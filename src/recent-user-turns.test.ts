import { describe, expect, it } from "bun:test";
import { recentUserTurnsBoundary } from "./recent-user-turns.js";
import { captureUnindexedBatchesFromSession } from "./batch-capture.js";
import { pruneMessages } from "./pruner.js";
import { createSupersedeState } from "./supersede.js";
import { compressEligible } from "./chain-compressor.js";
import { detectChains } from "./chain-detector.js";

const interaction = (n: number, tool = "bash", error = false): any[] => [
  { role: "user", timestamp: n, content: "question" },
  { role: "assistant", timestamp: n + 1, content: [{ type: "toolCall", id: `tc${n}`, name: tool, arguments: { path: "/tmp/a", content: "large arguments" } }] },
  { role: "toolResult", timestamp: n + 2, toolCallId: `tc${n}`, toolName: tool, content: [{ type: "text", text: "identical output" }], isError: error },
  { role: "assistant", timestamp: n + 3, content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "done" }] },
];
const indexer = (summarized = false, spill = false, chainEntries: any[] = []): any => ({
  isSummarized: () => summarized,
  hasLegacyBareRecord: () => false,
  getShortRefForToolCallId: () => "t1",
  getRecord: () => spill ? { spillPath: "/tmp/legacy-spill", toolName: "bash" } : undefined,
  getChainEntries: () => chainEntries,
  getPerBatchSummaryTextForToolCallIds: () => "summary",
  findChainEntryByBlockId: () => undefined,
});
const chain = (start: number, end = start + 3): any => ({ blockId: `b${start}`, startUserTimestamp: start,
  finalAssistantTimestamp: end, droppedToolCallIds: [`tc${start}`], toolRefs: ["t1"], compressedAt: 1000 });
const cc = { enabled: true, rollingWindow: 0, stripFinalAssistantThinking: true, fuseRangeSummary: false };

describe("recent user interaction boundary", () => {
  it("counts users, not assistant turns, custom messages, or tool results", () => {
    const messages = [...interaction(10), { role: "custom" }, ...interaction(20), ...interaction(30).slice(0, 3)];
    expect(recentUserTurnsBoundary(messages)).toBe(messages.length);
    expect(recentUserTurnsBoundary(messages, 1)).toBe(9);
    expect(recentUserTurnsBoundary(messages, 2)).toBe(5);
    expect(recentUserTurnsBoundary(messages, 3)).toBe(0);
    expect(recentUserTurnsBoundary(messages, 4)).toBe(0);
    expect(recentUserTurnsBoundary([{ role: "assistant" }], 1)).toBe(0);
    expect(recentUserTurnsBoundary([], 1)).toBe(0);
  });

  it("capture defers an interaction until it ages out, with stable turn indices", () => {
    const messages = [...interaction(10), ...interaction(20)];
    const branch = () => messages.map(message => ({ type: "message", message }));
    const capture = (n: number) => captureUnindexedBatchesFromSession(branch(), indexer(), undefined, n);
    expect(capture(2)).toEqual([]);
    expect(capture(1).map(b => b.toolCalls[0].toolCallId)).toEqual(["tc10"]);
    messages.push(...interaction(30));
    expect(capture(1).map(b => b.turnIndex)).toEqual([0, 2]);
    expect(capture(0)).toHaveLength(3);
  });

  for (const spill of [false, true]) {
    it(`preserves recent ${spill ? "legacy spill" : "summary/dedup"} results, rewrites older ones`, () => {
      const messages = [...interaction(10), ...interaction(20)];
      const result = pruneMessages(messages, indexer(true, spill), undefined, undefined, undefined, 0, undefined, undefined, 1);
      expect(result.pruned).toBe(true);
      expect(result.messages[2]).not.toBe(messages[2]);
      result.messages.slice(4).forEach((message, i) => expect(message).toBe(messages[i + 4]));
      expect(pruneMessages(messages, indexer(true, spill), undefined, undefined, undefined, 0, undefined, undefined, 2).messages).toBe(messages);
    });
  }

  it("keeps failed arguments and orphan cleanup inside the protected suffix untouched", () => {
    const messages = [...interaction(10, "write", true), ...interaction(20, "write", true),
      { role: "toolResult", toolCallId: "orphan", content: [] }];
    const purge = { enabled: true, cooldownTurns: 0, minArgChars: 0 };
    const result = pruneMessages(messages, indexer(), undefined, purge, undefined, 0, undefined, undefined, 1);
    expect(result.messages[1].content[0].arguments._purged).toBeDefined();
    expect(result.messages.slice(4)).toEqual(messages.slice(4));
    expect(pruneMessages(messages, indexer(), undefined, purge).messages).toHaveLength(messages.length - 1);
  });

  it("supersedes only within the eligible prefix", () => {
    const messages = [...interaction(10, "read"), ...interaction(20, "read"), ...interaction(30, "read"), ...interaction(40, "read")];
    const result = pruneMessages(messages, indexer(), undefined, undefined, undefined, 0, undefined,
      { state: { ...createSupersedeState(), floor: 0 }, isProtected: () => true }, 2);
    expect(result.messages[2]).not.toBe(messages[2]);
    result.messages.slice(8).forEach((message, i) => expect(message).toBe(messages[i + 8]));
  });

  it("renders historical chain entries only wholly before the boundary", () => {
    const messages = [...interaction(10), ...interaction(20)];
    const result = pruneMessages(messages, indexer(false, false, [chain(10), chain(20)]), cc,
      undefined, undefined, 0, undefined, undefined, 1);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.messages.slice(-4)).toEqual(messages.slice(-4));
    const crossing = pruneMessages(messages, indexer(false, false, [chain(10, 23)]), cc,
      undefined, undefined, 0, undefined, undefined, 1);
    expect(crossing.messages).toBe(messages);
  });

  it("manual K=0 compression cannot archive or fuse protected chains", async () => {
    const messages = interaction(10);
    const forbidden = () => { throw new Error("protected chain touched"); };
    const result = await compressEligible(detectChains(messages), 0, {
      messages, keepRecentUserTurns: 1, indexer: { getChainEntries: () => [], getIndex: forbidden } as any,
      blockRefs: { issue: forbidden } as any, appendEntry: forbidden, now: forbidden, fuseRange: forbidden,
      diagnostics: { report: forbidden }, backfill: { spillThreshold: 1, spillPreviewBytes: 1, sessionDir: "/tmp", sessionId: "unused" },
    });
    expect(result.compressedEntries).toEqual([]);
  });
});
