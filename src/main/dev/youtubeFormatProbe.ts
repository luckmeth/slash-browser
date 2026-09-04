import { app } from 'electron'
import type { BrowserWindowController } from '../windows/BrowserWindowController'
import { analyseFormats } from '../media/pageFormats'
import { createLogger } from '../logger'

const log = createLogger('spike')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const TARGET =
  process.env['SLASH_YT_URL'] ?? 'https://www.youtube.com/watch?v=vrzIePSBu8k&t=2685s'

/**
 * How many qualities does a real watch page actually put within reach?
 *
 * The picker offers one row on YouTube and the question is whether that is a
 * bug in the reader or a fact about the page. Those need opposite responses, so
 * this counts rather than argues: every format the page lists, split by whether
 * it carries a plain `url`, a `signatureCipher`, or **neither**.
 *
 * Neither is the interesting bucket. It means the page names the format but no
 * address for it exists anywhere in the document — the player asks the server
 * for each piece as it plays. Nothing can be fetched from a format like that,
 * by us or by anything else reading the page, and no amount of work on the
 * reader changes it.
 */
export interface FormatProbeHooks {
  /** What the network observer collected for this tab. */
  sniffed: () => { url: string; kind: string; label: string }[]
}

export async function runYouTubeFormatProbe(
  window: BrowserWindowController,
  hooks: FormatProbeHooks
): Promise<void> {
  const tabs = window.tabs
  const activeId = tabs.snapshot().activeTabId
  if (!activeId) {
    log.error('yt-format probe: FAIL — no active tab')
    app.quit()
    return
  }

  tabs.navigate(activeId, TARGET)
  log.info(`yt-format probe: loading ${TARGET}`)
  // Long enough for the player to install `ytInitialPlayerResponse`.
  await delay(14_000)

  const contents = tabs.activeTab?.contents ?? null
  // Autoplay is blocked under automation, so nothing streams and the sniffer
  // stays empty — which would look exactly like "there is nothing here". Start
  // it by hand: `userGesture` is what makes play() permitted.
  if (contents) {
    await contents
      .executeJavaScript(
        `(() => { const v = document.querySelector('video'); if (v) { v.muted = true; v.play(); return true } return false })()`,
        true
      )
      .catch(() => false)
    await delay(12_000)
  }
  if (!contents) {
    log.error('yt-format probe: FAIL — tab has no contents')
    app.quit()
    return
  }

  try {
    const raw = (await contents.executeJavaScript(
      `(() => {
        const r = window.ytInitialPlayerResponse;
        const s = r && r.streamingData;
        const pick = (list) => (Array.isArray(list) ? list : []).map((f) => ({
          itag: f.itag,
          quality: f.qualityLabel || (f.height ? f.height + 'p' : ''),
          mime: (f.mimeType || '').split(';')[0],
          bytes: f.contentLength ? Number(f.contentLength) : null,
          hasUrl: typeof f.url === 'string' && f.url.length > 0,
          signed: !!(f.signatureCipher || f.cipher)
        }));
        return {
          found: !!s,
          title: (r && r.videoDetails && r.videoDetails.title) || '',
          progressive: pick(s && s.formats),
          adaptive: pick(s && s.adaptiveFormats)
        };
      })()`,
      true
    )) as {
      found: boolean
      title: string
      progressive: { itag: number; quality: string; mime: string; bytes: number | null; hasUrl: boolean; signed: boolean }[]
      adaptive: { itag: number; quality: string; mime: string; bytes: number | null; hasUrl: boolean; signed: boolean }[]
    }

    if (!raw.found) {
      log.error('yt-format probe: FAIL — no ytInitialPlayerResponse.streamingData on the page')
      app.quit()
      return
    }

    const all = [...raw.progressive, ...raw.adaptive]
    const withUrl = all.filter((f) => f.hasUrl)
    const signed = all.filter((f) => !f.hasUrl && f.signed)
    const serverDriven = all.filter((f) => !f.hasUrl && !f.signed)

    log.info(`yt-format probe: "${raw.title}"`)
    log.info(
      `yt-format probe: ${all.length} formats — ${raw.progressive.length} progressive, ${raw.adaptive.length} adaptive`
    )
    log.info(
      `yt-format probe: ${withUrl.length} carry a plain URL, ${signed.length} are signed, ${serverDriven.length} have no address at all`
    )

    // The ones that matter: what could actually be fetched, and at what quality.
    const videoWithUrl = withUrl.filter((f) => f.mime.startsWith('video'))
    const audioWithUrl = withUrl.filter((f) => f.mime.startsWith('audio'))
    log.info(
      `yt-format probe: fetchable video qualities = [${videoWithUrl.map((f) => `${f.quality}/${f.itag}`).join(', ') || 'none'}]`
    )
    log.info(
      `yt-format probe: fetchable audio tracks = [${audioWithUrl.map((f) => `${f.itag}`).join(', ') || 'none'}]`
    )
    log.info(
      `yt-format probe: signed video qualities = [${signed.filter((f) => f.mime.startsWith('video')).map((f) => f.quality).join(', ') || 'none'}]`
    )

    // And what the shipping reader makes of the same page.
    const analysis = analyseFormats({
      formats: raw.progressive.map((f) => ({ ...f })) as never,
      adaptiveFormats: raw.adaptive.map((f) => ({ ...f })) as never
    })
    log.info(
      `yt-format probe: the picker would offer ${analysis.choices.length} row(s): [${analysis.choices.map((c) => c.label).join(' | ')}]`
    )
    // ---- the other half: what the network observer actually caught ---------
    // The page reader and the sniffer are independent routes to the same
    // button, and when the page carries no addresses the sniffer is the only
    // one left. Its offers are the quality the player *is streaming*, which is
    // a different question from the quality the page lists.
    const sniffed = hooks.sniffed()
    log.info(`yt-format probe: the sniffer holds ${sniffed.length} item(s)`)
    for (const item of sniffed.slice(0, 12)) {
      const itag = /[?&]itag=(\d+)/.exec(item.url)?.[1] ?? 'none'
      const mime = /[?&]mime=([^&]+)/.exec(item.url)?.[1] ?? 'unknown'
      log.info(
        `yt-format probe:   ${item.kind} itag=${itag} mime=${decodeURIComponent(mime)} — ${item.label}`
      )
    }
  } catch (error) {
    log.error(`yt-format probe: FAIL — ${error instanceof Error ? error.message : String(error)}`)
  }

  if (process.env['SLASH_PROBE_EXIT']) app.quit()
}
