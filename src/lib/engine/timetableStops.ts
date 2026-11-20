import { onRuntimeEvent, runDeduped } from "@/lib/core/runtimeHub";
import { distanceCoords } from "@/lib/core/spatial";
import { dedupeLines, foldStopKey } from "@/lib/core/text";
import type { BusStop } from "@/lib/types";
import { ensureGtfsSeeded } from "./gtfsStore";
import { boardableStopInfo } from "./boardableStops";
import { OFFICIAL_STOPS_BY_ID, loadOfficialStops } from "./officialStops";
import { mergeTimetableStops, type StopVector } from "./mergeTimetableStops";

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
    const destinationsByStopId = new Map<string, string>();
    // Use the entire feed validity window, not just today: a weekend or seasonal
    // departure is still a departure. Mirror the GTFS parser's calendar filter.
    const activeServices = new Set<string>();
    for (const [date, serviceIds] of store.base.serviceIdsByDate) {
      if (store.base.feedStartDate > 0 && date < store.base.feedStartDate) continue;
      if (store.base.feedEndDate > 0 && date > store.base.feedEndDate) continue;
      for (const id of serviceIds) activeServices.add(id);
    }
    const routeNames = new Map([...store.base.routesById].map(([id, route]) => [id, route.shortName]));

    for (const g of store.base.stops) {
      if (!store.base.activeStopIds.has(g.id)) continue;
      const { lines, destination } = boardableStopInfo(
        store.stopTimesByStopId.get(g.id) ?? [],
        activeServices.size ? activeServices : null,
        routeNames
      );
      if (!lines.size) continue;
      if (destination) destinationsByStopId.set(g.id, destination);

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

    // Some malformed feeds contain no usable boarding information at all. In that
    // case keep the known timetable stops instead of blanking the entire map.
    if (!stops.length) {
      for (const g of store.base.stops) {
        if (!store.base.activeStopIds.has(g.id)) continue;
        const lines = store.base.linesByStopId.get(g.id);
        if (!lines?.size) continue;
        stops.push({
          id: `tt-${g.id}`, gtfsId: g.id, name: tidyStopName(g.name),
          lat: g.lat, lon: g.lon, lines: dedupeLines(lines), shelter: false,
          operator: "Rozkład jazdy Wałbrzych", kind: "bus_stop", source: "timetable",
          ref: g.platformCode || undefined,
        });
        const dest = store.base.topDestByStopId.get(g.id);
        if (dest) destinationsByStopId.set(g.id, dest);
      }
    }

    // Derive approach bearings from real trip sequences, not final headsigns:
    // routes can branch after the same physical platform.
    const vectors = new Map<string, StopVector[]>();
    for (const [tripId, times] of store.base.rawStopTimesByTrip) {
      const trip = store.base.rawTripsById.get(tripId);
      if (!trip || (activeServices.size && !activeServices.has(trip.serviceId))) continue;
      for (let i = 0; i < times.length - 1; i++) {
        if (times[i].pickupType === 1) continue;
        const current = store.base.stopsById.get(times[i].stopId);
        if (!current) continue;
        let other = null;
        let incoming = true;
        for (let j = i - 1; j >= 0; j--) {
          const candidate = store.base.stopsById.get(times[j].stopId);
          if (candidate && distanceCoords(current.lat, current.lon, candidate.lat, candidate.lon) >= 40) { other = candidate; break; }
        }
        if (!other) {
          incoming = false;
          for (let j = i + 1; j < times.length; j++) {
            const candidate = store.base.stopsById.get(times[j].stopId);
            if (candidate && distanceCoords(current.lat, current.lon, candidate.lat, candidate.lon) >= 40) { other = candidate; break; }
          }
        }
        if (!other) continue;
        const dx = (current.lon - other.lon) * Math.cos(current.lat * Math.PI / 180) * (incoming ? 1 : -1);
        const dy = (current.lat - other.lat) * (incoming ? 1 : -1);
        const length = Math.hypot(dx, dy);
        const list = vectors.get(current.id) ?? [];
        // Avoid repeated vectors for the many trips sharing a pattern.
        const vector: StopVector = [dx / length, dy / length];
        if (!list.some((v) => v[0] * vector[0] + v[1] * vector[1] > 0.999)) list.push(vector);
        vectors.set(current.id, list);
      }
    }
    const officialByName = new Map<string, ReturnType<typeof loadOfficialStops>["stops"]>();
    for (const official of loadOfficialStops().stops) {
      const key = foldStopKey(official.name);
      const list = officialByName.get(key) ?? [];
      list.push(official);
      officialByName.set(key, list);
    }
    const evidence = new Map(stops.map((s) => {
      const official = s.gtfsId ? OFFICIAL_STOPS_BY_ID.get(s.gtfsId) : undefined;
      const gtfs = s.gtfsId ? store.base.stopsById.get(s.gtfsId) : undefined;
      const name = foldStopKey(s.name);
      let symbol = official && foldStopKey(official.name) === name &&
        distanceCoords(official.lat, official.lon, s.lat, s.lon) <= 25 ? official.symbol : undefined;
      if (!symbol) {
        // IDs may differ across feeds. Use the local snapshot only when all
        // very close same-name records agree on the physical symbol.
        const symbols = new Set((officialByName.get(name) ?? [])
          .filter((item) => distanceCoords(item.lat, item.lon, s.lat, s.lon) <= 8)
          .map((item) => item.symbol).filter(Boolean));
        if (symbols.size === 1) symbol = [...symbols][0];
      }
      return [s.id, { symbol, code: gtfs?.code || s.ref, vectors: vectors.get(s.gtfsId ?? "") }] as const;
    }));
    const mergedStops = mergeTimetableStops(stops, evidence);

    const groups = new Map<string, BusStop[]>();
    for (const s of mergedStops) {
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
        const destinations = [...new Set((s.gtfsIds ?? (s.gtfsId ? [s.gtfsId] : []))
          .map((id) => destinationsByStopId.get(id)).filter((value): value is string => !!value))];
        const dest = destinations.length === 1 ? destinations[0] : undefined;
        if (dest && foldStopKey(dest) !== foldStopKey(s.name)) {
          s.towards = tidyStopName(dest);
        }
      }
    }

    mergedStops.sort((a, b) => a.name.localeCompare(b.name, "pl"));
    const value: TimetableStopsResult = {
      stops: mergedStops,
      meta: {
        total: mergedStops.length,
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
