/**
 * Gives right-click back on sites that take it away.
 *
 * A page can cancel the `contextmenu` event, and when it does Chromium never
 * asks the browser for a menu — so there is nothing for `installPageContextMenu`
 * to show. That is correct behaviour and Chrome does exactly the same, which is
 * why "right-click does nothing here" is a complaint people have about every
 * browser and not a bug in this one.
 *
 * It is still a bad answer. Blocking the menu is almost always there to stop
 * people copying a link or saving an image, and the browser is the user's
 * software, not the site's. So this puts the menu back.
 *
 * **How, and why this way.** A capturing listener registered before the page's
 * own runs, calling `stopImmediatePropagation`. That stops the site's handler
 * ever seeing the event, so it never gets the chance to cancel it — which is
 * different from, and better than, letting it cancel and then un-cancelling,
 * because `preventDefault` cannot be undone once called.
 *
 * `document_start` timing matters for the same reason: a listener added after
 * the page's own would still fire second on the capture phase for handlers on
 * the same node, and sites commonly bind theirs on `document` directly.
 *
 * **What it costs.** Sites with a *useful* custom menu lose it — YouTube's
 * player menu, editors with their own right-click actions. That is why it is a
 * setting rather than always-on behaviour, and why the settings copy says which
 * way the trade runs instead of describing it as pure gain.
 */
export function buildContextMenuScript(): string {
  return `(() => {
  try {
    // Capture phase, so this runs before anything the page bound. Sites bind
    // on document or window; both are reached on the way down.
    const free = (event) => {
      event.stopImmediatePropagation();
    };
    window.addEventListener('contextmenu', free, true);
    document.addEventListener('contextmenu', free, true);

    // The other half: an inline handler set as a property rather than a
    // listener. stopImmediatePropagation does not reach these, because they run
    // as the target's own handler — so they are cleared and kept cleared.
    const clear = () => {
      for (const node of [document, document.body, document.documentElement]) {
        if (node && node.oncontextmenu) node.oncontextmenu = null;
      }
    };
    clear();
    document.addEventListener('DOMContentLoaded', clear);

    // Some sites re-apply theirs after load, or on every render. Checked a few
    // times rather than watched continuously: a MutationObserver over the whole
    // document for the life of the page is a real cost, and this is a
    // convenience.
    let checks = 0;
    const timer = setInterval(() => {
      clear();
      if ((checks += 1) > 10) clearInterval(timer);
    }, 500);
  } catch {
    // Somebody else's page. A failure here must never break it.
  }
})()`
}
