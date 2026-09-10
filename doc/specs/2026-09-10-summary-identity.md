# Summary request identity

## Problem

Independent summaries currently omit pi-ai's `sessionId`. Concurrent anonymous Luna requests produced empty or truncated wire streams in a diagnostic sample; a pair with distinct UUID identities succeeded. An affinity collision is plausible, not a proven universal gateway cause. Serializing one Pi process would not isolate parallel agents.

## Decision

Allocate a random UUID once per `runSummarization` invocation and pass it to every `runOnce` attempt as pi-ai's supported `sessionId`. The UUID stays stable through primary retries and the session-model fallback for that job. Each later invocation, including a sticky-fallback job or cooldown probe, gets a new UUID. No identity is persisted or taken from the parent Pi session.

This covers automatic batch workers, serial manual flushes, merged captured batches, and range-summary fusion through the existing shared call path. A later flush retry of retained work is a new invocation and gets a new identity.

Alternatives rejected: a parent/session-wide identity would still group unrelated concurrent jobs; a new identity per attempt would discard useful retry affinity without improving isolation between jobs.

## Boundaries

- Keep default automatic concurrency at 2 and manual progress-driven flushes serial.
- Leave ordering, publication barriers, archival, retry counts/backoff, failure classification, timeouts, reasoning, and fallback transitions unchanged.
- Do not add headers, provider-specific routing, configuration, dependencies, or persistent state.
- Providers own identity interpretation. Providers without support ignore it; cache-retention settings and explicit provider headers can affect the wire representation. Distinct identities do not guarantee gateway reliability or shared cache reuse across summary jobs.

## API evidence

Checked pi-ai 0.85.1 README and shipped `dist/types.d.ts`: `SimpleStreamOptions` extends `StreamOptions`, whose `sessionId` supports caching and routing. `dist/api/simple-options.js` forwards it. The real OpenAI Responses adapter uses it for `prompt_cache_key` and its supported affinity headers. No extension-owned header mapping is needed.

## Acceptance and validation

- Concurrent logical jobs, including identical inputs and separate contexts, have distinct UUIDs at `streamSimple`.
- All attempts within one job retain one identity across retries/fallback; later sticky/probe jobs get new identities.
- An offline request-level test runs the real OpenAI Responses adapter with gated synthetic SSE responses and verifies overlapping requests have distinct supported wire identities.
- Existing suite, strict entry-point typecheck, shared AGENTS check, and primary branch review pass.
- Keep the assigned worktree and deliver a ready PR without merge or installed-extension changes.
