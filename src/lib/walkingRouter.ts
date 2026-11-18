import { LruTtlCache, runDeduped } from "./core/runtimeHub";
import { withWalkingSlot } from "./requests";
import { WALKING_ROUTING_URL } from "./services";

export interface WalkingPoint {
  lat: number;
  lon: number;
}

export interface WalkingRoute {
  meters: number;
  seconds: number;
  path: [number, number][];
}

const MAX_SNAP_METERS = 25;
const CACHE_TTL_MS = 24 * 60 * 60_000;
const cache = new LruTtlCache<string, { route: WalkingRoute | null }>(600, CACHE_TTL_MS);

export const walkingKey = (from: WalkingPoint, to: WalkingPoint) =>
  `${from.lat.toFixed(6)},${from.lon.toFixed(6)}>${to.lat.toFixed(6)},${to.lon.toFixed(6)}`;

interface RouteResponse {
  code: string;
  routes?: Array<{
    distance: number;
    duration: number;
    geometry: { type: string; coordinates: number[][] };
  }>;
  waypoints?: Array<{ distance: number; location: number[] }>;
}

function remember(key: string, route: WalkingRoute | null): WalkingRoute | null {
  cache.set(key, { route });
  return route;
}

async function fetchWalkingRouteNetwork(
  key: string,
  from: WalkingPoint,
  to: WalkingPoint,
  signal?: AbortSignal
): Promise<WalkingRoute | null> {
  return withWalkingSlot(async () => {
    const saved = cache.get(key);
    if (saved !== undefined) return saved.route;

    const coordinates = [from, to]
      .map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`)
      .join(";");
    const url = `${WALKING_ROUTING_URL}/route/v1/foot/${coordinates}?overview=full&geometries=geojson&steps=false&alternatives=false&radiuses=${MAX_SNAP_METERS};${MAX_SNAP_METERS}`;

    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), 12_000);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status === 429) {
        withWalkingSlot.cooldown(30_000);
        throw new Error(
          "Serwer tras pieszych jest zajęty. Spróbuj ponownie za chwilę."
        );
      }
      if (!response.ok && response.status !== 400) {
        throw new Error("Routing unavailable");
      }
      const data = (await response.json()) as RouteResponse;
      if (data.code === "NoRoute" || data.code === "NoSegment") {
        return remember(key, null);
      }
      const route = data.routes?.[0];
      if (
        data.code !== "Ok" ||
        !route ||
        !Number.isFinite(route.distance) ||
        !Number.isFinite(route.duration) ||
        route.distance < 0 ||
        route.duration < 0 ||
        route.geometry?.type !== "LineString" ||
        route.geometry.coordinates.length < 2 ||
        data.waypoints?.length !== 2
      ) {
        throw new Error("Invalid walking route");
      }
      if (
        data.waypoints.some(
          (p) => !Number.isFinite(p.distance) || p.distance > MAX_SNAP_METERS
        )
      ) {
        return remember(key, null);
      }
      const path: [number, number][] = route.geometry.coordinates.map((p) => {
        if (
          p.length < 2 ||
          !p.every(Number.isFinite) ||
          Math.abs(p[1]) > 90 ||
          Math.abs(p[0]) > 180
        ) {
          throw new Error("Invalid walking geometry");
        }
        return [p[1], p[0]];
      });
      const accessMeters = data.waypoints.reduce(
        (sum, p) => sum + Math.max(0, p.distance),
        0
      );
      const meters = Math.ceil(route.distance + accessMeters);
      const seconds = Math.ceil(
        Math.max(route.duration, route.distance / 1.3) + accessMeters / 1.3
      );
      return remember(key, { meters, seconds, path });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.message.startsWith("Serwer tras")) {
        throw error;
      }
      throw new Error(
        "Nie udało się sprawdzić dojść po drogach i ścieżkach. Spróbuj ponownie. Nie zastępujemy ich odcinkiem w linii prostej."
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }, signal);
}

/** Only pedestrian-network paths are accepted. Cached hits resolve immediately in O(1). */
export async function getWalkingRoute(
  from: WalkingPoint,
  to: WalkingPoint,
  signal?: AbortSignal
): Promise<WalkingRoute | null> {
  signal?.throwIfAborted();
  if (![from.lat, from.lon, to.lat, to.lon].every(Number.isFinite)) {
    throw new Error("Nieprawidłowe współrzędne trasy pieszej.");
  }
  if (from.lat === to.lat && from.lon === to.lon) {
    return { meters: 0, seconds: 0, path: [[from.lat, from.lon]] };
  }
  const key = walkingKey(from, to);
  // Return cached pedestrian leg immediately without waiting behind in-flight network requests!
  const saved = cache.get(key);
  if (saved !== undefined) return saved.route;

  if (signal) {
    return fetchWalkingRouteNetwork(key, from, to, signal);
  }
  return runDeduped(`walk:${key}`, () => fetchWalkingRouteNetwork(key, from, to));
}
