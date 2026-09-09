import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app, net } from 'electron'
import { createHash } from 'node:crypto'
import { createLogger } from '../../logger'
import {
  checksumFor,
  chooseAsset,
  shouldRefreshYtDlp,
  YTDLP_RELEASE_API
} from './ytDlpRelease'
import {
  parseFormats,
  parseProgress,
  PROGRESS_ARGS,
  type ExternalChoice,
  type ExternalProgress
} from './ytDlpOutput'

const log = createLogger('external')

/** Names to try on PATH, in order. */
const CANDIDATES = ['yt-dlp', 'yt-dlp.exe', 'yt-dlp_x86.exe']

/** A format dump should not take this long, and a hung probe blocks the picker. */
const LIST_TIMEOUT_MS = 45_000

export interface ExternalDownloadHandle {
  cancel: () => void
}

/**
 * Runs a **user-installed** yt-dlp, when there is one.
 *
 * Slash does not ship this, download it, or offer to install it, and that is a
 * deliberate boundary rather than an oversight. Some sites — YouTube most
 * visibly — serve their media in a form no observer can turn into a file:
 * addresses that exist only inside the player's own session, or a transport
 * framing the player unwraps in the page. Reaching those means impersonating a
 * different client or running the site's signature code, which is defeating an
 * access control, and this browser does not do that.
 *
 * A tool the user chose to install is a different question, and one that is
 * theirs to answer. This is how mpv, VLC front-ends and most media applications
 * handle it. The capability lives in a program they put on their machine; Slash
 * finds it, hands it a URL, and shows the result honestly — including saying
 * plainly, in the UI, which downloads it did and which the browser did.
 *
 * Nothing here runs unless the setting is on **and** the binary is found.
 */
export class YtDlpService {
  private resolved: string | null = null
  private looked = false

  constructor(
    /** An explicit path from settings; empty means "look on PATH". */
    private readonly configuredPath: () => string
  ) {}

  /** Forget a cached lookup — the user changed the setting, or installed it. */
  reset(): void {
    this.resolved = null
    this.looked = false
  }

  /**
   * The binary, or null.
   *
   * Cached because this is asked on every picker open and a failed PATH lookup
   * is a process spawn. Reset when the setting changes.
   */
  async locate(): Promise<string | null> {
    const configured = this.configuredPath().trim()
    if (configured !== '') {
      // An explicit path is checked every time. It is a file the user can move.
      const ok = await fs
        .access(configured)
        .then(() => true)
        .catch(() => false)
      return ok ? configured : null
    }

    if (this.looked) return this.resolved
    this.looked = true

    // A copy Slash installed is preferred over one on PATH, because it is the
    // one this can keep up to date. yt-dlp ships fixes for YouTube every few
    // weeks and a stale copy is the whole reason it is not bundled.
    const managed = this.managedPath()
    if (await exists(managed)) {
      this.resolved = managed
      return managed
    }

    for (const candidate of CANDIDATES) {
      const works = await this.version(candidate)
      if (works !== null) {
        log.info(`found ${candidate} ${works}`)
        this.resolved = candidate
        return candidate
      }
    }
    this.resolved = null
    return null
  }

  /** `--version`, used as the existence test. */
  private version(command: string): Promise<string | null> {
    return new Promise((resolve) => {
      // `shell` for the same reason as `spawnTool`: a `.cmd` shim is not an
      // executable image, and this is also how a bare name on PATH is resolved.
      execFile(
        command,
        ['--version'],
        { timeout: 8000, shell: /\.(cmd|bat)$/i.test(command) },
        (error, stdout) => resolve(error ? null : stdout.trim())
      )
    })
  }

  /**
   * What this URL is available as.
   *
   * `--dump-single-json` and nothing else: no download, no playlist expansion,
   * no writing anywhere. `--no-playlist` matters on YouTube, where every watch
   * URL in a mix carries a list id and would otherwise enumerate the whole mix
   * before answering.
   */
  async listFormats(url: string): Promise<{
    ok: boolean
    title: string
    choices: ExternalChoice[]
    error: string | null
  }> {
    const binary = await this.locate()
    if (binary === null) {
      return { ok: false, title: '', choices: [], error: 'yt-dlp was not found.' }
    }

    return new Promise((resolve) => {
      execFile(
        binary,
        ['--dump-single-json', '--no-playlist', '--no-warnings', url],
        {
          timeout: LIST_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
          shell: /\.(cmd|bat)$/i.test(binary)
        },
        (error, stdout, stderr) => {
          if (error) {
            const message = (stderr || error.message).trim().split('\n').slice(-2).join(' ')
            log.warn(`listing failed: ${message}`)
            return resolve({ ok: false, title: '', choices: [], error: message })
          }
          try {
            const parsed = parseFormats(JSON.parse(stdout))
            resolve({ ...parsed, ok: true, error: null })
          } catch (parseError) {
            resolve({
              ok: false,
              title: '',
              choices: [],
              error: parseError instanceof Error ? parseError.message : 'Unreadable output'
            })
          }
        }
      )
    })
  }

