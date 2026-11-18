import walbrzychSignalsData from "@/data/walbrzych-signals.json";
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
import { getCachedTrafficSignals, setCachedTrafficSignals } from "./storage";

export interface RawSignalNode {
  id: string;
  lat: number;
  lon: number;
}

export interface DetectedSignalIntersection {
  id: string;
  lat: number;
  lon: number;
  routeOffsetMeters: number;
}

const WALBRZYCH_BBOX: GeoBounds = {
  south: 50.69,
  west: 16.14,
  north: 50.88,
  east: 16.43,
};

const CACHE_TTL_MS = 7 * 24 * 3600_000;

const LOCAL_WALBRZYCH_SIGNALS: RawSignalNode[] = (
  walbrzychSignalsData as Array<{ id?: number | string; lat?: number; lon?: number }>
)
  .filter((el) => typeof el.lat === "number" && typeof el.lon === "number")
  .map((el) => ({
    id: String(el.id ?? `${el.lat},${el.lon}`),
    lat: el.lat!,
    lon: el.lon!,
  }));

async function fetchOverpassSignals(
  bounds: GeoBounds,
  signal?: AbortSignal
): Promise<RawSignalNode[]> {
  const query = `[out:json][timeout:10];node["highway"="traffic_signals"](${formatBbox(bounds, 4)});out body;`;
  const { elements } = await queryOverpass<{ id: number; lat?: number; lon?: number }>(query, {
    signal,
    timeoutMs: 9_000,
  });
  if (!elements) return [];
  return elements
    .filter((e) => typeof e.lat === "number" && typeof e.lon === "number")
    .map((e) => ({ id: String(e.id), lat: e.lat!, lon: e.lon! }));
}

export async function detectTrafficSignalsAlongRoute(
  coords: [number, number][],
  signal?: AbortSignal
): Promise<{
  intersections: DetectedSignalIntersection[];
  count: number;
  source: string;
}> {
  if (!coords || coords.length < 2) {
    return { intersections: [], count: 0, source: "none" };
  }

  const bounds = computePaddedBounds(coords, 0.004);
  if (!bounds) return { intersections: [], count: 0, source: "none" };

  let nodes: RawSignalNode[] = [];
  let source = "osm-walbrzych-local";

  if (isBoundsWithin(bounds, WALBRZYCH_BBOX)) {
    nodes = LOCAL_WALBRZYCH_SIGNALS.filter((n) => isInsideBounds(n.lat, n.lon, bounds));
  } else {
    const bboxKey = formatBbox(bounds, 2);
    const cached = await getCachedTrafficSignals(bboxKey);

    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      nodes = cached.signals;
      source = "osm-overpass-cache";
    } else {
      const remote = await fetchOverpassSignals(bounds, signal);
      const localOverlap = LOCAL_WALBRZYCH_SIGNALS.filter((n) =>
        isInsideBounds(n.lat, n.lon, bounds)
      );
      const merged = new Map<string, RawSignalNode>();
      for (const n of [...localOverlap, ...remote]) merged.set(n.id, n);
      nodes = Array.from(merged.values());
      source = remote.length > 0 ? "osm-overpass-live" : "osm-walbrzych-local";
      if (remote.length > 0) {
        void setCachedTrafficSignals({ bboxKey, signals: nodes, fetchedAt: Date.now() });
      }
    }
  }

  if (!nodes.length) {
    return { intersections: [], count: 0, source };
  }

  const cumMeters = cumulativeRouteMeters(coords);

  // Pre-group raw traffic signal nodes into physical intersections (single-linkage 70 m).
  const clusterByNodeIndex = new Int32Array(nodes.length);
  let nextClusterId = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    if (clusterByNodeIndex[i] !== 0) continue;
    nextClusterId += 1;
    clusterByNodeIndex[i] = nextClusterId;
    const queue = [i];
    let head = 0;
    while (head < queue.length) {
      const curNode = nodes[queue[head++]];
      for (let j = 0; j < nodes.length; j += 1) {
        if (clusterByNodeIndex[j] !== 0) continue;
        if (distanceCoords(curNode.lat, curNode.lon, nodes[j].lat, nodes[j].lon) <= 70) {
          clusterByNodeIndex[j] = nextClusterId;
          queue.push(j);
        }
      }
    }
  }

  const MAX_DIST_METERS = 15;
  const degSlack = 0.0003;
  interface RawSignalHit extends DetectedSignalIntersection {
    dist: number;
    clusterId: number;
  }
  const hits: RawSignalHit[] = [];

  for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx += 1) {
    const node = nodes[nodeIdx];
    if (!isInsideBounds(node.lat, node.lon, bounds)) continue;

    const passes: Array<{ dist: number; offset: number }> = [];
    for (let i = 1; i < coords.length; i += 1) {
      const a = coords[i - 1];
      const b = coords[i];
      const minLat = (a[0] < b[0] ? a[0] : b[0]) - degSlack;
      const maxLat = (a[0] > b[0] ? a[0] : b[0]) + degSlack;
      if (node.lat < minLat || node.lat > maxLat) continue;
      const minLon = (a[1] < b[1] ? a[1] : b[1]) - degSlack;
      const maxLon = (a[1] > b[1] ? a[1] : b[1]) + degSlack;
      if (node.lon < minLon || node.lon > maxLon) continue;

      const seg = pointToSegmentMeters(node.lat, node.lon, a[0], a[1], b[0], b[1]);
      if (seg.distance > MAX_DIST_METERS) continue;

      const offset = cumMeters[i - 1] + (cumMeters[i] - cumMeters[i - 1]) * seg.t;
      const samePass = passes.find((p) => Math.abs(offset - p.offset) <= 150);
      if (samePass) {
        if (seg.distance < samePass.dist) {
          samePass.dist = seg.distance;
          samePass.offset = offset;
        }
      } else {
        passes.push({ dist: seg.distance, offset });
      }
    }

    for (const pass of passes) {
      hits.push({
        id: node.id,
        lat: node.lat,
        lon: node.lon,
        routeOffsetMeters: Math.round(pass.offset),
        dist: pass.dist,
        clusterId: clusterByNodeIndex[nodeIdx],
      });
    }
  }

  hits.sort((a, b) => a.dist - b.dist || a.routeOffsetMeters - b.routeOffsetMeters);

  const clustered: RawSignalHit[] = [];
  for (const hit of hits) {
    const duplicate = clustered.some(
      (existing) =>
        (existing.clusterId === hit.clusterId &&
          Math.abs(hit.routeOffsetMeters - existing.routeOffsetMeters) <= 150) ||
        (Math.abs(hit.routeOffsetMeters - existing.routeOffsetMeters) <= 115 &&
          distanceCoords(hit.lat, hit.lon, existing.lat, existing.lon) <= 105)
    );
    if (!duplicate) clustered.push(hit);
  }

  clustered.sort((a, b) => a.routeOffsetMeters - b.routeOffsetMeters);
  const intersections: DetectedSignalIntersection[] = clustered.map(
    ({ id, lat, lon, routeOffsetMeters }) => ({
      id,
      lat,
      lon,
      routeOffsetMeters,
    })
  );

  return {
    intersections,
    count: intersections.length,
    source,
  };
}
