import { setTimeout as delay } from "node:timers/promises";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  CapturedBatch,
  ContextPruneConfig,
  SummarizerThinking,
  SummarizeBatchOptions,
  SummarizeBatchesOptions,
  SummarizeOutcome,
} from "./types.js";
import { serializeBatchForSummarizer } from "./batch-capture.js";
import { FallbackController, type FallbackTransition } from "./summarizer-fallback.js";

const SYSTEM_PROMPT = `You are summarizing a batch of tool calls made by an AI coding assistant.
For each tool call provide:
- Tool name and a one-sentence description of what it did
- Key outcome, plus any file paths, identifiers, signatures, or error strings copied verbatim - never reword these
- Any findings the future conversation needs to remember

Keep each tool call to 1-3 bullet points. Skip calls that succeeded with nothing reusable to record. Be concise.

Begin the first bullet of each tool call with that tool's [[N:toolname]] label, copied verbatim (both the number and the name) from its line in the input, as the plain, first thing on the line - no bold, backticks, or list numbering around it. Do not renumber, rename, or invent labels; if you skip a tool, skip its label too.`;

const RANGE_SYSTEM_PROMPT = `You are fusing several per-step summaries of one CLOSED sub-task from an AI coding assistant's history into a SINGLE cohesive summary.
- Merge overlapping or repeated information; do not restate each step separately.
- Preserve concrete outcomes, decisions, file paths, identifiers, and anything later work needs to remember.
- Keep any reference tokens like \`t12\` or \`b3\` intact.
- Be concise: a short narrative or a few grouped bullets, not one bullet per step.`;

export function summarizerThinkingOptions(config: ContextPruneConfig): Pick<SimpleStreamOptions, "reasoning"> {
  const level: SummarizerThinking = config.summarizerThinking;
  if (level === "default") {
    return {};
  }

  // streamSimple translates the level to each provider's effort or token budget.
  return { reasoning: level === "off" ? undefined : level };
}

/**
 * Returns the model to use for summarization.
 * config.summarizerModel === "default" => ctx.model
 * "provider/model-id" => ctx.modelRegistry.find(provider, modelId), fallback to ctx.model with warning
 */
