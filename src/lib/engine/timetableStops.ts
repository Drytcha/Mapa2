import type { BusStop } from "@/lib/types";
import { ensureGtfsSeeded, type GtfsMemoryStore } from "./gtfsStore";
import { loadOfficialStops } from "./officialStops";

export interface TimetableStopsResult {
  stops: BusStop[];
  meta: {
    /** Stops shown = GTFS stops with at least one scheduled call on an active service. */
    total: number;
    /** All stops listed in stops.txt (including ones no trip visits). */
    fromGtfs: number;
    /** GTFS stops dropped because no active trip calls there. */
    unservedGtfs: number;
    /** rozklad.walbrzych.eu stops without a GTFS counterpart – not shown (no trips). */
    officialOnly: number;
    officialSource: string;
    officialFetchedAt: string | null;
  };
}

const fold = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l")
    .replace(/\(?\bna zadanie\b\)?|\(?\bna żądanie\b\)?|\bn\/z\b|\bnz\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** "Niepodległości -Kaszubska" -> "Niepodległości - Kaszubska"; keeps "Jedlina-Zdrój". */
export function tidyStopName(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s+-(?=\S)/g, " - ")
    .replace(/(\S)-\s+/g, "$1 - ")
    .replace(/\s+,/g, ",")
    .trim();
}

function metres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * 110540;
  const dLon = (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
}

function compareLines(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na) return -1;
  if (nb) return 1;
  return a.localeCompare(b, "pl");
}

let cache: { at: number; value: TimetableStopsResult } | null = null;
const TTL_MS = 10 * 60_000;

export function invalidateTimetableStops(): void {
  cache = null;
}

export async function getTimetableStops(force = false): Promise<TimetableStopsResult> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const store = await ensureGtfsSeeded();
  const value = buildTimetableStops(store);
  cache = { at: Date.now(), value };
  return value;
}

/**
 * Pure builder (no I/O) so the "only served stops" rule can be verified against a
 * real GTFS archive in tests: every returned stop is a GTFS stop with at least one
 * scheduled call on an active service; nothing else is added.
 */
export function buildTimetableStops(store: Pick<GtfsMemoryStore, "base">): TimetableStopsResult {
  const official = loadOfficialStops();

  const stops: BusStop[] = [];
  const usedOfficial = new Set<number>();
  let unservedGtfs = 0;

  for (const g of store.base.stops) {
    // Only stops that buses really call at: at least one boarding/alighting
    // stop_time on a trip of a service active inside the feed window.
    if (!store.base.servedStopIds.has(g.id)) {
      unservedGtfs += 1;
      continue;
    }
    let best: (typeof official.stops)[number] | null = null;
    let bestDistance = 45;
    for (const o of official.stops) {
      const d = metres(g.lat, g.lon, o.lat, o.lon);
      if (d > bestDistance) continue;
      const a = fold(g.name);
      const b = fold(o.name);
      const compatible = d <= 12 || a === b || a.includes(b) || b.includes(a);
      if (!compatible) continue;
      best = o;
      bestDistance = d;
    }
    if (best) usedOfficial.add(best.id);
    // Lines come from the trips that actually call here; the official snapshot
    // is only a fallback when the feed has no route information for the stop.
    const gtfsLines = store.base.linesByStopId.get(g.id);
    const lines = new Set<string>(gtfsLines?.size ? gtfsLines : best?.lines ?? []);
    const calls = store.base.callsByStopId.get(g.id);
    stops.push({
      id: `tt-${g.id}`,
      gtfsId: g.id,
      name: tidyStopName(g.name),
      lat: g.lat,
      lon: g.lon,
      lines: [...lines].sort(compareLines),
      shelter: false,
      operator: "Rozkład jazdy Wałbrzych",
      kind: "bus_stop",
      source: "timetable",
      ref: g.platformCode || undefined,
      calls: calls ? { ...calls } : undefined,
    });
  }

  // Stops known only from the rozklad.walbrzych.eu snapshot (no GTFS counterpart)
  // have no trips, departures or kursówki behind them – they are counted for
  // diagnostics but deliberately NOT added to the map.
  let officialOnly = 0;
  for (const o of official.stops) {
    if (usedOfficial.has(o.id) || o.lines.length === 0) continue;
    const near = stops.some(
      (s) => metres(s.lat, s.lon, o.lat, o.lon) <= 30 && fold(s.name) === fold(o.name)
    );
    if (near) continue;
    officialOnly += 1;
  }

  const groups = new Map<string, BusStop[]>();
  for (const s of stops) {
    const key = fold(s.name);
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const close = list.filter((s) =>
      list.some((o) => o !== s && metres(s.lat, s.lon, o.lat, o.lon) <= 300)
    );
    for (const s of close) {
      const dest = s.gtfsId ? store.base.topDestByStopId.get(s.gtfsId) : undefined;
      if (dest && fold(dest) !== fold(s.name)) s.towards = tidyStopName(dest);
    }
  }

  stops.sort((a, b) => a.name.localeCompare(b.name, "pl"));
  return {
    stops,
    meta: {
      total: stops.length,
      fromGtfs: store.base.stops.length,
      unservedGtfs,
      officialOnly,
      officialSource: official.source,
      officialFetchedAt: official.fetchedAt,
    },
  };
}
