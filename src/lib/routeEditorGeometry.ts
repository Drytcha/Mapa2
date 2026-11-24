/**
 * Pure geometry and OSRM road-snapping utilities for the Planner Line Route Editor.
 */

import { distanceCoords, pointToSegmentMeters } from "./core/spatial";
import { withRoutingSlot } from "./requests";
import { BUS_ROUTING_URL } from "./services";

export type LatLng = [number, number];

const COORD_PRECISION = 1e6;
const MIN_POINT_SPACING_M = 0.5;
const OSRM_CHUNK_SIZE = 20;

export function roundCoord(point: readonly [number, number]): LatLng {
  return [
    Math.round(point[0] * COORD_PRECISION) / COORD_PRECISION,
    Math.round(point[1] * COORD_PRECISION) / COORD_PRECISION,
  ];
}

export function isValidLatLng(point: unknown): point is LatLng {
  return (
    Array.isArray(point) &&
    point.length >= 2 &&
    typeof point[0] === "number" &&
    typeof point[1] === "number" &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1]) &&
    Math.abs(point[0]) <= 90 &&
    Math.abs(point[1]) <= 180
  );
}

/** Filters invalid coordinates, rounds to 6 decimals, and collapses duplicate adjacent points. */
export function sanitizePath(points: readonly (readonly [number, number])[]): LatLng[] {
  const out: LatLng[] = [];
  for (const raw of points) {
    if (!isValidLatLng(raw)) continue;
    const pt = roundCoord(raw);
    const prev = out[out.length - 1];
    if (prev && distanceCoords(prev[0], prev[1], pt[0], pt[1]) < MIN_POINT_SPACING_M) {
      continue;
    }
    out.push(pt);
  }
  return out;
}

/**
 * Douglas-Peucker simplification in real meters. Always keeps the first and last vertex.
 * Ideal for turning dense 400-point GTFS shapes into clean, draggable road-corner vertices.
 */
export function simplifyPath(
  points: readonly LatLng[],
  toleranceMeters = 8,
): LatLng[] {
  if (points.length <= 2 || toleranceMeters <= 0) {
    return points.map((pt) => roundCoord(pt));
  }

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end - start <= 1) continue;
    const a = points[start];
    const b = points[end];
    let maxDist = -1;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i += 1) {
      const { distance } = pointToSegmentMeters(
        points[i][0],
        points[i][1],
        a[0],
        a[1],
        b[0],
        b[1],
      );
      if (distance > maxDist) {
        maxDist = distance;
        maxIndex = i;
      }
    }
    if (maxDist > toleranceMeters && maxIndex > start && maxIndex < end) {
      keep[maxIndex] = 1;
      stack.push([start, maxIndex], [maxIndex, end]);
    }
  }

  const result: LatLng[] = [];
  for (let i = 0; i < points.length; i += 1) {
    if (keep[i]) result.push(roundCoord(points[i]));
  }
  return result;
}

/** Inserts a new vertex along the closest segment of `points`. */
export function insertVertexOnPath(
  points: readonly LatLng[],
  clickPoint: LatLng,
): { nextPoints: LatLng[]; insertedIndex: number } {
  const rounded = roundCoord(clickPoint);
  if (points.length === 0) {
    return { nextPoints: [rounded], insertedIndex: 0 };
  }
  if (points.length === 1) {
    return { nextPoints: [roundCoord(points[0]), rounded], insertedIndex: 1 };
  }

  let bestSeg = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length - 1; i += 1) {
    const { distance } = pointToSegmentMeters(
      rounded[0],
      rounded[1],
      points[i][0],
      points[i][1],
      points[i + 1][0],
      points[i + 1][1],
    );
    if (distance < bestDist) {
      bestDist = distance;
      bestSeg = i;
    }
  }

  const insertedIndex = bestSeg + 1;
  const nextPoints = [
    ...points.slice(0, insertedIndex),
    rounded,
    ...points.slice(insertedIndex),
  ];
  return { nextPoints, insertedIndex };
}

