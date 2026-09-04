import { app, net, type WebContents } from 'electron'
import type { BrowserWindowController } from '../windows/BrowserWindowController'
import {
  openMediaRequest,
  sendMediaRequest,
  type MediaRequestContext
} from '../downloads/engine/requestContext'
import { analyseFormats } from '../media/pageFormats'
import { EXTRACT_SCRIPT } from '../media/PageMediaExtractor'
import { isMasterPlaylist, parseMaster } from '../media/hlsPlaylist'
import { planStream } from '../downloads/engine/StreamDownload'
import { createLogger } from '../logger'

const log = createLogger('spike')

/**
 * Why does a media download come back 403?
 *
 * Written because the answer was being guessed at, and a guess produces a fix
 * that works on one site and quietly does nothing on the next. A failed media
 * fetch has several plausible causes at once — the wrong session, no cookies,
 * no referrer, the wrong user agent, or an address that genuinely cannot be
 * fetched by anything but the page that minted it — and from the outside they
 * are indistinguishable. All you see is 403.
 *
 * So this asks each site the same question four ways and prints the answers
 * next to each other:
 *
 *  - **bare** — what the engine used to do: default session, no headers at all.
 *  - **session** — the tab's session and cookies, still no headers.
 *  - **headers** — referrer, origin and user agent, but the default session.
 *  - **page** — all of it, which is what the engine does now.
 *
 * `bare` failing where `page` succeeds is the fix, demonstrated. All four
 * failing is a different finding and a more important one: it means the address
 * cannot be fetched outside its page, and the honest response is to *say so*
 * rather than to retry four times and report a status code.
 *
 * Its own module rather than another entry in `spikeCapture.ts` because it is
 * the only probe that talks to third-party sites over the real network, so what
 * it does and does not send is worth reading in one place.
 */
