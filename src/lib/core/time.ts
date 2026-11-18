/**
 * Shared Europe/Warsaw clock formatting and safe browser localStorage helpers.
 * Uses cached Intl.DateTimeFormat instances instead of allocating DateTime objects
 * inside hot timetable / UI loops.
 */

export const WARSAW_ZONE = "Europe/Warsaw";

const warsawClockFormatter = new Intl.DateTimeFormat("pl-PL", {
  timeZone: WARSAW_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const warsawDayLabelFormatter = new Intl.DateTimeFormat("pl-PL", {
  timeZone: WARSAW_ZONE,
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
});

/** Formats epoch milliseconds as `HH:mm` in `Europe/Warsaw`, or `"—"` if invalid. */
export function formatWarsawClock(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
  return warsawClockFormatter.format(ms);
}

/** Formats epoch milliseconds as Polish short weekday + `dd.MM` in `Europe/Warsaw`. */
export function formatWarsawShortDate(ms: number): string {
  return warsawDayLabelFormatter.format(ms);
}

/** Formats integer minutes from midnight (including >= 1440 after-midnight GTFS times) as `HH:mm`. */
export function minutesToClock(totalMinutes: number): string {
  const wrapped = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, "0");
  const mm = String(wrapped % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function readStorageText(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorageText(key: string, value: string): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function readStorageJson<T = unknown>(key: string): T | null {
  const raw = readStorageText(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeStorageJson(key: string, value: unknown): boolean {
  try {
    return writeStorageText(key, JSON.stringify(value));
  } catch {
    return false;
  }
}
