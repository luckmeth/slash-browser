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

    // \`adBreakHeartbeatParams\` is the marker for **server-stitched** ads
    // (SSAP): the break is not a separate request or a placement the page can
    // be relieved of, it is spliced into the same stream as the video. Measured
    // on a real watch page by SLASH_YT_ADS_PROBE, which found the other three
    // fields correctly gone and this one present with ssap active — which is
    // exactly what "the blocker stopped working" looked like from outside.
    // Removing the heartbeat parameters is the only part of that mechanism the
    // page hands us. It is not a guarantee: a stitched break that plays anyway
    // cannot be filtered out of the video it is inside.
    var FIELDS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'];

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
      // The server-stitched configuration hangs off playerConfig rather than
      // sitting at the top level, so the loop above cannot reach it.
      try {
        if (value.playerConfig && value.playerConfig.ssap) delete value.playerConfig.ssap;
      } catch (error) {
        // As above: a failure here must not break playback.
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
    // 4. The slots that hold companion and feed adverts.
    //
    // These are not video breaks and no field removal reaches them: YouTube
    // renders them as its own elements from a separate response, which is why
    // a watch page with every ad field stripped still showed a full sponsored
    // panel beside the player. This is **cosmetic filtering**, which
    // \`FilterEngine\` deliberately does not do in general — a browser hiding
    // elements site-wide on rules it did not write is a much larger promise.
    // Here it is a fixed list of YouTube's own ad containers on YouTube only,
    // and it hides them rather than removing them, so the page's own scripts
    // still find every node they expect.
    var css = [
      '#player-ads',
      'ytd-companion-slot-renderer',
      'ytd-action-companion-ad-renderer',
      'ytd-ad-slot-renderer',
      'ytd-in-feed-ad-layout-renderer',
      'ytd-banner-promo-renderer',
      'ytd-statement-banner-renderer',
      'ytd-primetime-promo-renderer',
      '#masthead-ad',
      '.ytp-ad-overlay-container',
      'ytd-rich-item-renderer:has(ytd-ad-slot-renderer)',
      'ytd-video-masthead-ad-v3-renderer'
    ].join(',') + '{display:none !important}';

    var addStyle = function () {
      try {
        if (document.getElementById('slash-yt-ads')) return;
        var root = document.head || document.documentElement;
        if (!root) return;
        var style = document.createElement('style');
        style.id = 'slash-yt-ads';
        style.textContent = css;
        root.appendChild(style);
      } catch (error) {
        // Cosmetic only - never worth breaking the page for.
      }
    };

    // At document-start there may be no element to attach to yet, so try now
    // and again once the document has a head.
    addStyle();
    document.addEventListener('readystatechange', addStyle);
    document.addEventListener('DOMContentLoaded', addStyle);
  } catch (error) {
    // A failure here must leave YouTube working normally. Ads are the cost of
    // that, and a broken player is a far worse outcome.
  }
})()`
}
