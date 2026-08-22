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
- **Start page** — backdrops, honest stats, recently closed, sponsored slot.
- **First-run onboarding** — four screens, and it cannot switch anything on.
- **Command palette** (Ctrl+K) and **shortcut sheet** (Ctrl+/, generated from the live menu).
- **Per-site zoom · custom search engines by keyword · a custom engine as the *default* ·
  configurable toolbar · settings search.**

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

| # | Work | Why |
|---|---|---|
| 1 | Code signing → installing updates | Everything else is downstream of shipping safely |
| 2 | Accessibility pass | The largest untested surface in the product |
| 3 | Multi-window restore, custom shortcuts | Small, visible, no new architecture |
| 4 | Sync | Large; needs an account system that does not exist |
| 5 | Extensions: load-unpacked, honestly scoped | Real capability without overpromising |

## Keeping this file honest

Before adding an entry, grep for it. Before trusting one, grep for it. The QA pass that found the
last round of rot did it with `grep -rl` against `src/` and took under a minute.
