/**
 * The official Wałbrzych GTFS shapes are dense (median 18 m per point) but contain
 * long segments. Most of them are simply straight roads between two corners
 * (typical for simplified shapes), and a few are real holes where the geometry is
 * missing and the road curves. This module finds long segments and, where OSRM can
 * answer in time, replaces them with road geometry.
 *
 * Contract: the result is ALWAYS one continuous line per shape. A segment that
 * cannot be routed (OSRM offline, rate-limited, over the request budget or the
 * time budget) is crossed by its straight chord instead of being left open — a
 * course line must never look broken or dashed.
 */

import { distanceCoords } from "../core/spatial";
import { LruTtlCache, runDeduped } from "../core/runtimeHub";
import { withRoutingSlot } from "../requests";
import { ROUTING_URL } from "../services";
import { idbGetKv, idbSetKv } from "./storage";

type LatLng = [number, number];

/**
 * A segment at least this long is a candidate for road-geometry repair.
 *
 * Measured on the official feed (513 shapes, ~350k segments): the median segment
 * is 18 m and the 99th percentile is 168 m. An earlier "relative" rule (a segment
 * >= 120 m and 3x longer than its neighbours) flagged 2955 "gaps" in 483 of the 513
 * shapes, 56% of them shorter than 250 m. Routing them exhausted the per-preview
 * request budget and the rest were left open, so course lines looked broken.
 * Probing OSRM showed that ~90% of the remaining 250 m+ segments are straight road
 * (OSRM distance / chord = 1.00), which is why the chord is a safe fallback.
 */
const HARD_GAP_M = 250;
/** Wall-clock limit for road routing of one shape; late answers only warm the cache. */
const DEFAULT_BUDGET_MS = 6_000;
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

/** Splits `path` into runs at long segments. Runs and gaps alternate. */
export function splitShapeAtGaps(path: LatLng[]): { runs: LatLng[][]; gaps: Array<[LatLng, LatLng]> } {
  if (path.length < 2) return { runs: path.length ? [path] : [], gaps: [] };
  // runs[k] ends at gaps[k][0] and runs[k+1] starts at gaps[k][1]. A run may be a
  // single point when two gaps are adjacent; it is kept so the alternation stays intact.
  const runs: LatLng[][] = [];
  const gaps: Array<[LatLng, LatLng]> = [];
  let current: LatLng[] = [path[0]];
  for (let i = 0; i < path.length - 1; i += 1) {
    const next = path[i + 1];
    const length = distanceCoords(path[i][0], path[i][1], next[0], next[1]);
    if (length >= HARD_GAP_M) {
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
  /**
   * One continuous line per shape (empty for a degenerate shape). Long segments are
   * replaced by road geometry when OSRM answered in time, otherwise they stay as the
   * straight chord already present in the shape.
   */
  polylines: LatLng[][];
  gapsTotal: number;
  gapsRepaired: number;
}

/**
 * Improves long segments of a shape with road geometry. Routes the longest
 * segments first, at most `maxRouted` of them, and never waits longer than
 * `budgetMs`, so a preview appears quickly even when the routing server is slow.
 */
export async function repairShapeGaps(
  path: LatLng[],
  signal?: AbortSignal,
  maxRouted = 6,
  budgetMs = DEFAULT_BUDGET_MS
): Promise<RepairedShape> {
  const { runs, gaps } = splitShapeAtGaps(path);
  if (!gaps.length) {
    return { polylines: path.length >= 2 ? [path] : [], gapsTotal: 0, gapsRepaired: 0 };
  }

  const order = gaps
    .map((gap, index) => ({ gap, index, len: distanceCoords(gap[0][0], gap[0][1], gap[1][0], gap[1][1]) }))
    .sort((x, y) => y.len - x.len)
    .slice(0, maxRouted);

  const fills = new Map<number, LatLng[]>();
  const jobs = order.map(async ({ gap, index }) => {
    const fill = await routeGap(gap[0], gap[1], signal);
    if (fill) fills.set(index, fill);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(jobs),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  // Snapshot: answers that arrive after the budget must not change a drawn line.
  const done = new Map(fills);
  const line: LatLng[] = [];
  runs.forEach((run, k) => {
    line.push(...run);
    const fill = done.get(k);
    if (fill) line.push(...fill);
  });

  return {
    polylines: line.length >= 2 ? [line] : [],
    gapsTotal: gaps.length,
    gapsRepaired: done.size,
  };
}
