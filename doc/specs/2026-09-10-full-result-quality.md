# Full-result summarization quality

## Contract

Quality takes priority over compression. The summarizer receives the complete captured text, not a 2,000-character prefix. If a batch cannot produce a usable, smaller summary, its originals remain in context and the frontier does not pass that batch. Recovery tool results remain verbatim through later pruning, including chain compression.

## Design

- Remove the serializer's per-result truncation. Keep the existing provider failure and unusable-output handling; do not add retries or arbitrary size cutoffs. Check available model-budget support before implementation.
- Treat oversized summaries as failures, restoring the batch and later batches through the existing failure path.
- Require observed per-batch summary coverage for every unprotected occurrence before authorizing a new chain drop. An archive alone is not summary coverage. This also retains trivial unsummarized outputs instead of reducing them to deterministic metadata. Continue reading historical chain entries.
- Always protect `context_tree_query`, regardless of user protection settings. Reuse verbatim protected-output relocation for chains, including historical chain entries that did not record recovery protection.
- Preserve unsupported non-text tool results rather than summarizing their text portion alone.

## Boundaries

No chunking, retry machinery, policy/timing redesign, instruction classification, benchmarks, installation changes, or merge. The query tool's explicit response-size limit and recovery access remain unchanged. This change preserves the tool output delivered to the main agent; it does not promise lossless LLM summaries or expand query response limits.

## Validation

Regression coverage at the provider-input and extension event seams: late facts reach the summarizer; failed, truncated and oversized summaries retain originals and do not advance the frontier; later automatic/manual chain compression and reload cannot hide unsummarized originals; recovered output survives pruning and chain relocation verbatim. Run the full suite, typecheck, and an isolated extension smoke test before primary branch review.
