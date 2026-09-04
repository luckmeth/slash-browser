# Saved addresses and autofill: test script

Run `passwords.md` first — this feature deliberately reuses that machinery, and the property being
checked is the same one.

## What is stored, and what is not

| | |
|---|---|
| **Addresses** | Stored in `saved_addresses`, in the clear |
| **Passwords** | Stored via `safeStorage` (DPAPI), never returned by any IPC channel |
| **Card numbers** | **Not stored at all** |

The address table is deliberately not encrypted, and that is a position rather than an oversight: an
address is not a credential. It is printed on the parcels arriving at the house and already sits in
the address book of every shop the user has ordered from. Encrypting it needs a key, and the only
place to keep that key is beside the data — which buys the appearance of protection and none of the
substance.

**Cards are absent on purpose.** Storing one means holding a primary account number, a regulated
category of data with obligations this project cannot meet, and the browser has no way to protect it
that a dedicated password manager does not do better. Slash fills addresses and says plainly that it
does not fill cards, rather than half-doing it.

## The property that matters

**`preload/content.ts` never reads a value out of a form field.** It reports which *kinds* of field
a page has — that a "city" box exists somewhere — and holds the element references itself. The main
process never learns what is in any of them.

Filling goes the same way sign-ins do: main sends "focus the city field", then calls
`webContents.insertText`. The value travels Chromium's own input pipeline, the same path a keystroke
takes.

Two alternatives were rejected and should stay rejected:

- `executeJavaScript` would put the user's home address into script source running in the page's own
  world.
- Sending the value to the content preload would hand it to a process running untrusted web content.

### How to verify it

1. Open Settings → Privacy & security → Saved addresses. Add one.
2. Open any checkout or delivery form. Right-click a text field → **Fill address** → pick it.
3. In DevTools on that page, before filling, run:
   ```js
   const original = HTMLInputElement.prototype.value
   ```
   There is nothing to observe — which is the point. The page's own JavaScript sees ordinary input
   events, exactly as if the user had typed.
4. Confirm the entry does **not** appear when right-clicking a field on a page with no address form
   (a search box, a comment box). `addressOffers` returns an empty list unless the page reported
   address fields.

## Field matching

`src/shared/addressFields.ts` is covered by 20 unit tests. Check these by hand on real sites:

| Case | Expected |
|---|---|
| A form using standard `autocomplete` tokens | Every field correct; the token wins over everything |
| `autocomplete="shipping address-line1"` | Street line 1 — the prefix is ignored |
| A form with `name="billing_city"` and no autocomplete | City. Underscores are normalised first; `\b` does not fire beside one |
| A form with both a billing and a delivery block | The **first** of each kind is filled — the one on screen |
| A "Search addresses" box on a checkout page | **Untouched.** `type="search"` is refused outright |
| A password field named `address` | **Untouched** |
| A field the classifier cannot identify | **Left empty.** A field left blank is obvious and fixable; a field filled wrongly on a form about to be submitted often is not |

## Things to check on purpose

- **Sites that reformat as you type** (postcodes, phone numbers). The filler pauses ~35 ms between
  fields; without it, sites that rewrite the value drop characters when the next field is focused.
- **A partial address.** Fields with nothing saved are skipped, not filled with an empty string — a
  form reporting "phone is required" after being autofilled is worse than one never touched.
- **A form that appears after load** (a modal, a route change). The preload rescans on `focusin`, so
  clicking into the form is what makes it available.
- **Deleting an address** while a page holds a fill offer. The context menu is rebuilt per
  right-click, so the deleted entry cannot be chosen.

## Regression checks

- `passwords.md` — the sign-in fill path must still work; both share `CONTENT_COMMAND_CHANNEL`.
- A page with **both** a sign-in form and an address form. The two scanners are independent and both
  should report.
- Confirm `out/preload/content.js` still contains no zod (`grep -c zod out/preload/content.js` → 0).
  The classifier lives in `shared/` with zero imports precisely so this stays true.
