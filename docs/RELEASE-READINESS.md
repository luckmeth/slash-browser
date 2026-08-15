# Release readiness

All seven planned phases are built and verified. This document is the honest gap between that and a
browser you could hand to someone who is not you.

Written down because "all the phases are done" and "ready to launch" are different claims, and it
would be easy to let the first quietly imply the second.

## Blockers — do not ship without these

| | Why it blocks | Effort |
|---|---|---|
| **No auto-update channel** | Chromium ships security fixes roughly monthly. A browser that cannot update itself is a knowingly-vulnerable renderer with no path to a patch. This is the most serious item on the page. | Real work: `electron-updater`, a release feed, signed artifacts |
| **No code signing certificate** | Windows SmartScreen shows "unknown publisher" to every installer. Many people stop there, and rightly. | A purchase and an identity check — not a coding task |
| **Nobody has used it** | Every claim in `docs/testing/*` is verified by automated captures and DOM probes. Those catch broken code. They cannot catch "this feels wrong." | Hours of real browsing |
| **No crash reporting** | You would never learn what broke on someone else's machine. | Sentry or Crashpad wiring |

## Should fix before a wider release

- **CSP still allows `'unsafe-inline'` for scripts.** Required by Vite's dev HMR preamble; the
  production build emits no inline scripts, so this should become a nonce in the packaged build.
- **Favicons are fetched directly by the chrome document** (`img-src https:`). It works and matches
  what mainstream browsers do, but fetching them in main and caching as data URLs would remove even
  that contact.
- **The dev capture harness ships in the bundle.** It is environment-gated and inert, but
  `src/main/dev/` should be excluded from production builds.
- **Windows x64 only.** The code is platform-agnostic and `electron-builder.yml` has commented mac
  and Linux blocks, but neither has ever been built. Note the prebuild exclusion list there — adding
  a platform without updating it ships that platform without its SQLite binding.
- **No accessibility pass.** Keyboard navigation and ARIA exist in places but have not been audited,
  and no screen reader has been tried.
- **No E2E suite.** `playwright.config.ts` is referenced in the plan but was never written; all
  end-to-end verification is via the dev harness, which is not a regression net.

## Known functional gaps

These are deliberate and documented in their phase scripts, not oversights:

- **Google will not let you sign in.** Google gates sign-in on `navigator.userAgentData.brands`, which
  identifies the browser vendor and is not settable from Electron — it is filled in by Chromium from
  the embedder's own identity, and Slash is not on Google's approved list. Spoofing the user-agent
  *string* does not help; that is not the value being read. The honest fix, and what is built, is the
  hand-off: a notice on those hosts explaining the refusal, plus a toolbar button and Ctrl+Shift+E to
  open the current page in the default browser. Sites that use "Sign in with Google" as a federated
  login for their own account will hit the same wall.
- **Semantic search is not built.** Keyword FTS5 search is complete and always works. `sqlite-vec` is
  installed and verified loading in Electron, but there is no embedding worker — so paraphrase
  queries ("making Postgres handle more traffic") will not find a page that only says "scaling". The
  panel reports semantic search as *not installed* rather than *off*.
- **AI page summarisation is not built.** It produces text rather than a browser action, so it does
  not fit the preview-and-approve model the engine is built around.
- **Multi-window session restore is partial.** Snapshots are per-database, so restoring puts every
  tab into one window regardless of where they came from.
- **Private browsing does not exist yet.** The Web Memory gate already has the flag and honours it;
  there is simply no private window to set it.
- **`beforeunload` detection is reactive.** There is no API to ask whether a page has registered a
  handler, so a page that has one but has never been asked to unload will not be caught. The
  unsaved-form-input signal is the reliable guard.

## What is genuinely solid

Worth stating too, so the list above is read in proportion:

- 137 tests over the logic whose failure modes are destructive — never-hibernate guards, permission
  scoping and defaults, the AI action allowlist, URL resolution, query parsing.
- Every phase has a manual test script that re-runs earlier phases as regression checks.
- The security posture holds: `contextIsolation`, `sandbox`, `nodeIntegration: false` everywhere
  including our own chrome; a sender-allowlisted, zod-validated IPC surface; a content preload with
  no privileges; and a verified probe showing web content cannot reach `browser`, `require`,
  `process` or `ipcRenderer`.
- Measured, not estimated, memory figures for hibernation — and everything projected is labelled.