/** Moves a single vertex to `nextCoord`. */
export function moveVertexInPath(
  points: readonly LatLng[],
  index: number,
  nextCoord: LatLng,
): LatLng[] {
  if (index < 0 || index >= points.length) return [...points];
  const next = [...points];
  next[index] = roundCoord(nextCoord);
  return next;
}

/** Removes a vertex at `index`. */
export function removeVertexFromPath(
  points: readonly LatLng[],
  index: number,
  minPoints = 2,
): LatLng[] {
  if (points.length <= minPoints || index < 0 || index >= points.length) {
    return [...points];
  }
  return [...points.slice(0, index), ...points.slice(index + 1)];
}

export interface SelectionBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Returns sorted indices of all vertices located inside geographic `bounds`. */
export function findVerticesInBounds(
  points: readonly LatLng[],
  bounds: SelectionBounds,
): number[] {
  const s = Math.min(bounds.south, bounds.north);
  const n = Math.max(bounds.south, bounds.north);
  const w = Math.min(bounds.west, bounds.east);
  const e = Math.max(bounds.west, bounds.east);
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const [lat, lon] = points[i];
    if (lat >= s && lat <= n && lon >= w && lon <= e) {
      out.push(i);
    }
  }
  return out;
}

/**
 * Removes multiple vertex indices at once while preserving at least `minPoints` (default 2).
 * If removing every requested vertex would leave fewer than `minPoints`, endpoints (first/last)
 * are preserved first so the route remains valid.
 */
export function removeVerticesFromPath(
  points: readonly LatLng[],
  indices: Iterable<number>,
  minPoints = 2,
): { nextPoints: LatLng[]; removedCount: number } {
  const toRemove = new Set<number>();
  for (const idx of indices) {
    if (Number.isInteger(idx) && idx >= 0 && idx < points.length) {
      toRemove.add(idx);
    }
  }
  if (toRemove.size === 0 || points.length <= minPoints) {
    return { nextPoints: [...points], removedCount: 0 };
  }

  const maxRemovable = Math.max(0, points.length - minPoints);
  if (toRemove.size > maxRemovable) {
    // Preserve route endpoints first (start, then end), then earliest indices.
    if (toRemove.has(0) && toRemove.size > maxRemovable) {
      toRemove.delete(0);
    }
    if (toRemove.has(points.length - 1) && toRemove.size > maxRemovable) {
      toRemove.delete(points.length - 1);
    }
    if (toRemove.size > maxRemovable) {
      const sorted = [...toRemove].sort((a, b) => a - b);
      let excess = sorted.length - maxRemovable;
      for (let i = 0; i < sorted.length && excess > 0; i += 1) {
        toRemove.delete(sorted[i]);
        excess -= 1;
      }
    }
  }

  const nextPoints: LatLng[] = [];
  for (let i = 0; i < points.length; i += 1) {
    if (!toRemove.has(i)) nextPoints.push(points[i]);
  }
  return {
    nextPoints,
    removedCount: points.length - nextPoints.length,
  };
}

/** Finds the nearest vertex index on `points` to `target`. */
export function nearestVertexOnPath(
  points: readonly LatLng[],
  target: LatLng,
): { index: number; distanceMeters: number } {
  let bestIndex = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    const d = distanceCoords(points[i][0], points[i][1], target[0], target[1]);
    if (d < bestDist) {
      bestDist = d;
      bestIndex = i;
    }
  }
  return { index: bestIndex, distanceMeters: bestDist };
}

/**
 * Replaces the sub-path between indices `startIdx` and `endIdx` (inclusive) with `replacement`.
 * If `startIdx > endIdx`, the replacement is reversed automatically so route orientation stays intact.
 */
export function replacePathSegment(
  points: readonly LatLng[],
  startIdx: number,
  endIdx: number,
  replacement: readonly LatLng[],
): LatLng[] {
  if (
    startIdx < 0 ||
    endIdx < 0 ||
    startIdx >= points.length ||
    endIdx >= points.length ||
    startIdx === endIdx
  ) {
    return [...points];
  }
  const reversed = startIdx > endIdx;
  const lo = reversed ? endIdx : startIdx;
  const hi = reversed ? startIdx : endIdx;
  const middle = reversed ? [...replacement].reverse() : [...replacement];
  const merged = [
    ...points.slice(0, lo),
    ...(middle.length > 0 ? middle : [points[lo], points[hi]]),
    ...points.slice(hi + 1),
  ];
  return sanitizePath(merged);
}

