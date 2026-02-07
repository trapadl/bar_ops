import { AppConfig, ComparableNight, HistorySnapshot, LiveSnapshot, RevenueBucket } from "@/lib/types";
import { averageSeries, buildBaselineFractions, computeProjection, computeWageSeries, cumulative, getBaselineFractionAtIndex, toPercent } from "@/lib/math";
import { buildBucketLabels, getZonedNow, minutesInOperatingWindow, minutesSinceOpening } from "@/lib/time";
import { getOperatingHoursForDay } from "@/lib/config";

const BUCKET_MINUTES = 15;

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

function buildHistoryModel(config: AppConfig, now: Date): HistorySnapshot {
  const zonedNow = getZonedNow(now, config.timezone);
  const operatingHours = getOperatingHoursForDay(config, zonedNow.dayKey);
  const targets = config.dailyTargets[zonedNow.dayKey];

  if (operatingHours.isClosed) {
    return {
      dayKey: zonedNow.dayKey,
      lastWeekRevenueCents: 0,
      rollingAverageRevenueCents: 0,
      comparableNights: [],
    };
  }

  const labels = buildBucketLabels(
    operatingHours.openingTime,
    operatingHours.closingTime,
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
  const operatingHours = getOperatingHoursForDay(config, history.dayKey);

  if (operatingHours.isClosed) {
    return {
      generatedAtIso: now.toISOString(),
      dayKey: history.dayKey,
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
            targetPercent: targets.wageTargetPercent,
            historicalPercent: 0,
          },
        ],
        historicalWagePercentByBucket: [0],
      },
    };
  }

  const labels = buildBucketLabels(
    operatingHours.openingTime,
    operatingHours.closingTime,
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

  const zonedNow = getZonedNow(now, config.timezone);
  const operatingWindowMinutes = minutesInOperatingWindow(
    operatingHours.openingTime,
    operatingHours.closingTime,
  );
  const elapsedMinutes = minutesSinceOpening(
    zonedNow.hour,
    zonedNow.minute,
    operatingHours.openingTime,
    operatingHours.closingTime,
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
  const baselineFractionAtNow = getBaselineFractionAtIndex(
    baselineFractions,
    Math.max(0, completedBucketCount - 1),
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

  return {
    generatedAtIso: now.toISOString(),
    dayKey: history.dayKey,
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
