import { CUSTOM_TYPE_CHAIN } from "./types.js";
import type { ChainRange, ChainCompressionEntry, ToolCallRecord } from "./types.js";
import type { ToolCallIndexer } from "./indexer.js";
import type { BlockRefIssuer } from "./block-refs.js";
import type { DiagnosticSink } from "./diagnostics.js";
import { bareToolCallId, occKey, parseOccKey, resultTimestampOf } from "./occurrence-key.js";
import { hasNonTextOutput, resolveRange } from "./chain-range-prune.js";
import { extractToolResultText } from "./batch-capture.js";

/**
 * Grace ids are keyed the same way `recovery-grace.ts` keys them: occurrence
 * (`id@timestamp`) when the recovery message carried a timestamp, bare id
 * otherwise. A chain's middles are compared occurrence-first (exact match on
 * `middleOccurrenceKeys`, falling back to `middleToolCallIds` for chains built
 * before the field existed), so a graced occurrence never defers a chain
 * holding a DIFFERENT occurrence of the same reused provider id. The only
 * bare-to-bare fallback is for grace entries that themselves have no
 * timestamp discriminant — there is no exact key to compare in that case.
 */
function chainMatchesGrace(chain: ChainRange, inGraceToolCallIds: Set<string>): boolean {
  const keys = chain.middleOccurrenceKeys?.length ? chain.middleOccurrenceKeys : chain.middleToolCallIds;
  if (keys.some((k) => inGraceToolCallIds.has(k))) return true;
  for (const g of inGraceToolCallIds) {
    if (parseOccKey(g).resultTimestamp === undefined && keys.some((k) => bareToolCallId(k) === g)) return true;
  }
  return false;
}

/**
 * Pure eligibility filter: given all detected chains, return the subset
 * that should be compressed — closed, not already compressed, and older
 * than the rolling window.
 *
 * Extracted for unit testing without needing a real indexer or appendEntry.
 *
 * @param chains Must be in chronological order (oldest first), as emitted by
 *   chain-detector. Ordering is not validated here; out-of-order input silently
 *   picks wrong chains because the rolling-window slice is positional.
 * @param inGraceToolCallIds Recovery ids still within their grace window. Chains
 *   spanning one of these ids are deferred from compression, but the rolling-window
 *   boundary itself is computed BEFORE grace exclusion, so a grace-protected chain
 *   never shrinks the window buffer or shifts which other chains become eligible.
 */
export function selectEligible(
  chains: ChainRange[],
  rollingWindow: number,
  alreadyCompressed: Set<number>,
  inGraceToolCallIds: Set<string> = new Set(),
): ChainRange[] {
  const candidates = chains.filter(
    (c) =>
      c.finalAssistantTimestamp !== null &&
      !alreadyCompressed.has(c.startUserTimestamp) &&
      c.middleToolCallIds.length > 0,
  );
  const toCompress = candidates.slice(0, Math.max(0, candidates.length - rollingWindow));
  return toCompress.filter((c) => !chainMatchesGrace(c, inGraceToolCallIds));
}

/**
 * The subset of ToolCallIndexer that compressEligible actually uses.
 * Accepting this narrower interface keeps the function testable without a full indexer
 * and documents its real dependency surface.
 */
export interface ChainCompressorIndexerDeps {
  getChainEntries(): import("./types.js").ChainCompressionEntry[];
  hasPerBatchSummaryCoveringAny(toolCallIds: string[]): boolean;
  getPerBatchSummariesForToolCallIds(toolCallIds: string[]): string[];
  getToolRefsForToolCallIds(toolCallIds: string[]): string[];
  registerChain(entry: import("./types.js").ChainCompressionEntry): void;
  getIndex(): Map<string, ToolCallRecord>;
  backfillChainRecords(
    records: ToolCallRecord[],
    opts: {
      spillThreshold: number;
      spillPreviewBytes: number;
      sessionDir: string;
      sessionId: string;
      appendEntry: (customType: string, data?: unknown) => void;
    },
  ): Promise<import("./types.js").SummaryToolCallRef[]>;
}

