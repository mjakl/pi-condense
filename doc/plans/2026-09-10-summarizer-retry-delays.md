# Summarizer retry delays implementation plan

Goal: extend PR #5 with the settled 3s/9s/27s abortable waits before primary retries. Architecture: use Node's `timers/promises.setTimeout` directly in the existing bounded loop; no new configuration or retry abstraction. Sole mutating worker executes inline.

- [x] Verify clean worktree at 08aca742ffa049ea40d814c754797d640ea6b474 and read affected implementation/tests.
- [x] Add deterministic boundary tests in `src/summarizer-wiring.test.ts`: gate each delay and assert request ordering; pin delays to 3000/9000/27000ms; cancel each native timer through its signal; prove no later auth/request; assert no delay for cooldown/probes or early success. New assertions failed before implementation (7 failures).
- [x] In `src/summarizer.ts`, import `setTimeout as delay` from `node:timers/promises`; iterate `[3000, 9000, 27000]`, break on nontransient outcomes, and await `delay(delayMs, undefined, { signal: options.signal })` before each retry. Wiring suite passes (32 tests).
- [x] Update directly affected spec, PRUNING, and changelog. Initial and fallback calls remain immediate; timeout budgets exclude waits.
- [x] Run full suite, strict typecheck, agents-core, and simulated isolated Pi smoke with request timestamps.
- [x] Primary review cycle 2, cumulative previous budget: cycle 1 approved with zero findings. No Claude. Close findings within remaining allowance; do not reset budget or add unbounded review rounds.
- [ ] Remove ephemeral plan, commit, normal push, update existing ready PR #5. No merge/install/release.

Results: 617 tests passed; strict project tsc, agents-core and diff checks passed. Isolated Pi local-provider smoke measured request gaps of 3003/9011/27030ms before primary retries, then 2ms before fallback; primary reasoning high and fallback reasoning omitted. Exhaustion wrote error metrics with one captured and zero processed batches. Cycle 2 approved with no findings or corrections (32 wiring tests independently passed); cumulative two primary reviews consumed. No live provider outage was reproduced. Remaining delivery: commit/push and update existing PR description.
