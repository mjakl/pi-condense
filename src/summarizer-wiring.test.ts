import { describe, it, expect, mock, beforeEach } from "bun:test";
import { setTimeout as nativeDelay } from "node:timers/promises";

// Keep native cancellation semantics without waiting through the retry schedule.
const realDelay = nativeDelay;
const delays: number[] = [];
let delayImpl: typeof nativeDelay = async (_ms, value, options) => {
  options?.signal?.throwIfAborted();
  return value!;
};
mock.module("node:timers/promises", () => ({
  setTimeout: (...args: Parameters<typeof nativeDelay>) => {
    delays.push(args[0]!);
    return delayImpl(...args);
  },
}));
beforeEach(() => {
  delays.length = 0;
  delayImpl = async (_ms, value, options) => {
    options?.signal?.throwIfAborted();
    return value!;
  };
});
import * as actualCompat from "@earendil-works/pi-ai/compat";

// Stub pi-ai's `streamSimple` so runSummarization can be exercised without a network
// call. `streamImpl` is swapped per test to simulate primary/fallback outcomes.
let streamImpl: (model: any, input?: any, opts?: any) => any = () => {
  throw new Error("streamImpl not set");
};
mock.module("@earendil-works/pi-ai/compat", () => ({
  ...actualCompat,
  streamSimple: (...args: any[]) => streamImpl(...args),
}));

const { summarizeBatch, summarizeRange, summarizeBatches } = await import("./summarizer.js");
const { FallbackController, COOLDOWN_MS } = await import("./summarizer-fallback.js");
const { DEFAULT_CONFIG } = await import("./types.js");

const PRIMARY = { id: "primary-model", provider: "provider-a", name: "Primary" };
const SESSION = { id: "session-model", provider: "provider-b", name: "Session" };

const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function okStream(text: string) {
  return {
    async *[Symbol.asyncIterator]() {
      // no events; runOnce only needs .result()
    },
    async result() {
      return { stopReason: "stop", content: [{ type: "text", text }], usage: USAGE };
    },
  };
}

function errStream(message: string) {
  return {
    async *[Symbol.asyncIterator]() {},
    async result() {
      return { stopReason: "error", errorMessage: message, content: [], usage: USAGE };
    },
  };
}

// Hangs until `opts.signal` (the combined caller+timeout signal runOnce
// passes to streamSimple()) aborts. With no signal it never settles.
function hangingStream(opts: any) {
  const signal: AbortSignal | undefined = opts?.signal;
  const untilAbort = () =>
    new Promise<never>((_, reject) => {
      if (!signal) return; // no signal => never settles
      if (signal.aborted) return reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  return {
    async *[Symbol.asyncIterator]() {
      await untilAbort();
    },
    async result() {
      return untilAbort();
    },
  };
}

// Emits `events` thinking_delta events spaced `gapMs` apart, then completes
// successfully — UNLESS `opts.signal` aborts mid-drip, in which case the
// current sleep rejects, exactly like a real provider stream cancelling on
// abort. This is what gives the idle-reset test teeth: if runOnce's in-loop
// bumpIdle() is ever removed, the idle timer fires at the configured window
// and the combined signal aborts, so this stream rejects instead of
// completing — the test then fails instead of passing vacuously.
function drippingStream(opts: any, text: string, events: number, gapMs: number) {
  const signal: AbortSignal | undefined = opts?.signal;
  const sleepOrAbort = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true }
      );
    });
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < events; i++) {
        await sleepOrAbort(gapMs);
        yield { type: "thinking_delta" };
      }
    },
    async result() {
      return { stopReason: "stop", content: [{ type: "text", text }], usage: USAGE };
    },
  };
}

interface Note {
  msg: string;
  level: string;
}

function makeCtx(notes: Note[], sessionModel: any = SESSION, primaryModel: any = PRIMARY) {
  return {
    model: sessionModel,
    modelRegistry: {
      find: () => primaryModel,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
      getProviderAuth: async () => undefined,
    },
    ui: { notify: (msg: string, level: string) => notes.push({ msg, level }) },
  } as any;
}

function makeBatch() {
  return {
    turnIndex: 0,
    timestamp: 0,
    assistantText: "",
    toolCalls: [
      { toolCallId: "t1", toolName: "read", args: {}, resultText: "x".repeat(50), isError: false },
    ],
  } as any;
}

