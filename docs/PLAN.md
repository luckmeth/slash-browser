# Adaptive Browser — Full Development Plan

> **Corrections applied during Phase 0** (this plan is otherwise as approved):
>
> - **Versions.** Electron **43** (Chromium 150, Node 24.18), not 40. TypeScript **5.9**, not 7 —
>   typescript-eslint peer-caps at `<6.1.0`. Vite **7**, not 8 — electron-vite 5 peer-caps at `^7`.
> - **The native-module premise was wrong, in our favour.** better-sqlite3 needs no ABI rebuild: v13
>   ships N-API prebuilds that load in Electron as-is. This matters because node-gyp *cannot* build
>   here at all — the project path contains spaces. `npmRebuild` is off. See CLAUDE.md.
> - **`node:sqlite` does have FTS5** (verified), so that was not the deciding factor. better-sqlite3
>   still wins on a newer SQLite and a non-experimental API.
> - **Both Phase 0 spikes passed**, in dev and in the packaged NSIS build. See `docs/testing/phase-0.md`.
>
> **Progress:** Phases 0–7 all built ✅, plus a native-shell pass that was not in the
> original plan. 121 tests, installer builds.
>
> **Not launch-ready.** See `docs/RELEASE-READINESS.md` for what stands between this and
> something you could hand to a stranger — the largest items are code signing and an
> auto-update channel, neither of which is a coding task.
>
> Deliberately not built: the optional local ONNX embedding layer for semantic search
> (`docs/testing/phase-5.md`), and AI page summarisation (`docs/testing/phase-7.md`).
> Per-phase test scripts and known gaps live in `docs/testing/phase-N.md`.
>
> Two design decisions made during implementation that the plan did not anticipate:
>
> - **Side panels inset the page view; they do not float over it.** A `WebContentsView` is a native
>   layer composited above the DOM, so a CSS drawer in the chrome document renders *underneath* the
>   page. Panels therefore shrink the page rect via `layout:setRightPanelWidth`. The transparent
>   overlay view remains for things that genuinely must float (command bar, permission prompts).
> - **The new tab page is drawn by the chrome document, not a page.** A tab whose URL is
>   `adaptive://newtab` simply has no view attached, so the chrome shows through the content hole.
>   This avoids registering a custom protocol and avoids granting any page view privileges.

## Context

`D:\Projects - Slash Developments\Slash Browser` is empty. This plan builds **Adaptive Browser** from zero: a Chromium/Electron desktop browser whose differentiator is not rendering (that's Chromium's job) but **everything around the page** — workspace organisation, adaptive tab resource management, granular permission control, local-first browsing memory, session time travel, and an optional AI action layer that always previews before it acts.

The core product rule driving every decision below: **the browser must be fully usable, fast, and private with AI completely disabled.** AI is a bolt-on that requires a user-supplied key and never fires an action without explicit approval.

Verified environment: Node v22.16.0, npm 11.18.0, cargo 1.95.0, git 2.50.0, VS 2022 (native modules compile locally). Not yet a git repo — Phase 0 initialises one.

### Decisions locked with the user

| Fork | Decision |
|---|---|
| Workspace isolation | **Hybrid** — shared default session; per-workspace `persist:` partition is opt-in at creation |
| AI backend | **Pluggable BYOK** — Anthropic adapter (default, `claude-opus-5`/`claude-sonnet-5`) + OpenAI-compatible local adapter (Ollama/LM Studio) |
| Semantic search | **Local ONNX embeddings, opt-in** — transformers.js + MiniLM in a utility process, vectors in `sqlite-vec`; FTS5 keyword search ships first and always works |
| Platforms | **Windows first**, all code platform-agnostic so mac/Linux is a config change |

---

## Honest technical constraints (design around these, don't paper over them)

These are the places where the product vision outruns what Electron/Chromium actually expose. Each has a designed, technically-correct substitute. **The UI must state these limits to the user rather than implying capability we don't have** (product principle #8).

