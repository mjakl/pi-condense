import { expect, it } from "bun:test";
import { convertResponsesMessages } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";
import { ToolCallIndexer } from "./indexer.js";
import { pruneMessages } from "./pruner.js";

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

it("malformed stored Responses reasoning fails even without condense transformations", () => {
  const malformed = structuredClone(messages);
  malformed[1].content[0].thinkingSignature = "not-json";
  expect(() => convertResponsesMessages(model, { messages: malformed }, new Set([model.provider]))).toThrow();
  const unchanged = pruneMessages(malformed, new ToolCallIndexer());
  expect(unchanged.pruned).toBe(false);
  expect(() => convertResponsesMessages(model, { messages: unchanged.messages }, new Set([model.provider]))).toThrow();
});