export interface CompressEligibleDeps {
  indexer: ChainCompressorIndexerDeps;
  blockRefs: BlockRefIssuer;
  /** pi.appendEntry binding — routes to session or runtime depending on caller context */
  appendEntry: (customType: string, data: unknown) => void;
  /** Injectable clock for deterministic tests */
  now: () => number;
  /**
   * Optional range-summary fuser (B). When present, a span with >= 2 per-batch
   * summaries gets one LLM call fusing them into a cohesive `rangeSummaryText`.
   * Returning null (or throwing) is non-fatal: the chain still compresses and
   * the renderer falls back to the per-batch concatenation.
   */
  fuseRange?: (perBatchSummaryText: string) => Promise<string | null>;
  /** MUST be the same withClosingMessage(...) array chain detection ran on - raw branch messages spuriously fail span resolution on the message_end path (see doc/specs/2026-08-14-uncovered-chain-deterministic-backfill.md). */
  messages: any[];
  diagnostics: Pick<DiagnosticSink, "report">;
  backfill: { spillThreshold: number; spillPreviewBytes: number; sessionDir: string; sessionId: string };
}

/**
 * Pure span walk backing archival of every missing occurrence. Excludes
 * protected middles (relocated verbatim at render, never phase-1 stubbed)
 * and already-indexed occurrence keys (retry idempotence).
 */
export function extractChainRecords(
  messages: any[],
  chain: Pick<ChainRange, "startUserTimestamp" | "finalAssistantTimestamp" | "protectedToolCallIds">,
  isIndexed: (occurrenceKey: string) => boolean,
): ToolCallRecord[] {
  const range = resolveRange(chain, messages);
  if (!range) return [];
  const protectedIds = new Set(chain.protectedToolCallIds ?? []);
  const open = new Map<string, { toolName: string; args: unknown }>();
  const records: ToolCallRecord[] = [];
  for (let i = range.startIndex + 1; i < range.endIndex; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "toolCall") open.set(block.id, { toolName: block.name, args: block.input ?? block.args ?? block.arguments ?? {} });
      }
    } else if (msg.role === "toolResult") {
      const call = open.get(msg.toolCallId);
      if (!call) continue;
      open.delete(msg.toolCallId);
      if (protectedIds.has(msg.toolCallId)) continue;
      const resultTimestamp = resultTimestampOf(msg.timestamp);
      if (resultTimestamp === undefined) continue;
      const key = occKey(msg.toolCallId, resultTimestamp);
      if (isIndexed(key)) continue;
      records.push({
        toolCallId: msg.toolCallId,
        toolName: call.toolName,
        args: call.args as Record<string, unknown>,
        resultText: extractToolResultText(msg),
        isError: msg.isError === true,
        turnIndex: -1, // backfilled records have no batch turn; query tool renders "Turn: -1" (pinned)
        timestamp: resultTimestamp,
        resultTimestamp,
      });
    }
  }
  return records;
}

export interface CompressEligibleResult {
  compressedEntries: ChainCompressionEntry[];
  skipped: Array<{ startUserTimestamp: number; reason: "no-summary" | "already-compressed" }>;
}

/**
 * Compresses all chains that are outside the rolling window.
 * Reads existing chain state from the indexer so calls are safe to repeat
 * (already-compressed chains are detected and reported, not double-compressed).
 */