| Vision | Reality | What we build instead |
|---|---|---|
| "Freeze / hibernate a tab" | Electron has no freeze API. `setBackgroundThrottling` only throttles timers/rAF. | **FROZEN** = detach view from window + throttle + mute (process alive, stops compositing). **HIBERNATED** = destroy the `WebContentsView` entirely, persist `{url, title, favicon, scrollY, navigationHistory}` in the tab model, render a placeholder, rebuild on activation. This genuinely frees the renderer process. Unsaved form state is lost — we detect `beforeunload` handlers and never auto-hibernate those tabs. |
| "Per-tab CPU/RAM" | `app.getAppMetrics()` is **per-process**. Site isolation means several same-site tabs share one renderer. | Map `webContents.getOSProcessId()` → metrics. When N tabs share a PID, divide and **label the row "shared process (estimate)"** in the dashboard. Never present a shared-process number as exact. |
| "Show resource savings" | Only measurable for hibernation. | Record RSS immediately before destroying a view; report that as **measured**. Freeze savings are shown as **estimated** with a visible tag. |
| Autoplay as a permission | Not part of `setPermissionRequestHandler`. | `autoplayPolicy` webPreference is fixed at view creation + per-tab `setAudioMuted`. Changing the policy requires a tab reload — the UI says so. |
| Permission revocation | Chromium caches some grants in the renderer; revoking mid-page isn't always immediate. | Revoke updates our store *and* offers a one-click "Revoke & reload tab" for permission types where mid-flight revocation is unreliable. |
| "Restore my session" | Cookies/localStorage persist; SPA in-memory state and auth flows do not. | Restore URL + title + order + pinned + scroll + **full back/forward history** via `webContents.navigationHistory.restore()`. Time Machine UI explicitly says it restores *pages, not logged-in application state*. |
| React UI overlapping page content | `WebContentsView` is a native view composited above the DOM — CSS `z-index` cannot cover it. | Dedicated **transparent overlay `WebContentsView`** stacked above page views, hosting `overlay.html` (command bar, dialogs, permission prompts). Validated by a spike in Phase 0; fallback is shrinking/hiding the page view while an overlay is open. Retrofitting this later is painful, so it is built on day one. |

---

## Architecture

```
slash-browser/
├── electron.vite.config.ts        # 3 build targets: main, preload, renderer
├── electron-builder.yml           # NSIS (win) now; mac/linux blocks stubbed
├── tsconfig.{json,node,web}.json  # strict: true, noUncheckedIndexedAccess
├── vitest.config.ts               # unit tests (main-process logic, pure funcs)
├── playwright.config.ts           # E2E driving the real packaged app
├── CLAUDE.md                      # master prompt as permanent project instruction
└── src/
    ├── main/                                  # privileged — Node + Electron APIs
    │   ├── index.ts                           # bootstrap, single-instance lock, lifecycle
    │   ├── AppContext.ts                      # DI container; owns construction + shutdown order
    │   ├── windows/
    │   │   ├── BrowserWindowController.ts     # BaseWindow + chrome/page/overlay view stack
    │   │   ├── ViewLayoutManager.ts           # bounds math, resize, chrome height
    │   │   └── OverlayController.ts           # transparent overlay view show/hide/focus
    │   ├── tabs/
    │   │   ├── Tab.ts                         # model + optional live WebContentsView
    │   │   ├── TabManager.ts                  # CRUD, activate, reorder, move, closed-tab stack
    │   │   ├── TabEvents.ts                   # webContents events → normalised TabUpdate
    │   │   └── ViewFactory.ts                 # builds views with correct session + webPreferences
    │   ├── sessions/
    │   │   ├── SessionRegistry.ts             # default + persist:ws-<id> partitions
    │   │   └── SessionHardening.ts            # handlers applied to EVERY session created
    │   ├── navigation/
    │   │   ├── UrlResolver.ts                 # omnibox text → URL | search query
    │   │   └── NavigationGuards.ts            # will-navigate, windowOpenHandler, external protocols
    │   ├── downloads/DownloadManager.ts
    │   ├── workspaces/WorkspaceManager.ts     # Phase 2
    │   ├── performance/                       # Phase 3
    │   ├── permissions/                       # Phase 4
    │   ├── memory/                            # Phase 5
    │   ├── snapshots/                         # Phase 6
    │   ├── ai/                                # Phase 7
    │   ├── db/
    │   │   ├── Database.ts                    # better-sqlite3, WAL, pragmas, migration runner
    │   │   ├── migrations/00N_*.sql
    │   │   └── repositories/                  # History, Bookmark, Workspace, Permission, …
    │   ├── ipc/{registry.ts,validate.ts}
    │   └── settings/SettingsStore.ts
    ├── preload/
    │   ├── chrome.ts        # contextBridge → window.browser — ONLY for our React UI
    │   └── content.ts       # web pages: scroll capture + Readability extract. Zero privileges.
    ├── renderer/
    │   ├── index.html · App.tsx          # main chrome UI
    │   ├── overlay.html · Overlay.tsx    # command bar, dialogs, permission prompts
    │   ├── components/                   # primitives: Button, Dialog, Menu, Tooltip
    │   ├── features/{omnibox,tabs,workspaces,history,bookmarks,downloads,
    │   │             performance,permissions,memory,timemachine,settings,ai}
    │   ├── stores/                       # zustand slices, hydrated + patched over IPC
    │   └── hooks/
    └── shared/
        ├── types/                        # Tab, Workspace, PermissionGrant, Snapshot, …
        ├── ipc/contracts.ts              # zod schemas + channel names — single source of truth
        ├── constants.ts
        └── result.ts                     # Result<T,E>; IPC never throws across the boundary
```

