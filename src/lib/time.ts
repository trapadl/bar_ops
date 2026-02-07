import { getDayKeyFromWeekdayLabel } from "@/lib/config";
import { DayKey } from "@/lib/types";

const MINUTES_PER_DAY = 24 * 60;

export function parseClockToMinutes(clock: string): number {
  const [hours, minutes] = clock.split(":").map((part) => Number(part));

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return 0;
  }

  const safeHours = Math.min(Math.max(hours, 0), 23);
  const safeMinutes = Math.min(Math.max(minutes, 0), 59);
  return safeHours * 60 + safeMinutes;
}

export function minutesInOperatingWindow(openingTime: string, closingTime: string): number {
  const openingMinutes = parseClockToMinutes(openingTime);
  const closingMinutes = parseClockToMinutes(closingTime);
  let difference = closingMinutes - openingMinutes;

  if (difference <= 0) {
    difference += MINUTES_PER_DAY;
  }

  return difference;
}

export function minutesSinceOpening(
  hour: number,
  minute: number,
  openingTime: string,
  closingTime: string,
): number {
  const nowMinutes = hour * 60 + minute;
  const openingMinutes = parseClockToMinutes(openingTime);
  const closingMinutes = parseClockToMinutes(closingTime);
  const crossesMidnight = closingMinutes <= openingMinutes;
  const windowMinutes = minutesInOperatingWindow(openingTime, closingTime);

  if (!crossesMidnight) {
    if (nowMinutes <= openingMinutes) {
      return 0;
    }
    if (nowMinutes >= closingMinutes) {
      return windowMinutes;
    }
    return nowMinutes - openingMinutes;
  }

  if (nowMinutes >= openingMinutes) {
    return nowMinutes - openingMinutes;
  }

  if (nowMinutes < closingMinutes) {
    return MINUTES_PER_DAY - openingMinutes + nowMinutes;
  }

  return 0;
}

function formatClock(totalMinutes: number): string {
  const wrapped = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}`;
}

export function buildBucketLabels(
  openingTime: string,
  closingTime: string,
  bucketSizeMinutes = 15,
): string[] {
  const operatingMinutes = minutesInOperatingWindow(openingTime, closingTime);
  const bucketCount = Math.max(1, Math.ceil(operatingMinutes / bucketSizeMinutes));
  const openingMinutes = parseClockToMinutes(openingTime);

  return Array.from({ length: bucketCount }, (_, index) =>
    formatClock(openingMinutes + index * bucketSizeMinutes),
  );
}

export interface ZonedNow {
  dayKey: DayKey;
  hour: number;
  minute: number;
}

export function getZonedNow(date: Date, timeZone: string): ZonedNow {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sunday";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");

  return {
    dayKey: getDayKeyFromWeekdayLabel(weekday),
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
  };
}
