import walbrzychTurnaroundData from "@/data/walbrzych-turnarounds.json";
import { withOverpassSlot } from "@/lib/requests";
import { OVERPASS_URL } from "@/lib/services";
import { idbGetKv, idbSetKv } from "./storage";

export type TurnaroundKind = "roundabout" | "crossing";

export interface TurnaroundSpot {
  id: string;
  lat: number;
  lon: number;
  kind: TurnaroundKind;
  arms: number;
  routeOffsetMeters: number;
}

interface RawSpot {
  id: string;
  kind: TurnaroundKind;
  arms: number;
  lat: number;
  lon: number;
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  nodes?: number[];
  tags?: Record<string, string>;
}

const WALBRZYCH_BBOX = {
  south: 50.685,
  west: 16.135,
  north: 50.885,
  east: 16.435,
};

const OVERPASS_ENDPOINTS = [
  OVERPASS_URL,
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
].filter((url, idx, list) => list.indexOf(url) === idx);

const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const CACHE_PREFIX = "mapplaner.turnarounds.v1.";

/**
 * Turn-around spots for long vehicles (12 m+ buses): roundabouts and large
 * (4-way or larger) crossings built from major roads only. T-junctions and
 * service roads are excluded — those are car-scale places a bus cannot turn around.
 */
const LOCAL_WALBRZYCH_SPOTS: RawSpot[] = (
  walbrzychTurnaroundData as Array<RawSpot>
).filter(
  (el) =>
    el &&
    typeof el.lat === "number" &&
    typeof el.lon === "number" &&
    (el.kind === "roundabout" || el.kind === "crossing")
);

function insideWalbrzych(south: number, west: number, north: number, east: number): boolean {
  return (
    south >= WALBRZYCH_BBOX.south - 0.005 &&
    west >= WALBRZYCH_BBOX.west - 0.005 &&
    north <= WALBRZYCH_BBOX.north + 0.005 &&
    east <= WALBRZYCH_BBOX.east + 0.005
  );
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const latM = 110540;
  const lonM = 111320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot((lat2 - lat1) * latM, (lon2 - lon1) * lonM);
}

function pointToSegmentMeters(
  pLat: number,
  pLon: number,
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): { distance: number; t: number } {
  const latM = 110540;
  const lonM = 111320 * Math.cos((pLat * Math.PI) / 180);
  const px = (pLon - aLon) * lonM;
  const py = (pLat - aLat) * latM;
  const bx = (bLon - aLon) * lonM;
  const by = (bLat - aLat) * latM;
  const len2 = bx * bx + by * by;
  if (len2 <= 1e-6) return { distance: Math.hypot(px, py), t: 0 };
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return { distance: Math.hypot(px - bx * t, py - by * t), t };
}

/** Builds raw turn-around spots from Overpass elements (roundabouts + 4-way+ major crossings). */
function buildSpotsFromElements(elements: OverpassElement[]): RawSpot[] {
  // 1. Roundabouts: junction nodes, roundabout/circular ring ways, multipolygon relations.
  const roundSpots: Array<{ id: string; lat: number; lon: number }> = [];
  const addRound = (id: string, lat: number, lon: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (!roundSpots.some((s) => haversineMeters(s.lat, s.lon, lat, lon) <= 45)) {
      roundSpots.push({ id, lat, lon });
    }
  };
  for (const el of elements) {
    if (
      el.type === "node" &&
      el.lat != null &&
      el.lon != null &&
      (el.tags?.junction === "roundabout" || el.tags?.junction === "circular")
    ) {
      addRound(`n${el.id}`, el.lat, el.lon);
    } else if (el.type === "way" && el.center && (el.tags?.highway === "roundabout" || el.tags?.highway === "circular")) {
      addRound(`w${el.id}`, el.center.lat, el.center.lon);
    } else if (el.type === "relation" && el.center && el.tags?.junction === "roundabout") {
      addRound(`r${el.id}`, el.center.lat, el.center.lon);
    }
  }

  // 2. Large crossings: a node shared by >= 4 distinct major roads.
  const MAJOR = /^(trunk|primary|secondary|tertiary|residential|unclassified|living_street)$/;
  const waysByNode = new Map<number, Set<number>>();
  for (const el of elements) {
    if (el.type !== "way" || !el.nodes?.length) continue;
    if (!MAJOR.test(el.tags?.highway ?? "")) continue;
    for (const nid of el.nodes) {
      const set = waysByNode.get(nid) ?? new Set<number>();
      set.add(el.id);
      waysByNode.set(nid, set);
    }
  }
  const nodeById = new Map<number, { lat: number; lon: number }>();
  for (const el of elements) {
    if (el.type === "node" && el.lat != null && el.lon != null) {
      nodeById.set(el.id, { lat: el.lat, lon: el.lon });
    }
  }

  const crossingSpots: Array<{ id: string; lat: number; lon: number; arms: number }> = [];
  for (const [nid, waySet] of waysByNode) {
    if (waySet.size < 4) continue;
    const node = nodeById.get(nid);
    if (!node) continue;
    if (roundSpots.some((rb) => haversineMeters(rb.lat, rb.lon, node.lat, node.lon) <= 40)) continue;
    if (crossingSpots.some((s) => haversineMeters(s.lat, s.lon, node.lat, node.lon) <= 22)) continue;
    crossingSpots.push({ id: `n${nid}`, lat: node.lat, lon: node.lon, arms: waySet.size });
  }

  return [
    ...roundSpots.map((r) => ({ id: r.id, kind: "roundabout" as const, arms: 0, lat: r.lat, lon: r.lon })),
    ...crossingSpots.map((c) => ({ id: c.id, kind: "crossing" as const, arms: c.arms, lat: c.lat, lon: c.lon })),
  ];
}

