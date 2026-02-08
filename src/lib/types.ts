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
export type SampleDataPreset = "ponr_na" | "ponr_safe_all_shift" | "ponr_time_point";

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
  weeklyPointOfNoReturnWagePercent: number;
  refreshIntervalSeconds: number;
  excludedOpenOrderLabels: string[];
  dataSourceMode: DataSourceMode;
  sampleDataPreset: SampleDataPreset;
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

export interface WeeklySnapshot {
  weekStartIso: string;
  revenueToDateCents: number | null;
  wagesToDateCents: number | null;
}

export type PointOfNoReturnStatus =
  | "upcoming"
  | "passed"
  | "safe_all_shift"
  | "not_last_shift"
  | "unavailable";

export interface PointOfNoReturnSnapshot {
  targetWagePercent: number;
  status: PointOfNoReturnStatus;
  pointTimeIso: string | null;
  minutesFromNow: number | null;
  projectedWeekWagePercentAtNow: number | null;
  shiftStartIso: string | null;
  shiftEndIso: string | null;
}

export interface LiveSnapshot {
  generatedAtIso: string;
  dayKey: DayKey;
  weekly?: WeeklySnapshot;
  pointOfNoReturn?: PointOfNoReturnSnapshot;
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