export async function runMediaAccessProbe(
  window: BrowserWindowController,
  hooks: {
    /** What the sniffer saw on this tab. */
    sniffed: (contents: WebContents) => { url: string; kind: string; label: string }[]
    /** The real context the engine would now use for a download from this tab. */
    contextFor: (contents: WebContents) => MediaRequestContext | undefined
    /**
     * Whether Slash Shield decided about this URL, and what it decided.
     *
     * Asked because `ERR_BLOCKED_BY_CLIENT` says only that *something* on this
     * machine refused the request. Our own blocker is the obvious suspect and
     * the one we can check, and "it was us" and "it was not us" need completely
     * different fixes.
     */
    shieldDecisions: () => { url: string; blocked: boolean }[]
    /** How many requests Slash Shield's listener has seen, to tell "we blocked
     * it" from "it never reached us". */
    shieldSeen: () => number
  }
): Promise<void> {
  const activeId = await waitForActiveTab(window)
  if (!activeId) {
    log.error('media access probe: no tab appeared')
    app.quit()
    return
  }

  /**
   * Every mode, one header's worth apart.
   *
   * Coarser buckets were the first version and they were not enough: "headers"
   * failing told us the headers were the problem and not which one, and the
   * answer turned out to be a header Chromium reserves for itself rather than
   * any of the ones a CDN checks. One variable at a time, or the probe just
   * relocates the guess.
   */
  const modes = [
    'bare',
    'session',
    'ua',
    'referer',
    'referer-alt',
    'referer-origin',
    'origin',
    'secfetch',
    'headers',
    'page',
    // The two the engine itself sends, which nothing here was testing.
    // `SegmentedDownload.probe()` opens with `Range: bytes=0-0` to learn the
    // length and whether ranges are supported; if a CDN refuses *that* while
    // serving everything else, every download fails before a byte moves and
    // the mode list above would have shown nothing but green.
    'page-range0',
    'page-range'
  ] as const
  type Mode = (typeof modes)[number]

  /** What each mode is allowed to send. */
  const narrow = (
    mode: Mode,
    full: MediaRequestContext | undefined
  ): { context: MediaRequestContext | undefined; extra: Record<string, string> } => {
    if (mode === 'bare' || full === undefined) return { context: undefined, extra: {} }
    switch (mode) {
      case 'session':
        return { context: { session: full.session }, extra: {} }
      case 'ua':
        return { context: { userAgent: full.userAgent }, extra: {} }
      case 'referer':
        return { context: {}, extra: full.referer ? { Referer: full.referer } : {} }
      case 'referer-origin':
        // The page's host without its path. Separates "this site's name is
        // being matched" from "this long URL is".
        return { context: {}, extra: full.origin ? { Referer: `${full.origin}/` } : {} }
      case 'referer-alt':
        // A referrer the CDN has never heard of. If the real one is refused and
        // this one is not, something is matching the value rather than the
        // presence of the header.
        return { context: {}, extra: { Referer: 'https://example.com/' } }
      case 'origin':
        return { context: {}, extra: full.origin ? { Origin: full.origin } : {} }
      case 'page-range0':
        return { context: full, extra: { Range: 'bytes=0-0' } }
      case 'page-range':
        return { context: full, extra: { Range: 'bytes=0-1048575' } }
      case 'secfetch':
        return {
          context: {},
          extra: {
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'cross-site'
          }
        }
      case 'headers':
        return {
          context: { referer: full.referer, origin: full.origin, userAgent: full.userAgent },
          extra: {}
        }
      default:
        return { context: full, extra: {} }
    }
  }

  /**
   * One request, one status code.
   *
   * Media is asked for a single kilobyte — the question is whether the server
   * will answer at all, and downloading 200 MB four times to find out would
   * make the probe the slowest thing in the repository.
   */
  const ask = async (
    url: string,
    mode: Mode,
    full: MediaRequestContext | undefined,
    wantText: boolean
  ): Promise<{ status: string; text: string }> => {
    let redirected = ''
    const { context, extra } = narrow(mode, full)
    const headers = { ...extra, ...(wantText ? {} : { Range: 'bytes=0-1023' }) }
    // `bare` is the old code path *exactly*: manual redirect with nobody
    // following it, which is how every segment on a redirecting CDN failed.
    const request =
      mode === 'bare'
        ? net.request({ url, method: 'GET', redirect: 'manual' })
        : openMediaRequest(url, context, headers)
    request.on('redirect', (status: number, _method: string, redirectUrl: string) => {
      if (mode === 'bare') {
        redirected = ` [${status}, not followed]`
        return
      }
      redirected = ` [followed → ${new URL(redirectUrl).host}]`
      request.followRedirect()
    })

    try {
      const response = await new Promise<Electron.IncomingMessage>((resolve, reject) => {
        request.on('response', resolve)
        request.on('error', reject)
        // A hung CDN must not hold the rest of the probe hostage.
        setTimeout(() => reject(new Error('timeout')), 20_000)
        request.end()
      })

      if (!wantText) {
        try {
          request.abort()
        } catch {
          // Already finished; nothing to stop.
        }
        return { status: `${response.statusCode}${redirected}`, text: '' }
      }

      const body = await new Promise<string>((resolve) => {
        const parts: Buffer[] = []
        response.on('data', (chunk: Buffer) => parts.push(chunk))
        response.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
        response.on('error', () => resolve(''))
      })
      return { status: `${response.statusCode}${redirected}`, text: body }
    } catch (error) {
      return { status: `${error instanceof Error ? error.message : 'failed'}${redirected}`, text: '' }
    }
  }

  const compare = async (
    label: string,
    url: string,
    context: MediaRequestContext | undefined,
    wantText: boolean
  ): Promise<string> => {
    const results: string[] = []
    let text = ''
    for (const mode of modes) {
      const before = hooks.shieldDecisions().length
      const seenBefore = hooks.shieldSeen()
      const answer = await ask(url, mode, context, wantText)
      const during = hooks.shieldDecisions().slice(before)
      const ours = during.filter((decision) => decision.blocked)
      results.push(
        `${mode}=${answer.status}[shieldSaw+${hooks.shieldSeen() - seenBefore}` +
          `${ours.length > 0 ? ` blocked:${ours[0]?.url.slice(0, 40)}` : ''}]`
      )
      if (mode === 'page') text = answer.text
    }
    log.info(`  ${label}: ${results.join('  ')}`)
    return text
  }

  const visit = async (url: string, settleMs: number): Promise<WebContents | null> => {
    window.tabs.activate(activeId)
    window.tabs.navigate(activeId, url)
    await delay(settleMs)
    const contents = window.tabs.findById(activeId)?.contents ?? null
    if (contents) log.info(`  loaded: ${contents.getURL().slice(0, 120)}`)
    return contents
  }

  // --- YouTube ---------------------------------------------------------------
  log.info('media access probe: youtube.com/watch?v=vrzIePSBu8k')
  const youtube = await visit('https://www.youtube.com/watch?v=vrzIePSBu8k&t=2685s', 20_000)
  if (youtube) {
    const context = hooks.contextFor(youtube)

    // What the page actually has, before asking the extractor for an opinion.
    // The first run of this probe reported "0 formats, 0 signed", which is what
    // the extractor says both when a page lists nothing and when its script
    // returned null — two very different findings wearing the same number.
    const state = (await youtube.executeJavaScript(
      `(() => {
         try {
           const p = document.querySelector('#movie_player');
           const r =
             (p && typeof p.getPlayerResponse === 'function' ? p.getPlayerResponse() : null) ||
             window.ytInitialPlayerResponse || null;
           const s = r && r.streamingData;
           return JSON.stringify({
             player: !!p,
             getPlayerResponse: !!(p && typeof p.getPlayerResponse === 'function'),
             initial: typeof window.ytInitialPlayerResponse,
             streamingData: !!s,
             formats: s && s.formats ? s.formats.length : 0,
             adaptive: s && s.adaptiveFormats ? s.adaptiveFormats.length : 0,
             withUrl: s ? [].concat(s.formats || [], s.adaptiveFormats || []).filter((f) => !!f.url).length : 0,
             withCipher: s ? [].concat(s.formats || [], s.adaptiveFormats || []).filter((f) => !!(f.signatureCipher || f.cipher)).length : 0,
             qualities: s ? [].concat(s.formats || [], s.adaptiveFormats || []).map((f) => (f.qualityLabel || f.audioQuality || '?') + (f.url ? '' : '(signed)')).slice(0, 30) : [],
             status: r && r.playabilityStatus ? r.playabilityStatus.status : 'none'
           });
         } catch (e) { return JSON.stringify({ threw: String(e) }); }
       })()`,
      true
    )) as string
    log.info(`  page state: ${state}`)

    const raw: unknown = await youtube.executeJavaScript(EXTRACT_SCRIPT, true)
    const analysis = analyseFormats((raw as { streamingData?: unknown } | null)?.streamingData as never)

    log.info(
      `  extractor: ${analysis.choices.length} offerable, ${analysis.signed} signed, ` +
        `${analysis.serverDriven} with no address at all`
    )
    for (const choice of analysis.choices) {
      log.info(`    offerable: ${choice.label} · ${choice.mimeType} · complete=${choice.complete}`)
    }

    const first = analysis.choices[0]
    if (first) await compare(`format "${first.label}"`, first.url, context, false)
    else log.info('  nothing offerable — see the page state above for which reason')

    // The case the user actually hits. Nothing on the page has an address, so
    // the only thing the download button can offer is what the *sniffer* saw
    // going past - a `videoplayback` URL the player itself requested. Those are
    // what the downloads list shows failing with 403, so the question worth
    // answering is whether any request shape gets them.
    //
    // Autoplay is blocked under automation, so nothing streams and the sniffer
    // stays empty. `userGesture` is what makes play() permitted.
    await youtube
      .executeJavaScript(
        `(() => { const v = document.querySelector('video'); if (!v) return false; v.muted = true; v.play(); return true })()`,
        true
      )
      .catch(() => false)
    await delay(12_000)

    const streamed = hooks.sniffed(youtube)
    log.info(`  sniffer holds ${streamed.length} item(s) after playback started`)
    const playback = streamed.find((item) => /googlevideo\.com/i.test(item.url))
    if (playback) {
      const itag = /[?&]itag=(\d+)/.exec(playback.url)?.[1] ?? 'none'
      const expire = /[?&]expire=(\d+)/.exec(playback.url)?.[1]
      const age = expire ? Math.round((Number(expire) * 1000 - Date.now()) / 1000) : null
      log.info(`  playback URL: itag=${itag} expires in ${age === null ? 'unknown' : `${age}s`}`)
      await compare('sniffed videoplayback', playback.url, context, false)
    } else {
      log.info('  no videoplayback URL was seen at all — the media is not arriving as fetchable responses')
    }

    // ---- can the player be asked for a different quality? -----------------
    // The picker can only offer what has actually played, so "only 360p" is a
    // consequence of YouTube starting low and climbing. The question is whether
    // the *site's own* player API will fetch a chosen quality on request — the
    // same call its quality menu makes. If it does, the sniffer sees that
    // quality's segments and the picker can offer it.
    const api = (await youtube.executeJavaScript(
      `(() => {
         const p = document.querySelector('#movie_player');
         if (!p) return JSON.stringify({ player: false });
         return JSON.stringify({
           player: true,
           setRange: typeof p.setPlaybackQualityRange === 'function',
           setQuality: typeof p.setPlaybackQuality === 'function',
           getLevels: typeof p.getAvailableQualityLevels === 'function',
           levels: typeof p.getAvailableQualityLevels === 'function' ? p.getAvailableQualityLevels() : [],
           current: typeof p.getPlaybackQuality === 'function' ? p.getPlaybackQuality() : '?'
         });
       })()`,
      true
    )) as string
    log.info(`  player API: ${api}`)

    const before = new Set(
      hooks.sniffed(youtube).map((item) => /[?&]itag=(\d+)/.exec(item.url)?.[1] ?? '?')
    )
    log.info(`  itags before switching: [${[...before].join(', ')}]`)

    const switched = (await youtube.executeJavaScript(
      `(() => {
         const p = document.querySelector('#movie_player');
         if (!p || typeof p.setPlaybackQualityRange !== 'function') return 'no api';
         p.setPlaybackQualityRange('hd1080', 'hd1080');
         if (typeof p.setPlaybackQuality === 'function') p.setPlaybackQuality('hd1080');
         return 'asked for hd1080';
       })()`,
      true
    )) as string
    log.info(`  ${switched}`)
    await delay(14_000)

    const after = hooks.sniffed(youtube)
    const afterTags = after.map((item) => /[?&]itag=(\d+)/.exec(item.url)?.[1] ?? '?')
    log.info(`  itags after switching: [${afterTags.join(', ')}]`)
    log.info(
      `  quality now: ${await youtube.executeJavaScript(
        `(() => { const p = document.querySelector('#movie_player'); return p && p.getPlaybackQuality ? p.getPlaybackQuality() : '?' })()`,
        true
      )}`
    )

    const fresh = afterTags.filter((tag) => !before.has(tag))
    log.info(
      fresh.length > 0
        ? `  NEW itags appeared after asking for 1080p: [${fresh.join(', ')}] — the player fetches on request`
        : '  no new itags — asking the player for a quality did not produce new segments'
    )
  }

  // --- The film sites --------------------------------------------------------
  for (const site of [
    'https://ww8.123moviesfree.net/movie/spider-man-brand-new-day-1223/',
    'https://streamm4u.vip/movies/doctor-strange-in-the-multiverse-of-madness-2022-yoddc'
  ]) {
    log.info(`media access probe: ${site}`)
    const contents = await visit(site, 10_000)
    if (!contents) continue

    // The playlist is only requested once the player starts, and autoplay is
    // off. These players live in a cross-origin iframe, so a script in the main
    // frame cannot reach them — a real click is the only thing that starts one.
    // What is on the page is logged first, because the first run of this probe
    // saw nothing at all and could not say whether that was a player it failed
    // to start or a page with no player on it.
    const layout = (await contents.executeJavaScript(
      `(() => {
         try {
           const rect = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
           return JSON.stringify({
             videos: [].slice.call(document.querySelectorAll('video')).map((v) => ({ src: (v.currentSrc || v.src || '').slice(0, 80), box: rect(v) })),
             iframes: [].slice.call(document.querySelectorAll('iframe')).map((f) => ({ src: (f.src || '').slice(0, 100), box: rect(f) }))
           });
         } catch (e) { return JSON.stringify({ threw: String(e) }); }
       })()`,
      true
    )) as string
    log.info(`  players on the page: ${layout}`)

    // Clicked where the player actually is, taken from the layout above rather
    // than guessed at as a fraction of the window — the first version guessed
    // and hit the page background twice.
    const boxes = (JSON.parse(layout) as {
      videos?: { box: number[] }[]
      iframes?: { box: number[] }[]
    }) ?? {}
    const targets = [...(boxes.videos ?? []), ...(boxes.iframes ?? [])]
      .map((entry) => entry.box)
      .filter((box) => (box[2] ?? 0) > 200 && (box[3] ?? 0) > 150)
      .slice(0, 2)

    // No inset: sendInputEvent's coordinates are the page view's own, and the
    // rectangles above came from that same document.
    for (const box of targets) {
      const x = Math.round((box[0] ?? 0) + (box[2] ?? 0) / 2)
      const y = Math.round((box[1] ?? 0) + (box[3] ?? 0) / 2)
      log.info(`  clicking player at ${x},${y}`)
      contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      await delay(8000)
    }
    await delay(8000)

    const context = hooks.contextFor(contents)
    const found = hooks.sniffed(contents)
    log.info(`  sniffer saw ${found.length} item(s)`)
    for (const item of found) log.info(`    ${item.kind}: ${item.label} — ${item.url.slice(0, 120)}`)

    const stream = found.find((item) => item.kind === 'stream')
    if (!stream) {
      log.info('  no playlist seen — the player never started, or this is not HLS')
      continue
    }

    const text = await compare('playlist', stream.url, context, true)
    if (text === '') {
      log.info('  playlist body was empty even as the page’s own request')
      continue
    }
    log.info(`  playlist is a ${isMasterPlaylist(text) ? 'master' : 'media'} playlist`)
    log.info(`  head: ${text.slice(0, 220).replace(/\s+/g, ' ')}`)

    // Which playlist the engine would actually plan, and with what hint. A
    // media playlist is not a lesser case to skip: this CDN serves one directly
    // and the picker has no qualities to offer, which is a finding rather than
    // a gap.
    let target = stream.url
    let hint: { bandwidth?: number; quality?: string | null } | undefined
    if (isMasterPlaylist(text)) {
      const variants = parseMaster(text, stream.url)
      log.info(`  ${variants.length} quality variant(s) — this is what the picker can now offer:`)
      for (const variant of variants) {
        log.info(`    ${variant.resolution ?? 'no resolution declared'} · ${variant.bandwidth} bps`)
      }
      const best = variants[0]
      if (!best) continue
      target = best.url
      hint = { bandwidth: best.bandwidth, quality: best.resolution }
      await compare('best variant', best.url, context, true)
    } else {
      log.info('  one rendition only — nothing to choose between, and the picker says so')
    }

    // The real planner, on the real playlist, with the real context — because
    // "the playlist fetched" and "the engine can download it" are different
    // claims and only the second one matters. `planStream` is what
    // `DownloadQueue.beginStream` calls, so a refusal here is the refusal the
    // user would have seen.
    const planned = await planStream(target, context, hint)
    if (!planned.ok) {
      log.info(`  planStream refused: ${planned.reason}`)
      continue
    }
    log.info(
      `  planStream: ${planned.plan.segments.length} segments · container=${planned.plan.container} · ` +
        `estimate=${planned.plan.estimatedBytes ?? 'unknown'} bytes · quality=${planned.plan.quality ?? 'not declared'}`
    )

    const firstSegment = planned.plan.segments[0]
    if (!firstSegment) {
      log.info('  the plan has no segments, which is a refusal that did not say so')
      continue
    }
    await compare('first segment', firstSegment, context, false)

    // Read one segment back rather than trusting the status code. A CDN that
    // answers 200 with an HTML error page is the failure this catches: the
    // download completes, the file is the right size, and nothing plays it.
    const bytes = await fetchBytes(firstSegment, context)
    log.info(
      `  first segment: ${bytes.length} bytes, ` +
        (bytes.length === 0
          ? 'EMPTY'
          : bytes[0] === 0x47
            ? 'starts with the MPEG-TS sync byte — real video'
            : `starts with 0x${(bytes[0] ?? 0).toString(16)}: ${JSON.stringify(bytes.subarray(0, 32).toString('utf8'))}`)
    )
  }

  log.info('media access probe: done. bare=403 next to page=200/206 is the fix, demonstrated.')
  app.quit()
}

/** The first kilobytes of a URL, for looking at what actually came back. */
async function fetchBytes(url: string, context: MediaRequestContext | undefined): Promise<Buffer> {
  try {
    const { response } = await sendMediaRequest(url, context)
    if (response.statusCode >= 400) return Buffer.alloc(0)
    return await new Promise<Buffer>((resolve) => {
      const parts: Buffer[] = []
      let total = 0
      response.on('data', (chunk: Buffer) => {
        parts.push(chunk)
        total += chunk.length
        if (total > 64_000) resolve(Buffer.concat(parts))
      })
      response.on('end', () => resolve(Buffer.concat(parts)))
      response.on('error', () => resolve(Buffer.concat(parts)))
    })
  } catch {
    return Buffer.alloc(0)
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The first tab is created on the chrome view's load, so this waits rather than assumes. */
async function waitForActiveTab(window: BrowserWindowController): Promise<string | null> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const id = window.tabs.snapshot().activeTabId
    if (id) return id
    await delay(250)
  }
  return null
}
