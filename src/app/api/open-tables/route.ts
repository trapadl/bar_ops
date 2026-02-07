import { NextResponse } from "next/server";
import { resolveSquareRuntimeConfig } from "@/lib/realtimeEnv";

const MAX_SQUARE_PAGES = 40;

interface OpenTableSummary {
  label: string;
  orderCount: number;
  totalCents: number;
}

function getSquareBaseUrl(environment: "production" | "sandbox"): string {
  return environment === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

function buildDebugCode(prefix: string): string {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${stamp}-${random}`;
}

function preview(value: unknown, maxLength = 350): string {
  try {
    const text = JSON.stringify(value);
    if (!text) {
      return "null";
    }
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  } catch {
    return "[unserializable]";
  }
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function pickOrderLabel(order: Record<string, unknown>): string | null {
  const directCandidates = [
    order.ticket_name,
    order.reference_id,
    order.customer_note,
    order.name,
  ];

  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  const metadata = order.metadata as Record<string, unknown> | undefined;
  if (metadata) {
    const metadataCandidates = [
      metadata.table,
      metadata.tab,
      metadata.order_name,
      metadata.label,
    ];

    for (const candidate of metadataCandidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
  }

  const source = order.source as Record<string, unknown> | undefined;
  if (source && typeof source.name === "string" && source.name.trim().length > 0) {
    return source.name.trim();
  }

  return null;
}

function readOrderAmountCents(order: Record<string, unknown>): number {
  const directAmount =
    parseNumber((order.total_money as { amount?: unknown } | undefined)?.amount) ??
    parseNumber(
      (
        order.net_amounts as
          | { total_money?: { amount?: unknown } }
          | undefined
      )?.total_money?.amount,
    );

  if (directAmount !== null) {
    return Math.max(0, Math.round(directAmount));
  }

  const lineItems = Array.isArray(order.line_items)
    ? (order.line_items as Array<Record<string, unknown>>)
    : [];

  let derivedAmount = 0;
  for (const item of lineItems) {
    const quantity = parseNumber(item.quantity) ?? 1;
    const base = parseNumber(
      (item.base_price_money as { amount?: unknown } | undefined)?.amount,
    );
    derivedAmount += (base ?? 0) * quantity;
  }

  return Math.max(0, Math.round(derivedAmount));
}

async function fetchSquareOpenOrders(config: {
  environment: "production" | "sandbox";
  accessToken: string;
  locationId: string;
}): Promise<unknown[]> {
  const baseUrl = getSquareBaseUrl(config.environment);
  let cursor: string | null = null;
  const orders: unknown[] = [];

  for (let page = 0; page < MAX_SQUARE_PAGES; page += 1) {
    const response = await fetch(new URL("/v2/orders/search", baseUrl).toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": process.env.SQUARE_API_VERSION ?? "2025-10-16",
      },
      body: JSON.stringify({
        location_ids: [config.locationId],
        cursor: cursor ?? undefined,
        limit: 100,
        query: {
          filter: {
            state_filter: {
              states: ["OPEN"],
            },
          },
        },
      }),
      cache: "no-store",
    });

    const body = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(`Square open orders ${response.status}: ${preview(body)}`);
    }

    const payload = body as { orders?: unknown[]; cursor?: string };
    const pageOrders = Array.isArray(payload.orders) ? payload.orders : [];
    orders.push(...pageOrders);

    if (!payload.cursor) {
      break;
    }
    cursor = payload.cursor;
  }

  return orders;
}

function summarizeOpenTables(rawOrders: unknown[]): OpenTableSummary[] {
  const byLabel = new Map<string, OpenTableSummary>();

  for (const raw of rawOrders) {
    const order = raw as Record<string, unknown>;
    const label = pickOrderLabel(order);
    if (!label) {
      continue;
    }

    const normalized = normalizeLabel(label);
    if (!normalized) {
      continue;
    }

    const amountCents = readOrderAmountCents(order);
    const existing = byLabel.get(normalized);

    if (existing) {
      existing.orderCount += 1;
      existing.totalCents += amountCents;
      continue;
    }

    byLabel.set(normalized, {
      label: normalized,
      orderCount: 1,
      totalCents: amountCents,
    });
  }

  return Array.from(byLabel.values()).sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}

export async function GET(): Promise<NextResponse> {
  const square = resolveSquareRuntimeConfig();
  if (square.missing.length > 0) {
    const debugCode = buildDebugCode("OTC");
    return NextResponse.json(
      {
        error: "Missing Square environment settings",
        message: "Square realtime config is incomplete for open-table discovery.",
        missing: square.missing,
        debugCode,
      },
      { status: 400 },
    );
  }

  try {
    const rawOrders = await fetchSquareOpenOrders({
      environment: square.environment,
      accessToken: square.accessToken,
      locationId: square.locationId,
    });

    const openTables = summarizeOpenTables(rawOrders);

    return NextResponse.json(
      {
        fetchedAtIso: new Date().toISOString(),
        openTables,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    const debugCode = buildDebugCode("OTF");
    return NextResponse.json(
      {
        error: "Open table discovery failed",
        message: error instanceof Error ? error.message : "Unknown open-table error",
        debugCode,
      },
      { status: 502 },
    );
  }
}

