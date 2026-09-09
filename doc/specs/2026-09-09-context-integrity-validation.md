# Context integrity validation and stream diagnosis

## Dependency evidence

Registry checks on 2026-09-09: `npm view <package> version engines --json`.

| Package | Previous dev range | Current dev version | Registry latest |
|---|---|---|---|
| `@earendil-works/pi-ai` | `^0.83.0` | `0.85.1` | `0.85.1` |
| `@earendil-works/pi-coding-agent` | `^0.83.0` | `0.85.1` | `0.85.1` |
| `@earendil-works/pi-tui` | `^0.83.0` | `0.85.1` | `0.85.1` |
| `@sinclair/typebox` | `^0.34.52` | `^0.34.52` (resolved `0.34.52`) | `0.34.52` |

- Pi packages upgraded together; no namespace or TypeBox ecosystem migration.
- Node requirement stays `>=22.19.0`. Validation host: Node `24.21.0`, Bun `1.4.2`.
- Coding-agent peer minimum is now `>=0.84.4`, not `*`. Non-turn message delivery needs the tool-boundary ordering fix shipped in 0.84.4. This is an explicit host compatibility change; older hosts must upgrade. Other peer ranges are unchanged.
- Source: [Pi 0.84.4 release notes](https://github.com/earendil-works/pi/releases/tag/v0.84.4), discovered with Exa and fetched selectively. Installed `AgentSession.sendCustomMessage` queues `triggerTurn: false` messages until tool results are appended, rather than steering another turn.
- Dependencies installed with `npm install --include=dev --ignore-scripts`. No lifecycle scripts, global config changes, or package publication.
- Final `npm audit --json`: zero vulnerabilities. Initial 0.83 installation reported one moderate and two high vulnerabilities.
- No lockfile added: this repository ignores `package-lock.json`. The three development Pi versions are exact pins.

## Regression evidence

| Contract | Evidence |
|---|---|
| Live final-response summaries | Offline actual Pi SDK + Anthropic adapter, compression disabled. Two tool turns per prompt, three prompts across reload; exactly one summary per completed response, no extra main-model turns, one live and persisted copy |
| Mid-run budget summaries | Same SDK fixture, 90% usage and 50% threshold; summary visible in the immediate continuation payload before raw results become stubs. Two summaries per run, including later runs and reload |
| Branch-wide capture indexes | Reverting only the live index fix makes the second budget run produce three cumulative summaries instead of four. Final-response batching alone would conceal this failure |
| Summary snapshot race | Non-turn delivery alone passed final-response tests but failed the immediate budget continuation. Reconciling active persisted summaries in `context` fixes Pi's already-captured request snapshot without re-persisting or starting a turn |
| Partial archive coverage | Real indexer/reload tests cover summarized plus unarchived repeated IDs, complete occurrence recovery, failed archive writes and incomplete extraction |
| Protected images | Chain eligibility and existing persisted-entry render tests retain image-only and mixed text/image outputs |
| Spill collisions | Short colliding sanitized keys recover independent bodies after reload; old unhashed persisted paths still recover |
| Nested defaults | Partial `chainCompression` and `purgeErrors` settings retain sibling defaults and explicit false/zero values |
| Thinking translation | Offline real Anthropic requests: Sonnet 4.5 high -> enabled thinking with 16384-token budget; Sonnet 4.6 high -> adaptive thinking with high effort |
| On/off durability | Real `/pruner off` returned before its settings write completed. Immediate read regression failed for both lifecycle modes; awaiting persistence fixes it. `/pruner on` uses the same awaited path |

Both lifecycle tests failed against the pre-fix `index.ts`. The previous chain/spill/config/provider regressions were also demonstrated red before their corrections. Full-suite failures caused by the old `stream` mock were corrected to intercept `streamSimple`; those were stale test wiring, not provider failures.

## Final validation

- Pi **0.85.1**: `bun test src/` - **592 passed, 0 failed**, 34 files, 1513 assertions.
- Pi **0.84.4**: same complete suite - **592 passed, 0 failed**, same files/assertions. Installed as a temporary coherent Pi group with `--no-save`; restored 0.85.1 afterward.
- Strict extension typecheck passed on both groups:
  ```sh
  bun x tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --allowJs --esModuleInterop --resolveJsonModule --lib es2022 --types node index.ts
  ```
- `node scripts/check-agents-core.mjs` and `git diff --check` passed.
- No separate lint or build command is defined. Pi loads this TypeScript extension directly.
- CLI smoke: local Pi 0.85.1, `-e ./index.ts --no-extensions -p`, explicit offline fixture provider extension, isolated `PI_CODING_AGENT_DIR` and session file inside the checkout, no discovered skills/context files. Completed one tool-bearing response with exactly one each of `context-prune-summary`, `context-prune-index`, `context-prune-frontier`, `context-prune-stats`, and `context-prune-flush-metrics`. Original tool result remained in the JSONL. Temporary fixture/state removed after inspection.
- SDK lifecycle tests additionally exercise `/pruner off`, reopening with the extension absent, native manual compaction, and re-enabling pruning. Compacted summaries are not resurrected by context reconciliation.
- No paid requests, original session inspection/rewrites, installed-extension replacement, or independent readiness review.

## Broken-stream diagnosis: evidence, not attribution

No affected session ID/path or exact error was supplied. The private `codex-lb` provider configuration was not inspected. The names `gpt-6-astra`, `gpt-5.6-luna`, and `gpt-5.6-sol` alone do not establish their API adapter, transport, or backend behavior.

Verified mechanisms:

- With `/pruner off`, the `context` hook returns without transforming messages and future automatic capture/flush hooks are disabled. It does not delete prior custom summary messages, index entries, spill files, or native compaction checkpoints. The recovery tool remains registered.
- Unloading/uninstalling the extension removes its hooks and recovery tool on the next runtime load, but persisted custom messages still participate in Pi context. Neither action is a session repair or an undo of native compaction.
- Pruning transforms request copies. Original message entries remain in the session archive. Native compaction is separate: newer Pi sessions may contain self-contained `retainedTail` checkpoints, so disabling condense does not promise restoration of the entire old transcript to active context.
- Offline actual Responses serialization preserves a signed reasoning item, function-call item ID, and matching call/output ID after condense stub replacement. This tests a synthetic `codex-lb` label, not the user's backend.
- A deliberately malformed stored `thinkingSignature` throws during the actual Responses adapter's JSON parsing both without condense and with a no-op prune. Persistent malformed reasoning is therefore one possible repeat-failure mechanism, not an observed cause in the user's sessions.
- Pi's Responses converter has model-dependent replay handling: same-model `fc_*` item IDs are retained; different-model function-call IDs may be omitted to avoid reasoning-item pairing validation. Provider acceptance of opaque reasoning cannot be proved by a local serializer test.
- Pi's Codex WebSocket adapter can fail with `WebSocket stream closed before response.completed`. HTTP error, malformed replay, incomplete SSE/WebSocket stream, and summarizer timeout are distinct failure classes; "broken stream" does not identify which occurred.
- Pi 0.84.4 release notes document repaired custom-message/tool-result interleaving and repeated OpenAI-compatible thinking-signature serialization. These are relevant upstream mechanisms, not proof that either caused the reported failures.

Evidence still needed: one explicitly authorized affected session path/ID, exact error text, Pi version, and effective provider API/transport. Inspect only that identified session and compare payloads with condense enabled/disabled; do not rewrite it or make broad paid model probes.

## Handoff targets

Independent readiness review has consumed **zero cycles**. Focus it on live summary reconciliation at the active compaction boundary, repeated-ID partial archive coverage, and retained protected content. Adjacent existing limitation: settings controls other than on/off still launch asynchronous `saveConfig` writes without awaiting them; this change does not redesign overlay persistence.

Project map: TypeScript ESM Pi extension; Bun test runner; npm dependency metadata; Node filesystem sidecars; Pi AI summarization; TypeBox tool schemas; Pi TUI command/settings components. Purpose: reduce long-session tool-output context while recovering archived output via `context_tree_query`. Repository-local skill inventory: `.agents/skills/release/SKILL.md` only. Gauntlet overrides live at `.pi/gauntlet-overrides.md`; no sibling code dependency was added and `cost:external` is unchanged.
