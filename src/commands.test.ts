import { describe, it, expect, mock } from "bun:test";
import { setPruneStatusWidget, registerCommands } from "./commands.js";
import type { ContextMetricsSnapshot, SummarizerStats } from "./types.js";
import { DEFAULT_CONFIG, STATUS_WIDGET_ID } from "./types.js";

// ── /pruner command handler harness (registerCommands) ──────────────────────
// Drives the real switch-statement handler registered by registerCommands,
// with all injected collaborators stubbed. This is the seam for exercising
// /pruner subcommands without booting the full index.ts extension.
function setupPrunerCommand(overrides: {
  capturePendingBatches?: () => any[];
  flushPending?: (ctx: any, options?: any) => Promise<any>;
  getRearmed?: () => boolean;
  getContextMetrics?: (ctx: any) => ContextMetricsSnapshot;
} = {}) {
  let handler: (args: string, ctx: any) => Promise<void>;
  const notifications: { message: string; type?: string }[] = [];
  const flushCalls: any[] = [];

  const flushPending =
    overrides.flushPending ??
    (async (_ctx: any, options?: any) => {
      flushCalls.push(options);
      return { ok: false, reason: "empty" };
    });

  const pi: any = {
    registerCommand(_name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) {
      handler = spec.handler;
    },
    registerMessageRenderer() {},
  };

  const currentConfig = { value: { ...DEFAULT_CONFIG, enabled: true } };

  registerCommands(
    pi,
    currentConfig,
    flushPending,
    overrides.capturePendingBatches ?? (() => []),
    () => ({ callCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 } as SummarizerStats),
    {} as any,
    async () => ({ compressedEntries: [], skipped: 0 }),
    overrides.getContextMetrics,
    overrides.getRearmed,
  );

  const ctx: any = {
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  };

  return {
    run: (args: string) => handler(args, ctx),
    notifications,
    flushCalls,
  };
}

describe("/pruner now (empty capture)", () => {
  it("invokes flushPending even when nothing is pending, so a flush-metrics entry is recorded", async () => {
    const harness = setupPrunerCommand({ capturePendingBatches: () => [] });
    await harness.run("now");

    expect(harness.flushCalls.length).toBe(1);
    expect(harness.flushCalls[0]).toMatchObject({ previewedBatches: [], trigger: "manual" });
    expect(harness.notifications[0]?.message).toBe("pruner: nothing pending — no batches to summarize");
  });
});

describe("/pruner status context block", () => {
  const metrics: ContextMetricsSnapshot = {
    openCycleThinkingTokens: 12000,
    largestChainSharePct: 62,
    frontierGapTokens: 195000,
  };

  it("renders the --- context --- block with all three metrics", async () => {
    const harness = setupPrunerCommand({ getContextMetrics: () => metrics, getRearmed: () => false });
    await harness.run("status");

    const text = harness.notifications[0]?.message ?? "";
    expect(text).toContain("--- context ---");
    expect(text).toContain("thinking:     12.0k tokens (open segment)");
    expect(text).toContain("chain share:  62%");
    expect(text).toContain("frontier gap: 195.0k tokens");
  });

  it("appends the rearmed: line only when getRearmed() is true", async () => {
    const armed = setupPrunerCommand({ getContextMetrics: () => metrics, getRearmed: () => true });
    await armed.run("status");
    expect(armed.notifications[0]?.message).toContain("rearmed:      yes");

    const notArmed = setupPrunerCommand({ getContextMetrics: () => metrics, getRearmed: () => false });
    await notArmed.run("status");
    expect(notArmed.notifications[0]?.message).not.toContain("rearmed:");
  });

  it("omits the context block entirely when getContextMetrics is unwired", async () => {
    const harness = setupPrunerCommand();
    await harness.run("status");
    expect(harness.notifications[0]?.message).not.toContain("--- context ---");
  });
});

describe("setPruneStatusWidget", () => {
  it("writes exactly prune: on when enabled and visible", () => {
    const setStatus = mock();
    setPruneStatusWidget({ ui: { setStatus } }, { ...DEFAULT_CONFIG, enabled: true, showPruneStatusLine: true });
    expect(setStatus.mock.calls).toEqual([[STATUS_WIDGET_ID, "prune: on"]]);
  });

  it("clears the status when disabled or hidden", () => {
    for (const config of [
      { enabled: false, showPruneStatusLine: true },
      { enabled: true, showPruneStatusLine: false },
      { enabled: false, showPruneStatusLine: false },
    ]) {
      const setStatus = mock();
      const ctx = { ui: { setStatus } };
      setPruneStatusWidget(ctx, { ...DEFAULT_CONFIG, ...config });
      expect(setStatus.mock.calls).toEqual([[STATUS_WIDGET_ID, undefined]]);
    }
  });
});
