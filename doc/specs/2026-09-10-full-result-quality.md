# Full-result summarization quality

## Contract

Quality takes priority over compression. The summarizer receives the complete captured text, not a 2,000-character prefix. If a batch cannot produce a usable, smaller summary, its originals remain in context verbatim. Deterministic rejections (over-budget input, empty or length-truncated output, larger-than-raw summary) advance the frontier and are not retried; transient and auth failures keep the batch pending. Recovery tool results remain verbatim through later pruning, including chain compression.

## Design

- Remove the serializer's per-result truncation. Keep the existing provider failure and unusable-output handling; do not add retries or arbitrary size cutoffs. Use Pi's exported `estimateTokens` on the complete summarizer message against the selected model's `contextWindow`. Pi reserves/clamps output itself; token estimates are not exact.
- Treat oversized summaries like the other deterministic rejections: retain originals verbatim, advance the frontier, and let later batches in the same flush publish. Preserve the outcome kind across the summarizer seam so only transient and auth failures restore the batch and later batches. Remove eager result spilling from capture because its preview-only replacement bypassed summarization entirely. Keep archival spill helpers and historical spill recovery.
- Require observed per-batch summary coverage for every unprotected occurrence before authorizing a new chain drop. An archive alone is not summary coverage. This also retains trivial unsummarized outputs instead of reducing them to deterministic metadata. Continue reading historical chain entries.
- Always protect `context_tree_query`, regardless of user protection settings. Reuse verbatim protected-output relocation for chains, including historical chain entries that did not record recovery protection.
- Preserve unsupported non-text tool results rather than summarizing their text portion alone.
- Charge every completed provider response once, before classification, and persist the stats snapshot once per flush attempt. Keep UI notices outside provider classification.

## Boundaries

No chunking, retry machinery, policy/timing redesign, instruction classification, benchmarks, installation changes, or merge. The query tool's explicit response-size limit and recovery access remain unchanged. This change preserves the tool output delivered to the main agent; it does not promise lossless LLM summaries or expand query response limits.

## Validation

Regression coverage at the provider-input and extension event seams: late facts reach the summarizer; transient failures retain originals and do not advance the frontier; truncated, over-budget and oversized summaries retain originals, advance the frontier, publish later batches and are not re-billed; later automatic/manual chain compression and reload cannot hide unsummarized originals; recovered output survives pruning and chain relocation verbatim. Run the full suite, typecheck, and an isolated extension smoke test before primary branch review.
