import { getOperatingHoursForDay } from "@/lib/config";
import {
  buildBaselineFractions,
  computeProjection,
  computeWageSeries,
  cumulative,
  getBaselineFractionAtIndex,
  toPercent,
} from "@/lib/math";
import {
  buildBucketLabels,
  BUSINESS_DAY_START_HOUR,
  getZonedNow,
  parseClockToMinutes,
  toBusinessDayReference,
} from "@/lib/time";
import { AppConfig, LiveSnapshot, OperatingHours } from "@/lib/types";

const BUCKET_MINUTES = 15;
const BUCKET_MILLISECONDS = BUCKET_MINUTES * 60 * 1000;
const MAX_SQUARE_PAGES = 40;

type IntegrationStatus = "fulfilled" | "rejected" | "skipped";

type IntegrationLogFn = (scope: string, message: string, payload?: unknown) => void;

interface IntegrationSummary {
  mode: "realtime";
  fetchedAtIso: string;
  status: {
    squarePayments: IntegrationStatus;
    squareOpenOrders: IntegrationStatus;
    deputyTimesheets: IntegrationStatus;
    deputyEmployees: IntegrationStatus;
    historicalWeek1: IntegrationStatus;
    historicalWeek2: IntegrationStatus;
    historicalWeek3: IntegrationStatus;
    historicalWeek4: IntegrationStatus;
  };
  counts: {
    squarePayments: number;
    squareOpenOrders: number;
    squareOpenOrdersExcluded: number;
    squareOpenOrdersExcludedCarryoverCents: number;
    squareOpenOrdersExcludedDeltaCents: number;
    deputyTimesheets: number;
    deputyEmployees: number;
  };
}

export interface RealtimeBuildResult {
  snapshot: LiveSnapshot;
  integration: IntegrationSummary;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

interface WindowRange {
  start: Date;
  end: Date;
}

interface PromiseResult<T> {
  status: "fulfilled" | "rejected";
  value?: T;
  reason?: string;
}

interface SquarePayment {
  createdAt: Date;
  amountCents: number;
}

interface SquareOrder {
  id: string | null;
  label: string | null;
  createdAt: Date | null;
  amountCents: number;
}

interface DeputyTimesheet {
  startAt: Date;
  endAt: Date | null;
  employeeId: number | null;
  hourlyRate: number | null;
}

interface ExcludedOpenOrderBaselineEntry {
  baselineCents: number;
  capturedAtIso: string;
}

const excludedOpenOrderBaselineByServiceDay = new Map<
  string,
  ExcludedOpenOrderBaselineEntry
>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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

function getLocalDateParts(date: Date, timeZone: string): LocalDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === "year")?.value ?? "1970"),
    month: Number(parts.find((part) => part.type === "month")?.value ?? "1"),
    day: Number(parts.find((part) => part.type === "day")?.value ?? "1"),
  };
}

function addDays(parts: LocalDateParts, days: number): LocalDateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function parseOffsetMinutes(offsetName: string): number {
  const match = offsetName.match(/(?:GMT|UTC)([+-]\d{1,2})(?::?(\d{2}))?/);
  if (!match) {
    return 0;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? "0");
  const sign = hours < 0 ? -1 : 1;
  return hours * 60 + sign * minutes;
}

function getOffsetMinutesAt(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const zonePart = formatter
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;

  if (!zonePart) {
    return 0;
  }

  return parseOffsetMinutes(zonePart);
}

function zonedClockToUtc(
  parts: LocalDateParts,
  clock: string,
  timeZone: string,
): Date {
  const clockMinutes = parseClockToMinutes(clock);
  const hours = Math.floor(clockMinutes / 60);
  const minutes = clockMinutes % 60;

  const naiveUtc = Date.UTC(parts.year, parts.month - 1, parts.day, hours, minutes, 0, 0);
  let timestamp = naiveUtc;

  // Two-pass offset correction handles most timezone and DST boundaries.
  for (let pass = 0; pass < 2; pass += 1) {
    const offsetMinutes = getOffsetMinutesAt(new Date(timestamp), timeZone);
    timestamp = naiveUtc - offsetMinutes * 60_000;
  }

  return new Date(timestamp);
}