export function resolveModel(config: ContextPruneConfig, ctx: ExtensionContext): any {
  if (config.summarizerModel === "default") {
    return ctx.model;
  }

  const slashIndex = config.summarizerModel.indexOf("/");
  if (slashIndex === -1) {
    ctx.ui.notify(
      `pruner: invalid summarizerModel "${config.summarizerModel}", expected "provider/model-id". Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  const provider = config.summarizerModel.slice(0, slashIndex);
  const modelId = config.summarizerModel.slice(slashIndex + 1);

  const found = ctx.modelRegistry.find(provider, modelId);
  if (!found) {
    ctx.ui.notify(
      `pruner: model "${config.summarizerModel}" not found in registry. Falling back to default model.`,
      "warning"
    );
    return ctx.model;
  }

  return found;
}

function receivedTextChars(message: AssistantMessage): number {
  return message.content.reduce((sum, content) => {
    return content.type === "text" ? sum + content.text.length : sum;
  }, 0);
}

/** A summary is usable only if it has non-whitespace text and was not truncated. */
export function isUsableSummary(llmText: string, stopReason: string): boolean {
  return llmText.trim().length > 0 && stopReason !== "length";
}

/** Human label for a model in notify text: prefer name, fall back to provider/id. */
function modelLabel(model: any): string {
  if (!model) return "unknown model";
  return model.name || `${model.provider}/${model.id}`;
}

/** Combines any present abort signals into one; undefined if none are given. */
function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => !!s);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present); // Node 20+; host runtime is node 24.5.0
}

/**
 * One summarization attempt against a specific model. Returns a classified
 * outcome instead of throwing (except aborts, which propagate so flushPending
 * can restore state). Auth failure is detected pre-stream and never reaches
 * the fallback path. `unusable` = over-budget input, empty or length-truncated
 * text. Everything else that reaches the catch is `transient` (the outage
 * bucket) — pi-ai surfaces no structured status code on the throw, so
 * classification is coarse by design. Never touches the UI: a notify failure
 * inside this try would be misread as a provider outage and retried.
 */
async function runOnce(
  model: any,
  userMessage: string,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions
): Promise<SummarizeOutcome> {
  options.signal?.throwIfAborted();
  const context = {
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: userMessage }], timestamp: Date.now() }],
  };
  // Pi estimates tokens and clamps the output budget itself. Do not truncate
  // input to make it fit; provider rejection or a length stop also retains raw.
  if (model?.contextWindow > 0 && estimateTokens(context.messages[0]) >= model.contextWindow) {
    return { kind: "unusable", message: `input exceeds estimated context window of ${modelLabel(model)}` };
  }
  const idleMs = config.summarizerIdleTimeoutMs;
  const maxMs = config.summarizerMaxTimeoutMs;
  const timeoutController = new AbortController();
  let timedOut = false;
  let timeoutKind: "idle" | "ceiling" | null = null;
  let idleTimerId: ReturnType<typeof setTimeout> | null = null;
  let ceilingTimerId: ReturnType<typeof setTimeout> | null = null;

  const bumpIdle = () => {
    if (idleTimerId !== null) clearTimeout(idleTimerId);
    if (idleMs > 0) {
      idleTimerId = setTimeout(() => {
        timedOut = true;
        timeoutKind = "idle";
        timeoutController.abort();
      }, idleMs);
    }
  };
  const timeoutMessage = () =>
    timeoutKind === "ceiling"
      ? `summarizer ${modelLabel(model)} exceeded ${Math.round(maxMs / 1000)}s ceiling`
      : `summarizer ${modelLabel(model)} stalled (no output for ${Math.round(idleMs / 1000)}s)`;

  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      const authMessage = "error" in auth ? auth.error : "authentication failed";
      return { kind: "auth", message: authMessage };
    }

    // Mirror the main loop (model-runtime stream): auth resolution can carry a
    // seat-specific baseUrl (e.g. GitHub Copilot business/enterprise endpoints).
    // The shipped model data pins the individual host, which 421s other seats,
    // so the resolved auth baseUrl must win over the static model baseUrl.
    const providerAuth = await ctx.modelRegistry.getProviderAuth(model.provider);
    const effectiveModel = providerAuth?.auth.baseUrl
      ? { ...model, baseUrl: providerAuth.auth.baseUrl }
      : model;

    options.signal?.throwIfAborted();

    // Pass the combined signal so the underlying fetch is cancelled immediately
    // either when the user presses Esc, or when an idle/ceiling timeout fires.
    const responseStream = streamSimple(
      effectiveModel,
      context,
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: combineSignals(options.signal, timeoutController.signal),
        ...summarizerThinkingOptions(config),
      }
    );

    // Ceiling arms once at call start; idle arms/resets on every stream event
    // (including before the first one, so it also bounds time-to-first-token).
    if (maxMs > 0) {
      ceilingTimerId = setTimeout(() => {
        timedOut = true;
        timeoutKind ??= "ceiling";
        timeoutController.abort();
      }, maxMs);
    }
    bumpIdle();

    let lastReportedChars = -1;
    options.onTextProgress?.(0);
    const reportTextProgress = (message: AssistantMessage) => {
      const chars = receivedTextChars(message);
      if (chars !== lastReportedChars) {
        lastReportedChars = chars;
        options.onTextProgress?.(chars);
      }
    };

    for await (const event of responseStream) {
      // Reset idle on ANY event (text_* and thinking_*), not just text — a
      // reasoning-heavy model stays alive via thinking_delta and is never
      // false-aborted for being quiet on text while it reasons.
      bumpIdle();
      // Belt-and-suspenders: break early when signal fires mid-stream.
      if (options.signal?.aborted) break;
      if (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end") {
        reportTextProgress(event.partial);
      }
    }

    // If signal fired while we were iterating, propagate the abort so
    // flushPending can detect it and restore batches.
    if (options.signal?.aborted) throw new Error("summarize: aborted during stream");

    const response = await responseStream.result();
    // Charged once per completed response, before any classification: error
    // stops (refusal, mid-stream failure) and unusable text are billed too.
    options.onUsage?.(response.usage);
    reportTextProgress(response);
    // stopReason "aborted" means the provider cut the stream short (e.g. signal
    // fired just before the final chunk). Treat identically to the signal check
    // above — throw so the catch below can detect options.signal.aborted.
    if (response.stopReason === "aborted") {
      throw new Error("summarize: stream stopped with reason aborted");
    }
    if (response.stopReason === "error") {
      if (timedOut) return { kind: "transient", message: timeoutMessage(), timedOut: true };
      return { kind: "transient", message: response.errorMessage ?? "Summarizer stopped with reason: error" };
    }

    const llmText = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    if (!isUsableSummary(llmText, response.stopReason)) {
      return { kind: "unusable", message: "summary was empty or length-truncated" };
    }

    return { kind: "ok", result: { summaryText: llmText, usage: response.usage } };
  } catch (err: any) {
    // Propagate abort errors upward so flushPending can check signal.aborted
    // and return { ok: false, reason: "aborted" } without showing a UI error.
    if (options.signal?.aborted) throw err;
    if (timedOut) return { kind: "transient", message: timeoutMessage(), timedOut: true };
    return { kind: "transient", message: err.message };
  } finally {
    if (idleTimerId !== null) clearTimeout(idleTimerId);
    if (ceilingTimerId !== null) clearTimeout(ceilingTimerId);
  }
}

/**
 * Shared LLM-call machinery for both per-batch and range summarization.
 * `userMessage` already embeds the relevant system prompt as leading text
 * (the summarizer is a single-user-message call). Returns the classified
 * outcome; transient and auth failures are notified here, outside runOnce's
 * provider try, so a stale UI context surfaces as a thrown error at the
 * caller's stale-context boundary rather than as a retryable outage.
 * Abort errors are re-thrown so flushPending can detect
 * options.signal.aborted and restore state without a UI error.
 *
 * When options.controller is set AND a distinct fallback model exists, a
 * initial transient failures get three primary retries, then one session-model
 * attempt with provider-default reasoning. Fallback stays sticky until a
 * single-attempt per-cooldown probe of the primary succeeds.
 */
async function runSummarization(
  userMessage: string,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions
): Promise<SummarizeOutcome> {
  // Fast-fail if already aborted before we even start.
  if (options.signal?.aborted) throw new Error("summarize: aborted before start");

  const primary = resolveModel(config, ctx);
  const controller = options.controller;
  const sessionModel = ctx.model;

  const notifyFailure = (o: { message: string; timedOut?: boolean }) =>
    ctx.ui.notify(
      o.timedOut
        ? `pi-condense: ${o.message}; summarizer call abandoned`
        : `pruner: summarization failed: ${o.message}`,
      o.timedOut ? "warning" : "error",
    );

  // No controller or no distinct fallback: single attempt, legacy behavior.
  if (!controller || !FallbackController.hasDistinctFallback(primary, sessionModel)) {
    const r = await runOnce(primary, userMessage, config, ctx, options);
    if (r.kind === "auth" || r.kind === "transient") notifyFailure(r);
    return r;
  }

  const emit = (t: FallbackTransition) => {
    if (t === "enter") {
      ctx.ui.notify(
        `pi-condense: summarizer model ${modelLabel(primary)} failing, using session model ${modelLabel(sessionModel)} until it recovers`,
        "warning"
      );
    } else if (t === "recover") {
      ctx.ui.notify(`pi-condense: summarizer model ${modelLabel(primary)} recovered`, "info");
    }
  };

  const decision = controller.chooseTarget();
  const fallbackConfig = { ...config, summarizerThinking: "default" as const };
  const model = decision.target === "primary" ? primary : sessionModel;
  let r = await runOnce(model, userMessage, decision.target === "primary" ? config : fallbackConfig, ctx, options);
  // Cooldown probes stay single-shot; only initial primary calls get retries.
  if (decision.target === "primary" && !decision.wasProbe) {
    for (const delayMs of [3000, 9000, 27000]) {
      if (r.kind !== "transient") break;
      await delay(delayMs, undefined, { signal: options.signal });
      r = await runOnce(primary, userMessage, config, ctx, options);
    }
  }

  switch (r.kind) {
    case "ok":
      if (decision.target === "primary") emit(controller.onPrimarySuccess(decision.wasProbe));
      else emit(controller.onFallbackSuccess());
      return r;
    case "auth":
      notifyFailure(r); // auth never trips the controller
      return r;
    case "unusable":
      return r; // deterministic for this input; probe unusable => stay (no state change)
    case "transient": {
      if (decision.target === "fallback") {
        controller.onFallbackOnlyFail();
        notifyFailure(r);
        return r;
      }
      // Primary retries exhausted (or single probe failed): one fallback attempt.
      const r2 = await runOnce(sessionModel, userMessage, fallbackConfig, ctx, options);
      if (r2.kind === "ok") {
        emit(controller.onPrimaryFailFallbackOk(decision.wasProbe));
        return r2; // suppress the legacy error notify — fallback rescued the call
      }
      controller.onBothDown();
      // An unusable fallback text does not make the primary outage terminal.
      const failure = r2.kind === "unusable" ? r : r2;
      notifyFailure(failure);
      return failure;
    }
  }
}

/** Summarizes a captured batch into a classified outcome (see SummarizeOutcome). */
export async function summarizeBatch(
  batch: CapturedBatch,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions = {}
): Promise<SummarizeOutcome> {
  const serialized = serializeBatchForSummarizer(batch);
  const userMessage =
    SYSTEM_PROMPT + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>";
  return runSummarization(userMessage, config, ctx, options);
}

/**
 * Fuses a closed chain's already-computed per-batch summaries into one cohesive
 * range summary (recursive summarization). Input is the span's per-batch summary
 * text — small and already pruned — so this never re-sends raw tool output.
 * Used by chain compression to replace the concatenated per-batch body with a
 * single coherent summary.
 */
export async function summarizeRange(
  perBatchSummaryText: string,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions = {}
): Promise<SummarizeOutcome> {
  const userMessage =
    RANGE_SYSTEM_PROMPT + "\n\n<sub-task-summaries>\n" + perBatchSummaryText + "\n</sub-task-summaries>";
  return runSummarization(userMessage, config, ctx, options);
}

/**
 * Summarizes multiple captured batches — one LLM call per batch, run in parallel.
 *
 * Returns one classified outcome per batch, index-aligned with `batches`.
 *
 * Rationale for parallel-per-batch instead of a single merged call:
 *   • Each batch becomes its own summary message (one per turn), so they can be
 *     rendered, browsed, and recovered independently via context_tree_query.
 *   • Parallel calls give similar end-to-end latency to a single merged call while
 *     keeping the summaries strictly separated.
 */
export async function summarizeBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchesOptions = {}
): Promise<SummarizeOutcome[]> {
  if (batches.length === 0) return [];
  // Single batch — delegate to the single-batch path (no extra overhead)
  if (batches.length === 1) {
    return [
      await summarizeBatch(batches[0], config, ctx, {
        signal: options.signal,
        controller: options.controller,
        onUsage: options.onUsage,
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(0, 1, batches[0], receivedChars);
        },
      }),
    ];
  }

  // Multiple batches — run in parallel; each produces its own SummarizeResult
  return Promise.all(
    batches.map((batch, index) =>
      summarizeBatch(batch, config, ctx, {
        signal: options.signal,
        controller: options.controller,
        onUsage: options.onUsage,
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(index, batches.length, batch, receivedChars);
        },
      })
    )
  );
}