/** Snaps the first and last vertex of `points` to the first and last stop coordinates. */
export function snapEndsToStops(
  points: readonly LatLng[],
  firstStop: { lat: number; lon: number } | null,
  lastStop: { lat: number; lon: number } | null,
): LatLng[] {
  if (points.length < 2) return [...points];
  const next = points.map((pt) => roundCoord(pt));
  if (firstStop && Number.isFinite(firstStop.lat) && Number.isFinite(firstStop.lon)) {
    const start: LatLng = roundCoord([firstStop.lat, firstStop.lon]);
    if (distanceCoords(next[0][0], next[0][1], start[0], start[1]) > 15) {
      next.unshift(start);
    } else {
      next[0] = start;
    }
  }
  if (lastStop && Number.isFinite(lastStop.lat) && Number.isFinite(lastStop.lon)) {
    const end: LatLng = roundCoord([lastStop.lat, lastStop.lon]);
    const tail = next[next.length - 1];
    if (distanceCoords(tail[0], tail[1], end[0], end[1]) > 15) {
      next.push(end);
    } else {
      next[next.length - 1] = end;
    }
  }
  return sanitizePath(next);
}

interface OsrmRouteJson {
  code?: string;
  routes?: Array<{
    distance?: number;
    geometry?: {
      coordinates?: [number, number][];
    };
  }>;
}

/**
 * Routes an ordered list of waypoints along real streets via OSRM.
 * Falls back cleanly to the input waypoints if OSRM is unavailable or cannot route a leg.
 */
export async function routeSegmentViaOsrm(
  waypoints: readonly LatLng[],
  signal?: AbortSignal,
): Promise<{ path: LatLng[]; snapped: boolean }> {
  const clean = sanitizePath(waypoints);
  if (clean.length < 2) return { path: clean, snapped: false };

  const coordsStr = clean.map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(";");
  const url = `${BUS_ROUTING_URL}/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=false&alternatives=false&continue_straight=true`;

  try {
    const routed = await withRoutingSlot(async () => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 12_000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return null;
        const data = (await res.json()) as OsrmRouteJson;
        const coords = data.routes?.[0]?.geometry?.coordinates;
        if (data.code !== "Ok" || !coords || coords.length < 2) return null;
        return sanitizePath(coords.map(([lon, lat]) => [lat, lon] as LatLng));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    }, signal);

    if (routed && routed.length >= 2) {
      return { path: routed, snapped: true };
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
  }
  return { path: clean, snapped: false };
}

/**
 * Builds a complete road-snapped polyline through all stops of a variant in chunks.
 * Guarantees a continuous polyline even if an individual chunk cannot be routed by OSRM.
 */
export async function routeThroughStopsViaOsrm(
  stops: ReadonlyArray<{ lat: number; lon: number }>,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<{ path: LatLng[]; snappedChunks: number; totalChunks: number }> {
  const coords = sanitizePath(stops.map((s) => [s.lat, s.lon] as LatLng));
  if (coords.length < 2) {
    return { path: coords, snappedChunks: 0, totalChunks: 0 };
  }

  const chunks: LatLng[][] = [];
  for (let i = 0; i < coords.length - 1; i += OSRM_CHUNK_SIZE - 1) {
    const slice = coords.slice(i, Math.min(coords.length, i + OSRM_CHUNK_SIZE));
    if (slice.length >= 2) chunks.push(slice);
  }

  const merged: LatLng[] = [];
  let snappedChunks = 0;
  for (let c = 0; c < chunks.length; c += 1) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const { path, snapped } = await routeSegmentViaOsrm(chunks[c], signal);
    if (snapped) snappedChunks += 1;
    if (merged.length === 0) {
      merged.push(...path);
    } else {
      merged.push(...path.slice(1));
    }
    onProgress?.(c + 1, chunks.length);
  }

  return {
    path: sanitizePath(merged),
    snappedChunks,
    totalChunks: chunks.length,
  };
}
