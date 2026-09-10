# Errors-only notifications implementation plan

**Goal:** Remove routine notifications while preserving failures and explicit command output.

**Architecture:** Delete notification calls at their sources, with no filtering layer. Keep legacy configuration readable but remove its obsolete UI control.

**Tech stack:** TypeScript, Pi 0.85.1, Bun tests.

- [x] Inspect notification paths, installed extension/TUI docs, session format, and engineering taste. Verify clean assigned worktree.
- [x] Update `src/commands.test.ts`, `src/reload-rearm.integration.test.ts`, and `src/summarizer-wiring.test.ts` to assert silent routine outcomes and retained warnings/output. Run focused tests before production edits.
- [x] Delete routine `safeNotify` calls from `index.ts`, recovery notify from `src/summarizer.ts`, and success/no-op notifications from `src/commands.ts`. Keep `status`, `stats`, `help`, and setting-query output. Exclude empty, busy, aborted, and stale-context results from manual failure notification. Remove obsolete quiet-skip UI and update its legacy field documentation.
- [x] Update `PRUNING.md`, `README.md`, and `CHANGELOG.md` with the notification contract.
- [x] Run `bun test src/`, strict entry-point `tsc`, `node scripts/check-agents-core.mjs`, and isolated `pi -e ./index.ts --no-extensions -p` smoke test. Dependencies are symlinked from existing installs; no install is authorized.
- [ ] Remove this ephemeral plan, commit, and run one read-only readiness review (budget 0/1 before review). Verify findings and apply one correction set if needed, rerunning affected validation.
- [ ] Push branch normally and open a ready PR to main. Report review budget, commit, validation, behavior, and PR URL.
