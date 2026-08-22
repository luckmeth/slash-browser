# Slash Operations — the desktop build

The advertising and browser management app as a Windows application, rather than something you keep
a terminal open for.

It embeds **the same Next.js app** that runs at `localhost:3001` — one build, one set of pages, no
second implementation to drift out of step with the first. The Electron shell's entire job is to
hold the database key safely, start the server on a private port, and show it.

## Building it

```bash
cd platform/admin && npm run build     # produces .next/standalone
cd ../admin-desktop && npm run package
```

Two artefacts land in `release/`:

| | |
|---|---|
| `Slash Operations Setup 0.1.0.exe` | Installer. Start-menu entry, choose your own location, uninstaller |
| `Slash Operations 0.1.0.exe` | Portable. One file, run it anywhere, leaves nothing behind but its settings |

About 108 MB each — Chromium and Node, the same as any Electron application.

`npm start` runs it unpackaged, reusing the browser's own Electron rather than downloading a second
copy of it.

## First run

It asks for the database key (below), then -- if no operator exists yet -- offers to create one.
That is deliberate: needing the *public advertiser website* running in a terminal, plus the
Supabase SQL editor, just to make an account for this app was three applications for one task.

The offer disappears once an operator exists, and the action behind it re-checks that at write
time rather than trusting what the page decided when it rendered.

## The key it asks for, and why it is not in the file

On first run it asks for your Supabase **service_role** key.

That key bypasses every row-level security policy in the database. An executable with one baked in
is a file that hands your whole database to anyone who copies it — so it is not in the build, and
`scripts/prepare-server.mjs` refuses to build if a secret ever appears in the public slot.

What you enter is encrypted by Windows through Electron's `safeStorage` (DPAPI) and written to
`%APPDATA%/slash-operations/operations.credentials`. That ties it to the Windows account that
entered it: copy the program to another machine, or run it as a different user, and you get the
setup screen rather than the data.

**What *is* in the build** is the project URL and the anon key. Both are public by design — the anon
key identifies the project and authorises nothing on its own, and what a signed-in person may read
is decided by row-level security on the server, on every request. They also have to be baked in:
Next inlines `NEXT_PUBLIC_` values into the client bundle at build time, so asking for them at
runtime would change nothing about what the pages already contain.

## What it does at startup

1. Reads the encrypted key. Absent or unreadable → the setup screen.
2. Asks the operating system for a free port.
3. Starts the embedded server on **127.0.0.1 only**. Binding to `0.0.0.0` would put an application
   holding a service-role key on the local network, reachable by anything else on it.
4. Waits for it to answer, then loads it.

The window runs with `contextIsolation`, `sandbox` and no Node integration — the same posture the
browser takes with its own chrome. It loads a local server, but "local" is not a reason to hand a
renderer Node. Links to anywhere else open in the real browser rather than inside an app holding a
database key.

## When it will not start

It writes to `%APPDATA%/Slash Operations/operations.log`, including everything the embedded
server printed. A packaged Electron app on Windows is not attached to a console, so without that
file a failure leaves you with one red sentence and nowhere to look.

Two failures worth knowing about, both found by building this:

- **`Cannot find module next`** — the server tree lost its `node_modules`. electron-builder
  strips those from `extraResources` whatever filter you give it, which is why the copy is done
  by `scripts/after-pack.js` instead, and why that script asserts the dependencies arrived
  rather than trusting the copy.
- **A blank window and an empty log** — a syntax error in `main.js`. The app never loaded at
  all. `npm run verify` (part of `npm run package`) parses both scripts first so this cannot
  ship again.

## Signing

Unsigned, like the browser. Windows SmartScreen will warn the first time it runs, and that is the
honest state of things until a certificate exists — see `../../docs/LAUNCH.md`.

## Changing the database it points at

Delete `%APPDATA%/slash-operations/operations.credentials` and restart; the setup screen comes back.
Changing the *project* means rebuilding, because the URL and anon key are compiled in.

## Not included

- **Auto-update.** Same reason as the browser: an unsigned auto-installer is an unauthenticated way
  to put code on a machine. Rebuild and reinstall.
- **macOS and Linux builds.** The config targets Windows only, which is what this project ships.
  Adding them is a target list, not a code change.
