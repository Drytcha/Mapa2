import walbrzychSignalsData from "@/data/walbrzych-signals.json";
import { withOverpassSlot } from "@/lib/requests";
import { OVERPASS_URL } from "@/lib/services";
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

const WALBRZYCH_BBOX = {
  south: 50.69,
  west: 16.14,
  north: 50.88,
  east: 16.43,
};

const OVERPASS_ENDPOINTS = [
  OVERPASS_URL,
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
].filter((url, idx, list) => list.indexOf(url) === idx);

const LOCAL_WALBRZYCH_SIGNALS: RawSignalNode[] = (
  walbrzychSignalsData as Array<{ id?: number | string; lat?: number; lon?: number }>
)
  .filter((el) => typeof el.lat === "number" && typeof el.lon === "number")
  .map((el) => ({
    id: String(el.id ?? `${el.lat},${el.lon}`),
    lat: el.lat!,
    lon: el.lon!,
  }));

function insideWalbrzych(south: number, west: number, north: number, east: number): boolean {
  return (
    south >= WALBRZYCH_BBOX.south &&
    west >= WALBRZYCH_BBOX.west &&
    north <= WALBRZYCH_BBOX.north &&
    east <= WALBRZYCH_BBOX.east
  );
}

async function fetchOverpassSignals(
  south: number,
  west: number,
  north: number,
  east: number,
  signal?: AbortSignal
): Promise<RawSignalNode[]> {
  const query = `[out:json][timeout:10];node["highway"="traffic_signals"](${south.toFixed(4)},${west.toFixed(4)},${north.toFixed(4)},${east.toFixed(4)});out body;`;
  for (const url of OVERPASS_ENDPOINTS) {
    if (signal?.aborted) break;
    try {
      const nodes = await withOverpassSlot(async () => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, 9000);
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Accept: "application/json",
            },
            body: new URLSearchParams({ data: query }).toString(),
            signal: controller.signal,
          });
          if (!res.ok) return null;
          const json = (await res.json()) as {
            elements?: Array<{ id: number; lat?: number; lon?: number }>;
          };
          if (!Array.isArray(json.elements)) return null;
          return json.elements
            .filter((e) => typeof e.lat === "number" && typeof e.lon === "number")
            .map((e) => ({ id: String(e.id), lat: e.lat!, lon: e.lon! }));
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        }
      }, signal);
      if (nodes) return nodes;
    } catch {
      // Try next mirror
    }
  }
  return [];
}

function metersPerDeg(lat: number): { latM: number; lonM: number } {
  return {
    latM: 110540,
    lonM: 111320 * Math.cos((lat * Math.PI) / 180),
  };
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const { latM, lonM } = metersPerDeg((lat1 + lat2) / 2);
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
  const { latM, lonM } = metersPerDeg(pLat);
  const px = (pLon - aLon) * lonM;
  const py = (pLat - aLat) * latM;
  const bx = (bLon - aLon) * lonM;
  const by = (bLat - aLat) * latM;
  const len2 = bx * bx + by * by;
  if (len2 <= 1e-6) return { distance: Math.hypot(px, py), t: 0 };
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return { distance: Math.hypot(px - bx * t, py - by * t), t };
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

  let nodes: RawSignalNode[] = [];
  let source = "osm-walbrzych-local";

  if (insideWalbrzych(south, west, north, east)) {
    nodes = LOCAL_WALBRZYCH_SIGNALS.filter(
      (n) => n.lat >= south && n.lat <= north && n.lon >= west && n.lon <= east
    );
  } else {
    const bboxKey = [south, west, north, east].map((v) => v.toFixed(2)).join(",");
    const cached = await getCachedTrafficSignals(bboxKey);

    if (cached && Date.now() - cached.fetchedAt < 7 * 24 * 3600 * 1000) {
      nodes = cached.signals;
      source = "osm-overpass-cache";
    } else {
      const remote = await fetchOverpassSignals(south, west, north, east, signal);
      const localOverlap = LOCAL_WALBRZYCH_SIGNALS.filter(
        (n) => n.lat >= south && n.lat <= north && n.lon >= west && n.lon <= east
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

  const cumMeters: number[] = [0];
  for (let i = 1; i < coords.length; i += 1) {
    cumMeters.push(
      cumMeters[i - 1] +
        haversineMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
    );
  }

  // Pre-group raw traffic signal nodes into physical intersections (single-linkage 70 m).
  // Large multi-arm junctions in Wałbrzych span up to ~104 m across stop lines, while distinct
  // intersections are >= 115 m apart.
  const clusterByNodeIndex = new Int32Array(nodes.length);
  let nextClusterId = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    if (clusterByNodeIndex[i] !== 0) continue;
    nextClusterId += 1;
    clusterByNodeIndex[i] = nextClusterId;
    const queue = [i];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const curNode = nodes[cur];
      for (let j = 0; j < nodes.length; j += 1) {
        if (clusterByNodeIndex[j] !== 0) continue;
        if (haversineMeters(curNode.lat, curNode.lon, nodes[j].lat, nodes[j].lon) <= 70) {
          clusterByNodeIndex[j] = nextClusterId;
          queue.push(j);
        }
      }
    }
  }

  // Tight 15 m match prevents grabbing signals on perpendicular side roads or opposite approaches.
  const MAX_DIST_METERS = 15;
  const degSlack = 0.0003;
  interface RawSignalHit extends DetectedSignalIntersection {
    dist: number;
    clusterId: number;
  }
  const hits: RawSignalHit[] = [];

  for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx += 1) {
    const node = nodes[nodeIdx];
    if (node.lat < south || node.lat > north || node.lon < west || node.lon > east) continue;

    // Collect distinct passes near this node (supporting loops / bidirectional routes).
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

  // Sort by closest perpendicular distance to the route first so each intersection picks
  // the signal actually lying on the bus's road rather than a side-street node.
  hits.sort((a, b) => a.dist - b.dist || a.routeOffsetMeters - b.routeOffsetMeters);

  const clustered: RawSignalHit[] = [];
  for (const hit of hits) {
    const duplicate = clustered.some(
      (existing) =>
        (existing.clusterId === hit.clusterId &&
          Math.abs(hit.routeOffsetMeters - existing.routeOffsetMeters) <= 150) ||
        (Math.abs(hit.routeOffsetMeters - existing.routeOffsetMeters) <= 115 &&
          haversineMeters(hit.lat, hit.lon, existing.lat, existing.lon) <= 105)
    );
    if (duplicate) continue;
    clustered.push(hit);
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
