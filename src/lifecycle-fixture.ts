import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "@sinclair/typebox";
import extension from "../index.ts";

const dir = mkdtempSync(join(process.cwd(), ".lifecycle-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
const budget = process.argv.includes("budget") || process.argv.includes("recent-budget");
const recent = process.argv.some(arg => arg.startsWith("recent-"));
writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextPrune: {
  enabled: true, pruneOn: "agent-message", minBatchChars: 1, dedupByContentHash: recent,
  keepRecentUserTurns: recent ? 1 : 0,
  spillThreshold: recent ? 1 : 65536,
  summarizerModel: "default", batchingMode: "agent-message", autoBudgetThreshold: budget ? 0.5 : null,
  chainCompression: { enabled: false },
} }));
let calls = 0;
let summaries = 0;
const payloads: any[] = [];
globalThis.fetch = (async (_url: any, init: any) => {
  const body = JSON.parse(init.body);
  const main = Boolean(body.tools?.length);
  if (main) {
    payloads.push(body);
    const open = new Set<string>();
    for (const message of body.messages) {
      for (const block of message.content) {
        if (block.type === "tool_use") open.add(block.id);
        if (block.type === "tool_result") {
          assert.ok(open.delete(block.tool_use_id), "provider payload must pair each tool result");
        }
      }
    }
    assert.equal(open.size, 0, "provider payload must not leave calls without results");
  }
  const tool = main && calls++ % 3 < 2;
  if (!main) summaries++;
  const content = tool
    ? { type: "tool_use", id: `call-${calls}`, name: "fixture", input: {} }
    : { type: "text", text: main ? "done" : `Archived fact ${summaries}.` };
  const events = [
    { type: "message_start", message: { id: `msg-${calls}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 900000, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: content },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;
try {
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "store.json") });
  await modelRuntime.setRuntimeApiKey("anthropic", "offline-key");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
  const create = async (sm: SessionManager, loadExtension = true) => {
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: loadExtension ? [extension] : [],
    });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager,
      modelRuntime, model: getModel("anthropic", "claude-sonnet-4-5")!, thinkingLevel: "off", sessionManager: sm,
      tools: ["fixture"], customTools: [{ name: "fixture", label: "Fixture", description: "Return a fact", parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "raw fact ".repeat(1000) }], details: {} }),
      }],
    });
    await session.bindExtensions({});
    return session;
  };
  const sm = SessionManager.create(dir, join(dir, "sessions"));
  let session = await create(sm);
  if (recent) {
    await session.prompt("Use fixture then finish.");
    assert.equal(summaries, 0, "current interaction must not summarize even under pressure");
    assert.ok(JSON.stringify(payloads.at(-1)).includes("raw fact raw fact"));
    assert.ok(!sm.getBranch().some((e: any) => ["context-prune-index", "context-prune-frontier", "context-prune-dedup-alias", "context-prune-chain"].includes(e.customType)), "protected work must not advance the frontier or create archives");
    const file = sm.getSessionFile()!;
    session.dispose();
    session = await create(SessionManager.open(file));
    await session.prompt("Use fixture then finish.");
    assert.equal(summaries, 1, "reload rescan must summarize the newly eligible first interaction");
    const latest = JSON.stringify(payloads.at(-1));
    assert.ok(latest.includes("raw fact raw fact"), "current results stay raw");
    const entries = SessionManager.open(file).getBranch();
    const records = entries.filter((e: any) => e.customType === "context-prune-index").flatMap((e: any) => e.data.toolCalls);
    assert.deepEqual(records.map((r: any) => r.toolCallId), ["call-1", "call-2"], "only the older interaction is archived");
    await session.prompt("Use fixture then finish.");
    assert.equal(summaries, 1, "identical older outputs dedup after aging out");
    assert.ok(JSON.stringify(payloads.at(-1)).includes("raw fact raw fact"), "dedup must not rewrite current results");
    assert.ok(sm.getSessionFile());
    session.dispose();
    console.log(JSON.stringify({ recent: true, budget, calls, summaries, reload: true }));
  } else {
  for (let run = 1; run <= 2; run++) {
    await session.prompt("Use fixture then finish.");
    const expectedSummaries = run * (budget ? 2 : 1);
    assert.equal(calls, run * 3, "summary delivery must not trigger extra turns");
    assert.equal(summaries, expectedSummaries, "each batch must summarize once");
    assert.equal(session.messages.filter((m: any) => m.customType === "context-prune-summary").length, expectedSummaries);
    assert.equal(sm.getBranch().filter((e: any) => e.customType === "context-prune-summary").length, expectedSummaries);
    const requestMessages = payloads.at(-1).messages;
    for (let n = 1; n < run; n++) {
      assert.equal(JSON.stringify(requestMessages).split(`Archived fact ${n}.`).length - 1, 1, "live summary must not be duplicated");
    }
    if (budget) {
      const request = JSON.stringify(payloads.at(-1));
      assert.ok(request.includes(`Archived fact ${expectedSummaries}.`), "budget summary must reach immediate continuation");
      assert.ok(!request.includes("raw fact raw fact"), "summarized output must be stubbed");
    }
  }
  assert.ok(JSON.stringify(payloads[3]).includes("Archived fact 1."), "next prompt must contain final-response summary");
  const file = sm.getSessionFile()!;
  session.dispose();
  session = await create(SessionManager.open(file));
  await session.prompt("Use fixture then finish.");
  assert.equal(calls, 9);
  assert.equal(summaries, budget ? 6 : 3, "reload must not summarize archived batches again");
  assert.equal(session.messages.filter((m: any) => m.customType === "context-prune-summary").length, budget ? 6 : 3);
  const report = { budget, calls, summaries, reload: true };
  await session.prompt("/pruner off");
  assert.equal(JSON.parse(await Bun.file(join(dir, "settings.json")).text()).contextPrune.enabled, false, "off must persist before the command returns");
  await session.prompt("Use fixture then finish.");
  assert.equal(summaries, report.summaries, "off must stop automatic summarization");
  assert.ok(JSON.stringify(payloads.at(-1)).includes("raw fact raw fact"), "off must retain original outputs");
  assert.ok(JSON.stringify(payloads.at(-1)).includes("Archived fact 1."), "off does not delete persisted summaries");
  session.dispose();
  session = await create(SessionManager.open(file), false);
  await session.prompt("Use fixture then finish.");
  assert.equal(summaries, report.summaries, "unloaded extension must not summarize");
  assert.ok(JSON.stringify(payloads.at(-1)).includes("raw fact raw fact"));
  assert.ok(JSON.stringify(payloads.at(-1)).includes("Archived fact 1."), "unloading does not delete persisted summaries");
  session.dispose();
  // Re-enable only the disposable fixture's settings; no installed configuration is touched.
  const settings = JSON.parse(await Bun.file(join(dir, "settings.json")).text());
  settings.contextPrune.enabled = true;
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  session = await create(SessionManager.open(file));
  await session.compact();
  await session.prompt("Use fixture then finish.");
  assert.ok(!JSON.stringify(payloads.at(-1)).includes("Archived fact 1."), "context reconciliation must not resurrect compacted summaries");
  assert.ok(SessionManager.open(file).getEntries().some((e: any) => e.message?.role === "toolResult" && JSON.stringify(e.message.content).includes("raw fact raw fact")), "compaction leaves original session history intact");
  session.dispose();
  console.log(JSON.stringify(report));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
