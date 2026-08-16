# Google sign-in — audit, measurement and outcome

Why Google Account sign-in does not work inside Slash, established by measurement rather than
assumption, and what was changed as a result.

Run the diagnostic yourself:

```bash
npm run build && SLASH_GOOGLE_DIAGNOSTIC=diag.png npx electron-vite preview
```

## Architecture audit

| Question | Finding |
|---|---|
| How tabs are created | `createPageView()` in `src/main/tabs/ViewFactory.ts` — the single audit point |
| Tab surface | **`WebContentsView`**, one per tab, owned by `TabManager` |
| `<webview>` | Not used, and **disabled**: `webviewTag: false` |
| `<iframe>` for page content | Not used. Pages are native views, never nested documents |
| `BrowserView` | Not used (deprecated in Electron) |
| Electron version | **43.4.0** — the latest published release |
| Chromium version | **150.0.7871.224**, measured from the running app |
| Persistent sessions | Yes. Default session plus `persist:ws-<id>` for isolated workspaces |
| Google in a separate partition | No — Google loads in the ordinary browsing session, as it should |
| User-Agent modified | Yes; see below |
| Client Hints modified | No |
| Automation flags | None. `navigator.webdriver` measures `false`; no `--remote-debugging-port`, no `--disable-blink-features` |
| Preload on Google pages | Yes — `preload/content.ts`, on every page |
| Security prefs | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true` |

**The embedded-browser architecture was already correct.** There was no `<webview>` or iframe to
migrate away from, and Electron was already current, so steps 2 and 3 of the brief were no-ops.

## Measurement

Signals as the page sees them, from `runGoogleDiagnostic`:

```json
{
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.224 Safari/537.36",
  "webdriver": false,
  "hasUserAgentData": true,
  "brands": [],
  "platform": "",
  "highEntropy": { "brands": [], "fullVersionList": [], "platform": "", "platformVersion": "" }
}
```

`brands` is **empty**. Not "Chromium without a product name" — empty. Chrome reports
`[{"Chromium","150"}, {"Google Chrome","150"}, {"Not;A=Brand","24"}]` and `platform: "Windows"`.

This is the same metadata that generates the `Sec-CH-UA` request headers, so the absence is visible
both to page script and on the wire.

### The User-Agent string is not the cause

Tested directly by skipping UA handling entirely and re-measuring:

| UA handling | Resulting UA | `brands` |
|---|---|---|
| Normalised | `… Chrome/150.0.7871.224 Safari/537.36` | `[]` |
| Untouched | `… Slash/0.1.0 Chrome/150.0.7871.224 Electron/43.4.0 Safari/537.36` | `[]` |

Identical. Editing the UA string cannot fix this, and any advice to do so is wrong.

### There is no API for it

`node_modules/electron/electron.d.ts` contains `setUserAgent(userAgent, acceptLanguages?)` and **no**
reference to user-agent metadata, brands, or client hints. A command-line switch was tried in an
earlier session and verified to do nothing. Electron does not populate this metadata and exposes no
way to set it.

## Classification

**Electron-specific detection**, caused by absent User-Agent Client Hints metadata — a platform gap,
not a misconfiguration in Slash and not something a browser setting can reach.

It is *not*: a cookie or session problem (the session is persistent and the sign-in page loads and
runs normally), a network or security configuration problem (a request to Google returns 204), a
version-compatibility problem (Chromium 150 is current), or an automation-detection problem
(`webdriver` is false).

## What changed as a result

**The User-Agent now declares Slash.** It previously stripped both `Electron/43.4.0` and
`Slash/0.1.0`, producing a string byte-identical to Chrome's. That was impersonation; it was not
needed for compatibility; and the measurement above proves it never helped. It is now
`… Chrome/150.0.7871.224 Safari/537.36 Slash/0.1.0`. `Electron/43.4.0` stays removed — it names the
toolkit rather than the browser, and sites that sniff for it serve a degraded page.

**The content preload no longer reads what the user types.** It ran on every page — sign-in forms
included — and answered "does this tab hold unsaved work?" by comparing `field.value` to
`field.defaultValue` across every input, password fields included. Only a boolean crossed IPC, but
the capability existed in a script injected into every page. The signal is now the `input` **event**:
that one fired proves the user edited something, and the target's tag and type say whether the edit
was text. No value is read anywhere in the file.

This is also more accurate. Script assigning `element.value` does not fire an `input` event, so a
prefilled form no longer registers as unsaved work.

Verify the guard still fires:

```bash
npm run build && SLASH_UNSAVED_PROBE=1 npx electron-vite preview
```

Expected: `unsaved probe: PASS — flag set by typing, not by a checkbox`. The checkbox step matters —
it proves the predicate is consulted rather than every input event counting as unsaved work.

## Outcome

**Google Account sign-in still does not work inside Slash, and no change in this codebase can make
it work.** The blocker is metadata Electron does not expose.

What was rejected, and stays rejected: UA impersonation, Chrome brand spoofing, `Sec-CH-UA`
falsification, injecting script to redefine `navigator.userAgentData`, automation-marker hiding, and
weakening any Electron security setting.

The shipped answer is the hand-off (`shared/externalHandoff.ts`): on `accounts.google.com` and
`accounts.youtube.com`, a notice explains the refusal and offers one click to open the page in the
default browser. Also on the toolbar and `Ctrl+Shift+E` for any page.

## Manual test procedure

1. Open `accounts.google.com` → the sign-in page loads and renders normally.
2. The Slash Shield-independent hand-off notice appears under the address bar.
3. Enter a Google email, press Next → the password step is refused with **"Couldn't sign you in —
   This browser or app may not be secure."**
4. Click **Open in default browser** → the same URL opens in the system default browser.
5. Complete sign-in there.
6. Back in Slash, open Gmail and Google Drive → these are **not** blocked; only the sign-in flow is.
   They will show signed-out until a session exists in Slash's own cookie store.
7. Restart Slash → cookies persist per the *Restore tabs on startup* and clear-on-exit settings.

Step 3 is the failure to report if this is ever retested. Steps 6–7 confirm the rest of Google works.

## Regression checks

Re-run `docs/testing/phase-1.md` (navigation, session persistence) and `docs/testing/phase-3.md`
(the never-hibernate guards, which depend on the rewritten preload signal).