**Deviation from the brief's `/services` folder:** the engines need privileged Electron APIs, so they live under `src/main/<domain>/` rather than a sibling top-level folder. The modularity the brief asks for is preserved by the interface boundary: every engine is defined as a TS interface in `shared/types/` and consumed only through that interface.

**Rust migration boundary.** Two components are the realistic future Rust candidates: the performance sampler (`ResourceSampler`) and the embedding indexer (`EmbeddingWorker`). Both are defined as interfaces with an in-process TS implementation and are invoked asynchronously over a message-passing seam, so replacing either with a sidecar binary speaking JSON-RPC over stdio is a swap of one class — not a rewrite.

### IPC contract (the security spine)

Every channel is declared once in `shared/ipc/contracts.ts` as `{ channel, request: ZodSchema, response: ZodSchema }`. `ipc/registry.ts` is the only file allowed to call `ipcMain.handle`, and it wraps each handler with:

1. **Sender allowlist** — reject unless `event.senderFrame` is our chrome or overlay view. Web content can never reach a privileged handler even if a preload leaks.
2. **Zod parse** of the payload; a parse failure returns `Result.err`, never throws.
3. **Result wrapping** so renderer code handles typed errors instead of rejected promises.

All web content runs `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`. `content.ts` exposes no `ipcRenderer` — it posts to a single allowlisted channel via `ipcRenderer.sendToHost`-style narrow bridge.

### Stack

Electron 43 (Chromium 150, Node 24.18) · React 19 + TypeScript 5.9 strict · Vite 7 via `electron-vite` 5 · Tailwind v4 · Zustand · **better-sqlite3 13** (N-API prebuilds — no compilation step, which is mandatory here since node-gyp cannot build under a path containing spaces) · `zod` · `dnd-kit` · `@mozilla/readability` · `sqlite-vec` + `@huggingface/transformers` (Phase 5, opt-in) · `@anthropic-ai/sdk` (Phase 7, opt-in).

---

## Roadmap

| Milestone | Phases | Outcome |
|---|---|---|
| **v0.1** | 0–3 | A browser you can use daily: tabs, workspaces, adaptive performance |
| **v0.2** | 4 | Permission Intelligence |
| **v0.3** | 5 | Web Memory (keyword, then opt-in semantic) |
| **v0.4** | 6 | Time Machine |
| **v0.5** | 7 | AI Action Engine |

Each phase ends with: types clean (`tsc --noEmit`), tests green, a manual test script in `docs/testing/phase-N.md`, and no regression in earlier phases.

---

## Phase 0 — Foundation & the two risky spikes

**Goal:** an empty window that proves the two architectural bets before any feature work depends on them.

Scaffold `electron-vite` with three entry points, strict tsconfig, Tailwind, ESLint/Prettier, Vitest, `git init` + `.gitignore`, `CLAUDE.md` containing the master prompt. Build `AppContext`, `Database` (WAL, `foreign_keys=ON`, forward-only numbered migration runner), `SettingsStore`, and the `ipc/registry` + `validate` skeleton with one round-trip channel.

**Spike A — view stacking.** `BaseWindow` → chrome `WebContentsView` (full bounds) → page `WebContentsView` (inset below chrome) → transparent overlay `WebContentsView` (full bounds, `setBackgroundColor('#00000000')`, hidden by default). Confirm the overlay renders above live page content with click-through where transparent. If transparency fails, fall back to hiding the page view while an overlay is open — decide here, not later.

**Spike B — native module.** `better-sqlite3` rebuilt for the Electron ABI, opening a DB in `app.getPath('userData')`, surviving `electron-builder` packaging into an installed NSIS build.

