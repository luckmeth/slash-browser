/**
 * The shared core, as the mobile shells see it.
 *
 * Phase A's whole argument is that Slash is already factored into pure policy
 * and privileged I/O — `scripts/core-boundary.mjs` measures it — so the planning
 * half can run unchanged on Android and iOS while only the I/O half is rewritten
 * per platform. This file is where that claim becomes a build artefact.
 *
 * The surface is deliberately one function. `call(name, argsJson) -> resultJson`
 * is the smallest thing that works identically in a headless WebView (V8), in
 * QuickJS, and in JavaScriptCore on iOS, so the choice of JS engine stays a
 * shell decision rather than something baked into the core. Everything crosses
 * as JSON because that is the only representation all three agree on.
 *
 * Nothing here may import `electron`, a native module, or a node builtin. The
 * boundary is enforced by `src/core/coreBoundary.test.ts`, not by good manners.
 */
import type { Segment } from '@shared/types/downloadEngine'
import { planSplit, remainingBytes, MIN_SPLIT_BYTES } from '@main/downloads/engine/segmentSplitting'
import { mediaFilename } from '@main/downloads/engine/mediaFilename'
import { classifyFailure } from '@main/downloads/engine/retryPolicy'
import { mediaIdentity } from '@main/media/mediaIdentity'
import {
  advance as advanceEarning,
  close as closeEarning,
  qualifies,
  MAX_SAMPLE_GAP_MS,
  MIN_INTERVAL_SECONDS,
  SAMPLE_INTERVAL_MS,
  type IntervalState,
  type EarningInputs
} from '@main/rewards/earningRules'
import { decidePopup, explainPopup, type PopupFacts } from '@main/shield/PopupPolicy'
import {
  decideRedirect,
  explainRedirect,
  type RedirectFacts
} from '@main/shield/RedirectChainMonitor'
import {
  isLive,
  selectLive,
  acceptCreative,
  type Creative,
  type Scheduled
} from '@main/sponsor/sponsorRules'
import { buildYouTubeAdScript } from '@main/shield/youtubeAdScript'
import { buildPopupDefuserScript } from '@main/shield/inject/popupDefuserScript'
import { buildContextMenuScript } from '@main/shield/inject/contextMenuScript'
import {
  DEFAULT_BLOCK_DOMAINS,
  DEFAULT_TRACKER_DOMAINS,
  DEFAULT_MALICIOUS_DOMAINS,
  DEFAULT_PATH_RULES
} from '@main/shield/defaultLists'

/**
 * Every exposed function takes one parsed-JSON argument and returns anything
 * JSON-serialisable.
 *
 * `Record<string, unknown>` rather than `any`, and each wrapper below asserts
 * the shape it needs. That keeps the assertion visible at the point where trust
 * is actually placed — the parse of a string that came from a native shell —
 * instead of letting `any` erase the boundary everywhere downstream, which is
 * the same reason the IPC layer refuses it. zod would be the rigorous answer and
 * is deliberately not used: it would cost more than the entire core bundle.
 */
type CoreArgs = Record<string, unknown>
type CoreFn = (args: CoreArgs) => unknown

