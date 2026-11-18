/**
 * Shared spatial, distance, bounding-box and route-corridor primitives.
 * Replaces duplicate Haversine, equirectangular, segment-projection and bbox
 * implementations across geo, GTFS, stops, signals, turnarounds and bridges.
 */

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

const EARTH_RADIUS_M = 6_371_000;
const DEG_TO_RAD = Math.PI / 180;
const LAT_METERS_PER_DEG = 110_540;
const LON_METERS_AT_EQUATOR = 111_320;

/** Exact spherical Haversine distance in meters between two WGS84 coordinates. */
export function distanceCoords(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  if (lat1 === lat2 && lon1 === lon2) return 0;
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const rLat1 = lat1 * DEG_TO_RAD;
  const rLat2 = lat2 * DEG_TO_RAD;
  const sinLat = Math.sin(dLat * 0.5);
  const sinLon = Math.sin(dLon * 0.5);
  const h =
    sinLat * sinLat + Math.cos(rLat1) * Math.cos(rLat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Tuple overload `[lat, lon]` used by routing and Leaflet helpers. */
export function haversine(
  a: readonly [number, number],
  b: readonly [number, number]
): number {
  return distanceCoords(a[0], a[1], b[0], b[1]);
}

/** Object overload `{ lat, lon }` with safe `Infinity` fallback when missing. */
export function distancePoints(
  a?: GeoPoint | null,
  b?: GeoPoint | null
): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return distanceCoords(a.lat, a.lon, b.lat, b.lon);
}

/** Perpendicular distance (m) and clamping factor `t` in [0, 1] from point P to segment AB. */
export function pointToSegmentMeters(
  pLat: number,
  pLon: number,
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): { distance: number; t: number } {
  const lonM = LON_METERS_AT_EQUATOR * Math.cos(pLat * DEG_TO_RAD);
  const px = (pLon - aLon) * lonM;
  const py = (pLat - aLat) * LAT_METERS_PER_DEG;
  const bx = (bLon - aLon) * lonM;
  const by = (bLat - aLat) * LAT_METERS_PER_DEG;
  const len2 = bx * bx + by * by;
  if (len2 <= 1e-6) return { distance: Math.hypot(px, py), t: 0 };
  const rawT = (px * bx + py * by) / len2;
  const t = rawT < 0 ? 0 : rawT > 1 ? 1 : rawT;
  return { distance: Math.hypot(px - bx * t, py - by * t), t };
}

/** Cumulative distance array `[0, d1, d1+d2, ...]` along a `[lat, lon]` polyline. */
export function cumulativeRouteMeters(
  coords: readonly [number, number][]
): number[] {
  const out = new Array<number>(coords.length);
  if (!coords.length) return out;
  out[0] = 0;
  for (let i = 1; i < coords.length; i += 1) {
    out[i] =
      out[i - 1] +
      distanceCoords(
        coords[i - 1][0],
        coords[i - 1][1],
        coords[i][0],
        coords[i][1]
      );
  }
  return out;
}

/** Total polyline length in meters. */
export function polylineLengthMeters(
  coords: readonly [number, number][]
): number {
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    total += distanceCoords(
      coords[i - 1][0],
      coords[i - 1][1],
      coords[i][0],
      coords[i][1]
    );
  }
  return total;
}

/** Bounding box of `[lat, lon]` coordinates with optional degree padding. */
export function computePaddedBounds(
  coords: readonly [number, number][],
  padDeg = 0
): GeoBounds | null {
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  let valid = 0;
  for (const [lat, lon] of coords) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    valid += 1;
  }
  if (!valid) return null;
  return {
    south: south - padDeg,
    west: west - padDeg,
    north: north + padDeg,
    east: east + padDeg,
  };
}

export function isInsideBounds(
  lat: number,
  lon: number,
  bounds: GeoBounds,
  marginDeg = 0
): boolean {
  return (
    lat >= bounds.south - marginDeg &&
    lat <= bounds.north + marginDeg &&
    lon >= bounds.west - marginDeg &&
    lon <= bounds.east + marginDeg
  );
}

