# Preserve distinct protected read evidence

Status: implemented and validated
Supersedes: [protected-path supersession](2026-09-07-protected-path-supersede.md), candidate identity and error handling only.

## Evidence

At `6c2215b`, the isolated Pi 0.85.1 SDK trial captured actual Responses request payloads for an 800-line protected `SKILL.md`:

| History | Extension off | Extension on after cold-cache activation |
|---|---|---|
| Read lines 1-400, then 401-800 | Both page sentinels | Only page two |
| Both pages, then failed reread | Both page sentinels | Neither page |
| Both pages, then one-line partial reread | Both page sentinels | Only page two |

Raw session results were unchanged. Path-only supersession removed distinct instruction evidence from future context.

## Contract and decision

Pi's `read` accepts `path`, optional 1-indexed `offset`, and optional `limit`. Even without pagination arguments, it truncates text at 2,000 lines or 50 KB. Equal paths or arguments do not prove equal output, file stability, or complete coverage. Read results can also contain images.

Only successful protected `read` results with identical text-only `content` arrays and the same normalized path may supersede one another. Compare the complete content, including continuation notices and block boundaries. Other tools, failed results, and nontext results do not participate. Distinct output stays verbatim regardless of offset/limit or apparent coverage.

This retains older changed file versions and overlapping/full-versus-partial reads when their outputs differ. That costs context space but preserves evidence without an interval model, filesystem reads, version tracking, or guesses about truncation. Identical text needs only one verbatim copy; no coverage inference from arguments is necessary.

The existing occurrence pairing, cache-floor activation, branch reconstruction, stub format, and non-destructive render path remain unchanged. No config, persistence format, summarizer, or external-cost changes.

## Acceptance criteria

- Disjoint pages, partial rereads, and same-argument reads with changed output retain every distinct text result.
- A failed later read cannot supersede successful evidence, even if its content matches. Failed earlier evidence also remains outside supersession.
- Identical successful text reads of one protected path can still supersede older copies at existing cache boundaries.
- Protected non-read tools and nontext read results remain untouched by supersession.
- Removing or changing the replacement restores the older result even if its occurrence key was already activated.
- Provider-seam replay preserves both page sentinels with the extension off/on and after failed/partial rereads; no paid calls.
- Existing pairing, occurrence identity, cache cadence, and chain relocation tests remain valid with duplicate-content fixtures.

## Validation

- Before correction: the focused candidate tests reported 27 pass / 10 fail on path-only behavior.
- After correction: 614 native tests pass, including actual Pi read output through Responses serialization; strict TypeScript and shared instruction-core checks pass.
- Isolated Pi 0.85.1 SDK/provider-fetch replay: both page sentinels survive extension off/on, failed reread, and partial reread. Four synthetic requests; no paid calls.
- One focused readiness review found no functional defects or validation gaps. Its stale pruner-comment finding was corrected; no further review cycle.
