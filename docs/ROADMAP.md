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

### Blocking, in order of what it costs you

1. **Installing updates.** `UpdateService` checks a feed and deliberately refuses to install,
   because an unsigned auto-installer is an unauthenticated code path onto the user's machine. Needs
   a code-signing certificate — a purchase, not a coding task. See `docs/LAUNCH.md`.
2. **Sync.** No account, no cross-device anything. A deliberate fit with local-first, and the thing
   users will ask for first.
3. **Accessibility pass.** No screen reader has ever been tried against this; keyboard navigation is
   partial. Untested rather than known-bad.

### Smaller gaps

- **Multi-window session restore** — snapshots are per-database, so restoring puts every tab in one
  window regardless of where it came from.
- **Custom keyboard shortcuts.** The sheet lists them; nothing remaps them. The menu already owns
  every accelerator, so this is a settings surface over an existing map.
- **Form-state restore** — needs its own decision: it means writing what you typed, excluding
  password fields, into the local database. Off by default, and the settings copy would have to say
  exactly that.
- **Picture-in-picture, cast, page translation.** None built. Translation in particular cannot be
  done without sending page text somewhere, so it needs the same opt-in treatment as the AI layer.
- **Side panels inset the page rather than floating.** Correct for the architecture, but it makes
  opening History feel heavy. An overlay-view panel would suit quick lookups.

### Extensions — read this before promising anything

**Electron cannot install Chrome Web Store extensions.** Unpacked folders only, a subset of the
APIs, no `webRequest` blocking and no full `declarativeNetRequest` — so uBlock Origin, the extension
most people would want, **does not work**. That is why Slash Shield is built in.

Nothing extension-related is built today. What is realistically buildable: a "load unpacked
extension" setting, or a Slash-native plugin API over the existing IPC contracts. What will not be
done: implying Web Store compatibility.

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
