# Keep recent user turns

`contextPrune.keepRecentUserTurns` is a nonnegative integer, default `0` (disabled).
For `N > 0`, preserve the latest N user interactions, each starting at a user
message and ending immediately before the next user message. The current
interaction counts. If fewer than N user messages exist, protect the entire
available context.

A shared positional boundary excludes the protected suffix from every condense
rewrite and from new summary/dedup/spill/chain-compression work. Pressure and
manual compaction do not override it. As a new user message arrives, older work
becomes eligible through the existing branch rescan; no new persisted state.

This does not undo historical loss and does not control Pi native compaction.
Existing rolling windows, cooldowns, and protection rules still apply to the
eligible prefix. Default zero preserves existing behavior.

Validation covers boundary counting, ordinary summaries, oversized output,
dedup, supersede, failed arguments, chain ranges, and lifecycle aging/reload.
