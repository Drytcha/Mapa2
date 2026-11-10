import { getTimetableStops } from "./engine/timetableStops";
import { withOverpassSlot } from "./requests";
import { OVERPASS_URL } from "./services";
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

const ENDPOINTS = [
  OVERPASS_URL,
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
].filter((url, index, list) => list.indexOf(url) === index);

const LEGACY_CACHE_PREFIX = "mapplaner.stops.v5.";
const CACHE_PREFIX = "mapplaner.stops.v6.";
const CACHE_TTL = 12 * 60 * 60 * 1000;
const memoryCache = new Map<string, { at: number; stops: BusStop[] }>();
let legacyPurged = false;

function purgeLegacyStopCache() {
  if (legacyPurged) return;
  legacyPurged = true;
  try {
    if (typeof localStorage === "undefined") return;
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LEGACY_CACHE_PREFIX)) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch {
    /* Storage optional */
  }
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

function metresBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const meanLat = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const dx = (lon2 - lon1) * 111320 * Math.cos(meanLat);
  const dy = (lat2 - lat1) * 110540;
  return Math.hypot(dx, dy);
}

const foldName = (value: string) =>
  value
    .trim()
    .toLocaleLowerCase("pl")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

function canMerge(candidate: Candidate, existing: BusStop): boolean {
  if (candidate.name && existing.name && foldName(candidate.name) !== foldName(existing.name)) {
    return false;
  }
  const distance = metresBetween(
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

export function stopDisplayName(stop: BusStop): string {
  if (stop.ref) return `${stop.name} · stan. ${stop.ref}`;
  if (stop.side) return `${stop.name} · strona ${stop.side}`;
  if (stop.towards) return `${stop.name} · do ${stop.towards}`;
  if (stop.direction) return `${stop.name} · kier. ${stop.direction}`;
  if (stop.source === "timetable") return stop.name;
  return `${stop.name} · ${stop.lat.toFixed(4)}, ${stop.lon.toFixed(4)}`;
}

function readCache(key: string): BusStop[] | null {
  purgeLegacyStopCache();
  const hit = memoryCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.stops;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; stops: BusStop[] };
    if (!parsed?.at || Date.now() - parsed.at > CACHE_TTL || !Array.isArray(parsed.stops)) {
      return null;
    }
    memoryCache.set(key, { at: parsed.at, stops: parsed.stops });
    return parsed.stops;
  } catch {
    return null;
  }
}

function writeCache(key: string, stops: BusStop[]) {
  purgeLegacyStopCache();
  memoryCache.set(key, { at: Date.now(), stops });
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), stops }));
  } catch {
    /* Storage optional */
  }
}

async function queryEndpoint(
  url: string,
  query: string,
  timeout: number,
  signal?: AbortSignal
): Promise<OverpassElement[]> {
  return withOverpassSlot(async () => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ data: query }).toString(),
      });
      if (!response.ok) throw new Error(`Overpass ${response.status}`);
      const data = (await response.json()) as { elements?: OverpassElement[]; remark?: string };
      if (data.remark) throw new Error(data.remark);
      if (!Array.isArray(data.elements)) throw new Error("Nieprawidłowa odpowiedź Overpass");
      return data.elements;
    } catch (error) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (controller.signal.aborted) throw new Error("Overpass timeout");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }, signal);
}

function elementsToStops(elements: OverpassElement[], bounds?: Bounds): BusStop[] {
  const candidates: Candidate[] = [];
  const seenIds = new Set<string>();
  for (const element of elements) {
    const candidate = toCandidate(element);
    if (!candidate || seenIds.has(candidate.id)) continue;
    if (bounds) {
      const [lat, lon] = candidate.position;
      if (lat < bounds.south || lat > bounds.north || lon < bounds.west || lon > bounds.east) {
        continue;
      }
    }
    seenIds.add(candidate.id);
    candidates.push(candidate);
  }
  return mergeStopCandidates(candidates);
}

/** Stops of the Wałbrzych timetable (GTFS + official rozklad.walbrzych.eu snapshot). */
export async function fetchTimetableStops(signal?: AbortSignal, force = false): Promise<BusStop[]> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const { stops } = await getTimetableStops(force);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return stops;
}

const insideBounds = (stop: BusStop, bounds: Bounds) =>
  stop.lat >= bounds.south &&
  stop.lat <= bounds.north &&
  stop.lon >= bounds.west &&
  stop.lon <= bounds.east;

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
    const candidateName = foldName(candidate.name);
    let hit = -1;
    let best = 40;
    for (let index = 0; index < result.length; index += 1) {
      const existing = result[index];
      const distance = metresBetween(candidate.lat, candidate.lon, existing.lat, existing.lon);
      if (distance > best) continue;
      const existingName = foldName(existing.name);
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

  const timetable = (await fetchTimetableStops(signal, force)).filter(
    (stop) => stop.lines.length > 0 && insideBounds(stop, bounds)
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
    for (let index = 0; index < ENDPOINTS.length; index += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        elements = await queryEndpoint(
          ENDPOINTS[index],
          query,
          index === 0 ? 8000 : 6000,
          signal
        );
        break;
      } catch (error) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        // Overpass shelter enrichment is best-effort only
      }
    }
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
