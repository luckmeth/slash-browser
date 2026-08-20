# Saved sign-ins

A password vault and autofill, built so that the two ways this feature usually
fails are structurally impossible rather than merely avoided.

Reproduce with:

```bash
npm run build && SLASH_VAULT_PROBE=1 npx electron-vite preview
```

## The two failures worth designing against

**A vault that leaves plaintext somewhere.** Everything else can work perfectly
while the password sits readable in a database file, and the user is worse off
than with no vault at all, because they believe they are safe. So the probe reads
the database file's raw bytes — main file, `-wal` and `-shm`, in UTF-8 and
UTF-16 — and fails if the value appears anywhere. The schema has no column that
could hold a readable password and no "encrypted" flag: a schema that can
represent plaintext is one where plaintext eventually gets written.

**A vault that hands passwords to the interface.** `SavedLogin` has no password
field, `VaultStatus` has nowhere to put one, and no IPC channel returns one. That
is enforced by the *type*, so a future handler cannot start leaking by accident —
there is nowhere to put the value. The probe serialises everything the renderer
can ask for and fails if the secret, or even a password-shaped field name,
appears.

There is deliberately no "reveal password" button. It would require exactly the
channel this design refuses to have.

## How the password reaches the page

Both obvious implementations are wrong for this browser:

- **`executeJavaScript("field.value = '…'")`** puts the password into a string of
  source code run in the page's own world. That is also the mechanism the YouTube
  ad filter uses, which CLAUDE.md records as the **only** main-world execution in
  Slash. Widening it to "and also passwords" is not a change worth making for a
  form fill.
- **Sending the password to the content preload** hands it to a process hosting
  untrusted web content, and puts it on our own IPC surface, for no gain.

Instead:

1. The content preload reports **only** that a password field exists — a boolean.
   It keeps its own references to the fields it found, so no selector and no
   description of the page crosses in either direction.
2. Main asks it to *focus* one of those fields. That command carries no secret.
3. Main calls `webContents.insertText`, so the value travels **Chromium's own
   input pipeline**. The page sees ordinary keystrokes, which is also why
   framework-controlled inputs (React and friends) update correctly.

The password therefore never exists as script source, never as an IPC payload,
and never inside a renderer we control.

The preload's charter is unchanged in the way that matters: it still never reads
what the user typed. `type="password"` is a structural fact about the document;
the value in it is not, and is not read.

## The honest limitation

**Slash cannot capture a password automatically when you sign in.** Doing that
means reading the value out of a password field, which is precisely the thing
`preload/content.ts` is written never to do. Sign-ins are added by hand in
Settings → Saved sign-ins, and Slash types them back for you.

That is a real cost, stated in the interface rather than discovered. The
alternative — a preload that reads sign-in fields on every site — is a much
larger change to what this browser is, and it is not made quietly for
convenience.

Two further limits, both stated in the UI:

- **No secure store, no saving.** If `safeStorage.isEncryptionAvailable()` is
  false, the vault refuses rather than falling back to something readable. The
  settings section says so instead of offering a form that will always fail.
- **A blob encrypted under a different Windows account will not decrypt.** DPAPI
  is keyed to the user. The filler reports that plainly rather than failing
  silently.

## What the probe checks

```
vault probe: PASS — a secure credential store is available
vault probe: PASS — the sign-in was saved
vault probe: scanned 3 database file(s) for the plaintext
vault probe: PASS — the password does not appear in the database bytes
vault probe: PASS — no password in what the renderer is sent
vault probe: PASS — the payload has no password-shaped field at all
vault probe: PASS — the main process decrypts the original value
vault probe: fill result {"user":"someone@example.com","hasPass":true,"fillError":null}
vault probe: PASS — both fields were typed into the page
```

The fill test uses a `data:` URL, so the probe never types a secret into anything
on the network.

## Regression checks

1. Save a sign-in, restart Slash, and fill it — DPAPI must survive a restart.
2. Visit a page with no password field: the toolbar key must not appear at all.
3. Visit a sign-in page for a site with nothing saved: the key appears, and the
   panel says nothing is saved rather than showing an empty list.
4. Fill twice in a row. The second fill must *replace* the field contents, not
   append to them — the preload selects before main inserts.
5. Confirm the fill works on a React-based sign-in form, which is the case that
   breaks naive `value =` assignment.
