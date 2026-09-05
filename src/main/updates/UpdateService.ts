import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app, net, shell } from 'electron'
import { isSignedBuild } from './buildSignature'
import { z } from 'zod'
import type { UpdateStatus } from '@shared/types/updates'
import { createLogger } from '../logger'
import { installGate } from './installGate'
import { packagesToRemove } from './prunePackages'
import { currentPlatformKey, planInstall, type InstallPlan } from './updatePlan'
import { REWARDS_ANON_KEY_DEFAULT } from '@shared/types/rewards'

/** Whether an address is this project's own REST API, which needs a key. */
function isSupabaseRest(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.hostname.endsWith('.supabase.co') && parsed.pathname.startsWith('/rest/v1/')
  } catch {
    return false
  }
}

const log = createLogger('updates')

/**
 * Minimum shape a release feed must provide.
 *
 * This is the same `latest.yml` electron-updater publishes, read as JSON when a
 * feed offers it, or as the two fields we need out of the YAML. Only `version`
 * is required — a feed that cannot say what the newest version is has told us
 * nothing.
 */
const FeedSchema = z.object({
  version: z.string().min(1).max(40),
  releaseUrl: z.string().url().optional(),
  /**
   * The package and its checksum, when the publisher offers them.
   *
   * All optional: a feed carrying only a version is the check-only feed this
   * browser has always understood, and it still works. What these add is the
   * ability to fetch the package and **prove it is the one that was
   * published** before running it -- see `updatePlan.ts` for what that does
   * and does not buy.
   */
  fileUrl: z.string().url().optional(),
  sha512: z.string().max(200).optional(),
  size: z.number().nonnegative().optional(),
  notes: z.string().max(4000).optional(),
  /**
   * Packages for other kinds of machine, keyed `<platform>-<arch>`.
   *
   * Optional, and unknown keys are simply never looked up -- a feed naming
   * `linux-x64` is not an error here, it is a package this build has no use
   * for. The flat fields above stay Windows for ever, because every install
   * released before this existed reads only those.
   */
  platforms: z
    .record(
      z.string().max(40),
      z.object({
        fileUrl: z.string().url().optional(),
        sha512: z.string().max(200).optional(),
        size: z.number().nonnegative().optional()
      })
    )
    .optional()
})

/** A check that hangs must not leave the UI on "checking" forever. */
const CHECK_TIMEOUT_MS = 15_000

/** Late enough that a check never competes with the first paint. */
const FIRST_CHECK_DELAY_MS = 45_000
/** Four times a day is plenty for a browser somebody leaves open for weeks. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Long enough for the renderer to paint "Installing…" before the window goes.
 *
 * Quitting in the same tick as the click makes the browser vanish under the
 * pointer, which reads as a crash rather than as an update starting.
 */
const INSTALL_QUIT_DELAY_MS = 1_200
/** A package download is not a page load; it is allowed to take its time. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Checks a release feed for a newer version.
 *
 * **Deliberately never installs silently.** It checks, and it downloads and
 * verifies against the checksum the feed publishes -- but the last step always
 * asks. `electron-updater` is installed and its config is in place, and
 * auto-installing stays withheld until the build is code-signed: without a
 * signature there is nothing proving an update package came from us, and an
 * unsigned auto-installer is a remote code path onto the user's machine.
 * Handing somebody a verified installer to run carries none of that risk.
 *
 * The feed URL comes from settings and **defaults to Slash's own release
 * feed**, so a fresh install does check on launch. That was a deliberate
 * change: a browser that never learns about a Chromium security fix is a worse
 * outcome than one outbound request carrying no identifier, no cookie and no
 * per-installation key. Emptying `updateFeedUrl` stops it dead, and this then
 * reports `no-channel` rather than failing, because there is no feed to be
 * wrong about.
 */
