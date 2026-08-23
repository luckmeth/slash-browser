# Adaptive Browser

A Chromium/Electron desktop browser. The differentiator is not rendering — that is Chromium's job —
but everything around the page: workspace organisation, adaptive tab resource management, granular
permission control, local-first browsing memory, session time travel, and an optional AI action layer
that always previews before it acts.

Full development plan: `docs/PLAN.md`.
**What is left to build, in priority order: `docs/ROADMAP.md`** — read this before starting new
feature work. It records what is missing, what each item costs, and the constraints that rule some
approaches out (notably: Electron cannot install Chrome Web Store extensions, and auto-update needs
a signing certificate the project does not have).

## Core product principles

These are not aspirations; they constrain the code.

1. **Fast by default.** No feature may add latency to the browsing path.
2. **Privacy by default.** Nothing leaves the machine unless the user turned it on.
3. **Local-first.** SQLite in `userData` is the source of truth.
4. **AI is optional.** The browser must be fully usable with AI disabled — and it must be disabled
   until the user configures a provider. No nagging, no degraded experience.
5. **AI never acts without approval.** `UNDERSTAND → PLAN → PREVIEW → APPROVE → EXECUTE → REPORT`.
6. **Advanced power must not complicate the default UI.** Dashboards are routes the user opens, never
   permanent chrome.
7. **Explain permissions and security decisions in plain language.**
8. **Never claim capability the architecture does not have.** See "Honest constraints" below. If
   Electron cannot do something, the UI says so rather than implying otherwise.
9. **Modular systems behind clean interfaces.**
10. **Stability before experiments.**

## Honest constraints (do not paper over these)

