// Reproduces pre-quality-change eager spills for archive compatibility tests.
import { mkdir, writeFile } from "node:fs/promises";
import type { CapturedBatch, CapturedToolCall } from "./types.js";
import type { ToolCallIndexer } from "./indexer.js";
import { occKey } from "./occurrence-key.js";
import { applySpill, blobDirFor, blobPathFor } from "./spill.js";

export async function spillOversizedBatch(args: {
  batch: CapturedBatch;
  indexer: ToolCallIndexer;
  config: { spillThreshold: number; spillPreviewBytes: number; dedupByContentHash: boolean };
  sessionDir: string;
  sessionId: string;
  appendEntry: (customType: string, data?: unknown) => void;
}): Promise<Set<string>> {
  const { batch, indexer, config, sessionDir, sessionId, appendEntry } = args;
  const handled = new Set<string>();
  const toIndex: CapturedToolCall[] = [];
  for (const tc of batch.toolCalls) {
    if (tc.resultText.length < config.spillThreshold) continue;
    const key = occKey(tc.toolCallId, tc.resultTimestamp);
    if (config.dedupByContentHash) {
      const original = indexer.lookupByContent(tc.toolName, tc.resultText);
      if (original && original !== key) {
        indexer.registerDuplicate(key, original, appendEntry);
        handled.add(tc.toolCallId);
        continue;
      }
    }
    const path = blobPathFor(sessionDir, sessionId, key);
    try {
      await mkdir(blobDirFor(sessionDir, sessionId), { recursive: true });
      await writeFile(path, tc.resultText, "utf-8");
    } catch {
      continue;
    }
    applySpill(tc, path, config.spillPreviewBytes);
    toIndex.push(tc);
    handled.add(tc.toolCallId);
  }
  if (toIndex.length > 0) {
    indexer.addBatch({ turnIndex: batch.turnIndex, timestamp: batch.timestamp, assistantText: "", toolCalls: toIndex }, appendEntry);
  }
  return handled;
}
