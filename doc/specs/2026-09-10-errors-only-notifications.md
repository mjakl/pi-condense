# Errors-only notifications

## Contract

Remove unsolicited and action-confirmation notifications. Keep notifications for actual failures and actionable problems, including rejected summaries, missing models or credentials, timeouts, invalid command arguments, and fallback activation after a model outage.

Explicit read-only command output remains available through its existing UI: `/pruner status`, `stats`, `help`, and bare setting queries still answer the user. These are requested output, not background alerts. Keep settings dialogs, the tree browser, summary rendering, footer status, and manual-prune progress widgets.

## Design

Delete routine notification calls at their source in `index.ts`, `src/commands.ts`, and `src/summarizer.ts`. Do not introduce notification filtering, settings, replacement messages, or a new output channel. Remove the obsolete quiet-skip setting from the settings UI; retain its serialized field as an inert legacy setting so existing configuration remains readable.

Silent paths: queued batches, automatic budget/delta/frontier-gap flushing, successful chain compression, trivial and dedup skips, model recovery, successful setting changes, manual prune/compact success, empty work, and ordinary cancellation. Preserve automatic processing, metrics, state transitions, and persistence.

Manual flush failure notifications exclude expected `empty`, `already-flushing`, `aborted`, and stale-context lifecycle outcomes. Other failures remain visible. Unknown subcommands use warning severity.

## Validation and review

Add behavioral tests at command handlers and existing integration/fallback seams. Run the full `bun test src/` suite, strict entry-point typecheck, shared-instructions check, and an isolated Pi CLI smoke test. Reuse installed dependencies without installing packages.

Review budget starts at zero. Use one read-only branch readiness review after implementation and validation, verify findings, and apply at most one correction set with tests. No further review loop. Commit and push normally, then open a ready PR to main.