**Files:** `electron.vite.config.ts`, `electron-builder.yml`, `src/main/{index,AppContext}.ts`, `src/main/windows/*`, `src/main/db/*`, `src/main/ipc/*`, `src/preload/chrome.ts`, `src/renderer/{index.html,overlay.html,App.tsx,Overlay.tsx}`, `src/shared/*`.

**Verify:** `npm run dev` opens a window; overlay toggles above a loaded page; `npm run build` produces an installer whose installed copy writes to SQLite.

---

## Phase 1 — Core browser

**Goal:** stable, pleasant daily-driver browsing. No AI, no advanced engines.

`TabManager` owns an ordered `Tab[]` plus an `activeTabId`; `Tab` holds the model and *optionally* a live `WebContentsView` — this optionality is what makes Phase 3 hibernation a state change rather than a refactor. `TabEvents` normalises `did-start-loading`, `did-navigate`, `page-title-updated`, `page-favicon-updated`, `did-fail-load`, `media-started-playing`, `audio-state-changed`, `render-process-gone` into a single `TabUpdate` stream pushed to the renderer.

- **Navigation:** back / forward / reload / stop / home; `UrlResolver` decides URL vs search (configurable engine, default DuckDuckGo); `NavigationGuards` sends `mailto:`/unknown protocols to the OS after a confirm dialog and routes `window.open` through `setWindowOpenHandler` into a real tab.
- **Tabs:** new / close / close-others / reopen-closed (LIFO stack, 25 deep) / pin / duplicate / drag-reorder (`dnd-kit`) / **duplicate-URL detection** — opening a URL already open offers "Switch to existing tab".
- **Data:** history (visits table + dedup on `url`), bookmarks (folders, drag-order), downloads (`will-download`, pause/resume/cancel, open-in-folder, **danger warning on executable extensions**).
- **New tab page:** local `app://newtab`, no network calls.
- **Settings:** search engine, homepage, downloads dir, theme, startup behaviour, clear-browsing-data.
- **Profiles:** a Profile row selects a top-level `persist:profile-<id>` partition and a separate DB file. Switching profiles opens a new window. (This is the layer *above* workspaces.)
- **Crash resilience:** `render-process-gone` → sad-tab UI with Reload, never a silent blank page.

**Verify:** open 20 tabs across sites, drag-reorder, pin, close, Ctrl+Shift+T restores; navigate with back/forward; download a file and cancel another; history and bookmarks survive restart; no Node globals reachable from a page console.

---

## Phase 2 — Workspace engine

**Goal:** organisation that beats a flat tab strip.

`Workspace = { id, name, icon, color, isolated: boolean, createdAt, notes, tabOrder[], pinnedTabIds[] }`. `WorkspaceManager` owns membership; `TabManager` gains `workspaceId` per tab and only renders tabs of the active workspace.

**Hybrid isolation (the locked decision).** Non-isolated workspaces use the profile's default session — tabs move instantly and stay signed in. A workspace created with **Isolated** on gets `persist:ws-<id>` from `SessionRegistry`, giving real cookie/storage/cache separation. Moving a tab across an isolation boundary destroys and rebuilds its view in the target session; the UI shows a **clear, non-dismissible-by-accident warning** that the tab will reload signed-out. `SessionHardening` must run on every partition the registry creates, not just the default one.

Also: create/rename/delete/duplicate workspace, reorder, per-workspace notes (markdown, autosaved), scoped search within a workspace, and a workspace switcher (sidebar + `Ctrl+1..9`).

**Explicit non-goal:** no automatic tab classification. Grouping suggestions are Phase 7 and always require approval.

**Verify:** create Work (isolated) and Personal (shared); sign into the same site in each and confirm independent sessions; move a tab between them and confirm the warning fires and the reload happens; delete a workspace and confirm its tabs are offered for relocation rather than silently destroyed.

---

## Phase 3 — Adaptive performance engine

**Goal:** measurable RAM reduction with zero surprise data loss.

Four modules, matching the brief:

- **`ResourceSampler`** — polls `app.getAppMetrics()` on an interval (default 5 s, backing off when idle), joins to tabs via `getOSProcessId()`, and marks any sample whose PID serves >1 tab as `shared: true`. *(Rust migration candidate.)*
- **`TabPerformanceManager`** — owns the state machine `ACTIVE → RECENT → BACKGROUND → IDLE → FROZEN → HIBERNATED`, plus `PROTECTED` as an orthogonal user-set flag. Implements `monitor / getResourceUsage / calculatePriority / freeze / hibernate / restore / protect`.
- **`ResourcePolicyEngine`** — evaluates user-editable policies (thresholds, timings, aggressiveness presets Off/Balanced/Aggressive). All timings are config, never constants in the state machine.
- **`OptimizationRecommendationEngine`** — surfaces suggestions ("12 tabs idle >2h, ~1.4 GB estimated") that the user applies manually.