function buildOperatingWindow(
  localDate: LocalDateParts,
  hours: OperatingHours,
  timeZone: string,
): WindowRange {
  const start = zonedClockToUtc(localDate, hours.openingTime, timeZone);
  const openingMinutes = parseClockToMinutes(hours.openingTime);
  const closingMinutes = parseClockToMinutes(hours.closingTime);
  const closesNextDay = closingMinutes <= openingMinutes;
  const closeDate = closesNextDay ? addDays(localDate, 1) : localDate;
  const end = zonedClockToUtc(closeDate, hours.closingTime, timeZone);
  return { start, end };
}

function getSquareBaseUrl(environment: "production" | "sandbox"): string {
  return environment === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
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

function parseDateValue(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "number") {
    const milliseconds = value > 1e12 ? value : value * 1000;
    const parsed = new Date(milliseconds);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (typeof value === "string") {
    const deputyMatch = value.match(/\/Date\((\d+)(?:[+-]\d+)?\)\//);
    if (deputyMatch) {
      const milliseconds = Number(deputyMatch[1]);
      const parsed = new Date(milliseconds);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function isOrderInReportingWindow(order: SquareOrder, windowStartMs: number): boolean {
  if (!order.createdAt) {
    return true;
  }

  return order.createdAt.getTime() >= windowStartMs;
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

function matchesAnyExcludedLabel(
  label: string | null,
  excludedLabels: string[],
): boolean {
  if (!label) {
    return false;
  }

  const normalizedLabel = normalizeLabel(label);
  if (!normalizedLabel) {
    return false;
  }

  return excludedLabels.some((excluded) => normalizedLabel.includes(excluded));
}

function buildExcludedServiceDayKey(
  config: AppConfig,
  windowStartMs: number,
  excludedLabels: string[],
): string {
  const labelsKey = [...excludedLabels].sort().join("|");
  return `${config.square.locationId}|${windowStartMs}|${labelsKey}`;
}

function getExcludedCarryoverBaselineCents(
  config: AppConfig,
  windowStartMs: number,
  excludedLabels: string[],
  currentExcludedTotalCents: number,
): number {
  if (excludedLabels.length === 0) {
    return 0;
  }

  const key = buildExcludedServiceDayKey(config, windowStartMs, excludedLabels);
  const existing = excludedOpenOrderBaselineByServiceDay.get(key);
  if (existing) {
    return existing.baselineCents;
  }

  if (excludedOpenOrderBaselineByServiceDay.size > 200) {
    const oldestKey = excludedOpenOrderBaselineByServiceDay.keys().next().value as
      | string
      | undefined;
    if (oldestKey) {
      excludedOpenOrderBaselineByServiceDay.delete(oldestKey);
    }
  }

  excludedOpenOrderBaselineByServiceDay.set(key, {
    baselineCents: Math.max(0, currentExcludedTotalCents),
    capturedAtIso: new Date().toISOString(),
  });

  return Math.max(0, currentExcludedTotalCents);
}

async function fetchSquarePayments(
  config: AppConfig,
  window: WindowRange,
): Promise<unknown[]> {
  const baseUrl = getSquareBaseUrl(config.square.environment);
  let cursor: string | null = null;
  const results: unknown[] = [];

  for (let page = 0; page < MAX_SQUARE_PAGES; page += 1) {
    const url = new URL("/v2/payments", baseUrl);
    url.searchParams.set("location_id", config.square.locationId);
    url.searchParams.set("begin_time", window.start.toISOString());
    url.searchParams.set("end_time", window.end.toISOString());
    url.searchParams.set("sort_order", "ASC");
    url.searchParams.set("limit", "100");

    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.square.accessToken}`,
        "Square-Version": process.env.SQUARE_API_VERSION ?? "2025-10-16",
      },
      cache: "no-store",
    });

    const body = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(`Square payments ${response.status}: ${preview(body)}`);
    }

    const payload = body as { payments?: unknown[]; cursor?: string };
    const payments = Array.isArray(payload.payments) ? payload.payments : [];
    results.push(...payments);

    if (!payload.cursor) {
      break;
    }

    cursor = payload.cursor;
  }

  return results;
}

async function fetchSquareOpenOrders(config: AppConfig): Promise<unknown[]> {
  const baseUrl = getSquareBaseUrl(config.square.environment);
  let cursor: string | null = null;
  const orders: unknown[] = [];

  for (let page = 0; page < MAX_SQUARE_PAGES; page += 1) {
    const url = new URL("/v2/orders/search", baseUrl);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.square.accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": process.env.SQUARE_API_VERSION ?? "2025-10-16",
      },
      body: JSON.stringify({
        location_ids: [config.square.locationId],
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

async function fetchDeputyCollection(
  config: AppConfig,
  paths: string[],
): Promise<unknown[]> {
  const errors: string[] = [];

  for (const path of paths) {
    const url = new URL(path, config.deputy.baseUrl);
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.deputy.accessToken}`,
      },
      cache: "no-store",
    });

    const body = await parseJsonResponse(response);
    if (!response.ok) {
      errors.push(`${path}: ${response.status}`);
      continue;
    }

    if (Array.isArray(body)) {
      return body;
    }

    const payload = body as { data?: unknown[] };
    if (Array.isArray(payload.data)) {
      return payload.data;
    }

    return [];
  }

  throw new Error(`Deputy endpoints failed: ${errors.join(", ")}`);
}

function extractSquarePayments(rawPayments: unknown[]): SquarePayment[] {
  const rows: SquarePayment[] = [];

  for (const raw of rawPayments) {
    const payment = raw as {
      created_at?: unknown;
      status?: unknown;
      amount_money?: { amount?: unknown };
    };

    if (
      typeof payment.status === "string" &&
      payment.status.toUpperCase() !== "COMPLETED"
    ) {
      continue;
    }

    const createdAt = parseDateValue(payment.created_at);
    const amount = parseNumber(payment.amount_money?.amount);
    if (!createdAt || amount === null) {
      continue;
    }

    rows.push({
      createdAt,
      amountCents: Math.round(amount),
    });
  }

  return rows;
}

function extractSquareOpenOrders(rawOrders: unknown[]): SquareOrder[] {
  const rows: SquareOrder[] = [];

  for (const raw of rawOrders) {
    const order = raw as {
      id?: unknown;
      created_at?: unknown;
      total_money?: { amount?: unknown };
      net_amounts?: { total_money?: { amount?: unknown } };
      ticket_name?: unknown;
      reference_id?: unknown;
      customer_note?: unknown;
      metadata?: Record<string, unknown>;
      source?: Record<string, unknown>;
      line_items?: Array<{
        quantity?: unknown;
        base_price_money?: { amount?: unknown };
      }>;
    };

    const orderId = typeof order.id === "string" ? order.id : null;
    const createdAt = parseDateValue(order.created_at);
    const label = pickOrderLabel(order as unknown as Record<string, unknown>);

    const directAmount =
      parseNumber(order.total_money?.amount) ??
      parseNumber(order.net_amounts?.total_money?.amount);

    if (directAmount !== null) {
      rows.push({
        id: orderId,
        label,
        createdAt,
        amountCents: Math.max(0, Math.round(directAmount)),
      });
      continue;
    }

    const items = Array.isArray(order.line_items) ? order.line_items : [];
    let derivedAmount = 0;
    for (const item of items) {
      const quantity = parseNumber(item.quantity) ?? 1;
      const base = parseNumber(item.base_price_money?.amount) ?? 0;
      derivedAmount += base * quantity;
    }

    rows.push({
      id: orderId,
      label,
      createdAt,
      amountCents: Math.max(0, Math.round(derivedAmount)),
    });
  }

  return rows;
}

function extractDeputyTimesheets(raw: unknown[]): DeputyTimesheet[] {
  const rows: DeputyTimesheet[] = [];

  for (const entry of raw) {
    const timesheet = entry as Record<string, unknown>;

    const startAt =
      parseDateValue(timesheet.StartTime) ??
      parseDateValue(timesheet.StartTimeLocalized) ??
      parseDateValue(timesheet.start_time) ??
      parseDateValue(timesheet.start);

    if (!startAt) {
      continue;
    }

    const endAt =
      parseDateValue(timesheet.EndTime) ??
      parseDateValue(timesheet.EndTimeLocalized) ??
      parseDateValue(timesheet.end_time) ??
      parseDateValue(timesheet.end) ??
      null;

    const employeeId =
      parseNumber(timesheet.Employee) ??
      parseNumber(timesheet.EmployeeId) ??
      parseNumber(timesheet.employee_id);

    const hourlyRate =
      parseNumber(timesheet.CostRate) ??
      parseNumber(timesheet.UnitRate) ??
      parseNumber(timesheet.HourlyRate) ??
      parseNumber(timesheet.PayRate) ??
      null;

    rows.push({
      startAt,
      endAt,
      employeeId: employeeId === null ? null : Math.round(employeeId),
      hourlyRate,
    });
  }

  return rows;
}

function extractDeputyEmployeeRateMap(raw: unknown[]): Map<number, number> {
  const map = new Map<number, number>();

  for (const entry of raw) {
    const employee = entry as Record<string, unknown>;
    const id =
      parseNumber(employee.Id) ??
      parseNumber(employee.EmployeeId) ??
      parseNumber(employee.id);

    if (id === null) {
      continue;
    }

    const rate =
      parseNumber(employee.CostRate) ??
      parseNumber(employee.HourlyRate) ??
      parseNumber(employee.PayRate) ??
      parseNumber(employee.DefaultPayRate);

    if (rate !== null && rate > 0) {
      map.set(Math.round(id), rate);
    }
  }

  return map;
}

function bucketizeRevenue(
  payments: SquarePayment[],
  windowStartMs: number,
  effectiveNowMs: number,
  bucketCount: number,
): number[] {
  const buckets = Array.from({ length: bucketCount }, () => 0);

  for (const payment of payments) {
    const timestamp = payment.createdAt.getTime();
    if (timestamp < windowStartMs || timestamp >= effectiveNowMs) {
      continue;
    }

    const index = Math.floor((timestamp - windowStartMs) / BUCKET_MILLISECONDS);
    if (index < 0 || index >= bucketCount) {
      continue;
    }

    buckets[index] += Math.max(0, payment.amountCents);
  }

  return buckets;
}

function distributeLabor(
  bucketLabor: number[],
  windowStartMs: number,
  effectiveNowMs: number,
  timesheet: DeputyTimesheet,
  fallbackRate: number,
  employeeRates: Map<number, number>,
): void {
  let startMs = timesheet.startAt.getTime();
  let endMs = timesheet.endAt ? timesheet.endAt.getTime() : effectiveNowMs;

  if (endMs <= startMs) {
    return;
  }

  startMs = Math.max(startMs, windowStartMs);
  endMs = Math.min(endMs, effectiveNowMs);

  if (endMs <= startMs) {
    return;
  }

  const rate =
    timesheet.hourlyRate ??
    (timesheet.employeeId !== null
      ? employeeRates.get(timesheet.employeeId) ?? fallbackRate
      : fallbackRate);

  if (rate <= 0) {
    return;
  }

  let cursor = startMs;

  while (cursor < endMs) {
    const bucketIndex = Math.floor((cursor - windowStartMs) / BUCKET_MILLISECONDS);
    if (bucketIndex < 0 || bucketIndex >= bucketLabor.length) {
      break;
    }

    const bucketEnd = windowStartMs + (bucketIndex + 1) * BUCKET_MILLISECONDS;
    const segmentEnd = Math.min(endMs, bucketEnd);
    const hours = (segmentEnd - cursor) / 3_600_000;
    bucketLabor[bucketIndex] += Math.round(hours * rate * 100);
    cursor = segmentEnd;
  }
}

function buildFallbackFractions(bucketCount: number): number[] {
  if (bucketCount <= 0) {
    return [0];
  }

  return Array.from({ length: bucketCount }, (_, index) =>
    bucketCount === 1 ? 1 : (index + 1) / bucketCount,
  );
}

function normalizeFractions(fractions: number[], bucketCount: number): number[] {
  if (bucketCount <= 0) {
    return [0];
  }

  if (fractions.length === bucketCount) {
    return fractions;
  }

  if (fractions.length === 0) {
    return buildFallbackFractions(bucketCount);
  }

  if (fractions.length > bucketCount) {
    return fractions.slice(0, bucketCount);
  }

  const output = [...fractions];
  const last = fractions[fractions.length - 1] ?? 0;
  const remaining = bucketCount - fractions.length;
  for (let step = 1; step <= remaining; step += 1) {
    const next = last + ((1 - last) * step) / remaining;
    output.push(clamp(next, 0, 1));
  }
  return output;
}

async function settled<T>(work: () => Promise<T>): Promise<PromiseResult<T>> {
  try {
    const value = await work();
    return { status: "fulfilled", value };
  } catch (error) {
    return {
      status: "rejected",
      reason: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

function buildClosedSnapshot(config: AppConfig, referenceDate: Date): LiveSnapshot {
  const serviceReference = toBusinessDayReference(
    referenceDate,
    BUSINESS_DAY_START_HOUR,
  );
  const dayKey = getZonedNow(serviceReference, config.timezone).dayKey;
  const targetWage = config.dailyTargets[dayKey].wageTargetPercent;

  return {
    generatedAtIso: new Date().toISOString(),
    dayKey,
    totals: {
      actualRevenueCents: 0,
      openBillsCents: 0,
      adjustedRevenueCents: 0,
      projectedRevenueCents: 0,
      projectedVsTargetPercent: 0,
      laborCostCents: 0,
      wagePercent: null,
    },
    comparison: {
      lastWeekRevenueCents: 0,
      rollingAverageRevenueCents: 0,
    },
    projection: {
      baselineFraction: 0,
      rawProjectedTotalCents: 0,
      rampedProjectedTotalCents: 0,
      rampWeight: 0,
      elapsedFraction: 0,
    },
    timeline: {
      revenueBuckets: [
        {
          bucketIndex: 0,
          label: "Closed",
          closedRevenueCents: 0,
          openBillsCents: 0,
          laborCostCents: 0,
        },
      ],
      baselineFractions: [0],
      wageSeries: [
        {
          label: "Closed",
          currentPercent: null,
          targetPercent: targetWage,
          historicalPercent: targetWage,
        },
      ],
      historicalWagePercentByBucket: [targetWage],
    },
  };
}

export async function buildRealtimeSnapshot(
  config: AppConfig,
  referenceDate: Date,
  log: IntegrationLogFn = () => {},
): Promise<RealtimeBuildResult> {
  const serviceReference = toBusinessDayReference(
    referenceDate,
    BUSINESS_DAY_START_HOUR,
  );
  const zonedReference = getZonedNow(serviceReference, config.timezone);
  const dayKey = zonedReference.dayKey;
  const target = config.dailyTargets[dayKey];
  const operatingHours = getOperatingHoursForDay(config, dayKey);

  if (operatingHours.isClosed) {
    return {
      snapshot: buildClosedSnapshot(config, referenceDate),
      integration: {
        mode: "realtime",
        fetchedAtIso: new Date().toISOString(),
        status: {
          squarePayments: "skipped",
          squareOpenOrders: "skipped",
          deputyTimesheets: "skipped",
          deputyEmployees: "skipped",
          historicalWeek1: "skipped",
          historicalWeek2: "skipped",
          historicalWeek3: "skipped",
          historicalWeek4: "skipped",
        },
        counts: {
          squarePayments: 0,
          squareOpenOrders: 0,
          squareOpenOrdersExcluded: 0,
          squareOpenOrdersExcludedCarryoverCents: 0,
          squareOpenOrdersExcludedDeltaCents: 0,
          deputyTimesheets: 0,
          deputyEmployees: 0,
        },
      },
    };
  }

  const labels = buildBucketLabels(
    operatingHours.openingTime,
    operatingHours.closingTime,
    BUCKET_MINUTES,
  );
  const bucketCount = labels.length;

  const localDate = getLocalDateParts(serviceReference, config.timezone);
  const window = buildOperatingWindow(localDate, operatingHours, config.timezone);
  const windowStartMs = window.start.getTime();
  const windowEndMs = window.end.getTime();
  const nowMs = Date.now();
  const effectiveNowMs = clamp(nowMs, windowStartMs, windowEndMs);
  const elapsedMinutes = Math.max(0, (effectiveNowMs - windowStartMs) / 60_000);
  const operatingWindowMinutes = Math.max(1, (windowEndMs - windowStartMs) / 60_000);
  const elapsedFraction = clamp(elapsedMinutes / operatingWindowMinutes, 0, 1);
  const completedBucketCount = clamp(
    Math.ceil(elapsedMinutes / BUCKET_MINUTES),
    0,
    bucketCount,
  );

  log("realtime", "Window", {
    dayKey,
    localDate,
    windowStartIso: window.start.toISOString(),
    windowEndIso: window.end.toISOString(),
    effectiveNowIso: new Date(effectiveNowMs).toISOString(),
  });

  const [
    squarePaymentsResult,
    squareOpenOrdersResult,
    deputyTimesheetsResult,
    deputyEmployeesResult,
  ] = await Promise.all([
    settled(() => fetchSquarePayments(config, window)),
    settled(() => fetchSquareOpenOrders(config)),
    settled(() =>
      fetchDeputyCollection(config, [
        "/api/v1/resource/Timesheet?max=500",
        "/api/v1/supervise/timesheet?max=500",
      ]),
    ),
    settled(() =>
      fetchDeputyCollection(config, [
        "/api/v1/resource/Employee?max=500",
        "/api/v1/supervise/employee?max=500",
      ]),
    ),
  ]);

  if (squarePaymentsResult.status === "rejected") {
    log("realtime", "Square payments failed", squarePaymentsResult.reason);
  }
  if (squareOpenOrdersResult.status === "rejected") {
    log("realtime", "Square open orders failed", squareOpenOrdersResult.reason);
  }
  if (deputyTimesheetsResult.status === "rejected") {
    log("realtime", "Deputy timesheets failed", deputyTimesheetsResult.reason);
  }
  if (deputyEmployeesResult.status === "rejected") {
    log("realtime", "Deputy employees failed", deputyEmployeesResult.reason);
  }

  const payments =
    squarePaymentsResult.status === "fulfilled"
      ? extractSquarePayments(squarePaymentsResult.value ?? [])
      : [];

  const openOrders =
    squareOpenOrdersResult.status === "fulfilled"
      ? extractSquareOpenOrders(squareOpenOrdersResult.value ?? [])
      : [];

  const timesheets =
    deputyTimesheetsResult.status === "fulfilled"
      ? extractDeputyTimesheets(deputyTimesheetsResult.value ?? [])
      : [];

  const employeeRates =
    deputyEmployeesResult.status === "fulfilled"
      ? extractDeputyEmployeeRateMap(deputyEmployeesResult.value ?? [])
      : new Map<number, number>();

  const closedRevenueByBucket = bucketizeRevenue(
    payments,
    windowStartMs,
    effectiveNowMs,
    bucketCount,
  );

  const excludedOpenOrderLabels = Array.from(
    new Set(
      config.excludedOpenOrderLabels
        .map((label) => normalizeLabel(label))
        .filter((label) => label.length > 0),
    ),
  );

  const excludedOpenOrders = openOrders.filter((order) =>
    matchesAnyExcludedLabel(order.label, excludedOpenOrderLabels),
  );
  const includedOpenOrders = openOrders.filter(
    (order) =>
      !matchesAnyExcludedLabel(order.label, excludedOpenOrderLabels) &&
      isOrderInReportingWindow(order, windowStartMs),
  );
  const includedOpenOrdersOutsideWindowCount = openOrders.filter(
    (order) =>
      !matchesAnyExcludedLabel(order.label, excludedOpenOrderLabels) &&
      !isOrderInReportingWindow(order, windowStartMs),
  ).length;

  const includedOpenBillsCents = includedOpenOrders.reduce(
    (sum, order) => sum + Math.max(0, order.amountCents),
    0,
  );
  const excludedOpenOrdersTotalCents = excludedOpenOrders.reduce(
    (sum, order) => sum + Math.max(0, order.amountCents),
    0,
  );

  const excludedCarryoverBaselineCents = getExcludedCarryoverBaselineCents(
    config,
    windowStartMs,
    excludedOpenOrderLabels,
    excludedOpenOrdersTotalCents,
  );
  const excludedOpenOrdersDeltaCents = Math.max(
    0,
    excludedOpenOrdersTotalCents - excludedCarryoverBaselineCents,
  );

  const openBillsCents = includedOpenBillsCents + excludedOpenOrdersDeltaCents;

  log("realtime", "Open order filtering", {
    totalOpenOrderCount: openOrders.length,
    includedOpenOrderCount: includedOpenOrders.length,
    includedOpenOrdersOutsideWindowCount,
    excludedOpenOrderCount: excludedOpenOrders.length,
    includedOpenBillsCents,
    excludedOpenOrdersTotalCents,
    excludedCarryoverBaselineCents,
    excludedOpenOrdersDeltaCents,
    excludedOpenOrderLabels,
  });

  const laborByBucket = Array.from({ length: bucketCount }, () => 0);
  for (const timesheet of timesheets) {
    distributeLabor(
      laborByBucket,
      windowStartMs,
      effectiveNowMs,
      timesheet,
      config.averageHourlyRate,
      employeeRates,
    );
  }

  const cumulativeClosedRevenue = cumulative(closedRevenueByBucket);
  const cumulativeLabor = cumulative(laborByBucket);
  const actualRevenueCents = cumulativeClosedRevenue[completedBucketCount - 1] ?? 0;
  const adjustedRevenueCents =
    actualRevenueCents + (completedBucketCount > 0 ? openBillsCents : 0);
  const laborCostCents = cumulativeLabor[completedBucketCount - 1] ?? 0;
  const wagePercent = toPercent(laborCostCents, adjustedRevenueCents);

  const comparableTotals: number[] = [];
  const comparableSeries: number[][] = [];
  const historicalStatuses: IntegrationStatus[] = [];

  for (let week = 1; week <= 4; week += 1) {
    const compareDate = addDays(localDate, -7 * week);
    const compareWindow = buildOperatingWindow(
      compareDate,
      operatingHours,
      config.timezone,
    );

    const historicalResult = await settled(() =>
      fetchSquarePayments(config, compareWindow),
    );

    if (historicalResult.status === "fulfilled") {
      const rows = extractSquarePayments(historicalResult.value ?? []);
      const bucketed = bucketizeRevenue(
        rows,
        compareWindow.start.getTime(),
        compareWindow.end.getTime(),
        bucketCount,
      );
      comparableSeries.push(bucketed);
      comparableTotals.push(bucketed.reduce((sum, value) => sum + value, 0));
      historicalStatuses.push("fulfilled");
    } else {
      log("realtime", `Historical week-${week} failed`, historicalResult.reason);
      historicalStatuses.push("rejected");
    }
  }

  const lastWeekRevenueCents = comparableTotals[0] ?? 0;
  const rollingAverageRevenueCents =
    comparableTotals.length > 0
      ? Math.round(
          comparableTotals.reduce((sum, value) => sum + value, 0) / comparableTotals.length,
        )
      : target.revenueTargetCents;

  const baselineFractions = normalizeFractions(
    comparableSeries.length > 0
      ? buildBaselineFractions(comparableSeries)
      : buildFallbackFractions(bucketCount),
    bucketCount,
  );
  const baselineFractionAtNow = getBaselineFractionAtIndex(
    baselineFractions,
    Math.max(0, completedBucketCount - 1),
  );

  const projection = computeProjection(
    adjustedRevenueCents,
    baselineFractionAtNow,
    rollingAverageRevenueCents,
    elapsedFraction,
  );

  const projectedVsTargetPercent =
    target.revenueTargetCents > 0
      ? ((projection.rampedProjectedTotalCents - target.revenueTargetCents) /
          target.revenueTargetCents) *
        100
      : 0;

  const historicalWagePercentByBucket = Array.from(
    { length: bucketCount },
    () => target.wageTargetPercent,
  );

  const wageSeries = computeWageSeries(
    labels,
    cumulativeClosedRevenue,
    cumulativeLabor,
    target.wageTargetPercent,
    historicalWagePercentByBucket,
  );

  const revenueBuckets = labels.map((label, index) => ({
    bucketIndex: index,
    label,
    closedRevenueCents: closedRevenueByBucket[index] ?? 0,
    openBillsCents:
      index === Math.max(0, completedBucketCount - 1) && completedBucketCount > 0
        ? openBillsCents
        : 0,
    laborCostCents: laborByBucket[index] ?? 0,
  }));

  const snapshot: LiveSnapshot = {
    generatedAtIso: new Date().toISOString(),
    dayKey,
    totals: {
      actualRevenueCents,
      openBillsCents: completedBucketCount > 0 ? openBillsCents : 0,
      adjustedRevenueCents,
      projectedRevenueCents: projection.rampedProjectedTotalCents,
      projectedVsTargetPercent,
      laborCostCents,
      wagePercent,
    },
    comparison: {
      lastWeekRevenueCents,
      rollingAverageRevenueCents,
    },
    projection,
    timeline: {
      revenueBuckets,
      baselineFractions,
      wageSeries,
      historicalWagePercentByBucket,
    },
  };

  const integration: IntegrationSummary = {
    mode: "realtime",
    fetchedAtIso: new Date().toISOString(),
    status: {
      squarePayments: squarePaymentsResult.status,
      squareOpenOrders: squareOpenOrdersResult.status,
      deputyTimesheets: deputyTimesheetsResult.status,
      deputyEmployees: deputyEmployeesResult.status,
      historicalWeek1: historicalStatuses[0] ?? "skipped",
      historicalWeek2: historicalStatuses[1] ?? "skipped",
      historicalWeek3: historicalStatuses[2] ?? "skipped",
      historicalWeek4: historicalStatuses[3] ?? "skipped",
    },
    counts: {
      squarePayments: payments.length,
      squareOpenOrders: openOrders.length,
      squareOpenOrdersExcluded: excludedOpenOrders.length,
      squareOpenOrdersExcludedCarryoverCents: excludedCarryoverBaselineCents,
      squareOpenOrdersExcludedDeltaCents: excludedOpenOrdersDeltaCents,
      deputyTimesheets: timesheets.length,
      deputyEmployees: employeeRates.size,
    },
  };

  log("realtime", "Integration summary", integration);

  return {
    snapshot,
    integration,
  };
}
