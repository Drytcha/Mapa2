import type { StopDepartureItem } from "./types";

export interface DepartureDirection {
  key: string;
  label: string;
  /** Empty for the line's main direction; a letter for deviations (e.g. "g"). */
  suffix: string;
  /** True for the dominant direction of the day — shown without a letter. */
  main: boolean;
  count: number;
}

export interface DepartureLineGroup {
  line: string;
  color: string;
  textColor: string;
  /** Main direction first, then deviations alphabetically. */
  directions: DepartureDirection[];
  departures: Array<{
    departure: StopDepartureItem;
    direction: DepartureDirection;
  }>;
}

const UNKNOWN = "Nieznany kierunek";

const directionName = (d: StopDepartureItem) =>
  (d.finalStop || d.headsign || UNKNOWN).trim().replace(/\s+/g, " ");
const directionKey = (name: string) => name.toLocaleLowerCase("pl");
const suffixLetter = (label: string) =>
  label
    .toLocaleLowerCase("pl")
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[a-z]/)?.[0] ?? "k";

/**
 * Groups a whole day's departures by line. The most frequent destination of a
 * line (e.g. "Bystrzycka końcowy") is the main direction and gets no letter;
 * only deviations (Głuszyca, Jedlina…) are marked, e.g. "11:25g". When no
 * destination clearly dominates (a tie), every direction gets a letter so the
 * timetable stays unambiguous. Codes are computed before any time/line filter,
 * so they don't change when switching to "Od teraz".
 */
export function groupDeparturesByLine(
  departures: StopDepartureItem[],
): DepartureLineGroup[] {
  const byLine = new Map<string, StopDepartureItem[]>();
  const seen = new Set<string>();
  for (const departure of departures) {
    const key = `${departure.tripId}|${departure.atMs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const items = byLine.get(departure.routeShort) ?? [];
    items.push(departure);
    byLine.set(departure.routeShort, items);
  }

  return [...byLine.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "pl", { numeric: true }))
    .map(([line, items]) => {
      items.sort((a, b) => a.atMs - b.atMs || a.tripId.localeCompare(b.tripId));

      const stats = new Map<string, { label: string; count: number }>();
      for (const d of items) {
        const label = directionName(d);
        const key = directionKey(label);
        const entry = stats.get(key);
        if (entry) entry.count += 1;
        else stats.set(key, { label, count: 1 });
      }

      const ranked = [...stats.entries()].sort(
        ([ka, a], [kb, b]) => b.count - a.count || ka.localeCompare(kb, "pl"),
      );
      // A main direction only exists when it is strictly the most frequent.
      const mainKey =
        ranked.length === 1 || (ranked.length > 1 && ranked[0][1].count > ranked[1][1].count)
          ? ranked[0][0]
          : null;

      const used = new Set<string>();
      const deviations = ranked
        .filter(([key]) => key !== mainKey)
        .sort(([a], [b]) => a.localeCompare(b, "pl"))
        .map(([key, { label, count }]): DepartureDirection => {
          const letter = suffixLetter(label);
          let suffix = letter;
          let number = 2;
          while (used.has(suffix)) suffix = `${letter}${number++}`;
          used.add(suffix);
          return { key, label, suffix, main: false, count };
        });

      const directions: DepartureDirection[] = mainKey
        ? [
            { key: mainKey, label: stats.get(mainKey)!.label, suffix: "", main: true, count: stats.get(mainKey)!.count },
            ...deviations,
          ]
        : deviations;

      const byKey = new Map(directions.map((direction) => [direction.key, direction]));
      return {
        line,
        color: items[0].routeColor,
        textColor: items[0].routeTextColor,
        directions,
        departures: items.map((departure) => ({
          departure,
          direction: byKey.get(directionKey(directionName(departure)))!,
        })),
      };
    });
}