const distinctConfig = { ...DEFAULT_CONFIG, summarizerModel: "provider-a/primary-model" };

const text = (outcome: any) => (outcome.kind === "ok" ? outcome.result.summaryText : undefined);

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

// Drain async auth/stream continuations without wall-clock timing assumptions.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const batches = (count: number) => Array.from({ length: count }, (_, index) => ({
  ...makeBatch(), assistantText: `batch-${index}`, turnIndex: index,
}));
const batchIndex = (input: any) => Number(input.messages[0].content[0].text.match(/batch-(\d+)/)[1]);

function gatedStream(wait: Promise<void>, summary: string) {
  return {
    async *[Symbol.asyncIterator]() { await wait; },
    async result() { return { stopReason: "stop", content: [{ type: "text", text: summary }], usage: USAGE }; },
  };
}

describe("summary request identity", () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it("isolates overlapping identical batches, separate contexts, and range jobs", async () => {
    const wait = gate();
    const identities: string[] = [];
    streamImpl = (_model, _input, opts) => {
      identities.push(opts.sessionId);
      return gatedStream(wait.promise, "summary");
    };
    const ctx = makeCtx([]);
    ctx.sessionManager = { getSessionId: () => "parent-session" };
    const work = Promise.all([
      summarizeBatches([makeBatch(), makeBatch()], DEFAULT_CONFIG, ctx),
      summarizeBatch(makeBatch(), DEFAULT_CONFIG, makeCtx([])),
      summarizeRange("t1: read source", DEFAULT_CONFIG, ctx),
    ]);
    try {
      await tick();
      expect(identities).toHaveLength(4);
      for (const id of identities) expect(id).toMatch(uuid);
      expect(new Set(identities).size).toBe(4);
    } finally {
      wait.release();
      await work;
    }
  });

  it("gives serial manual-style invocations fresh identities for merged batches", async () => {
    const { groupBatchesByMode } = await import("./batch-capture.js");
    const [merged] = groupBatchesByMode([
      { ...makeBatch(), userTurnGroup: 1 },
      { ...makeBatch(), userTurnGroup: 1 },
    ], "agent-message");
    expect(merged.toolCalls).toHaveLength(2);
    const identities: string[] = [];
    streamImpl = (_model, _input, opts) => {
      identities.push(opts.sessionId);
      return okStream("summary");
    };
    const ctx = makeCtx([]);
    const options = { onTextProgress: () => {} };
    for (let i = 0; i < 2; i++) {
      expect((await summarizeBatch(merged, DEFAULT_CONFIG, ctx, options)).kind).toBe("ok");
    }
    for (const id of identities) expect(id).toMatch(uuid);
    expect(new Set(identities).size).toBe(2);
  });

  it("keeps identity through retries and fallback, but renews for sticky and probe jobs", async () => {
    let now = 0;
    const controller = new FallbackController(() => now);
    const calls: { model: string; sessionId: string }[] = [];
    streamImpl = (model, _input, opts) => {
      calls.push({ model: model.id, sessionId: opts.sessionId });
      return model === PRIMARY ? errStream("offline outage") : okStream("fallback");
    };
    const ctx = makeCtx([]);
    const options = { controller };
    expect((await summarizeBatch(makeBatch(), distinctConfig, ctx, options)).kind).toBe("ok");
    expect(calls.map(c => c.model)).toEqual([
      PRIMARY.id, PRIMARY.id, PRIMARY.id, PRIMARY.id, SESSION.id,
    ]);
    expect(calls[0].sessionId).toMatch(uuid);
    expect(new Set(calls.map(c => c.sessionId)).size).toBe(1);
    expect(delays).toEqual([3000, 9000, 27000]);

    expect((await summarizeBatch(makeBatch(), distinctConfig, ctx, options)).kind).toBe("ok");
    expect(calls[5].model).toBe(SESSION.id);
    now = COOLDOWN_MS;
    expect((await summarizeRange("t1: read source", distinctConfig, ctx, options)).kind).toBe("ok");
    expect(calls.slice(6).map(c => c.model)).toEqual([PRIMARY.id, SESSION.id]);
    expect(calls[6].sessionId).toBe(calls[7].sessionId);
    for (const index of [5, 6]) expect(calls[index].sessionId).toMatch(uuid);
    expect(new Set([calls[0].sessionId, calls[5].sessionId, calls[6].sessionId]).size).toBe(3);
    expect(options).toEqual({ controller });
  });
});

