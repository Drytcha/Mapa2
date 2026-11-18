/**
 * Unified Polish text folding, stop-key normalization, duty-code parsing,
 * technical route classification, and HTML escaping.
 */

const MAX_MEMO_ENTRIES = 2_000;
const foldCache = new Map<string, string>();
const stopKeyCache = new Map<string, string>();

function memoSet(map: Map<string, string>, key: string, value: string): string {
  if (map.size >= MAX_MEMO_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
  return value;
}

/**
 * Case-insensitive Polish diacritic folding (`ł` -> `l`, strips NFD accents).
 * Bounded LRU cache prevents repeated Unicode NFD passes when filtering stops/places.
 */
export function foldPolish(value: string): string {
  if (!value) return "";
  const hit = foldCache.get(value);
  if (hit !== undefined) return hit;
  const folded = value
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return memoSet(foldCache, value, folded);
}

/**
 * Canonical comparison key for bus stop names and headsigns:
 * strips Polish diacritics, "na żądanie" / "n/z" / "nz" suffixes, and punctuation.
 */
export function foldStopKey(value: string): string {
  if (!value) return "";
  const hit = stopKeyCache.get(value);
  if (hit !== undefined) return hit;
  const key = foldPolish(value)
    .replace(/\(?\bna zadanie\b\)?|\bn\/z\b|\bn\s+z\b|\bnz\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return memoSet(stopKeyCache, value, key);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
};

export function escapeHtml(value: string): string {
  if (!value) return "";
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/** Parses a duty identifier such as "2/03", "2-3", "A:1" into `{ line, suffix }`. */
export function parseDutyPair(
  value: string
): { line: string; suffix: string } | null {
  const clean = value.trim().toUpperCase().replace(/\s+/g, "");
  const match = clean.match(/^([A-Z0-9]+)[/:\\-](\d{1,3})$/);
  if (!match) return null;
  return {
    line: match[1],
    suffix: match[2].padStart(2, "0"),
  };
}

/** Formats a duty code consistently as `LINE/01` or `LINE-01`. */
export function formatDutyCode(
  value: string,
  separator: "/" | "-" = "/"
): string {
  const clean = value.trim().toUpperCase().replace(/\s+/g, "");
  const parsed = parseDutyPair(clean);
  if (parsed) return `${parsed.line}${separator}${parsed.suffix}`;
  return separator === "-" ? clean.replace(/\//g, "-") : clean;
}

/**
 * Returns true when `dutyCode` represents the same line as `routeShort`
 * (e.g. `routeShort = "2"` and `dutyCode = "2/01"`, `"2-01"`, or `"2"`).
 * Used to prevent duplicated labels like `2 | 2/01` or `2 | 2`.
 */
export function isSameDutyLine(
  routeShort: string | null | undefined,
  dutyCode: string | null | undefined
): boolean {
  const cleanRoute = (routeShort ?? "").trim().toUpperCase();
  const cleanDuty = (dutyCode ?? "").trim().toUpperCase();
  if (!cleanRoute || !cleanDuty) return false;
  if (cleanRoute === cleanDuty) return true;
  const parsed = parseDutyPair(cleanDuty);
  return parsed ? parsed.line === cleanRoute : false;
}

/** Canonical sort comparator for Wałbrzych transit line codes (numeric first, then A, C, EX, S1..S4). */
export function compareLineCodes(a: string, b: string): number {
  const ca = a.trim().toUpperCase();
  const cb = b.trim().toUpperCase();
  const na = /^\d+$/.test(ca);
  const nb = /^\d+$/.test(cb);
  if (na && nb) return Number(ca) - Number(cb);
  if (na) return -1;
  if (nb) return 1;
  return ca.localeCompare(cb, "pl", { numeric: true });
}

/** Deduplicates, trims, uppercases and sorts an iterable of transit line codes. */
export function dedupeLines(lines: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const raw of lines) {
    const clean = raw.trim().toUpperCase();
    if (clean) seen.add(clean);
  }
  return [...seen].sort(compareLineCodes);
}

/** Non-revenue / technical runs shared across brigade metrics and GPS verification. */
export const TECHNICAL_ROUTE_CODES: ReadonlySet<string> = new Set([
  "PRZ",
  "WY",
  "ZJ",
  "WYJAZD",
  "ZJAZD",
  "DOJAZD",
  "TECH",
  "TECHN",
  "SERWIS",
  "TEST",
]);

/** Depot pull-out / pull-in runs. */
export const DEPOT_ROUTE_CODES: ReadonlySet<string> = new Set([
  "WY",
  "ZJ",
  "WYJAZD",
  "ZJAZD",
  "DOJAZD",
]);

export function isTechnicalRoute(line: string): boolean {
  return TECHNICAL_ROUTE_CODES.has(line.trim().toUpperCase());
}

/**
 * Special "S" lines (S1, S2, ...) are planner-only. Regular travellers never see
 * them in schedules, brigades, journey planning or stop line badges.
 */
export function isPlannerOnlyLine(line: string | null | undefined): boolean {
  return /^S\d+$/.test((line ?? "").trim().toUpperCase());
}

/** Removes planner-only lines from any code list; a no-op for planners. */
export function filterLinesForRole(lines: Iterable<string>, isPlanner: boolean): string[] {
  const list = [...lines];
  return isPlanner ? list : list.filter((line) => !isPlannerOnlyLine(line));
}

export function isDepotRoute(line: string): boolean {
  return DEPOT_ROUTE_CODES.has(line.trim().toUpperCase());
}
