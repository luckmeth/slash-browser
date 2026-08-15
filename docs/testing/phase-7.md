# Phase 7 — AI action engine: test script

Run `phase-0.md` through `phase-6.md` first as regression checks.

## The safety property

`BrowserAction` is a discriminated union of exactly six variants, and
`ActionExecutor` is an exhaustive switch over it. **The prohibited capabilities are unrepresentable,
not merely discouraged.** There is no `send-message`, `purchase`, `submit-form`, `change-setting`,
`grant-permission`, `delete-history`, `navigate` or `run-script` variant — so a model asking for one
produces JSON that fails zod parsing and never reaches the executor.

This is asserted directly by `actionSchema.test.ts`, which feeds each forbidden payload in and
requires it to be rejected. That test failing is a release blocker.

Every allowed action is also reversible or non-destructive:

| Action | Reversal |
|---|---|
| organize-tabs / create-workspace | tabs moved back, created workspace deleted |
| move-tabs | moved back to their original workspaces |
| close-tabs | already on the reopen stack (`Ctrl+Shift+T`) |
| save-tabs | the created bookmark folder is deleted |
| reading-queue | reordering only; nothing is lost |

Two things the executor refuses even when asked:

- **Moving tabs into an isolated workspace.** It has its own cookie partition, so the move would
  sign every tab out. The manual path warns about this explicitly; the AI simply may not cause it.
- **Creating an isolated workspace.** Same reason — it must not be a side effect.

## Privacy

`ContextBuilder` is the single path by which anything reaches a provider, and it builds both the
payload and the disclosure shown to the user, so the two cannot drift apart.

By default it sends **site names and page titles only** — never full URLs, since a path or query can
itself be a token or an order id. Page text requires the standing `aiMayReadPageContent` setting
**and** a per-request opt-in. Origins excluded from Web Memory are dropped here too, and the preview
admits that something was withheld rather than hiding it.

The panel shows "what gets sent" *before* anything is sent, not after.

## Automated

```bash
npm run typecheck && npm test && npm run lint
```

Expect 121 tests.

## Manual checks — with AI off (the default)

1. Open the Assistant panel (`Ctrl+Shift+A`). It offers setup and nothing else, and states plainly
   that the browser works fully without it.
2. Confirm **no network requests are made**. Nothing is contacted until a provider is configured.
3. Every other feature in the browser works exactly as before. This is the point of the whole
   design: AI is a bolt-on, not a dependency.

## Manual checks — with a provider configured

Either paste an Anthropic key, or point the OpenAI-compatible adapter at a local Ollama server — in
which case nothing leaves the machine at all.

4. Open ten or so tabs across a few topics and ask *"organise my tabs"*.
5. It reports **what it understood** first. A misreading is visible before anything happens.
6. Expand *what gets sent* and confirm it lists titles and site names, and says no page text.
7. Press **Cancel** — nothing changes. Verify the tab strip is untouched.
8. Ask again and press **Apply**. The result matches the preview exactly.
9. Press **Undo**. The tabs return to their original workspaces and any created workspace is gone.
10. Ask it to do something outside its powers — *"email this page to my boss"*, *"buy this"*,
    *"delete my history"*. It reports that it cannot, and no action is proposed.
11. Add a site to excluded origins, then ask it to organise. That tab is not described at all, and
    the egress preview says one tab was excluded.
12. Set the key with a deliberately wrong value — the error explains the provider rejected it, and
    the key never appears in any log.

## Notes and limitations

- **The API key is encrypted with the OS credential store** (DPAPI on Windows) before it touches the
  database, and is never sent back to the renderer. If the OS has no secure store, the key is
  **refused** rather than written in plain text.
- **A plan is consumed on approval**, so approving twice cannot duplicate the effects.
- **Only the most recent plan can be undone.** There is no undo stack; the panel only offers Undo
  while that is true.
- Tabs may close between proposal and approval. Those are skipped and reported, not treated as
  errors.
- **Summarising pages is not implemented.** It was in the original action list, but it produces text
  rather than a browser action, so it does not fit the preview-and-approve model this engine is
  built around. It would need its own surface.
