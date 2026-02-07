export type DayKey =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface DailyTarget {
  revenueTargetCents: number;
  wageTargetPercent: number;
}

export interface OperatingHours {
  openingTime: string;
  closingTime: string;
  isClosed: boolean;
}

export type DataSourceMode = "sample" | "realtime";

export type SquareEnvironment = "production" | "sandbox";

export interface SquareAccessConfig {
  environment: SquareEnvironment;
  accessToken: string;
  locationId: string;
}

export interface DeputyAccessConfig {
  accessToken: string;
  baseUrl: string;
}

export interface AppConfig {
  storeName: string;
  timezone: string;
  openingTime: string;
  closingTime: string;
  dailyOperatingHours: Record<DayKey, OperatingHours>;
  averageBillLengthMinutes: number;
  averageHourlyRate: number;
  refreshIntervalSeconds: number;
  dataSourceMode: DataSourceMode;
  square: SquareAccessConfig;
  deputy: DeputyAccessConfig;
  dailyTargets: Record<DayKey, DailyTarget>;
}

export interface RevenueBucket {
  bucketIndex: number;
  label: string;
  closedRevenueCents: number;
  openBillsCents: number;
  laborCostCents: number;
}

export interface ProjectionMetrics {
  baselineFraction: number;
  rawProjectedTotalCents: number;
  rampedProjectedTotalCents: number;
  rampWeight: number;
  elapsedFraction: number;
}

export interface WagePoint {
  label: string;
  currentPercent: number | null;
  targetPercent: number;
  historicalPercent: number;
}

export interface ComparableNight {
  totalRevenueCents: number;
  bucketRevenueCents: number[];
  cumulativeFractions: number[];
  wagePercentByBucket: number[];
}

export interface HistorySnapshot {
  dayKey: DayKey;
  lastWeekRevenueCents: number;
  rollingAverageRevenueCents: number;
  comparableNights: ComparableNight[];
}

export interface LiveSnapshot {
  generatedAtIso: string;
  dayKey: DayKey;
  totals: {
    actualRevenueCents: number;
    openBillsCents: number;
    adjustedRevenueCents: number;
    projectedRevenueCents: number;
    projectedVsTargetPercent: number;
    laborCostCents: number;
    wagePercent: number | null;
  };
  comparison: {
    lastWeekRevenueCents: number;
    rollingAverageRevenueCents: number;
  };
  projection: ProjectionMetrics;
  timeline: {
    revenueBuckets: RevenueBucket[];
    baselineFractions: number[];
    wageSeries: WagePoint[];
    historicalWagePercentByBucket: number[];
  };
}
