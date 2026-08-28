"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  createInitialPaperBotState,
  emergencyCloseAll,
  getPaperReadiness,
  runPaperBotTick,
  startBot,
  stopBot,
  validateLiveGuardrails,
  type BotMode,
  type PaperBotConfig,
  type PaperBotState,
} from "@/lib/trading/paperBot";
import { MinuteRateLimiter, retryWithBackoff } from "@/lib/trading/guardrails";

const STORAGE_KEY = "claw3d-paper-trading-dashboard";
const DEFAULT_PRICE = 100;

type AlertProvider = "telegram" | "discord";

type DashboardSettings = {
  provider: AlertProvider;
  webhookUrl: string;
};

const defaultConfig = (): PaperBotConfig => ({
  symbol: "FOMO/USD",
  mode: "paper",
  startingCapital: 100,
  strategy: {
    shortWindow: 6,
    longWindow: 18,
  },
  risk: {
    maxPositionFraction: 0.02,
    stopLossPercent: 0.015,
    maxDailyLossPercent: 0.03,
    maxConsecutiveLosses: 3,
  },
  guardrails: {
    apiTradeOnly: true,
    apiWithdrawalsDisabled: true,
    apiIpAllowlistEnabled: false,
  },
});

const createInitialState = (): PaperBotState =>
  createInitialPaperBotState(defaultConfig(), DEFAULT_PRICE, new Date().toISOString());

const nextPrice = (price: number): number => {
  const drift = (Math.random() * 2 - 1) * 0.0055;
  return Number(Math.max(1, price * (1 + drift)).toFixed(4));
};

const currency = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(
    value,
  );

const pct = (value: number) => `${(value * 100).toFixed(2)}%`;

const metricClass =
  "rounded-xl border border-border/70 bg-background/80 px-3 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/70";

