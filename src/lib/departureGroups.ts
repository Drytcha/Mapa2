import type { StopDepartureItem } from "./types";

export interface DepartureDirection {
  key: string;
  label: string;
  suffix: string;
}

export interface DepartureLineGroup {
  line: string;
  color: string;
  textColor: string;
  directions: DepartureDirection[];
  departures: Array<{
    departure: StopDepartureItem;
    direction: DepartureDirection;
  }>;
}

const directionKey = (name: string) =>
  name.trim().replace(/\s+/g, " ").toLocaleLowerCase("pl");
const suffixLetter = (label: string) =>
  label
    .toLocaleLowerCase("pl")
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[a-z]/)?.[0] ?? "k";

/** Codes come from the whole day's destinations, before time/line filtering. */
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
      const names = new Map<string, string>();
      for (const d of items) {
        const name = (d.finalStop || d.headsign || "Nieznany kierunek")
          .trim()
          .replace(/\s+/g, " ");
        names.set(directionKey(name), name);
      }
      const used = new Set<string>();
      const directions = [...names.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "pl"))
        .map(([key, label]) => {
          const letter = suffixLetter(label);
          let suffix = names.size > 1 ? letter : "";
          let number = 2;
          while (used.has(suffix)) suffix = `${letter}${number++}`;
          used.add(suffix);
          return { key, label, suffix };
        });
      const byKey = new Map(
        directions.map((direction) => [direction.key, direction]),
      );
      return {
        line,
        color: items[0].routeColor,
        textColor: items[0].routeTextColor,
        directions,
        departures: items.map((departure) => ({
          departure,
          direction: byKey.get(
            directionKey(
              departure.finalStop || departure.headsign || "Nieznany kierunek",
            ),
          )!,
        })),
      };
    });
}
