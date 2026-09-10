# Summary concurrency

## Outcome

Limit automatic batch summarization to two concurrent jobs per extension session by default. Concurrency is a hypothesis for the reported `upstream_stream_truncated` errors, not an established root cause. The user will monitor real usage; no live provider experiments or background preparation are part of this change.

## Design

Replace the unbounded `Promise.all` in `summarizeBatches` with local workers taking the next batch from an index. `flushPending` already prevents overlapping batch flushes within an extension instance. No global semaphore, durable queue, dependency, UI, or merged batch is needed.

Add config-file-only `contextPrune.summarizerConcurrency`, default `2`. Accept finite numbers >= 1 and floor fractions, following existing numeric normalization. Values below 1 or of the wrong type fall back to 2. There is no arbitrary upper limit; worker count is capped by batch count. Setting 1 serializes automatic batch summarization.

A worker holds its slot until `summarizeBatch` completes, including primary retries, backoff, and fallback. Assign outcomes by input index, not completion order. Preserve the existing all-results publication barrier, ordered frontier processing, usage callbacks, and one summary per batch. Manual progress-driven flushes stay serial; range fusion stays on its existing path after batch processing.

Before taking another batch, check cancellation. A thrown error stops further dispatch; wait for all started workers before rethrowing the first error so the flush guard and accounting remain owned until work settles. Classified failures remain results and do not stop dispatch, preserving current behavior. Do not add cancellation to automatic lifecycle events that currently have none.

## Validation and delivery

Test default and configured concurrency, normalization and persistence, next-slot dispatch, out-of-order completion with ordered results, progress indices, independent invocations, retries/backoff/fallback retaining a slot, abort before dispatch and during running work, and settlement before rejection. Reuse existing integration coverage for ordered publication/frontier, manual processing, accounting, archive recovery, and summary safety.

Run the full Bun suite, strict entry-point typecheck, shared-instructions check, and an isolated offline Pi CLI smoke test. Perform one read-only primary readiness review (initial budget: 0 cycles consumed, no findings); verify any in-scope findings before correcting. No extra review loops, live installation, release, merge, or force push. Push the committed branch and create a ready PR.

Validation on Pi 0.85.1: 691 tests pass; strict entry-point typecheck, agents-core consistency, and diff checks pass. Eight new concurrency regressions failed against the original unbounded implementation before the fix. The offline CLI smoke ran five tool-bearing turns: peak summary concurrency 2, completion order 2/3/4/5/1, publication order 1/2/3/4/5. Session JSONL contains five summary and five index entries, one frontier/stats/flush-metrics entry each, and all five original tool results. Only disposable fixture state was written; no installed extension or global settings changed.