const FUNCTIONS: Record<string, CoreFn> = {
  /** Version marker, so a shell can tell which core bundle it actually loaded. */
  version: () => ({ core: '0.1.0', functions: Object.keys(FUNCTIONS).sort() }),

  planSplit: (a) =>
    planSplit(a.segments as Segment[], a.nextIndex as number, a.minSplitBytes as number | undefined),

  remainingBytes: (a) => remainingBytes(a.segment as Segment),

  mediaFilename: (a) =>
    mediaFilename(a.pageTitle as string, a.url as string, a.fallback as string | undefined),

  mediaIdentity: (a) => mediaIdentity(a.url as string),

  /**
   * `error` crosses as a plain object — `{ status: 403 }`, or `{ message: '…' }`
   * — because a native shell has no Error to hand over. `classifyFailure` reads
   * `status` off whatever it is given and falls back to the message, so this is
   * the real function on real input rather than a mobile-shaped copy of it.
   */
  classifyFailure: (a) =>
    classifyFailure(a.error, {
      retryAfter: a.retryAfter as string | null | undefined,
      now: a.now as number | undefined
    }),

  /**
   * The coverage invariant, callable from the shell.
   *
   * Work-stealing is the one piece of this engine that corrupts a file without
   * failing anything: a gap or an overlap does not throw, does not fail a
   * request, and does not stop the download reaching 100% — it writes a file
   * that opens, plays for a while, and is wrong in the middle. So the Android
   * shell can assert the same property the desktop tests assert, against the
   * same implementation, rather than trusting that a port preserved it.
   */
  checkCoverage: (a) => checkCoverage(a.segments as Segment[], a.total as number),

  /**
   * The shield's rules, as **data** rather than as a decision.
   *
   * Matching happens in Kotlin, on the interception thread, synchronously. That
   * is a deliberate exception to sharing: `shouldInterceptRequest` fires for
   * every subresource on every page, and routing each one through a JS bridge
   * would put an asynchronous hop on the browsing path — principle 1 forbids
   * exactly that, and it is the same reasoning that keeps segment transfer
   * native while the *planning* stays here.
   *
   * So the lists cross once at startup and the host-suffix match is ported. The
   * port is small, and `ShieldEngineTest` checks it against the cases
   * `FilterEngine.test.ts` checks, so the two cannot quietly disagree.
   */
  shieldLists: () => ({
    ads: DEFAULT_BLOCK_DOMAINS,
    trackers: DEFAULT_TRACKER_DOMAINS,
    malicious: DEFAULT_MALICIOUS_DOMAINS,
    pathRules: DEFAULT_PATH_RULES
  }),

  /**
   * Scripts that must run before the page's own, fetched once at startup.
   *
   * These are the desktop's files verbatim — the YouTube field strip deletes
   * `adPlacements`, `playerAds`, `adSlots` and `adBreakHeartbeatParams` and the
   * `ssap` config, and each re-checks its own hostname and setting at runtime.
   * Android has no single-debugger-client limit, so unlike desktop there is no
   * attach-point bottleneck and no fight with DevTools.
   */
  scripts: () => ({
    youtubeAds: buildYouTubeAdScript(),
    popupDefuser: buildPopupDefuserScript(),
    contextMenu: buildContextMenuScript()
  }),

  /**
   * Whether a creative from an operator's endpoint may be shown at all.
   *
   * Shared rather than re-implemented because both rules are privacy promises,
   * not formatting preferences: an image that is not a `data:` URL is a request
   * to the sponsor's server on every impression — a tracking pixel wearing a
   * different hat, which defeats the entire point of batching — and a click
   * target that is not `https:` sends somebody somewhere tamperable. A second
   * implementation of this on Android is a second chance to get it wrong.
   */
  acceptCreative: (a) => acceptCreative(a.creative as Creative),

  /**
   * The creative due now.
   *
   * `selectLive` filters to currently-running campaigns and *then* rotates, so
   * a batch holding future campaigns still shows its live ones evenly rather
   * than leaving gaps where a scheduled one would have been.
   *
   * A query, never an advance: an earlier desktop version rotated as it read,
   * so every caller moved the batch on — including the click handler, which
   * then compared the clicked id against a different creative and billed a
   * click that opened nothing.
   */
  selectSponsored: (a) =>
    selectLive(
      (a.creatives ?? []) as (Creative & Scheduled)[],
      (a.rotation ?? 0) as number,
      a.now as number
    ),

  /** Whether one campaign window is open at `now`. */
  isLive: (a) => isLive(a.window as Scheduled, a.now as number),

  /** Just the filter, for a caller that wants the whole live set. */
  liveCreatives: (a) => {
    const now = a.now as number
    return ((a.creatives ?? []) as (Creative & Scheduled)[]).filter((c) => isLive(c, now))
  },

  /**
   * One tick of the Slash Coin earning clock.
   *
   * Shared rather than ported, and this is the clearest case for it in the whole
   * core: these rules are the anti-farming logic, they are subtle, and a second
   * implementation that is *nearly* right would be indistinguishable from the
   * real one until somebody noticed a phone banking the eight hours it spent
   * asleep. A sample is taken every 30 seconds, so a bridge call per sample is
   * nothing.
   *
   * Note that `accumulatedMs` is not `lastSampleAt - startedAt`: only the gaps
   * between two consecutive *qualifying* samples count, which is the whole
   * point.
   */
  earningAdvance: (a) =>
    advanceEarning(
      (a.state ?? null) as IntervalState | null,
      a.sample as { at: number; qualifying: boolean },
      (a.maxGapMs ?? MAX_SAMPLE_GAP_MS) as number
    ),

  /** Closes the open interval, or returns null if it is too short to report. */
  earningClose: (a) => closeEarning(a.state as IntervalState),

  /** Whether the browser is in a state that earns at all. */
  earningQualifies: (a) => qualifies(a.input as EarningInputs),

  earningConstants: () => ({
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    maxSampleGapMs: MAX_SAMPLE_GAP_MS,
    minIntervalSeconds: MIN_INTERVAL_SECONDS
  }),

  /**
   * Whether a window a page tried to open should be allowed.
   *
   * Shared, not ported. The interesting half of this policy is not "was there a
   * click" — it is everything after that: one gesture may open one window, a
   * gesture explains *that* a window opened and not that the user wanted that
   * destination, and a popunder is a real click whose target happens to be an
   * ad host. Those rules took a while to get right on the desktop and a second
   * implementation would be a second set of them to get right.
   */
  decidePopup: (a) => {
    const verdict = decidePopup(a.facts as PopupFacts)
    return { ...verdict, explanation: explainPopup(verdict.reason) }
  },

  /**
   * Whether a top-level navigation should be allowed to continue.
   *
   * The ordering here is the whole value, and it is not obvious: identity
   * providers are exempted *before* anything can form an opinion, because a
   * sign-in flow is supposed to cross five domains and flagging that would make
   * the warning worthless everywhere it matters. Only then does an ad
   * destination reached without a click block outright — the one case with an
   * actual rule behind it rather than a heuristic.
   *
   * A second implementation of that ordering would get it subtly wrong, and the
   * failure mode is a browser that cries wolf on every login.
   */
  decideRedirect: (a) => {
    const verdict = decideRedirect(a.facts as RedirectFacts)
    return { ...verdict, explanation: explainRedirect(verdict.reason) }
  }
}

