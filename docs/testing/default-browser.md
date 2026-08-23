# Manual test — default browser

Covers `DefaultBrowserService`, `openTargetFromArgv`, the installer registration in
`build/installer.nsh`, the onboarding step, the start-page card and the Settings group.

**Most of this only works from an installed build**, because the registry entries that make Slash
appear in Windows' list are written by the installer. `npm run dev` can only exercise the argv
handling and the cadence.

## What is actually possible here

Windows has not let an application make itself the default browser since Windows 8. The association
lives in a `UserChoice` key signed against the user and the ProgId; anything written from code is
reverted with no error. So the passing behaviour is: **Slash appears in the Windows list, opens that
list on request, and says clearly that the final click is the user's.**

Any screen implying Slash set the default itself is a failure, not a nicety.

## 0 — The detection must not answer from its own writing

The bug this replaced: Slash registered itself as an `http` handler at startup, which writes
`HKCUSoftwareClasseshttp`, and then asked a question that reads those keys. It answered "yes,
you are the default" on every machine, so the offer never appeared and nothing was logged.

Slash now reads `UserChoiceProgId` — the key Windows itself consults, and the one key nothing an
application runs can write.

1. On a machine where Slash is **not** the default, launch it.
2. Check the log for `http UserChoice is <something>`. **Expect:** the name of your actual browser
   (`ChromeHTML`, `MSEdgeHTM`, `FirefoxURL`…), followed by "Slash is not default".
3. **Must not:** report `SlashHTM` unless you genuinely set it.
4. Confirm from a terminal:

   ```bash
   reg query "HKCUSoftwareMicrosoftWindowsShellAssociationsUrlAssociationshttpUserChoice" /v ProgId
   ```

   Slash's answer must match that value.

## 1 — The installer registers Slash

1. `npm run package`, then install from `release/`.
2. Open Settings → Apps → Default apps.
3. **Expect:** *Slash* is in the list of applications.
4. Open it. **Expect:** entries for `http`, `https`, `.htm` and `.html`.

If Slash is absent, `nsis.include` or `build/installer.nsh` did not run — check
`HKCU\Software\RegisteredApplications` for a `Slash` value.

## 2 — The offer, in the walkthrough

1. Fresh profile (or clear `onboardingCompleted`). Launch.
2. Page through to the **last** step. **Expect:** "Make Slash your default".
3. **Expect** the copy states, *before* any click, that Windows does not let an application make
   itself the default.
4. Press **Open Windows settings**. **Expect:** the Windows Default apps screen opens — on Windows
   11 22H2+ on Slash's own page.
5. Choose Slash for http and https there.
6. Relaunch Slash and reach that step again (fresh profile). **Expect:** it now reads "Slash is
   already your default browser" with no button.

## 3 — Links from other applications open here

This is the part that makes being the default worth anything.

1. With Slash set as default and **running**, click an `https://` link in another application
   (Notepad won't do — use Mail, Slack, or `Win+R` → `https://example.com`).
2. **Expect:** a new tab in the existing Slash window, showing that URL. Not a blank tab, not a
   second window.
3. Close Slash entirely. Click a link again.
4. **Expect:** Slash launches and opens that URL.
5. Double-click a local `.html` file. **Expect:** it opens as a `file://` page.

A blank new tab in either case means `openTargetFromArgv` rejected the argument — check whether the
path or URL shape is one of the cases in `defaultBrowserRules.test.ts`.

## 4 — Argv must not open the wrong thing

1. Run `npm run dev` (Electron is launched as `electron .`).
2. **Expect:** the usual start page. **Must not:** open the project directory as a page.
3. Launch with `--new-private-window`. **Expect:** a private window, and no extra tab.

## 4d — Installing over an existing profile

The commonest real case, and the one that has no walkthrough to fall back on.

1. With a profile that has already completed onboarding, install the new build.
2. Launch and open a **new tab**.
3. **Expect:** the "Make Slash your default browser" card on the start page.

If it is absent, check step 0 — a detection that wrongly reports Slash as default suppresses both
the card and the walkthrough step, and looks identical to the feature not existing.

## 5 — The card on the start page

1. Profile where onboarding is complete and Slash is *not* the default.
2. Open a new tab. **Expect:** the "Make Slash your default browser" card.
3. Press **Not now**. **Expect:** it disappears; new tabs do not show it again today.
4. Set the clock forward more than a fortnight (or edit `defaultBrowserAskedAt`). **Expect:** it
   returns — once.
5. After that second offer, **expect** it never returns.
6. On a fresh profile, press **Don't ask again**. **Expect:** it never returns, immediately.

## 6 — Settings always has the route

1. Settings → Browsing → **Default browser**.
2. **Expect:** an accurate statement of whether Slash is the default, and a button when it is not.
3. **Must not:** be a toggle. A switch here would appear to work and quietly not have.

## 7 — Already default

1. With Slash set as default, open a new tab. **Expect:** no card.
2. Settings shows "Slash is your default browser".

## Regression

`docs/testing/phase-1.md` (launch and single-instance behaviour) and any script covering the
taskbar jump list, which shares the argv path.
