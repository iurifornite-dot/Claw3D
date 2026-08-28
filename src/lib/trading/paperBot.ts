export type TradeSignal = "buy" | "sell" | "hold";

export type BotMode = "paper" | "live";

export type TradeLogKind =
  | "signal"
  | "open"
  | "close"
  | "shutdown"
  | "bot"
  | "risk";

export type TradeLogEntry = {
  id: string;
  at: string;
  kind: TradeLogKind;
  message: string;
};

export type ClosedTrade = {
  id: string;
  openedAt: string;
  closedAt: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  reason: "signal" | "stop-loss" | "daily-loss-limit" | "emergency";
};

export type OpenPosition = {
  id: string;
  openedAt: string;
  entryPrice: number;
  quantity: number;
  stopLossPrice: number;
};

export type RiskConfig = {
  maxPositionFraction: number;
  stopLossPercent: number;
  maxDailyLossPercent: number;
  maxConsecutiveLosses: number;
};

export type StrategyConfig = {
  shortWindow: number;
  longWindow: number;
};

export type GuardrailConfig = {
  apiTradeOnly: boolean;
  apiWithdrawalsDisabled: boolean;
  apiIpAllowlistEnabled: boolean;
};

export type PaperBotConfig = {
  symbol: string;
  mode: BotMode;
  startingCapital: number;
  risk: RiskConfig;
  strategy: StrategyConfig;
  guardrails: GuardrailConfig;
};

export type PaperBotState = {
  config: PaperBotConfig;
  isRunning: boolean;
  isShutdown: boolean;
  shutdownReason: string | null;
  balance: number;
  equity: number;
  marketPrice: number;
  priceHistory: number[];
  openPosition: OpenPosition | null;
  closedTrades: ClosedTrade[];
  logs: TradeLogEntry[];
  lastSignal: TradeSignal;
  consecutiveLosses: number;
  dayStartedAt: string;
  dayStartingBalance: number;
};

type TickInput = {
  timestamp: string;
  marketPrice: number;
};

const MAX_PRICE_HISTORY = 250;
const MAX_CLOSED_TRADES = 500;

const nextId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const pushLog = (state: PaperBotState, kind: TradeLogKind, message: string, at: string): PaperBotState => ({
  ...state,
  logs: [{ id: nextId(), at, kind, message }, ...state.logs].slice(0, 300),
});

const pnlForPosition = (position: OpenPosition, marketPrice: number): number =>
  (marketPrice - position.entryPrice) * position.quantity;

const withUpdatedEquity = (state: PaperBotState, marketPrice: number): PaperBotState => {
  const unrealized = state.openPosition ? pnlForPosition(state.openPosition, marketPrice) : 0;
  const equity = Number((state.balance + unrealized).toFixed(2));
  return {
    ...state,
    equity,
    marketPrice,
  };
};

const computeSignal = (prices: number[], config: StrategyConfig): TradeSignal => {
  if (prices.length < config.longWindow) return "hold";
  const shortSlice = prices.slice(-config.shortWindow);
  const longSlice = prices.slice(-config.longWindow);
  const shortAvg = shortSlice.reduce((sum, value) => sum + value, 0) / shortSlice.length;
  const longAvg = longSlice.reduce((sum, value) => sum + value, 0) / longSlice.length;
  if (shortAvg > longAvg * 1.002) return "buy";
  if (shortAvg < longAvg * 0.998) return "sell";
  return "hold";
};

const ensureDailyReset = (state: PaperBotState, timestamp: string): PaperBotState => {
  const dayKey = timestamp.slice(0, 10);
  const runningKey = state.dayStartedAt.slice(0, 10);
  if (dayKey === runningKey) return state;
  return {
    ...state,
    dayStartedAt: timestamp,
    dayStartingBalance: state.equity,
    consecutiveLosses: 0,
  };
};

