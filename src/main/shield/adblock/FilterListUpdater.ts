import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, net } from 'electron'
import { createLogger } from '../../logger'

const log = createLogger('adblock')

/**
 * Keeping the filter lists current.
 *
 * **Why this is the biggest gap between Slash and Brave.** The technique is the
 * same — both prune the same fields out of the same player responses — but
 * Brave's rules are refreshed continuously by a community that notices within
 * hours when a site changes shape, and Slash's were compiled into the installer
 * and never fetched again. A list bundled in March is a list that is wrong by
 * May, silently, because a stale rule fails per-site rather than loudly.
 *
 * Bounded by the same rules as the yt-dlp fetch, for the same reasons:
 *
 *  - **A setting**, on by default, off in one switch, with the copy saying what
 *    the request is and where it goes.
 *  - **The check is recorded whether or not it succeeded**, so a machine that
 *    was offline does not retry on every launch for ever.
 *  - **It degrades to the bundled lists.** A browser whose blocking dies because
 *    a list server was down is worse than one running a fortnight-old list, so
 *    every failure path leaves the previous copy exactly where it was.
 *  - **Nothing is trusted because it arrived.** A list is written only if it
 *    parses as one; an HTML error page served with a 200 is the failure this
 *    guards against, and it would otherwise replace a working list with a login
 *    form.
 */
export interface FilterListSource {
  /** The filename under `resources/filters/`, kept identical so the cache stamp works. */
  readonly file: string
  readonly url: string
  /** Shown in Settings and in the log. */
  readonly name: string
}

/**
 * Where the lists come from.
 *
 * The canonical, publisher-served addresses — EasyList's own host and uBlock's
 * published pages — rather than a mirror. `isTrustedListUrl` pins the hosts, so
 * a config that ever carries these cannot be talked into fetching a list from
 * somewhere else.
 */
export const FILTER_LIST_SOURCES: readonly FilterListSource[] = [
  { file: 'easylist.txt', name: 'EasyList', url: 'https://easylist.to/easylist/easylist.txt' },
  {
    file: 'easyprivacy.txt',
    name: 'EasyPrivacy',
    url: 'https://easylist.to/easylist/easyprivacy.txt'
  },
  {
    file: 'ublock-filters.txt',
    name: 'uBlock filters',
    url: 'https://ublockorigin.github.io/uAssets/filters/filters.txt'
  },
  {
    file: 'ublock-badware.txt',
    name: 'uBlock badware',
    url: 'https://ublockorigin.github.io/uAssets/filters/badware.txt'
  },
  {
    file: 'ublock-privacy.txt',
    name: 'uBlock privacy',
    url: 'https://ublockorigin.github.io/uAssets/filters/privacy.txt'
  }
]

/**
 * How often to look.
 *
 * Four days, from how often these lists actually move rather than a round
 * number: EasyList commits most days, and uBlock's filters change several times
 * a week. Checking hourly would be a request nobody asked for; checking monthly
 * would leave the gap this exists to close.
 */
export const FILTER_REFRESH_INTERVAL_MS = 4 * 24 * 60 * 60 * 1000

/** Only these hosts, whatever a config or a redirect says. */
export function isTrustedListUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    // Exact hosts. `easylist.to.evil.test` must fail this, which a
    // `.endsWith()` test would not catch.
    return host === 'easylist.to' || host === 'ublockorigin.github.io'
  } catch {
    return false
  }
}

/**
 * Whether a downloaded body is actually a filter list.
 *
 * The failure this exists for is a 200 that carries an HTML error or a captive
 * portal's login page. Writing that over a working list would disable blocking
 * on the next compile, and nothing would report it — the file would be there,
 * the right name, the wrong contents.
 *
 * Pure and tested, because it is the only thing standing between the network
 * and the rules the browser enforces.
 */
export function looksLikeFilterList(body: string): boolean {
  if (body.length < 1024) return false

  const head = body.slice(0, 4096).toLowerCase()
  if (head.includes('<!doctype html') || head.includes('<html')) return false

  // Every one of these lists opens with a comment block: `[Adblock Plus 2.0]`,
  // or `!` lines carrying the title and expiry.
  const firstLine = body.slice(0, 200).trimStart()
  if (!firstLine.startsWith('[') && !firstLine.startsWith('!')) return false

  // And it must contain **rules**, not merely lines. Counting lines was the
  // first version and a test caught it immediately: a truncated download padded
  // with blank lines has hundreds of lines and no filters in it, and would have
  // replaced a working list with a header.
  let rules = 0
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('!') || trimmed.startsWith('[')) continue
    rules += 1
    if (rules > 50) return true
  }
  return false
}

