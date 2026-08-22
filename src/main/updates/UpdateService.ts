import { app, net } from 'electron'
import { isSignedBuild } from './buildSignature'
import { z } from 'zod'
import type { UpdateStatus } from '@shared/types/updates'
import { createLogger } from '../logger'

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
  releaseUrl: z.string().url().optional()
})

/** A check that hangs must not leave the UI on "checking" forever. */
const CHECK_TIMEOUT_MS = 15_000

/**
 * Checks a release feed for a newer version.
 *
 * **Deliberately does not download or install.** `electron-updater` is installed
 * and its config is in place, but auto-installing is withheld until the build is
 * code-signed: without a signature there is no way to verify an update package
 * came from us, and an unsigned auto-installer is a remote code path onto the
 * user's machine. Telling the user a version exists carries none of that risk.
 *
 * The feed URL comes from settings and is empty by default, so a fresh install
 * contacts nothing. That is also why this reports `no-channel` rather than
 * failing: there is no feed to be wrong about yet.
 */
export class UpdateService {
  private status: UpdateStatus

  constructor(private readonly feedUrl: () => string) {
    this.status = {
      state: 'idle',
      currentVersion: app.getVersion(),
      latestVersion: null,
      releaseUrl: null,
      checkedAt: null,
      detail: 'Not checked yet.',
      canInstall: false
    }
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

      return newer
        ? this.settle(
            'update-available',
            latest,
            parsed.data.releaseUrl ?? null,
            signed
              ? `Version ${latest} is available. You are running ${app.getVersion()}.`
              : `Version ${latest} is available. You are running ${app.getVersion()}. Slash will not install it for you — this build is unsigned, so it cannot verify the package came from us.`,
            signed
          )
        : this.settle('up-to-date', latest, null, `You are running the newest version (${latest}).`)
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
    canInstall = false
  ): UpdateStatus {
    this.status = {
      ...this.status,
      state,
      latestVersion,
      releaseUrl,
      detail,
      checkedAt: Date.now(),
      canInstall
    }
    return this.status
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
    if (this.status.state !== 'update-available') {
      return { ok: false, detail: 'There is no update to install.' }
    }
    if (!(await isSignedBuild())) {
      return {
        ok: false,
        detail:
          'This build is not code-signed, so it cannot verify that an update came from us. ' +
          'Download the new version from the release page instead.'
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
