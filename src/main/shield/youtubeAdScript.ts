/**
 * The script injected into YouTube pages before their own JavaScript runs.
 *
 * This is the only place in Slash that executes in a page's **main world** — the
 * same JavaScript context as the site's own code — and it exists for exactly one
 * reason: YouTube's ad breaks are not requests, so no network filter can reach
 * them. They arrive as a field inside the watch page's own player response, and
 * the only way to remove them is to take that field away before the player reads
 * it.
 *
 * Everything about it is written to keep that capability as small as possible:
 *
 *  - **It gates on hostname first.** The script is installed per-tab and would
 *    otherwise persist across navigations, so it checks where it is running and
 *    does nothing anywhere but YouTube.
 *  - **It deletes three named fields and nothing else.** No network access, no
 *    DOM rewriting, no communication back to the browser. There is no channel
 *    from this script to anything privileged.
 *  - **Its JSON.parse hook is conditional.** Only objects that look like a player
 *    response are touched, so ordinary parsing on the page is unaffected.
 */
export function buildYouTubeAdScript(): string {
  return `(() => {
  try {
    // Installed per tab, so it runs on whatever that tab visits next. Anywhere
    // but YouTube, it does nothing at all.
    if (!/(^|\\.)youtube(-nocookie)?\\.com$/.test(location.hostname)) return;

    var FIELDS = ['adPlacements', 'playerAds', 'adSlots'];

    // Only objects that are actually a player response. A blanket strip would
    // reach into unrelated data the page parses for its own reasons.
    var isPlayerResponse = function (value) {
      return (
        value &&
        typeof value === 'object' &&
        (value.streamingData || value.videoDetails || value.adPlacements)
      );
    };

    var strip = function (value) {
      if (!isPlayerResponse(value)) return value;
      for (var i = 0; i < FIELDS.length; i++) {
        try {
          delete value[FIELDS[i]];
        } catch (error) {
          // A frozen response is left as it is rather than throwing into the
          // page's own script and breaking playback entirely.
        }
      }
      return value;
    };

    // 1. The response embedded in the watch page's HTML.
    //
    // Intercepted with an accessor rather than edited afterwards: the player
    // reads this the moment the document parses, so anything that runs later has
    // already lost the race.
    var stored;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: function () {
        return stored;
      },
      set: function (value) {
        stored = strip(value);
      }
    });

    // 2. Responses fetched afterwards.
    //
    // YouTube is a single-page app: moving to the next video fetches a fresh
    // player response over the network rather than reloading the document, so
    // without this the fix would work once and then stop.
    var originalParse = JSON.parse;
    JSON.parse = function () {
      var result = originalParse.apply(this, arguments);
      return strip(result);
    };
  } catch (error) {
    // A failure here must leave YouTube working normally. Ads are the cost of
    // that, and a broken player is a far worse outcome.
  }
})()`
}