export function PaperTradingDashboard() {
  const [state, setState] = useState<PaperBotState>(() => createInitialState());
  const [settings, setSettings] = useState<DashboardSettings>({
    provider: "telegram",
    webhookUrl: "",
  });
  const [statusMessage, setStatusMessage] = useState<string>("");

  const lastAlertedLogIdRef = useRef<string | null>(null);
  const alertRateLimiter = useRef(new MinuteRateLimiter(8));

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { state?: PaperBotState; settings?: DashboardSettings };
      if (parsed.state) {
        setState(parsed.state);
      }
      if (parsed.settings) {
        setSettings(parsed.settings);
      }
    } catch {
      // Ignore malformed local storage payload.
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, settings }));
  }, [state, settings]);

  useEffect(() => {
    if (!state.isRunning) return;
    const timer = window.setInterval(() => {
      setState((current) =>
        runPaperBotTick(current, {
          timestamp: new Date().toISOString(),
          marketPrice: nextPrice(current.marketPrice),
        }),
      );
    }, 1700);

    return () => {
      window.clearInterval(timer);
    };
  }, [state.isRunning]);

  const readiness = useMemo(() => getPaperReadiness(state), [state]);
  const guardrailFailures = useMemo(() => validateLiveGuardrails(state.config.guardrails), [state.config.guardrails]);

  useEffect(() => {
    const latest = state.logs[0];
    if (!latest) return;
    if (latest.id === lastAlertedLogIdRef.current) return;
    lastAlertedLogIdRef.current = latest.id;

    if (!["open", "close", "shutdown", "risk"].includes(latest.kind)) {
      return;
    }
    if (!settings.webhookUrl.trim()) {
      return;
    }
    if (!alertRateLimiter.current.allow()) {
      return;
    }

    void retryWithBackoff(
      async () => {
        const response = await fetch("/api/trading/alerts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: settings.provider,
            webhookUrl: settings.webhookUrl,
            message: `[${state.config.mode.toUpperCase()}] ${latest.message}`,
          }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? `Alert failed with status ${response.status}.`);
        }
      },
      {
        attempts: 3,
        baseDelayMs: 300,
      },
    ).catch((error) => {
      const message = error instanceof Error ? error.message : "Alert delivery failed.";
      setStatusMessage(`Alert delivery failed: ${message}`);
    });
  }, [settings.provider, settings.webhookUrl, state.config.mode, state.logs]);

  const closedPnl = useMemo(
    () => state.closedTrades.reduce((sum, trade) => Number((sum + trade.pnl).toFixed(2)), 0),
    [state.closedTrades],
  );

  const updateMode = (mode: BotMode) => {
    if (mode === "live") {
      if (!readiness.isReady) {
        setStatusMessage("Live mode is locked until paper results are stable.");
        return;
      }
      if (guardrailFailures.length > 0) {
        setStatusMessage("Live mode is locked until API key guardrails are complete.");
        return;
      }
    }

    setState((current) => ({
      ...current,
      config: {
        ...current.config,
        mode,
      },
      isRunning: false,
      isShutdown: false,
      shutdownReason: null,
      logs: [
        {
          id:
            typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `${Date.now()}-mode`,
          at: new Date().toISOString(),
          kind: "bot",
          message: `Switched mode to ${mode.toUpperCase()}.`,
        },
        ...current.logs,
      ].slice(0, 300),
    }));
    setStatusMessage("");
  };

  const resetBot = () => {
    const config: PaperBotConfig = {
      ...state.config,
      startingCapital: Number(state.config.startingCapital.toFixed(2)),
    };
    setState(createInitialPaperBotState(config, state.marketPrice, new Date().toISOString()));
    setStatusMessage("Session reset with current settings.");
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-md flex-col gap-3 overflow-y-auto p-3 pb-6 text-sm sm:max-w-2xl sm:text-base">
      <header className="rounded-xl border border-border bg-card/85 p-3 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight sm:text-xl">Mobile Paper Trading Bot</h1>
        <p className="text-muted-foreground">
          One strategy, low-capital risk controls, and webhook alerts for Telegram/Discord.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-2">
        <div className={metricClass}>
          <p className="text-xs text-muted-foreground">Balance</p>
          <p className="font-semibold">{currency(state.balance)}</p>
        </div>
        <div className={metricClass}>
          <p className="text-xs text-muted-foreground">Equity</p>
          <p className="font-semibold">{currency(state.equity)}</p>
        </div>
        <div className={metricClass}>
          <p className="text-xs text-muted-foreground">Closed P/L</p>
          <p className={`font-semibold ${closedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>{currency(closedPnl)}</p>
        </div>
        <div className={metricClass}>
          <p className="text-xs text-muted-foreground">Last Signal</p>
          <p className="font-semibold uppercase">{state.lastSignal}</p>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card/85 p-3 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold sm:text-base">Mode & Capital</h2>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className={`rounded-md border px-3 py-2 font-medium ${
              state.config.mode === "paper" ? "border-emerald-500 text-emerald-500" : "border-border"
            }`}
            onClick={() => updateMode("paper")}
          >
            Paper
          </button>
          <button
            type="button"
            className={`rounded-md border px-3 py-2 font-medium ${
              state.config.mode === "live" ? "border-amber-500 text-amber-500" : "border-border"
            }`}
            onClick={() => updateMode("live")}
          >
            Live (small size)
          </button>
        </div>
        <label className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
          Starting capital (USD)
          <input
            type="number"
            inputMode="decimal"
            min={25}
            max={500}
            step={5}
            value={state.config.startingCapital}
            disabled={state.isRunning}
            className="rounded-md border border-border bg-background px-2 py-2 text-foreground"
            onChange={(event) => {
              const value = Number(event.target.value);
              if (!Number.isFinite(value)) return;
              setState((current) => ({
                ...current,
                config: {
                  ...current.config,
                  startingCapital: Math.max(25, Math.min(500, value)),
                },
              }));
            }}
          />
        </label>
      </section>

      <section className="rounded-xl border border-border bg-card/85 p-3 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold sm:text-base">Controls</h2>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className={`rounded-md px-3 py-2 font-semibold text-white ${state.isRunning ? "bg-zinc-500" : "bg-emerald-600"}`}
            onClick={() => {
              if (state.isRunning) {
                setState((current) => stopBot(current, new Date().toISOString()));
              } else {
                setState((current) => startBot(current, new Date().toISOString()));
              }
              setStatusMessage("");
            }}
            disabled={state.isShutdown}
          >
            {state.isRunning ? "Stop Bot" : "Start Bot"}
          </button>
          <button
            type="button"
            className="rounded-md bg-red-600 px-3 py-2 font-semibold text-white"
            onClick={() => {
              setState((current) => emergencyCloseAll(current, new Date().toISOString()));
              setStatusMessage("Emergency close-all executed.");
            }}
          >
            Close All
          </button>
          <button
            type="button"
            className="col-span-2 rounded-md border border-border px-3 py-2"
            onClick={resetBot}
            disabled={state.isRunning}
          >
            Reset Session
          </button>
        </div>
        {state.shutdownReason ? <p className="mt-2 text-xs text-red-500">{state.shutdownReason}</p> : null}
        {statusMessage ? <p className="mt-2 text-xs text-muted-foreground">{statusMessage}</p> : null}
      </section>

      <section className="rounded-xl border border-border bg-card/85 p-3 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold sm:text-base">Risk Rules</h2>
        <ul className="space-y-1 text-xs text-muted-foreground">
          <li>Position size: {pct(state.config.risk.maxPositionFraction)} of equity per trade.</li>
          <li>Hard stop-loss: {pct(state.config.risk.stopLossPercent)} below entry.</li>
          <li>Daily loss cap: {pct(state.config.risk.maxDailyLossPercent)} auto-shutdown.</li>
          <li>Consecutive-loss cap: {state.config.risk.maxConsecutiveLosses} losses then shutdown.</li>
        </ul>
      </section>

      <section className="rounded-xl border border-border bg-card/85 p-3 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold sm:text-base">API Key Guardrails</h2>
        <div className="space-y-2 text-xs">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.config.guardrails.apiTradeOnly}
              onChange={(event) =>
                setState((current) => ({
                  ...current,
                  config: {
                    ...current.config,
                    guardrails: {
                      ...current.config.guardrails,
                      apiTradeOnly: event.target.checked,
                    },
                  },
                }))
              }
            />
            Trade-only API key
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.config.guardrails.apiWithdrawalsDisabled}
              onChange={(event) =>
                setState((current) => ({
                  ...current,
                  config: {
                    ...current.config,
                    guardrails: {
                      ...current.config.guardrails,
                      apiWithdrawalsDisabled: event.target.checked,
                    },
                  },
                }))
              }
            />
            Withdrawals disabled
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.config.guardrails.apiIpAllowlistEnabled}
              onChange={(event) =>
                setState((current) => ({
                  ...current,
                  config: {
                    ...current.config,
                    guardrails: {
                      ...current.config.guardrails,
                      apiIpAllowlistEnabled: event.target.checked,
                    },
                  },
                }))
              }
            />
            IP allowlist enabled
          </label>
        </div>
        {guardrailFailures.length > 0 ? (
          <ul className="mt-2 list-disc pl-4 text-xs text-amber-500">
            {guardrailFailures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-emerald-500">Guardrails passed.</p>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card/85 p-3 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold sm:text-base">Telegram / Discord Alerts</h2>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Provider
          <select
            value={settings.provider}
            className="rounded-md border border-border bg-background px-2 py-2 text-foreground"
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                provider: event.target.value === "discord" ? "discord" : "telegram",
              }))
            }
          >
            <option value="telegram">Telegram</option>
            <option value="discord">Discord</option>
          </select>
        </label>
        <label className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
          Webhook URL
          <input
            type="url"
            value={settings.webhookUrl}
            placeholder="https://..."
            className="rounded-md border border-border bg-background px-2 py-2 text-foreground"
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                webhookUrl: event.target.value,
              }))
            }
          />
        </label>
      </section>

      <section className="rounded-xl border border-border bg-card/85 p-3 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold sm:text-base">Paper Readiness Gate</h2>
        <p className={`text-xs ${readiness.isReady ? "text-emerald-500" : "text-amber-500"}`}>
          {readiness.isReady ? "Ready for tiny live capital scaling." : "Not ready for live mode yet."}
        </p>
        {readiness.reasons.length > 0 ? (
          <ul className="mt-2 list-disc pl-4 text-xs text-muted-foreground">
            {readiness.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="rounded-xl border border-border bg-card/85 p-3 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold sm:text-base">Open Position</h2>
        {state.openPosition ? (
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>Entry: {state.openPosition.entryPrice.toFixed(4)}</p>
            <p>Qty: {state.openPosition.quantity.toFixed(6)}</p>
            <p>Stop: {state.openPosition.stopLossPrice.toFixed(4)}</p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No open trade.</p>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card/85 p-3 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold sm:text-base">Trade Log</h2>
        <ul className="max-h-56 space-y-1 overflow-y-auto pr-1 text-xs">
          {state.logs.length === 0 ? <li className="text-muted-foreground">No events yet.</li> : null}
          {state.logs.map((entry) => (
            <li key={entry.id} className="rounded-md border border-border/60 px-2 py-1 text-muted-foreground">
              <span className="mr-1 font-semibold text-foreground">[{entry.kind}]</span>
              {entry.message}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
