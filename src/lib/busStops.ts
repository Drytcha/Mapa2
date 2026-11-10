import { getTimetableStops, invalidateTimetableStops } from "./engine/timetableStops";
import type { BusStop } from "./types";

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * Whole Wałbrzych timetable area: Szczawno-Zdrój, Boguszów-Gorce, Jedlina-Zdrój, Głuszyca
 * with Andrzejówka and Rybnica Leśna, Mieroszów, Sokołowsko, Stare Bogaczowice and Struga.
 */
export const WALBRZYCH_BOUNDS: Bounds = {
  south: 50.6,
  west: 16.07,
  north: 50.88,
  east: 16.44,
};

export const WALBRZYCH_CENTER: [number, number] = [50.7714, 16.2843];
export const WALBRZYCH_ZOOM = 14;

/** Human readable label of the only stop source used on the map. */
export const BUS_STOP_SOURCE_LABEL = "tylko przystanki obsługiwane przez kursy GTFS";

/*
 * v6: the stop layer contains exclusively stops that scheduled buses call at
 * (GTFS stop_times of active services). Older caches still hold unverified
 * OpenStreetMap stops and rozklad.walbrzych.eu-only entries, so the key changed.
 */
const CACHE_PREFIX = "mapplaner.stops.v6.";
const CACHE_TTL = 12 * 60 * 60 * 1000;
const memoryCache = new Map<string, { at: number; stops: BusStop[] }>();

const keyFor = (bounds: Bounds) =>
  CACHE_PREFIX +
  [bounds.south, bounds.west, bounds.north, bounds.east].map((v) => v.toFixed(3)).join(",");

export function stopDisplayName(stop: BusStop): string {
  if (stop.ref) return `${stop.name} · stan. ${stop.ref}`;
  if (stop.side) return `${stop.name} · strona ${stop.side}`;
  if (stop.towards) return `${stop.name} · do ${stop.towards}`;
  if (stop.direction) return `${stop.name} · kier. ${stop.direction}`;
  if (stop.source === "timetable") return stop.name;
  return `${stop.name} · ${stop.lat.toFixed(4)}, ${stop.lon.toFixed(4)}`;
}

/** Total scheduled calls across the three day types – 0 means "nothing stops here". */
export function stopCallsTotal(stop: BusStop): number {
  const calls = stop.calls;
  if (!calls) return 0;
  return calls.weekday + calls.saturday + calls.sunday;
}

/** "1 kurs", "3 kursy", "12 kursów" – Polish plural forms for scheduled calls. */
export function formatCalls(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word =
    count === 1
      ? "kurs"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "kursy"
        : "kursów";
  return `${count} ${word}`;
}

/** Short summary of calls for the busiest day type, e.g. "54 kursy / dzień rob.". */
export function describeCalls(stop: BusStop): string | null {
  const calls = stop.calls;
  if (!calls) return null;
  if (calls.weekday > 0) return `${formatCalls(calls.weekday)} / dzień rob.`;
  if (calls.saturday > 0) return `${formatCalls(calls.saturday)} / sobota`;
  if (calls.sunday > 0) return `${formatCalls(calls.sunday)} / niedziela`;
  return null;
}

/** True when at least one scheduled bus trip calls at the stop. */
export function isServedStop(stop: BusStop): boolean {
  if (stop.source !== "timetable" || !stop.gtfsId) return false;
  if (stop.calls) return stopCallsTotal(stop) > 0;
  return stop.lines.length > 0;
}

function readCache(key: string): BusStop[] | null {
  const hit = memoryCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.stops;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; stops: BusStop[] };
    if (!parsed?.at || Date.now() - parsed.at > CACHE_TTL || !Array.isArray(parsed.stops)) {
      return null;
    }
    const stops = parsed.stops.filter(isServedStop);
    memoryCache.set(key, { at: parsed.at, stops });
    return stops;
  } catch {
    return null;
  }
}

function writeCache(key: string, stops: BusStop[]) {
  memoryCache.set(key, { at: Date.now(), stops });
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), stops }));
  } catch {
    /* Storage optional */
  }
}

/** Removes stop caches of older layer versions (they contain unverified stops). */
function dropLegacyCaches() {
  try {
    const legacy: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith("mapplaner.stops.") && !key.startsWith(CACHE_PREFIX)) {
        legacy.push(key);
      }
    }
    legacy.forEach((key) => localStorage.removeItem(key));
  } catch {
    /* Storage optional */
  }
}

/** Stops of the Wałbrzych timetable that scheduled GTFS trips really call at. */
export async function fetchTimetableStops(signal?: AbortSignal, force = false): Promise<BusStop[]> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (force) invalidateTimetableStops();
  const { stops } = await getTimetableStops(force);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return stops.filter(isServedStop);
}

const insideBounds = (stop: BusStop, bounds: Bounds) =>
  stop.lat >= bounds.south &&
  stop.lat <= bounds.north &&
  stop.lon >= bounds.west &&
  stop.lon <= bounds.east;

/**
 * Bus stops for the given area.
 *
 * Only stops with scheduled service are returned: every stop comes from the Wałbrzych
 * GTFS feed and has at least one trip (kursówka) calling at it on an active service day.
 * Stops that exist merely in OpenStreetMap or in the rozklad.walbrzych.eu snapshot but
 * are not visited by any current trip are intentionally left out.
 */
export async function fetchBusStops(
  bounds: Bounds,
  options: { signal?: AbortSignal; force?: boolean; onProgress?: (seconds: number) => void } = {}
): Promise<BusStop[]> {
  const { signal, force = false, onProgress } = options;
  const key = keyFor(bounds);
  dropLegacyCaches();
  if (!force) {
    const cached = readCache(key);
    if (cached && cached.length) return cached;
  }

  const startedAt = Date.now();
  const ticker = onProgress
    ? setInterval(() => onProgress(Math.round((Date.now() - startedAt) / 1000)), 1000)
    : null;
  try {
    const stops = (await fetchTimetableStops(signal, force)).filter((stop) =>
      insideBounds(stop, bounds)
    );
    writeCache(key, stops);
    return stops;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(
      error instanceof Error && error.message
        ? error.message
        : "Nie udało się wczytać przystanków z rozkładu GTFS Wałbrzych."
    );
  } finally {
    if (ticker) clearInterval(ticker);
  }
}

export function groupStopsByName(stops: BusStop[]) {
  const groups = new Map<string, BusStop[]>();
  for (const stop of stops) {
    const key = `${stopDisplayName(stop)}|${stop.lat.toFixed(6)},${stop.lon.toFixed(6)}`;
    const list = groups.get(key) ?? [];
    list.push(stop);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, members]) => ({
      key,
      name: stopDisplayName(members[0]),
      members,
      lines: [...new Set(members.flatMap((member) => member.lines))].slice(0, 14),
      lat: members.reduce((sum, member) => sum + member.lat, 0) / members.length,
      lon: members.reduce((sum, member) => sum + member.lon, 0) / members.length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "pl"));
}

export function filterStops(stops: BusStop[], query: string) {
  const fold = (value: string) =>
    value
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ł/g, "l");
  const term = fold(query.trim());
  if (!term) return stops;
  return stops.filter((stop) =>
    [
      stop.name,
      stopDisplayName(stop),
      stop.ref ?? "",
      stop.towards ?? "",
      stop.direction ?? "",
      stop.side ?? "",
      stop.operator ?? "",
      ...stop.lines,
    ].some((value) => fold(value).includes(term))
  );
}
