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
    // already lost the race. If the page somehow got there first, the existing
    // value is stripped rather than discarded — an accessor that swallows an
    // already-set response would break playback outright.
    var stored = strip(window.ytInitialPlayerResponse);
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: function () {
        return stored;
      },
      set: function (value) {
        stored = strip(value);
      }
    });

    // 2. Responses the page parses from text itself.
    //
    // Covers XMLHttpRequest and any code path that reads a body as text and
    // parses it — the string always goes through JSON.parse.
    var originalParse = JSON.parse;
    JSON.parse = function () {
      var result = originalParse.apply(this, arguments);
      return strip(result);
    };

    // 3. Responses fetched and read with Response.json().
    //
    // fetch() never calls JSON.parse — json() decodes internally — and this is
    // exactly how YouTube's own navigation loads the next player response:
    // home to video, video to next video, search result to video. Without this
    // hook the strip works only on a watch page navigated to directly, which
    // is the least common way to reach one. Same conditional strip, so every
    // other json() call on the page passes through untouched.
    if (typeof Response !== 'undefined' && Response.prototype && Response.prototype.json) {
      var originalJson = Response.prototype.json;
      Response.prototype.json = function () {
        return originalJson.apply(this, arguments).then(strip);
      };
    }
  } catch (error) {
    // A failure here must leave YouTube working normally. Ads are the cost of
    // that, and a broken player is a far worse outcome.
  }
})()`
}
