"use client";

import { useEffect, useMemo, useState } from "react";
import { DAY_KEYS, DAY_LABELS, getOperatingHoursForDay } from "@/lib/config";
import {
  formatClockIso,
  formatClockMinuteIso,
  formatCurrencyFromCents,
  formatPercent,
} from "@/lib/format";
import { buildLiveSnapshot } from "@/lib/mockData";
import { DayKey, LiveSnapshot, OperatingHours } from "@/lib/types";
import { getZonedNow, minutesInOperatingWindow, parseClockToMinutes } from "@/lib/time";
import { useConfig } from "@/lib/useConfig";

const CHART_WIDTH = 1000;
const CHART_HEIGHT = 280;
const MINUTES_PER_DAY = 24 * 60;

function buildLinePath(values: number[], maxY: number): string {
  if (values.length === 0) {
    return "";
  }

  const xStep = values.length > 1 ? CHART_WIDTH / (values.length - 1) : CHART_WIDTH;

  return values
    .map((value, index) => {
      const clamped = Math.max(0, Math.min(value, maxY));
      const x = index * xStep;
      const y = CHART_HEIGHT - (clamped / maxY) * CHART_HEIGHT;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function isLiveSnapshotPayload(value: unknown): value is LiveSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<LiveSnapshot>;
  return (
    typeof candidate.generatedAtIso === "string" &&
    typeof candidate.dayKey === "string" &&
    typeof candidate.totals === "object" &&
    typeof candidate.comparison === "object" &&
    typeof candidate.timeline === "object"
  );
}

function buildTimeTickLabels(labels: string[]): string[] {
  if (labels.length === 0) {
    return [];
  }

  const anchors = [0, 0.25, 0.5, 0.75, 1];
  const indexes: number[] = [];

  for (const anchor of anchors) {
    const index = Math.round((labels.length - 1) * anchor);
    if (!indexes.includes(index)) {
      indexes.push(index);
    }
  }

  return indexes.map((index) => labels[index]);
}

function getNextDayKey(dayKey: DayKey): DayKey {
  const index = DAY_KEYS.indexOf(dayKey);
  const safeIndex = index >= 0 ? index : 0;
  return DAY_KEYS[(safeIndex + 1) % DAY_KEYS.length];
}

function getRemainingMinutesForServiceDay(
  serviceDayKey: DayKey,
  actualDayKey: DayKey,
  hour: number,
  minute: number,
  operatingHours: OperatingHours,
): number {
  if (operatingHours.isClosed) {
    return 0;
  }

  const nowMinutes = hour * 60 + minute;
  const openingMinutes = parseClockToMinutes(operatingHours.openingTime);
  const closingMinutes = parseClockToMinutes(operatingHours.closingTime);
  const operatingMinutes = minutesInOperatingWindow(
    operatingHours.openingTime,
    operatingHours.closingTime,
  );
  const crossesMidnight = closingMinutes <= openingMinutes;
  const isServiceDay = actualDayKey === serviceDayKey;
  const isNextCalendarDay = actualDayKey === getNextDayKey(serviceDayKey);

  if (!crossesMidnight) {
    if (!isServiceDay) {
      return 0;
    }

    if (nowMinutes < openingMinutes) {
      return operatingMinutes;
    }

    if (nowMinutes >= closingMinutes) {
      return 0;
    }

    return closingMinutes - nowMinutes;
  }

  if (isServiceDay) {
    if (nowMinutes >= openingMinutes) {
      return MINUTES_PER_DAY - nowMinutes + closingMinutes;
    }

    return operatingMinutes;
  }

  if (isNextCalendarDay) {
    if (nowMinutes < closingMinutes) {
      return closingMinutes - nowMinutes;
    }

    return 0;
  }

  return 0;
}

function getRemainingWeekMinutes(
  now: Date,
  timeZone: string,
  serviceDayKey: DayKey,
  getHoursForDay: (dayKey: DayKey) => OperatingHours,
): number {
  const zonedNow = getZonedNow(now, timeZone);
  const currentDayHours = getHoursForDay(serviceDayKey);
  const currentDayRemaining = getRemainingMinutesForServiceDay(
    serviceDayKey,
    zonedNow.dayKey,
    zonedNow.hour,
    zonedNow.minute,
    currentDayHours,
  );

  const serviceDayIndex = DAY_KEYS.indexOf(serviceDayKey);
  const safeServiceDayIndex = serviceDayIndex >= 0 ? serviceDayIndex : 0;

  let remainingMinutes = currentDayRemaining;
  for (let index = safeServiceDayIndex + 1; index < DAY_KEYS.length; index += 1) {
    const dayHours = getHoursForDay(DAY_KEYS[index]);
    if (dayHours.isClosed) {
      continue;
    }

    remainingMinutes += minutesInOperatingWindow(dayHours.openingTime, dayHours.closingTime);
  }

  return Math.max(0, remainingMinutes);
}

interface RealtimeErrorState {
  status: number;
  message: string;
  debugCode: string | null;
  missing: string[];
}

function parseRealtimeError(status: number, payload: unknown): RealtimeErrorState {
  const objectPayload =
    payload && typeof payload === "object"
      ? (payload as {
          error?: unknown;
          message?: unknown;
          debugCode?: unknown;
          missing?: unknown;
        })
      : null;

  const message =
    typeof objectPayload?.message === "string"
      ? objectPayload.message
      : typeof objectPayload?.error === "string"
        ? objectPayload.error
        : `Realtime request failed (HTTP ${status})`;

  const debugCode =
    typeof objectPayload?.debugCode === "string" ? objectPayload.debugCode : null;
  const missing = Array.isArray(objectPayload?.missing)
    ? objectPayload.missing.filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    status,
    message,
    debugCode,
    missing,
  };
}

function describePointOfNoReturn(
  snapshot: LiveSnapshot,
  timeZone: string,
  defaultTargetPercent: number,
): { targetPercent: number; detail: string } {
  const pointOfNoReturn = snapshot.pointOfNoReturn;
  const targetPercent =
    pointOfNoReturn?.targetWagePercent ?? defaultTargetPercent;

  if (!pointOfNoReturn) {
    return {
      targetPercent,
      detail: "N/A",
    };
  }

  if (
    (pointOfNoReturn.status === "upcoming" || pointOfNoReturn.status === "passed") &&
    pointOfNoReturn.pointTimeIso
  ) {
    const timeLabel = formatClockMinuteIso(pointOfNoReturn.pointTimeIso, timeZone);
    const minutes = Math.abs(pointOfNoReturn.minutesFromNow ?? 0);
    return {
      targetPercent,
      detail:
        pointOfNoReturn.status === "upcoming"
          ? `${timeLabel} (in ${minutes} mins)`
          : `${timeLabel} (${minutes} mins ago)`,
    };
  }

  if (pointOfNoReturn.status === "safe_all_shift") {
    return {
      targetPercent,
      detail: "Safe all shift",
    };
  }

  if (pointOfNoReturn.status === "not_last_shift") {
    return {
      targetPercent,
      detail: "Active on final weekly shift only",
    };
  }

  return {
    targetPercent,
    detail: "N/A",
  };
}

export default function DashboardPage(): React.JSX.Element {
  const { config, ready, setConfig } = useConfig();
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [dataError, setDataError] = useState<RealtimeErrorState | null>(null);

  useEffect(() => {
    if (!ready) {
      return;
    }

    let alive = true;

    const refresh = async (): Promise<void> => {
      if (config.dataSourceMode === "sample") {
        if (!alive) {
          return;
        }

        setSnapshot(buildLiveSnapshot(config, new Date()));
        setDataError(null);
        return;
      }

      const endpoint = "/api/live";

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            source: "realtime",
            config,
          }),
        });

        const payload = (await response.json()) as unknown;

        if (!response.ok) {
          if (!alive) {
            return;
          }

          const realtimeError = parseRealtimeError(response.status, payload);
          setDataError(realtimeError);
          console.warn("[barops:dashboard] realtime /api/live error", {
            ...realtimeError,
            payload,
          });
          return;
        }

        if (!isLiveSnapshotPayload(payload)) {
          if (!alive) {
            return;
          }

          setDataError({
            status: 500,
            message: "Realtime response shape is invalid.",
            debugCode: null,
            missing: [],
          });
          console.warn("[barops:dashboard] realtime /api/live invalid payload", payload);
          return;
        }

        if (!alive) {
          return;
        }

        setSnapshot(payload);
        setDataError(null);
        console.info("[barops:dashboard] realtime /api/live payload", payload);
      } catch {
        if (!alive) {
          return;
        }

        setDataError({
          status: 0,
          message: "Unable to reach realtime endpoint.",
          debugCode: "CLIENT-NETWORK",
          missing: [],
        });
        console.warn("[barops:dashboard] realtime /api/live network failure");
      }
    };

    void refresh();
    const intervalId = window.setInterval(
      () => void refresh(),
      config.refreshIntervalSeconds * 1000,
    );

    return () => {
      alive = false;
      window.clearInterval(intervalId);
    };
  }, [config, ready]);

  const currentSeries = useMemo(() => {
    if (!snapshot) {
      return [];
    }

    let previous = snapshot.timeline.wageSeries[0]?.historicalPercent ?? 0;
    return snapshot.timeline.wageSeries.map((point) => {
      if (point.currentPercent === null) {
        return previous;
      }

      previous = point.currentPercent;
      return point.currentPercent;
    });
  }, [snapshot]);

  const historicalSeries = useMemo(
    () => snapshot?.timeline.wageSeries.map((point) => point.historicalPercent) ?? [],
    [snapshot],
  );

  const targetSeries = useMemo(
    () => snapshot?.timeline.wageSeries.map((point) => point.targetPercent) ?? [],
    [snapshot],
  );

  const maxWageAxis = useMemo(() => {
    const maxValue = Math.max(15, ...currentSeries, ...historicalSeries, ...targetSeries);
    return Math.ceil(maxValue * 1.15);
  }, [currentSeries, historicalSeries, targetSeries]);

  const yAxisTicks = useMemo(
    () => [maxWageAxis, Math.round(maxWageAxis * 0.66), Math.round(maxWageAxis * 0.33), 0],
    [maxWageAxis],
  );

  const timeTickLabels = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return buildTimeTickLabels(snapshot.timeline.wageSeries.map((point) => point.label));
  }, [snapshot]);

  if (!ready) {
    return (
      <section className="grid-cards">
        <article className="card">
          <h2 className="card-title">Loading Dashboard</h2>
          <p className="muted">Preparing configuration and live snapshot...</p>
        </article>
      </section>
    );
  }

  if (!snapshot && dataError && config.dataSourceMode === "realtime") {
    return (
      <section className="grid-cards">
        <article className="card">
          <h2 className="card-title">Realtime Data Unavailable</h2>
          <p className="warn">{dataError.message}</p>
          <p className="muted">Status: {dataError.status}</p>
          <p className="muted">
            Debug Code:{" "}
            <code className="debug-code">{dataError.debugCode ?? "N/A"}</code>
          </p>
          {dataError.missing.length > 0 ? (
            <p className="muted">Missing: {dataError.missing.join(", ")}</p>
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="button-secondary"
              onClick={() =>
                setConfig((previous) => ({
                  ...previous,
                  dataSourceMode: "sample",
                }))
              }
            >
              Switch To Sample
            </button>
          </div>
        </article>
      </section>
    );
  }

  if (!snapshot) {
    return (
      <section className="grid-cards">
        <article className="card">
          <h2 className="card-title">Loading Dashboard</h2>
          <p className="muted">Preparing configuration and live snapshot...</p>
        </article>
      </section>
    );
  }

  const targetRevenueCents = config.dailyTargets[snapshot.dayKey].revenueTargetCents;
  const targetWagePercent = config.dailyTargets[snapshot.dayKey].wageTargetPercent;
  const operatingHours = getOperatingHoursForDay(config, snapshot.dayKey);
  const excludedLabelSummary =
    config.excludedOpenOrderLabels.length > 0
      ? config.excludedOpenOrderLabels.join(", ")
      : "none";

  const revenueScaleMax = Math.max(
    1,
    snapshot.totals.projectedRevenueCents,
    snapshot.comparison.lastWeekRevenueCents,
    snapshot.comparison.rollingAverageRevenueCents,
  );
  const projectionMarkerPercent = Math.min(
    100,
    (snapshot.totals.projectedRevenueCents / revenueScaleMax) * 100,
  );

  const actualFillPercent =
    revenueScaleMax > 0
      ? Math.min(100, (snapshot.totals.adjustedRevenueCents / revenueScaleMax) * 100)
      : 0;

  const lastWeekMarkerPercent = Math.min(
    100,
    (snapshot.comparison.lastWeekRevenueCents / revenueScaleMax) * 100,
  );
  const rollingMarkerPercent = Math.min(
    100,
    (snapshot.comparison.rollingAverageRevenueCents / revenueScaleMax) * 100,
  );

  const positiveProjection = snapshot.totals.projectedVsTargetPercent >= 0;
  const remainingWeekMinutes = getRemainingWeekMinutes(
    new Date(snapshot.generatedAtIso),
    config.timezone,
    snapshot.dayKey,
    (dayKey) => getOperatingHoursForDay(config, dayKey),
  );
  const remainingWeekHours = remainingWeekMinutes / 60;
  const projectedSingleStaffWagesCents = Math.round(
    remainingWeekHours * config.averageHourlyRate * 100,
  );
  const weeklyRevenueToDateCents = snapshot.weekly?.revenueToDateCents ?? null;
  const weeklyWagesSpentToDateCents = snapshot.weekly?.wagesToDateCents ?? null;
  const weeklyProjectedWagesCents =
    weeklyWagesSpentToDateCents === null
      ? null
      : weeklyWagesSpentToDateCents + projectedSingleStaffWagesCents;
  const pointOfNoReturn = describePointOfNoReturn(
    snapshot,
    config.timezone,
    config.weeklyPointOfNoReturnWagePercent,
  );

  return (
    <section className="grid-cards">
      <article className="card hero">
        <p className="eyebrow">{DAY_LABELS[snapshot.dayKey]} Service</p>
        <h2 className="kpi">{formatCurrencyFromCents(snapshot.totals.projectedRevenueCents)}</h2>
        <p className="muted">Projected Revenue</p>

        <div className="source-controls">
          <span className="muted">Data Source</span>
          <div className="source-toggle" role="group" aria-label="Data source toggle">
            <button
              type="button"
              className={`source-button ${config.dataSourceMode === "sample" ? "active" : ""}`}
              onClick={() =>
                setConfig((previous) => ({
                  ...previous,
                  dataSourceMode: "sample",
                }))
              }
            >
              Sample
            </button>
            <button
              type="button"
              className={`source-button ${config.dataSourceMode === "realtime" ? "active" : ""}`}
              onClick={() =>
                setConfig((previous) => ({
                  ...previous,
                  dataSourceMode: "realtime",
                }))
              }
            >
              Realtime (Square + Deputy)
            </button>
          </div>
          <p className="muted endpoint-line">
            Realtime credentials are loaded from server environment variables. Excluded
            open-table carryover labels: {excludedLabelSummary}.
          </p>
          {dataError ? (
            <p className="warn">
              {dataError.message}{" "}
              <code className="debug-code">{dataError.debugCode ?? "N/A"}</code>
            </p>
          ) : null}
          {dataError && dataError.missing.length > 0 ? (
            <p className="muted">Missing: {dataError.missing.join(", ")}</p>
          ) : null}
        </div>

        <div className="kpi-subgrid">
          <p>
            Target: <strong>{formatCurrencyFromCents(targetRevenueCents)}</strong>
          </p>
          <p className={positiveProjection ? "good" : "warn"}>
            Delta: {formatPercent(snapshot.totals.projectedVsTargetPercent, 1)}
          </p>
          <p>Actual + Open: {formatCurrencyFromCents(snapshot.totals.adjustedRevenueCents)}</p>
          <p>Labor: {formatCurrencyFromCents(snapshot.totals.laborCostCents)}</p>
          <p>
            Wage: <strong>{formatPercent(snapshot.totals.wagePercent, 1)}</strong>
          </p>
          <p>Target Wage: {formatPercent(targetWagePercent, 1)}</p>
          <p>
            Operating Hours:{" "}
            {operatingHours.isClosed
              ? "Closed"
              : `${operatingHours.openingTime} - ${operatingHours.closingTime}`}
          </p>
          <p>Reporting Window: 05:00 - 05:00</p>
          <p className="muted">
            Last refresh {formatClockIso(snapshot.generatedAtIso, config.timezone)}
          </p>
        </div>
      </article>

      <article className="card">
        <h3 className="card-title">Revenue Pace</h3>
        <p className="muted">
          Fill tracks tonight&apos;s pace while markers show projection, last week, and 4-week context.
        </p>

        <div className="bar-stack">
          <div className="bar-wrap">
            <span className="bar-label">Revenue Pace</span>
            <div className="bar-scale">
              <div className="context-base">
                <div className="bar-fill good-bg context-fill" style={{ width: `${actualFillPercent}%` }} />
                <span
                  className="marker marker-projection"
                  style={{ left: `${projectionMarkerPercent}%` }}
                >
                  <span className="marker-label">Projection</span>
                </span>
                <span className="marker marker-last" style={{ left: `${lastWeekMarkerPercent}%` }}>
                  <span className="marker-label">Last Week</span>
                </span>
                <span className="marker marker-rolling" style={{ left: `${rollingMarkerPercent}%` }}>
                  <span className="marker-label">4W Avg</span>
                </span>
              </div>
            </div>
            <p className="bar-values">
              {formatCurrencyFromCents(snapshot.totals.adjustedRevenueCents)} /{" "}
              {formatCurrencyFromCents(snapshot.totals.projectedRevenueCents)}
            </p>
            <p className="bar-values">
              Last Week {formatCurrencyFromCents(snapshot.comparison.lastWeekRevenueCents)} | 4W Avg{" "}
              {formatCurrencyFromCents(snapshot.comparison.rollingAverageRevenueCents)}
            </p>
          </div>
        </div>
      </article>

      <article className="card chart-card">
        <h3 className="card-title">Wage Percent Trend</h3>
        <p className="muted">
          Wage % on the vertical axis and service time on the horizontal axis.
        </p>
        <p className="muted">
          Week revenue so far (Square):{" "}
          <strong>
            {weeklyRevenueToDateCents === null
              ? "N/A"
              : formatCurrencyFromCents(weeklyRevenueToDateCents)}
          </strong>{" "}
          | Wages spent so far (Deputy):{" "}
          <strong>
            {weeklyWagesSpentToDateCents === null
              ? "N/A"
              : formatCurrencyFromCents(weeklyWagesSpentToDateCents)}
          </strong>
        </p>
        <p className="muted">
          Remaining week roster time: <strong>{remainingWeekHours.toFixed(1)}h</strong> | Remaining
          wages projection (1 staff):{" "}
          <strong>{formatCurrencyFromCents(projectedSingleStaffWagesCents)}</strong> | Weekly
          projected wages:{" "}
          <strong>
            {weeklyProjectedWagesCents === null
              ? "N/A"
              : formatCurrencyFromCents(weeklyProjectedWagesCents)}
          </strong>
        </p>
        <p className="muted">
          Point of no return target:{" "}
          <strong>{formatPercent(pointOfNoReturn.targetPercent, 1)}</strong> | Point of no
          return: <strong>{pointOfNoReturn.detail}</strong>
        </p>

        <div className="wage-chart-layout">
          <div className="wage-y-axis" aria-hidden="true">
            {yAxisTicks.map((tick, index) => (
              <span key={`${tick}-${index}`}>{tick}%</span>
            ))}
            <strong>Wage %</strong>
          </div>

          <div className="wage-chart-main">
            <svg
              className="chart-svg"
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              preserveAspectRatio="none"
              role="img"
              aria-label="Wage percent trend chart"
            >
              <path
                d={buildLinePath(historicalSeries, maxWageAxis)}
                className="line-historical"
              />
              <path d={buildLinePath(targetSeries, maxWageAxis)} className="line-target" />
              <path d={buildLinePath(currentSeries, maxWageAxis)} className="line-current" />
            </svg>

            <div className="x-axis">
              {timeTickLabels.map((label, index) => (
                <span key={`${label}-${index}`}>{label}</span>
              ))}
            </div>
            <p className="axis-title">Time</p>
          </div>
        </div>

        <div className="legend">
          <span>
            <i className="legend-line current" /> Current
          </span>
          <span>
            <i className="legend-line target" /> Target
          </span>
          <span>
            <i className="legend-line historical" /> Historical Avg
          </span>
        </div>
      </article>
    </section>
  );
}