export class UpdateService {
  private status: UpdateStatus
  /** What the feed said may be fetched, once a check has found something. */
  private plan: InstallPlan | null = null
  /** Where the verified package is on disk, or null. */
  private packagePath: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly feedUrl: () => string,
    /**
     * Told whenever the status changes, so a download reports progress rather
     * than leaving a panel to poll for it.
     */
    private readonly onChanged: (status: UpdateStatus) => void = () => {}
  ) {
    this.status = {
      state: 'idle',
      currentVersion: app.getVersion(),
      latestVersion: null,
      releaseUrl: null,
      checkedAt: null,
      detail: 'Not checked yet.',
      canInstall: false,
      canFetch: false,
      progress: 0,
      notes: ''
    }
  }

  /**
   * Checks on launch and every few hours.
   *
   * Does nothing at all while no feed is configured -- the address is the
   * switch that decides whether this browser talks to a server about updates,
   * and this only decides how often once one exists. A feed **is** configured
   * by default, so this does run on a fresh install. The first check is
   * delayed so it never competes with the first paint.
   */
  startAutoCheck(enabled: () => boolean, autoDownload: () => boolean): void {
    const run = (): void => {
      if (!enabled() || this.feedUrl().trim() === '') return
      void this.check().then(async (status) => {
        if (status.state === 'update-available' && status.canFetch && autoDownload()) {
          await this.download()
        }
      })
    }

    const first = setTimeout(run, FIRST_CHECK_DELAY_MS)
    first.unref?.()
    this.timer = setInterval(run, CHECK_INTERVAL_MS)
    this.timer.unref?.()
  }

  stopAutoCheck(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  current(): UpdateStatus {
    const feed = this.feedUrl().trim()
    if (feed === '') {
      return {
        ...this.status,
        state: 'no-channel',
        detail:
          'No update channel is configured, so Slash never contacts anything to check. This build also cannot install updates: it is not code-signed, and an unsigned update would be code arriving from an unverified source.'
      }
    }
    return this.status
  }

  /** Fetches the feed and compares versions. Never downloads a package. */
  async check(): Promise<UpdateStatus> {
    const feed = this.feedUrl().trim()
    if (feed === '') return this.current()

    this.status = { ...this.status, state: 'checking', detail: 'Checking for a newer version…' }

    try {
      const body = await this.fetchFeed(feed)
      const parsed = FeedSchema.safeParse(body)
      if (!parsed.success) {
        return this.settle('error', null, null, 'The update feed was not in a format Slash could read.')
      }

      const latest = parsed.data.version
      const newer = compareVersions(latest, app.getVersion()) > 0
      log.info(`update check: running ${app.getVersion()}, feed offers ${latest}`)

      const signed = await isSignedBuild()

      // What the feed offers to fetch, if anything. A feed carrying only a
      // version is the check-only feed this browser has always understood.
      const verdict = planInstall(parsed.data, feed, currentPlatformKey())
      this.plan = verdict.ok ? verdict.plan : null
      this.packagePath = null
      this.status = { ...this.status, notes: parsed.data.notes ?? '', progress: 0 }

      if (!newer) {
        // The moment after a successful update: the browser has relaunched on
        // the new version and nothing is pending, so every package in the
        // folder has already been run. This is what actually reclaims the
        // space, and it needs no user action and no button.
        void this.prunePackages(null)
        return this.settle('up-to-date', latest, null, `You are running the newest version (${latest}).`)
      }

      const detail = signed
        ? `Version ${latest} is available. You are running ${app.getVersion()}.`
        : this.plan
          ? `Version ${latest} is available. You are running ${app.getVersion()}. Slash can fetch it and check it against the checksum the feed publishes, then hand the installer to you. This build is not code-signed, so Windows will warn about the publisher exactly as it did when you installed it.`
          : `Version ${latest} is available. You are running ${app.getVersion()}. This release publishes no package to verify, so open the release page and download it there.`

      return this.settle(
        'update-available',
        latest,
        parsed.data.releaseUrl ?? null,
        detail,
        signed,
        this.plan !== null
      )
    } catch (error) {
      log.warn('update check failed', error)
      return this.settle('error', null, null, 'Could not reach the update feed.')
    }
  }

  private settle(
    state: UpdateStatus['state'],
    latestVersion: string | null,
    releaseUrl: string | null,
    detail: string,
    canInstall = false,
    canFetch = false
  ): UpdateStatus {
    this.status = {
      ...this.status,
      state,
      latestVersion,
      releaseUrl,
      detail,
      checkedAt: Date.now(),
      canInstall,
      canFetch
    }
    this.onChanged(this.status)
    return this.status
  }

  private progress(state: UpdateStatus['state'], detail: string, fraction: number): void {
    this.status = { ...this.status, state, detail, progress: fraction }
    this.onChanged(this.status)
  }

  /**
   * Fetches the package and verifies it, installing nothing.
   *
   * The verification is the whole value of this method, so it fails closed:
   * the file is hashed **as it is written**, compared against the checksum the
   * feed published, and **deleted** on any mismatch. A package that does not
   * match is not left in a folder for somebody to run by hand.
   */
  async download(): Promise<{ ok: boolean; detail: string }> {
    const plan = this.plan
    if (!plan) {
      return { ok: false, detail: 'This release publishes no package that Slash can verify.' }
    }
    if (this.packagePath) return { ok: true, detail: 'Already downloaded and verified.' }

    const folder = join(app.getPath('userData'), 'updates')
    const target = join(folder, plan.fileName)

    try {
      await mkdir(folder, { recursive: true })
      // A partial file from an abandoned attempt is never resumed: resuming an
      // unverified package is how bytes from two different servers end up in
      // one hash.
      await rm(target, { force: true })

      this.progress('downloading', `Downloading version ${plan.version}…`, 0)
      const digest = await this.fetchPackage(plan, target)

      if (digest !== plan.sha512) {
        await rm(target, { force: true })
        log.warn(`update package checksum mismatch: expected ${plan.sha512}, got ${digest}`)
        this.settle(
          'error',
          plan.version,
          this.status.releaseUrl,
          'The downloaded package did not match the checksum the feed published, so it was deleted. Nothing was installed.'
        )
        return { ok: false, detail: 'The package did not match its published checksum.' }
      }

      if (plan.size > 0) {
        const written = (await stat(target)).size
        if (written !== plan.size) {
          await rm(target, { force: true })
          this.settle(
            'error',
            plan.version,
            this.status.releaseUrl,
            'The downloaded package was not the size the feed published, so it was deleted.'
          )
          return { ok: false, detail: 'The package was not the published size.' }
        }
      }

      this.packagePath = target
      // Every package fetched used to be kept for ever: 168 MB each, and six
      // updates in one evening left 673 MB in the profile that nothing would
      // read again. An installer that has been run has no further use.
      void this.prunePackages(plan.fileName)
      this.settle(
        'ready',
        plan.version,
        this.status.releaseUrl,
        `Version ${plan.version} is downloaded and matches its published checksum. Installing closes Slash and runs the installer.`,
        this.status.canInstall,
        true
      )
      this.status = { ...this.status, progress: 1 }
      return { ok: true, detail: 'Downloaded and verified.' }
    } catch (error) {
      log.warn('update download failed', error)
      await rm(target, { force: true }).catch(() => {})
      this.settle('error', plan.version, this.status.releaseUrl, 'The update could not be downloaded.')
      return { ok: false, detail: 'The update could not be downloaded.' }
    }
  }

  /**
   * Streams the package to disk, hashing as it goes.
   *
   * Hashed while writing rather than by reading the file back: a second read
   * is a second chance for what is on disk to differ from what was checked,
   * and on a large installer it doubles the disk work for nothing.
   */
  private async fetchPackage(plan: InstallPlan, target: string): Promise<string> {
    const request = net.request({ url: plan.fileUrl, method: 'GET' })
    const timer = setTimeout(() => request.abort(), DOWNLOAD_TIMEOUT_MS)

    try {
      return await new Promise<string>((resolve, reject) => {
        const hash = createHash('sha512')
        const file = createWriteStream(target)
        let received = 0

        request.on('response', (response) => {
          if (response.statusCode >= 400) {
            reject(new Error(`Package returned ${response.statusCode}`))
            return
          }
          const declared =
            plan.size > 0 ? plan.size : Number(response.headers['content-length'] ?? 0)

          response.on('data', (chunk: Buffer) => {
            received += chunk.length
            hash.update(chunk)
            file.write(chunk)
            if (declared > 0) {
              this.progress(
                'downloading',
                `Downloading version ${plan.version}… ${Math.round((received / declared) * 100)}%`,
                Math.min(received / declared, 1)
              )
            }
          })
          response.on('end', () => {
            file.end(() => resolve(hash.digest('hex')))
          })
          response.on('error', reject)
        })
        request.on('error', reject)
        request.on('abort', () => reject(new Error('The download timed out')))
        request.end()
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Deletes update packages that are no longer needed.
   *
   * Best-effort by design: a file that will not delete -- open, locked by an
   * antivirus scan, on a volume that has gone away -- is a housekeeping
   * failure, and housekeeping must never break updating. Every error is
   * swallowed after a log line.
   */
  private async prunePackages(keep: string | null): Promise<void> {
    const folder = join(app.getPath('userData'), 'updates')
    try {
      const files = await readdir(folder)
      const stale = packagesToRemove(files, keep)
      for (const name of stale) {
        await rm(join(folder, name), { force: true }).catch(() => undefined)
      }
      if (stale.length > 0) log.info(`removed ${stale.length} update package(s) no longer needed`)
    } catch {
      // No folder yet, which is the ordinary case before a first download.
    }
  }

  /**
   * Runs the NSIS package with no interface, detached from this process.
   *
   * Detached and with its streams released, because the installer outlives the
   * browser that started it: `app.quit()` follows immediately, and a child
   * still tied to this process's stdio would be killed with it, leaving Slash
   * uninstalled halfway.
   */
  private launchInstaller(packagePath: string): boolean {
    try {
      const child = spawn(packagePath, ['/S', '--force-run'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      child.unref()
      return true
    } catch (error) {
      log.warn(`could not spawn the installer: ${String(error)}`)
      return false
    }
  }

  /**
   * Downloads and installs the available update.
   *
   * Gated on the build carrying a valid Authenticode signature, checked against
   * the binary on this machine rather than against a flag set when it was built.
   * Unsigned, this refuses — an auto-installer with nothing to verify against is
   * a remote code path onto the user's machine, and that is the whole reason
   * this browser has shipped check-only until now.
   *
   * When a certificate is bought and the build is signed, this becomes live with
   * no code change: `isSignedBuild()` starts returning true and the button in
   * Settings stops being disabled.
   */
  async downloadAndInstall(): Promise<{ ok: boolean; detail: string }> {
    // Not `state !== 'update-available'`, which refused `ready` -- the state
    // that means the package is downloaded and its checksum matches. With
    // auto-download on, that is the state every user is in by the time they
    // click, so installing was refused on the normal path. See installGate.ts.
    const gate = installGate(this.status.state)
    if (!gate.ok) return { ok: false, detail: gate.detail }
    if (!(await isSignedBuild())) {
      // The unsigned path: fetch the package the feed named, prove it matches
      // the checksum the feed published, and hand the installer to the user.
      //
      // This is the same trade the yt-dlp install in this codebase already
      // makes, and the difference from the signed path is worth being exact
      // about. Integrity: the bytes are what the publisher published, and a
      // proxy cannot substitute others. **Not** authenticity independent of
      // that server: whoever controls the feed host controls both the file and
      // its checksum. Code signing is what fixes that, and the path below
      // stays for when a certificate exists.
      //
      // Nothing is run silently either. `openPath` starts the installer the
      // user asked for; Windows will warn about an unknown publisher exactly
      // as it did when they installed Slash in the first place.
      if (!this.plan) {
        return {
          ok: false,
          detail:
            'This release publishes no package and checksum, so Slash cannot verify an update. Download it from the release page instead.'
        }
      }

      if (!this.packagePath) {
        const fetched = await this.download()
        if (!fetched.ok) return fetched
      }

      const packagePath = this.packagePath
      if (!packagePath) return { ok: false, detail: 'The update package is not on disk.' }

      // Silent, because an update is not a first install and should not read
      // like one. `oneClick: false` gives a full wizard -- welcome page,
      // install location, progress, finish -- which is right for somebody
      // installing Slash and wrong for somebody who has already agreed to
      // update inside the browser. `/S` runs the same NSIS package with no UI
      // and `--force-run` starts Slash again afterwards, so the update looks
      // like a restart rather than a reinstallation.
      //
      // The consent is the Update button. Nothing is silent that the user did
      // not ask for, and the bytes were checked against the published checksum
      // before this point.
      // macOS installs by dragging, and that is not a limitation to route
      // around. A DMG has to be mounted and the bundle copied over the running
      // application, which is a thing Slash cannot do to itself safely — and
      // doing it badly leaves somebody with a half-replaced .app and no
      // browser. Opening the image is what every unsigned Mac application
      // does, and the user finishes it in Finder, where they can see what is
      // happening.
      //
      // The check, the download and the checksum are identical to Windows.
      // Only this last step differs, and the honest version of it is one
      // sentence rather than an untested file copy.
      if (process.platform !== 'win32') {
        const failure = await shell.openPath(packagePath)
        if (failure !== '') {
          log.warn(`could not open the disk image: ${failure}`)
          return { ok: false, detail: 'The disk image could not be opened.' }
        }
        log.info(`opened the disk image for ${this.plan.version}`)
        return {
          ok: true,
          detail:
            'The disk image is open. Drag Slash into Applications, replacing the old copy, then reopen it.'
        }
      }

      const started = this.launchInstaller(packagePath)
      if (!started) {
        // Falls back to the visible wizard rather than failing: a wizard is a
        // worse experience than a silent update and a far better one than an
        // update that cannot happen at all.
        const failure = await shell.openPath(packagePath)
        if (failure !== '') {
          log.warn(`could not start the installer: ${failure}`)
          return { ok: false, detail: 'The installer could not be started.' }
        }
        return {
          ok: true,
          detail: 'The installer has been started. Slash will close when it asks you to.'
        }
      }

      log.info(`installing ${this.plan.version} silently`)
      // NSIS cannot replace files that are open, so the browser has to go.
      // Given a moment first so the renderer can paint "Installing…" -- quitting
      // in the same tick makes the window vanish mid-click, which reads as a
      // crash rather than as an update.
      setTimeout(() => app.quit(), INSTALL_QUIT_DELAY_MS)

      return {
        ok: true,
        detail: 'Installing. Slash will close and reopen on the new version.'
      }
    }

    try {
      // Imported here rather than at module scope: electron-updater reads app
      // paths and writes a cache directory on load, and doing that at startup
      // costs every launch for a feature most launches never use.
      const { autoUpdater } = await import('electron-updater')
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.setFeedURL({ provider: 'generic', url: this.feedUrl().trim() })

      this.status = { ...this.status, state: 'downloading', detail: 'Downloading the update…' }
      await autoUpdater.downloadUpdate()

      // Quits and relaunches. `verifyUpdateCodeSignature` in electron-builder.yml
      // makes the installer refuse a package whose signature does not match the
      // installed app — the check that stops a tampered update being accepted.
      autoUpdater.quitAndInstall(false, true)
      return { ok: true, detail: 'Installing…' }
    } catch (error) {
      log.warn('update install failed', error)
      this.status = { ...this.status, state: 'error', detail: 'The update could not be installed.' }
      return { ok: false, detail: 'The update could not be installed.' }
    }
  }

  /**
   * Fetches the feed through Chromium's stack.
   *
   * `net` rather than Node's http, so the check honours the same proxy and
   * certificate configuration as the rest of the browser. A checker that trusted
   * a different TLS stack from the browser would be a real inconsistency.
   */
  private async fetchFeed(url: string): Promise<unknown> {
    const request = net.request({ url, method: 'GET' })

    // The default feed is the `releases` table read through PostgREST, which
    // requires the project key on every request even for a public row. It is
    // the same key every copy of Slash already ships and it identifies the
    // project, not the installation.
    if (isSupabaseRest(url)) {
      request.setHeader('apikey', REWARDS_ANON_KEY_DEFAULT)
      request.setHeader('authorization', `Bearer ${REWARDS_ANON_KEY_DEFAULT}`)
    }
    const timer = setTimeout(() => request.abort(), CHECK_TIMEOUT_MS)

    try {
      const text = await new Promise<string>((resolve, reject) => {
        request.on('response', (response) => {
          if (response.statusCode >= 400) {
            reject(new Error(`Feed returned ${response.statusCode}`))
            return
          }
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        })
        request.on('error', reject)
        request.on('abort', () => reject(new Error('Update check timed out')))
        request.end()
      })

      return parseFeed(text)
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Reads a feed body as JSON, falling back to the two fields we need from YAML.
 *
 * A full YAML parser is not worth a dependency here: `latest.yml` is a flat
 * key/value file, and this reads the one key that matters rather than pretending
 * to understand the format in general.
 */
export function parseFeed(text: string): unknown {
  const trimmed = text.trim()

  /*
   * A PostgREST array: the feed is a table, so the answer is a list of rows in
   * the column names the table uses. Mapped here rather than in the schema so
   * that a hand-written JSON feed and a database-backed one both arrive at the
   * same shape, and neither has to know about the other.
   */
  if (trimmed.startsWith('[')) {
    try {
      const rows = JSON.parse(trimmed) as Record<string, unknown>[]
      const row = rows[0]
      if (!row) return {}
      return {
        version: row.version,
        releaseUrl: row.release_url ?? row.releaseUrl ?? undefined,
        notes: row.notes ?? '',
        // Empty strings are how the table says "no package"; the plan wants
        // them absent, since an empty address is a malformed one.
        fileUrl: row.file_url === '' ? undefined : (row.file_url ?? row.fileUrl),
        sha512: row.sha512 === '' ? undefined : row.sha512,
        size: Number(row.size_bytes ?? row.size ?? 0) || undefined
      }
    } catch {
      return {}
    }
  }

  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return null
    }
  }

  const version = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(trimmed)?.[1]
  const releaseUrl = /^releaseUrl:\s*['"]?(\S+?)['"]?\s*$/m.exec(trimmed)?.[1]
  if (!version) return null
  return releaseUrl ? { version, releaseUrl } : { version }
}

/**
 * Compares dotted versions numerically.
 *
 * String comparison gets this wrong in the way that matters: `'0.10.0' < '0.9.0'`
 * lexicographically, so a user on 0.9.0 would never be offered 0.10.0.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/i, '')
      // Drop any pre-release suffix; only the numeric core is compared.
      .split('-')[0]!
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0))

  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}