/** Tiles `[0, total)` with no gap and no overlap, or says exactly where it failed. */
function checkCoverage(
  segments: readonly Segment[],
  total: number
): { ok: true } | { ok: false; reason: string } {
  const ordered = [...segments].sort((x, y) => x.start - y.start)
  let cursor = 0
  for (const segment of ordered) {
    if (segment.start > cursor) {
      return { ok: false, reason: `gap at ${cursor}..${segment.start - 1}` }
    }
    if (segment.start < cursor) {
      return { ok: false, reason: `overlap at ${segment.start}, expected ${cursor}` }
    }
    cursor = segment.end + 1
  }
  if (cursor !== total) return { ok: false, reason: `covered ${cursor} of ${total}` }
  return { ok: true }
}

export interface CoreBridge {
  call(name: string, argsJson: string): string
}

const bridge: CoreBridge = {
  call(name, argsJson) {
    try {
      const fn = FUNCTIONS[name]
      if (!fn) return JSON.stringify({ ok: false, error: `no such core function: ${name}` })
      const args = argsJson === '' ? {} : JSON.parse(argsJson)
      return JSON.stringify({ ok: true, value: fn(args) })
    } catch (error) {
      // A throw must not cross the bridge — a shell reading a native exception
      // out of a JS engine gets a stack trace instead of a result, and every
      // caller then has two failure shapes to handle.
      return JSON.stringify({ ok: false, error: String(error) })
    }
  }
}

// Attached to globalThis rather than exported, because the consumers are three
// different JS engines embedded in native shells, none of which speaks ESM.
;(globalThis as unknown as { SlashCore: CoreBridge }).SlashCore = bridge

export { MIN_SPLIT_BYTES }
export default bridge