async function fetchOverpassTurnarounds(
  south: number,
  west: number,
  north: number,
  east: number,
  signal?: AbortSignal
): Promise<RawSpot[] | null> {
  const bbox = `${south.toFixed(4)},${west.toFixed(4)},${north.toFixed(4)},${east.toFixed(4)}`;
  const query = `[out:json][timeout:40];(way[highway~"^(trunk|primary|secondary|tertiary|residential|unclassified|living_street|circular|roundabout)$"](${bbox});node[junction~"^(roundabout|circular)$"](${bbox});relation[junction="roundabout"](${bbox}););(._;>;);out center;`;

  for (const url of OVERPASS_ENDPOINTS) {
    if (signal?.aborted) return null;
    try {
      const elements = await withOverpassSlot(async () => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, 20000);
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: new URLSearchParams({ data: query }).toString(),
            signal: controller.signal,
          });
          if (!res.ok) return null;
          const json = (await res.json()) as { elements?: OverpassElement[] };
          return Array.isArray(json.elements) ? json.elements : null;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        }
      }, signal);
      if (!elements) continue;
      return buildSpotsFromElements(elements);
    } catch {
      // Try next mirror
    }
  }
  return null;
}

export async function detectTurnaroundSpotsAlongRoute(
  coords: [number, number][],
  signal?: AbortSignal
): Promise<{ spots: TurnaroundSpot[]; count: number; source: string }> {
  if (!coords || coords.length < 2) {
    return { spots: [], count: 0, source: "none" };
  }

  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  for (const [lat, lon] of coords) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
  }
  const pad = 0.004;
  south -= pad;
  west -= pad;
  north += pad;
  east += pad;

  let spots: RawSpot[] = [];
  let source = "osm-walbrzych-local";

  if (insideWalbrzych(south, west, north, east)) {
    spots = LOCAL_WALBRZYCH_SPOTS.filter(
      (s) => s.lat >= south && s.lat <= north && s.lon >= west && s.lon <= east
    );
  } else {
    const bboxKey = CACHE_PREFIX + [south, west, north, east].map((v) => v.toFixed(2)).join(",");
    const cached = await idbGetKv<{ spots: RawSpot[]; fetchedAt: number }>(bboxKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      spots = cached.spots;
      source = "osm-overpass-cache";
    } else {
      const remote = await fetchOverpassTurnarounds(south, west, north, east, signal);
      if (remote) {
        spots = remote;
        source = "osm-overpass-live";
        void idbSetKv(bboxKey, { spots: remote, fetchedAt: Date.now() });
      }
    }
  }

  if (!spots.length) {
    return { spots: [], count: 0, source };
  }

  const cumMeters: number[] = [0];
  for (let i = 1; i < coords.length; i += 1) {
    cumMeters.push(
      cumMeters[i - 1] + haversineMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
    );
  }

  const MAX_DIST_METERS = 22;
  const degSlack = 0.0003;
  const hits: Array<TurnaroundSpot & { dist: number }> = [];

  for (const spot of spots) {
    if (spot.lat < south || spot.lat > north || spot.lon < west || spot.lon > east) continue;
    let bestDist = MAX_DIST_METERS + 0.01;
    let bestOffset = 0;
    for (let i = 1; i < coords.length; i += 1) {
      const a = coords[i - 1];
      const b = coords[i];
      const minLat = Math.min(a[0], b[0]) - degSlack;
      const maxLat = Math.max(a[0], b[0]) + degSlack;
      if (spot.lat < minLat || spot.lat > maxLat) continue;
      const minLon = Math.min(a[1], b[1]) - degSlack;
      const maxLon = Math.max(a[1], b[1]) + degSlack;
      if (spot.lon < minLon || spot.lon > maxLon) continue;

      const seg = pointToSegmentMeters(spot.lat, spot.lon, a[0], a[1], b[0], b[1]);
      if (seg.distance <= bestDist) {
        bestDist = seg.distance;
        bestOffset = cumMeters[i - 1] + (cumMeters[i] - cumMeters[i - 1]) * seg.t;
      }
    }
    if (bestDist <= MAX_DIST_METERS) {
      hits.push({
        id: spot.id,
        lat: spot.lat,
        lon: spot.lon,
        kind: spot.kind,
        arms: spot.arms,
        routeOffsetMeters: Math.round(bestOffset),
        dist: bestDist,
      });
    }
  }

  hits.sort((a, b) => a.dist - b.dist || a.routeOffsetMeters - b.routeOffsetMeters);

  const clustered: TurnaroundSpot[] = [];
  for (const hit of hits) {
    const duplicate = clustered.some(
      (existing) =>
        existing.id === hit.id ||
        (Math.abs(hit.routeOffsetMeters - existing.routeOffsetMeters) <= 120 &&
          haversineMeters(hit.lat, hit.lon, existing.lat, existing.lon) <= 100)
    );
    if (duplicate) continue;
    clustered.push({
      id: hit.id,
      lat: hit.lat,
      lon: hit.lon,
      kind: hit.kind,
      arms: hit.arms,
      routeOffsetMeters: hit.routeOffsetMeters,
    });
  }

  clustered.sort((a, b) => a.routeOffsetMeters - b.routeOffsetMeters);
  return { spots: clustered, count: clustered.length, source };
}
