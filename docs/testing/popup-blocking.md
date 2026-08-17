# Popups on ad-funded streaming sites

Reported against `ww8.123moviesfree.net`: clicking a film thumbnail opened three tabs — two
"Access popular coupons…" and one "Redirect" — with the popup blocker on.

## What was actually happening

Not a bypass. The guard ran and allowed them, correctly by its own rules.

`decidePopup` allowed one window per trusted gesture. The click on the thumbnail is a real click:
`event.isTrusted` is true, the preload reports it, and the site spends it on an advert instead of on
the film. The second window from that same click *was* blocked (`repeated-from-one-gesture`), but
`GestureTracker.note()` resets the spent counter on every new gesture — so clicking the thumbnail
again, which is exactly what you do when the first click appears to do nothing, hands the site a
fresh budget. Three clicks, three ad tabs.

The preload throttles gesture reports to one per 250 ms, so a single physical click cannot produce
several. Each tab in the screenshot cost a separate real click.

## The rule that was missing

A gesture explains *that* a window opened. It says nothing about **where** it goes. Slash already
knows an ad host when it sees one — `FilterEngine.isKnownAdHost` decides every third-party
subresource — and the popup guard simply never asked it.

`known-ad-host`: a **cross-site** window to a host on the ad/tracker lists is blocked even with a
perfectly good click behind it. Clicking play is not consent to open an advert. It stays blocked on
the tenth click as well, because it does not depend on the per-gesture budget.

What it deliberately does not touch:

- **Same-site windows.** An ad domain opening a window on itself is its own business.
- **Sites you allowed popups on.** An explicit "always allow here" is a specific instruction from
  the user and outranks a list.

## The honest limit

**This only catches ad networks that are on the bundled list.** That list is ~150 entries compiled
into the app, not a live feed. 13 popunder and click-monetisation networks were added with this
change (popcash, clickadu, hilltopads, adsterra, monetag, galaksion, adspyglass, onclicka,
trafficstars, bidvertiser, adskeeper, and the two already present). Sites like this rotate
throwaway domains, so some windows will still get through, and the notice will say the click opened
them — which will be true.

**The reliable answer for a site like this is Strict mode**, per-tab, in the shield panel: it blocks
*every* cross-site window, listed or not. It is per-tab precisely so it can be turned on for one bad
site without affecting normal browsing.

## Checks

Automated, in `PopupPolicy.test.ts`:

- a clicked cross-site window to an ad host is blocked;
- it stays blocked at `opensFromThisGesture` 0, 1 and 2 — the repeat-click case;
- a same-site window to an ad host is allowed;
- a site-level popup exception still wins.

Manual:

1. On a page you trust that opens new tabs (search results, a link aggregator), open five results in
   new tabs. All five must open — the rule must not touch ordinary browsing.
2. On the reported site, click a thumbnail repeatedly. Windows to listed networks are held and the
   shield notice explains why; the held popup can still be released.
3. Turn on Strict mode for that tab and repeat. No cross-site window opens at all.
