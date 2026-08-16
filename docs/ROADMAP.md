# What Slash still needs

An honest inventory: what is missing, what it costs, and what I would build in what order.
Written after a full pass over the codebase, not from a feature wishlist.

## The uncomfortable summary

Slash has seven phases of engines and almost none of them are visible. Workspaces, adaptive tab
sleeping, browsing memory, time machine, permission intelligence — all built, all behind a panel you
have to know to open. **A user opening Slash for the first time sees a competent Chromium browser
with a nice glass theme and no reason to switch.** That is the actual problem, and it is a UI
problem, not an engine problem.

The engines are the hard part and they are done. What is missing is the part that makes anyone care.

---

## 1. Make the specialness visible (highest value, lowest risk)

### New tab page as a real home
Currently: logo, search box, frequently-visited grid. It says nothing Slash-specific.

Should carry: your workspaces with tab counts · "pick up where you left off" (the last few restore
points, one click each) · recently closed tabs · a search box that searches **where you have been**,
not the web · what Slash Shield blocked today · how much memory tab sleeping has saved you.

This is the screen seen most often. It should be the argument for the browser.

### Tab sleeping, visible
The single thing Slash does that Chrome and Brave do not, and it happens silently. A toolbar readout
— "6 asleep · 1.2 GB freed" — with measured numbers, plus a dimmed/moon treatment on sleeping tabs in
the strip. Hover to see why a tab is or is not eligible.

Honest bit: only hibernation frees measurable memory; freezing is an estimate and must stay labelled.

### Browsing memory in the omnibox
Typing should surface pages you actually visited, ranked, with **why it matched** — matched terms,
when you saw it, which workspace. "That article about Postgres indexes, last Tuesday" is a real
thing people want and no mainstream browser does it well.

### Workspace theming
Per-workspace accent colour applied to the whole window chrome, so switching context is felt rather
than read. Cheap to build, disproportionate effect.

---

## 2. Personalisation

None of this exists yet, and all of it is what makes a browser feel like *yours*:

- **Themes** — accent colour, light/dark/system, glass intensity slider (some people hate acrylic),
  a solid-background option for Windows 10 and low-end GPUs.
- **Custom new tab background** — local image or gradient. No network fetch.
- **Density** — compact / comfortable tab strip and UI scale.
- **Tab strip position** — top or vertical-left. Vertical tabs are a genuine differentiator and the
  view-stack architecture already supports insetting the page for it.
- **Configurable toolbar** — reorder and hide buttons; not everyone wants a downloads icon.
- **Custom search engines** — add your own with a keyword prefix.
- **Custom keyboard shortcuts** — the menu already owns every accelerator, so this is a settings
  surface over an existing map, not new plumbing.
- **Per-site zoom and per-site settings** memory.

---

## 3. The "not built yet" list

### Private browsing — **build this next after the visibility work**
Its absence is conspicuous; every browser has it. The Web Memory gate already has the flag and
honours it, so this is mostly: a new window type, a non-persistent session from `SessionRegistry`,
visual treatment, and refusing to write history. A few days, not weeks.

### Semantic search
`sqlite-vec` is installed and loads. Missing: the embedding worker. Plan is already written — MiniLM
via transformers.js in a utility process, opt-in, with a visible model download. Keyword search
stays the default and always works.

### Auto-update — **the real blocker for shipping to anyone**
Chromium ships security fixes roughly monthly. A browser that cannot update itself is a knowingly
vulnerable renderer with no path to a patch. Needs `electron-updater`, a release feed, and a signing
certificate. This outranks every feature on this page if Slash is ever handed to another person.

### Crash reporting
You would currently never learn what broke on someone else's machine.

---

## 4. Extensions — read this before promising anything

**Electron cannot install Chrome Web Store extensions.** This is the honest constraint and it is a
hard one.

What Electron actually supports, via `session.extensions.loadExtension()`:

- **Unpacked extensions only** — a folder, not a `.crx`. No Web Store install flow.
- **A subset of the extension APIs.** Devtools extensions and simple content-script extensions work.
  `chrome.tabs`, `chrome.storage`, parts of `chrome.runtime` work. Much else does not.
