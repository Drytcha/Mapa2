import type { StopDepartureItem } from "./types";

export interface DepartureDirection {
  key: string;
  label: string;
  /** Litera tylko dla kierunku odchylenia; główny kierunek ma pusty sufiks. */
  suffix: string;
  /** Główny kierunek linii — najczęstszy, bez litery. */
  main: boolean;
  /** Liczba odjazdów w pełnym dniu (przed filtrowaniem czasu i linii). */
  count: number;
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

/** Główny kierunek musi być wyraźnie dominujący, nie tylko najczęstszy z remisu. */
const MIN_DOMINANT_DEPARTURES = 3;
const DOMINANT_SHARE = 0.5;

// Zachowujemy oryginalną pisownię (np. „Jedlina-Zdrój”); myślniki i spacje
// ujednolica tylko klucz porównawczy.
const cleanLabel = (name: string) => name.replace(/\s+/g, " ").trim();

/**
 * Klucz porównuje kierunki odpornie na pisownię (wielkość liter, polskie
 * znaki, myślniki, dopiski „na żądanie” i warianty spacji), ale nie scala
 * różnych miejscowości.
 */
const directionKey = (name: string) =>
  name
    .toLocaleLowerCase("pl")
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(?:nz|n z|na zadanie|na żądanie)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const suffixLetter = (label: string) =>
  directionKey(label).match(/[a-z]/)?.[0] ?? "k";

const pickLabel = (labels: Map<string, number>) =>
  [...labels.entries()].sort(
    ([aLabel, aCount], [bLabel, bCount]) =>
      bCount - aCount || aLabel.localeCompare(bLabel, "pl"),
  )[0]?.[0] ?? "Nieznany kierunek";

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
      const stats = new Map<
        string,
        { count: number; labels: Map<string, number> }
      >();
      for (const d of items) {
        const label = cleanLabel(
          d.finalStop || d.headsign || "Nieznany kierunek",
        );
        const key = directionKey(label);
        const entry = stats.get(key) ?? { count: 0, labels: new Map() };
        entry.count += 1;
        entry.labels.set(label, (entry.labels.get(label) ?? 0) + 1);
        stats.set(key, entry);
      }

      const ranked = [...stats.entries()]
        .map(([key, entry]) => ({
          key,
          label: pickLabel(entry.labels),
          count: entry.count,
        }))
        .sort(
          (a, b) => b.count - a.count || a.label.localeCompare(b.label, "pl"),
        );

      // Jeden kierunek to cały rozkład. Przy wielu kierunkach literę dostają
      // tylko odchylenia; stały, dominujący kierunek zostaje bez litery.
      const hasDominant =
        ranked.length > 1 &&
        ranked[0].count >= MIN_DOMINANT_DEPARTURES &&
        ranked[0].count / items.length >= DOMINANT_SHARE &&
        ranked[0].count > ranked[1].count;
      const mainKey = hasDominant
        ? ranked[0].key
        : ranked.length === 1
          ? ranked[0].key
          : null;

      const used = new Set<string>();
      const directions: DepartureDirection[] = ranked.map(
        ({ key, label, count }) => {
          if (key === mainKey) {
            return { key, label, suffix: "", main: true, count };
          }
          const letter = suffixLetter(label);
          let suffix = letter;
          let number = 2;
          while (used.has(suffix)) suffix = `${letter}${number++}`;
          used.add(suffix);
          return { key, label, suffix, main: false, count };
        },
      );
      directions.sort((a, b) => {
        if (a.main !== b.main) return a.main ? -1 : 1;
        return a.label.localeCompare(b.label, "pl");
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
              cleanLabel(
                departure.finalStop ||
                  departure.headsign ||
                  "Nieznany kierunek",
              ),
            ),
          )!,
        })),
      };
    });
}