| Vision | Reality | What we do instead |
|---|---|---|
| Freeze/hibernate a tab | Electron has no freeze API | FROZEN = detach view + throttle + mute. HIBERNATED = destroy the `WebContentsView`, persist `{url,title,favicon,scrollY,navigationHistory}`, rebuild on activate |
| Per-tab CPU/RAM | `app.getAppMetrics()` is per-**process**; site isolation shares renderers | Map via `getOSProcessId()`; when a PID serves >1 tab, divide and label the row "shared process (estimate)" |
| Resource savings | Only measurable for hibernation | Record RSS before destroying the view → **measured**. Freeze savings are tagged **estimate** |
| Autoplay as a permission | Not in `setPermissionRequestHandler` | `autoplayPolicy` webPreference + per-tab mute; UI states a reload is required to change it |
| Permission revocation | Chromium caches some grants renderer-side | Revoke updates our store *and* offers "Revoke & reload tab" |
| Restore my session | Cookies persist; SPA in-memory state does not | Restore URL/title/order/pinned/scroll + full back-forward history via `navigationHistory.restore()`. UI says: pages, not logged-in state |
| React UI over page content | `WebContentsView` is a native view — CSS `z-index` cannot cover it | Transparent overlay `WebContentsView` stacked above page views, hosting `overlay.html` |
| Block YouTube's video ads by filtering requests | Ad segments stream from the same `googlevideo.com/videoplayback` URL as the video, and the ad breaks arrive as a *field in the watch page's HTML*, not as a request | One script in YouTube's own JavaScript context deletes `adPlacements`/`playerAds`/`adSlots`. Gated on hostname, scoped to three fields, switchable off via `blockYouTubeVideoAds`. It does not touch creator-read sponsor segments, which are part of the video itself |
| Run our scripts in the page whenever we like | Only **one** debugger client may attach to a `WebContents`, so a second feature attaching its own would silently never run — and DevTools is a client too | `ScriptletInjector` is the single attach point; scripts register with it and each re-checks its own hostname and setting at runtime. **DevTools always wins**: opening it detaches us, closing it reattaches. Two scripts live there — the YouTube ad-break strip and the `window.open` defuser. `CleanupService.executeJavaScript` is also main-world, so this is a capability to keep narrow rather than a line nobody has crossed |
| Block a popup by refusing it | `setWindowOpenHandler` denying makes `window.open()` return `null` — and Slash denies for *allowed* popups too, since it opens the tab itself and denies so Chromium does not open a second window. Sites doing `var w = window.open(u); w.blur()` then throw, killing the click that asked | `popupDefuserScript` decides nothing: the real `window.open` still runs, so the verdict, gesture accounting and held-popup notice are unchanged. Only the return value changes — `null` becomes a harmless stand-in, so the page's code continues and the popup still never opens |
| Match ads by hostname alone | 152 hand-kept domains cannot express request types, first-party exceptions, or the tens of thousands of rules real lists carry | `@ghostery/adblocker` (pure TypeScript — node-gyp cannot build under a path with spaces) runs *alongside* `FilterEngine`, which keeps the malicious list, per-site exemptions and the host+path rules that reach first-party endpoints. Lists are bundled data with attribution; uBlock's scriptlets are **not** bundled, being executable GPLv3 |
| Compile filter lists at startup | Parsing 4.3 MB takes ~770 ms, and principle 1 is that no feature may add latency to the browsing path | Compiled in a utility process (second rollup entry, same as the embedding worker) and cached to `userData`. Main only deserialises: 24–30 ms, and later launches skip the compile entirely. A stale or missing cache degrades to the domain lists rather than blocking startup |
| Autofill a saved password | Filling means the value must reach the page, and both obvious routes are bad: `executeJavaScript` puts it in script source in the page's own world, and sending it to the content preload hands it to a process running untrusted web content | The preload reports only that a password field **exists** and keeps its own element references; main asks it to *focus* one (no secret in the command) and then calls `webContents.insertText`, so the value travels Chromium's own input pipeline. Never script source, never an IPC payload, never inside a renderer we control. `SavedLogin` has no password field, so no handler can leak one |
| Capture a password when you sign in | That means reading the value out of a password field, which is exactly what `preload/content.ts` is written never to do | Sign-ins are added by hand in Settings and typed back for you. The cost is stated in the UI rather than discovered. A preload that reads sign-in fields on every site is a much larger change to what this browser is, and is not made quietly for convenience |
| Four-pane split view | Each pane is a live renderer, and Chromium composites every attached view | Capped at **two**. Two is the one deliberate exception to "only the active tab's view is attached", justified because both panes are genuinely visible; four is a different performance conversation, not a bigger number. The drag handle may live in the chrome document *only* because it sits in the gutter, where no page view composites above it |
| Tab groups that behave like small workspaces | A workspace owns a session partition; a group is a label over tabs that already exist | Deleting a group never deletes tabs, and moving a tab between groups never reloads it. "Ungroup (keeps tabs open)" and "Close N tabs" are separate channels with separate names, because they are one careless click apart and only one is recoverable. Collapsing is **not** sleeping — the tabs keep their views, so the chip shows a count rather than letting a run silently vanish |
| Semantic search out of the box | Running a language model needs weights from somewhere | MiniLM **ships with the app** (`resources/models/`, ~23 MB) rather than being fetched on first enable. Downloading it would have turned a local search feature into an outbound request to a third party. Still opt-in, and keyword search never depends on it |
| Two profiles open side by side | The single-instance lock is application-wide, and `app.setPath('userData')` is only honoured before anything has opened a file — by the time a user clicks "switch", the database, every session partition and every cache are already open | **One profile at a time.** Switching relaunches with `--profile=<id>`, which Chrome does too. The default profile keeps the original directory untouched so no existing install moves; others are **siblings**, never children, or the default's "delete all data" would take them with it |
| Media keys that only reach Slash | `globalShortcut` is exactly that — global. Electron does not route hardware media keys to the focused page, and Chromium's own handling sits above the layer Electron exposes | Registered on focus, released on blur, so pausing Spotify does not pause a minimised browser tab. `mediaKeysAlwaysOn` opts into the rude version for people who use Slash as their music player, and the settings copy says what it takes |
| Translate a page without sending it anywhere | A translation model worth using is gigabytes; the browser ships a ~23 MB embedding model and bundling a translator would quadruple the installer for a feature most people never open | Translation goes through the **already-configured AI provider** and is gated on `aiMayReadPageContent` — the same switch as every other route page text takes to a provider, not a second one to find. It translates the *article* (Readability blocks, shown in the reader), never the live page, because rewriting text in place would mean scripting every site in its own world |
| Autofill a saved payment card | Storing one means holding a primary account number: a regulated category of data with obligations this project cannot meet, and nothing the browser can do protects it better than a dedicated password manager already does | Addresses are stored and filled; **cards are not**, and the settings screen says so rather than half-doing it. Address filling reuses the password path exactly — the preload reports which *kinds* of field exist and never a value, main focuses one and calls `insertText` |
| Sync that a server operator could read | Nothing, technically — which is the problem. A sync that uploads readable bookmarks turns "local-first, nothing leaves the machine" into a slogan | End-to-end encrypted: scrypt from a passphrase that **never leaves the machine**, AES-256-GCM per item, and no derived key stored. The server holds ciphertext and a timestamp. The cost is stated before the switch is thrown — forget the passphrase and the data is unrecoverable, because nobody holds a spare. History is deliberately not synced |
| An accessible combobox: omnibox + its suggestion popup | The suggestions render in the **overlay**, a separate `WebContentsView` with its own document. `aria-controls` and `aria-activedescendant` are id references, and an id cannot be resolved across documents — so the relationship was declared and silently resolved to nothing | `aria-autocomplete="list"` plus a `role="status"` live region **in the chrome document**, announcing how many suggestions there are. The overlay list keeps `role="listbox"`/`option` for its own document. The relationship is not faked with attributes that cannot work |
| "Find any page by meaning" | Only the first ~8,000 characters of a page are embedded (10 passages), and MiniLM reads 256 word-pieces at a time | The cap is stated in the UI. A long page is matched on its opening, not its entirety |
| Sign in with a Claude Pro/Max subscription and use it from the browser | There is no public OAuth that grants a third-party app someone's subscription. The API is billed separately; the only other route is lifting a session cookie out of a browser profile | The assistant is **the real website in a pane** — split view, pointed at claude.ai. The user signs in as they always do, so the subscription works, there is no key to enter, and Slash reads nothing. Sending page content to a provider stays a separate feature behind `aiMayReadPageContent` |
| Set Slash as the default browser from inside Slash | Windows has not permitted it since Windows 8: the association is a `UserChoice` key signed against the user and the ProgId, and anything written from code is reverted with no error | The installer registers Slash under `StartMenuInternet`/`RegisteredApplications` so it *appears* in Default apps; the app opens that screen and says the final click is the user's. No `system:makeDefault` channel exists, because the name would be a lie. Slash also had to learn to open URLs from its own argv — that is the entire mechanism by which a default browser receives a click |
| Find YouTube's video by watching the network | Its media arrives as byte ranges of `videoplayback`, increasingly inside YouTube's own transport format — a response observer sees fragments, never a file. The chip correctly had nothing to offer, so it never appeared on the one site people judge this feature on | The page lists every format in `ytInitialPlayerResponse` before playback starts. `PageMediaExtractor` **reads** it: hostname-gated, only on the user's click, changing nothing. Formats whose address must be built by running the site's signature code are skipped *and counted*, so the picker says that rather than "nothing found" |
| Right-click always works | A page can cancel the `contextmenu` event, and Chromium then never asks the browser for a menu. There is nothing for `installPageContextMenu` to show, and Chrome behaves identically — which is why this is a complaint about every browser | `contextMenuScript` registers a capture-phase listener at document start that calls `stopImmediatePropagation`, so the site's handler never runs and never gets to cancel. Inline `oncontextmenu` properties are cleared separately, since propagation does not reach those. Verified by `SLASH_CONTEXTMENU_PROBE` against both forms. Behind `restoreContextMenu` because a site with a genuinely useful menu loses it |
| Drag a link or selection onto the omnibox | The omnibox lives in the chrome view and the page in a separate `WebContentsView`. A drag is a native session belonging to one surface; it does not cross between two of them in the same window | Not implemented, and not faked. The context menu's **Search for "…"** and **Copy link address** reach the same outcomes in one action, and paste-and-go works in the omnibox |
| A floating "download this video" panel, like IDM | Anything drawn over a page has to be a native view: the page is a `WebContentsView` composited above the chrome document, so a React chip renders *behind* the video it points at — visible on the new tab page, invisible on YouTube | The chip is an overlay surface (`media-offer`) sized to a corner, non-modal so the player stays clickable. **Passive**: it never takes the overlay from a surface the user opened, and returns when that closes |
| Download any video the browser plays, like a download manager | Every serious video site streams through Media Source Extensions: the `<video>` element's `src` is a `blob:` URL meaningless outside that page, the real media arrives as thousands of encrypted or segmented responses, and DRM-protected streams cannot be assembled at all | `MediaSniffer` watches `onResponseStarted` (the free event — `onBeforeRequest` belongs to `ContentBlocker`, and Electron allows one listener each) and offers **complete files only**. Manifests and encrypted streams are recognised in order to be *excluded and explained*, never decrypted. A toolbar button appears only when there is genuinely something to download |