const closeOpenPosition = (
  state: PaperBotState,
  timestamp: string,
  price: number,
  reason: ClosedTrade["reason"],
): PaperBotState => {
  if (!state.openPosition) return state;
  const openPosition = state.openPosition;
  const pnl = Number(pnlForPosition(openPosition, price).toFixed(2));
  const updatedBalance = Number((state.balance + pnl).toFixed(2));
  const closedTrade: ClosedTrade = {
    id: openPosition.id,
    openedAt: openPosition.openedAt,
    closedAt: timestamp,
    entryPrice: openPosition.entryPrice,
    exitPrice: price,
    quantity: openPosition.quantity,
    pnl,
    reason,
  };

  const nextConsecutiveLosses = pnl < 0 ? state.consecutiveLosses + 1 : 0;

  let nextState: PaperBotState = {
    ...state,
    balance: updatedBalance,
    equity: updatedBalance,
    openPosition: null,
    closedTrades: [closedTrade, ...state.closedTrades].slice(0, MAX_CLOSED_TRADES),
    consecutiveLosses: nextConsecutiveLosses,
  };

  nextState = pushLog(
    nextState,
    "close",
    `Closed ${state.config.symbol} at ${price.toFixed(4)} (${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USD, ${reason}).`,
    timestamp,
  );

  if (nextState.consecutiveLosses >= state.config.risk.maxConsecutiveLosses) {
    const shutdownReason = `Auto-shutdown: ${nextState.consecutiveLosses} consecutive losses reached.`;
    nextState = {
      ...nextState,
      isRunning: false,
      isShutdown: true,
      shutdownReason,
    };
    nextState = pushLog(nextState, "shutdown", shutdownReason, timestamp);
  }

  return nextState;
};

const openPosition = (state: PaperBotState, timestamp: string, price: number): PaperBotState => {
  if (state.openPosition || !state.isRunning || state.isShutdown) return state;
  const spend = Number((state.equity * clamp(state.config.risk.maxPositionFraction, 0.001, 0.2)).toFixed(2));
  const quantity = Number((spend / price).toFixed(6));
  if (quantity <= 0) {
    return pushLog(state, "risk", "Skipped order: calculated quantity was zero.", timestamp);
  }

  const stopLossPrice = Number((price * (1 - clamp(state.config.risk.stopLossPercent, 0.001, 0.25))).toFixed(4));
  const position: OpenPosition = {
    id: nextId(),
    openedAt: timestamp,
    entryPrice: price,
    quantity,
    stopLossPrice,
  };

  const nextState = {
    ...state,
    openPosition: position,
  };

  return pushLog(
    nextState,
    "open",
    `Opened ${state.config.symbol}: qty ${quantity.toFixed(6)} at ${price.toFixed(4)} (stop ${stopLossPrice.toFixed(4)}).`,
    timestamp,
  );
};

const enforceDailyLossLimit = (state: PaperBotState, timestamp: string): PaperBotState => {
  const baseline = state.dayStartingBalance;
  if (baseline <= 0) return state;
  const drawdown = (baseline - state.equity) / baseline;
  if (drawdown < state.config.risk.maxDailyLossPercent) return state;

  const closedState = closeOpenPosition(state, timestamp, state.marketPrice, "daily-loss-limit");
  const shutdownReason = `Auto-shutdown: daily loss limit hit (${(drawdown * 100).toFixed(2)}%).`;
  return pushLog(
    {
      ...closedState,
      isRunning: false,
      isShutdown: true,
      shutdownReason,
    },
    "shutdown",
    shutdownReason,
    timestamp,
  );
};

export const validateLiveGuardrails = (guardrails: GuardrailConfig): string[] => {
  const failures: string[] = [];
  if (!guardrails.apiTradeOnly) failures.push("API key must be restricted to trading only.");
  if (!guardrails.apiWithdrawalsDisabled) failures.push("API key must have withdrawals disabled.");
  if (!guardrails.apiIpAllowlistEnabled) failures.push("API key must be bound to an IP allowlist.");
  return failures;
};

