# Bundled models

## `Xenova/all-MiniLM-L6-v2` — sentence embeddings for semantic search

Shipped with the application rather than downloaded on first use. That is a deliberate trade of
~23 MB of installer size against the browser's second principle: **nothing leaves the machine unless
the user turned it on.** A model fetched at runtime would have made enabling a local search feature
into an outbound request to a third party, which is exactly the shape of thing this browser is
supposed to avoid.

Loaded by `src/main/memory/embedding/worker.ts` with `env.allowRemoteModels = false`, so a missing
or corrupt file fails loudly instead of quietly reaching for the network.

| File | Purpose |
|---|---|
| `config.json` | Architecture and pooling configuration |
| `tokenizer.json` | WordPiece vocabulary and merges |
| `tokenizer_config.json` | Truncation and special-token settings |
| `onnx/model_quantized.onnx` | The int8-quantised weights (~23 MB) |

**Provenance:** <https://huggingface.co/Xenova/all-MiniLM-L6-v2>, Apache-2.0. The ONNX conversion is
Xenova's, of `sentence-transformers/all-MiniLM-L6-v2`.

Only the `q8` variant is present. `dtype: 'q8'` in the worker resolves to `onnx/model_quantized.onnx`;
asking for any other dtype would look for a file that is not here and fail.

## Replacing the model

Vectors from two models are not comparable, so this is not a drop-in swap:

1. Update `SEMANTIC_MODEL_ID`, `SEMANTIC_DIMENSIONS` and `SEMANTIC_MODEL_LABEL` in
   `src/shared/types/semantic.ts`.
2. Drop the new files in beside these, under the model id as the directory name.
3. Existing vectors are invalidated automatically — `memory_embedded_pages.model` records which model
   produced each row, and anything from another model is treated as unembedded and redone.
4. `memory_vectors` is declared `FLOAT[384]`. A model of a different width needs that table dropped
   and recreated, not merely repopulated.
