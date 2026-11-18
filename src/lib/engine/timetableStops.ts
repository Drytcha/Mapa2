import { onRuntimeEvent, runDeduped } from "@/lib/core/runtimeHub";
import { distanceCoords } from "@/lib/core/spatial";
import { dedupeLines, foldStopKey } from "@/lib/core/text";
import type { BusStop } from "@/lib/types";
import { ensureGtfsSeeded } from "./gtfsStore";

export interface TimetableStopsResult {
  stops: BusStop[];
  meta: {
    total: number;
    fromGtfs: number;
    officialOnly: number;
    officialSource: string;
    officialFetchedAt: string | null;
  };
}

/** "Niepodległości -Kaszubska" -> "Niepodległości - Kaszubska"; keeps "Jedlina-Zdrój". */
export function tidyStopName(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s+-(?=\S)/g, " - ")
    .replace(/(\S)-\s+/g, "$1 - ")
    .replace(/\s+,/g, ",")
    .trim();
}

let cache: { at: number; value: TimetableStopsResult } | null = null;
const TTL_MS = 10 * 60_000;

export function invalidateTimetableStops(): void {
  cache = null;
}

// Automatically drop cached timetable stops whenever the GTFS feed reloads
onRuntimeEvent("gtfs:updated", () => {
  cache = null;
});

export async function getTimetableStops(force = false): Promise<TimetableStopsResult> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;

  return runDeduped(force ? "timetableStops:force" : "timetableStops:default", async () => {
    const store = await ensureGtfsSeeded();
    const stops: BusStop[] = [];

    for (const g of store.base.stops) {
      if (!store.base.activeStopIds.has(g.id)) continue;
      if (!store.stopTimesByStopId.get(g.id)?.length) continue;
      const lines = store.base.linesByStopId.get(g.id);
      if (!lines || lines.size === 0) continue;

      stops.push({
        id: `tt-${g.id}`,
        gtfsId: g.id,
        name: tidyStopName(g.name),
        lat: g.lat,
        lon: g.lon,
        lines: dedupeLines(lines),
        shelter: false,
        operator: "Rozkład jazdy Wałbrzych",
        kind: "bus_stop",
        source: "timetable",
        ref: g.platformCode || undefined,
      });
    }

    const groups = new Map<string, BusStop[]>();
    for (const s of stops) {
      const key = foldStopKey(s.name);
      const list = groups.get(key);
      if (list) list.push(s);
      else groups.set(key, [s]);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const close = list.filter((s) =>
        list.some((o) => o !== s && distanceCoords(s.lat, s.lon, o.lat, o.lon) <= 300)
      );
      for (const s of close) {
        const dest = s.gtfsId ? store.base.topDestByStopId.get(s.gtfsId) : undefined;
        if (dest && foldStopKey(dest) !== foldStopKey(s.name)) {
          s.towards = tidyStopName(dest);
        }
      }
    }

    stops.sort((a, b) => a.name.localeCompare(b.name, "pl"));
    const value: TimetableStopsResult = {
      stops,
      meta: {
        total: stops.length,
        fromGtfs: stops.length,
        officialOnly: 0,
        officialSource: store.feed.source,
        officialFetchedAt: store.feed.generatedAt,
      },
    };
    cache = { at: Date.now(), value };
    return value;
  });
}