describe("bounded automatic batch summarization", () => {
  it("defaults to two slots, refills on completion, and returns ordered results and progress indices", async () => {
    const gates = Array.from({ length: 5 }, gate);
    const started: number[] = [];
    const progress: number[][] = [];
    let charged = 0;
    streamImpl = (_model, input) => {
      const index = batchIndex(input);
      started.push(index);
      return gatedStream(gates[index].promise, `summary-${index}`);
    };
    const work = summarizeBatches(batches(5), DEFAULT_CONFIG, makeCtx([]), {
      onUsage: () => charged++,
      onBatchTextProgress: (index, total, batch) => progress.push([index, total, batch.turnIndex]),
    });
    try {
      await tick();
      expect(started).toEqual([0, 1]);
      gates[1].release();
      await tick();
      expect(started).toEqual([0, 1, 2]);
      gates[2].release();
      await tick();
      expect(started).toEqual([0, 1, 2, 3]);
      gates[0].release();
      await tick();
      expect(started).toEqual([0, 1, 2, 3, 4]);
    } finally {
      gates.forEach((g) => g.release());
      await work;
    }
    expect((await work).map(text)).toEqual([0, 1, 2, 3, 4].map((i) => `summary-${i}`));
    expect(charged).toBe(5);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every(([index, total, turn]) => total === 5 && index === turn)).toBe(true);
  });

  for (const limit of [1, 3, 20]) {
    it(`honors configured concurrency ${limit}, bounded by batch count`, async () => {
      const hold = gate();
      let started = 0;
      streamImpl = () => { started++; return gatedStream(hold.promise, "summary"); };
      const work = summarizeBatches(batches(4), { ...DEFAULT_CONFIG, summarizerConcurrency: limit }, makeCtx([]));
      try {
        await tick();
        expect(started).toBe(Math.min(limit, 4));
      } finally {
        hold.release();
        await work;
      }
      expect(started).toBe(4);
    });
  }

  it("does not share slots between independent extension invocations", async () => {
    const hold = gate();
    let started = 0;
    streamImpl = () => { started++; return gatedStream(hold.promise, "summary"); };
    const work = Promise.all([makeCtx([]), makeCtx([])].map((ctx) => summarizeBatches(batches(3), DEFAULT_CONFIG, ctx)));
    try {
      await tick();
      expect(started).toBe(4);
    } finally {
      hold.release();
      await work;
    }
  });

  it("returns empty and single-batch results without changing their shape", async () => {
    streamImpl = () => okStream("one");
    expect(await summarizeBatches([], DEFAULT_CONFIG, makeCtx([]))).toEqual([]);
    expect((await summarizeBatches(batches(1), DEFAULT_CONFIG, makeCtx([]))).map(text)).toEqual(["one"]);
  });

  it("does not dispatch an already-cancelled queue", async () => {
    let started = 0;
    streamImpl = () => { started++; return okStream("unexpected"); };
    const abort = new AbortController();
    abort.abort();
    await expect(summarizeBatches(batches(4), DEFAULT_CONFIG, makeCtx([]), { signal: abort.signal })).rejects.toThrow();
    expect(started).toBe(0);
  });

  it("stops dispatch on cancellation and waits for every started worker before rejecting", async () => {
    const hold = gate();
    const abort = new AbortController();
    const started: number[] = [];
    streamImpl = (_model, input, opts) => {
      const index = batchIndex(input);
      started.push(index);
      return index === 0 ? hangingStream(opts) : gatedStream(hold.promise, "late");
    };
    let settled = false;
    const work = summarizeBatches(batches(4), DEFAULT_CONFIG, makeCtx([]), { signal: abort.signal })
      .then(() => { settled = true; return null; }, (error) => { settled = true; return error; });
    try {
      await tick();
      abort.abort();
      await tick();
      expect(started).toEqual([0, 1]);
      expect(settled).toBe(false);
    } finally {
      hold.release();
      await work;
    }
    expect(await work).toBeInstanceOf(Error);
    expect(started).toEqual([0, 1]);
  });

  it("stops dispatch after a thrown UI error but settles owned work and usage", async () => {
    const hold = gate();
    const failure = new Error("stale context");
    const ctx = makeCtx([]);
    ctx.ui.notify = () => { throw failure; };
    const started: number[] = [];
    let charged = 0;
    streamImpl = (_model, input) => {
      const index = batchIndex(input);
      started.push(index);
      return index === 0 ? errStream("down") : gatedStream(hold.promise, "late");
    };
    let settled = false;
    const work = summarizeBatches(batches(4), DEFAULT_CONFIG, ctx, { onUsage: () => charged++ })
      .then(() => { settled = true; return null; }, (error) => { settled = true; return error; });
    try {
      await tick();
      expect(settled).toBe(false);
      expect(started).toEqual([0, 1]);
    } finally {
      hold.release();
      await work;
    }
    expect(await work).toBe(failure);
    expect(charged).toBe(2);
    expect(started).toEqual([0, 1]);
  });

  it("keeps the slot through all primary backoffs and fallback, then dispatches the next batch", async () => {
    const retryGates = Array.from({ length: 3 }, gate);
    const fallbackGate = gate();
    const seen: string[] = [];
    let charged = 0;
    delayImpl = async (_ms, value, options) => {
      await retryGates[delays.length - 1].promise;
      options?.signal?.throwIfAborted();
      return value!;
    };
    streamImpl = (model, input) => {
      const index = batchIndex(input);
      seen.push(`${index}:${model.id}`);
      if (index === 0 && model.id === PRIMARY.id) return errStream("down");
      return gatedStream(fallbackGate.promise, `summary-${index}`);
    };
    const work = summarizeBatches(batches(2), { ...distinctConfig, summarizerConcurrency: 1 }, makeCtx([]), {
      controller: new FallbackController(), onUsage: () => charged++,
    });
    try {
      for (let i = 0; i < 3; i++) {
        await tick();
        expect(seen).toEqual(Array(i + 1).fill(`0:${PRIMARY.id}`));
        retryGates[i].release();
      }
      await tick();
      expect(delays).toEqual([3000, 9000, 27000]);
      expect(seen).toEqual([...Array(4).fill(`0:${PRIMARY.id}`), `0:${SESSION.id}`]);
    } finally {
      retryGates.forEach((g) => g.release());
      fallbackGate.release();
      await work;
    }
    expect((await work).map(text)).toEqual(["summary-0", "summary-1"]);
    expect(seen.at(-1)).toBe(`1:${SESSION.id}`);
    expect(charged).toBe(6);
  });

  it("cancellation during backoff never starts queued batches or another attempt", async () => {
    delayImpl = (_ms, value, options) => realDelay(60_000, value, options);
    const abort = new AbortController();
    const started: number[] = [];
    streamImpl = (_model, input) => { started.push(batchIndex(input)); return errStream("down"); };
    const work = summarizeBatches(batches(4), distinctConfig, makeCtx([]), {
      signal: abort.signal, controller: new FallbackController(),
    }).catch((error) => error);
    await tick();
    abort.abort();
    expect(await work).toBeInstanceOf(Error);
    expect(started).toEqual([0, 1]);
    expect(delays).toEqual([3000, 3000]);
  });
});

