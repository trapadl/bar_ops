import { NextResponse } from "next/server";
import { sanitizeConfig } from "@/lib/config";
import { buildLiveSnapshot } from "@/lib/mockData";
import { buildRealtimeSnapshot } from "@/lib/realtimeSnapshot";
import { getServerConfig } from "@/lib/serverConfigStore";
import { AppConfig } from "@/lib/types";

function parseDateFromQuery(url: string): Date {
  const searchParams = new URL(url).searchParams;
  const queryDate = searchParams.get("date");
  if (!queryDate || queryDate.trim().length === 0) {
    return new Date();
  }

  const trimmed = queryDate.trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? new Date(`${trimmed}T12:00:00.000Z`)
    : new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }

  return parsed;
}

function parseDateFromValue(value: unknown): Date {
  if (typeof value !== "string" || value.trim().length === 0) {
    return new Date();
  }

  const trimmed = value.trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? new Date(`${trimmed}T12:00:00.000Z`)
    : new Date(trimmed);

  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }

  return parsed;
}

function parseSource(value: unknown): "sample" | "realtime" {
  return value === "realtime" ? "realtime" : "sample";
}

function parseSourceFromQuery(url: string): "sample" | "realtime" {
  const searchParams = new URL(url).searchParams;
  return parseSource(searchParams.get("source"));
}

function parseConfigOverride(configOverride: unknown): AppConfig {
  if (!configOverride || typeof configOverride !== "object") {
    return getServerConfig();
  }

  return sanitizeConfig(configOverride as Partial<AppConfig>);
}

function logInternal(scope: string, message: string, payload?: unknown): void {
  if (payload === undefined) {
    console.info(`[barops:${scope}] ${message}`);
    return;
  }

  console.info(`[barops:${scope}] ${message}`, payload);
}

function buildDebugCode(prefix: string): string {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${stamp}-${random}`;
}

function validateRealtimeConfig(config: ReturnType<typeof getServerConfig>): string[] {
  const missing: string[] = [];
  if (!config.square.accessToken) {
    missing.push("square.accessToken");
  }
  if (!config.square.locationId) {
    missing.push("square.locationId");
  }
  if (!config.deputy.accessToken) {
    missing.push("deputy.accessToken");
  }
  if (!config.deputy.baseUrl) {
    missing.push("deputy.baseUrl");
  }
  return missing;
}

interface LiveRequestOptions {
  config: AppConfig;
  referenceDate: Date;
  source: "sample" | "realtime";
}

async function handleLiveRequest({
  config,
  referenceDate,
  source,
}: LiveRequestOptions): Promise<NextResponse> {

  if (source === "realtime") {
    const missing = validateRealtimeConfig(config);
    if (missing.length > 0) {
      const debugCode = buildDebugCode("CFG");
      logInternal("live", "Realtime config missing", { debugCode, missing });
      return NextResponse.json(
        {
          error: "Missing realtime integration settings",
          message: "Square/Deputy realtime config is incomplete.",
          missing,
          debugCode,
        },
        { status: 400 },
      );
    }

    try {
      const realtime = await buildRealtimeSnapshot(config, referenceDate, logInternal);
      return NextResponse.json({
        ...realtime.snapshot,
        _integration: realtime.integration,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown realtime error";
      const debugCode = buildDebugCode("RTL");
      logInternal("live", "Realtime snapshot build failed", { debugCode, message });
      return NextResponse.json(
        {
          error: "Realtime integration failed",
          message,
          debugCode,
        },
        { status: 502 },
      );
    }
  }

  const payload = buildLiveSnapshot(config, referenceDate);
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  return handleLiveRequest({
    config: getServerConfig(),
    referenceDate: parseDateFromQuery(request.url),
    source: parseSourceFromQuery(request.url),
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  let payload: unknown;

  try {
    payload = (await request.json()) as unknown;
  } catch {
    return NextResponse.json(
      {
        error: "Invalid request body",
        message: "Expected JSON request payload.",
      },
      { status: 400 },
    );
  }

  const body = payload as {
    config?: unknown;
    date?: unknown;
    source?: unknown;
  };

  return handleLiveRequest({
    config: parseConfigOverride(body.config),
    referenceDate: parseDateFromValue(body.date),
    source: parseSource(body.source),
  });
}
