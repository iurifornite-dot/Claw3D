export type NumericPoint = {
  timestampMs: number;
  value: number;
};

export type CoinCandidate = {
  id: string;
  symbol: string;
  marketCapUsd: number;
  liquidityUsd: number;
  volume1hUsd: number;
  contractAgeHours: number;
  buyTaxBps?: number;
  sellTaxBps?: number;
  isHoneypotSuspected?: boolean;
  isRugSuspected?: boolean;
  hasSuspiciousTokenomics?: boolean;
  priceHistory: NumericPoint[];
  volumeHistory: NumericPoint[];
  socialMentionsHistory: NumericPoint[];
  holderHistory: NumericPoint[];
};

export type RankingWeights = {
  volumeSpike: number;
  momentum: number;
  liquidity: number;
  marketCap: number;
  socialTrend: number;
  holderGrowth: number;
  safety: number;
};

export type RankingFilters = {
  minLiquidityUsd: number;
  minVolume1hUsd: number;
  minContractAgeHours: number;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  maxTaxBps: number;
  preferredMarketCapMinUsd: number;
  preferredMarketCapMaxUsd: number;
};

export type RollingWindow = {
  label: "15m" | "1h" | "4h";
  durationMs: number;
};

export type RankedCoin = {
  id: string;
  symbol: string;
  score: number;
  evaluatedAtLocal: string;
  keyDrivers: string[];
  riskFlags: string[];
};

export type RankingResult = {
  timeZone: string;
  evaluatedAtMs: number;
  evaluatedAtLocal: string;
  ranked: RankedCoin[];
  excluded: Array<{ id: string; symbol: string; reason: string }>;
};

export type CoinAlertLine = {
  symbol: string;
  score: number;
  keyDrivers: string[];
  riskFlags: string[];
};

export type TelegramTopCoinsAlert = {
  timeZone: string;
  generatedAtLocal: string;
  lines: CoinAlertLine[];
  message: string;
};

export type PerformanceOutcome = {
  signalScore: Partial<Record<keyof RankingWeights, number>>;
  return1hPct: number;
  return4hPct: number;
  return24hPct: number;
};

const DEFAULT_WINDOWS: RollingWindow[] = [
  { label: "15m", durationMs: 15 * 60 * 1000 },
  { label: "1h", durationMs: 60 * 60 * 1000 },
  { label: "4h", durationMs: 4 * 60 * 60 * 1000 },
];

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  volumeSpike: 0.26,
  momentum: 0.22,
  liquidity: 0.16,
  marketCap: 0.1,
  socialTrend: 0.1,
  holderGrowth: 0.08,
  safety: 0.08,
};

export const DEFAULT_RANKING_FILTERS: RankingFilters = {
  minLiquidityUsd: 25_000,
  minVolume1hUsd: 15_000,
  minContractAgeHours: 12,
  minMarketCapUsd: 100_000,
  maxMarketCapUsd: 200_000_000,
  maxTaxBps: 1_200,
  preferredMarketCapMinUsd: 250_000,
  preferredMarketCapMaxUsd: 50_000_000,
};

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const normalizeLinear = (value: number, min: number, max: number) => {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0;
  return clamp((value - min) / (max - min), 0, 1);
};

const sortPoints = (points: NumericPoint[]) =>
  [...points]
    .filter((point) => Number.isFinite(point.timestampMs) && Number.isFinite(point.value))
    .sort((a, b) => a.timestampMs - b.timestampMs);

const getValueAtOrBefore = (points: NumericPoint[], timestampMs: number): number | null => {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index].timestampMs <= timestampMs) return points[index].value;
  }
  return null;
};

const getWindowChangePct = (
  rawPoints: NumericPoint[],
  nowMs: number,
  durationMs: number
): number | null => {
  const points = sortPoints(rawPoints);
  if (points.length < 2) return null;
  const endValue = getValueAtOrBefore(points, nowMs);
  const startValue = getValueAtOrBefore(points, nowMs - durationMs);
  if (endValue === null || startValue === null || startValue <= 0) return null;
  return ((endValue - startValue) / startValue) * 100;
};

const getWeightedWindowChange = (history: NumericPoint[], nowMs: number): { pct: number; best: string } => {
  const weightsByLabel: Record<RollingWindow["label"], number> = { "15m": 0.5, "1h": 0.3, "4h": 0.2 };
  let total = 0;
  let weighted = 0;
  let bestLabel: RollingWindow["label"] = "15m";
  let bestChange = Number.NEGATIVE_INFINITY;
  for (const window of DEFAULT_WINDOWS) {
    const change = getWindowChangePct(history, nowMs, window.durationMs);
    if (change === null) continue;
    const weight = weightsByLabel[window.label];
    weighted += change * weight;
    total += weight;
    if (change > bestChange) {
      bestChange = change;
      bestLabel = window.label;
    }
  }
  return { pct: total > 0 ? weighted / total : 0, best: bestLabel };
};

const formatPct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

