# Slash for mobile

Android first. iOS after, and deliberately scoped — see "What iOS cannot be" below.

This is **not** a port of the desktop app. Electron's main process is 61,360 lines of privileged
Chromium API, and no mobile runtime provides any of it. What crosses is Slash's *pure* half:
policy, planning and parsing. What gets rewritten per platform is its I/O half.

## Layout

```
mobile/
  core/            The shared TypeScript core, bundled for the shells
    entry.ts       call(name, argsJson) -> resultJson — the whole surface
    build.mjs      esbuild -> mobile/android/app/src/main/assets/core/slash-core.js
  android/         Gradle project (Kotlin). Phase B.
```

The analysis behind all of this lives in [`src/core/boundary.ts`](../src/core/boundary.ts) and is
enforced by [`src/core/coreBoundary.test.ts`](../src/core/coreBoundary.test.ts).

## The measured core

```bash
npm run core:boundary          # summary + cost model
npm run core:boundary -- --why src/main/downloads/engine/DownloadQueue.ts
```

As of this writing:

| | files | note |
|---|---|---|
| **Portable** | **128 source (19,333 lines) + 66 tests** | runs unchanged on a device |
| Blocked — shim | 50 | `node:path` (31), `node:crypto` (18), `node:os` (1). Pure computation; a few dozen lines each, identical on both platforms |
| Blocked — bridge | 27 | `node:fs`, `node:child_process`, `node:http`. Real I/O; needs a native implementation per platform |
| Blocked — rewrite | 67 | `electron` (64) and the native modules. No shared answer exists |

Those three classes are genuinely different pieces of work, which is why the tool prints them
separately. `node:path` alone gates 31 files — including `DownloadQueue.ts` — so a path shim is the
single cheapest way to widen the core, and it is the first thing Phase B1 should do.

## The core bundle

```bash
npm run core:build     # writes assets/core/slash-core.js
npm run core:check     # CI: verifies the asset exists and exposes SlashCore
```

Output is a single IIFE, **no imports, no module system**, because the engines that must run it agree
on nothing else: a headless WebView (V8) on Android, JavaScriptCore on iOS. The build *fails* rather
than warns if anything unportable reaches the bundle — a core that quietly pulled in `node:path`
would build, ship, and throw on a device at the first call.

Current bundle: **17,029 bytes**, exposing `planSplit`, `remainingBytes`, `checkCoverage`,
`mediaFilename`, `mediaIdentity`, `classifyFailure`, `shieldLists`, `scripts`, `version`. Most of
that is `defaultLists.ts` and the three document-start scripts, which are data and source text
rather than logic — the engine code itself is still about 4 KB.

The asset is **not committed** — it is built from `src/`. Committing it would mean two sources of
truth for the same logic, and the stale one always wins an argument.

## Android

```bash
cd mobile/android
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n dev.slash.browser/.spike.SpikeActivity
adb logcat -s SLASH_ANDROID_SPIKE
```

Versions are pinned to what was already in the local Gradle cache (AGP 8.13.1, Gradle 8.14.3,
Kotlin 2.2.20, androidx.webkit 1.14.0) so a first build is not a twenty-minute download.

`local.properties` is gitignored and must point at your SDK:

```
sdk.dir=C\:/Users/<you>/AppData/Local/Android/Sdk
```

### SLASH_ANDROID_SPIKE — Phase B0

The Android plan rests on four claims. Each is cheap to believe and expensive to be wrong about, so
each is measured rather than assumed:

| # | Claim | If it fails |
|---|---|---|
| 1 | `Profile` isolates cookies per workspace | Workspaces share one cookie jar — say so, or require a newer WebView |
| 2 | `shouldInterceptRequest` can refuse a request | No network ad blocking on WebView; GeckoView instead |
| 3 | A script can run **before** the page's own scripts | The YouTube field strip cannot work; it must win that race |
| 4 | The desktop's pure core runs unmodified and agrees | Phase A is wrong and mobile is a full rewrite |

Every probe reports one of **PASS / FAIL / UNSUPPORTED / INCONCLUSIVE**, and three of those are not
"it works". This is not pedantry — `SLASH_YT_ADS_PROBE` on desktop asked its question once, reported
PASS on a page that showed an advert seconds later, and was believed twice. So:

- **Probe 1** writes a cookie into two profiles and reads *both* back. If neither profile can read
  its own cookie the write failed, and two empty reads look exactly like isolation → INCONCLUSIVE.
- **Probe 2** blocks one subresource and allows another, and requires both observations. Checking
  only that the blocked one failed would pass against a harness where nothing loads at all.
- **Probe 3** runs the page **twice**, with and without injection. A marker seen in the injected run
  proves nothing unless the control run did not see it.
- **Probe 4** asserts exact values, coverage invariant included — not that the core merely ran.

The harness serves every page and subresource from the interceptor itself, so no probe can pass
because the network answered, and a run means the same thing on a disconnected machine.

Emulator note: **use a non-Play-Store system image** (`google_apis`, not `google_apis_playstore`).
Play images enforce adb authorization with an on-screen dialog, and booting one with
`-no-snapshot-load` discards any previous authorization.

## Phase B1 — the browser shell (built)

`mobile/dist/Slash-0.1.0-android-universal.apk` — 11.8 MB, signed, universal (no native code, so
every architecture), minSdk 26, targetSdk 36.

