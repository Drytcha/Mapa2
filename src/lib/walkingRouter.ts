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
const MAX_CACHE_SIZE = 600;
const REQUEST_GAP_MS = 1100;
const cache = new Map<string, { at: number; route: WalkingRoute | null }>();
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

export const walkingKey = (from: WalkingPoint, to: WalkingPoint) =>
  `${from.lat.toFixed(6)},${from.lon.toFixed(6)}>${to.lat.toFixed(6)},${to.lon.toFixed(6)}`;

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

interface RouteResponse {
  code: string;
  routes?: Array<{
    distance: number;
    duration: number;
    geometry: { type: string; coordinates: number[][] };
  }>;
  waypoints?: Array<{ distance: number; location: number[] }>;
}

function remember(key: string, route: WalkingRoute | null) {
  cache.delete(key);
  cache.set(key, { at: Date.now(), route });
  if (cache.size > MAX_CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return route;
}

/** Only pedestrian-network paths are accepted. No car-profile or straight-line fallback. */
export async function getWalkingRoute(
  from: WalkingPoint,
  to: WalkingPoint,
  signal?: AbortSignal,
): Promise<WalkingRoute | null> {
  signal?.throwIfAborted();
  if (![from.lat, from.lon, to.lat, to.lon].every(Number.isFinite)) {
    throw new Error("Nieprawidłowe współrzędne trasy pieszej.");
  }
  if (from.lat === to.lat && from.lon === to.lon) {
    return { meters: 0, seconds: 0, path: [[from.lat, from.lon]] };
  }
  const key = walkingKey(from, to);
  const job = queue.then(async () => {
    signal?.throwIfAborted();
    const saved = cache.get(key);
    if (saved && Date.now() - saved.at < CACHE_TTL_MS) return saved.route;

    // FOSSGIS permits at most one request per second, including aborted searches.
    await wait(REQUEST_GAP_MS - (Date.now() - lastRequestAt), signal);
    signal?.throwIfAborted();
    const coordinates = [from, to]
      .map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`)
      .join(";");
    const url = `${WALKING_ROUTING_URL}/route/v1/foot/${coordinates}?overview=full&geometries=geojson&steps=false&alternatives=false&radiuses=${MAX_SNAP_METERS};${MAX_SNAP_METERS}`;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), 12_000);
    lastRequestAt = Date.now();
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status === 429) {
        lastRequestAt = Date.now() + 30_000;
        throw new Error(
          "Serwer tras pieszych jest zajęty. Spróbuj ponownie za chwilę.",
        );
      }
      if (!response.ok && response.status !== 400)
        throw new Error("Routing unavailable");
      const data = (await response.json()) as RouteResponse;
      if (data.code === "NoRoute" || data.code === "NoSegment")
        return remember(key, null);
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
          (p) => !Number.isFinite(p.distance) || p.distance > MAX_SNAP_METERS,
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
        0,
      );
      // Count short endpoint access, but never draw invented connectors through terrain.
      const meters = Math.ceil(route.distance + accessMeters);
      const seconds = Math.ceil(
        Math.max(route.duration, route.distance / 1.3) + accessMeters / 1.3,
      );
      return remember(key, { meters, seconds, path });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.message.startsWith("Serwer tras"))
        throw error;
      throw new Error(
        "Nie udało się sprawdzić dojść po drogach i ścieżkach. Spróbuj ponownie. Nie zastępujemy ich odcinkiem w linii prostej.",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  });
  queue = job.catch(() => undefined);
  return job;
}