  /**
   * Downloads one selector into a folder.
   *
   * The output template is fixed here rather than taken from the caller: it is
   * passed to a program that treats `%(...)s` as a formatting language and a
   * path as a path, and a filename arriving from a page is attacker-controlled.
   * `--restrict-filenames` then keeps the result to a safe ASCII subset, so no
   * separator or traversal can survive the title.
   */
  start(
    url: string,
    selector: string,
    directory: string,
    hooks: {
      onProgress: (progress: ExternalProgress) => void
      onDone: (result: { ok: boolean; error: string | null; file: string | null }) => void
    }
  ): ExternalDownloadHandle | null {
    if (this.resolved === null && this.configuredPath().trim() === '') return null
    const binary = this.configuredPath().trim() || this.resolved
    if (!binary) return null

    const args = [
      '--no-playlist',
      '--no-warnings',
      '--restrict-filenames',
      '-f',
      selector,
      ...PROGRESS_ARGS,
      '--print',
      'after_move:SLASHFILE|%(filepath)s',
      '-P',
      directory,
      '-o',
      '%(title)s.%(ext)s',
      url
    ]

    let child: ChildProcess
    try {
      child = spawnTool(binary, args)
    } catch (error) {
      hooks.onDone({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        file: null
      })
      return null
    }

    let file: string | null = null
    let tail = ''
    let carry = ''

    const consume = (chunk: string): void => {
      carry += chunk
      const lines = carry.split(/\r?\n/)
      carry = lines.pop() ?? ''
      for (const line of lines) {
        const progress = parseProgress(line)
        if (progress) {
          hooks.onProgress(progress)
          continue
        }
        if (line.startsWith('SLASHFILE|')) {
          file = line.slice('SLASHFILE|'.length).trim()
          continue
        }
        // Keep the last of the chatter; it is what explains a failure.
        if (line.trim() !== '') tail = line.trim()
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => consume(chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text !== '') tail = text.split('\n').at(-1)?.trim() ?? tail
    })

    child.on('error', (error) => {
      hooks.onDone({ ok: false, error: error.message, file: null })
    })

    child.on('close', (code, signal) => {
      // Cancelled deliberately; not a failure to report as one.
      if (signal !== null) return hooks.onDone({ ok: false, error: null, file: null })
      hooks.onDone({
        ok: code === 0,
        error: code === 0 ? null : tail || `yt-dlp exited with code ${code}`,
        // The path yt-dlp printed after the file landed, which is the only
        // reliable one: the title decides the name and it sanitises it.
        file: file !== null && code === 0 ? file : null
      })
    })

    return {
      cancel: () => {
        try {
          child.kill()
        } catch (error) {
          log.debug('killing yt-dlp threw', error)
        }
      }
    }
  }

  /** Where a Slash-installed copy lives. Never inside the install directory. */
  managedPath(): string {
    return join(app.getPath('userData'), 'tools', 'yt-dlp.exe')
  }

  /** What the UI needs to render the Settings row. */
  async status(): Promise<{
    installed: boolean
    managed: boolean
    path: string | null
    version: string | null
  }> {
    const found = await this.locate()
    if (found === null) return { installed: false, managed: false, path: null, version: null }
    return {
      installed: true,
      managed: found === this.managedPath(),
      path: found,
      version: await this.version(found)
    }
  }