## Architecture rules

- **Three view layers per window.** chrome view (full bounds) → page view (inset into the chrome's
  content hole) → transparent overlay view (full bounds, hidden by default). Anything that must
  visually cover a web page — command bar, dialogs, permission prompts, context menus — renders in
  the overlay.
- **A CSS panel in the chrome document renders *underneath* the page view.** The page view is a
  native layer composited above the DOM. So side panels (history, bookmarks, downloads, settings)
  **inset** the page via `layout:setRightPanelWidth` → `ViewLayoutManager.setRightPanelWidth` rather
  than floating over it. Anything that genuinely must float goes in the overlay view instead.
- **Only the active tab's view is attached to the window.** Background tabs keep their
  `WebContentsView` alive but detached — they carry on loading and playing audio without being
  composited. Chromium composites every attached view, so leaving N in the tree costs GPU work for
  N-1 invisible pages.
- **`Tab` holds its `WebContentsView` optionally.** A tab with a null view is a completely normal tab
  that simply is not rendering. This is what makes Phase 3 hibernation a state change rather than a
  refactor, and it is also how internal pages (the new tab page) work: no view is attached and the
  chrome document shows through the content hole.
- **Workspace isolation is fixed at creation and cannot be toggled.** An isolated workspace owns a
  `persist:ws-<id>` partition; flipping the flag later would strand every cookie in the old
  partition. The supported route to isolation is *Duplicate as isolated*. Moving a tab across an
  isolation boundary necessarily reloads it signed out — warn first, never do it silently.
