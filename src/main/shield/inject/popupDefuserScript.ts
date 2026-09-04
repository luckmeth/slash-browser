/**
 * Stops a refused popup from breaking the click that asked for it.
 *
 * **The bug this fixes.** `NavigationGuards` returns `{ action: 'deny' }` from
 * `setWindowOpenHandler` — for popups the shield blocks *and* for popups it
 * allows, because in the allowed case Slash opens the tab itself and denies so
 * Chromium does not open a second window. Either way Chromium hands the page
 * `null` back from `window.open()`. Sites written like this then break:
 *
 *     var w = window.open(url);
 *     w.blur(); window.focus();   // TypeError on null
 *     startPlayer();              // never runs
 *
 * That is why strict mode stopped the ad tabs on a streaming site *and* stopped
 * the video: both came from the same line. It also means any site that touches
 * the window it opened has been quietly broken in Slash all along, allowed or
 * not.
 *
 * **What this does, and what it deliberately does not.** It decides nothing.
 * The real `window.open` is still called, so the shield's verdict, the gesture
 * accounting and the held-popup notice all behave exactly as before. The only
 * change is that when the browser returns `null`, the page gets a harmless
 * stand-in object instead — so its code runs on, and the popup still never
 * opens. A page that legitimately opened a window gets the real one, untouched.
 *
 * It is the smallest possible intervention that fixes the class of breakage:
 * no allowlist, no heuristics about which popups are adverts, nothing that
 * could itself decide wrongly.
 */
export function buildPopupDefuserScript(): string {
  return `(() => {
  try {
    if (!/^https?:$/.test(location.protocol)) return;

    var realOpen = window.open;
    if (typeof realOpen !== 'function') return;

    // A stand-in for a Window. Only the members that sloppy popunder code
    // actually touches — enough that a null-dereference becomes a no-op, and
    // not so much that a page could mistake it for a working window and, say,
    // wait forever on a postMessage reply.
    var makeStub = function () {
      var noop = function () {};
      var stub = {
        // False rather than true: code that checks \`w.closed\` is usually
        // looking for "did the user block me", and answering yes is what
        // triggers anti-adblock nags.
        closed: false,
        opener: null,
        name: '',
        close: noop,
        focus: noop,
        blur: noop,
        postMessage: noop,
        addEventListener: noop,
        removeEventListener: noop,
        document: { write: noop, writeln: noop, open: noop, close: noop, body: null },
        location: { href: '', replace: noop, assign: noop, reload: noop }
      };
      stub.self = stub;
      stub.window = stub;
      return stub;
    };

    window.open = function () {
      var opened = null;
      try {
        opened = realOpen.apply(window, arguments);
      } catch (error) {
        // Chromium itself refused. Same outcome as a null return.
        opened = null;
      }
      return opened || makeStub();
    };

    // Some pages check that window.open still looks native before using it, and
    // treat a visibly patched one as evidence of a blocker.
    try {
      window.open.toString = function () { return 'function open() { [native code] }'; };
    } catch (error) {}
  } catch (error) {
    // A failure here must leave the page working normally. The cost is a site
    // that breaks on a blocked popup, which is where it started.
  }
})()`
}
