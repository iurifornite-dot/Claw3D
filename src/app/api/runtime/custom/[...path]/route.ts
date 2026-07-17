import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));

function handleHealth() {
  return NextResponse.json({ status: "ok", ok: true });
}

function handleState() {
  return NextResponse.json({
    runtime: {
      name: "Claw3D",
      version: process.env.npm_package_version ?? "0.0.0",
      vendor: "Claw3D",
    },
    identity: {
      name: "Claw3D",
      role: "assistant",
    },
  });
}

function handleRegistry() {
  const models: Record<string, unknown> = {};
  if (process.env.OPENAI_API_KEY) {
    models["gpt-4o"] = { name: "GPT-4o", vendor: "openai" };
    models["gpt-4o-mini"] = { name: "GPT-4o Mini", vendor: "openai" };
  }
  return NextResponse.json({ models });
}

async function handleChatCompletions(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "No AI model configured. Set the OPENAI_API_KEY environment variable to enable chat completions.",
      },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const payload = isRecord(body) ? body : {};
  const model =
    typeof payload.model === "string" && payload.model.trim()
      ? payload.model.trim()
      : "gpt-4o-mini";

  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...payload, model }),
    signal: request.signal,
  });

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: Request, context: RouteContext) {
  const { path: segments } = await context.params;
  const pathname = "/" + (Array.isArray(segments) ? segments.join("/") : "");

  if (pathname === "/health") return handleHealth();
  if (pathname === "/state") return handleState();
  if (pathname === "/registry") return handleRegistry();

  return NextResponse.json(
    { error: `Not found: ${pathname}` },
    { status: 404 }
  );
}

export async function POST(request: Request, context: RouteContext) {
  const { path: segments } = await context.params;
  const pathname = "/" + (Array.isArray(segments) ? segments.join("/") : "");

  if (pathname === "/v1/chat/completions")
    return handleChatCompletions(request);

  return NextResponse.json(
    { error: `Not found: ${pathname}` },
    { status: 404 }
  );
}