- **No `webRequest` blocking API and no full `declarativeNetRequest`** — so uBlock Origin, the
  extension most people would want, **does not work**. This is also why Slash Shield exists as a
  built-in rather than as "just install an ad blocker".
- **Not persisted across restarts** — extensions must be re-loaded on every launch, so we would keep
  our own registry of installed paths.
- **No auto-update**, no permission-prompt infrastructure, no store UI.

What is realistically buildable:

1. **"Load unpacked extension" in Settings** — pick a folder, we persist the path and reload it each
   launch. Honest, small, works today. Useful for anyone doing development, and for the handful of
   extensions that do function.
2. **A curated built-in catalogue** — a short list of known-compatible extensions we test, install by
   download-and-unpack. This looks like a store without pretending to be one.
3. **A Slash-native plugin API** — our own extension surface over the IPC contracts we already have
   (a plugin could add omnibox commands, a side panel, AI actions). More work, but it fits the
   architecture, is properly sandboxed, and does not inherit Chromium's extension baggage.

**What I will not do:** imply Chrome Web Store compatibility, or ship an "Extensions" store page that
mostly shows things that will not run. That is the same honesty rule as the virus-scanner wording.

---

## 5. Missing browser basics people will notice

These are unglamorous and their absence is felt immediately:

- **Password manager** — or at minimum, integration with the OS one. Currently nothing.
- **Autofill** for addresses and payment details.
- **Sync** — no account, no cross-device. A deliberate fit with local-first, but users will ask.
- **Reading list / read-it-later**, distinct from bookmarks.
- **Reader mode** — Readability is already a dependency for Web Memory; this is nearly free.
- **PDF viewer** — Chromium's is available but needs wiring.
- **Tab search** (Ctrl+Shift+A) — essential past ~30 tabs.
- **Tab groups within a workspace** — colour-coded runs in the strip.
- **Picture-in-picture**, **cast**, **translate**.
- **Import from Chrome/Edge** — bookmarks, history, passwords. Without this, switching is a wall.
- **Accessibility pass** — no screen reader has ever been tried; keyboard navigation is partial.
- **Multi-window session restore** — snapshots are per-database, so restoring puts every tab in one
  window regardless of where it came from.

---

## 6. UI/UX problems worth fixing

- **The side panel insets the page rather than floating.** Correct given the architecture, but it
  makes opening History feel heavy. Consider an overlay-view panel for quick lookups.
- **No empty states.** Empty history, no bookmarks, no downloads all render as blank space.
- **No onboarding.** First launch should offer: import from your old browser, pick an accent, choose
  a search engine, explain what tab sleeping will do. Three screens.
- **Errors are silent.** A failed page load shows Chromium's default; there is no Slash-styled error
  page with a Retry that also says whether Shield blocked it.
- **No loading feedback on slow panels** — memory search over a large index just pauses.
- **Favicon fallbacks** are inconsistent — some tabs show a blank square.
- **The tab strip does not scroll or shrink gracefully** past ~15 tabs; titles become unreadable
  before anything adapts.
- **No visible keyboard-shortcut discovery.** Everything is in the menu, which is hidden behind Alt.
- **Settings is one long scroll** — it needs sections and a search box.

---

## Suggested order

| # | Work | Why |
|---|---|---|
| 1 | New tab page, visible tab sleeping, workspace theming, memory in omnibox | Makes the browser's reason to exist visible. Highest value per hour. |
| 2 | Onboarding + import from Chrome/Edge | Without import, nobody can switch even if they want to. |
| 3 | Private browsing | Conspicuous absence; groundwork already laid. |
| 4 | Tab search, reader mode, PDF, empty states | Basics whose absence reads as "unfinished". |
| 5 | Personalisation (themes, density, vertical tabs) | Makes it feel like theirs. |
| 6 | Extensions: load-unpacked + honest scoping | Real capability without overpromising. |
| 7 | Auto-update + code signing + crash reporting | **Mandatory before anyone else uses it.** |
| 8 | Semantic search, password manager, sync | Larger projects, lower urgency. |

Form-state restore sits alongside #5 and needs its own decision: it means writing what you typed —
excluding password fields — into the local database. It is off by default and the settings copy says
exactly that.
