import {
  AppConfig,
  DailyTarget,
  DayKey,
  OperatingHours,
  SquareAccessConfig,
  DeputyAccessConfig,
} from "@/lib/types";

export const DAY_KEYS: DayKey[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export const DAY_LABELS: Record<DayKey, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

export const LOCAL_STORAGE_CONFIG_KEY = "barops_live_config_v1";

const DEFAULT_DAILY_TARGETS: Record<DayKey, DailyTarget> = {
  monday: { revenueTargetCents: 120000, wageTargetPercent: 28 },
  tuesday: { revenueTargetCents: 125000, wageTargetPercent: 28 },
  wednesday: { revenueTargetCents: 135000, wageTargetPercent: 27 },
  thursday: { revenueTargetCents: 160000, wageTargetPercent: 26 },
  friday: { revenueTargetCents: 235000, wageTargetPercent: 24 },
  saturday: { revenueTargetCents: 255000, wageTargetPercent: 24 },
  sunday: { revenueTargetCents: 170000, wageTargetPercent: 26 },
};

const DEFAULT_DAILY_OPERATING_HOURS: Record<DayKey, OperatingHours> = {
  monday: { openingTime: "16:00", closingTime: "01:00", isClosed: false },
  tuesday: { openingTime: "16:00", closingTime: "01:00", isClosed: false },
  wednesday: { openingTime: "16:00", closingTime: "01:00", isClosed: false },
  thursday: { openingTime: "16:00", closingTime: "02:00", isClosed: false },
  friday: { openingTime: "15:00", closingTime: "03:00", isClosed: false },
  saturday: { openingTime: "15:00", closingTime: "03:00", isClosed: false },
  sunday: { openingTime: "15:00", closingTime: "00:00", isClosed: false },
};

const DEFAULT_SQUARE_CONFIG: SquareAccessConfig = {
  environment: "production",
  accessToken: "",
  locationId: "",
};

const DEFAULT_DEPUTY_CONFIG: DeputyAccessConfig = {
  accessToken: "",
  baseUrl: "",
};

export const DEFAULT_CONFIG: AppConfig = {
  storeName: "BarOps Adelaide",
  timezone: "Australia/Adelaide",
  openingTime: "16:00",
  closingTime: "02:00",
  dailyOperatingHours: cloneOperatingHours(DEFAULT_DAILY_OPERATING_HOURS),
  averageBillLengthMinutes: 55,
  averageHourlyRate: 32,
  refreshIntervalSeconds: 60,
  dataSourceMode: "sample",
  square: { ...DEFAULT_SQUARE_CONFIG },
  deputy: { ...DEFAULT_DEPUTY_CONFIG },
  dailyTargets: cloneTargets(DEFAULT_DAILY_TARGETS),
};

function cloneTargets(
  targets: Record<DayKey, DailyTarget>,
): Record<DayKey, DailyTarget> {
  return {
    monday: { ...targets.monday },
    tuesday: { ...targets.tuesday },
    wednesday: { ...targets.wednesday },
    thursday: { ...targets.thursday },
    friday: { ...targets.friday },
    saturday: { ...targets.saturday },
    sunday: { ...targets.sunday },
  };
}

function cloneOperatingHours(
  operatingHours: Record<DayKey, OperatingHours>,
): Record<DayKey, OperatingHours> {
  return {
    monday: { ...operatingHours.monday },
    tuesday: { ...operatingHours.tuesday },
    wednesday: { ...operatingHours.wednesday },
    thursday: { ...operatingHours.thursday },
    friday: { ...operatingHours.friday },
    saturday: { ...operatingHours.saturday },
    sunday: { ...operatingHours.sunday },
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sanitizeClock(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return fallback;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return fallback;
  }

  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}`;
}

function sanitizeTarget(target: unknown, fallback: DailyTarget): DailyTarget {
  const source = target as Partial<DailyTarget> | undefined;

  return {
    revenueTargetCents: Math.round(
      clampNumber(
        Number(source?.revenueTargetCents ?? fallback.revenueTargetCents),
        0,
        5000000,
      ),
    ),
    wageTargetPercent: clampNumber(
      Number(source?.wageTargetPercent ?? fallback.wageTargetPercent),
      0,
      100,
    ),
  };
}

function sanitizeOperatingHours(
  hours: unknown,
  fallback: OperatingHours,
): OperatingHours {
  const source = hours as Partial<OperatingHours> | undefined;
  return {
    openingTime: sanitizeClock(source?.openingTime, fallback.openingTime),
    closingTime: sanitizeClock(source?.closingTime, fallback.closingTime),
    isClosed:
      typeof source?.isClosed === "boolean" ? source.isClosed : fallback.isClosed,
  };
}

function sanitizeDataSourceMode(value: unknown): AppConfig["dataSourceMode"] {
  return value === "realtime" ? "realtime" : "sample";
}

function sanitizeSquareConfig(value: unknown): SquareAccessConfig {
  const source = value as Partial<SquareAccessConfig> | undefined;
  const environment =
    source?.environment === "sandbox" ? "sandbox" : DEFAULT_SQUARE_CONFIG.environment;

  return {
    environment,
    accessToken:
      typeof source?.accessToken === "string" ? source.accessToken.trim() : "",
    locationId:
      typeof source?.locationId === "string" ? source.locationId.trim() : "",
  };
}

function sanitizeDeputyBaseUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.origin;
  } catch {
    return "";
  }
}

function sanitizeDeputyConfig(value: unknown): DeputyAccessConfig {
  const source = value as Partial<DeputyAccessConfig> | undefined;
  return {
    accessToken:
      typeof source?.accessToken === "string" ? source.accessToken.trim() : "",
    baseUrl: sanitizeDeputyBaseUrl(source?.baseUrl),
  };
}

export function getOperatingHoursForDay(
  config: AppConfig,
  dayKey: DayKey,
): OperatingHours {
  const fallback = {
    openingTime: config.openingTime,
    closingTime: config.closingTime,
    isClosed: false,
  };
  return sanitizeOperatingHours(config.dailyOperatingHours[dayKey], fallback);
}

export function sanitizeConfig(input: Partial<AppConfig> | null | undefined): AppConfig {
  const source = input ?? {};

  const legacyOpeningTime = sanitizeClock(
    source.openingTime,
    DEFAULT_CONFIG.openingTime,
  );
  const legacyClosingTime = sanitizeClock(
    source.closingTime,
    DEFAULT_CONFIG.closingTime,
  );

  const dayTargets = source.dailyTargets as
    | Partial<Record<DayKey, DailyTarget>>
    | undefined;
  const sourceOperatingHours = source.dailyOperatingHours as
    | Partial<Record<DayKey, OperatingHours>>
    | undefined;

  const legacyFallbackHours: OperatingHours = {
    openingTime: legacyOpeningTime,
    closingTime: legacyClosingTime,
    isClosed: false,
  };

  return {
    storeName:
      typeof source.storeName === "string" && source.storeName.trim().length > 0
        ? source.storeName.trim()
        : DEFAULT_CONFIG.storeName,
    timezone:
      typeof source.timezone === "string" && source.timezone.trim().length > 0
        ? source.timezone.trim()
        : DEFAULT_CONFIG.timezone,
    openingTime: legacyOpeningTime,
    closingTime: legacyClosingTime,
    dailyOperatingHours: {
      monday: sanitizeOperatingHours(
        sourceOperatingHours?.monday,
        sourceOperatingHours ? legacyFallbackHours : DEFAULT_DAILY_OPERATING_HOURS.monday,
      ),
      tuesday: sanitizeOperatingHours(
        sourceOperatingHours?.tuesday,
        sourceOperatingHours ? legacyFallbackHours : DEFAULT_DAILY_OPERATING_HOURS.tuesday,
      ),
      wednesday: sanitizeOperatingHours(
        sourceOperatingHours?.wednesday,
        sourceOperatingHours ? legacyFallbackHours : DEFAULT_DAILY_OPERATING_HOURS.wednesday,
      ),
      thursday: sanitizeOperatingHours(
        sourceOperatingHours?.thursday,
        sourceOperatingHours ? legacyFallbackHours : DEFAULT_DAILY_OPERATING_HOURS.thursday,
      ),
      friday: sanitizeOperatingHours(
        sourceOperatingHours?.friday,
        sourceOperatingHours ? legacyFallbackHours : DEFAULT_DAILY_OPERATING_HOURS.friday,
      ),
      saturday: sanitizeOperatingHours(
        sourceOperatingHours?.saturday,
        sourceOperatingHours ? legacyFallbackHours : DEFAULT_DAILY_OPERATING_HOURS.saturday,
      ),
      sunday: sanitizeOperatingHours(
        sourceOperatingHours?.sunday,
        sourceOperatingHours ? legacyFallbackHours : DEFAULT_DAILY_OPERATING_HOURS.sunday,
      ),
    },
    averageBillLengthMinutes: Math.round(
      clampNumber(
        Number(source.averageBillLengthMinutes ?? DEFAULT_CONFIG.averageBillLengthMinutes),
        1,
        240,
      ),
    ),
    averageHourlyRate: clampNumber(
      Number(source.averageHourlyRate ?? DEFAULT_CONFIG.averageHourlyRate),
      5,
      200,
    ),
    refreshIntervalSeconds: Math.round(
      clampNumber(
        Number(source.refreshIntervalSeconds ?? DEFAULT_CONFIG.refreshIntervalSeconds),
        15,
        900,
      ),
    ),
    dataSourceMode: sanitizeDataSourceMode(source.dataSourceMode),
    square: sanitizeSquareConfig(source.square),
    deputy: sanitizeDeputyConfig(source.deputy),
    dailyTargets: {
      monday: sanitizeTarget(dayTargets?.monday, DEFAULT_DAILY_TARGETS.monday),
      tuesday: sanitizeTarget(dayTargets?.tuesday, DEFAULT_DAILY_TARGETS.tuesday),
      wednesday: sanitizeTarget(dayTargets?.wednesday, DEFAULT_DAILY_TARGETS.wednesday),
      thursday: sanitizeTarget(dayTargets?.thursday, DEFAULT_DAILY_TARGETS.thursday),
      friday: sanitizeTarget(dayTargets?.friday, DEFAULT_DAILY_TARGETS.friday),
      saturday: sanitizeTarget(dayTargets?.saturday, DEFAULT_DAILY_TARGETS.saturday),
      sunday: sanitizeTarget(dayTargets?.sunday, DEFAULT_DAILY_TARGETS.sunday),
    },
  };
}

export function loadConfigFromStorage(): AppConfig {
  if (typeof window === "undefined") {
    return sanitizeConfig(DEFAULT_CONFIG);
  }

  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_CONFIG_KEY);
    if (!raw) {
      return sanitizeConfig(DEFAULT_CONFIG);
    }

    return sanitizeConfig(JSON.parse(raw) as Partial<AppConfig>);
  } catch {
    return sanitizeConfig(DEFAULT_CONFIG);
  }
}

export function saveConfigToStorage(config: AppConfig): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    LOCAL_STORAGE_CONFIG_KEY,
    JSON.stringify(sanitizeConfig(config)),
  );
}

export function getDayKeyFromWeekdayLabel(weekday: string): DayKey {
  switch (weekday.toLowerCase()) {
    case "monday":
      return "monday";
    case "tuesday":
      return "tuesday";
    case "wednesday":
      return "wednesday";
    case "thursday":
      return "thursday";
    case "friday":
      return "friday";
    case "saturday":
      return "saturday";
    default:
      return "sunday";
  }
}

export function getAppSlug(): string {
  const candidate = (process.env.NEXT_PUBLIC_APP_SLUG ?? "barops-live-5h2q")
    .trim()
    .toLowerCase();

  const slug = candidate.replace(/[^a-z0-9-]/g, "").replace(/--+/g, "-");
  return slug.length > 0 ? slug : "barops-live-5h2q";
}

export function cloneConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    dailyOperatingHours: cloneOperatingHours(config.dailyOperatingHours),
    square: { ...config.square },
    deputy: { ...config.deputy },
    dailyTargets: cloneTargets(config.dailyTargets),
  };
}
