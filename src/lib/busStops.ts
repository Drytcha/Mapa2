import { queryOverpass } from "./core/overpass";
import { LruTtlCache, onRuntimeEvent, runDeduped } from "./core/runtimeHub";
import { coordKey, distanceCoords, isInsideBounds, type GeoBounds } from "./core/spatial";
import { foldPolish } from "./core/text";
import { readStorageJson, writeStorageJson } from "./core/time";
import { getTimetableStops } from "./engine/timetableStops";
import type { BusStop } from "./types";

export type Bounds = GeoBounds;

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

const LEGACY_CACHE_PREFIXES = ["mapplaner.stops.v5.", "mapplaner.stops.v6."];
const CACHE_PREFIX = "mapplaner.stops.v7.";
const CACHE_TTL = 12 * 60 * 60_000;
const memoryCache = new LruTtlCache<string, BusStop[]>(24, CACHE_TTL);
let legacyPurged = false;

onRuntimeEvent("gtfs:updated", () => {
  memoryCache.clear();
  removeStoredStopCaches([CACHE_PREFIX]);
});

function removeStoredStopCaches(prefixes: string[]) {
  try {
    if (typeof localStorage === "undefined") return;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* Storage optional */
  }
}

function purgeLegacyStopCache() {
  if (legacyPurged) return;
  legacyPurged = true;
  removeStoredStopCaches(LEGACY_CACHE_PREFIXES);
}

type StopKind = "platform" | "bus_stop" | "stop_position";
const PRIORITY: Record<StopKind, number> = { platform: 3, bus_stop: 2, stop_position: 1 };

const SAME_BAY_RADIUS_M = 30;
const UNTAGGED_MIXED_RADIUS_M = 12;
const EXACT_DUPLICATE_RADIUS_M = 3;
const PARTLY_TAGGED_RADIUS_M = 8;

