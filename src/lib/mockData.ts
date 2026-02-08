import { DAY_KEYS } from "@/lib/config";
import {
  AppConfig,
  ComparableNight,
  DayKey,
  HistorySnapshot,
  LiveSnapshot,
  PointOfNoReturnSnapshot,
  RevenueBucket,
  WeeklySnapshot,
} from "@/lib/types";
import { averageSeries, buildBaselineFractions, computeProjection, computeWageSeries, cumulative, getInterpolatedBaselineFractionAtElapsedMinutes, toPercent } from "@/lib/math";
import {
  buildBucketLabels,
  BUSINESS_DAY_START_HOUR,
  getZonedNow,
  minutesInOperatingWindow,
  minutesSinceOpening,
  toBusinessDayReference,
} from "@/lib/time";
const REPORTING_WINDOW_OPENING = "05:00";
const REPORTING_WINDOW_CLOSING = "05:00";

const BUCKET_MINUTES = 15;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function seedFromString(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(seed: number, index: number): number {
  const raw = Math.sin(seed * 0.001 + index * 12.9898) * 43758.5453;
  return raw - Math.floor(raw);
}

function buildDemandShape(bucketCount: number, seed: number): number[] {
  return Array.from({ length: bucketCount }, (_, index) => {
    const progress = bucketCount > 1 ? index / (bucketCount - 1) : 0;
    const early = Math.exp(-Math.pow((progress - 0.2) * 5, 2)) * 0.55;
    const rush = Math.exp(-Math.pow((progress - 0.56) * 5.5, 2)) * 1.25;
    const late = Math.exp(-Math.pow((progress - 0.82) * 8, 2)) * 0.5;
    const noise = 0.8 + seededUnit(seed, index) * 0.45;
    return (0.08 + early + rush + late) * noise;
  });
}

function scaleShapeToTotal(shape: number[], totalCents: number): number[] {
  const shapeSum = shape.reduce((sum, value) => sum + value, 0);
  if (shape.length === 0 || shapeSum <= 0) {
    return [];
  }

  const scaled = shape.map((value) => Math.round((value / shapeSum) * totalCents));
  const remainder = totalCents - scaled.reduce((sum, value) => sum + value, 0);
  if (scaled.length > 0) {
    scaled[scaled.length - 1] += remainder;
  }

  return scaled;
}

function buildComparableNights(
  keySeed: number,
  targetRevenueCents: number,
  targetWagePercent: number,
  bucketCount: number,
): ComparableNight[] {
  const nights: ComparableNight[] = [];

  for (let nightIndex = 0; nightIndex < 4; nightIndex += 1) {
    const nightSeed = keySeed + nightIndex * 97;
    const performanceFactor = 0.8 + seededUnit(nightSeed, 100 + nightIndex) * 0.42;
    const totalRevenueCents = Math.round(targetRevenueCents * performanceFactor);

    const shape = buildDemandShape(bucketCount, nightSeed);
    const bucketRevenueCents = scaleShapeToTotal(shape, totalRevenueCents);
    const cumulativeRevenue = cumulative(bucketRevenueCents);

    const cumulativeFractions =
      totalRevenueCents > 0
        ? cumulativeRevenue.map((value) => value / totalRevenueCents)
        : bucketRevenueCents.map(() => 0);

    const wagePercentByBucket = Array.from({ length: bucketCount }, (_, bucketIndex) => {
      const progress = bucketCount > 1 ? bucketIndex / (bucketCount - 1) : 0;
      const drift = (seededUnit(nightSeed, 300 + bucketIndex) - 0.5) * 3.2;
      const shapeWave = Math.sin(progress * Math.PI) * 1.1;
      return clamp(targetWagePercent + shapeWave + drift, 12, 45);
    });

    nights.push({
      totalRevenueCents,
      bucketRevenueCents,
      cumulativeFractions,
      wagePercentByBucket,
    });
  }

  return nights;
}

function withFutureBucketsZeroed(values: number[], completedBucketCount: number): number[] {
  return values.map((value, index) => (index < completedBucketCount ? value : 0));
}

function averageRevenue(nights: ComparableNight[]): number {
  if (nights.length === 0) {
    return 0;
  }

  return Math.round(
    nights.reduce((sum, night) => sum + night.totalRevenueCents, 0) / nights.length,
  );
}

function getDayIndex(dayKey: DayKey): number {
  const index = DAY_KEYS.indexOf(dayKey);
  return index >= 0 ? index : 0;
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

function buildSampleWeeklySnapshot(
  config: AppConfig,
  dayKey: DayKey,
  serviceReference: Date,
  actualRevenueCents: number,
  laborCostCents: number,
): WeeklySnapshot {
  const dayIndex = getDayIndex(dayKey);
  const weekStartIso = new Date(
    serviceReference.getTime() - dayIndex * MILLISECONDS_PER_DAY,
  ).toISOString();
  const dateKey = serviceReference.toISOString().slice(0, 10);
  const seed = seedFromString(`${config.storeName}:${dateKey}:weekly`);

  let priorRevenueCents = 0;
  let priorWagesCents = 0;

  for (let index = 0; index < dayIndex; index += 1) {
    const priorDayKey = DAY_KEYS[index];
    const target = config.dailyTargets[priorDayKey];
    const revenueFactor = 0.84 + seededUnit(seed, 300 + index) * 0.32;
    const dayRevenueCents = Math.round(target.revenueTargetCents * revenueFactor);
    const wageFactor = 0.9 + seededUnit(seed, 500 + index) * 0.22;
    const dayWagesCents = Math.round(
      dayRevenueCents * (target.wageTargetPercent / 100) * wageFactor,
    );

    priorRevenueCents += dayRevenueCents;
    priorWagesCents += dayWagesCents;
  }

  return {
    weekStartIso,
    revenueToDateCents: Math.max(0, priorRevenueCents + actualRevenueCents),
    wagesToDateCents: Math.max(0, priorWagesCents + laborCostCents),
  };
}

function buildSamplePointOfNoReturn(
  config: AppConfig,
  dayKey: DayKey,
  now: Date,
  projectedWeekWagePercentAtNow: number | null,
): PointOfNoReturnSnapshot {
  const targetWagePercent = config.weeklyPointOfNoReturnWagePercent;
  const lastOpenDayKey = getLastOpenDayKey(config);

  if (!lastOpenDayKey) {
    return {
      targetWagePercent,
      status: "unavailable",
      pointTimeIso: null,
      minutesFromNow: null,
      projectedWeekWagePercentAtNow,
      shiftStartIso: null,
      shiftEndIso: null,
    };
  }

  if (dayKey !== lastOpenDayKey) {
    return {
      targetWagePercent,
      status: "not_last_shift",
      pointTimeIso: null,
      minutesFromNow: null,
      projectedWeekWagePercentAtNow,
      shiftStartIso: null,
      shiftEndIso: null,
    };
  }

  if (projectedWeekWagePercentAtNow === null) {
    return {
      targetWagePercent,
      status: "unavailable",
      pointTimeIso: null,
      minutesFromNow: null,
      projectedWeekWagePercentAtNow,
      shiftStartIso: null,
      shiftEndIso: null,
    };
  }

  const deltaPercent = projectedWeekWagePercentAtNow - targetWagePercent;
  if (deltaPercent <= -1.2) {
    return {
      targetWagePercent,
      status: "safe_all_shift",
      pointTimeIso: null,
      minutesFromNow: null,
      projectedWeekWagePercentAtNow,
      shiftStartIso: null,
      shiftEndIso: null,
    };
  }

  const minutesMagnitude = Math.max(
    8,
    Math.min(210, Math.round(Math.abs(deltaPercent) * 75)),
  );
  if (deltaPercent > 0) {
    return {
      targetWagePercent,
      status: "passed",
      pointTimeIso: new Date(now.getTime() - minutesMagnitude * 60_000).toISOString(),
      minutesFromNow: -minutesMagnitude,
      projectedWeekWagePercentAtNow,
      shiftStartIso: null,
      shiftEndIso: null,
    };
  }

  return {
    targetWagePercent,
    status: "upcoming",
    pointTimeIso: new Date(now.getTime() + minutesMagnitude * 60_000).toISOString(),
    minutesFromNow: minutesMagnitude,
    projectedWeekWagePercentAtNow,
    shiftStartIso: null,
    shiftEndIso: null,
  };
}

function buildHistoryModel(config: AppConfig, now: Date): HistorySnapshot {
  const serviceReference = toBusinessDayReference(now, BUSINESS_DAY_START_HOUR);
  const zonedNow = getZonedNow(serviceReference, config.timezone);
  const targets = config.dailyTargets[zonedNow.dayKey];

  const labels = buildBucketLabels(
    REPORTING_WINDOW_OPENING,
    REPORTING_WINDOW_CLOSING,
    BUCKET_MINUTES,
  );
  const keySeed = seedFromString(`${zonedNow.dayKey}:${config.storeName}`);

  const comparableNights = buildComparableNights(
    keySeed,
    targets.revenueTargetCents,
    targets.wageTargetPercent,
    labels.length,
  );

  return {
    dayKey: zonedNow.dayKey,
    lastWeekRevenueCents: comparableNights[0]?.totalRevenueCents ?? 0,
    rollingAverageRevenueCents: averageRevenue(comparableNights),
    comparableNights,
  };
}

export function buildHistorySnapshot(config: AppConfig, now = new Date()): HistorySnapshot {
  return buildHistoryModel(config, now);
}

function buildLaborSeries(
  closedRevenueByBucket: number[],
  completedBucketCount: number,
  targetWagePercent: number,
  averageHourlyRate: number,
): number[] {
  const cumulativeRevenue = cumulative(closedRevenueByBucket);
  const cumulativeLabor: number[] = [];

  for (let index = 0; index < closedRevenueByBucket.length; index += 1) {
    if (index >= completedBucketCount) {
      cumulativeLabor.push(cumulativeLabor[index - 1] ?? 0);
      continue;
    }

    const progress =
      closedRevenueByBucket.length > 1 ? index / (closedRevenueByBucket.length - 1) : 0;
    const baselineStaff = 2 + Math.round(progress * 2);
    const fixedQuarterHourCost = Math.round(averageHourlyRate * 100 * baselineStaff * 0.25);
    const accumulatedFixed = fixedQuarterHourCost * (index + 1);

    const swing = 0.92 + 0.14 * Math.sin(progress * Math.PI);
    const variableLabor = Math.round(
      cumulativeRevenue[index] * (targetWagePercent / 100) * swing,
    );

    cumulativeLabor.push(Math.max(accumulatedFixed, variableLabor));
  }

  return cumulativeLabor;
}

function buildRevenueBuckets(
  labels: string[],
  closedRevenueByBucket: number[],
  cumulativeLabor: number[],
  openBillsCents: number,
  completedBucketCount: number,
): RevenueBucket[] {
  return labels.map((label, bucketIndex) => {
    const previousLabor = bucketIndex === 0 ? 0 : cumulativeLabor[bucketIndex - 1] ?? 0;
    const currentLabor = cumulativeLabor[bucketIndex] ?? previousLabor;
    const laborCostCents = Math.max(0, currentLabor - previousLabor);

    const openBills = bucketIndex === Math.max(0, completedBucketCount - 1) ? openBillsCents : 0;

    return {
      bucketIndex,
      label,
      closedRevenueCents: closedRevenueByBucket[bucketIndex] ?? 0,
      openBillsCents: openBills,
      laborCostCents,
    };
  });
}

export function buildLiveSnapshot(config: AppConfig, now = new Date()): LiveSnapshot {
  const history = buildHistoryModel(config, now);
  const targets = config.dailyTargets[history.dayKey];
  const serviceReference = toBusinessDayReference(now, BUSINESS_DAY_START_HOUR);

  const labels = buildBucketLabels(
    REPORTING_WINDOW_OPENING,
    REPORTING_WINDOW_CLOSING,
    BUCKET_MINUTES,
  );
  const bucketCount = labels.length;

  const keySeed = seedFromString(
    `${config.storeName}:${history.dayKey}:${now.toISOString().slice(0, 10)}`,
  );

  const demandShape = buildDemandShape(bucketCount, keySeed + 1000);
  const tonightPerformance = 0.86 + seededUnit(keySeed, 777) * 0.3;
  const nightlyExpectation = Math.round(history.rollingAverageRevenueCents * tonightPerformance);
  const fullNightRevenue = scaleShapeToTotal(demandShape, nightlyExpectation);

  const zonedNow = getZonedNow(serviceReference, config.timezone);
  const operatingWindowMinutes = minutesInOperatingWindow(
    REPORTING_WINDOW_OPENING,
    REPORTING_WINDOW_CLOSING,
  );
  const elapsedMinutes = minutesSinceOpening(
    zonedNow.hour,
    zonedNow.minute,
    REPORTING_WINDOW_OPENING,
    REPORTING_WINDOW_CLOSING,
  );
  const elapsedFraction = clamp(elapsedMinutes / operatingWindowMinutes, 0, 1);
  const completedBucketCount = clamp(Math.ceil(elapsedMinutes / BUCKET_MINUTES), 0, bucketCount);

  const closedRevenueByBucket = withFutureBucketsZeroed(fullNightRevenue, completedBucketCount);
  const cumulativeClosedRevenue = cumulative(closedRevenueByBucket);
  const actualRevenueCents = cumulativeClosedRevenue[completedBucketCount - 1] ?? 0;

  const openBillLookbackBuckets = Math.max(
    1,
    Math.round(config.averageBillLengthMinutes / BUCKET_MINUTES),
  );
  const lookbackStart = Math.max(0, completedBucketCount - openBillLookbackBuckets);
  const recentClosedRevenue = closedRevenueByBucket
    .slice(lookbackStart, completedBucketCount)
    .reduce((sum, value) => sum + value, 0);
  const openBillsMultiplier = 0.16 + seededUnit(keySeed, 901) * 0.2;
  const openBillsCents =
    completedBucketCount > 0 ? Math.round(recentClosedRevenue * openBillsMultiplier) : 0;

  const adjustedRevenueCents = actualRevenueCents + openBillsCents;

  const baselineFractions = buildBaselineFractions(
    history.comparableNights.map((night) => night.bucketRevenueCents),
  );
  const baselineFractionAtNow = getInterpolatedBaselineFractionAtElapsedMinutes(
    baselineFractions,
    elapsedMinutes,
    BUCKET_MINUTES,
  );
  const projection = computeProjection(
    adjustedRevenueCents,
    baselineFractionAtNow,
    history.rollingAverageRevenueCents,
    elapsedFraction,
  );

  const cumulativeLabor = buildLaborSeries(
    closedRevenueByBucket,
    completedBucketCount,
    targets.wageTargetPercent,
    config.averageHourlyRate,
  );
  const laborCostCents = cumulativeLabor[completedBucketCount - 1] ?? 0;
  const wagePercent = toPercent(laborCostCents, adjustedRevenueCents);

  const historicalWagePercentByBucket = averageSeries(
    history.comparableNights.map((night) => night.wagePercentByBucket),
  );

  const wageSeries = computeWageSeries(
    labels,
    cumulativeClosedRevenue,
    cumulativeLabor,
    targets.wageTargetPercent,
    historicalWagePercentByBucket,
  );

  const projectedVsTargetPercent =
    targets.revenueTargetCents > 0
      ? ((projection.rampedProjectedTotalCents - targets.revenueTargetCents) /
          targets.revenueTargetCents) *
        100
      : 0;

  const weekly = buildSampleWeeklySnapshot(
    config,
    history.dayKey,
    serviceReference,
    actualRevenueCents,
    laborCostCents,
  );
  const remainingWindowMinutes = Math.max(0, operatingWindowMinutes - elapsedMinutes);
  const projectedRemainingWagesCents = Math.round(
    (remainingWindowMinutes / 60) * config.averageHourlyRate * 100,
  );
  const projectedRemainingRevenueCents = Math.max(
    0,
    projection.rampedProjectedTotalCents - adjustedRevenueCents,
  );
  const projectedWeekRevenueAtNow = Math.max(
    0,
    (weekly.revenueToDateCents ?? 0) + projectedRemainingRevenueCents,
  );
  const projectedWeekWagesAtNow = Math.max(
    0,
    (weekly.wagesToDateCents ?? 0) + projectedRemainingWagesCents,
  );
  const projectedWeekWagePercentAtNow = toPercent(
    projectedWeekWagesAtNow,
    projectedWeekRevenueAtNow,
  );
  const pointOfNoReturn = buildSamplePointOfNoReturn(
    config,
    history.dayKey,
    now,
    projectedWeekWagePercentAtNow,
  );

  return {
    generatedAtIso: now.toISOString(),
    dayKey: history.dayKey,
    weekly,
    pointOfNoReturn,
    totals: {
      actualRevenueCents,
      openBillsCents,
      adjustedRevenueCents,
      projectedRevenueCents: projection.rampedProjectedTotalCents,
      projectedVsTargetPercent,
      laborCostCents,
      wagePercent,
    },
    comparison: {
      lastWeekRevenueCents: history.lastWeekRevenueCents,
      rollingAverageRevenueCents: history.rollingAverageRevenueCents,
    },
    projection,
    timeline: {
      revenueBuckets: buildRevenueBuckets(
        labels,
        closedRevenueByBucket,
        cumulativeLabor,
        openBillsCents,
        completedBucketCount,
      ),
      baselineFractions,
      wageSeries,
      historicalWagePercentByBucket,
    },
  };
}