describe("runSummarization wiring — same-model no-op (legacy path)", () => {
  it("summarizerModel=default: transient failure notifies error, returns transient, controller untouched", async () => {
    streamImpl = () => errStream("provider overloaded");
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const r = await summarizeBatch(makeBatch(), { ...DEFAULT_CONFIG, summarizerModel: "default" }, ctx, {
      controller,
    });
    expect(r.kind).toBe("transient");
    expect(controller.inFallback).toBe(false);
    expect(notes).toHaveLength(1);
    expect(notes[0].level).toBe("error");
    expect(notes[0].msg).toContain("provider overloaded");
  });
});

describe("usage and UI boundaries", () => {
  it("charges a billed error stop once, before classification", async () => {
    streamImpl = () => errStream("refusal");
    const charged: unknown[] = [];
    const r = await summarizeBatch(makeBatch(), { ...DEFAULT_CONFIG, summarizerModel: "default" }, makeCtx([]), {
      onUsage: (usage) => charged.push(usage),
    });
    expect(r.kind).toBe("transient");
    expect(charged).toEqual([USAGE]);
  });

  it("charges every completed attempt exactly once across retries and fallback", async () => {
    streamImpl = (model) => (model.id === PRIMARY.id ? errStream("down") : okStream("- rescued"));
    let charged = 0;
    const r = await summarizeBatch(makeBatch(), distinctConfig, makeCtx([]), {
      controller: new FallbackController(), onUsage: () => charged++,
    });
    expect(text(r)).toBe("- rescued");
    expect(charged).toBe(5);
  });

  it("an unusable response stays unusable when the UI context is stale (no retry, no fallback)", async () => {
    let calls = 0;
    streamImpl = () => {
      calls++;
      return { async *[Symbol.asyncIterator]() {}, async result() {
        return { stopReason: "length", content: [{ type: "text", text: "partial" }], usage: USAGE };
      } };
    };
    const ctx = makeCtx([]);
    ctx.ui.notify = () => { throw new Error("This extension ctx is stale after session replacement or reload."); };
    const r = await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller: new FallbackController() });
    expect(r.kind).toBe("unusable");
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });
});

