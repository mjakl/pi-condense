import { describe, expect, test } from "bun:test";
import { ToolCallIndexer } from "./indexer.js";
import { BlockRefIssuer } from "./block-refs.js";
import { compressEligible } from "./chain-compressor.js";
import { pruneMessages } from "./pruner.js";
import { detectChains } from "./chain-detector.js";
import { isProtected } from "./protected.js";
import { expectNoOrphanToolResults } from "./test-support.js";
import { CUSTOM_TYPE_CHAIN, CUSTOM_TYPE_INDEX, DEFAULT_CONFIG } from "./types.js";

const cc = { ...DEFAULT_CONFIG.chainCompression, enabled: true, rollingWindow: 0 };
const protection = { protectedTools: [], protectedPaths: ["**/skills/**/*.md"] };
const protectedCall = (name: string, args: unknown) => isProtected(name, args, protection);
const backfill = { spillThreshold: 1_000_000, spillPreviewBytes: 2048, sessionDir: "/tmp", sessionId: "s1" };

function messages(secondTool = "bash", secondText = "out2", secondArgs = {}): any[] {
  return [
    { role: "user", content: [{ type: "text", text: "go" }], timestamp: 100 },
    { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }], timestamp: 200 },
    { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "out1" }], timestamp: 210 },
    { role: "assistant", content: [{ type: "toolCall", id: "tc2", name: secondTool, arguments: secondArgs }], timestamp: 300 },
    { role: "toolResult", toolCallId: "tc2", toolName: secondTool, content: [{ type: "text", text: secondText }], timestamp: 310 },
    { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 400 },
  ];
}

function fixture(input = messages()) {
  const indexer = new ToolCallIndexer();
  const persisted: any[] = [];
  const deps = {
    indexer, blockRefs: new BlockRefIssuer(), messages: input, backfill,
    appendEntry: (customType: string, data: unknown) => persisted.push({ type: "custom", customType, data }),
    diagnostics: { report: () => {} }, now: () => 999,
  };
  const compress = (fuseRange?: (text: string) => Promise<string | null>) =>
    compressEligible(detectChains(input, protectedCall), 0, { ...deps, fuseRange });
  const render = (idx = indexer) => pruneMessages(input, idx, cc, DEFAULT_CONFIG.errorPurge, protection, 0).messages;
  return { indexer, persisted, deps, compress, render };
}

function synthetic(out: any[]) {
  return out.find(m => m.role === "user" && m.content?.[0]?.text?.startsWith("<compressed-chain"))?.content[0].text;
}