**Hard never-hibernate guards, enforced in one place and unit-tested:** active tab · audible or playing video · active download in that tab · `PROTECTED` / "Never Sleep" · has a `beforeunload` handler · has unsaved form input (detected by `content.ts`) · devtools open · workspace pinned-and-protected.

Hibernation records RSS before destroying the view and reports it as **measured**; freeze savings render with an **"estimate"** tag. The `PerformanceDashboard` is a route the user opens — never a permanent chrome element.

**Verify:** unit-test the state machine and every guard with fake clock + metrics; play a YouTube tab, leave it 30 min, confirm it never sleeps; leave a static article idle past threshold, confirm hibernation, confirm placeholder, confirm click restores it at the same scroll position and back/forward history; watch Task Manager renderer count actually drop.

---

## Phase 4 — Permission intelligence

**Goal:** permissions that are legible and time-bounded.

`PermissionManager` sits behind `setPermissionRequestHandler` (async grants), `setPermissionCheckHandler` (sync checks — must answer from the store without prompting), `setDevicePermissionHandler`, and `setDisplayMediaRequestHandler`, installed on **every** session. Policies: `ALLOW_ONCE · ALLOW_FOR_TAB · ALLOW_FOR_SESSION · ALLOW_UNTIL_TIME · ALWAYS_ALLOW · BLOCK · ALWAYS_BLOCK`.

Grants persist to SQLite keyed by `(partition, origin, permission)` with `expiresAt` and `scope`; an expiry sweeper revokes on schedule. Every request/grant/denial/expiry/revocation appends to an immutable `permission_events` log.

The prompt is rendered in the **overlay view** anchored to the requesting tab, showing origin, permission, plain-language consequence, duration selector, and a revoke path. Copy describes *what access enables*, never the site's motive. A Permissions dashboard lists all grants with countdowns and one-click revoke (plus "revoke & reload" where mid-flight revocation is unreliable). Autoplay is handled separately via `autoplayPolicy` + mute, and the UI states that changing it needs a reload.

**Verify:** grant camera `ALLOW_FOR_TAB`, confirm a second tab on the same origin still prompts; grant `ALLOW_UNTIL_TIME` 1 min and watch it expire and re-prompt; confirm an isolated workspace's grants don't leak to the shared session; confirm `navigator.permissions.query()` matches the dashboard.

---

## Phase 5 — Web memory engine

**Goal:** find the page you can describe but can't name. **Consent-gated end to end.**

The pipeline is **gated before extraction, not after**: `Page visit → indexing enabled? → private window? → origin excluded? → extract via Readability in the isolated world (content.ts) → strip cookies/query secrets/form values → store → FTS5 index → [opt-in] embed → sqlite-vec`.

**Settings the user owns:** index history on/off · index page *content* on/off (separate, defaults off) · retention window · excluded-origin list · exclude private browsing (default on) · "Delete everything indexed" · per-page "Forget this page".

**Search** — `SearchProvider` interface with two implementations. `KeywordProvider` (FTS5 + BM25) ships first and always works, spanning open tabs, history, bookmarks, downloads, saved pages, workspace metadata and notes. `SemanticProvider` is the opt-in local layer: `@huggingface/transformers` running MiniLM in an Electron **utility process** (never the main process — it must not block the UI), vectors in `sqlite-vec`, results fused with keyword hits via reciprocal-rank fusion. *(Rust migration candidate.)* First enable downloads the model once, with a visible progress and size disclosure.

Every result renders **why it matched** — matched terms, semantic similarity, visit time, source. Natural-language time expressions ("last Tuesday", "last month") are parsed deterministically in TS, not by an LLM, so this works with AI off.

**Verify:** with content indexing off, confirm the `pages_content` table stays empty; add an excluded origin and confirm nothing is written; index ~500 pages and confirm keyword search returns <100 ms; enable semantic and confirm a paraphrased query finds the right article; confirm private-window visits never appear; confirm "delete everything" leaves no rows and no vector index.

---

## Phase 6 — Time machine

**Goal:** get yesterday's work back, with truthful expectations.