describe("runSummarization wiring — enter fallback", () => {
  it("primary transient + fallback ok: returns summary, one warning, no error notify, sticky", async () => {
    const efforts: unknown[] = [];
    streamImpl = (model, _input, opts) => {
      efforts.push(Object.hasOwn(opts, "reasoning") ? opts.reasoning : "omitted");
      return model.id === PRIMARY.id ? errStream("down") : okStream("- fallback summary");
    };
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const r = await summarizeBatch(makeBatch(), { ...distinctConfig, summarizerThinking: "high" }, ctx, { controller });
    expect(efforts).toEqual(["high", "high", "high", "high", "omitted"]);
    expect(text(r)).toBe("- fallback summary");
    expect(controller.inFallback).toBe(true);
    const warnings = notes.filter((n) => n.level === "warning");
    const errors = notes.filter((n) => n.level === "error");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].msg).toContain("Primary");
    expect(warnings[0].msg).toContain("Session");
    expect(errors).toHaveLength(0);
  });

  it("steady-state after enter routes to the session model only (no primary call, no notify)", async () => {
    const seen: string[] = [];
    streamImpl = (model) => {
      seen.push(model.id);
      return model.id === PRIMARY.id ? errStream("down") : okStream("- ok");
    };
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController(); // real clock: cooldown (3m) will not elapse in-test
    await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller }); // enter
    seen.length = 0;
    notes.length = 0;
    const r = await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller }); // steady-state
    expect(text(r)).toBe("- ok");
    expect(seen).toEqual([SESSION.id]); // primary never called again before cooldown
    expect(notes).toHaveLength(0);
  });
});

describe("runSummarization wiring — both-down + deferred warning", () => {
  it("primary + fallback both transient: transient, error notify, enters fallback with owed warning", async () => {
    streamImpl = () => errStream("everything down");
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const r = await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller });
    expect(r.kind).toBe("transient");
    expect(controller.inFallback).toBe(true);
    const warnings = notes.filter((n) => n.level === "warning");
    const errors = notes.filter((n) => n.level === "error");
    expect(warnings).toHaveLength(0); // warning is owed, not yet fired
    expect(errors).toHaveLength(1);

    // Next flush: fallback now succeeds -> owed warning fires once.
    streamImpl = (model) => (model.id === PRIMARY.id ? errStream("still down") : okStream("- rescued"));
    notes.length = 0;
    const r2 = await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller });
    expect(text(r2)).toBe("- rescued");
    expect(notes.filter((n) => n.level === "warning")).toHaveLength(1);
  });
});

describe("runSummarization wiring — auth", () => {
  it("does not stream or enter fallback when auth resolution fails", async () => {
    let calls = 0;
    streamImpl = () => { calls++; return okStream("- unexpected"); };
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "missing credential" });
    const controller = new FallbackController();
    expect((await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller })).kind).toBe("auth");
    expect(calls).toBe(0);
    expect(controller.inFallback).toBe(false);
    expect(notes).toEqual([{ msg: "pruner: summarization failed: missing credential", level: "error" }]);
  });
});

describe("runSummarization wiring — abort", () => {
  it("cancels an active stream without retrying on the fallback", async () => {
    const ac = new AbortController();
    let calls = 0;
    streamImpl = (_model, _input, opts) => {
      calls++;
      queueMicrotask(() => ac.abort());
      return hangingStream(opts);
    };
    const notes: Note[] = [];
    const controller = new FallbackController();
    await expect(summarizeBatch(makeBatch(), distinctConfig, makeCtx(notes), {
      controller, signal: ac.signal,
    })).rejects.toThrow("aborted");
    expect(calls).toBe(1);
    expect(controller.inFallback).toBe(false);
    expect(notes).toHaveLength(0);
  });
  it("re-throws when the signal is already aborted", async () => {
    streamImpl = () => okStream("- never");
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const ac = new AbortController();
    ac.abort();
    await expect(
      summarizeBatch(makeBatch(), distinctConfig, ctx, { controller, signal: ac.signal }),
    ).rejects.toThrow();
  });
});