export const createInitialPaperBotState = (
  config: PaperBotConfig,
  marketPrice: number,
  timestamp: string,
): PaperBotState => ({
  config,
  isRunning: false,
  isShutdown: false,
  shutdownReason: null,
  balance: Number(config.startingCapital.toFixed(2)),
  equity: Number(config.startingCapital.toFixed(2)),
  marketPrice,
  priceHistory: [marketPrice],
  openPosition: null,
  closedTrades: [],
  logs: [
    {
      id: nextId(),
      at: timestamp,
      kind: "bot",
      message: `Initialized ${config.mode.toUpperCase()} bot for ${config.symbol}.`,
    },
  ],
  lastSignal: "hold",
  consecutiveLosses: 0,
  dayStartedAt: timestamp,
  dayStartingBalance: Number(config.startingCapital.toFixed(2)),
});

export const startBot = (state: PaperBotState, timestamp: string): PaperBotState => {
  if (state.isShutdown || state.isRunning) return state;
  return pushLog(
    {
      ...state,
      isRunning: true,
      shutdownReason: null,
    },
    "bot",
    `Bot started in ${state.config.mode.toUpperCase()} mode.`,
    timestamp,
  );
};

export const stopBot = (state: PaperBotState, timestamp: string): PaperBotState => {
  if (!state.isRunning) return state;
  return pushLog(
    {
      ...state,
      isRunning: false,
    },
    "bot",
    "Bot stopped manually.",
    timestamp,
  );
};

export const emergencyCloseAll = (state: PaperBotState, timestamp: string): PaperBotState => {
  const closedState = closeOpenPosition(state, timestamp, state.marketPrice, "emergency");
  return pushLog(closedState, "risk", "Emergency close-all executed.", timestamp);
};

export const runPaperBotTick = (state: PaperBotState, input: TickInput): PaperBotState => {
  let nextState = ensureDailyReset(state, input.timestamp);
  const nextPriceHistory = [...nextState.priceHistory, input.marketPrice].slice(-MAX_PRICE_HISTORY);

  nextState = withUpdatedEquity(
    {
      ...nextState,
      priceHistory: nextPriceHistory,
    },
    input.marketPrice,
  );

  const signal = computeSignal(nextState.priceHistory, nextState.config.strategy);

  if (signal !== "hold") {
    nextState = pushLog(
      {
        ...nextState,
        lastSignal: signal,
      },
      "signal",
      `${signal.toUpperCase()} signal at ${input.marketPrice.toFixed(4)}.`,
      input.timestamp,
    );
  } else {
    nextState = {
      ...nextState,
      lastSignal: signal,
    };
  }

  if (nextState.isShutdown) {
    return nextState;
  }

  if (!nextState.isRunning) {
    return nextState;
  }

  if (nextState.openPosition && input.marketPrice <= nextState.openPosition.stopLossPrice) {
    nextState = closeOpenPosition(nextState, input.timestamp, input.marketPrice, "stop-loss");
  }

  if (nextState.isRunning && !nextState.isShutdown) {
    if (signal === "buy" && !nextState.openPosition) {
      nextState = openPosition(nextState, input.timestamp, input.marketPrice);
    } else if (signal === "sell" && nextState.openPosition) {
      nextState = closeOpenPosition(nextState, input.timestamp, input.marketPrice, "signal");
    }
  }

  return enforceDailyLossLimit(nextState, input.timestamp);
};

export const getPaperReadiness = (state: PaperBotState): {
  isReady: boolean;
  reasons: string[];
} => {
  const reasons: string[] = [];
  const closedCount = state.closedTrades.length;
  if (closedCount < 15) reasons.push("Need at least 15 closed paper trades.");

  const wins = state.closedTrades.filter((trade) => trade.pnl > 0).length;
  const winRate = closedCount > 0 ? wins / closedCount : 0;
  if (winRate < 0.55) reasons.push("Win rate must be at least 55%.");

  const totalPnl = state.closedTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  if (totalPnl <= 0) reasons.push("Net paper P/L must be positive.");

  const maxLoss = state.closedTrades.reduce((worst, trade) => Math.min(worst, trade.pnl), 0);
  if (Math.abs(maxLoss) > state.config.startingCapital * 0.05) {
    reasons.push("Largest single-trade loss must stay within 5% of starting capital.");
  }

  return {
    isReady: reasons.length === 0,
    reasons,
  };
};
