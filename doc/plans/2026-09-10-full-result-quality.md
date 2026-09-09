# Implementation checklist

- [x] Verify clean assigned worktree and current behavior; commit agreed spec first.
- [x] Remove result truncation; preserve unsupported content; check selected model's estimated input against its context window.
- [x] Restore oversized batches through failure path; require full summary coverage before new chain drops.
- [x] Protect recovery output in capture, stubbing, and new/legacy chain rendering.
- [x] Regression tests, full suite (599 pass), typecheck, isolated smoke; update current docs.
- [ ] Commit implementation, primary review (budget 0/1 primary, 0/1 closure, 0/1 conditional re-review), authorized corrections if needed.
- [ ] Remove ephemeral plan, normal push, ready PR; retain branch/worktree.

Required superpowers brainstorming/writing-plans/using-git-worktrees skills were not available in this installation. The user supplied the approved narrow design and assigned worktree; this spec/checklist records execution without changing that authorization.
