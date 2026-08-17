<!-- Updated after the feature build-out. -->

## Verified state — 2026-08-17

Measured, not assumed:

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm test` | 406 passing |
| `npm run package` | builds `release/Slash-0.1.0-x64.exe`, 153 MB |
| Installer signature | **NotSigned** (`Get-AuthenticodeSignature`) |
| App executable signature | **NotSigned** |
| `electron-updater` | **not installed** — there is no update channel |

Every feature below the two blockers has been verified in the **packaged** build,
not only in dev, via the `SLASH_*` probes in `src/main/dev/spikeCapture.ts`.

## The two blockers, restated plainly

Neither is a coding task, and no amount of code removes them:

1. **No code-signing certificate.** Every user meets SmartScreen's "unknown
   publisher" wall. Requires purchasing an OV/EV certificate and passing identity
   validation.
2. **No auto-update channel.** Chromium ships security fixes roughly monthly, so
   an un-updatable browser is a knowingly vulnerable renderer. Requires
   `electron-updater`, a hosted release feed, **and** the certificate above —
   unsigned updates are worse than none, because they are an unauthenticated code
   path onto the user's machine.

Until both exist, this build is suitable for the developer's own machine and for
people who are told exactly what they are running. It is not suitable for
distribution to strangers.

# Release readiness

All seven planned phases are built and verified, plus the feature build-out recorded at the top of
this file. This document is the honest gap between that and a
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
- **Semantic search reads only the opening of a long page.** It is built, opt-in and verified in a
  packaged build — a paraphrase sharing no term with the page does reach it. But a page is embedded
  as at most ten passages, roughly the first 8,000 characters, so a fact buried in the last third of
  a longread is findable by keyword and not by meaning. The UI states this rather than implying
  whole-page coverage.
- **Semantic search adds ~61 MB to the installer** (153 MB, up from ~92 MB) whether or not the user
  ever enables it: ~38 MB of ONNX runtime and ~23 MB of model weights. The weights are bundled
  deliberately — downloading them on first enable would have made a local search feature depend on a
  third-party host — but the cost falls on everyone, including people who leave it switched off.
- **AI page summarisation is not built.** It produces text rather than a browser action, so it does
  not fit the preview-and-approve model the engine is built around.
- **Multi-window session restore is partial.** Snapshots are per-database, so restoring puts every
  tab into one window regardless of where they came from.
- ~~Private browsing does not exist yet.~~ **Built** — Ctrl+Shift+N, verified by
  `SLASH_PRIVATE_PROBE`. This bullet claimed otherwise long after it shipped, and the Settings panel
  repeated the claim to users. Check before trusting anything in this section.
- **`beforeunload` detection is reactive.** There is no API to ask whether a page has registered a
  handler, so a page that has one but has never been asked to unload will not be caught. The
  unsaved-form-input signal is the reliable guard.

## What is genuinely solid

Worth stating too, so the list above is read in proportion:

- 406 tests over the logic whose failure modes are destructive — never-hibernate guards, permission
  scoping and defaults, the AI action allowlist, URL resolution, query parsing, and Slash Shield's
  popup and redirect judgements.
- The content preload reads no page content at all. It reports that a trusted gesture happened and
  that an edit occurred, never what was typed, so the script injected into every page — sign-in
  forms included — has no access to leak.
- Every phase has a manual test script that re-runs earlier phases as regression checks.
- The security posture holds: `contextIsolation`, `sandbox`, `nodeIntegration: false` everywhere
  including our own chrome; a sender-allowlisted, zod-validated IPC surface; a content preload with
  no privileges; and a verified probe showing web content cannot reach `browser`, `require`,
  `process` or `ipcRenderer`.
- Measured, not estimated, memory figures for hibernation — and everything projected is labelled.
