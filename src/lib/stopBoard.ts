import { delayTone, DELAY_STYLES, type DelayStyle, type DelayTone } from "./delay";
import type { DepartureLineGroup } from "./departureGroups";

/**
 * Tablica „Najbliższe odjazdy” — wzorowana na ekranie przystanku z myBus 3.0:
 * jedna płaska lista najbliższych kursów wszystkich linii (domyślnie 10),
 * z prognozą GPS i kolorem punktualności, a pod listą legenda oznaczeń.
 */
export interface BoardDeparture {
  key: string;
  line: string;
  color: string;
  textColor: string;
  /** Godzina z rozkładu (HH:MM). */
  clock: string;
  /** Prognozowany czas odjazdu (rozkład + GPS). */
  etaMs: number;
  /** Ile minut do odjazdu (0 = „teraz”). */
  minutes: number;
  /** Kierunek: litera wariantu + oficjalny opis. */
  suffix: string;
  label: string;
  legendText?: string;
  isRealtime: boolean;
  delaySeconds: number;
  tone: DelayTone;
  toneStyle: DelayStyle;
  departure: DepartureLineGroup["departures"][number];
}

const DEFAULT_LIMIT = 10;

/** Ile minut do odjazdu — zaokrąglone w dół, żeby „za 1 min” nie kłamało. */
export function minutesUntil(etaMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((etaMs - nowMs) / 60_000));
}

/** „teraz”, „za 3 min”, „za 1 h 12 min”. */
export function formatEta(minutes: number): string {
  if (minutes <= 0) return "teraz";
  if (minutes < 60) return `za ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `za ${hours} h ${rest} min` : `za ${hours} h`;
}

/**
 * Najbliższe odjazdy ze wszystkich linii, posortowane po czasie prognozowanym.
 * Kursy już odjechane (z uwzględnieniem opóźnienia) są pomijane.
 */
export function nextDepartures(
  groups: readonly DepartureLineGroup[],
  options: { nowMs: number; limit?: number },
): BoardDeparture[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const rows: BoardDeparture[] = [];
  for (const group of groups) {
    for (const entry of group.departures) {
      const { departure, direction } = entry;
      const etaMs = departure.atMs + (departure.isRealtime ? departure.delaySeconds * 1000 : 0);
      if (etaMs < options.nowMs) continue;
      const tone = delayTone(departure.isRealtime ? departure.delaySeconds : 0);
      rows.push({
        key: `${departure.tripId}|${departure.atMs}`,
        line: group.line,
        color: group.color,
        textColor: group.textColor,
        clock: departure.clock,
        etaMs,
        minutes: minutesUntil(etaMs, options.nowMs),
        suffix: direction.suffix,
        label: direction.label,
        legendText: direction.legendText,
        isRealtime: departure.isRealtime,
        delaySeconds: departure.delaySeconds,
        tone,
        toneStyle: DELAY_STYLES[tone],
        departure: entry,
      });
    }
  }
  return rows
    .sort((a, b) => a.etaMs - b.etaMs || a.line.localeCompare(b.line, "pl"))
    .slice(0, limit);
}

/**
 * Legenda liter użytych na tablicy (w kolejności oficjalnej legendy linii).
 * Zwraca pustą listę, gdy w kadrze nie ma żadnego wariantu z literą.
 */
export function boardLegend(
  groups: readonly DepartureLineGroup[],
): Array<{ line: string; code: string; text: string }> {
  const seen = new Set<string>();
  const rows: Array<{ line: string; code: string; text: string }> = [];
  for (const group of groups) {
    for (const direction of group.directions) {
      if (!direction.suffix || !direction.legendText) continue;
      const key = `${group.line}|${direction.suffix}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ line: group.line, code: direction.suffix, text: direction.legendText });
    }
  }
  return rows;
}

/** Opis kolorów punktualności do legendy pod listą (myBus 3.0: „Legenda oznaczeń”). */
export const PUNCTUALITY_LEGEND: Array<{ tone: DelayTone; style: DelayStyle }> = (
  ["early-small", "late", "late-high", "early-big"] as DelayTone[]
).map((tone) => ({ tone, style: DELAY_STYLES[tone] }));