```bash
npm run core:build                       # required first: the asset is gitignored
cd mobile/android && ./gradlew :app:assembleRelease
adb install app/build/outputs/apk/release/app-release.apk
```

What works, verified on Android 15 / WebView 151:

| | |
|---|---|
| Browsing | Tabs, omnibox (URL vs search), back/forward/reload, progress, page titles |
| Workspaces | Personal / Work, each a WebView `Profile` with its own cookie jar |
| Shield | **138 rules from `defaultLists.ts`** — measured blocking 13 ads + 7 trackers on one CNN load |
| Scriptlets | `youtubeAdScript` and `popupDefuserScript` installed at document start, verbatim from `src/` |
| Hibernation | Over `MAX_LIVE_VIEWS`, the least recently used tab is destroyed and its `saveState` kept |
| Error page | Slash's own, because Chromium's cannot say the Shield refused the request |
| Default browser | `VIEW` intent-filter for http/https |

**Where the shield is not shared.** Matching is Kotlin (`ShieldEngine.kt`), not the JS core. It runs
in `shouldInterceptRequest`, once per subresource — 227 times on one CNN load — and routing that
through a JS bridge would be an async hop on the browsing path, which principle 1 forbids. The
*rules* still come from `defaultLists.ts` at startup; only the match is native. Same reasoning that
keeps segment transfer native while planning stays shared.

### Three bugs the device caught that nothing else could

Each passed compilation and would have passed any unit test:

1. **`ProfileStore.getOrCreateProfile` must run on the UI thread.** The code ran it on
   `Dispatchers.Default` with a comment explaining why that was safe.
2. **`SlashCore.destroy()` on a background dispatcher killed the process** — *after* the shield had
   loaded successfully, so it read as the shield being at fault. `destroy()` now hops to Main itself
   rather than trusting callers.
3. **An unbounded `CompletableDeferred` hung startup.** `evaluateJavascript`'s callback never fired
   before `about:blank` finished loading, so `shieldReady` never completed, so the first tab was
   never created — a browser with no tabs and no error explaining why. Every await is now bounded and
   degrades to "blocking is off" rather than to nothing.

### Phase B2 — settings, sync, Coin, adverts

`mobile/dist/Slash-0.5.0-android-universal.apk`. On top of B1:

| | |
|---|---|
| Storage | SQLite mirroring the desktop schema — history, bookmarks, tombstones, coin outbox |
| Panels | Settings, History, Bookmarks, Slash Coin, Advertise |
| Sync | The full `docs/sync.md` protocol, history included, **cross-platform crypto verified on device** |
| Slash Coin | PKCE exchange, keystore-held refresh token, earning clock from the shared core, offline outbox, server-owned balance |
| Adverts | Batched fetch, disk cache, shared `acceptCreative`, aggregated impression/click reporting |
| Session | Restored on launch, written debounced as tabs change |

**Every setting listed does something.** That was checked, not assumed: an earlier build shipped
four shield switches — block ads, block trackers, the YouTube strip, the pop-up defuser — that
rendered themselves and enforced nothing. Turning "Block ads" off changed a boolean while the shield
kept blocking. The audit that found it is one line and worth keeping:

```bash
for k in blockAds blockTrackers restoreTabsOnLaunch syncIntervalMinutes ...; do
  grep -rn "\.$k" app/src/main/java/ --include=*.kt     | grep -v SettingsStore.kt | grep -v panels/SettingsPanel.kt
done
```

A key that appears **only** in `SettingsStore` and `SettingsPanel` is a control with nothing behind
it, which CLAUDE.md counts as an unfinished feature rather than a gap.

### Where the shield's switches are applied

In `SlashWebViewClient`, not in `ShieldEngine`. The matcher's job is to say *what a request is*;
whether that category is blocked today is a setting, and folding the two together would mean
rebuilding the rule sets whenever somebody flipped a switch. Malicious hosts have no switch, and
should not.

### Not built yet

Downloads, media detection and reader. The download engine's *planning* is already in the core and
proven on device (`planSplit`, the coverage invariant); what is missing is its I/O half — a
foreground service, `MediaStore`, and the segment loops.

Coin sign-in and advert delivery are **written but never exercised end to end**: no real Google
account has been through the flow, and no sponsor endpoint has served a batch.

## What iOS cannot be

Recorded here so it is not rediscovered later. App Store Guideline **2.5.6** requires every browsing
app to use WebKit — Chrome, Firefox, Edge and Brave on iOS are all WKWebView skins. The EU DMA
`BrowserEngineKit` entitlement is real but is EU-only distribution with a separate binary and
commitments this project cannot meet.

Consequences, none of which are engineering problems to be solved:

- **No self-update.** `UpdateService`, the feed and `selectPackage` are simply unused; the screen
  says "Update in the App Store."
- **No downloader on the App Store.** Guideline 5.2.3 is why NewPipe and Seal are not on Play or the
  App Store. The engine would work; shipping it is the problem.
- **Weaker blocking.** `WKContentRuleList` is declarative with a rule cap — no per-request decisions.
- **`WKUserScript` does work**, so the YouTube field strip and the popup defuser port to iOS as-is.
- **Workspaces do work** via `WKWebsiteDataStore(forIdentifier:)`, iOS 17+.

Android gets *better* updates than the desktop, because Android signing is a free self-signed
keystore where the desktop has no certificate at all. **Back that keystore up before the first
release**: lose it and no existing install can ever update again.