export function isBoundsWithin(
  inner: GeoBounds,
  outer: GeoBounds,
  marginDeg = 0
): boolean {
  return (
    inner.south >= outer.south - marginDeg &&
    inner.west >= outer.west - marginDeg &&
    inner.north <= outer.north + marginDeg &&
    inner.east <= outer.east + marginDeg
  );
}

export function formatBbox(bounds: GeoBounds, decimals = 4): string {
  return `${bounds.south.toFixed(decimals)},${bounds.west.toFixed(decimals)},${bounds.north.toFixed(decimals)},${bounds.east.toFixed(decimals)}`;
}

export function coordKey(lat: number, lon: number, decimals = 5): string {
  return `${lat.toFixed(decimals)},${lon.toFixed(decimals)}`;
}

export interface CorridorHit {
  distance: number;
  offsetMeters: number;
}

/**
 * Spatial grid index over a route polyline. Answers point-to-route proximity
 * and route-offset queries in O(local segments) instead of scanning the entire polyline.
 */
export function createRouteCorridorIndex(
  coords: readonly [number, number][],
  maxSearchMeters = 200
) {
  if (coords.length < 2) {
    return {
      totalMeters: 0,
      bounds: null as GeoBounds | null,
      cumMeters: [] as number[],
      nearest: (_lat: number, _lon: number): CorridorHit | null => null,
    };
  }

  const padDeg = Math.max(0.0025, maxSearchMeters / LAT_METERS_PER_DEG + 0.0005);
  const bounds = computePaddedBounds(coords, padDeg)!;
  const cumMeters = cumulativeRouteMeters(coords);
  const totalMeters = cumMeters[cumMeters.length - 1] ?? 0;

  const cellDeg = Math.max(0.0025, (maxSearchMeters * 1.5) / LAT_METERS_PER_DEG);
  const buckets = new Map<string, number[]>();

  for (let i = 1; i < coords.length; i += 1) {
    const a = coords[i - 1];
    const b = coords[i];
    const minLatCell = Math.floor((Math.min(a[0], b[0]) - padDeg) / cellDeg);
    const maxLatCell = Math.floor((Math.max(a[0], b[0]) + padDeg) / cellDeg);
    const minLonCell = Math.floor((Math.min(a[1], b[1]) - padDeg) / cellDeg);
    const maxLonCell = Math.floor((Math.max(a[1], b[1]) + padDeg) / cellDeg);

    for (let la = minLatCell; la <= maxLatCell; la += 1) {
      for (let lo = minLonCell; lo <= maxLonCell; lo += 1) {
        const key = `${la}:${lo}`;
        const list = buckets.get(key);
        if (list) list.push(i);
        else buckets.set(key, [i]);
      }
    }
  }

  return {
    totalMeters,
    bounds,
    cumMeters,
    nearest(lat: number, lon: number): CorridorHit | null {
      if (!isInsideBounds(lat, lon, bounds)) return null;
      const cellKey = `${Math.floor(lat / cellDeg)}:${Math.floor(lon / cellDeg)}`;
      const candidateSegments = buckets.get(cellKey);
      if (!candidateSegments?.length) return null;

      let bestDistance = maxSearchMeters + 0.001;
      let bestOffset = 0;
      for (let idx = 0; idx < candidateSegments.length; idx += 1) {
        const segIdx = candidateSegments[idx];
        const a = coords[segIdx - 1];
        const b = coords[segIdx];
        const proj = pointToSegmentMeters(lat, lon, a[0], a[1], b[0], b[1]);
        if (proj.distance < bestDistance) {
          bestDistance = proj.distance;
          bestOffset =
            cumMeters[segIdx - 1] +
            (cumMeters[segIdx] - cumMeters[segIdx - 1]) * proj.t;
        }
      }
      if (bestDistance > maxSearchMeters) return null;
      return { distance: bestDistance, offsetMeters: bestOffset };
    },
  };
}