  /**
   * Fetches the current yt-dlp from its official releases into `userData`.
   *
   * Deliberately not bundled in the installer, and this is the reason rather
   * than squeamishness: yt-dlp ships extractor fixes every few weeks because
   * the sites move, and Slash has no auto-update of its own — it is unsigned.
   * A copy frozen into the installer would break within a month and could not
   * be repaired short of reinstalling the whole application.
   *
   * `userData` rather than the program directory so updating never needs
   * elevation, and so uninstalling Slash takes it with it.
   *
   * The bytes are **verified against the published SHA-512** before anything is
   * marked as installed, and the download URL has already been checked to come
   * from the official repository. This writes a file it will then execute; both
   * checks are the minimum that deserves.
   */
  /**
   * Installs on first run, once, in the background.
   *
   * Slash cannot download most video sites on its own; that capability lives in
   * yt-dlp. Leaving it behind a button in Settings meant the feature existed and
   * nobody found it — which is the same failure as a channel with no caller.
   *
   * Three things keep this from being a browser that phones home:
   *
   *  - It is a **setting**, on by default and off in one click, and the copy
   *    beside it says what the request is and where it goes.
   *  - It is **attempted once**. A machine with no network, or a release with no
   *    checksum, must not retry on every launch for ever — so the attempt is
   *    recorded whether or not it succeeded, and Settings still offers the
   *    manual button afterwards.
   *  - It does nothing at all if a usable yt-dlp is already present, including
   *    one the user installed themselves.
   *
   * Never awaited by anything on the browsing path. A first run with no network
   * is an ordinary state, not an error worth showing.
   */
  async installOnFirstRun(
    enabled: () => boolean,
    alreadyAttempted: () => boolean,
    markAttempted: () => void
  ): Promise<void> {
    if (!enabled() || alreadyAttempted()) return
    if ((await this.locate()) !== null) {
      // Already available — record it so this never runs again.
      markAttempted()
      return
    }

    markAttempted()
    log.info('first run: fetching yt-dlp')
    const result = await this.install().catch((error: unknown) => ({
      ok: false,
      version: null,
      note: String(error)
    }))
    if (result.ok) {
      log.info(`first run: yt-dlp ${result.version ?? ''} installed`)
    } else {
      // Silent to the user. They did not ask for this yet, and a modal about a
      // component they have not tried to use would be worse than the gap.
      log.warn(`first run: could not install yt-dlp — ${result.note}`)
    }
  }

  /**
   * Replaces a stale managed yt-dlp with the current release.
   *
   * **Why installing once was not enough.** `installOnFirstRun` fetches a
   * working copy, and CLAUDE.md already records why bundling one is wrong:
   * releases carry extractor fixes every few weeks, so a frozen copy breaks
   * within a month. Installing once re-creates that same problem a month
   * later — the difference being that the user now believes the feature works.
   * A stale extractor does not announce itself; it fails per-site, which reads
   * as "Slash cannot download this video" rather than as a component needing an
   * update.
   *
   * Bounded by the same rules as the first-run install: only the copy Slash
   * owns in `userData`, only from the official repository, checksum verified
   * before anything is replaced, off in one switch, and the check itself is
   * recorded whether or not it succeeded so a machine with no network does not
   * retry on every launch.
   */
  async refreshIfStale(
    enabled: () => boolean,
    lastCheckedAt: () => number,
    markChecked: () => void,
    now: () => number = () => Date.now()
  ): Promise<void> {
    const found = await this.locate()
    if (found === null) return

    if (
      !shouldRefreshYtDlp({
        enabled: enabled(),
        managed: found === this.managedPath(),
        lastCheckedAt: lastCheckedAt(),
        now: now()
      })
    ) {
      return
    }

    // Recorded before the attempt, not after, so a repeated failure cannot turn
    // into a request on every launch.
    markChecked()

    const installed = await this.version(found)
    const result = await this.install().catch((error: unknown) => ({
      ok: false,
      version: null,
      note: String(error)
    }))

    if (result.ok) {
      log.info(
        installed !== null && result.version === installed
          ? `yt-dlp is current (${installed})`
          : `yt-dlp updated ${installed ?? 'unknown'} -> ${result.version ?? 'unknown'}`
      )
    } else {
      // Silent to the user: the copy they have still works, and a modal about a
      // component that is merely a fortnight old would be noise.
      log.warn(`could not refresh yt-dlp — ${result.note}`)
    }
  }

