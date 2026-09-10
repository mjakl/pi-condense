# Summary concurrency implementation plan

**Goal:** Bound automatic summary work to 2 jobs by default without changing publication or recovery.

**Architecture:** Local index-taking workers inside `summarizeBatches`; the existing extension flush guard prevents overlapping automatic invocations. Keep the whole retry/fallback sequence inside one worker slot. Await settlement of owned workers on rejection.

**Tech stack:** TypeScript, Bun tests, existing Pi 0.85.1 dependencies.

## Tasks

- [x] Verify assigned clean worktree/base and baseline: `bun test src/` (663 pass).
- [ ] Extend `src/summarizer-wiring.test.ts` with gated mock streams: start five batches, assert only indices 0 and 1 start, complete 1 before 0, assert 2 starts, then finish all and assert ordered results and original progress indices. Test configured 1 and 3, pre-abort, abort while another started worker is still settling, thrown UI error, and retry/fallback gates holding one slot. Run `bun test src/summarizer-wiring.test.ts` and confirm concurrency tests fail on the old implementation.
- [ ] Add `summarizerConcurrency: number` to `ContextPruneConfig` and `summarizerConcurrency: 2` to `DEFAULT_CONFIG` in `src/types.ts`. Normalize in `src/config.ts` using `typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_CONFIG.summarizerConcurrency`. Add load/save tests for missing, 1, 3, fractions, zero, sub-one, negative, string, boolean, null, and non-finite JSON values in `src/config.test.ts`.
- [ ] Replace `summarizeBatches` single/all split with `Math.min(config.summarizerConcurrency, batches.length)` async workers. Each checks cancellation before taking `nextIndex++`, awaits `summarizeBatch`, and assigns `results[index]`. Catch errors in workers into a first-error record, stop dispatch, await all workers, then rethrow. Keep original callback indices and totals.
- [ ] Update `index.ts` comments, README, configuration reference and CHANGELOG to document default 2, file-only configuration, serial manual path, retry-slot retention and unchanged publication barrier.
- [ ] Run `bun test src/`, `bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts`, `bun run check:agents-core`, and `git diff --check`. Run an offline isolated Pi CLI fixture and inspect session entry counts and maximum summary concurrency.
- [ ] Remove this ephemeral plan, commit coherent implementation, obtain one read-only primary readiness review (0 consumed at plan creation, no prior findings). Verify and fix only in-scope findings; re-run affected/full checks as needed without extra review loops.
- [ ] Push normally and create ready PR against main. Report PR/head, config behavior, validation, review outcome and supported activation after merge. Do not release, merge, install the extension or alter global settings.
