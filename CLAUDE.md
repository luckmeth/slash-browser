# Adaptive Browser

A Chromium/Electron desktop browser. The differentiator is not rendering — that is Chromium's job —
but everything around the page: workspace organisation, adaptive tab resource management, granular
permission control, local-first browsing memory, session time travel, and an optional AI action layer
that always previews before it acts.

Full development plan: `docs/PLAN.md`.

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
