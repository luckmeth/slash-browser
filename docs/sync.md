# Sync

Bookmarks, the reading list and — when switched on separately — history, between a person's own machines.

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

**History syncs only if you turn it on, under its own switch.**

It was previously not synced at all, and the reason given still stands: history is the largest and
most revealing thing the browser holds. So `syncHistory` is separate from `syncEnabled` and off even
when sync is on — turning on bookmark sync must not quietly start uploading browsing history.

Three things had to be solved before it could be offered at all:

| Problem | What would go wrong | What is done |
|---|---|---|
| **Identity** | Reading-list items travel under their own URL. Doing that for history would put every page somebody visited on the server in the clear — the exact thing the encryption exists to prevent. A plain `sha256(url)` is no better: URLs are public and low-entropy, so one precomputed table reverses the lot | The id is an **HMAC-SHA256 under the sync key**. Same URL on your two devices gives the same id because both derived the same key; the server, which never has the key, cannot go from id back to URL at all |
| **Volume** | Bookmarks are hundreds of rows; history is tens of thousands, and every item offered is encrypted on every pass | A 90-day retention window **and** a hard cap of 5,000 entries, both applied before any encryption. Newest first, so being capped costs you the oldest pages rather than random ones |
| **Counters** | Summing `visit_count` across devices inflates it on every sync — the classic distributed-counter bug, and it grows fastest for the pages you visit most, which is exactly what ordering depends on | Visit counts are **local and never synced**. What travels is the URL, title and last visit time; `mergeVisit` takes the later visit and leaves each device's own count alone |

The collection is `history`, and its `id` is the HMAC — so unlike `reading`, the id row in the table
below reveals nothing.

### What leaks

Stated plainly, because a claim of "encrypted" that quietly omits this is not honest:

- **Reading-list ids are URLs in the clear.** The item's identity has to be stable across devices,
  and the URL is the only natural key the table has. The title, favicon and read state are
  encrypted; the address is not. Bookmarks do not have this problem — they travel by random guid,
  and **history ids are HMACs under the sync key**, because the reading-list shortcut would have
  been indefensible applied to every page somebody has visited.
- **How many history entries you have, and when.** The ids reveal nothing, but a server still sees
  a count and a timestamp per entry — so it can tell roughly how much you browse and when, without
  learning any of what you browsed.
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