describe("runSummarization wiring — timeouts", () => {
  it("idle timeout (default model): transient warning, returns transient", async () => {
    streamImpl = (_m, _i, opts) => hangingStream(opts);
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const cfg = { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerIdleTimeoutMs: 20, summarizerMaxTimeoutMs: 0 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, {});
    expect(r.kind).toBe("transient");
    const warnings = notes.filter((n) => n.level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].msg).toMatch(/stalled/);
    expect(notes.filter((n) => n.level === "error")).toHaveLength(0);
  });

  it("ceiling timeout (idle disabled): transient warning mentioning ceiling", async () => {
    streamImpl = (_m, _i, opts) => hangingStream(opts);
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const cfg = { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerIdleTimeoutMs: 0, summarizerMaxTimeoutMs: 20 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, {});
    expect(r.kind).toBe("transient");
    const warnings = notes.filter((n) => n.level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].msg).toMatch(/ceiling/);
  });

  it("option B: primary idle-times-out, session model rescues", async () => {
    streamImpl = (model, _i, opts) => (model.id === PRIMARY.id ? hangingStream(opts) : okStream("- rescued"));
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const cfg = { ...distinctConfig, summarizerIdleTimeoutMs: 20 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, { controller });
    expect(text(r)).toBe("- rescued");
    expect(controller.inFallback).toBe(true);
    expect(notes.filter((n) => n.level === "warning")).toHaveLength(1); // generic "enter" fallback warning
    expect(notes.filter((n) => n.level === "error")).toHaveLength(0);
  });

  it("both time out: transient, both-down notice at warning severity", async () => {
    streamImpl = (_m, _i, opts) => hangingStream(opts);
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const controller = new FallbackController();
    const cfg = { ...distinctConfig, summarizerIdleTimeoutMs: 20 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, { controller });
    expect(r.kind).toBe("transient");
    expect(notes.filter((n) => n.level === "warning")).toHaveLength(1);
    expect(notes.filter((n) => n.level === "error")).toHaveLength(0);
  });

  it("pre-aborted signal is not a timeout (throws, no warning)", async () => {
    streamImpl = (_m, _i, opts) => hangingStream(opts);
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const ac = new AbortController();
    ac.abort();
    const cfg = { ...distinctConfig, summarizerIdleTimeoutMs: 20 };
    await expect(summarizeBatch(makeBatch(), cfg, ctx, { signal: ac.signal })).rejects.toThrow();
    expect(notes.filter((n) => n.level === "warning")).toHaveLength(0);
  });

  it("both timeouts disabled: okStream succeeds unchanged", async () => {
    streamImpl = () => okStream("- ok");
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const cfg = { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerIdleTimeoutMs: 0, summarizerMaxTimeoutMs: 0 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, {});
    expect(text(r)).toBe("- ok");
    expect(notes).toHaveLength(0);
  });
});

describe("runSummarization wiring — idle reset keeps a flowing stream alive", () => {
  it("does not time out while events keep arriving within the idle window", async () => {
    // 6 events, 10ms apart = 60ms total > 25ms idle window; only survives if
    // the idle timer resets on every event (bumpIdle() inside the loop).
    streamImpl = (_m, _i, opts) => drippingStream(opts, "- flowing summary", 6, 10);
    const notes: Note[] = [];
    const ctx = makeCtx(notes);
    const cfg = { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerIdleTimeoutMs: 25, summarizerMaxTimeoutMs: 0 };
    const r = await summarizeBatch(makeBatch(), cfg, ctx, {});
    expect(text(r)).toBe("- flowing summary");
    expect(notes.filter((n) => n.level === "warning")).toHaveLength(0);
  });
});


