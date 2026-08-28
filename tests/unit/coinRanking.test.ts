import { describe, expect, it } from "vitest";

import {
  DEFAULT_RANKING_WEIGHTS,
  formatTopCoinsTelegramAlert,
  rankCoinsNow,
  tuneRankingWeights,
  type CoinCandidate,
} from "@/lib/coin-alerts/ranking";

const nowMs = Date.UTC(2026, 7, 28, 2, 0, 0);

const toHistory = (points: Array<[number, number]>) =>
  points.map(([minutesAgo, value]) => ({
    timestampMs: nowMs - minutesAgo * 60 * 1000,
    value,
  }));

const makeCoin = (input: Partial<CoinCandidate> & Pick<CoinCandidate, "id" | "symbol">): CoinCandidate => ({
  id: input.id,
  symbol: input.symbol,
  marketCapUsd: input.marketCapUsd ?? 1_000_000,
  liquidityUsd: input.liquidityUsd ?? 70_000,
  volume1hUsd: input.volume1hUsd ?? 30_000,
  contractAgeHours: input.contractAgeHours ?? 72,
  buyTaxBps: input.buyTaxBps ?? 200,
  sellTaxBps: input.sellTaxBps ?? 200,
  isHoneypotSuspected: input.isHoneypotSuspected ?? false,
  isRugSuspected: input.isRugSuspected ?? false,
  hasSuspiciousTokenomics: input.hasSuspiciousTokenomics ?? false,
  priceHistory:
    input.priceHistory ??
    toHistory([
      [240, 1.0],
      [60, 1.2],
      [15, 1.28],
      [0, 1.3],
    ]),
  volumeHistory:
    input.volumeHistory ??
    toHistory([
      [240, 8_000],
      [60, 14_000],
      [15, 22_000],
      [0, 28_000],
    ]),
  socialMentionsHistory:
    input.socialMentionsHistory ??
    toHistory([
      [240, 50],
      [60, 90],
      [15, 130],
      [0, 160],
    ]),
  holderHistory:
    input.holderHistory ??
    toHistory([
      [240, 2_000],
      [60, 2_080],
      [15, 2_120],
      [0, 2_140],
    ]),
});

describe("coin ranking", () => {
  it("filters high risk candidates before ranking", () => {
    const safe = makeCoin({ id: "safe-1", symbol: "SAFE" });
    const honeypot = makeCoin({
      id: "bad-1",
      symbol: "SCAM",
      isHoneypotSuspected: true,
    });
    const lowLiquidity = makeCoin({
      id: "bad-2",
      symbol: "DRY",
      liquidityUsd: 500,
    });

    const result = rankCoinsNow([safe, honeypot, lowLiquidity], { nowMs, timeZone: "America/New_York" });

    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0]?.symbol).toBe("SAFE");
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: "SCAM", reason: "honeypot risk" }),
        expect.objectContaining({ symbol: "DRY", reason: "liquidity too low" }),
      ])
    );
  });

  it("returns top 3 ordered by score and includes timezone-local evaluation time", () => {
    const alpha = makeCoin({ id: "alpha", symbol: "ALPHA" });
    const beta = makeCoin({
      id: "beta",
      symbol: "BETA",
      volumeHistory: toHistory([
        [240, 10_000],
        [60, 12_000],
        [15, 13_500],
        [0, 14_500],
      ]),
      socialMentionsHistory: toHistory([
        [240, 120],
        [60, 130],
        [15, 136],
        [0, 140],
      ]),
    });
    const gamma = makeCoin({
      id: "gamma",
      symbol: "GAMMA",
      liquidityUsd: 120_000,
      marketCapUsd: 3_000_000,
    });
    const delta = makeCoin({
      id: "delta",
      symbol: "DELTA",
      marketCapUsd: 180_000_000,
      volumeHistory: toHistory([
        [240, 4_000],
        [60, 7_000],
        [15, 10_000],
        [0, 11_000],
      ]),
    });

    const result = rankCoinsNow([beta, alpha, gamma, delta], {
      nowMs,
      timeZone: "America/Sao_Paulo",
      topN: 3,
    });

    expect(result.ranked).toHaveLength(3);
    expect(result.ranked[0]!.score).toBeGreaterThanOrEqual(result.ranked[1]!.score);
    expect(result.ranked[1]!.score).toBeGreaterThanOrEqual(result.ranked[2]!.score);
    expect(result.evaluatedAtLocal).toContain("GMT-3");
  });

  it("formats a ranked telegram alert with scores, key drivers, and risks", () => {
    const result = rankCoinsNow(
      [
        makeCoin({ id: "a", symbol: "A", buyTaxBps: 900, sellTaxBps: 900, contractAgeHours: 18 }),
        makeCoin({ id: "b", symbol: "B" }),
      ],
      { nowMs, timeZone: "UTC" }
    );

    const alert = formatTopCoinsTelegramAlert(result);

    expect(alert.lines.length).toBeGreaterThan(0);
    expect(alert.message).toContain("Top coins now");
    expect(alert.message).toContain("score");
    expect(alert.message).toContain("•");
  });

  it("tunes weights from outcomes and keeps them normalized", () => {
    const tuned = tuneRankingWeights(DEFAULT_RANKING_WEIGHTS, [
      {
        signalScore: { momentum: 0.9, volumeSpike: 0.8, safety: 0.6 },
        return1hPct: 8,
        return4hPct: 14,
        return24hPct: 22,
      },
      {
        signalScore: { momentum: 0.2, volumeSpike: 0.1, safety: 0.9 },
        return1hPct: -4,
        return4hPct: -3,
        return24hPct: -2,
      },
    ]);

    const total = Object.values(tuned).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(tuned.momentum).toBeGreaterThan(DEFAULT_RANKING_WEIGHTS.momentum * 0.9);
    expect(tuned.volumeSpike).toBeGreaterThan(DEFAULT_RANKING_WEIGHTS.volumeSpike * 0.9);
  });
});
