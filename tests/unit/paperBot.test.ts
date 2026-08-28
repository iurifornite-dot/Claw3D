import { describe, expect, it } from "vitest";

import {
  createInitialPaperBotState,
  getPaperReadiness,
  runPaperBotTick,
  startBot,
  validateLiveGuardrails,
  type PaperBotConfig,
} from "@/lib/trading/paperBot";

const baseConfig = (): PaperBotConfig => ({
  symbol: "FOMO/USD",
  mode: "paper",
  startingCapital: 100,
  strategy: {
    shortWindow: 2,
    longWindow: 3,
  },
  risk: {
    maxPositionFraction: 0.1,
    stopLossPercent: 0.01,
    maxDailyLossPercent: 0.05,
    maxConsecutiveLosses: 3,
  },
  guardrails: {
    apiTradeOnly: true,
    apiWithdrawalsDisabled: true,
    apiIpAllowlistEnabled: true,
  },
});

describe("paper bot", () => {
  it("opens a position after an upward trend buy signal", () => {
    const startAt = "2026-01-01T10:00:00.000Z";
    const initial = createInitialPaperBotState(baseConfig(), 100, startAt);
    let state = startBot(initial, startAt);

    state = runPaperBotTick(state, { marketPrice: 101, timestamp: "2026-01-01T10:00:01.000Z" });
    state = runPaperBotTick(state, { marketPrice: 102, timestamp: "2026-01-01T10:00:02.000Z" });

    expect(state.openPosition).not.toBeNull();
    expect(state.lastSignal).toBe("buy");
  });

  it("triggers stop loss and shuts down at max consecutive losses", () => {
    const config = baseConfig();
    config.risk.maxConsecutiveLosses = 1;

    let state = createInitialPaperBotState(config, 100, "2026-01-01T10:00:00.000Z");
    state = startBot(state, "2026-01-01T10:00:00.500Z");
    state = runPaperBotTick(state, { marketPrice: 101, timestamp: "2026-01-01T10:00:01.000Z" });
    state = runPaperBotTick(state, { marketPrice: 102, timestamp: "2026-01-01T10:00:02.000Z" });
    state = runPaperBotTick(state, { marketPrice: 99, timestamp: "2026-01-01T10:00:03.000Z" });

    expect(state.openPosition).toBeNull();
    expect(state.isShutdown).toBe(true);
    expect(state.shutdownReason).toContain("consecutive losses");
  });

  it("enforces the daily loss cap and auto-shuts down", () => {
    const config = baseConfig();
    config.risk.maxPositionFraction = 0.2;
    config.risk.stopLossPercent = 0.2;
    config.risk.maxDailyLossPercent = 0.005;

    let state = createInitialPaperBotState(config, 100, "2026-01-01T10:00:00.000Z");
    state = startBot(state, "2026-01-01T10:00:00.500Z");
    state = runPaperBotTick(state, { marketPrice: 101, timestamp: "2026-01-01T10:00:01.000Z" });
    state = runPaperBotTick(state, { marketPrice: 102, timestamp: "2026-01-01T10:00:02.000Z" });
    state = runPaperBotTick(state, { marketPrice: 96.5, timestamp: "2026-01-01T10:00:03.000Z" });

    expect(state.isShutdown).toBe(true);
    expect(state.shutdownReason).toContain("daily loss limit");
  });

  it("flags missing live guardrails", () => {
    const failures = validateLiveGuardrails({
      apiTradeOnly: false,
      apiWithdrawalsDisabled: false,
      apiIpAllowlistEnabled: true,
    });

    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("trading only");
  });

  it("requires enough paper performance before live readiness", () => {
    const state = createInitialPaperBotState(baseConfig(), 100, "2026-01-01T10:00:00.000Z");
    const readiness = getPaperReadiness(state);

    expect(readiness.isReady).toBe(false);
    expect(readiness.reasons.length).toBeGreaterThan(0);
  });
});
