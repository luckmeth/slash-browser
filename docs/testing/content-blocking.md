# Content blocking: test script

## What this is, and what it is not

| Claim | True? |
|---|---|
| Blocks ad and tracker **requests** before they leave the machine | Yes |
| Refuses navigation to hosts on a known-malicious list | Yes |
| Per-site off switch, and global switches | Yes |
| Hides ad *placeholders* left behind (cosmetic filtering) | **No** |
| As comprehensive as uBlock Origin | **No** — bundled starter list |
| Scans files for viruses | **No, and a browser cannot** |

That last row is the one that matters. A shield icon invites the assumption that this is antivirus.
It is not: a browser has no ability to inspect a file's contents for malware. What it can do is
refuse to fetch from domains known to serve it, and warn about executable downloads by extension.
Windows Security does the actual scanning, and both the Settings panel and the shield say so.

The malicious list is also **bundled and static**. Malicious domains are registered and burned
within hours, so meaningful coverage needs a continuously updated feed (Safe Browsing or
equivalent). What ships here demonstrates the mechanism; it is not real-world protection, and the
UI states that rather than letting the icon imply otherwise.

## Automated

```bash
npm test
```

Expect 131 tests. `BlocklistEngine` covers the matching rules, including two that are easy to get
wrong:

- **subdomains match** (`stats.g.doubleclick.net` is caught by a rule for `doubleclick.net`) — or
  the list is trivially defeated by a new hostname
- **`notdoubleclick.net` does not match** `doubleclick.net` — only a real subdomain boundary counts
- **first-party requests are never blocked**, so visiting an ad network's own site still works

## Runtime verification

```bash
ADAPTIVE_BLOCK_CAPTURE=/tmp/block.png npm run dev
```

Loads an ordinary page, then has that page request a known tracker, a known ad server, and an
unrelated CDN:

```
blocking probe: tracker=blocked ads=blocked innocent=allowed
blocking probe: PASS — trackers cancelled, unrelated CDN untouched
blocker: refused navigation to known-malicious malware.testing.google.test
```

**Result 2026-08-15: PASS.**

This is deliberately a synthetic test. The first version loaded a news site and counted blocked
requests — it reported zero, and the reason was that the site's consent dialog meant no ads ever
loaded. A test that passes or fails for reasons unrelated to the thing being tested is worse than no
test.

## Manual checks

1. Visit a commercial news site and accept its cookie dialog. The shield shows a non-zero count.
2. Click the shield: it names the count, the per-site switch, and the list sizes.
3. Turn blocking off for that site. The page reloads and the count goes to zero; other sites are
   unaffected.
4. Confirm the site still works — first-party requests are never blocked, so nothing essential
   should break.
5. Visit `https://malware.testing.google.test/testing/malware/`. Navigation is refused.
6. Turn off *Refuse known-malicious sites* in Settings, and confirm the same address now loads.
   The switch has to actually do something.

## Known limitations

- **No cosmetic filtering.** Blocked ads can leave an empty space where the banner was. Removing
  that needs per-site element rules, which this does not have.
- **Same-site detection compares the last two labels**, which is wrong for suffixes like `co.uk` —
  `a.co.uk` and `b.co.uk` read as the same site. The failure is conservative (it blocks less, never
  more), so the worst case is an ad getting through. A Public Suffix List would fix it.
- **No filter-list subscription or updates.** The lists are compiled into the binary.
- **Counts are per WebContents and reset when the tab navigates**, so the shield shows "on this
  page", not a running total.
