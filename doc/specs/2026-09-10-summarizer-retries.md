# Summarizer retries and fallback reasoning

## Settled behavior

The authorized followup adds three retries to the initial configured-model attempt: at most four primary attempts, stopping early on success or any nontransient outcome. Only the existing controller-backed, distinct-model fallback path changes. Same-model and no-controller calls retain one attempt.

After four transient primary failures, try the current session model once with provider-default reasoning: omit reasoning options rather than using either the session thinking level or configured summarizer thinking. Primary attempts keep configured reasoning. A failed fallback ends this call with null; existing flush restoration retains pending batches for later triggers, without pausing the session.

Sticky fallback and the three-minute cooldown remain unchanged. Cooldown calls attempt the fallback once. The next eligible call claims one primary probe, not a new four-attempt sequence; concurrent calls continue to use fallback. A transient probe failure gets one fallback attempt.

## Implementation

Keep orchestration in `src/summarizer.ts` and leave `FallbackController` unchanged. Add a bounded loop only around initial primary attempts. Select provider-default reasoning for fallback by reusing the existing `summarizerThinking: "default"` semantics. Check cancellation at each attempt boundary and after asynchronous auth resolution before streaming. Each attempt retains independent idle and ceiling timers.

Do not change failure classification: auth-resolution failures returned as `ok: false` and empty/truncated responses stop without retry or fallback. Existing thrown/provider errors remain transient; caller cancellation propagates. No config, backoff, scheduled jobs, session pause, or cost-channel changes.

## Validation

Cover primary success at attempts 1-4, exhaustion, thrown/provider transient errors, auth and empty/truncated termination, cancellation between attempts and during auth, fallback option omission (including configured off), one-shot cooldown calls, cooldown single probes with concurrent calls, and later-call recovery. Run the full Bun suite, strict project typecheck, agents-core check, and an isolated extension smoke test. Complete one proportionate read-only primary review before pushing a ready PR; no merge, install, or release.