- **Only `HIBERNATED` frees memory.** FROZEN (detached + marked hidden + muted) buys CPU. Never
  quote a byte figure for freezing. Hibernation records the real working set immediately before
  destroying the renderer and reports it as **measured**; everything else is an **estimate** and
  must be labelled so in the UI.
- **Nothing may sleep a tab except through `ResourcePolicyEngine.blockersFor`.** That includes
  user-initiated actions — a button press is not a reason to destroy a half-filled form. The engine
  is pure and clock-injected precisely so every guard is unit-tested.
- **Every session must come from `SessionRegistry`.** It applies `SessionHardening` before handing
  one out. A partition created anywhere else would silently start with Chromium's defaults —
  permissive where ours are not — while looking identical from the outside.
- **Keyboard shortcuts live in the application menu** (`src/main/menu.ts`), not in renderer
  `keydown` handlers. Focus normally sits in the page view — a web page — so the chrome document
  never sees Ctrl+T. Menu accelerators fire regardless of which native view has focus. Commands
  needing renderer state are forwarded as a `ui:command` event.
- **`ipc/registry.ts` is the only file permitted to call `ipcMain.handle`.** Every handler is wrapped
  with a sender allowlist (chrome/overlay frames only), a zod parse of the payload, and `Result`
  wrapping so nothing throws across the boundary.
- **`shared/ipc/contracts.ts` is the single source of truth** for channel names and payload schemas.
  Adding a channel means adding a contract there first.