  async install(): Promise<{ ok: boolean; version: string | null; note: string }> {
    try {
      const release = await fetchJson(YTDLP_RELEASE_API)
      const choice = chooseAsset(release)
      if ('error' in choice) return { ok: false, version: null, note: choice.error }

      log.info(`installing yt-dlp ${choice.version} from ${choice.url}`)
      const binary = await fetchBinary(choice.url)

      if (choice.checksumUrl === null) {
        return {
          ok: false,
          version: null,
          note: 'That release publishes no checksum, so Slash will not install it.'
        }
      }
      const sums = await fetchText(choice.checksumUrl)
      const expected = checksumFor(sums)
      if (expected === null) {
        return { ok: false, version: null, note: 'The published checksums do not cover yt-dlp.exe.' }
      }
      const actual = createHash('sha512').update(binary).digest('hex')
      if (actual !== expected) {
        // Never keep the file. A mismatch is either corruption or something
        // worse, and this one gets executed.
        return {
          ok: false,
          version: null,
          note: 'The download did not match its published checksum, so it was discarded.'
        }
      }

      const target = this.managedPath()
      await fs.mkdir(join(target, '..'), { recursive: true })
      await fs.writeFile(target, binary)
      this.reset()

      log.info(`installed yt-dlp ${choice.version} (${binary.length} bytes, checksum verified)`)
      return {
        ok: true,
        version: choice.version,
        note: `Installed yt-dlp ${choice.version}. Checksum verified.`
      }
    } catch (error) {
      return {
        ok: false,
        version: null,
        note: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /** Removes a copy Slash installed. Never touches one found on PATH. */
  async uninstall(): Promise<{ ok: boolean; note: string }> {
    const target = this.managedPath()
    if (!(await exists(target))) return { ok: false, note: 'Slash did not install a copy.' }
    await fs.rm(target, { force: true })
    this.reset()
    return { ok: true, note: 'Removed the copy Slash installed.' }
  }

  /** Where a finished file should have landed, for the "show in folder" action. */
  static expectedIn(directory: string, name: string): string {
    return join(directory, name)
  }
}

/**
 * Spawns the tool, going through a shell only when Windows requires it.
 *
 * On Windows a `.cmd` or `.bat` is not an executable image — it is input to the
 * command interpreter — and Node refuses to spawn one directly (EINVAL since
 * the argument-injection fix). That matters here rather than being trivia: pip
 * installs `yt-dlp.exe`, but **scoop and npm install a `.cmd` shim**, so a
 * perfectly working yt-dlp would simply have failed to start for a good share
 * of the people who have one.
 *
 * Arguments are quoted by hand for that path. `shell: true` hands the string to
 * `cmd.exe`, which splits on whitespace — and the download folder very often
 * contains a space.
 */
function spawnTool(binary: string, args: string[]): ChildProcess {
  const isShim = /\.(cmd|bat)$/i.test(binary)
  if (!isShim) return spawn(binary, args, { windowsHide: true })

  const quote = (value: string): string =>
    /[\s"^&|<>()]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value

  return spawn([quote(binary), ...args.map(quote)].join(' '), {
    shell: true,
    windowsHide: true
  })
}

const exists = (path: string): Promise<boolean> =>
  fs
    .access(path)
    .then(() => true)
    .catch(() => false)

/**
 * A plain GET through Chromium's stack.
 *
 * `net` rather than node's http for the same reason the download engine uses
 * it: the same proxy resolution, certificate verification and DNS as the rest
 * of the browser. Fetching an executable over a different TLS stack from the
 * one the user trusts would be a real inconsistency, not a detail.
 */
function fetchBuffer(url: string, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects.'))

    const request = net.request({ url, method: 'GET', redirect: 'manual' })
    // GitHub requires one, and answers 403 to a request without it.
    request.setHeader('User-Agent', 'Slash-Browser')
    request.setHeader('Accept', '*/*')

    request.on('redirect', (_status, _method, redirectUrl) => {
      request.abort()
      // GitHub serves release assets from its own CDN, so the hop leaves
      // github.com by design. The *first* URL was checked against the official
      // repository, and the bytes are checksummed after arrival, which is what
      // actually protects this.
      resolve(fetchBuffer(redirectUrl, redirects + 1))
    })

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        request.abort()
        return reject(new Error(`The server answered ${response.statusCode}.`))
      }
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })

    request.on('error', reject)
    request.end()
  })
}

const fetchText = async (url: string): Promise<string> => (await fetchBuffer(url)).toString('utf8')
const fetchJson = async (url: string): Promise<unknown> => JSON.parse(await fetchText(url))
const fetchBinary = (url: string): Promise<Buffer> => fetchBuffer(url)
