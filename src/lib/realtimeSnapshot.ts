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
import {
  AppConfig,
  DayKey,
  LiveSnapshot,
  OperatingHours,
  PointOfNoReturnSnapshot,
} from "@/lib/types";

const BUCKET_MINUTES = 15;
const BUCKET_MILLISECONDS = BUCKET_MINUTES * 60 * 1000;
const MAX_SQUARE_PAGES = 40;
const REPORTING_WINDOW_OPENING = "05:00";
const REPORTING_WINDOW_CLOSING = "05:00";

type IntegrationStatus = "fulfilled" | "rejected" | "skipped";

type IntegrationLogFn = (scope: string, message: string, payload?: unknown) => void;

interface IntegrationSummary {
  mode: "realtime";
  fetchedAtIso: string;
  status: {
    squarePayments: IntegrationStatus;
    squareWeekPayments: IntegrationStatus;
    squareOpenOrders: IntegrationStatus;
    deputyTimesheets: IntegrationStatus;
    deputyWeekTimesheets: IntegrationStatus;
    deputyEmployees: IntegrationStatus;
    historicalWeek1: IntegrationStatus;
    historicalWeek2: IntegrationStatus;
    historicalWeek3: IntegrationStatus;
    historicalWeek4: IntegrationStatus;
  };
  counts: {
    squarePayments: number;
    squareWeekPayments: number;
    squareOpenOrders: number;
    squareOpenOrdersExcluded: number;
    squareOpenOrdersExcludedCarryoverCents: number;
    squareOpenOrdersExcludedDeltaCents: number;
    deputyTimesheets: number;
    deputyWeekTimesheets: number;
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

interface PointOfNoReturnInputs {
  config: AppConfig;
  dayKey: DayKey;
  localDate: LocalDateParts;
  timeZone: string;
  windowStartMs: number;
  effectiveNowMs: number;
  completedBucketCount: number;
  closedRevenueByBucket: number[];
  laborByBucket: number[];
  openBillsCents: number;
  baselineFractions: number[];
  projectedRevenueCents: number;
  weeklyRevenueToDateCents: number | null;
  weeklyWagesToDateCents: number | null;
  currentHourlySpendRate: number;
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

const DAY_KEY_TO_INDEX: Record<DayKey, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};
const DAY_KEYS: DayKey[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

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

function buildServiceWeekWindow(
  localDate: LocalDateParts,
  dayKey: DayKey,
  timeZone: string,
  effectiveNowMs: number,
): WindowRange {
  const dayOffset = DAY_KEY_TO_INDEX[dayKey] ?? 0;
  const weekStartDate = addDays(localDate, -dayOffset);
  const start = zonedClockToUtc(weekStartDate, REPORTING_WINDOW_OPENING, timeZone);
  const end = new Date(Math.max(effectiveNowMs, start.getTime()));
  return { start, end };
}

function getLastOpenDayKey(config: AppConfig): DayKey | null {
  for (let index = DAY_KEYS.length - 1; index >= 0; index -= 1) {
    const dayKey = DAY_KEYS[index];
    if (!config.dailyOperatingHours[dayKey].isClosed) {
      return dayKey;
    }
  }

  return null;
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

function withDeputyAuthHeader(
  headers: HeadersInit | undefined,
  token: string,
  scheme: "Bearer" | "OAuth",
): Headers {
  const merged = new Headers(headers ?? {});
  merged.set("Authorization", `${scheme} ${token}`);
  return merged;
}

async function fetchDeputyWithAuthFallback(
  url: string,
  init: RequestInit,
  token: string,
): Promise<Response> {
  const bearerResponse = await fetch(url, {
    ...init,
    headers: withDeputyAuthHeader(init.headers, token, "Bearer"),
  });

  if (bearerResponse.status !== 401 && bearerResponse.status !== 403) {
    return bearerResponse;
  }

  return fetch(url, {
    ...init,
    headers: withDeputyAuthHeader(init.headers, token, "OAuth"),
  });
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
    if (value <= 0) {
      return null;
    }
    const milliseconds = value > 1e12 ? value : value * 1000;
    const parsed = new Date(milliseconds);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric <= 0) {
      return null;
    }

    const deputyMatch = value.match(/\/Date\((\d+)(?:[+-]\d+)?\)\//);
    if (deputyMatch) {
      const milliseconds = Number(deputyMatch[1]);
      if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
        return null;
      }
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
    const response = await fetchDeputyWithAuthFallback(
      url.toString(),
      {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
      },
      config.deputy.accessToken,
    );

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

async function fetchDeputyTimesheets(
  config: AppConfig,
  window: WindowRange,
): Promise<unknown[]> {
  const minStartUnix = Math.floor((window.start.getTime() - 12 * 60 * 60 * 1000) / 1000);
  const queryPaths = [
    "/api/v1/resource/Timesheet/QUERY",
    "/api/v1/supervise/timesheet/QUERY",
  ];
  const queryErrors: string[] = [];

  for (const path of queryPaths) {
    const url = new URL(path, config.deputy.baseUrl);
    const response = await fetchDeputyWithAuthFallback(
      url.toString(),
      {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        search: {
          s1: {
            field: "StartTime",
            data: minStartUnix,
            type: "ge",
          },
        },
      }),
      cache: "no-store",
      },
      config.deputy.accessToken,
    );

    const body = await parseJsonResponse(response);
    if (!response.ok) {
      queryErrors.push(`${path}: ${response.status}`);
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

  const fallback = await fetchDeputyCollection(config, [
    "/api/v1/resource/Timesheet?max=500",
    "/api/v1/supervise/timesheet?max=500",
  ]);

  if (fallback.length > 0) {
    return fallback;
  }

  throw new Error(`Deputy timesheet query endpoints failed: ${queryErrors.join(", ")}`);
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

    const inProgressRaw = timesheet.IsInProgress ?? timesheet.is_in_progress;
    const isInProgress =
      inProgressRaw === true ||
      inProgressRaw === 1 ||
      inProgressRaw === "1" ||
      inProgressRaw === "true";

    const endAt =
      (isInProgress
        ? null
        : parseDateValue(timesheet.EndTime) ??
          parseDateValue(timesheet.EndTimeLocalized) ??
          parseDateValue(timesheet.end_time) ??
          parseDateValue(timesheet.end)) ??
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

function sumPaymentsInWindow(
  payments: SquarePayment[],
  windowStartMs: number,
  windowEndMs: number,
): number {
  let total = 0;

  for (const payment of payments) {
    const timestamp = payment.createdAt.getTime();
    if (timestamp < windowStartMs || timestamp >= windowEndMs) {
      continue;
    }

    total += Math.max(0, payment.amountCents);
  }

  return total;
}

function resolveTimesheetRate(
  timesheet: DeputyTimesheet,
  fallbackRate: number,
  employeeRates: Map<number, number>,
): number {
  return (
    timesheet.hourlyRate ??
    (timesheet.employeeId !== null
      ? employeeRates.get(timesheet.employeeId) ?? fallbackRate
      : fallbackRate)
  );
}

function computeTimesheetCostCents(
  timesheet: DeputyTimesheet,
  windowStartMs: number,
  windowEndMs: number,
  fallbackRate: number,
  employeeRates: Map<number, number>,
): number {
  let startMs = timesheet.startAt.getTime();
  let endMs = timesheet.endAt ? timesheet.endAt.getTime() : windowEndMs;

  if (endMs <= startMs) {
    return 0;
  }

  startMs = Math.max(startMs, windowStartMs);
  endMs = Math.min(endMs, windowEndMs);

  if (endMs <= startMs) {
    return 0;
  }

  const rate = resolveTimesheetRate(timesheet, fallbackRate, employeeRates);
  if (rate <= 0) {
    return 0;
  }

  const hours = (endMs - startMs) / 3_600_000;
  return Math.round(hours * rate * 100);
}

function sumTimesheetCostInWindow(
  timesheets: DeputyTimesheet[],
  windowStartMs: number,
  windowEndMs: number,
  fallbackRate: number,
  employeeRates: Map<number, number>,
): number {
  return timesheets.reduce(
    (sum, timesheet) =>
      sum +
      computeTimesheetCostCents(
        timesheet,
        windowStartMs,
        windowEndMs,
        fallbackRate,
        employeeRates,
      ),
    0,
  );
}

function computeCurrentHourlySpendRate(
  timesheets: DeputyTimesheet[],
  effectiveNowMs: number,
  fallbackRate: number,
  employeeRates: Map<number, number>,
): number {
  let totalRate = 0;

  for (const timesheet of timesheets) {
    const startMs = timesheet.startAt.getTime();
    const endMs = timesheet.endAt ? timesheet.endAt.getTime() : Number.POSITIVE_INFINITY;
    if (startMs > effectiveNowMs || endMs <= effectiveNowMs) {
      continue;
    }

    const rate = resolveTimesheetRate(timesheet, fallbackRate, employeeRates);
    if (rate > 0) {
      totalRate += rate;
    }
  }

  if (totalRate <= 0) {
    return fallbackRate;
  }

  return totalRate;
}

function buildUnavailablePointOfNoReturn(
  targetWagePercent: number,
  shiftWindow: WindowRange | null = null,
): PointOfNoReturnSnapshot {
  return {
    targetWagePercent,
    status: "unavailable",
    pointTimeIso: null,
    minutesFromNow: null,
    projectedWeekWagePercentAtNow: null,
    shiftStartIso: shiftWindow ? shiftWindow.start.toISOString() : null,
    shiftEndIso: shiftWindow ? shiftWindow.end.toISOString() : null,
  };
}

function buildNotLastShiftPointOfNoReturn(
  targetWagePercent: number,
  shiftWindow: WindowRange | null = null,
): PointOfNoReturnSnapshot {
  return {
    targetWagePercent,
    status: "not_last_shift",
    pointTimeIso: null,
    minutesFromNow: null,
    projectedWeekWagePercentAtNow: null,
    shiftStartIso: shiftWindow ? shiftWindow.start.toISOString() : null,
    shiftEndIso: shiftWindow ? shiftWindow.end.toISOString() : null,
  };
}

function buildPointOfNoReturnSnapshot({
  config,
  dayKey,
  localDate,
  timeZone,
  windowStartMs,
  effectiveNowMs,
  completedBucketCount,
  closedRevenueByBucket,
  laborByBucket,
  openBillsCents,
  baselineFractions,
  projectedRevenueCents,
  weeklyRevenueToDateCents,
  weeklyWagesToDateCents,
  currentHourlySpendRate,
}: PointOfNoReturnInputs): PointOfNoReturnSnapshot {
  const targetWagePercent = config.weeklyPointOfNoReturnWagePercent;
  const lastOpenDayKey = getLastOpenDayKey(config);
  if (!lastOpenDayKey) {
    return buildUnavailablePointOfNoReturn(targetWagePercent);
  }

  if (dayKey !== lastOpenDayKey) {
    return buildNotLastShiftPointOfNoReturn(targetWagePercent);
  }

  const lastShiftHours = config.dailyOperatingHours[lastOpenDayKey];
  const shiftWindow = buildOperatingWindow(localDate, lastShiftHours, timeZone);
  const shiftStartMs = shiftWindow.start.getTime();
  const shiftEndMs = shiftWindow.end.getTime();

  if (effectiveNowMs < shiftStartMs || effectiveNowMs > shiftEndMs) {
    return buildNotLastShiftPointOfNoReturn(targetWagePercent, shiftWindow);
  }

  if (weeklyRevenueToDateCents === null || weeklyWagesToDateCents === null) {
    return buildUnavailablePointOfNoReturn(targetWagePercent, shiftWindow);
  }

  const bucketCount = closedRevenueByBucket.length;
  if (bucketCount === 0 || laborByBucket.length !== bucketCount) {
    return buildUnavailablePointOfNoReturn(targetWagePercent, shiftWindow);
  }

  const currentBucketIndex =
    completedBucketCount > 0
      ? clamp(completedBucketCount - 1, 0, bucketCount - 1)
      : 0;
  const shiftStartBucketIndex = clamp(
    Math.floor((shiftStartMs - windowStartMs) / BUCKET_MILLISECONDS),
    0,
    bucketCount,
  );
  const shiftEndBucketExclusive = clamp(
    Math.ceil((shiftEndMs - windowStartMs) / BUCKET_MILLISECONDS),
    0,
    bucketCount,
  );

  if (shiftEndBucketExclusive <= shiftStartBucketIndex) {
    return buildUnavailablePointOfNoReturn(targetWagePercent, shiftWindow);
  }

  const adjustedRevenueByBucket = closedRevenueByBucket.map((value, index) =>
    completedBucketCount > 0 && index === currentBucketIndex
      ? value + openBillsCents
      : value,
  );

  const cumulativeClosedRevenue = cumulative(closedRevenueByBucket);
  const cumulativeAdjustedRevenue = cumulative(adjustedRevenueByBucket);
  const cumulativeLabor = cumulative(laborByBucket);

  const beforeShiftClosed =
    shiftStartBucketIndex > 0 ? (cumulativeClosedRevenue[shiftStartBucketIndex - 1] ?? 0) : 0;
  const beforeShiftAdjusted =
    shiftStartBucketIndex > 0
      ? (cumulativeAdjustedRevenue[shiftStartBucketIndex - 1] ?? 0)
      : 0;
  const beforeShiftLabor =
    shiftStartBucketIndex > 0 ? (cumulativeLabor[shiftStartBucketIndex - 1] ?? 0) : 0;

  const currentClosedTotal =
    completedBucketCount > 0 ? (cumulativeClosedRevenue[currentBucketIndex] ?? 0) : 0;
  const currentAdjustedTotal =
    completedBucketCount > 0 ? (cumulativeAdjustedRevenue[currentBucketIndex] ?? 0) : 0;
  const currentLaborTotal =
    completedBucketCount > 0 ? (cumulativeLabor[currentBucketIndex] ?? 0) : 0;

  const shiftClosedNow = Math.max(0, currentClosedTotal - beforeShiftClosed);
  const shiftAdjustedNow = Math.max(0, currentAdjustedTotal - beforeShiftAdjusted);
  const shiftLaborNow = Math.max(0, currentLaborTotal - beforeShiftLabor);

  const weekRevenueBeforeShift = Math.max(0, weeklyRevenueToDateCents - shiftClosedNow);
  const weekWagesBeforeShift = Math.max(0, weeklyWagesToDateCents - shiftLaborNow);

  const baselineBeforeShift =
    shiftStartBucketIndex > 0 ? (baselineFractions[shiftStartBucketIndex - 1] ?? 0) : 0;
  const rawExpectedShiftCumulativeByBucket = Array.from({ length: bucketCount }, (_, index) => {
    const baselineAtIndex = baselineFractions[index] ?? 1;
    const shiftFraction = Math.max(0, baselineAtIndex - baselineBeforeShift);
    return Math.round(projectedRevenueCents * shiftFraction);
  });

  const expectedShiftNowRaw =
    shiftStartBucketIndex <= currentBucketIndex
      ? rawExpectedShiftCumulativeByBucket[currentBucketIndex] ?? 0
      : 0;
  const shiftAlignment = shiftAdjustedNow - expectedShiftNowRaw;

  const alignedExpectedShiftCumulativeByBucket = Array.from(
    { length: bucketCount },
    () => 0,
  );
  let runningExpectedShift = 0;
  for (let index = shiftStartBucketIndex; index < shiftEndBucketExclusive; index += 1) {
    const rawShiftValue = rawExpectedShiftCumulativeByBucket[index] ?? 0;
    let aligned = Math.max(0, rawShiftValue + shiftAlignment);
    aligned = Math.max(runningExpectedShift, aligned);

    if (index === currentBucketIndex) {
      aligned = Math.max(runningExpectedShift, shiftAdjustedNow);
    }

    runningExpectedShift = aligned;
    alignedExpectedShiftCumulativeByBucket[index] = aligned;
  }

  const shiftCloseBucketIndex = shiftEndBucketExclusive - 1;
  const expectedShiftClose =
    alignedExpectedShiftCumulativeByBucket[shiftCloseBucketIndex] ?? shiftAdjustedNow;

  if (expectedShiftClose <= 0) {
    return buildUnavailablePointOfNoReturn(targetWagePercent, shiftWindow);
  }

  interface PnrPoint {
    timeMs: number;
    projectedWeekWagePercent: number | null;
  }

  const points: PnrPoint[] = [];

  const pushPoint = (
    timeMs: number,
    revenueSoFarShiftCents: number,
    expectedRevenueSoFarShiftCents: number,
    wagesSoFarShiftCents: number,
  ): void => {
    const expectedRemainingRevenueCents = Math.max(
      0,
      expectedShiftClose - expectedRevenueSoFarShiftCents,
    );
    const remainingShiftHours = Math.max(0, (shiftEndMs - timeMs) / 3_600_000);
    const oneStaffRemainingWagesCents = Math.round(
      remainingShiftHours * config.averageHourlyRate * 100,
    );
    const projectedWeekRevenueCents =
      weekRevenueBeforeShift + revenueSoFarShiftCents + expectedRemainingRevenueCents;
    const projectedWeekWagesCents =
      weekWagesBeforeShift + wagesSoFarShiftCents + oneStaffRemainingWagesCents;

    points.push({
      timeMs,
      projectedWeekWagePercent: toPercent(projectedWeekWagesCents, projectedWeekRevenueCents),
    });
  };

  pushPoint(shiftStartMs, 0, 0, 0);

  for (
    let bucketIndex = shiftStartBucketIndex;
    bucketIndex < shiftEndBucketExclusive;
    bucketIndex += 1
  ) {
    const boundaryTimeMs = Math.min(
      shiftEndMs,
      windowStartMs + (bucketIndex + 1) * BUCKET_MILLISECONDS,
    );

    if (boundaryTimeMs >= effectiveNowMs) {
      break;
    }

    const actualShiftRevenue = Math.max(
      0,
      (cumulativeAdjustedRevenue[bucketIndex] ?? 0) - beforeShiftAdjusted,
    );
    const actualShiftWages = Math.max(
      0,
      (cumulativeLabor[bucketIndex] ?? 0) - beforeShiftLabor,
    );
    const expectedShiftRevenue =
      alignedExpectedShiftCumulativeByBucket[bucketIndex] ?? actualShiftRevenue;

    pushPoint(
      boundaryTimeMs,
      actualShiftRevenue,
      expectedShiftRevenue,
      actualShiftWages,
    );
  }

  pushPoint(effectiveNowMs, shiftAdjustedNow, shiftAdjustedNow, shiftLaborNow);

  for (
    let bucketIndex = Math.max(currentBucketIndex, shiftStartBucketIndex);
    bucketIndex < shiftEndBucketExclusive;
    bucketIndex += 1
  ) {
    const boundaryTimeMs = Math.min(
      shiftEndMs,
      windowStartMs + (bucketIndex + 1) * BUCKET_MILLISECONDS,
    );

    if (boundaryTimeMs <= effectiveNowMs) {
      continue;
    }

    const expectedShiftRevenue = Math.max(
      shiftAdjustedNow,
      alignedExpectedShiftCumulativeByBucket[bucketIndex] ?? shiftAdjustedNow,
    );
    const projectedShiftWages =
      shiftLaborNow +
      Math.round(((boundaryTimeMs - effectiveNowMs) / 3_600_000) * currentHourlySpendRate * 100);

    pushPoint(
      boundaryTimeMs,
      expectedShiftRevenue,
      expectedShiftRevenue,
      projectedShiftWages,
    );
  }

  if (points.length === 0) {
    return buildUnavailablePointOfNoReturn(targetWagePercent, shiftWindow);
  }

  const validPoints = points.filter(
    (point): point is PnrPoint & { projectedWeekWagePercent: number } =>
      point.projectedWeekWagePercent !== null,
  );
  if (validPoints.length === 0) {
    return buildUnavailablePointOfNoReturn(targetWagePercent, shiftWindow);
  }

  const projectedWeekWagePercentAtNow =
    points.find((point) => point.timeMs === effectiveNowMs)?.projectedWeekWagePercent ?? null;

  let crossingTimeMs: number | null = null;
  for (let index = 0; index < validPoints.length; index += 1) {
    const point = validPoints[index];
    if (point.projectedWeekWagePercent < targetWagePercent) {
      continue;
    }

    if (index === 0) {
      crossingTimeMs = point.timeMs;
      break;
    }

    const previousPoint = validPoints[index - 1];

    if (previousPoint.projectedWeekWagePercent >= targetWagePercent) {
      crossingTimeMs = previousPoint.timeMs;
      break;
    }

    const previousDelta = previousPoint.projectedWeekWagePercent - targetWagePercent;
    const currentDelta = point.projectedWeekWagePercent - targetWagePercent;
    const deltaChange = currentDelta - previousDelta;
    if (Math.abs(deltaChange) < 0.00001) {
      crossingTimeMs = point.timeMs;
      break;
    }

    const interpolation = clamp(-previousDelta / deltaChange, 0, 1);
    crossingTimeMs = Math.round(
      previousPoint.timeMs + (point.timeMs - previousPoint.timeMs) * interpolation,
    );
    break;
  }

  if (crossingTimeMs === null) {
    return {
      targetWagePercent,
      status: "safe_all_shift",
      pointTimeIso: null,
      minutesFromNow: null,
      projectedWeekWagePercentAtNow,
      shiftStartIso: shiftWindow.start.toISOString(),
      shiftEndIso: shiftWindow.end.toISOString(),
    };
  }

  const minutesFromNow = Math.round((crossingTimeMs - effectiveNowMs) / 60_000);
  return {
    targetWagePercent,
    status: crossingTimeMs <= effectiveNowMs ? "passed" : "upcoming",
    pointTimeIso: new Date(crossingTimeMs).toISOString(),
    minutesFromNow,
    projectedWeekWagePercentAtNow,
    shiftStartIso: shiftWindow.start.toISOString(),
    shiftEndIso: shiftWindow.end.toISOString(),
  };
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

  const rate = resolveTimesheetRate(timesheet, fallbackRate, employeeRates);

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
  const reportingWindowHours: OperatingHours = {
    openingTime: REPORTING_WINDOW_OPENING,
    closingTime: REPORTING_WINDOW_CLOSING,
    isClosed: false,
  };

  const labels = buildBucketLabels(
    reportingWindowHours.openingTime,
    reportingWindowHours.closingTime,
    BUCKET_MINUTES,
  );
  const bucketCount = labels.length;

  const localDate = getLocalDateParts(serviceReference, config.timezone);
  const window = buildOperatingWindow(localDate, reportingWindowHours, config.timezone);
  const windowStartMs = window.start.getTime();
  const windowEndMs = window.end.getTime();
  const nowMs = Date.now();
  const effectiveNowMs = clamp(nowMs, windowStartMs, windowEndMs);
  const weekWindow = buildServiceWeekWindow(
    localDate,
    dayKey,
    config.timezone,
    effectiveNowMs,
  );
  const weekWindowStartMs = weekWindow.start.getTime();
  const weekWindowEndMs = weekWindow.end.getTime();
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
    reportingWindow: `${REPORTING_WINDOW_OPENING}-${REPORTING_WINDOW_CLOSING}`,
    localDate,
    windowStartIso: window.start.toISOString(),
    windowEndIso: window.end.toISOString(),
    effectiveNowIso: new Date(effectiveNowMs).toISOString(),
    weekWindowStartIso: weekWindow.start.toISOString(),
    weekWindowEndIso: weekWindow.end.toISOString(),
  });

  const [
    squarePaymentsResult,
    squareWeekPaymentsResult,
    squareOpenOrdersResult,
    deputyTimesheetsResult,
    deputyWeekTimesheetsResult,
    deputyEmployeesResult,
  ] = await Promise.all([
    settled(() => fetchSquarePayments(config, window)),
    settled(() => fetchSquarePayments(config, weekWindow)),
    settled(() => fetchSquareOpenOrders(config)),
    settled(() => fetchDeputyTimesheets(config, window)),
    settled(() => fetchDeputyTimesheets(config, weekWindow)),
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
  if (squareWeekPaymentsResult.status === "rejected") {
    log("realtime", "Square week payments failed", squareWeekPaymentsResult.reason);
  }
  if (squareOpenOrdersResult.status === "rejected") {
    log("realtime", "Square open orders failed", squareOpenOrdersResult.reason);
  }
  if (deputyTimesheetsResult.status === "rejected") {
    log("realtime", "Deputy timesheets failed", deputyTimesheetsResult.reason);
  }
  if (deputyWeekTimesheetsResult.status === "rejected") {
    log("realtime", "Deputy week timesheets failed", deputyWeekTimesheetsResult.reason);
  }
  if (deputyEmployeesResult.status === "rejected") {
    log("realtime", "Deputy employees failed", deputyEmployeesResult.reason);
  }

  const payments =
    squarePaymentsResult.status === "fulfilled"
      ? extractSquarePayments(squarePaymentsResult.value ?? [])
      : [];

  const weekPayments =
    squareWeekPaymentsResult.status === "fulfilled"
      ? extractSquarePayments(squareWeekPaymentsResult.value ?? [])
      : [];

  const openOrders =
    squareOpenOrdersResult.status === "fulfilled"
      ? extractSquareOpenOrders(squareOpenOrdersResult.value ?? [])
      : [];

  const timesheets =
    deputyTimesheetsResult.status === "fulfilled"
      ? extractDeputyTimesheets(deputyTimesheetsResult.value ?? [])
      : [];

  const weekTimesheets =
    deputyWeekTimesheetsResult.status === "fulfilled"
      ? extractDeputyTimesheets(deputyWeekTimesheetsResult.value ?? [])
      : [];

  const employeeRates =
    deputyEmployeesResult.status === "fulfilled"
      ? extractDeputyEmployeeRateMap(deputyEmployeesResult.value ?? [])
      : new Map<number, number>();
  const currentHourlySpendRate = computeCurrentHourlySpendRate(
    timesheets,
    effectiveNowMs,
    config.averageHourlyRate,
    employeeRates,
  );

  log("realtime", "Deputy timesheets parsed", {
    rawStatus: deputyTimesheetsResult.status,
    parsedTimesheets: timesheets.length,
    inProgressTimesheets: timesheets.filter((timesheet) => timesheet.endAt === null).length,
    rawWeekStatus: deputyWeekTimesheetsResult.status,
    parsedWeekTimesheets: weekTimesheets.length,
    employeeRateCount: employeeRates.size,
    currentHourlySpendRate,
  });

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
  const weeklyRevenueToDateCents =
    squareWeekPaymentsResult.status === "fulfilled"
      ? sumPaymentsInWindow(weekPayments, weekWindowStartMs, weekWindowEndMs)
      : null;
  const weeklyWagesToDateCents =
    deputyWeekTimesheetsResult.status === "fulfilled"
      ? sumTimesheetCostInWindow(
          weekTimesheets,
          weekWindowStartMs,
          weekWindowEndMs,
          config.averageHourlyRate,
          employeeRates,
        )
      : null;

  log("realtime", "Weekly totals", {
    weekWindowStartIso: weekWindow.start.toISOString(),
    weekWindowEndIso: weekWindow.end.toISOString(),
    weekRevenueStatus: squareWeekPaymentsResult.status,
    weekWagesStatus: deputyWeekTimesheetsResult.status,
    weekRevenueToDateCents: weeklyRevenueToDateCents,
    weekWagesToDateCents: weeklyWagesToDateCents,
  });

  const comparableTotals: number[] = [];
  const comparableSeries: number[][] = [];
  const historicalStatuses: IntegrationStatus[] = [];

  for (let week = 1; week <= 4; week += 1) {
    const compareDate = addDays(localDate, -7 * week);
    const compareWindow = buildOperatingWindow(
      compareDate,
      reportingWindowHours,
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
  const pointOfNoReturn = buildPointOfNoReturnSnapshot({
    config,
    dayKey,
    localDate,
    timeZone: config.timezone,
    windowStartMs,
    effectiveNowMs,
    completedBucketCount,
    closedRevenueByBucket,
    laborByBucket,
    openBillsCents: completedBucketCount > 0 ? openBillsCents : 0,
    baselineFractions,
    projectedRevenueCents: projection.rampedProjectedTotalCents,
    weeklyRevenueToDateCents,
    weeklyWagesToDateCents,
    currentHourlySpendRate,
  });

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
    weekly: {
      weekStartIso: weekWindow.start.toISOString(),
      revenueToDateCents: weeklyRevenueToDateCents,
      wagesToDateCents: weeklyWagesToDateCents,
    },
    pointOfNoReturn,
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
      squareWeekPayments: squareWeekPaymentsResult.status,
      squareOpenOrders: squareOpenOrdersResult.status,
      deputyTimesheets: deputyTimesheetsResult.status,
      deputyWeekTimesheets: deputyWeekTimesheetsResult.status,
      deputyEmployees: deputyEmployeesResult.status,
      historicalWeek1: historicalStatuses[0] ?? "skipped",
      historicalWeek2: historicalStatuses[1] ?? "skipped",
      historicalWeek3: historicalStatuses[2] ?? "skipped",
      historicalWeek4: historicalStatuses[3] ?? "skipped",
    },
    counts: {
      squarePayments: payments.length,
      squareWeekPayments: weekPayments.length,
      squareOpenOrders: openOrders.length,
      squareOpenOrdersExcluded: excludedOpenOrders.length,
      squareOpenOrdersExcludedCarryoverCents: excludedCarryoverBaselineCents,
      squareOpenOrdersExcludedDeltaCents: excludedOpenOrdersDeltaCents,
      deputyTimesheets: timesheets.length,
      deputyWeekTimesheets: weekTimesheets.length,
      deputyEmployees: employeeRates.size,
    },
  };

  log("realtime", "Integration summary", integration);

  return {
    snapshot,
    integration,
  };
}
