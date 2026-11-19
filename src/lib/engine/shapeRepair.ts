/** Repair suspicious GTFS chords with road geometry. Unresolved gaps are not
 * drawn as straight lines: doing so would falsely suggest a road exists there. */

import { distanceCoords } from "../core/spatial";
import { LruTtlCache, runDeduped } from "../core/runtimeHub";
import { withRoutingSlot } from "../requests";
import { ROUTING_URL } from "../services";
import { idbGetKv, idbSetKv } from "./storage";

type LatLng = [number, number];

// Shorter gaps can also cut across bends; stop-only paths need every leg routed.
const HARD_GAP_M = 120;
const DEFAULT_BUDGET_MS = 15_000;
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
export function splitShapeAtGaps(path: LatLng[], minGapMeters = HARD_GAP_M): { runs: LatLng[][]; gaps: Array<[LatLng, LatLng]> } {
  if (path.length < 2) return { runs: path.length ? [path] : [], gaps: [] };
  // runs[k] ends at gaps[k][0] and runs[k+1] starts at gaps[k][1]. A run may be a
  // single point when two gaps are adjacent; it is kept so the alternation stays intact.
  const runs: LatLng[][] = [];
  const gaps: Array<[LatLng, LatLng]> = [];
  let current: LatLng[] = [path[0]];
  for (let i = 0; i < path.length - 1; i += 1) {
    const next = path[i + 1];
    const length = distanceCoords(path[i][0], path[i][1], next[0], next[1]);
    if (length >= minGapMeters) {
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
    // Failures (including timeouts) must be retryable immediately.
    if (result) {
      memory.set(key, result);
      void idbSetKv(key, { at: Date.now(), path: result });
    }
    return result;
  });
}

export interface RepairedShape {
  polylines: LatLng[][];
  gapsTotal: number;
  gapsRepaired: number;
}

/** Route every candidate, within a bounded preview time. Unresolved gaps stay open. */
export async function repairShapeGaps(
  path: LatLng[],
  signal?: AbortSignal,
  stopChain = false,
  budgetMs = DEFAULT_BUDGET_MS
): Promise<RepairedShape> {
  const { runs, gaps } = splitShapeAtGaps(path, stopChain ? 0 : HARD_GAP_M);
  if (!gaps.length) {
    return { polylines: path.length >= 2 ? [path] : [], gapsTotal: 0, gapsRepaired: 0 };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const fills = new Map<number, LatLng[]>();
  const jobs = gaps.map(async (gap, index) => {
    const fill = await routeGap(gap[0], gap[1], controller.signal);
    if (fill && !controller.signal.aborted) fills.set(index, fill);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(jobs),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  controller.abort();
  signal?.removeEventListener("abort", abort);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const polylines: LatLng[][] = [];
  let line = [...runs[0]];
  for (let i = 0; i < gaps.length; i += 1) {
    const fill = fills.get(i);
    if (fill) {
      line.push(...fill, ...runs[i + 1]);
    } else {
      if (line.length >= 2) polylines.push(line);
      line = [...runs[i + 1]];
    }
  }
  if (line.length >= 2) polylines.push(line);
  return { polylines, gapsTotal: gaps.length, gapsRepaired: fills.size };
}
