# Context integrity corrections

## Approved scope

Fix seven reported correctness failures and update dependencies without changing the supported Pi ecosystem or persisted session formats. Preserve recovery compatibility. No UI redesign, release, PR, or independent readiness review.

## Design

- Deliver automatic summaries to live context and persist each once, without starting a turn. Cover final-response and mid-run budget flushes and reload.
- Archive every missing unprotected occurrence before dropping a chain, including partially summarized chains. Retain occurrence-key identity for repeated tool-call IDs.
- Use branch-stable assistant indexes for both live capture and rescans/frontiers.
- Preserve protected non-text content during chain compression, or leave unsafe chains intact.
- Hash all new spill filenames while continuing to read persisted archive paths.
- Merge nested configuration defaults.
- Translate summarizer thinking through Pi's provider-independent API; verify Anthropic request behavior offline.
- Upgrade compatible dependency groups using registry evidence and installed API sources.

## Validation

Add regressions at behavioral seams; demonstrate failures before fixes where practical. Run the complete Bun suite, strict extension typecheck, and repository instruction consistency check. Exercise the live Pi lifecycle with isolated session state and deterministic/offline provider responses where possible. Inspect analogous data-loss and recovery paths as implementation diligence, not an independent review cycle.

## Constraints

Only this assigned checkout may be changed. Existing persisted session formats and archive paths remain valid. No paid provider call is required to prove thinking translation. Report unavailable validation and consequential compatibility changes explicitly.