`SessionSnapshotManager` writes automatic snapshots (interval + on workspace switch + on clean quit) and manual named restore points. A snapshot stores `{id, timestamp, label, workspaceId, tabs: [{url, title, favicon, order, pinned, scrollY, navigationHistory}]}` — using `webContents.navigationHistory` so **back/forward history is genuinely restored**, not just the final URL. Storage is deduplicated (URL/title strings interned) and retention-capped.

Timeline UI grouped Today / Yesterday / This week / Older, with diff-against-now, restore-whole-workspace, restore-single-tab, restore-into-new-workspace, delete, and retention config. A permanent, plainly-worded note states that snapshots restore **pages and navigation history, not logged-in application state** — an expired login will land on a sign-in page.

**Verify:** snapshot 15 tabs across 2 workspaces, quit, restore, confirm order/pinning/scroll/back-button all survive; restore a single tab into a different workspace; confirm retention prunes on schedule; confirm crash recovery offers the last snapshot on next launch.

---

## Phase 7 — AI action engine (optional, off by default)

**Goal:** an assistant that *does* things — and never without a preview you approved.

`LLMProvider` interface with `AnthropicProvider` (BYOK, default `claude-sonnet-5` for planning; `claude-opus-5` selectable) and `OpenAICompatibleProvider` (Ollama / LM Studio). AI is **entirely disabled** until a provider is configured; every AI surface disappears rather than nagging.

Discriminated-union action type, each variant carrying its own preview shape:

```ts
type BrowserAction =
  | { kind: 'organize-tabs';    groups: { name: string; tabIds: string[] }[] }
  | { kind: 'create-workspace'; name: string; icon: string; tabIds: string[] }
  | { kind: 'move-tabs';        tabIds: string[]; toWorkspaceId: string }
  | { kind: 'close-tabs';       tabIds: string[]; reason: string }
  | { kind: 'save-tabs';        tabIds: string[]; toBookmarkFolder: string }
  | { kind: 'search-memory';    query: string }
  | { kind: 'summarize-pages';  tabIds: string[] }
  | { kind: 'reading-queue';    tabIds: string[]; order: string[] }
```

`ActionExecutor` is an **allowlist switch** over `kind` — it can reach no browser capability that isn't an enumerated variant, so the model cannot invent an action. The prohibited list (send messages, purchases, form submission, password changes, security settings, granting permissions, deleting data) is structurally unreachable, not merely discouraged. The pipeline is `UNDERSTAND → PLAN → PREVIEW → APPROVE → EXECUTE → REPORT`, every execution is undoable where the underlying operation allows, and every run appends to an AI activity log.

**Privacy, enforced in code:** a `ContextBuilder` is the single path by which data reaches a provider. It sends tab titles and URLs only; page *content* requires a separate explicit opt-in per request, shows a "what will be sent" preview, and honours the Phase 5 exclusion list. Nothing is ever sent silently.

**Verify:** with no key configured, confirm zero AI UI and zero network calls; ask "organise my tabs", confirm a preview appears and Cancel changes nothing; approve and confirm the result matches the preview exactly; confirm undo; hand-craft a malformed/hostile action payload and confirm the executor rejects it; inspect the outbound request body and confirm no page content unless separately approved.

---

## Verification strategy (all phases)

- **Unit (Vitest)** — `UrlResolver`, policy evaluation, the tab state machine + every never-hibernate guard, permission scope/expiry resolution, FTS query building, snapshot diffing, action-payload validation. These are pure functions by design so they test without Electron.
- **IPC contract tests** — every channel's zod schema round-trips; every handler rejects a non-allowlisted sender.
- **E2E (Playwright + `_electron`)** — launch the real app: open/close/restore tabs, switch workspaces, trigger hibernation with a fake clock, drive a permission prompt, run a search, restore a snapshot.
- **Security checklist per phase** — from a page console confirm `require`, `process`, and `window.browser` are all `undefined`; confirm the chrome view cannot be navigated away by page script; confirm every new session gets `SessionHardening`.
- **Manual scripts** — `docs/testing/phase-N.md`, kept current so each phase re-runs earlier phases' scripts as regression checks.

## Sequencing note

Build in phase order. Phase 0's two spikes come first because both the overlay-stacking approach and the native-module packaging path are expensive to change once features depend on them. Do not start Phase 7 until Phases 1–3 are stable — a browser that loses tabs is not improved by an assistant.

## First implementation step on approval

Phase 0: scaffold the project, `git init`, wire `electron-vite` with the three entry points and strict TypeScript, stand up `AppContext` + `Database` + the IPC registry, and run both spikes — reporting the transparency result and the packaged-SQLite result before moving to Phase 1.
