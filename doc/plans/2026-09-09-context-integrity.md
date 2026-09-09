# Context integrity implementation plan

**Goal:** Correct the seven reported failures and validate compatible dependency updates.
**Architecture:** Preserve session entry contracts; repair delivery, capture identity, archival completeness, protected content, spill naming, nested defaults, and provider translation at their existing boundaries.
**Tech stack:** TypeScript Pi extension, Bun tests, npm dependency metadata.

- [x] Verify checkout and preserve existing work; approved spec is the first commit.
- [x] Read installed Pi README, extension docs, SDK/session/compaction docs and relevant examples/API sources. Registry latest Pi 0.85.1, TypeBox 0.34.52.
- [x] Fix partial-coverage archival and protected images; validate chain/indexer/recovery regressions.
- [x] Fix spill collisions and nested defaults; validate old persisted-path recovery.
- [x] Use provider-independent thinking translation; verify real offline Anthropic budgeted/adaptive requests.
- [x] Fix final and budget delivery plus branch-stable capture. Real SDK regressions cover separate runs, reload, active snapshot reconciliation, and no extra turns.
- [x] Update Pi group to 0.85.1; retain TypeBox. Declare/test coding-agent minimum 0.84.4. Full suite and strict typecheck pass on both groups.
- [x] Diagnose disabling/unloading/native compaction with synthetic sessions only. Fix demonstrated on/off command settings-write race. Test Responses reasoning/call identity without claiming a private backend root cause.
- [x] Full suite: 592 passed, 0 failed. Strict typecheck, instruction consistency, diff check, audit, and isolated offline CLI smoke passed.
- [x] Record durable evidence in doc/specs/2026-09-09-context-integrity-validation.md. Remove this ephemeral plan in the final documentation commit; no independent review, PR, merge, push, or release.
