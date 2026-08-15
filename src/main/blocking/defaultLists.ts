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
  'propellerads.com',
  'popads.net',
  'adcash.com',
  'exoclick.com',
  'juicyads.com',
  'trafficjunky.com',
  // Misc trackers
  'moatads.com',
  'adsafeprotected.com',
  'doubleverify.com',
  'serving-sys.com',
  'flashtalking.com',
  'yieldlab.net',
  'improvedigital.com',
  'onetrust.com',
  'cookielaw.org'
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
