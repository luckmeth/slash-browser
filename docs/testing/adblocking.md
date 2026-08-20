# Filter-list blocking, cosmetic filtering, and the popunder defuser

Reproduce with:

```bash
npm run build && SLASH_ADBLOCK_PROBE=1 npx electron-vite preview
```

## The bug that started this, and what it really was

Reported on a streaming site: strict mode stopped the unwanted ad tabs **and stopped the video**.

Both came from one line. `NavigationGuards` returns `{ action: 'deny' }` from
`setWindowOpenHandler`, so Chromium hands the page `null` back from `window.open()`. Popunder sites
are written as:

```js
var w = window.open(adUrl);
w.blur(); window.focus();   // TypeError on null
startPlayer();              // never runs
```

Investigating it turned up something wider. **Both branches of the handler deny** — the blocked one
*and* the allowed one, because in the allowed case Slash opens the tab itself and then denies so
Chromium does not open a second window. So `window.open()` has returned `null` for every popup in
Slash, allowed or blocked, and any site that touched the window it opened has been quietly broken
all along. The streaming site was the visible instance of a general fault.

`popupDefuserScript` fixes the class rather than the case. **It decides nothing.** The real
`window.open` is still called, so the shield's verdict, the gesture accounting and the held-popup
notice all behave exactly as before. The only thing that changes is the return value: `null` becomes
a harmless stand-in object, so the page's code carries on and the popup still never opens. A page
that legitimately opened a window gets the real one, untouched.

Both halves are asserted, because fixing the crash by quietly allowing the popup would be a
regression dressed as a fix:

```
adblock probe: popunder pattern {"played":true,"threw":null}
adblock probe: PASS - the click survives a refused popup (video would play)
adblock probe: PASS - no window opened; it was defused, not allowed
```

## Why the engine changed

`FilterEngine` matched hostnames only: 152 hand-kept domains, no EasyList syntax, no request types,
no cosmetic rules, no first-party exceptions. That was a deliberate simplification and it reached
its limit — it is why blocking felt unintelligent next to Brave.

`@ghostery/adblocker` now runs **alongside** it, not instead of it. The old engine keeps the three
things the new one cannot do: the malicious-site list, per-site exemptions, and the host+path rules
that reach first-party ad endpoints like `youtube.com/ptracking`, which no domain list can express.

It is pure TypeScript, which is not incidental: this project's path contains spaces and node-gyp
refuses to build any module whose path does, so a native filter engine could not be built here at
all.

## Cost, measured

| | |
|---|---|
| Raw lists | 4.27 MB |
| Compile (utility process) | ~770 ms, **once** |
| Serialised cache | 4.33 MB |
| Deserialise on launch | **24–30 ms** |
| Second launch | no compile at all |

Compiling happens in a utility process and never on the main thread — the same reasoning as the
embedding worker, and a second rollup entry for the same reason. Principle 1 is that no feature may
add latency to the browsing path; a one-second main-thread stall is every tab switch and every IPC
reply while it runs.

A missing or stale cache degrades to the domain lists rather than blocking startup. A blocker that
cannot start must not also stop the browser working.

## Cosmetic filtering, and why it needs no preload

Network blocking cancels the request, but the page's layout still holds the empty slot. Cosmetic
filtering closes those gaps, and it uses `webContents.insertCSS` — a first-class Electron API
needing **no preload, no main-world script and no debugger**. That is what lets Slash have it
without widening `preload/content.ts`'s charter or spending the one CDP client.

Applied at `dom-ready`, so a slot can be briefly visible on a slow page. Injecting before the
document commits would need the debugger, which is not worth spending on this.

## One debugger client, shared

Only one debugger client may attach to a `WebContents`. The YouTube ad-break strip and the popup
defuser would have silently fought over it, so `ScriptletInjector` is the single attach point and
scripts register with it.

**DevTools always wins.** Opening it detaches us; closing it reattaches. A browser whose DevTools
mysteriously refuse to open is a worse browser than one that shows an advert.

## What is deliberately not bundled

uBlock Origin's scriptlet library. Those are executable GPLv3 files, and shipping them inside this
application carries obligations that filter lists — data, distributed with attribution — do not. The
one scriptlet Slash needs is written locally. Attribution for the lists is in
`resources/filters/README.md`.

## Regression checks

Re-run `docs/testing/popup-blocking.md`, `youtube-ads.md` and `slash-shield.md`, and confirm
specifically:

1. **YouTube plays**, including seeking, and the ad-break strip still works.
2. **Google Search works** — on `.com` and on a country domain.
3. The shield panel's ad/tracker counts still sum to the total shown.
4. A site with a legitimate popup (an OAuth sign-in window) still opens a real window.
5. Opening DevTools on a YouTube tab works, and closing it restores ad stripping.
6. Turning the shield off for a site turns **all** of it off — network, cosmetic and defuser.
