import { expect, it } from "bun:test";
import { convertResponsesMessages } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";
import { ToolCallIndexer } from "./indexer.js";
import { pruneMessages } from "./pruner.js";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSupersedeState } from "./supersede.js";
import { isProtected } from "./protected.js";

// Synthetic provider metadata, not a claim about the user's private codex-lb configuration.
const model: any = { id: "synthetic", provider: "codex-lb", api: "openai-responses", input: ["text"] };
const reasoning = { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "opaque-fixture" };
const messages: any[] = [
  { role: "user", content: "Read a file", timestamp: 1 },
  { role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 2,
    content: [
      { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoning) },
      { type: "toolCall", id: "call_fixture|fc_fixture", name: "read", arguments: { path: "file" } },
    ],
  },
  { role: "toolResult", toolCallId: "call_fixture|fc_fixture", toolName: "read", content: [{ type: "text", text: "original output" }], isError: false, timestamp: 3 },
];

it("stub replacement preserves Responses reasoning items and call/output identity", () => {
  const indexer = new ToolCallIndexer();
  indexer.addBatch({ turnIndex: 0, timestamp: 3, assistantText: "", toolCalls: [{
    toolCallId: "call_fixture|fc_fixture", toolName: "read", args: { path: "file" },
    resultText: "original output", resultTimestamp: 3, isError: false,
  }] }, () => {});
  indexer.registerSummaryBody(["call_fixture|fc_fixture@3"], "fixture summary");
  const rendered = pruneMessages(messages, indexer);
  const payload = convertResponsesMessages(model, { messages: rendered.messages }, new Set([model.provider]));
  expect(payload.find((item: any) => item.type === "reasoning")).toEqual(reasoning);
  expect(payload.find((item: any) => item.type === "function_call")).toMatchObject({ id: "fc_fixture", call_id: "call_fixture", arguments: '{"path":"file"}' });
  expect(payload.find((item: any) => item.type === "function_call_output")).toMatchObject({ call_id: "call_fixture" });
  expect(JSON.stringify(payload)).toContain("context_tree_query");
  expect(messages[2].content[0].text).toBe("original output");
});

it.each(["pages", "failed", "partial"])("Responses replay retains protected page evidence after %s reads", async (kind) => {
  const dir = await mkdtemp(join(tmpdir(), "protected-read-replay-"));
  try {
    const path = join(dir, "SKILL.md");
    await writeFile(path, Array.from({ length: 800 }, (_, i) =>
      i === 0 ? "PAGE_ONE_MANDATORY_COPPER" : i === 400 ? "PAGE_TWO_MANDATORY_VIOLET" : `line ${i + 1}`,
    ).join("\n"));
    const read = createReadTool(dir);
    const replay: any[] = [{ role: "user", content: "Read both pages", timestamp: 1 }];
    async function addRead(offset: number, limit: number) {
      const id = `call_${replay.length}|fc_${replay.length}`;
      const args = { path, offset, limit };
      replay.push({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
        stopReason: "toolUse", timestamp: replay.length + 1,
        content: [{ type: "toolCall", id, name: "read", arguments: args }] });
      let content;
      let isError = false;
      try {
        content = (await read.execute(id, args)).content;
      } catch (error) {
        isError = true;
        content = [{ type: "text", text: String(error) }];
      }
      replay.push({ role: "toolResult", toolCallId: id, toolName: "read", content, isError, timestamp: replay.length + 1 });
    }
    await addRead(1, 400);
    await addRead(401, 400);
    if (kind === "failed") await addRead(801, 1); // Real out-of-bounds read failure.
    if (kind === "partial") await addRead(401, 1);
    const before = JSON.stringify(replay);
    const protection = { protectedTools: ["read"], protectedPaths: [] };
    const state = createSupersedeState();
    state.floor = 0;
    const rendered = pruneMessages(replay, new ToolCallIndexer(), undefined, undefined, protection, 0, undefined, {
      state, isProtected: (name, args) => isProtected(name, args, protection),
    });
    for (const messages of [replay, rendered.messages]) {
      const payload = convertResponsesMessages(model, { messages }, new Set([model.provider]));
      const results = payload.filter((item: any) => item.type === "function_call_output");
      expect(results.length).toBe(kind === "pages" ? 2 : 3);
      expect(JSON.stringify(results)).toContain("PAGE_ONE_MANDATORY_COPPER");
      expect(JSON.stringify(results)).toContain("PAGE_TWO_MANDATORY_VIOLET");
    }
    expect(JSON.stringify(replay)).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("malformed stored Responses reasoning fails even without condense transformations", () => {
  const malformed = structuredClone(messages);
  malformed[1].content[0].thinkingSignature = "not-json";
  expect(() => convertResponsesMessages(model, { messages: malformed }, new Set([model.provider]))).toThrow();
  const unchanged = pruneMessages(malformed, new ToolCallIndexer());
  expect(unchanged.pruned).toBe(false);
  expect(() => convertResponsesMessages(model, { messages: unchanged.messages }, new Set([model.provider]))).toThrow();
});