describe("range compression integration", () => {
  test.each([true, false])("full coverage archives originals and renders fused=%s summary", async (fuse) => {
    const f = fixture();
    f.indexer.registerSummaryBody(["tc1@210"], "batch one");
    f.indexer.registerSummaryBody(["tc2@310"], "batch two");
    const inputs: string[] = [];
    const result = await f.compress(fuse ? async text => { inputs.push(text); return "FUSED"; } : undefined);
    expect(result.compressedEntries).toHaveLength(1);
    expect(result.compressedEntries[0].bodySource).toBeUndefined();
    expect(inputs).toEqual(fuse ? ["batch one\n\nbatch two"] : []);
    const out = f.render();
    expect(synthetic(out)).toContain(fuse ? "FUSED" : "batch one\n\nbatch two");
    expect(out.filter(m => m.role === "toolResult")).toHaveLength(0);
    expect(f.indexer.getRecord("t1")?.resultText).toBe("out1");
    expect(f.indexer.getRecord("t2")?.resultText).toBe("out2");
    expectNoOrphanToolResults(out);
  });

  test.each(["none", "partial", "archive-only"])("%s coverage retains unsummarized originals across compact and reload", async coverage => {
    const input = messages();
    // Reused provider ids must not borrow the first occurrence's coverage.
    input[3].content[0].id = "tc1";
    input[4].toolCallId = "tc1";
    const f = fixture(input);
    if (coverage !== "none") {
      f.indexer.addBatch({ turnIndex: 0, timestamp: 200, assistantText: "", toolCalls: [{
        toolCallId: "tc1", toolName: "bash", args: {}, resultText: "out1", isError: false, resultTimestamp: 210,
      }] }, f.deps.appendEntry);
    }
    if (coverage === "partial") f.indexer.registerSummaryBody(["tc1@210"], "first result summary");
    for (let i = 0; i < 2; i++) {
      expect((await f.compress()).compressedEntries).toHaveLength(0);
      expect(f.persisted.filter(e => e.customType === CUSTOM_TYPE_CHAIN)).toHaveLength(0);
      expect(f.render().find(m => m.role === "toolResult" && m.timestamp === 310)?.content[0].text).toBe("out2");
    }
    const reloaded = new ToolCallIndexer();
    reloaded.reconstructFromSession({ sessionManager: { getBranch: () => f.persisted } } as any);
    expect((await compressEligible(detectChains(input), 0, { ...f.deps, indexer: reloaded })).compressedEntries).toHaveLength(0);
    expect(f.render(reloaded).find(m => m.role === "toolResult" && m.timestamp === 310)?.content[0].text).toBe("out2");
  });

  test.each(["context_tree_query", "read"])("%s protected output stays verbatim through fusion, reload and repeat rendering", async tool => {
    const raw = "wrapper\n".repeat(400) + "src/exact.ts: diagnosis; clean up only after success\n{b1}";
    const input = messages(tool, raw, tool === "read" ? { path: "/h/skills/x/SKILL.md" } : {});
    const f = fixture(input);
    f.indexer.registerSummaryBody(["tc1@210"], "bash summary");
    // A legacy summary/index must not override permanent recovery protection.
    f.indexer.addBatch({ turnIndex: 1, timestamp: 300, assistantText: "", toolCalls: [{
      toolCallId: "tc2", toolName: tool, args: tool === "read" ? { path: "/h/skills/x/SKILL.md" } : {}, resultText: raw, isError: false, resultTimestamp: 310,
    }] }, f.deps.appendEntry);
    f.indexer.registerSummaryBody(["tc2@310"], "OLD LOSSY SUMMARY");
    const result = await f.compress(async text => {
      expect(text).not.toContain(raw);
      return "FUSED";
    });
    expect(result.compressedEntries).toHaveLength(1);
    expect(result.compressedEntries[0].protectedToolCallIds).toEqual(["tc2"]);
    const out = f.render();
    expect(synthetic(out)).toContain(`<protected-output tool="${tool}">\n${raw}\n</protected-output>`);
    expectNoOrphanToolResults(out);
    const rebuilt = new ToolCallIndexer();
    rebuilt.reconstructFromSession({ sessionManager: { getBranch: () => f.persisted } } as any);
    expect(synthetic(f.render(rebuilt))).toContain(raw);
    expect(pruneMessages(out, rebuilt, cc, undefined, protection).messages).toEqual(out);
  });

  test("historical chains without protected ids restore recovered text verbatim", () => {
    const raw = "original ".repeat(500) + "TAIL";
    const f = fixture(messages("context_tree_query", raw));
    f.indexer.registerChain({ blockId: "b1", startUserTimestamp: 100, finalAssistantTimestamp: 400,
      droppedToolCallIds: ["tc1", "tc2"], toolRefs: [], compressedAt: 999, rangeSummaryText: "OLD SUMMARY" });
    expect(synthetic(f.render())).toContain(raw);
  });

  test("unsupported image output prevents a new chain drop", async () => {
    const input = messages();
    input[4].content.push({ type: "image", data: "AA==", mimeType: "image/png" });
    const f = fixture(input);
    f.indexer.registerSummaryBody(["tc1@210", "tc2@310"], "text-only summary");
    expect((await f.compress()).compressedEntries).toHaveLength(0);
    expect(f.render().find(m => m.role === "toolResult" && m.timestamp === 310)).toEqual(input[4]);
  });

  test("covered-chain archival survives a failed chain append and retries without duplicate archives", async () => {
    const f = fixture();
    f.indexer.registerSummaryBody(["tc1@210", "tc2@310"], "summary");
    await expect(compressEligible(detectChains(f.deps.messages), 0, {
      ...f.deps, appendEntry: (type, data) => {
        if (type === CUSTOM_TYPE_CHAIN) throw new Error("session write failed");
        f.deps.appendEntry(type, data);
      },
    })).rejects.toThrow("session write failed");
    expect(f.persisted.filter(e => e.customType === CUSTOM_TYPE_INDEX)).toHaveLength(1);
    const rebuilt = new ToolCallIndexer();
    rebuilt.reconstructFromSession({ sessionManager: { getBranch: () => f.persisted } } as any);
    // Archives alone do not authorize retry after reload; the summary must be observed too.
    expect((await compressEligible(detectChains(f.deps.messages), 0, { ...f.deps, indexer: rebuilt })).compressedEntries).toHaveLength(0);
    rebuilt.registerSummaryBody(["tc1@210", "tc2@310"], "summary");
    expect((await compressEligible(detectChains(f.deps.messages), 0, { ...f.deps, indexer: rebuilt })).compressedEntries).toHaveLength(1);
    expect(f.persisted.filter(e => e.customType === CUSTOM_TYPE_INDEX)).toHaveLength(1);
  });
});