const formatLocalDateTime = (timestampMs: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(new Date(timestampMs));

const resolveTaxBps = (coin: CoinCandidate) =>
  Math.max(coin.buyTaxBps ?? 0, coin.sellTaxBps ?? 0);

const resolveHardFilterFailure = (coin: CoinCandidate, filters: RankingFilters): string | null => {
  if (coin.isHoneypotSuspected) return "honeypot risk";
  if (coin.isRugSuspected) return "rug-pull risk";
  if (coin.hasSuspiciousTokenomics) return "suspicious tokenomics";
  if (coin.liquidityUsd < filters.minLiquidityUsd) return "liquidity too low";
  if (coin.volume1hUsd < filters.minVolume1hUsd) return "1h volume too low";
  if (coin.contractAgeHours < filters.minContractAgeHours) return "contract too new";
  if (coin.marketCapUsd < filters.minMarketCapUsd) return "market cap too low";
  if (coin.marketCapUsd > filters.maxMarketCapUsd) return "market cap too high";
  if (resolveTaxBps(coin) > filters.maxTaxBps) return "tax/slippage too high";
  return null;
};

const getMarketCapScore = (coin: CoinCandidate, filters: RankingFilters) => {
  const cap = coin.marketCapUsd;
  if (cap >= filters.preferredMarketCapMinUsd && cap <= filters.preferredMarketCapMaxUsd) return 1;
  const span = Math.max(filters.preferredMarketCapMaxUsd - filters.preferredMarketCapMinUsd, 1);
  if (cap < filters.preferredMarketCapMinUsd) {
    return clamp(1 - (filters.preferredMarketCapMinUsd - cap) / span, 0, 1);
  }
  return clamp(1 - (cap - filters.preferredMarketCapMaxUsd) / span, 0, 1);
};

const mean = (values: number[]) => {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const buildRiskFlags = (coin: CoinCandidate, filters: RankingFilters): string[] => {
  const flags: string[] = [];
  const taxBps = resolveTaxBps(coin);
  if (taxBps > filters.maxTaxBps * 0.75) {
    flags.push(`elevated tax (${(taxBps / 100).toFixed(2)}%)`);
  }
  if (coin.contractAgeHours < filters.minContractAgeHours * 2) {
    flags.push(`young contract (${coin.contractAgeHours.toFixed(1)}h old)`);
  }
  return flags;
};

const getScoreComponents = (
  coin: CoinCandidate,
  filters: RankingFilters,
  evaluatedAtMs: number
): {
  components: RankingWeights;
  driverDetailsByComponent: Record<keyof RankingWeights, string>;
  riskFlags: string[];
} => {
  const volumeChange = getWeightedWindowChange(coin.volumeHistory, evaluatedAtMs);
  const momentumChange = getWeightedWindowChange(coin.priceHistory, evaluatedAtMs);
  const socialChange = getWeightedWindowChange(coin.socialMentionsHistory, evaluatedAtMs);
  const holderChange = getWeightedWindowChange(coin.holderHistory, evaluatedAtMs);

  const volumeSpike = normalizeLinear(volumeChange.pct, 0, 300);
  const momentum = normalizeLinear(momentumChange.pct, -20, 80);
  const socialTrend = normalizeLinear(socialChange.pct, 0, 250);
  const holderGrowth = normalizeLinear(holderChange.pct, 0, 40);
  const liquidity = normalizeLinear(
    coin.liquidityUsd,
    filters.minLiquidityUsd,
    Math.max(filters.minLiquidityUsd * 3, filters.preferredMarketCapMinUsd)
  );
  const marketCap = getMarketCapScore(coin, filters);

  let safety = 1;
  if (coin.hasSuspiciousTokenomics) safety -= 0.35;
  if (coin.isRugSuspected) safety -= 0.5;
  if (coin.isHoneypotSuspected) safety -= 0.7;
  safety = clamp(safety, 0, 1);

  const driverDetailsByComponent: Record<keyof RankingWeights, string> = {
    volumeSpike: `volume ${formatPct(volumeChange.pct)} (${volumeChange.best})`,
    momentum: `momentum ${formatPct(momentumChange.pct)} (${momentumChange.best})`,
    socialTrend: `social ${formatPct(socialChange.pct)} (${socialChange.best})`,
    holderGrowth: `holders ${formatPct(holderChange.pct)} (${holderChange.best})`,
    liquidity: `liquidity $${coin.liquidityUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    marketCap: `market cap $${coin.marketCapUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    safety: "safety checks passed",
  };

  return {
    components: { volumeSpike, momentum, liquidity, marketCap, socialTrend, holderGrowth, safety },
    driverDetailsByComponent,
    riskFlags: buildRiskFlags(coin, filters),
  };
};

type RankOptions = {
  nowMs?: number;
  timeZone?: string;
  topN?: number;
  filters?: Partial<RankingFilters>;
  weights?: Partial<RankingWeights>;
};

const mergeWeights = (weights?: Partial<RankingWeights>): RankingWeights => ({
  ...DEFAULT_RANKING_WEIGHTS,
  ...(weights ?? {}),
});

const mergeFilters = (filters?: Partial<RankingFilters>): RankingFilters => ({
  ...DEFAULT_RANKING_FILTERS,
  ...(filters ?? {}),
});

const calculateWeightedScore = (components: RankingWeights, weights: RankingWeights) => {
  const entries = Object.entries(weights) as Array<[keyof RankingWeights, number]>;
  const denominator = entries.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
  if (denominator <= 0) return 0;
  const numerator = entries.reduce(
    (sum, [key, weight]) => sum + components[key] * Math.max(0, weight),
    0
  );
  return clamp(numerator / denominator, 0, 1);
};

export const rankCoinsNow = (coins: CoinCandidate[], options: RankOptions = {}): RankingResult => {
  const evaluatedAtMs = options.nowMs ?? Date.now();
  const timeZone = options.timeZone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const topN = Math.max(1, Math.floor(options.topN ?? 3));
  const weights = mergeWeights(options.weights);
  const filters = mergeFilters(options.filters);

  const rankedRaw: Array<RankedCoin & { _scoreComponents: RankingWeights }> = [];
  const excluded: RankingResult["excluded"] = [];

  for (const coin of coins) {
    const failure = resolveHardFilterFailure(coin, filters);
    if (failure) {
      excluded.push({ id: coin.id, symbol: coin.symbol, reason: failure });
      continue;
    }

    const detail = getScoreComponents(coin, filters, evaluatedAtMs);
    const score = calculateWeightedScore(detail.components, weights);
    const driverEntries = Object.entries(detail.components) as Array<[keyof RankingWeights, number]>;
    const topDrivers = driverEntries
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([key]) => detail.driverDetailsByComponent[key]);

    rankedRaw.push({
      id: coin.id,
      symbol: coin.symbol,
      score,
      keyDrivers: topDrivers,
      riskFlags: detail.riskFlags,
      evaluatedAtLocal: formatLocalDateTime(evaluatedAtMs, timeZone),
      _scoreComponents: detail.components,
    });
  }

  const ranked = rankedRaw
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((coin) => ({
      id: coin.id,
      symbol: coin.symbol,
      score: coin.score,
      keyDrivers: coin.keyDrivers,
      riskFlags: coin.riskFlags,
      evaluatedAtLocal: coin.evaluatedAtLocal,
    }));

  return {
    timeZone,
    evaluatedAtMs,
    evaluatedAtLocal: formatLocalDateTime(evaluatedAtMs, timeZone),
    ranked,
    excluded,
  };
};

export const formatTopCoinsTelegramAlert = (result: RankingResult): TelegramTopCoinsAlert => {
  const lines = result.ranked.map((coin) => ({
    symbol: coin.symbol,
    score: coin.score,
    keyDrivers: coin.keyDrivers,
    riskFlags: coin.riskFlags,
  }));

  const body = lines
    .map((line, index) => {
      const scorePct = `${Math.round(line.score * 100)} / 100`;
      const drivers = line.keyDrivers.length > 0 ? line.keyDrivers.join("; ") : "signal mix pending";
      const risk = line.riskFlags.length > 0 ? ` | ⚠ ${line.riskFlags.join(", ")}` : "";
      return `${index + 1}) ${line.symbol} — score ${scorePct}\n• ${drivers}${risk}`;
    })
    .join("\n\n");

  const message =
    lines.length === 0
      ? `Top coins now (${result.evaluatedAtLocal}):\nNo coins passed current risk filters.`
      : `Top coins now (${result.evaluatedAtLocal}):\n${body}`;

  return {
    timeZone: result.timeZone,
    generatedAtLocal: result.evaluatedAtLocal,
    lines,
    message,
  };
};

const normalizeWeights = (weights: RankingWeights): RankingWeights => {
  const entries = Object.entries(weights) as Array<[keyof RankingWeights, number]>;
  const sum = entries.reduce((acc, [, value]) => acc + Math.max(value, 0), 0);
  if (sum <= 0) return DEFAULT_RANKING_WEIGHTS;
  const normalizedEntries = entries.map(([key, value]) => [key, Math.max(value, 0) / sum] as const);
  return Object.fromEntries(normalizedEntries) as RankingWeights;
};

const resolveOutcomeReturn = (outcome: PerformanceOutcome) =>
  mean([outcome.return1hPct, outcome.return4hPct, outcome.return24hPct]);

export const tuneRankingWeights = (
  currentWeights: RankingWeights,
  outcomes: PerformanceOutcome[],
  learningRate = 0.04
): RankingWeights => {
  if (outcomes.length === 0) return normalizeWeights(currentWeights);

  const updated: RankingWeights = { ...currentWeights };
  const averageReturn = mean(outcomes.map(resolveOutcomeReturn));

  const keys = Object.keys(updated) as Array<keyof RankingWeights>;
  for (const key of keys) {
    const directionalScore = mean(
      outcomes.map((outcome) => {
        const exposure = clamp(outcome.signalScore[key] ?? 0, 0, 1);
        const returnDelta = resolveOutcomeReturn(outcome) - averageReturn;
        return exposure * returnDelta;
      })
    );

    updated[key] = Math.max(0, updated[key] + directionalScore * learningRate);
  }

  return normalizeWeights(updated);
};
