# Slash Shield

Ad, tracker and popup protection. What is built, what is verified, and what is not there yet.

**Location note.** The brief asked for `/services/slash-shield/…`. It lives in `src/main/shield/`
instead, because these engines need privileged Electron APIs and `CLAUDE.md` puts engines under
`src/main/<domain>/`. The modularity is preserved the way the rest of the project does it: the
decision logic is pure and Electron-free, and the wiring is separate.

## Modules

| File | Role | Pure? |
|---|---|---|
| `FilterEngine.ts` | Domain matching, ad/tracker categories, allowlist, custom rules | yes |
| `defaultLists.ts` | Bundled starter lists, split ad / tracker / malicious | yes |
| `PopupPolicy.ts` | Decides whether a `window.open` was the user's doing | yes |
| `RedirectChainMonitor.ts` | Judges navigation chains; exempts sign-in and payment flows | yes |
| `ActivityLog.ts` | Per-tab record of decisions, bounded, host-only | yes |
| `PopupGuard.ts` | Gesture bookkeeping, holds blocked popups | no |
| `NetworkPolicy.ts` | `webRequest` installation, per session | no |

## The signal that makes popup blocking possible

`setWindowOpenHandler` receives no user-activation flag, so main cannot tell the popup you asked for
from the one the page opened while you were reading. The content preload reports **that** a trusted
click or keypress happened — no coordinates, no target, no key, no content — and main timestamps it
on arrival rather than trusting a time from the page.

`event.isTrusted` is the point: it is false for anything script dispatched, so a page cannot
manufacture consent by firing a synthetic click first.

## Privacy

- The activity log stores **hosts, never URLs**. A blocked request's path and query carry
  identifiers, search terms and sometimes session tokens; the host is the part that means something
  to a person reading the log, and the rest is only risk.
- The log is **in memory only**. Browsing activity is not written to disk, so closing the tab
  discards it and there is nothing to clear later.
- Slash Shield reads no form values, no passwords, no page content. It sees request URLs (from
  Chromium's own `webRequest`) and navigation hosts.
- No filtering decision contacts the network or an AI provider. Matching is local set lookup.

## Verified

```bash
npm run build && SLASH_POPUP_PROBE=1 npx electron-vite preview
```

Expected: `popup probe: PASS — script popup blocked, clicked popup allowed`.

Measured 2026-08-16: `tabs before=12 afterScriptOpen=12 afterClick=13`. This exercises the whole
chain — preload → IPC → `PopupGuard` → `PopupPolicy` → `setWindowOpenHandler` — which no unit test
covers. The clicked case matters most: a popup blocker that stops what the user asked for is worse
than none.

```bash
npm run build && ADAPTIVE_BLOCK_CAPTURE=block.png npx electron-vite preview
```

Network blocking, unchanged from before and still passing.

46 unit tests over the decision logic: 10 popup, 16 redirect, 20 filter/engine.

## Manual test procedure

1. **Ad blocked** — open a news site, open the shield panel, confirm a non-zero count.
2. **Normal content loads** — the article text, images and video still render.
3. **Clicked link opens** — a normal `target="_blank"` link opens a tab.
4. **Script popup blocked** — the notice appears: *"Slash Shield blocked a popup from …"*.
5. **Show it** — the held popup opens in a tab.
6. **Always allow this site** — the next script popup on that host opens without a notice.
7. **OAuth still works** — start a "Sign in with GitHub" flow; the redirect chain completes.
8. **Payment redirect** — a Stripe checkout redirect completes.
9. **Media site** — click play on a video; playback continues and the ad tab is blocked, with the
   original tab still active.
10. **Counts match** — the panel's ads + trackers + popups equals the total shown on the button.

## Not built yet — do not claim these

- **`RedirectChainMonitor` is not wired.** The logic and its 16 tests are complete and correct, but
  nothing calls `decideRedirect` from `will-navigate` yet. Redirect counts are therefore always zero
  and no redirect is currently blocked or warned about. This is the next piece of work.
- **"Stay on This Site" is half-connected.** The per-tab flag exists, the IPC to set it exists, and
  the *popup* path honours it. The *navigation* path does not, because that lives in the unwired
  redirect guard. Turning it on today blocks cross-site popups but not cross-site navigation.
- **The shield panel still shows the old single count.** The IPC now returns the ad/tracker/popup
  split and the recent-activity list, but `ShieldButton.tsx` has not been rebuilt to render them.
- **A refused malicious navigation shows no explanation.** `onMaliciousNavigation` has been a no-op
  since it was written — the request is genuinely cancelled, but the user sees a failed page load
  with no reason given. Pre-existing, found during this work, not introduced by it.
- **No subscribable filter lists.** The bundled starter list is small next to EasyList. There is no
  updater and no list subscription UI.
- **No cosmetic filtering.** Blocked ads leave their empty layout boxes behind. Slash cancels
  requests; it does not hide elements.

## Regression checks

Re-run `docs/testing/content-blocking.md` and `docs/testing/phase-1.md` (popup handling shares
`NavigationGuards` with `window.open` → tab conversion).
