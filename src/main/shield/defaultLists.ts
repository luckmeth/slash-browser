/**
 * Bundled starter lists.
 *
 * Shipped in the binary so blocking works on first launch with no network
 * fetch — a blocker that needs to phone home before it protects anything is not
 * much of a default.
 *
 * **This is a starter list, not EasyList.** It covers the large advertising and
 * analytics networks, which is most of the traffic by volume, but it is nowhere
 * near as comprehensive as uBlock Origin's lists and the Settings panel says so.
 * `ContentBlocker` can merge additional domains at runtime, which is where a
 * subscribable list would plug in.
 */

/** Advertising, analytics and cross-site tracking hosts. */
export const DEFAULT_BLOCK_DOMAINS: readonly string[] = [
  // Google advertising / measurement
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'google-analytics.com',
  'googletagmanager.com',
  'googletagservices.com',
  'adservice.google.com',
  'pagead2.googlesyndication.com',
  // Meta
  'connect.facebook.net',
  'facebook.net',
  'atdmt.com',
  // Amazon advertising
  'amazon-adsystem.com',
  'assoc-amazon.com',
  // Major exchanges and SSPs
  'adnxs.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'sharethrough.com',
  'smartadserver.com',
  'adform.net',
  'casalemedia.com',
  'indexww.com',
  'districtm.io',
  'bidswitch.net',
  'contextweb.com',
  'gumgum.com',
  'triplelift.com',
  'teads.tv',
  'yieldmo.com',
  '3lift.com',
  // Analytics and session recording
  'scorecardresearch.com',
  'quantserve.com',
  'quantcast.com',
  'chartbeat.com',
  'chartbeat.net',
  'hotjar.com',
  'hotjar.io',
  'fullstory.com',
  'mouseflow.com',
  'inspectlet.com',
  'luckyorange.com',
  'crazyegg.com',
  'mixpanel.com',
  'segment.com',
  'segment.io',
  'amplitude.com',
  'heap.io',
  'heapanalytics.com',
  'kissmetrics.com',
  'statcounter.com',
  'newrelic.com',
  'nr-data.net',
  // Ad tech / attribution
  'branch.io',
  'appsflyer.com',
  'adjust.com',
  'kochava.com',
  'bluekai.com',
  'demdex.net',
  'everesttech.net',
  'omtrdc.net',
  'krxd.net',
  'rlcdn.com',
  'agkn.com',
  'adsrvr.org',
  'mathtag.com',
  'turn.com',
  'exelator.com',
  'tapad.com',
  'crwdcntrl.net',
  'addthis.com',
  'sharethis.com',
  'zedo.com',
  'revcontent.com',
  'mgid.com',
  // Popunder and click-monetisation networks. These are the ones that pay
  // streaming and file-host sites per window opened, so they are what the popup
  // guard's `known-ad-host` rule is looking for — a click on a play button is
  // sold as consent to open one of these.
  'propellerads.com',
  'popads.net',
  'popcash.net',
  'clickadu.com',
  'hilltopads.net',
  'hilltopads.com',
  'adsterra.com',
  'monetag.com',
  'galaksion.com',
  'adspyglass.com',
  'onclicka.net',
  'trafficstars.com',
  'bidvertiser.com',
  'adskeeper.com',
  'adcash.com',
  'exoclick.com',
  'juicyads.com',
  'trafficjunky.com',
  'moatads.com',
  'adsafeprotected.com',
  'doubleverify.com',
  'serving-sys.com',
  'flashtalking.com',
  'yieldlab.net',
  'improvedigital.com'
]

/**
 * Hosts whose business is following people between sites.
 *
 * Separate from the advertising list because Slash Shield reports the two counts
 * separately, and a number shown to a user should come from the decision that
 * was actually made. The line is drawn on purpose rather than by convenience: an
 * ad network sells placements, these build profiles. Several firms do both and
 * are listed here, because the tracking is the more consequential half.
 */
export const DEFAULT_TRACKER_DOMAINS: readonly string[] = [
  // Analytics and product measurement
  'google-analytics.com',
  'googletagmanager.com',
  'mixpanel.com',
  'segment.com',
  'segment.io',
  'amplitude.com',
  'heap.io',
  'kissmetrics.com',
  'quantserve.com',
  'scorecardresearch.com',
  'chartbeat.com',
  'parsely.com',
  'newrelic.com',
  // Session recording — these replay what you did on the page
  'hotjar.com',
  'fullstory.com',
  'mouseflow.com',
  'luckyorange.com',
  'inspectlet.com',
  'smartlook.com',
  'clarity.ms',
  // Cross-site identity graphs
  'crwdcntrl.net',
  'bluekai.com',
  'demdex.net',
  'agkn.com',
  'tapad.com',
  'liveramp.com',
  'rlcdn.com',
  'addthis.com',
  'sharethis.com',
  // Consent platforms, which are themselves tracking surfaces
  'onetrust.com',
  'cookielaw.org'
]

/**
 * Host + path rules, for ad endpoints that domain blocking cannot reach.
 *
 * Every entry here is deliberate and narrow, because these bypass the
 * third-party test that keeps domain rules from breaking the site you are on.
 * A careless prefix here takes a working site down.
 *
 * What is intentionally **not** here:
 *
 *   - `youtube.com/api/stats/watchtime` and `/api/stats/qoe` — playback
 *     telemetry, not advertising. Blocking watchtime loses resume position.
 *   - `googlevideo.com/videoplayback` — this is the video itself. YouTube serves
 *     ad segments from the same host and the same path as the content, which is
 *     precisely why network filtering alone cannot remove a pre-roll. See
 *     docs/testing/youtube-ads.md.
 *   - `google.com` as a domain — it would break Search. Only `/pagead/` under it.
 */
export const DEFAULT_PATH_RULES: readonly {
  host: string
  path: string
  category: 'ad' | 'tracker'
}[] = [
  // YouTube's own ad and ad-measurement endpoints. First-party, so unreachable
  // by domain rules — verified on a live watch page.
  { host: 'youtube.com', path: '/pagead/', category: 'ad' },
  { host: 'youtube.com', path: '/ptracking', category: 'tracker' },
  { host: 'youtube.com', path: '/api/stats/ads', category: 'ad' },
  { host: 'youtube.com', path: '/youtubei/v1/player/ad_break', category: 'ad' },
  { host: 'youtube.com', path: '/get_midroll_info', category: 'ad' },
  { host: 'googlevideo.com', path: '/initplayback', category: 'ad' },

  // Ad telemetry on hosts whose main job is something else entirely.
  { host: 'google.*', path: '/pagead/', category: 'ad' },
  { host: 'google.*', path: '/ads/', category: 'ad' },
  { host: 'facebook.com', path: '/tr', category: 'tracker' },
  { host: 'bing.com', path: '/action/', category: 'tracker' }
]

/**
 * Known-malicious and phishing hosts.
 *
 * Intentionally tiny. Real protection here means a live feed — Google Safe
 * Browsing, or an equivalent — updated continuously, because malicious domains
 * are registered and burned within hours. A bundled static list is a
 * demonstration of the mechanism, not meaningful coverage, and the Settings
 * panel says exactly that rather than letting a shield icon imply otherwise.
 *
 * These are the standard test domains, which is what makes the path verifiable.
 */
export const DEFAULT_MALICIOUS_DOMAINS: readonly string[] = [
  'malware.testing.google.test',
  'testsafebrowsing.appspot.com',
  'phishing.testing.google.test',
  'eicar.org'
]