/**
 * Whether to look for newer lists now.
 *
 * Pure and clock-injected: every clause decides whether the browser makes an
 * unattended network request, and principle 2 does not let that be settled
 * inside an async method nobody can test.
 */
export function shouldRefreshFilterLists(options: {
  enabled: boolean
  lastCheckedAt: number
  now: number
  intervalMs?: number
}): boolean {
  if (!options.enabled) return false

  const interval = options.intervalMs ?? FILTER_REFRESH_INTERVAL_MS
  const elapsed = options.now - options.lastCheckedAt

  // A clock that moved backwards — a corrected system time, a restored machine
  // — reads as a negative age. Treated as due rather than as never due, because
  // the alternative is lists that can never update again.
  if (elapsed < 0) return true
  return elapsed >= interval
}

/** Where refreshed lists are written. Never the program directory. */
export function updatedListsDir(): string {
  return join(app.getPath('userData'), 'filters')
}

/**
 * Whether the updated directory holds a usable complete set.
 *
 * All or nothing on purpose. A directory with three fresh lists and two missing
 * is not "mostly updated" — it is a blocker with two lists switched off, which
 * is worse than five that are a month old.
 */
export function hasCompleteListSet(dir: string): boolean {
  return FILTER_LIST_SOURCES.every((source) => existsSync(join(dir, source.file)))
}

export class FilterListUpdater {
  /**
   * Fetches every list, and reports whether anything actually changed.
   *
   * Returns false when nothing was written, which is the common case: the
   * caller uses it to decide whether a recompile is worth starting at all.
   */
  async refreshIfStale(
    enabled: () => boolean,
    lastCheckedAt: () => number,
    markChecked: () => void,
    now: () => number = () => Date.now()
  ): Promise<boolean> {
    if (
      !shouldRefreshFilterLists({
        enabled: enabled(),
        lastCheckedAt: lastCheckedAt(),
        now: now()
      })
    ) {
      return false
    }

    // Recorded before the attempt, not after, so a repeated failure cannot turn
    // into a request on every launch.
    markChecked()

    const dir = updatedListsDir()
    mkdirSync(dir, { recursive: true })

    let changed = false
    for (const source of FILTER_LIST_SOURCES) {
      try {
        if (await this.fetchOne(source, dir)) changed = true
      } catch (error) {
        // One list failing must not stop the others, and must not disturb the
        // copy already on disk.
        log.warn(`could not refresh ${source.name}`, error)
      }
    }

    if (changed) log.info('filter lists updated; they will be compiled on the next load')
    return changed
  }

  /** Returns true when this list was replaced with different bytes. */
  private async fetchOne(source: FilterListSource, dir: string): Promise<boolean> {
    if (!isTrustedListUrl(source.url)) {
      log.warn(`refusing to fetch ${source.name} from ${source.url}`)
      return false
    }

    const body = await fetchText(source.url)
    if (!looksLikeFilterList(body)) {
      // The important one. A 200 carrying a login page or an error would
      // otherwise overwrite a working list.
      log.warn(`${source.name} did not look like a filter list; keeping the current copy`)
      return false
    }

    const target = join(dir, source.file)
    if (existsSync(target) && readFileSync(target, 'utf8') === body) return false

    // Written beside and renamed, so a process that dies mid-write leaves the
    // previous list intact rather than a half-file the compiler would choke on.
    const staging = `${target}.part`
    writeFileSync(staging, body, 'utf8')
    renameSync(staging, target)
    log.info(`updated ${source.name} (${Math.round(body.length / 1024)} KB)`)
    return true
  }
}

/** A plain GET, following redirects only to hosts still on the list. */
function fetchText(url: string, redirects = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('Too many redirects.'))

    const request = net.request({ url, method: 'GET', redirect: 'manual' })
    request.setHeader('User-Agent', 'Slash-Browser')
    request.setHeader('Accept', 'text/plain,*/*')

    request.on('redirect', (_status, _method, redirectUrl) => {
      request.abort()
      if (!isTrustedListUrl(redirectUrl)) {
        return reject(new Error(`Refused a redirect to ${redirectUrl}.`))
      }
      resolve(fetchText(redirectUrl, redirects + 1))
    })

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        request.abort()
        return reject(new Error(`The server answered ${response.statusCode}.`))
      }
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      response.on('error', reject)
    })

    request.on('error', reject)
    request.end()
  })
}
