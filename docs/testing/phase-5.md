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

## What is not built

**The optional semantic layer.** Keyword search is complete and always works, which is what the plan
specified ships first. `sqlite-vec` is installed and verified loading in Electron (v0.1.9), and the
`SearchProvider` seam and result-explanation format already accommodate a `semantic` match reason —
but the local ONNX embedding worker is not implemented.

Consequences, stated plainly:

- **Paraphrase queries do not work.** "The article about making Postgres handle more traffic" will
  not find a page that only ever says "scaling". You have to use words that are actually on the page.
- The Memory panel reports semantic search as **"not installed"** rather than as off, because off
  would imply a switch that exists.

Adding it means `@huggingface/transformers` + `onnxruntime-node` (~300 MB installed) running MiniLM
in a utility process — never the main process, which must not block — with vectors in `sqlite-vec`
and results fused with BM25 by reciprocal-rank fusion.
