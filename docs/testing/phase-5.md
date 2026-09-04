# Phase 5 — web memory: test script

Run `phase-0.md` through `phase-6.md` first as regression checks.

## What this does

Makes visited pages searchable **by what was on them**, not just their titles — locally, and only
with consent.

Pipeline, with the gate *before* extraction rather than after:

```
page loaded → indexHistory on? → private window? → origin excluded? → http(s)?
            → indexPageContent on? → Readability in the page → FTS5
```

Extracting and then discarding would still have read the whole document into memory and across a
process boundary. For an excluded site that is exactly what the user asked not to happen.

## Two separate consent settings

| Setting | Default | Effect |
|---|---|---|
| `indexHistory` | **off** | URLs and titles become searchable |
| `indexPageContent` | **off** | the page's *text* is stored too |
| `excludedOrigins` | empty | never indexed, at either level |
| `excludePrivateFromMemory` | on | private-window visits stay out |
| `memoryRetentionDays` | 90 | older entries are pruned |

They are separate because they are genuinely different levels of exposure. Both default to off, so a
fresh install indexes nothing at all.

## Automated

```bash
npm run typecheck && npm test && npm run lint
```

Expect 104 tests. The `parseQuery` suite covers the natural-language time handling that makes
"the article I read last Tuesday" work **with AI switched off** — deterministic rules, no model,
never a hallucinated date. It also covers FTS5 escaping: an unescaped apostrophe would otherwise
raise a parse error instead of searching.

## Runtime verification

```bash
ADAPTIVE_MEMORY_CAPTURE=/tmp/memory.png npm run dev
```

Exercises the chain against real pages, and — more importantly — checks the gate in both directions.

```
memory probe: PASS — nothing indexed while the setting is off
memory probe: PASS — history indexed without page text
memory probe: PASS — an excluded origin was not indexed
memory probe: indexed 2 page(s), 1 with full text
memory probe: "relational database transactions" → 1 result(s)
memory probe: PASS — a page was found by its body text
memory probe: time-scoped query → 1 result(s)
```

**Result 2026-08-15: PASS.** The body-text search is the one that proves the feature: those words
appear nowhere in the page's title or URL.

## Manual checks

1. With everything off, browse for a while, then open Browsing Memory (`Ctrl+Shift+F`). It says
   memory is off and explains how to turn it on — it does not look broken.
2. Turn on history indexing only. Titles and URLs become searchable; the stats show
   *0 with full text*.
3. Turn on content indexing. Visit a long article, then search for a phrase from the **middle of the
   body**. It is found.
4. Every result shows **why** it matched — matched terms, title hit, address hit, time window. A
   memory search that cannot explain itself is indistinguishable from a guess.
5. Try `postgres scaling last month`. The panel echoes back the window it understood, so filtered
   results are visible rather than mysterious.
6. Add a site to excluded origins, visit it, and confirm it never appears.
7. *Forget* a single result — it disappears and the count drops.
8. *Delete everything indexed* — the count goes to zero.

## The semantic layer (opt-in)

Keyword search ships first and always works. On top of it, an optional local embedding layer finds
pages by **meaning** — the query "how to make database queries return faster" reaching an article
titled *Database index*, which BM25 cannot do because the two share no term.

How it fits together:

```
enable → sqlite-vec loads → vec0 table created → MiniLM loads in a utility process
       → pages chunked (800 chars, 120 overlap, 10 max) → vectors in memory_vectors
search → FTS5 ranking ⊕ nearest-neighbour ranking, fused by reciprocal rank
```

**The model ships with the browser** (`resources/models/`, ~23 MB) rather than being downloaded on
first use, and `allowRemoteModels` is `false`. Fetching it would have made switching on a *local*
search feature into a request to a third party. Nothing here ever touches the network.

Nothing about it is on the critical path. The model runs in its own process, a search issued while
the model is still loading returns keyword results immediately, and a worker crash disables the
layer without touching the browser.

### Automated probe

```bash
npx electron-vite build
SLASH_SEMANTIC_CAPTURE=semantic.png npx electron .
```

Six checks, in a real Electron process — because the parts that break here are runtime facts that
no unit test can reach: the extension DLL loading under Electron's ABI, ONNX starting in a utility
process, and vec0 accepting better-sqlite3's bindings.

```
semantic probe: PASS — model loaded
semantic probe: PASS — a page was found by meaning, and said so
semantic probe: PASS — the unrelated page did not outrank the right one
semantic probe: PASS — a forgotten page is gone from the vector index
semantic probe: PASS — keyword search unaffected with semantic off
```

**Result 2026-08-16: PASS.** The load-bearing line is the second: keyword search returned **0**
results for that paraphrase and the fused search returned the right page, labelled *close in
meaning*. Model load: 0.5 s, every time — it is read from disk, not fetched.

**Prove it is offline.** Move `resources/models` aside and run the probe again. It must report
*error* with "the files that ship with Slash look missing or damaged", not quietly download a
replacement. **Result 2026-08-16: PASS** — refused, and keyword search kept working.

**Run it against the packaged build too** — `release/win-unpacked/Slash.exe` with the same
environment variable. This is not redundant. The dev build passed while the packaged build failed
with *"the vector extension could not be loaded"*, because `require.resolve` returns a path inside
`app.asar` and `loadExtension` hands that string straight to SQLite, which knows nothing about asar.
Electron's shim covers `require` and `fs`; it does not cover a native library opening a file.
**Result 2026-08-16, packaged: PASS.**

### Manual checks

9. With semantic off, the memory panel says the model already ships with Slash and that it runs
   offline. Nothing about turning it on should suggest a network request, because there is not one.
10. Turn it on. The state goes `loading → reading → on`, and `loading` lasts about a second.
11. While it says *reading*, search anyway. Results arrive immediately from the keyword index, and
    the panel says older pages are still being read rather than pretending the index is complete.
12. Search a paraphrase using **none** of the page's own words. The page is found, and the result
    carries an accent-coloured *close in meaning* chip distinguishing it from a word match.
13. Search something you have never visited. It returns **nothing** — the similarity floor is what
    stops a vector index from always handing back its nearest neighbours however unrelated.
14. *Forget* a semantic result, then repeat the query. It is gone: the vectors went with the page,
    not just the text.
15. Turn semantic off. Keyword search is unchanged. Turn it back on — it is ready immediately, since
    the model and the vectors were kept.
16. *Delete everything indexed* clears pages, passages **and** vectors.

### Known limits

- **Only the opening of a long page is embedded** — ten passages, roughly 8,000 characters. A fact
  buried in the last third of a longread is findable by keyword, not by meaning.
- Similarity is shown as a phrase, not a percentage. MiniLM's scale is nothing like what a percentage
  implies — a genuinely good match often scores under 0.4 — so "39%" beside the top result would read
  as failure when it is not.
- Turning the layer off keeps the stored vectors, so re-enabling is instant. They are page-derived
  data and are removed by *Delete everything indexed*.
- The weights cost every user ~23 MB of installer whether or not they ever switch this on. That is
  the price of the feature never needing the network, and it is the right way round for this
  browser — but it is a real cost paid by people who will not use it.
