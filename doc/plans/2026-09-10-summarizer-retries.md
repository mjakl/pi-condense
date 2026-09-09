# Summarizer retries implementation plan

Goal: implement the settled spec in `doc/specs/2026-09-10-summarizer-retries.md`.
Architecture: keep classified attempts in runOnce, bounded initial retries in runSummarization, and the cooldown controller unchanged. Sole mutating worker executes inline as authorized.
Tech stack: TypeScript, Bun tests, Pi 0.85.1.

- [x] Verify clean isolated branch and baseline: 599 tests and strict typecheck pass. Commit spec first.
- [x] Extend `src/summarizer-wiring.test.ts`: assert four high-effort primary calls then fallback with no own reasoning property; table-test success at 1-4, empty/length/auth stopping, thrown transient exhaustion, cancellation during retry auth and between attempts, cooldown one-shot failures and later success, single concurrent probe. Run `bun test src/summarizer-wiring.test.ts` and confirm new expectations fail.
- [x] In `src/summarizer.ts`, check `options.signal?.throwIfAborted()` at runOnce entry and before stream creation after auth. For fallback, use `{ ...config, summarizerThinking: "default" }`. After initial runOnce, use `for (let retry = 0; retry < 3 && r.kind === "transient"; retry++)` only when `decision.target === "primary" && !decision.wasProbe`. Keep existing switch transitions and one fallback attempt.
- [x] Update `PRUNING.md` and `CHANGELOG.md` for attempt counts, default fallback reasoning, single probes, and per-attempt timeout scope.
- [x] Run full `bun test src/`, project strict tsc command, `bun run check:agents-core`, and isolated Pi smoke. Inspect custom session entries and restored pending behavior.
- [ ] Read-only primary review cycle 1 (zero consumed at start), close findings within budget. Remove this ephemeral plan, commit, normal push and create ready PR against origin/main. Do not merge/install/release.

Validation: new boundary tests first failed (11 failures), then full suite passed (613 tests). Strict tsc and agents-core passed. Isolated Pi local-provider smoke recorded four high-reasoning primary requests, one fallback request with reasoning omitted, error metrics without publication, then a manual flush after reload summarized the retained batch and wrote index/summary/frontier/stats. No live Luna/Astra outage was induced. Primary review cycle 1 approved with no findings; reviewer independently ran 44 summarizer tests. No corrections or further review cycles required. Delivery remains push + ready PR.