const keyFor = (bounds: Bounds) =>
  CACHE_PREFIX +
  [bounds.south, bounds.west, bounds.north, bounds.east].map((v) => v.toFixed(3)).join(",");

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function linesFromTags(tags: Record<string, string>): string[] {
  const raw = tags.route_ref || tags.lines || "";
  return raw
    .split(/[;,]/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function classify(tags: Record<string, string>): StopKind | null {
  if (tags.railway || tags.tram === "yes" || tags.light_rail === "yes") return null;
  if (tags.public_transport === "platform" || tags.highway === "platform") return "platform";
  if (tags.highway === "bus_stop") return "bus_stop";
  if (tags.public_transport === "stop_position" && tags.bus === "yes") return "stop_position";
  if (tags.amenity === "bus_station") return "platform";
  return null;
}

function elementPosition(element: OverpassElement): [number, number] | null {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  return typeof lat === "number" && typeof lon === "number" ? [lat, lon] : null;
}

export interface Candidate {
  kind: StopKind;
  position: [number, number];
  name: string;
  lines: string[];
  shelter: boolean;
  operator?: string;
  ref?: string;
  direction?: string;
  towards?: string;
  side?: string;
  platformKey?: string;
  id: string;
}

function toCandidate(element: OverpassElement): Candidate | null {
  const tags = element.tags ?? {};
  const kind = classify(tags);
  const position = elementPosition(element);
  if (!kind || !position) return null;
  const name = (tags.name || tags["name:pl"] || "").trim();
  const operator = (tags.operator || tags.network || "").trim();
  const ref = (tags.ref || tags.local_ref || tags.platform || "").trim() || undefined;
  const direction = (tags.direction || tags.bearing || "").trim() || undefined;
  const towards = (tags.towards || tags.destination || "").trim() || undefined;
  const side = (tags.side || "").trim() || undefined;
  const platformKey =
    (ref || direction || towards || side || "").toLocaleLowerCase("pl") || undefined;
  return {
    kind,
    position,
    name,
    lines: linesFromTags(tags),
    shelter: tags.shelter === "yes",
    operator: operator || undefined,
    ref,
    direction,
    towards,
    side,
    platformKey,
    id: `${element.type}/${element.id}`,
  };
}

function canMerge(candidate: Candidate, existing: BusStop): boolean {
  if (
    candidate.name &&
    existing.name &&
    foldPolish(candidate.name.trim()) !== foldPolish(existing.name.trim())
  ) {
    return false;
  }
  const distance = distanceCoords(
    candidate.position[0],
    candidate.position[1],
    existing.lat,
    existing.lon
  );
  const candidateKey = candidate.platformKey;
  const existingKey = existing.platformKey;
  if (candidateKey && existingKey) {
    return candidateKey === existingKey && distance <= SAME_BAY_RADIUS_M;
  }
  if (!candidateKey && !existingKey) {
    if (distance > UNTAGGED_MIXED_RADIUS_M) return false;
    if (candidate.kind === existing.kind && distance > EXACT_DUPLICATE_RADIUS_M) return false;
    return true;
  }
  return distance <= PARTLY_TAGGED_RADIUS_M && candidate.kind !== existing.kind;
}

export function mergeStopCandidates(candidates: Candidate[]): BusStop[] {
  const merged: BusStop[] = [];
  for (const candidate of candidates) {
    const [lat, lon] = candidate.position;
    const target = merged.findIndex((other) => canMerge(candidate, other));
    if (target >= 0) {
      const existing = merged[target];
      const existingPriority = PRIORITY[existing.kind ?? "stop_position"];
      const candidatePriority = PRIORITY[candidate.kind];
      existing.lines = [...new Set([...existing.lines, ...candidate.lines])].slice(0, 14);
      existing.merged = (existing.merged ?? 1) + 1;
      existing.kinds = [
        ...new Set([...(existing.kinds ?? [existing.kind ?? "bus_stop"]), candidate.kind]),
      ];
      if (!existing.shelter && candidate.shelter) existing.shelter = true;
      if (!existing.operator && candidate.operator) existing.operator = candidate.operator;
      if (!existing.name && candidate.name) existing.name = candidate.name;
      if (!existing.ref && candidate.ref) existing.ref = candidate.ref;
      if (!existing.direction && candidate.direction) existing.direction = candidate.direction;
      if (!existing.towards && candidate.towards) existing.towards = candidate.towards;
      if (!existing.side && candidate.side) existing.side = candidate.side;
      if (!existing.platformKey && candidate.platformKey) {
        existing.platformKey = candidate.platformKey;
      }
      if (candidatePriority > existingPriority) {
        existing.lat = lat;
        existing.lon = lon;
        existing.kind = candidate.kind;
        existing.id = candidate.id;
      }
      continue;
    }
    merged.push({
      id: candidate.id,
      name:
        candidate.name ||
        (candidate.operator ? `Przystanek ${candidate.operator}` : "Przystanek bez nazwy"),
      lat,
      lon,
      lines: candidate.lines,
      shelter: candidate.shelter,
      operator: candidate.operator,
      ref: candidate.ref,
      direction: candidate.direction,
      towards: candidate.towards,
      side: candidate.side,
      platformKey: candidate.platformKey,
      kind: candidate.kind,
      kinds: [candidate.kind],
      merged: 1,
    });
  }
  return merged.sort((a, b) => stopDisplayName(a).localeCompare(b.name, "pl"));
}

const displayNameCache = new WeakMap<BusStop, string>();

export function stopDisplayName(stop: BusStop): string {
  const cached = displayNameCache.get(stop);
  if (cached) return cached;
  let display: string;
  if (stop.ref) display = `${stop.name} · stan. ${stop.ref}`;
  else if (stop.side) display = `${stop.name} · strona ${stop.side}`;
  else if (stop.towards) display = `${stop.name} · do ${stop.towards}`;
  else if (stop.direction) display = `${stop.name} · kier. ${stop.direction}`;
  else if (stop.source === "timetable") display = stop.name;
  else display = `${stop.name} · ${coordKey(stop.lat, stop.lon, 4).replace(",", ", ")}`;
  displayNameCache.set(stop, display);
  return display;
}

function readCache(key: string): BusStop[] | null {
  purgeLegacyStopCache();
  const hit = memoryCache.get(key);
  if (hit) return hit;
  const parsed = readStorageJson<{ at: number; stops: BusStop[] }>(key);
  if (!parsed?.at || Date.now() - parsed.at > CACHE_TTL || !Array.isArray(parsed.stops)) {
    return null;
  }
  memoryCache.set(key, parsed.stops, parsed.at);
  return parsed.stops;
}

function writeCache(key: string, stops: BusStop[]) {
  purgeLegacyStopCache();
  memoryCache.set(key, stops);
  writeStorageJson(key, { at: Date.now(), stops });
}

function elementsToStops(elements: OverpassElement[], bounds?: Bounds): BusStop[] {
  const candidates: Candidate[] = [];
  const seenIds = new Set<string>();
  for (const element of elements) {
    const candidate = toCandidate(element);
    if (!candidate || seenIds.has(candidate.id)) continue;
    if (bounds && !isInsideBounds(candidate.position[0], candidate.position[1], bounds)) {
      continue;
    }
    seenIds.add(candidate.id);
    candidates.push(candidate);
  }
  return mergeStopCandidates(candidates);
}

/** Stops of the Wałbrzych timetable (GTFS + official rozklad.walbrzych.eu snapshot). */
export async function fetchTimetableStops(
  signal?: AbortSignal,
  force = false
): Promise<BusStop[]> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const { stops } = await getTimetableStops(force);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return stops;
}

/**
 * Timetable stops are authoritative. OpenStreetMap stops are matched to them (<= 40 m with
 * the same name, or <= 14 m) and only add attributes; OSM-only stops are kept as "osm".
 */
export function mergeTimetableWithOsm(timetable: BusStop[], osm: BusStop[]): BusStop[] {
  const result = timetable
    .filter((stop) => stop.source === "timetable" && stop.lines.length > 0)
    .map((stop) => ({ ...stop }));
  for (const candidate of osm) {
    if (!candidate.shelter) continue;
    const candidateName = foldPolish(candidate.name.trim());
    let hit = -1;
    let best = 40;
    for (let index = 0; index < result.length; index += 1) {
      const existing = result[index];
      const distance = distanceCoords(candidate.lat, candidate.lon, existing.lat, existing.lon);
      if (distance > best) continue;
      const existingName = foldPolish(existing.name.trim());
      const sameName =
        !candidateName ||
        existingName === candidateName ||
        existingName.includes(candidateName) ||
        candidateName.includes(existingName);
      if (distance <= 14 || sameName) {
        best = distance;
        hit = index;
      }
    }
    if (hit >= 0) result[hit].shelter = true;
  }
  return result.sort((a, b) => stopDisplayName(a).localeCompare(b.name, "pl"));
}

export async function fetchBusStops(
  bounds: Bounds,
  options: { signal?: AbortSignal; force?: boolean; onProgress?: (seconds: number) => void } = {}
): Promise<BusStop[]> {
  const { signal, force = false, onProgress } = options;
  const key = keyFor(bounds);
  if (!force) {
    const cached = readCache(key);
    if (cached) return cached;
  }

  const run = async () => {
    const timetable = (await fetchTimetableStops(signal, force)).filter(
      (stop) => stop.lines.length > 0 && isInsideBounds(stop.lat, stop.lon, bounds)
    );

    const area = (bounds.north - bounds.south) * (bounds.east - bounds.west);
    if (!force || timetable.length === 0 || area > 0.6) {
      writeCache(key, timetable);
      return timetable;
    }

    const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
    const query = `[out:json][timeout:10];
(
  node["highway"="bus_stop"]["shelter"="yes"](${bbox});
  node["public_transport"="platform"]["bus"="yes"]["shelter"="yes"](${bbox});
);
out tags center;`;

    const startedAt = Date.now();
    const ticker = onProgress
      ? setInterval(() => onProgress(Math.round((Date.now() - startedAt) / 1000)), 1000)
      : null;

    let elements: OverpassElement[] | null = null;
    try {
      const res = await queryOverpass<OverpassElement>(query, {
        signal,
        timeoutMs: 8_000,
        force: true,
      });
      elements = res.elements;
    } finally {
      if (ticker) clearInterval(ticker);
    }

    if (!elements) {
      writeCache(key, timetable);
      return timetable;
    }

    const stops = mergeTimetableWithOsm(timetable, elementsToStops(elements));
    writeCache(key, stops);
    return stops;
  };

  return signal || force ? run() : runDeduped(`busStops:${key}`, run);
}

export function groupStopsByName(stops: BusStop[]) {
  const groups = new Map<string, BusStop[]>();
  for (const stop of stops) {
    const key = `${stopDisplayName(stop)}|${coordKey(stop.lat, stop.lon, 6)}`;
    const list = groups.get(key);
    if (list) list.push(stop);
    else groups.set(key, [stop]);
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

const stopSearchBlobCache = new WeakMap<BusStop, string>();

function getStopSearchBlob(stop: BusStop): string {
  const hit = stopSearchBlobCache.get(stop);
  if (hit !== undefined) return hit;
  const blob = foldPolish(
    [
      stop.name,
      stopDisplayName(stop),
      stop.ref ?? "",
      stop.towards ?? "",
      stop.direction ?? "",
      stop.side ?? "",
      stop.operator ?? "",
      ...stop.lines,
    ].join(" \0 ")
  );
  stopSearchBlobCache.set(stop, blob);
  return blob;
}

export function filterStops(stops: BusStop[], query: string): BusStop[] {
  const term = foldPolish(query.trim());
  if (!term) return stops;
  return stops.filter((stop) => getStopSearchBlob(stop).includes(term));
}
