import { ProjectionMetrics, WagePoint } from "@/lib/types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function cumulative(values: number[]): number[] {
  let runningTotal = 0;
  return values.map((value) => {
    runningTotal += value;
    return runningTotal;
  });
}

export function buildBaselineFractions(comparableBucketSeries: number[][]): number[] {
  const maxBuckets = comparableBucketSeries.reduce(
    (max, series) => Math.max(max, series.length),
    0,
  );

  if (maxBuckets === 0) {
    return [0.02];
  }

  const perNightFractions = comparableBucketSeries.map((series) => {
    const total = series.reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
      return Array.from({ length: maxBuckets }, () => 0);
    }

    const cumulativeValues = cumulative(series);
    return Array.from({ length: maxBuckets }, (_, index) => {
      const safeIndex = Math.min(index, cumulativeValues.length - 1);
      return clamp(cumulativeValues[safeIndex] / total, 0, 1);
    });
  });

  return Array.from({ length: maxBuckets }, (_, index) => {
    const average =
      perNightFractions.reduce((sum, fractions) => sum + fractions[index], 0) /
      perNightFractions.length;
    return clamp(average, 0, 1);
  });
}

export function getBaselineFractionAtIndex(
  baselineFractions: number[],
  bucketIndex: number,
): number {
  if (baselineFractions.length === 0) {
    return 0.02;
  }

  const safeIndex = clamp(bucketIndex, 0, baselineFractions.length - 1);
  return clamp(baselineFractions[safeIndex], 0, 1);
}

export function getInterpolatedBaselineFractionAtElapsedMinutes(
  baselineFractions: number[],
  elapsedMinutes: number,
  bucketMinutes: number,
): number {
  if (baselineFractions.length === 0) {
    return 0.02;
  }

  if (!Number.isFinite(elapsedMinutes) || elapsedMinutes <= 0) {
    return clamp(baselineFractions[0] ?? 0, 0, 1);
  }

  if (!Number.isFinite(bucketMinutes) || bucketMinutes <= 0) {
    return getBaselineFractionAtIndex(baselineFractions, 0);
  }

  const maxIndex = baselineFractions.length - 1;
  const bucketFloat = clamp(elapsedMinutes / bucketMinutes, 0, maxIndex);
  const lowerIndex = Math.floor(bucketFloat);
  const upperIndex = Math.min(maxIndex, lowerIndex + 1);
  const alpha = bucketFloat - lowerIndex;
  const lower = getBaselineFractionAtIndex(baselineFractions, lowerIndex);
  const upper = getBaselineFractionAtIndex(baselineFractions, upperIndex);

  return clamp(lower + (upper - lower) * alpha, 0, 1);
}

export function computeProjection(
  currentRevenueCents: number,
  baselineFractionAtNow: number,
  rollingAverageRevenueCents: number,
  elapsedFraction: number,
): ProjectionMetrics {
  const stableBaseline = clamp(baselineFractionAtNow, 0, 1);
  const guardedBaseline = stableBaseline < 0.03 ? 0.03 : stableBaseline;

  const rawProjectedTotalCents =
    stableBaseline > 0
      ? Math.round(currentRevenueCents / guardedBaseline)
      : rollingAverageRevenueCents;

  const rampProgress = clamp(guardedBaseline, 0, 1);
  const rampWeight = clamp(rampProgress * 1.65, 0.1, 1);
  const rampedProjectedTotalCents = Math.round(
    rawProjectedTotalCents * rampWeight +
      rollingAverageRevenueCents * (1 - rampWeight),
  );

  return {
    baselineFraction: stableBaseline,
    rawProjectedTotalCents,
    rampedProjectedTotalCents,
    rampWeight,
    elapsedFraction: clamp(elapsedFraction, 0, 1),
  };
}

export function toPercent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) {
    return null;
  }

  return (numerator / denominator) * 100;
}

export function averageSeries(series: number[][]): number[] {
  const maxBuckets = series.reduce((max, current) => Math.max(max, current.length), 0);
  if (maxBuckets === 0) {
    return [];
  }

  return Array.from({ length: maxBuckets }, (_, index) => {
    let sum = 0;
    let count = 0;

    for (const row of series) {
      if (index < row.length) {
        sum += row[index];
        count += 1;
      }
    }

    if (count === 0) {
      return 0;
    }

    return sum / count;
  });
}

export function computeWageSeries(
  labels: string[],
  cumulativeRevenueCents: number[],
  cumulativeLaborCents: number[],
  targetWagePercent: number,
  historicalWagePercentByBucket: number[],
): WagePoint[] {
  return labels.map((label, index) => {
    const revenue = cumulativeRevenueCents[index] ?? 0;
    const labor = cumulativeLaborCents[index] ?? 0;
    const currentPercent = toPercent(labor, revenue);

    return {
      label,
      currentPercent,
      targetPercent: targetWagePercent,
      historicalPercent: historicalWagePercentByBucket[index] ?? targetWagePercent,
    };
  });
}
