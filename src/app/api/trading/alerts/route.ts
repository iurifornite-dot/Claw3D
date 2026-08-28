import { NextResponse } from "next/server";

import { isPrivateOrLoopbackHostname } from "@/lib/security/urlSafety";
import { MinuteRateLimiter, retryWithBackoff } from "@/lib/trading/guardrails";

export const runtime = "nodejs";

type AlertRequestBody = {
  provider?: "telegram" | "discord";
  webhookUrl?: string;
  message?: string;
};

const MESSAGE_MAX_CHARS = 600;
const rateLimiter = new MinuteRateLimiter(20);

const parseWebhook = (webhookUrl: string): URL => {
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    throw new Error("Webhook URL is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Webhook URL must use HTTPS.");
  }
  if (isPrivateOrLoopbackHostname(url.hostname)) {
    throw new Error("Webhook URL must be a public host.");
  }
  return url;
};

const toProviderPayload = (provider: "telegram" | "discord", message: string): BodyInit => {
  if (provider === "telegram") {
    return JSON.stringify({ text: message });
  }
  return JSON.stringify({ content: message });
};

export async function POST(request: Request) {
  try {
    if (!rateLimiter.allow()) {
      return NextResponse.json({ error: "Alert rate limit exceeded. Try again shortly." }, { status: 429 });
    }

    const body = (await request.json()) as AlertRequestBody;
    const provider = body.provider;
    const webhookUrl = (body.webhookUrl ?? "").trim();
    const message = (body.message ?? "").trim();

    if (provider !== "telegram" && provider !== "discord") {
      return NextResponse.json({ error: "provider must be telegram or discord." }, { status: 400 });
    }
    if (!webhookUrl) {
      return NextResponse.json({ error: "webhookUrl is required." }, { status: 400 });
    }
    if (!message) {
      return NextResponse.json({ error: "message is required." }, { status: 400 });
    }
    if (message.length > MESSAGE_MAX_CHARS) {
      return NextResponse.json(
        { error: `message exceeds ${MESSAGE_MAX_CHARS} characters.` },
        { status: 400 },
      );
    }

    const parsedWebhook = parseWebhook(webhookUrl);

    await retryWithBackoff(
      async () => {
        const response = await fetch(parsedWebhook, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: toProviderPayload(provider, message),
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
