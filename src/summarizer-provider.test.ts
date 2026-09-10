import { expect, it } from "bun:test";

it("sends high thinking through the real Anthropic adapter with resolved auth (offline)", async () => {
  // A fresh process keeps other tests' pi-ai module mocks out of this request-level proof.
  const child = Bun.spawn([process.execPath, "--eval", `
    import { summarizeRange, summarizeBatch } from "./src/summarizer.ts";
    import { DEFAULT_CONFIG } from "./src/types.ts";
    import { getModel } from "@earendil-works/pi-ai/compat";
    const requests = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url: String(url), body, headers: Object.fromEntries(new Headers(init.headers)) });
      const events = [
        { type: "message_start", message: { id: "offline", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "offline summary" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ];
      return new Response(events.map(e => "event: " + e.type + "\\ndata: " + JSON.stringify(e) + "\\n\\n").join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const results = [];
    for (const id of ["claude-sonnet-4-5", "claude-sonnet-4-6"]) {
      const model = getModel("anthropic", id);
      if (!model) throw new Error("Missing test model " + id);
      const ctx = {
        model,
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "offline-test-key", headers: { "x-test-auth": "resolved-header" } }),
          getProviderAuth: async () => ({ auth: { baseUrl: "https://offline.invalid" } }),
        },
        ui: { notify: (message) => { throw new Error(message); } },
      };
      for (const summarizerThinking of ["high", "off", "default"]) {
        results.push(await summarizeRange("t1: read source", { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerThinking }, ctx));
      }
    }
    const raw = "prefix ".repeat(500) + "DIAGNOSIS: src/actual.ts; clean up only after success";
    const model = getModel("anthropic", "claude-sonnet-4-6");
    const notices = [];
    const ctx = { model, modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "offline-test-key", headers: { "x-test-auth": "resolved-header" } }),
      getProviderAuth: async () => ({ auth: { baseUrl: "https://offline.invalid" } }),
    }, ui: { notify: (message) => notices.push(message) } };
    const batch = { turnIndex: 1, timestamp: 1, assistantText: "", toolCalls: [{ toolCallId: "long", toolName: "read", args: {}, resultText: raw, isError: false }] };
    const fullResult = await summarizeBatch(batch, { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerThinking: "off" }, ctx);
    const tooLarge = await summarizeBatch(batch, { ...DEFAULT_CONFIG, summarizerModel: "default" }, { ...ctx, model: { ...model, contextWindow: 100 } });
    console.log(JSON.stringify({ requests, results, raw, fullResult, tooLarge, notices }));
  `], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const { requests, results, raw, fullResult, tooLarge, notices } = JSON.parse(stdout);
  expect(requests).toHaveLength(7);
  expect(JSON.stringify(requests[6].body)).toContain(raw);
  expect(fullResult.result.summaryText).toBe("offline summary");
  expect(tooLarge.kind).toBe("unusable");
  expect(tooLarge.message).toContain("context window");
  expect(notices).toHaveLength(0);
  expect(results.every((result: any) => result.kind === "ok" && result.result.summaryText === "offline summary")).toBe(true);
  expect(requests[0].body.thinking).toMatchObject({ type: "enabled", budget_tokens: 16384 });
  expect(requests[0].body.max_tokens).toBeGreaterThan(16384);
  expect(requests[3].body.thinking).toMatchObject({ type: "adaptive" });
  expect(requests[3].body.output_config).toEqual({ effort: "high" });
  for (const index of [1, 2, 4, 5]) {
    expect(requests[index].body.thinking).toEqual({ type: "disabled" });
  }
  for (const request of requests) {
    expect(request.url).toStartWith("https://offline.invalid/");
    expect(request.headers["x-api-key"]).toBe("offline-test-key");
    expect(request.headers["x-test-auth"]).toBe("resolved-header");
  }
});
