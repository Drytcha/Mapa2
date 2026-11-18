import walbrzychTurnaroundData from "@/data/walbrzych-turnarounds.json";
import { queryOverpass } from "@/lib/core/overpass";
import {
  computePaddedBounds,
  cumulativeRouteMeters,
  distanceCoords,
  formatBbox,
  isBoundsWithin,
  isInsideBounds,
  pointToSegmentMeters,
  type GeoBounds,
} from "@/lib/core/spatial";
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

const WALBRZYCH_BBOX: GeoBounds = {
  south: 50.685,
  west: 16.135,
  north: 50.885,
  east: 16.435,
};

const CACHE_TTL_MS = 7 * 24 * 3600_000;
const CACHE_PREFIX = "mapplaner.turnarounds.v1.";

const LOCAL_WALBRZYCH_SPOTS: RawSpot[] = (walbrzychTurnaroundData as Array<RawSpot>).filter(
  (el) =>
    el &&
    typeof el.lat === "number" &&
    typeof el.lon === "number" &&
    (el.kind === "roundabout" || el.kind === "crossing")
);

function buildSpotsFromElements(elements: OverpassElement[]): RawSpot[] {
  const roundSpots: Array<{ id: string; lat: number; lon: number }> = [];
  const addRound = (id: string, lat: number, lon: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (!roundSpots.some((s) => distanceCoords(s.lat, s.lon, lat, lon) <= 45)) {
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
    } else if (
      el.type === "way" &&
      el.center &&
      (el.tags?.highway === "roundabout" || el.tags?.highway === "circular")
    ) {
      addRound(`w${el.id}`, el.center.lat, el.center.lon);
    } else if (el.type === "relation" && el.center && el.tags?.junction === "roundabout") {
      addRound(`r${el.id}`, el.center.lat, el.center.lon);
    }
  }

  const MAJOR = /^(trunk|primary|secondary|tertiary|residential|unclassified|living_street)$/;
  const waysByNode = new Map<number, Set<number>>();
  for (const el of elements) {
    if (el.type !== "way" || !el.nodes?.length) continue;
    if (!MAJOR.test(el.tags?.highway ?? "")) continue;
    for (const nid of el.nodes) {
      let set = waysByNode.get(nid);
      if (!set) {
        set = new Set<number>();
        waysByNode.set(nid, set);
      }
      set.add(el.id);
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
    if (roundSpots.some((rb) => distanceCoords(rb.lat, rb.lon, node.lat, node.lon) <= 40)) {
      continue;
    }
    if (crossingSpots.some((s) => distanceCoords(s.lat, s.lon, node.lat, node.lon) <= 22)) {
      continue;
    }
    crossingSpots.push({ id: `n${nid}`, lat: node.lat, lon: node.lon, arms: waySet.size });
  }

  return [
    ...roundSpots.map((r) => ({
      id: r.id,
      kind: "roundabout" as const,
      arms: 0,
      lat: r.lat,
      lon: r.lon,
    })),
    ...crossingSpots.map((c) => ({
      id: c.id,
      kind: "crossing" as const,
      arms: c.arms,
      lat: c.lat,
      lon: c.lon,
    })),
  ];
}

async function fetchOverpassTurnarounds(
  bounds: GeoBounds,
  signal?: AbortSignal
): Promise<RawSpot[] | null> {
  const bbox = formatBbox(bounds, 4);
  const query = `[out:json][timeout:40];(way[highway~"^(trunk|primary|secondary|tertiary|residential|unclassified|living_street|circular|roundabout)$"](${bbox});node[junction~"^(roundabout|circular)$"](${bbox});relation[junction="roundabout"](${bbox}););(._;>;);out center;`;
  const { elements } = await queryOverpass<OverpassElement>(query, {
    signal,
    timeoutMs: 20_000,
  });
  return elements ? buildSpotsFromElements(elements) : null;
}

export async function detectTurnaroundSpotsAlongRoute(
  coords: [number, number][],
  signal?: AbortSignal
): Promise<{ spots: TurnaroundSpot[]; count: number; source: string }> {
  if (!coords || coords.length < 2) {
    return { spots: [], count: 0, source: "none" };
  }

  const bounds = computePaddedBounds(coords, 0.004);
  if (!bounds) return { spots: [], count: 0, source: "none" };

  let spots: RawSpot[] = [];
  let source = "osm-walbrzych-local";

  if (isBoundsWithin(bounds, WALBRZYCH_BBOX, 0.005)) {
    spots = LOCAL_WALBRZYCH_SPOTS.filter((s) => isInsideBounds(s.lat, s.lon, bounds));
  } else {
    const bboxKey = CACHE_PREFIX + formatBbox(bounds, 2);
    const cached = await idbGetKv<{ spots: RawSpot[]; fetchedAt: number }>(bboxKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      spots = cached.spots;
      source = "osm-overpass-cache";
    } else {
      const remote = await fetchOverpassTurnarounds(bounds, signal);
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

  const cumMeters = cumulativeRouteMeters(coords);
  const MAX_DIST_METERS = 22;
  const degSlack = 0.0003;
  const hits: Array<TurnaroundSpot & { dist: number }> = [];

  for (const spot of spots) {
    if (!isInsideBounds(spot.lat, spot.lon, bounds)) continue;
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
          distanceCoords(hit.lat, hit.lon, existing.lat, existing.lon) <= 100)
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
