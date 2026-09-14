# What Slash still needs

**Verified against the codebase on 2026-08-22**, not from memory. Every "built" claim below was
checked by finding the code; every "missing" claim by failing to.

> **This file has gone stale twice and caused real damage both times.** It once listed private
> browsing, tab sleeping and semantic search as missing after all three were built — and the Settings
> panel repeated the claim to users. The most recent QA pass found it still advertising the password
> manager, reading list, tab groups, tab search, reader mode and the PDF viewer as missing, all of
> which exist, plus two claims that were simply wrong ("no empty states"; "the tab strip does not
> scroll or shrink").
>
> `CLAUDE.md` tells you to read this before starting feature work, which is exactly why a stale entry
> here is worse than no file at all. **Check the code before believing a line of it**, and update it
> when you finish something.

## Built

Confirmed present. Roughly in the order they arrived:

Workspaces · adaptive tab sleeping · browsing memory · session time travel · permission
intelligence · Slash Shield (filter lists, cosmetic filtering, popup and redirect guards) ·
private browsing · Chrome/Edge import · semantic search · omnibox browsing memory · tab search ·
reader mode · Slash error pages · inline PDF · vertical tabs · crash reporting · update *checking* ·
page watching · Mission Mode · AI Hub and multi-provider comparison · segmented download engine ·
Download Guardian · Cleanup Mode · Page Insight · Redirect X-Ray · Tab Brain

Added most recently:

- **Split view** — two panes, one active tab, capped at two deliberately.
- **Tab groups** — coloured runs, persisted, collapse ≠ sleep.
- **Reading list** — a queue, separate from bookmarks.
- **Password vault + autofill** — DPAPI-encrypted; no channel returns a password.
- **Start page** — backdrops, honest stats, sponsored slot. (Recently closed moved off it: the
  capability lives on Ctrl+Shift+T, in the tab menu, and now in the command centre.)
- **First-run onboarding** — four screens, and it cannot switch anything on.
- **Command centre** (Ctrl+K) and **shortcut sheet** (Ctrl+/, generated from the live menu). The
  palette searches ten sources — open tabs, recently closed tabs, commands, bookmarks, the reading
  list, workspaces (names *and* notes), snapshots, history, downloads, and indexed page text where
  that is switched on — with `tabs:`/`history:`/`bm:`/`ws:`/`snapshots:`/`closed:`/`downloads:`/
  `page:`/`cmd:`/`reading:` filters and the matched characters marked. Ranking lives in
  `shared/commandSearch.ts`, pure and tested: an open tab outranks everything, because the answer to
  "I want github" when github is open in tab three is to switch to it rather than open a fourth copy.
- **Per-site zoom · custom search engines by keyword · a custom engine as the *default* ·
  configurable toolbar · settings search.**
- **Slash Coin** (2026-08-30) — pre-launch rewards. Opt-in, Google sign-in through the *system*
  browser via loopback PKCE, balances held server-side in Supabase. The client reports intervals and
  never a total; `record_coin_intervals` in Postgres is the fraud boundary and the overlap rule is a
  GiST exclusion constraint rather than a code path. **Not yet reachable end to end**: Google is not
  enabled on the Supabase project, which needs a Google Cloud OAuth client only the owner can
  create. See `docs/SLASH-COIN.md`.
- **Always-on sponsored placements** (2026-08-30) — the two reader-facing off-switches were removed;
  the settings copy now states that adverts fund the browser and cannot be turned off. The operator
  keys remain, because a publisher still needs a network off-switch.

Added 9 September 2026 — the shield-reliability pass:

- **The YouTube ad strip actually runs.** Two faults: a tab that has never navigated has no renderer,
  so the CDP install was never answered; and `Page.enable` had been removed as an optimisation, which
  silently disabled document-start injection altogether. Install time on a clean profile went from
  *never answered* / 2296 ms to **73 ms**, and `SLASH_YT_TIMING_PROBE` reports `ran=true accessor=true`
  with no ad fields left on cold, warm and restored navigations.
- **A shield self-check.** `ShieldVerifier` asks a real page once a session whether the strip ran, and
  Settings says so beside the switch. Built because nothing in the product could notice the fault above.
- **`npm run probe`.** One command for the 64 probes, with an explicit manifest of which are safe to
  run unattended and why the rest are not.
- **Tests for every page-world script.** `youtubeAdScript`, `contextMenuScript` and
  `popupDefuserScript` — 36 cases. They were strings of JavaScript with no test at all.
- **yt-dlp stays current**, not merely installed: a fortnightly check that only ever replaces the copy
  Slash owns.
- **Android downloads rows repaint.** Rebuilt on an immutable data class behind one
  `State<List<Download>>`; the previous design had failed three times.

Also already present, contrary to older versions of this file: **empty states** in History,
Bookmarks and Downloads, and a tab strip that **shrinks** tabs to fit (and, since the last QA pass,
scrolls once shrinking bottoms out).

---

## Genuinely missing

### Blocking

1. **A code-signing certificate.** The *only* thing left on updates. The download-and-install path
   is written and wired; `isSignedBuild()` asks Windows whether the running binary carries a valid
   Authenticode signature, and `canInstall` follows from that. Buy a certificate, set `CSC_LINK` and
   `CSC_KEY_PASSWORD` for the build, and the button in Settings stops being disabled — **no code
   change**. A purchase, not a coding task. See `docs/LAUNCH.md`.

### Built since the last revision

- **Sync** — bookmarks and reading list, end-to-end encrypted, provider-agnostic. The server holds
  ciphertext and nothing readable. See `docs/sync.md`, including what does leak.
- **Accessibility** — focus-visible styles across the chrome (there were none), `prefers-contrast`
  support, live regions for messages that appear without focus moving, and the omnibox's broken
  cross-document `aria-controls` replaced with something that works. Still never tried against a
  real screen reader.
- **Custom keyboard shortcuts** · **multi-window session restore** · **picture-in-picture** ·
  **hardware media keys** · **print preview** · **page translation** (through the configured AI
  provider, gated on the same page-content consent) · **saved addresses with autofill** ·
  **profiles**.
- **Form-state restore** was already built — `restoreFormState`, off by default.

### Smaller gaps that remain

- **Cast to a TV.** No Electron API. Would mean bundling a third-party stack.
- **Payment-card autofill.** Deliberately not built: storing a card number means holding regulated
  data this project cannot protect better than a dedicated password manager already does. Addresses
  are filled; cards are not, and the settings screen says so.
- **Two profiles at once.** The single-instance lock is application-wide, so switching relaunches.
  Chrome runs a process per profile; matching that is a larger change than it looks.
- **Side panels inset the page rather than floating.** Correct for the architecture, but it makes
  opening History feel heavy. An overlay-view panel would suit quick lookups.

### Extensions — read this before promising anything

**Electron cannot install Chrome Web Store extensions.** Unpacked folders only, a subset of the
APIs, no `webRequest` blocking and no full `declarativeNetRequest` — so uBlock Origin, the extension
most people would want, **does not work**. That is why Slash Shield is built in.

**Built:** `ExtensionManager` loads unpacked folders, and `manifestGaps` reads each manifest and
states in the UI which of its permissions will not work here — `nativeMessaging`,
`webRequestBlocking`, full `declarativeNetRequest`, `downloads`, MV3 service workers. Saying so
before the install is the whole design: the alternative is an extension that appears to load and
then quietly does nothing.

**Still not possible:** Web Store installation, and therefore the extensions most people would name.
IDM's browser integration needs `nativeMessaging` (it talks to a Windows program) and uBlock Origin
needs `webRequestBlocking`; neither will run. Grammarly, being a content script, largely does.

---

## Suggested order

Items 2 through 5 of the previous list are built. What is left is not
development work in the usual sense:

| # | Work | Why |
|---|---|---|
| 1 | **Buy a code-signing certificate** | The only thing between this build and self-updating. The install path is written, wired and gated on a real signature check. A purchase and a business verification, not a coding task |
| 2 | **Run a screen reader against the whole browser** | The focus, contrast and live-region work is done and none of it has been tried by somebody actually using assistive technology. It remains the largest unknown in the product |
| 3 | **Exercise sync and translation against something live** | Both have unit tests over their logic and neither has spoken to a real server or provider. Two devices and one API key would settle it |
| 4 | **Stand up the ad platform** | Four accounts and the RLS check in `platform/README.md`. Test row-level security first, with two real advertiser accounts |
| 5 | A search partnership | Still worth more than the ad platform at your current size. `docs/LAUNCH.md` |

## Ad-free subscription — deliberately not built yet

The intent is on record: adverts appear for everyone, and a paid subscription removes them.

**Not started, and it should not be, until the ad platform has run for a while with real
advertisers.** The reason is not effort. A subscription is a promise made monthly, and the pieces it
needs do not exist:

| Piece | State |
|---|---|
| Recurring billing | Stripe **Checkout** is wired for one-off campaign payments. Subscriptions are a different object, with dunning, proration, cancellation and tax handling behind them |
| Entitlement the browser can check | The browser is local-first and fetches a batch of adverts anonymously — deliberately so, since a per-user entitlement check is a request that identifies the user every few hours. Signed offline licence tokens are the only shape that fits, and there is no key infrastructure |
| A refund story | People pay for a year and the company changes. That is a commitment, not a feature |

What *is* already true, and is the honest half of it: every advert placement is a settings switch,
so an entitlement check has exactly one place to land — `SponsorService.livePlacement()` and
`SponsorNoticeService`. Nothing needs restructuring when this is built.

The thing to avoid is shipping a payment for a promise the architecture cannot keep. See
`docs/ADVERTISING.md` for how the advert side actually works today.

## Keeping this file honest

Before adding an entry, grep for it. Before trusting one, grep for it. The QA pass that found the
last round of rot did it with `grep -rl` against `src/` and took under a minute.
