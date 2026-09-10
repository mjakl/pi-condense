# Summary identity implementation plan

Goal: isolate summary jobs through the existing provider `sessionId` option.
Architecture: a UUID local to `runSummarization`, explicitly passed to private `runOnce`; no public option or persisted field.
Tech stack: TypeScript, node:crypto, Bun tests, pi-ai 0.85.1.

- [x] Add regression tests in `src/summarizer-wiring.test.ts`: gate two identical batch jobs at once, run another context and a range job, assert UUID uniqueness; simulate 4 primary failures then fallback and verify one identity per job including later sticky/probe calls.
- [x] Add a fresh-process offline OpenAI Responses request test in `src/summarizer-provider.test.ts`; gate responses until both requests arrive, assert `session_id`, `x-client-request-id`, and `prompt_cache_key` agree within each request and differ between requests.
- [x] Run `bun test src/summarizer-wiring.test.ts src/summarizer-provider.test.ts`; confirm new identity assertions fail before the fix.
- [x] In `src/summarizer.ts`, import `randomUUID` from `node:crypto`; allocate `const sessionId = randomUUID()` after the initial abort check in `runSummarization`; add required `sessionId: string` to private `runOnce`; forward at every call and in `streamSimple` options.
- [x] Update README, configuration reference, and CHANGELOG with job identity lifetime and provider-dependent semantics, preserving default 2.
- [x] Run focused tests, `bun test src/`, `node scripts/check-agents-core.mjs`, strict entry-point typecheck, and `git diff --check`. Commit code, tests, and docs together.
- [x] Primary review via requesting-code-review: 1 cycle consumed. One P2 finding: subprocess cwd used URL pathname rather than fileURLToPath. Fixed both fixtures in the touched test file; both pass from a checkout path containing a space. No production findings; no additional review cycle required.
- [x] Offline CLI smoke with isolated agent dir and real source produced index, summary, stats, frontier and flush-metrics entries; summary wire UUID differs from chat ID. Initial custom-API fixture lacked compat registration; corrected harness uses the built-in Responses adapter with offline fetch.
- [x] Bounded synthetic live Luna pair from corrected source: exactly 2 overlapping provider requests, maxRetries=0, no controller/fallback, distinct wire IDs, both stop/done, 376 and 357 summary characters. This is a sample, not a gateway-reliability guarantee. Artifacts: `/tmp/pi-condense-summary-identity-ztUlJW/`.
- [ ] Remove this ephemeral plan with `git rm`, commit removal, normal push to origin, create ready PR against main, wait for CI, verify clean worktree and remote head. No merge, no worktree cleanup.
