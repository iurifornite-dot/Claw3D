import { NextResponse } from "next/server";

import { isPrivateOrLoopbackHostname } from "@/lib/security/urlSafety";
import { MinuteRateLimiter, retryWithBackoff } from "@/lib/trading/guardrails";

export const runtime = "nodejs";

type AlertRequestBody = {
  provider?: "telegram" | "discord";
  telegramChatId?: string;
  message?: string;
};

const MESSAGE_MAX_CHARS = 600;
const clientLimiters = new Map<string, { limiter: MinuteRateLimiter; lastSeenAt: number }>();

const limiterForRequest = (request: Request): MinuteRateLimiter => {
  const ip =
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    "unknown";
  const now = Date.now();

  for (const [key, value] of clientLimiters.entries()) {
    if (now - value.lastSeenAt > 15 * 60_000) {
      clientLimiters.delete(key);
    }
  }

  const existing = clientLimiters.get(ip);
  if (existing) {
    existing.lastSeenAt = now;
    return existing.limiter;
  }

  const created = { limiter: new MinuteRateLimiter(20), lastSeenAt: now };
  clientLimiters.set(ip, created);
  return created.limiter;
};

const parseConfiguredDiscordWebhook = (): URL => {
  const configured = (process.env.TRADING_DISCORD_WEBHOOK_URL ?? "").trim();
  if (!configured) {
    throw new Error("TRADING_DISCORD_WEBHOOK_URL is not configured.");
  }

  const parsed = new URL(configured);
  if (parsed.protocol !== "https:") {
    throw new Error("TRADING_DISCORD_WEBHOOK_URL must use HTTPS.");
  }
  if (isPrivateOrLoopbackHostname(parsed.hostname)) {
    throw new Error("TRADING_DISCORD_WEBHOOK_URL must be a public host.");
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  if (hostname !== "discord.com" && hostname !== "discordapp.com") {
    throw new Error("TRADING_DISCORD_WEBHOOK_URL must target discord.com.");
  }
  if (!parsed.pathname.startsWith("/api/webhooks/")) {
    throw new Error("TRADING_DISCORD_WEBHOOK_URL must be a Discord webhook endpoint.");
  }

  return parsed;
};

const parseConfiguredTelegramEndpoint = (): URL => {
  const botToken = (process.env.TRADING_TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!botToken) {
    throw new Error("TRADING_TELEGRAM_BOT_TOKEN is not configured.");
  }

  return new URL(`https://api.telegram.org/bot${botToken}/sendMessage`);
};

export async function POST(request: Request) {
  try {
    if (!limiterForRequest(request).allow()) {
      return NextResponse.json({ error: "Alert rate limit exceeded. Try again shortly." }, { status: 429 });
    }

    const body = (await request.json()) as AlertRequestBody;
    const provider = body.provider;
    const telegramChatId = (body.telegramChatId ?? "").trim();
    const message = (body.message ?? "").trim();

    if (provider !== "telegram" && provider !== "discord") {
      return NextResponse.json({ error: "provider must be telegram or discord." }, { status: 400 });
    }
    if (!message) {
      return NextResponse.json({ error: "message is required." }, { status: 400 });
    }
    if (provider === "telegram" && !telegramChatId) {
      return NextResponse.json({ error: "telegramChatId is required for Telegram alerts." }, { status: 400 });
    }
    if (message.length > MESSAGE_MAX_CHARS) {
      return NextResponse.json(
        { error: `message exceeds ${MESSAGE_MAX_CHARS} characters.` },
        { status: 400 },
      );
    }

    let endpoint: URL;
    let payload: BodyInit;
    try {
      if (provider === "telegram") {
        endpoint = parseConfiguredTelegramEndpoint();
        payload = JSON.stringify({ chat_id: telegramChatId, text: message });
      } else {
        endpoint = parseConfiguredDiscordWebhook();
        payload = JSON.stringify({ content: message });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Alert provider is not configured.";
      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    await retryWithBackoff(
      async () => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: payload,
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`Webhook request failed with status ${response.status}.`);
        }
      },
      {
        attempts: 3,
        baseDelayMs: 350,
      },
    );

    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send alert.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