describe("bounded primary retries", () => {
  it("waits 3s, 9s, 27s before retries, with immediate initial and fallback attempts", async () => {
    const events: Array<string | number> = [];
    let release!: () => void;
    let delayStarted!: () => void;
    let waiting = new Promise<void>((resolve) => { delayStarted = resolve; });
    delayImpl = async (ms, value) => {
      events.push(ms!);
      const gate = new Promise<void>((resolve) => { release = resolve; });
      delayStarted();
      await gate;
      return value!;
    };
    streamImpl = (model) => {
      events.push(model.id);
      return model.id === PRIMARY.id ? errStream("down") : okStream("fallback");
    };
    const controller = new FallbackController();
    const ctx = makeCtx([]);
    const result = summarizeBatch(makeBatch(), distinctConfig, ctx, { controller });
    const expected: Array<string | number> = [];
    for (const ms of [3000, 9000, 27000]) {
      await waiting;
      expected.push(PRIMARY.id, ms);
      expect(events).toEqual(expected);
      waiting = new Promise<void>((resolve) => { delayStarted = resolve; });
      release();
    }
    expect(text(await result)).toBe("fallback");
    expect(events).toEqual([...expected, PRIMARY.id, SESSION.id]);
    expect(delays).toEqual([3000, 9000, 27000]);
    events.length = 0;
    await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller });
    expect(events).toEqual([SESSION.id]);
    expect(delays).toEqual([3000, 9000, 27000]);
  });

  for (const cancelAt of [1, 2, 3]) {
    it(`cancels during retry delay ${cancelAt} without further auth or requests`, async () => {
      const ac = new AbortController();
      let calls = 0;
      let auths = 0;
      const controller = new FallbackController();
      const ctx = makeCtx([]);
      ctx.modelRegistry.getProviderAuth = async () => { auths++; };
      delayImpl = async (ms, value, options) => {
        expect(options?.signal).toBe(ac.signal);
        if (delays.length === cancelAt) {
          const pending = realDelay(ms, value, options);
          ac.abort();
          return pending;
        }
        return value!;
      };
      streamImpl = () => { calls++; return errStream("down"); };
      await expect(summarizeBatch(makeBatch(), distinctConfig, ctx, {
        controller, signal: ac.signal,
      })).rejects.toThrow();
      expect(calls).toBe(cancelAt);
      expect(auths).toBe(cancelAt);
      expect(delays).toEqual([3000, 9000, 27000].slice(0, cancelAt));
      expect(controller.inFallback).toBe(false);
    });
  }

  for (const successAt of [1, 2, 3, 4]) {
    it(`stops on primary success at attempt ${successAt}`, async () => {
      const seen: string[] = [];
      streamImpl = (model) => {
        seen.push(model.id);
        return seen.length === successAt ? okStream("- primary") : errStream("down");
      };
      const notes: Note[] = [];
      const controller = new FallbackController();
      expect(text(await summarizeBatch(makeBatch(), distinctConfig, makeCtx(notes), { controller })))
        .toBe("- primary");
      expect(seen).toEqual(Array(successAt).fill(PRIMARY.id));
      expect(delays).toEqual([3000, 9000, 27000].slice(0, successAt - 1));
      expect(controller.inFallback).toBe(false);
      expect(notes).toEqual([]);
    });
  }

  it("exhausts thrown transients, stops after one fallback, then recovers on a later call", async () => {
    const seen: string[] = [];
    streamImpl = (model) => { seen.push(model.id); throw new Error("down"); };
    const notes: Note[] = [];
    const controller = new FallbackController();
    const ctx = makeCtx(notes);
    expect((await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller })).kind).toBe("transient");
    expect(seen).toEqual([...Array(4).fill(PRIMARY.id), SESSION.id]);
    seen.length = 0;
    expect((await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller })).kind).toBe("transient");
    expect(seen).toEqual([SESSION.id]);
    seen.length = 0;
    streamImpl = (model, _input, opts) => {
      seen.push(model.id);
      expect(Object.hasOwn(opts, "reasoning")).toBe(false);
      return okStream("- recovered");
    };
    expect(text(await summarizeBatch(makeBatch(), { ...distinctConfig, summarizerThinking: "off" }, ctx, { controller })))
      .toBe("- recovered");
    expect(seen).toEqual([SESSION.id]);
  });

  for (const stopReason of ["stop", "length"]) {
    for (const afterTransient of [false, true]) {
      it(`${stopReason} unusable response stops, after transient=${afterTransient}`, async () => {
        let calls = 0;
        streamImpl = () => {
          calls++;
          if (afterTransient && calls === 1) return errStream("down");
          return {
            async *[Symbol.asyncIterator]() {},
            async result() {
              return { stopReason, content: [{ type: "text", text: stopReason === "length" ? "partial" : " " }], usage: USAGE };
            },
          };
        };
        const controller = new FallbackController();
        expect((await summarizeBatch(makeBatch(), distinctConfig, makeCtx([]), { controller })).kind).toBe("unusable");
        expect(calls).toBe(afterTransient ? 2 : 1);
        expect(controller.inFallback).toBe(false);
      });
    }
  }

  it("auth failure on a retry stops without fallback", async () => {
    let streams = 0;
    let auths = 0;
    streamImpl = () => { streams++; return errStream("down"); };
    const ctx = makeCtx([]);
    ctx.modelRegistry.getApiKeyAndHeaders = async () => ++auths === 1
      ? { ok: true, apiKey: "k", headers: {} } : { ok: false, error: "missing credential" };
    const controller = new FallbackController();
    expect((await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller })).kind).toBe("auth");
    expect(auths).toBe(2);
    expect(streams).toBe(1);
    expect(controller.inFallback).toBe(false);
  });

  it("cancellation between attempts prevents retry auth and fallback", async () => {
    const ac = new AbortController();
    let auths = 0;
    const ctx = makeCtx([]);
    ctx.modelRegistry.getApiKeyAndHeaders = async () => {
      auths++;
      return { ok: true, apiKey: "k", headers: {} };
    };
    streamImpl = () => ({
      async *[Symbol.asyncIterator]() {},
      async result() {
        return {
          stopReason: "error",
          get errorMessage() { ac.abort(); return "down"; },
          content: [], usage: USAGE,
        };
      },
    });
    await expect(summarizeBatch(makeBatch(), distinctConfig, ctx, {
      controller: new FallbackController(), signal: ac.signal,
    })).rejects.toThrow();
    expect(auths).toBe(1);
  });

  it("cancellation during retry auth prevents a new stream", async () => {
    const ac = new AbortController();
    let auths = 0;
    let streams = 0;
    const ctx = makeCtx([]);
    ctx.modelRegistry.getProviderAuth = async () => { if (++auths === 2) ac.abort(); };
    streamImpl = () => { streams++; return errStream("down"); };
    await expect(summarizeBatch(makeBatch(), distinctConfig, ctx, {
      controller: new FallbackController(), signal: ac.signal,
    })).rejects.toThrow();
    expect(streams).toBe(1);
    expect(auths).toBe(2);
  });

  it("range fusion shares retries and default fallback reasoning", async () => {
    const seen: string[] = [];
    streamImpl = (model, _input, opts) => {
      seen.push(model.id);
      expect(Object.hasOwn(opts, "reasoning")).toBe(model.id === PRIMARY.id);
      return model.id === PRIMARY.id ? errStream("down") : okStream("fused");
    };
    expect(text(await summarizeRange("summaries", { ...distinctConfig, summarizerThinking: "off" }, makeCtx([]), {
      controller: new FallbackController(),
    }))).toBe("fused");
    expect(seen).toEqual([...Array(4).fill(PRIMARY.id), SESSION.id]);
  });

  it("claims one primary attempt after cooldown while concurrent calls use fallback", async () => {
    let now = 0;
    const controller = new FallbackController(() => now);
    controller.onBothDown();
    const seen: string[] = [];
    streamImpl = (model) => {
      seen.push(model.id);
      return model.id === PRIMARY.id ? errStream("down") : okStream("fallback");
    };
    now = COOLDOWN_MS;
    const ctx = makeCtx([]);
    await Promise.all([1, 2].map(() => summarizeBatch(makeBatch(), distinctConfig, ctx, { controller })));
    expect(seen.filter((id) => id === PRIMARY.id)).toHaveLength(1);
    expect(seen.filter((id) => id === SESSION.id)).toHaveLength(2);
    expect(delays).toEqual([]);
    now += COOLDOWN_MS;
    const recoveryNotes: Note[] = [];
    ctx.ui.notify = (msg: string, level: string) => recoveryNotes.push({ msg, level });
    seen.length = 0;
    streamImpl = (model) => { seen.push(model.id); return okStream("primary recovered"); };
    await summarizeBatch(makeBatch(), distinctConfig, ctx, { controller });
    expect(seen).toEqual([PRIMARY.id]);
    expect(controller.inFallback).toBe(false);
    expect(recoveryNotes).toEqual([]);
  });
});