- **All web content runs `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.**
  This includes our own chrome UI — it needs only `ipcRenderer` via `contextBridge`, which works
  sandboxed.
- **`preload/content.ts` has zero privileges.** It runs in web pages. It may capture scroll position
  and run Readability extraction, nothing more.
- **Engines live under `src/main/<domain>/`** (they need privileged APIs) but are defined as
  interfaces in `src/shared/types/` and consumed only through those interfaces.
- **Rust migration seam:** `ResourceSampler` and `EmbeddingWorker` are the two candidates. Both are
  interfaces with an in-process TS implementation, invoked asynchronously, so either can become a
  sidecar speaking JSON-RPC over stdio without touching callers.
- **The embedding runtime never loads in the main process.** `src/main/memory/embedding/worker.ts`
  is a second rollup entry (`out/main/embeddingWorker.js`) launched with `utilityProcess.fork`.
  Loading ONNX blocks its thread for hundreds of milliseconds; in main that is every tab switch and
  every IPC reply. The worker imports nothing from `shared/types` — the vector width is passed in
  the `prepare` message — because importing a schema module drags zod into a 4 KB bundle.
- **A tab showing an error has no page view.** `Tab.needsView` is false while `error` is set, so
  the view is detached and the chrome's `ErrorPage` fills the content hole — the same mechanism as
  the new tab page and the hibernation placeholder. Chromium's own failure page cannot say whether
  Slash Shield refused the request, which is the whole point of having our own. Retrying clears the
  error and **must reattach the view**; `navigate` and `reload` both do.
- **Reader mode carries text blocks, never HTML.** Readability's `content` is markup derived from a
  web page, and the overlay that renders it holds the privileged IPC bridge. `readerScript.ts`
  walks the parsed DOM in a detached container and returns typed blocks, which React escapes.
- **Vertical tabs inset the native page view.** `tabStripPosition: 'left'` widens
  `ViewLayoutManager.setSidebarWidth` by `VERTICAL_TAB_STRIP_WIDTH`. Moving the strip in React alone
  would draw the tab column underneath the page — same trap as side panels.
- **The importer reads bookmarks and history only.** Chromium's passwords are DPAPI-encrypted
  against the user's own account and *could* be decrypted here. Lifting a credential store on the
  strength of one "Import" button is not a thing this browser does. Chromium locks `History` while
  running, so it is copied — with its `-wal` — before being read.
- **The embedding model is bundled and `allowRemoteModels` is `false`.** `resources/models/` ships
  via `extraResources`, so it lands *beside* app.asar — the ONNX runtime opens those files natively
  and cannot read through the archive. A missing file fails loudly instead of silently reaching for
  huggingface.co. Verify by moving `resources/models` aside and re-running the semantic probe.
- **`memory_vectors` is created at runtime, never in a migration.** A vec0 virtual table needs the
  sqlite-vec extension loaded, and a failed migration takes the whole database, and therefore the
  browser, down with it. `VectorStore.enable()` creates it the first time the feature is switched on.
- **vec0 rowids must be bound as `BigInt`.** better-sqlite3 passes a plain JS number to SQLite as a
  float and vec0 rejects it ("Only integers are allows for primary key values"). Every insert and
  delete against `memory_vectors` binds `BigInt(id)`.
- **Deleting a page deletes its vectors first.** `ON DELETE CASCADE` reaches `memory_chunks` but not
  a virtual table, so `MemoryRepository` holds the `VectorStore` and calls `forgetPage` *before* the
  page row goes. `VectorStore.enable()` also prunes orphans left by a session where the extension
  never loaded.
- **The profile is chosen before `app.whenReady()`, and nothing may read a path before it.**
  `prepareUserDataPath()` then `applyProfile()`, in that order, at the very top of `main/index.ts`.
  `app.setPath('userData', …)` is silently ignored once anything has opened a file under the old
  path — there is no error, the browser simply uses the wrong profile's data and writes to it. The
  profile list is therefore plain JSON beside the directories, not SQLite: it has to be readable
  before the database exists.
- **A deletion that has to reach another device is a row, not an absence.** Bookmarks and reading
  list items write to `sync_tombstones` *before* the row goes, while their identity can still be
  read. Without that, "missing here" is indistinguishable from "new there" and every deleted item
  comes back on the next sync. Bookmarks carry a `guid` for the same reason: the AUTOINCREMENT
  primary key is unique on one machine and meaningless on any other.
- **Media detection is a network observer, and a deliberately partial one.** `MediaSniffer`
  lists only what it can hand to the download engine as a complete file. It recognises HLS/DASH
  manifests and DRM licence traffic so `sniffNote` can say *why* there is nothing to download —
  offering a button that produces an unplayable file is worse than a sentence. Reassembling
  segments or touching encrypted streams is out of scope and must stay that way.
- **Anything the queue starts must claim its slot before its first `await`.** `pump` starts
  whatever is queued and not already live, so a `begin*` method that awaits before calling
  `this.live.set` leaves a window for a second pump to start the same download again. The two runs
  then race over the same part files and the download **completes**, silently, having produced only
  half the video. `beginJoined` shipped with exactly that bug and it was invisible to typecheck,
  lint and 854 unit tests — only `SLASH_STREAM_PROBE` caught it.
- **A download path is not verified until a probe has run it and read the file back.** "State =
  completed" means the code finished, not that the file is right. `SLASH_STREAM_PROBE` generates a
  real video with the bundled ffmpeg, segments it into real HLS, serves it from a real server, runs
  the real `DownloadQueue`, and checks the **duration and stream count** of the result — because a
  stream assembled out of order still produces a file that opens and plays for a few seconds.
- **A page script that is a string needs its own test.** `EXTRACT_SCRIPT` is evaluated in the page's
  own world, so a syntax error or a typo'd property fails no build, no typecheck, and no runtime
  check anybody sees — `extract` catches it and the feature reports "nothing to download" for ever.
  `extractScript.test.ts` runs it through `new Function` against stand-ins for the page globals.
  Every string-of-code here deserves the same, and this one was written after shipping the failure
  twice.
- **A `webRequest` listener must be filtered, and its callback must do almost nothing.** An
  unfiltered listener is a main-process callback for *every response on every page*, and
  `ContentBlocker` already spends one. Media detection filters to `media`/`xhr`/`object` at
  registration — the exclusion has to happen before the callback exists, because by the time it
  runs the headers have already been marshalled across. The callback then dedupes by URL, because a
  playing video re-requests the same file several times a second and re-ranking on each would be a
  cost paid constantly. `detectPageMedia` **removes** the listener rather than skipping its body.
  This is principle 1, and it was learned by shipping the unfiltered version.
- **Anything that reaches a page's fields goes through `insertText`, never script.** Passwords and
  addresses both: `preload/content.ts` reports which *kinds* of field exist and holds the element
  references, main asks it to focus one, then types the value through Chromium's own input pipeline.
  `executeJavaScript` would put the value in script source in the page's own world; sending it to
  the content preload would hand it to a process running untrusted web content.

## Stack

Electron 43 (Chromium 150, Node 24.18) · React 19 · TypeScript 5.9 (**not 7** — typescript-eslint
peer-caps at `<6.1.0`) · Vite 7 (**not 8** — electron-vite 5 peer-caps at `^7`) · electron-vite 5 ·
Tailwind 4 · Zustand 5 · zod 4 · better-sqlite3 13.

`package.json` has no `"type": "module"`: main and preload emit CJS, the reliable path for native
modules and sandboxed preloads. Tooling configs use `.mjs`.

### Two build constraints that are easy to trip over

**Never add a native module that requires compilation.** This project's path contains spaces
(`Projects - Slash Developments\Slash Browser`) and **node-gyp refuses to build any module whose
path contains a space** ([nodejs/node-gyp#65](https://github.com/nodejs/node-gyp/issues/65)). There
is no flag for this. better-sqlite3 works only because v13 ships **N-API prebuilds** (`prebuilds/win32-x64.node`,
named by platform+arch with no ABI version), and N-API binaries are ABI-stable across both Node and
Electron — so the shipped binary loads as-is. Hence `npmRebuild: false` and no `install-app-deps`
postinstall; adding either brings back a build that cannot succeed here. A future native dependency
must either ship N-API prebuilds or move the repo to a space-free path.

*(Chosen over the built-in `node:sqlite`, which does also have FTS5 — verified. better-sqlite3 wins
on a newer SQLite (3.53.4 vs 3.49.1), a non-experimental API, and mature transaction/prepared-statement
ergonomics. `node:sqlite` remains a viable fallback if the prebuild story ever breaks.)*

**Never import `shared/ipc/contracts.ts` from a preload.** It pulls zod and every schema into a
bundle evaluated before each privileged view's first paint — it cost 137 KB before the split. Import
runtime values from the zod-free `shared/ipc/channels.ts`; schema-derived types are `import type` and
erase to nothing. Current preload: ~1 KB.

## Commands

```bash
npm run dev        # electron-vite dev server
npm run typecheck  # both tsconfig projects
npm test           # vitest, pure logic only — no electron import
npm run lint
npm run package    # NSIS installer into release/
```

## Working agreements

- Do not start a phase before the previous one is stable. Phase order is in `docs/PLAN.md`.
- No placeholder implementations for core features. If Electron cannot support something, implement
  the closest correct alternative and document the gap in the table above.
- Every phase ends with: `npm run typecheck` clean, tests green, and a manual script in
  `docs/testing/phase-N.md` that also re-runs earlier phases' scripts as regression checks.
- Never auto-classify a user's tabs, index page content, or contact an AI provider without an
  explicit opt-in already recorded in settings.
