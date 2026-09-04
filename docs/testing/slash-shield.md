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
| `RedirectGuard.ts` | Per-tab navigation chains, `will-navigate` / `will-redirect` | no |
| `GestureTracker.ts` | When each tab was last genuinely touched | no |
| `NetworkPolicy.ts` | `webRequest` installation, per session | no |

Both guards share **one** `GestureTracker`. They ask the same question — "was this the user?" — and
two trackers would be two answers that can disagree.

`will-redirect` is handled as well as `will-navigate`: a 302 chain through three ad networks fires
the former once per hop and the latter not at all, so a guard installed only on `will-navigate` would
miss the exact pattern it exists to catch.

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

```bash
npm run build && SLASH_REDIRECT_PROBE=1 npx electron-vite preview
```

Expected: `redirect probe: PASS — cross-site jump blocked, sign-in still reachable`.

Measured 2026-08-16: a locked tab on `example.com` had `location.href` set to `iana.org` by page
script — refused, logged as `navigation blocked → www.iana.org (site-locked)`, and the tab stayed
put. The same tab then reached `accounts.google.com/v3/signin` under identical conditions. That
second half is the point of the probe: locked tab, strict conditions, cross-site, unclicked — every
signal says block, and it must still allow, because a redirect guard that breaks sign-in is worse
than no redirect guard.

68 unit tests over the decision logic and the stateful guards.

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
10. **Counts match** — the panel's ads + trackers + popups + redirects equals the total on the button.
11. **Stay on This Site** — turn it on in the shield panel, then click a link to another site: it is
    allowed, because you clicked it. Script-driven jumps to other sites are refused with a notice.
12. **Refused navigation explains itself** — visiting `malware.testing.google.test` shows *"Slash
    Shield stopped this page going to …"* rather than a blank failed load.
13. **Clear** — the Clear button in the panel empties the recent list and zeroes the counts.

## Not built yet — do not claim these

- **No subscribable filter lists.** The bundled starter list is a few hundred domains; EasyList is
  tens of thousands. There is no updater and no subscription UI, so coverage is well short of uBlock
  Origin's and the panel says so rather than letting a shield icon imply otherwise.
- **No cosmetic filtering.** Blocked ads leave their empty layout boxes behind. Slash cancels
  requests; it does not hide elements.
- **Domain matching only.** No regex URL patterns, no per-element rules, no query-parameter
  stripping.
- **The same-site test is approximate.** It compares the last two labels, so `a.co.uk` and `b.co.uk`
  read as one site. The failure is conservative — it blocks *less*, never more — so the worst case is
  an ad getting through rather than a page breaking. A Public Suffix List would fix it.
- **Malicious-domain coverage is a demonstration, not protection.** The bundled list is four test
  domains. Real coverage needs a live feed like Safe Browsing, because malicious domains are
  registered and burned within hours.
- **Not a virus scanner.** A browser cannot inspect a file for malware. The panel states this
  outright.
- **Site lock is not persisted.** It is a mode for the page you are looking at now; a lock silently
  still in force days later on a restored tab would look like the browser was broken.

## Regression checks

Re-run `docs/testing/content-blocking.md` and `docs/testing/phase-1.md` (popup handling shares
`NavigationGuards` with `window.open` → tab conversion).
