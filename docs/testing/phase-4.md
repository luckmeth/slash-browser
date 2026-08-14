# Phase 4 — permission intelligence: test script

Run `phase-0.md` through `phase-3.md` first as regression checks.

## What changed

Before this phase every permission request was refused, which made video calls and maps simply not
work. Requests now reach a real manager with seven policies:

`allow-once` · `allow-for-tab` · `allow-for-session` · `allow-until` · `always-allow` · `block` ·
`always-block`

Only the last three of the *allow* family are written to disk. `allow-once`, `allow-for-tab` and
`allow-for-session` are memory-only on purpose: persisting a deliberately temporary grant would turn
it into a durable one, which is the opposite of what was chosen.

## Automated

```bash
npm run typecheck && npm test && npm run lint
```

Expect 91 tests. The `PermissionManager` suite covers the security-relevant defaults:

- an unrecognised permission maps to `unknown`, never to allowed
- the synchronous `check` never prompts and denies by default — answering optimistically there
  would grant access with no request at all
- a grant does not leak across origins, or across session partitions, so an isolated workspace has
  to ask again
- an `allow-for-tab` grant is never written to disk and dies with its tab
- a pending prompt resolves **denied** when its tab closes, and when the app quits — an unsettled
  promise would hang the page's callback forever
- a UI failure denies rather than silently granting

## Runtime verification

```bash
ADAPTIVE_PERMISSION_CAPTURE=/tmp/perm.png npm run dev
```

Drives a real `navigator.geolocation` call from a real page, so the whole chain runs: Chromium's
handler → PermissionManager → overlay prompt → answer → the page's own callback. Testing the manager
alone would not prove the session handler is wired to it.

```
permission probe: prompt raised for https://example.com (geolocation)
permission probe: prompt text — https://example.com | Know your location | ...
permission probe: PASS — denial reached the page (PERMISSION_DENIED)
```

**Result 2026-08-14: PASS.**

## Manual checks

1. Visit a site that asks for the camera. The prompt names the origin, explains **what the access
   enables** — never what the site intends, which we cannot know — and offers four durations.
2. **"Not now" is the prominent, focused button.** A prompt that nudges toward granting is a dark
   pattern; confirm the allow options are the quieter ones.
3. Choose *While this tab is open*. Open the same site in a second tab — it asks again. Close the
   first tab and revisit — it asks again. Confirm nothing appears in Settings → Permissions, because
   tab-scoped grants are never stored.
4. Choose *Always on this site*, then open Settings → Permissions. It is listed with a Withdraw
   action. Withdraw it and confirm the site asks next time.
5. Choose *For one hour* and confirm the dashboard shows a live countdown.
6. Ask for camera **and** microphone together (most video-call sites do). One prompt covers both, and
   it says so: Chromium hands us a single callback for the pair, so they genuinely cannot be
   answered separately.
7. Grant something in an isolated workspace, then visit the same site in the shared one. It must ask
   again — grants are keyed by partition.
8. Choose *Never*. The site is refused with no prompt on later visits.
9. Open the activity log at the bottom of the dashboard. Every request, grant, denial, expiry and
   revocation is there.

## Known limitations, stated in the UI

- **Revocation is not always immediate.** Chromium caches some grants renderer-side, so a page
  already holding a camera stream keeps it until the document is torn down. The dashboard offers
  *Withdraw & reload* for sensitive permissions rather than forcing a reload, since reloading
  discards page state.
- **Camera and microphone arrive as one `media` permission**, split by a `mediaTypes` array. When a
  page asks for both, they can only be allowed or refused together.
- **Autoplay is not a permission** in Chromium's model. It is a `webPreferences` value fixed at view
  creation plus per-tab mute, which is why changing it needs a reload.
- **WebUSB / WebHID / serial stay denied outright.** They are not in this phase's permission set, and
  a prompt that cannot explain itself is worse than a refusal.
