# Sync

Bookmarks and the reading list, between a person's own machines.

**Off by default and inert without an endpoint.** A fresh install contacts nothing.

## What the server sees

Nothing readable. Every item is encrypted on the device with AES-256-GCM under a key derived by
scrypt from a passphrase the user chooses. The passphrase never leaves the machine, is not stored,
and no key derived from it is stored either — it is derived on unlock and held in memory only.

So the server holds, per item:

| | |
|---|---|
| `id` | A bookmark's guid, or a reading-list item's URL — **opaque to the server**, but note the second one is a URL. See "What leaks" below. |
| `collection` | `bookmarks` or `reading` |
| `updatedAt` | Unix ms |
| `deleted` | Tombstone flag |
| `payload` | Base64 `iv \| tag \| ciphertext`. Empty for a tombstone |

**History is not synced.** It is the largest and most revealing thing the browser holds, and sending
it anywhere — even encrypted — is a different promise from the one this browser makes.

### What leaks

Stated plainly, because a claim of "encrypted" that quietly omits this is not honest:

- **Reading-list ids are URLs in the clear.** The item's identity has to be stable across devices,
  and the URL is the only natural key the table has. The title, favicon and read state are
  encrypted; the address is not. Bookmarks do not have this problem — they travel by random guid.
- **Item count, timing and sizes are visible.** A server can see how many things you have, roughly
  how large each is, and when you change them.
- **The device id** is a random UUID per installation. It is not derived from anything about the
  machine or the user, but it does let a server count your devices.

## The protocol

Two calls against the configured endpoint. Any server implementing them works; the browser is not
tied to a particular one.

### `GET <endpoint>?since=<cursor>&device=<uuid>`

```json
{
  "cursor": 1755820800000,
  "salt": "8f3c…",
  "verifier": "a91b…",
  "items": [
    {
      "id": "0f8c2e1a-…",
      "collection": "bookmarks",
      "updatedAt": 1755820800000,
      "deleted": false,
      "payload": "base64…"
    }
  ]
}
```

- `since` — return items with `updatedAt` greater than this. `0` means everything.
- `salt` and `verifier` — stored once by the first device and returned to every other, so a second
  device derives **the same key** from the same passphrase. The verifier is what lets it tell a
  wrong passphrase from an empty account; without it a typo looks like a fresh account and the user
  starts a second history that will never merge.
- Anything not matching this shape is ignored wholesale rather than partially applied.

### `POST <endpoint>`

```json
{ "device": "uuid", "salt": "8f3c…", "verifier": "a91b…", "items": [ … ] }
```

Upsert by `(collection, id)`, keeping whichever `updatedAt` is greater. Store `salt`/`verifier` on
first write and **never overwrite them** — doing so would strand every device already using the old
salt.

`Authorization: Bearer <token>` is sent when a token is configured.

## Merge rules

Implemented in `src/main/sync/merge.ts`, and tested there:

- **Last write wins, per item.** Not per collection — merging whole collections means the machine
  that syncs second silently discards every edit the first one made.
- **Deletion is an item, not an absence.** Tombstones carry timestamps and compete on equal terms.
- **Ties go to the deletion**, so every device resolves them the same way. Which one wins matters
  less than all of them agreeing.
- Tombstones are kept 180 days, then pruned. A device offline longer than that will resurrect a few
  deleted items — a better failure than a table that only ever grows.

## Reference server

`platform/advertiser/app/api/sync/route.ts`, backed by Supabase. It is a reference, not a
requirement: the protocol is small enough to implement on anything that can store rows.

## Recovery

There is none. Forget the passphrase and the synced data is unreadable — by the user, by the server
operator, and by us. The settings screen says so before the feature is switched on, rather than
leaving it to be discovered.
