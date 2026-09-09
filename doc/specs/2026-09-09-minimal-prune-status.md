# Minimal prune status

## Contract

User-approved design: show literal `prune: on` when `enabled` and `showPruneStatusLine` are both true; otherwise clear the extension's footer status. No divider, counters, activity, reclaim ratio, or diagnostics.

## Implementation

Keep `setPruneStatusWidget` as the single footer writer. It reads configuration only. Remove the old formatter and footer-only data plumbing. Keep existing refresh sites unless their only purpose was an activity label.

## Boundaries

No defaults or user/installed settings change. Pruning, archival, retrieval, model context, startup messages, notifications, explicit status/stats commands, and Pi Web summary cards remain unchanged. Diagnostic session entries remain available.

## Verification

- Exact enabled label and clearing on disabled/hidden transitions.
- Stable footer through pending work, summarization, reclaim measurements, and diagnostics using existing test seams.
- Full `bun test src/`, project typecheck, and isolated Pi smoke test.
- One primary readiness review; at most one consolidated correction and focused verification pass. Stop for human direction if unresolved after that bound. Prior advisory: one pass plus follow-up; no implementation findings or corrections carried forward.