export async function compressEligible(
  chains: ChainRange[],
  rollingWindow: number,
  deps: CompressEligibleDeps,
  inGraceToolCallIds: Set<string> = new Set(),
): Promise<CompressEligibleResult> {
  const alreadyCompressedTimestamps = new Set(
    deps.indexer.getChainEntries().map((e) => e.startUserTimestamp),
  );

  const skipped: CompressEligibleResult["skipped"] = [];

  // Report already-compressed closed chains for observability.
  for (const chain of chains) {
    if (chain.finalAssistantTimestamp !== null && alreadyCompressedTimestamps.has(chain.startUserTimestamp)) {
      skipped.push({ startUserTimestamp: chain.startUserTimestamp, reason: "already-compressed" });
    }
  }

  const eligible = selectEligible(chains, rollingWindow, alreadyCompressedTimestamps, inGraceToolCallIds);

  const compressedEntries: ChainCompressionEntry[] = [];
  for (const chain of eligible) {
    // summaryBodies / toolRefs live in occurrence-key space (src/indexer.ts).
    // Bare ids would match nothing and silently skip every chain.
    const lookupKeys = chain.middleOccurrenceKeys?.length ? chain.middleOccurrenceKeys : chain.middleToolCallIds;

    const range = resolveRange(chain, deps.messages);
    if (!range) {
      deps.diagnostics.report("backfill-empty", String(chain.startUserTimestamp), `middles=${chain.middleToolCallIds.length}`);
      skipped.push({ startUserTimestamp: chain.startUserTimestamp, reason: "no-summary" });
      continue;
    }
    if (hasNonTextOutput(deps.messages, range)) {
      skipped.push({ startUserTimestamp: chain.startUserTimestamp, reason: "no-summary" });
      continue;
    }
    // An archive is not a summary. Failed, unsupported, and trivial outputs
    // must stay verbatim rather than disappearing into a metadata-only chain.
    const protectedForCoverage = new Set(chain.protectedToolCallIds ?? []);
    const uncovered = deps.messages.slice(range.startIndex + 1, range.endIndex).some((msg) =>
      msg.role === "toolResult" && !protectedForCoverage.has(msg.toolCallId) &&
      (msg.content?.some((c: any) => c.type !== "text") ||
        !deps.indexer.hasPerBatchSummaryCoveringAny([occKey(msg.toolCallId, resultTimestampOf(msg.timestamp))])),
    );
    if (uncovered || !deps.indexer.hasPerBatchSummaryCoveringAny(lookupKeys)) {
      skipped.push({ startUserTimestamp: chain.startUserTimestamp, reason: "no-summary" });
      continue;
    }

    // Every occurrence also needs a durable recovery record.
    const index = deps.indexer.getIndex();
    const fresh = extractChainRecords(deps.messages, chain, (k) => index.has(k));
    const freshKeys = new Set(fresh.map((r) => occKey(r.toolCallId, r.resultTimestamp)));
    const isRecoverable = (key: string) => index.has(key) || freshKeys.has(key);
    const protectedIds = new Set(chain.protectedToolCallIds ?? []);
    const missing = deps.messages.slice(range.startIndex + 1, range.endIndex).some((msg) =>
      msg.role === "toolResult" && !protectedIds.has(msg.toolCallId) &&
      (resultTimestampOf(msg.timestamp) === undefined || !isRecoverable(occKey(msg.toolCallId, msg.timestamp))),
    ) || (chain.middleOccurrenceKeys ?? []).some((key) => !protectedIds.has(bareToolCallId(key)) && !isRecoverable(key));
    if (missing) {
      deps.diagnostics.report("backfill-empty", String(chain.startUserTimestamp), "incomplete occurrence archive");
      skipped.push({ startUserTimestamp: chain.startUserTimestamp, reason: "no-summary" });
      continue;
    }
    try {
      if (fresh.length > 0) {
        await deps.indexer.backfillChainRecords(fresh, { ...deps.backfill, appendEntry: deps.appendEntry });
      }
    } catch {
      skipped.push({ startUserTimestamp: chain.startUserTimestamp, reason: "no-summary" });
      continue;
    }

    const blockId = deps.blockRefs.issue();
    const toolRefs = deps.indexer.getToolRefsForToolCallIds(lookupKeys);

    // B: fuse this span's per-batch summaries into one cohesive summary.
    // Gated on >= 2 summaries (nothing to fuse otherwise). Non-fatal.
    let rangeSummaryText: string | undefined;
    if (deps.fuseRange) {
      const summaries = deps.indexer.getPerBatchSummariesForToolCallIds(lookupKeys);
      if (summaries.length >= 2) {
        try {
          const fused = await deps.fuseRange(summaries.join("\n\n"));
          if (fused && fused.trim()) rangeSummaryText = fused;
        } catch {
          // fall back to the per-batch concatenation at render time
        }
      }
    }

    const entry: ChainCompressionEntry = {
      blockId,
      startUserTimestamp: chain.startUserTimestamp,
      droppedToolCallIds: chain.middleToolCallIds,
      finalAssistantTimestamp: chain.finalAssistantTimestamp,
      toolRefs,
      compressedAt: deps.now(),
      ...(rangeSummaryText ? { rangeSummaryText } : {}),
      ...(chain.protectedToolCallIds?.length ? { protectedToolCallIds: chain.protectedToolCallIds } : {}),
      ...(chain.middleOccurrenceKeys?.length ? { droppedOccurrenceKeys: chain.middleOccurrenceKeys } : {}),
    };

    deps.appendEntry(CUSTOM_TYPE_CHAIN, entry);
    deps.indexer.registerChain(entry);
    compressedEntries.push(entry);
  }

  return { compressedEntries, skipped };
}
