/**
 * The official Wałbrzych GTFS has dense shapes (~20 m per point) with occasional
 * gaps of 600–850 m where the geometry is simply missing. Drawn as-is, those gaps
 * become straight lines cutting across terrain. This module splits a shape at
 * such gaps and fills each one with road geometry from OSRM. When routing is
 * unavailable the gap is left open rather than drawn as a false straight line.
 */

import { distanceCoords } from "../core/spatial";
import { LruTtlCache, runDeduped } from "../core/runtimeHub";
import { withRoutingSlot } from "../requests";
import { ROUTING_URL } from "../services";
import { idbGetKv, idbSetKv } from "./storage";

type LatLng = [number, number];

/** A gap longer than this is never genuine road geometry in this feed. */
const HARD_GAP_M = 250;
/** Relative test: a segment much longer than its neighbours is a data gap. */
const RELATIVE_GAP_FACTOR = 3;
const MIN_RELATIVE_GAP_M = 120;
const CACHE_PREFIX = "shapeGap.v1.";
const CACHE_TTL_MS = 30 * 24 * 3600_000;
const memory = new LruTtlCache<string, LatLng[] | null>(400, CACHE_TTL_MS);

interface OsrmGeometryResponse {
  code: string;
  routes?: Array<{ distance: number; geometry: { coordinates: [number, number][] } }>;
}

function gapKey(a: LatLng, b: LatLng): string {
  return `${CACHE_PREFIX}${a[0].toFixed(5)},${a[1].toFixed(5)}>${b[0].toFixed(5)},${b[1].toFixed(5)}`;
}

/** Splits `path` into continuous runs wherever the geometry is missing. */
export function splitShapeAtGaps(path: LatLng[]): { runs: LatLng[][]; gaps: Array<[LatLng, LatLng]> } {
  if (path.length < 2) return { runs: path.length ? [path] : [], gaps: [] };
  const lengths: number[] = [];
  for (let i = 1; i < path.length; i += 1) {
    lengths.push(distanceCoords(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]));
  }
  const isGap = (i: number): boolean => {
    const d = lengths[i];
    if (d >= HARD_GAP_M) return true;
    if (d < MIN_RELATIVE_GAP_M) return false;
    const around = [lengths[i - 2], lengths[i - 1], lengths[i + 1], lengths[i + 2]].filter(
      (v): v is number => typeof v === "number"
    );
    if (!around.length) return false;
    const median = [...around].sort((x, y) => x - y)[Math.floor(around.length / 2)];
    return d > median * RELATIVE_GAP_FACTOR;
  };
  // Runs and gaps alternate: runs[k] ends at gaps[k][0] and runs[k+1] starts at gaps[k][1].
  // A run may be a single point when two gaps are adjacent; it is kept so the
  // alternation stays intact and is dropped only when drawing.
  const runs: LatLng[][] = [];
  const gaps: Array<[LatLng, LatLng]> = [];
  let current: LatLng[] = [path[0]];
  for (let i = 0; i < lengths.length; i += 1) {
    const next = path[i + 1];
    if (isGap(i)) {
      runs.push(current);
      gaps.push([path[i], next]);
      current = [next];
    } else {
      current.push(next);
    }
  }
  runs.push(current);
  return { runs, gaps };
}

async function routeGap(a: LatLng, b: LatLng, signal?: AbortSignal): Promise<LatLng[] | null> {
  const key = gapKey(a, b);
  const cached = memory.get(key);
  if (cached !== undefined) return cached;
  const stored = await idbGetKv<{ at: number; path: LatLng[] | null }>(key);
  if (stored && Date.now() - stored.at < CACHE_TTL_MS) {
    memory.set(key, stored.path);
    return stored.path;
  }

  return runDeduped(key, async () => {
    const straight = distanceCoords(a[0], a[1], b[0], b[1]);
    const url =
      `${ROUTING_URL}/route/v1/driving/${a[1].toFixed(6)},${a[0].toFixed(6)};${b[1].toFixed(6)},${b[0].toFixed(6)}` +
      `?overview=full&geometries=geojson&steps=false&alternatives=false&radiuses=60;60`;
    let result: LatLng[] | null = null;
    try {
      result = await withRoutingSlot(async () => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, 9_000);
        try {
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) return null;
          const data = (await res.json()) as OsrmGeometryResponse;
          const route = data.routes?.[0];
          if (data.code !== "Ok" || !route || route.geometry.coordinates.length < 2) return null;
          // A detour several times longer than the gap means OSRM snapped to a wrong road.
          if (route.distance > Math.max(straight * 2.6, straight + 900)) return null;
          return route.geometry.coordinates.map(([lon, lat]) => [lat, lon] as LatLng);
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        }
      }, signal);
    } catch {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      result = null;
    }
    memory.set(key, result);
    // Only cache successes persistently; a transient failure should be retried later.
    if (result) void idbSetKv(key, { at: Date.now(), path: result });
    return result;
  });
}

export interface RepairedShape {
  /** Continuous drawable runs — gaps that could not be routed stay open. */
  polylines: LatLng[][];
  gapsTotal: number;
  gapsRepaired: number;
}

/**
 * Returns the shape split at data gaps, with each gap bridged by road geometry
 * when OSRM can provide it. Limits routing to a handful of gaps per shape so a
 * single preview never issues a request storm.
 */
export async function repairShapeGaps(
  path: LatLng[],
  signal?: AbortSignal,
  maxRouted = 6
): Promise<RepairedShape> {
  const { runs, gaps } = splitShapeAtGaps(path);
  if (!gaps.length) return { polylines: runs, gapsTotal: 0, gapsRepaired: 0 };

  // Route the longest gaps first — they are the most visible on the map.
  const order = gaps
    .map((gap, index) => ({ gap, index, len: distanceCoords(gap[0][0], gap[0][1], gap[1][0], gap[1][1]) }))
    .sort((x, y) => y.len - x.len)
    .slice(0, maxRouted);
  const fills = new Map<number, LatLng[]>();
  await Promise.all(
    order.map(async ({ gap, index }) => {
      const fill = await routeGap(gap[0], gap[1], signal);
      if (fill) fills.set(index, fill);
    })
  );

  // Stitch runs back together across repaired gaps; keep unrepaired ones split.
  const polylines: LatLng[][] = [];
  let current: LatLng[] = [];
  const flush = () => {
    if (current.length >= 2) polylines.push(current);
    current = [];
  };
  runs.forEach((run, k) => {
    current.push(...run);
    if (k >= gaps.length) return;
    const fill = fills.get(k);
    if (fill) current.push(...fill);
    else flush();
  });
  flush();

  return { polylines, gapsTotal: gaps.length, gapsRepaired: fills.size };
}
