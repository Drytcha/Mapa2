import { foldStopKey } from "./core/text";
import { hasLineLegend, legendCodeForTrip, legendText, lineLegend } from "./lineLegend";
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
  /** Oficjalny opis wariantu z legendy linii (bez litery). */
  legendText?: string;
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
const directionKey = foldStopKey;

const suffixLetter = (label: string) =>
  directionKey(label).match(/[a-z]/)?.[0] ?? "k";

const pickLabel = (labels: Map<string, number>) =>
  [...labels.entries()].sort(
    ([aLabel, aCount], [bLabel, bCount]) =>
      bCount - aCount || aLabel.localeCompare(bLabel, "pl"),
  )[0]?.[0] ?? "Nieznany kierunek";

/** Litera wariantu: z GTFS (pełna trasa) albo z kierunku, gdy trasa nieznana. */
const departureLegendCode = (departure: StopDepartureItem) => {
  if (typeof departure.legendCode === "string") return departure.legendCode;
  // Źródło bez pełnej trasy (np. rozkład awaryjny): rozpoznajemy tylko
  // warianty końcowe, żeby nie dopisywać liter „na wyczucie”.
  return legendCodeForTrip(departure.routeShort, {
    destination: departure.finalStop,
    headsign: departure.headsign,
  });
};

/**
 * Grupowanie odjazdów przystanku według linii i wariantów.
 *
 * Dla linii z oficjalną legendą litery pochodzą wyłącznie z tej legendy
 * (2b, 5*, 8s, 18q, …), a kurs bez litery jest kursem podstawowym. Dla
 * pozostałych linii zachowany jest dotychczasowy podział na kierunek główny
 * i odchylenia. Warianty liczymy z całego dnia, przed filtrowaniem godziny
 * i wybranej linii.
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
      const official = hasLineLegend(line);
      const legendOrder = lineLegend(line)?.map((entry) => entry.code) ?? [];
      const stats = new Map<
        string,
        { count: number; labels: Map<string, number>; code: string }
      >();
      for (const d of items) {
        const label = cleanLabel(
          d.finalStop || d.headsign || "Nieznany kierunek",
        );
        const code = official ? departureLegendCode(d) : "";
        // Linia z legendą grupuje kursy po literze wariantu; kursy podstawowe
        // mogą mieć kilka różnych kierunków, więc kluczem jest kierunek.
        const key = official
          ? code
            ? `wariant|${code}`
            : `podstawowy|${directionKey(label)}`
          : directionKey(label);
        const entry = stats.get(key) ?? { count: 0, labels: new Map(), code };
        entry.count += 1;
        entry.labels.set(label, (entry.labels.get(label) ?? 0) + 1);
        stats.set(key, entry);
      }

      const ranked = [...stats.entries()]
        .map(([key, entry]) => ({
          key,
          label: pickLabel(entry.labels),
          count: entry.count,
          code: entry.code,
        }))
        .sort(
          (a, b) => b.count - a.count || a.label.localeCompare(b.label, "pl"),
        );

      let directions: DepartureDirection[];
      if (official) {
        // Kurs podstawowy (bez litery) jest głównym kierunkiem; jeśli takiego
        // nie ma, wszystkie kursy mają litery z legendy.
        const base = ranked.filter((entry) => !entry.code);
        const variants = ranked.filter((entry) => entry.code);
        const mainKey = base.length
          ? base.reduce((best, entry) => (entry.count > best.count ? entry : best)).key
          : null;
        directions = [
          ...base.map((entry) => ({
            key: entry.key,
            label: entry.label,
            suffix: "",
            main: entry.key === mainKey,
            count: entry.count,
            legendText: undefined,
          })),
          ...variants
            .sort(
              (a, b) =>
                legendOrder.indexOf(a.code) - legendOrder.indexOf(b.code) ||
                a.code.localeCompare(b.code, "pl"),
            )
            .map((entry) => ({
              key: entry.key,
              label: entry.label,
              suffix: entry.code,
              main: false,
              count: entry.count,
              legendText: legendText(line, entry.code),
            })),
        ];
        // Główny kierunek na początku, potem pozostałe kursy podstawowe,
        // na końcu warianty w kolejności oficjalnej legendy.
        directions.sort((a, b) => {
          if (a.main !== b.main) return a.main ? -1 : 1;
          const aVariant = Boolean(a.suffix);
          const bVariant = Boolean(b.suffix);
          if (aVariant !== bVariant) return aVariant ? 1 : -1;
          return 0;
        });
      } else {
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
        directions = ranked.map(({ key, label, count }) => {
          if (key === mainKey) {
            return { key, label, suffix: "", main: true, count };
          }
          const letter = suffixLetter(label);
          let suffix = letter;
          let number = 2;
          while (used.has(suffix)) suffix = `${letter}${number++}`;
          used.add(suffix);
          return { key, label, suffix, main: false, count };
        });
        directions.sort((a, b) => {
          if (a.main !== b.main) return a.main ? -1 : 1;
          return a.label.localeCompare(b.label, "pl");
        });
      }

      const byKey = new Map(
        directions.map((direction) => [direction.key, direction]),
      );
      return {
        line,
        color: items[0].routeColor,
        textColor: items[0].routeTextColor,
        directions,
        departures: items.map((departure) => {
          const label = cleanLabel(
            departure.finalStop || departure.headsign || "Nieznany kierunek",
          );
          const code = official ? departureLegendCode(departure) : "";
          const key = official
            ? code
              ? `wariant|${code}`
              : `podstawowy|${directionKey(label)}`
            : directionKey(label);
          return { departure, direction: byKey.get(key)! };
        }),
      };
    });
}
