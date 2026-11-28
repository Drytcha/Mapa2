import { distanceCoords } from "./core/spatial";
import type { LiveBusVehicle } from "./types";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const METERS_PER_LAT = 111_320;

/** Poniżej 0,8 m traktujemy zmianę jako szum postoju GPS — bez drgań markera. */
export const STATIONARY_CUTOFF_METERS = 0.8;
/** Powyżej 650 m (np. przeskok po utracie zasięgu lub zmiana kursu) — natychmiastowy snap. */
export const TELEPORT_CUTOFF_METERS = 650;
/** Minimalny krok ruchu potrzebny do wiarygodnego wyliczenia azymutu, gdy GPS nie podaje `bearing`. */
export const DERIVED_BEARING_MIN_METERS = 6;
/** Maksymalna odległość od geometrii kursu GTFS, przy której autobus podąża po łuku ulicy. */
export const ROUTE_SNAP_MAX_METERS = 45;
/** Domyślny czas płynnego przejścia między pakietami GPS (ok. 2,5–4 s w Wałbrzychu). */
export const DEFAULT_GLIDE_DURATION_MS = 3_100;
const MIN_GLIDE_DURATION_MS = 1_750;
const MAX_GLIDE_DURATION_MS = 4_900;
const STALE_PACKET_GAP_MS = 25_000;

export interface IndexedRoutePolyline {
  points: [number, number][];
  cumMeters: Float64Array;
  segBearings: Float32Array;
  totalMeters: number;
}

export interface PolylineProjection {
  lat: number;
  lon: number;
  alongMeters: number;
  distanceMeters: number;
  bearingDeg: number;
}

export interface BusInterpolatedSample {
  lat: number;
  lon: number;
  bearingDeg: number | null;
  progress: number;
  settled: boolean;
}

interface BusMotionTrack {
  vehicleId: string;
  tripId: string | null;
  lastRawLat: number;
  lastRawLon: number;
  lastPacketAtMs: number;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  fromBearing: number | null;
  toBearing: number | null;
  startedAtMs: number;
  durationMs: number;
  settled: boolean;
  curve: {
    poly: IndexedRoutePolyline;
    fromAlongM: number;
    toAlongM: number;
  } | null;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function normalizeBearingDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

export function shortestAngleDeltaDeg(fromDeg: number, toDeg: number): number {
  return ((((toDeg - fromDeg) % 360) + 540) % 360) - 180;
}

export function interpolateBearingDeg(
  fromDeg: number,
  toDeg: number,
  t: number,
): number {
  const clamped = clamp(t, 0, 1);
  return normalizeBearingDeg(
    fromDeg + shortestAngleDeltaDeg(fromDeg, toDeg) * clamped,
  );
}

export function computeBearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;
  const dLambda = (lon2 - lon1) * DEG_TO_RAD;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12) return 0;
  return normalizeBearingDeg(Math.atan2(y, x) * RAD_TO_DEG);
}

/**
 * Lekkie wygładzenie ruchu: 88% stałej prędkości liniowej (autobus w biegu nie
 * zatrzymuje się co 3 s) + 12% smoothstep łagodzącego mikro-zmiany prędkości.
 */
function glideEase(t: number): number {
  const x = clamp(t, 0, 1);
  const smooth = x * x * (3 - 2 * x);
  return 0.88 * x + 0.12 * smooth;
}

export function indexRoutePolyline(
  points: [number, number][],
): IndexedRoutePolyline | null {
  if (!points || points.length < 2) return null;
  const n = points.length;
  const cumMeters = new Float64Array(n);
  const segBearings = new Float32Array(n - 1);
  let total = 0;
  for (let i = 0; i < n - 1; i += 1) {
    const [lat1, lon1] = points[i];
    const [lat2, lon2] = points[i + 1];
    const segLen = distanceCoords(lat1, lon1, lat2, lon2);
    total += segLen;
    cumMeters[i + 1] = total;
    segBearings[i] =
      segLen > 0.05
        ? computeBearingDeg(lat1, lon1, lat2, lon2)
        : i > 0
          ? segBearings[i - 1]
          : 0;
  }
  if (total < 1) return null;
  return {
    points,
    cumMeters,
    segBearings,
    totalMeters: total,
  };
}

export function projectPointOntoPolyline(
  poly: IndexedRoutePolyline,
  lat: number,
  lon: number,
  hintAlongMeters?: number | null,
): PolylineProjection {
  const cosLat = Math.cos(lat * DEG_TO_RAD);
  const metersPerLon = METERS_PER_LAT * Math.max(0.2, cosLat);

  let bestScore = Infinity;
  let bestDistSq = Infinity;
  let bestLat = poly.points[0][0];
  let bestLon = poly.points[0][1];
  let bestAlong = 0;
  let bestBearing = poly.segBearings[0] ?? 0;

  const { points, cumMeters, segBearings } = poly;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [aLat, aLon] = points[i];
    const [bLat, bLon] = points[i + 1];
    const ax = (aLon - lon) * metersPerLon;
    const ay = (aLat - lat) * METERS_PER_LAT;
    const bx = (bLon - lon) * metersPerLon;
    const by = (bLat - lat) * METERS_PER_LAT;
    const vx = bx - ax;
    const vy = by - ay;
    const lenSq = vx * vx + vy * vy;
    const u = lenSq > 1e-6 ? clamp(-(ax * vx + ay * vy) / lenSq, 0, 1) : 0;
    const px = ax + u * vx;
    const py = ay + u * vy;
    const distSq = px * px + py * py;
    const segLen = cumMeters[i + 1] - cumMeters[i];
    const along = cumMeters[i] + u * segLen;

    // Lekka preferencja ciągłości wzdłuż trasy na pętlach / wspólnych ulicach.
    let score = distSq;
    if (typeof hintAlongMeters === "number" && Number.isFinite(hintAlongMeters)) {
      const gapAlong = Math.abs(along - hintAlongMeters);
      if (gapAlong > 280) {
        score += Math.min(900, (gapAlong - 280) * 0.6);
      }
    }

    if (score < bestScore) {
      bestScore = score;
      bestDistSq = distSq;
      bestLat = aLat + u * (bLat - aLat);
      bestLon = aLon + u * (bLon - aLon);
      bestAlong = along;
      bestBearing = segBearings[i] ?? 0;
    }
  }

  return {
    lat: bestLat,
    lon: bestLon,
    alongMeters: bestAlong,
    distanceMeters: Math.sqrt(bestDistSq),
    bearingDeg: bestBearing,
  };
}

export function samplePolylineAtMeters(
  poly: IndexedRoutePolyline,
  alongMeters: number,
): { lat: number; lon: number; bearingDeg: number } {
  const { points, cumMeters, segBearings, totalMeters } = poly;
  if (alongMeters <= 0) {
    return {
      lat: points[0][0],
      lon: points[0][1],
      bearingDeg: segBearings[0] ?? 0,
    };
  }
  if (alongMeters >= totalMeters) {
    const last = points.length - 1;
    return {
      lat: points[last][0],
      lon: points[last][1],
      bearingDeg: segBearings[Math.max(0, last - 1)] ?? 0,
    };
  }

  let lo = 0;
  let hi = cumMeters.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cumMeters[mid] <= alongMeters) lo = mid;
    else hi = mid - 1;
  }

  const segStart = cumMeters[lo];
  const segLen = cumMeters[lo + 1] - segStart;
  const u = segLen > 1e-6 ? clamp((alongMeters - segStart) / segLen, 0, 1) : 0;
  const [aLat, aLon] = points[lo];
  const [bLat, bLon] = points[lo + 1];
  return {
    lat: aLat + u * (bLat - aLat),
    lon: aLon + u * (bLon - aLon),
    bearingDeg: segBearings[lo] ?? 0,
  };
}

function validBearing(bearing: number | null | undefined): number | null {
  return typeof bearing === "number" && Number.isFinite(bearing)
    ? normalizeBearingDeg(bearing)
    : null;
}

export class BusMotionInterpolator {
  private tracks = new Map<string, BusMotionTrack>();

  clear(): void {
    this.tracks.clear();
  }

  private evaluateTrack(
    track: BusMotionTrack,
    nowMs: number,
  ): BusInterpolatedSample {
    if (track.settled || track.durationMs <= 0) {
      return {
        lat: track.toLat,
        lon: track.toLon,
        bearingDeg: track.toBearing,
        progress: 1,
        settled: true,
      };
    }

    const rawT = (nowMs - track.startedAtMs) / track.durationMs;
    if (rawT >= 1) {
      track.settled = true;
      return {
        lat: track.toLat,
        lon: track.toLon,
        bearingDeg: track.toBearing,
        progress: 1,
        settled: true,
      };
    }

    const t = glideEase(Math.max(0, rawT));

    if (track.curve) {
      const along =
        track.curve.fromAlongM +
        (track.curve.toAlongM - track.curve.fromAlongM) * t;
      const onCurve = samplePolylineAtMeters(track.curve.poly, along);
      const isForward = track.curve.toAlongM >= track.curve.fromAlongM;
      const curveHeading = isForward
        ? onCurve.bearingDeg
        : normalizeBearingDeg(onCurve.bearingDeg + 180);
      return {
        lat: onCurve.lat,
        lon: onCurve.lon,
        bearingDeg:
          Math.abs(track.curve.toAlongM - track.curve.fromAlongM) >= 3
            ? curveHeading
            : track.toBearing,
        progress: t,
        settled: false,
      };
    }

    const lat = track.fromLat + (track.toLat - track.fromLat) * t;
    const lon = track.fromLon + (track.toLon - track.fromLon) * t;
    let bearingDeg: number | null = track.toBearing;
    if (track.fromBearing !== null && track.toBearing !== null) {
      bearingDeg = interpolateBearingDeg(track.fromBearing, track.toBearing, t);
    }

    return {
      lat,
      lon,
      bearingDeg,
      progress: t,
      settled: false,
    };
  }

  syncFleet(
    buses: readonly LiveBusVehicle[],
    nowMs: number,
    routeByVehicleId?: ReadonlyMap<string, IndexedRoutePolyline>,
  ): void {
    const activeIds = new Set<string>();

    for (const bus of buses) {
      const id = bus.vehicleId;
      activeIds.add(id);
      const routePoly = routeByVehicleId?.get(id) ?? null;
      const rawBearing = validBearing(bus.bearing);
      const prev = this.tracks.get(id);

      // Nowy pojazd na mapie — ustawiamy od razu w bieżącym punkcie bez lotu z (0,0).
      if (!prev) {
        let targetLat = bus.lat;
        let targetLon = bus.lon;
        let targetBearing = rawBearing;
        let curve: BusMotionTrack["curve"] = null;

        if (routePoly) {
          const proj = projectPointOntoPolyline(routePoly, bus.lat, bus.lon);
          if (proj.distanceMeters <= ROUTE_SNAP_MAX_METERS) {
            targetLat = proj.lat;
            targetLon = proj.lon;
            if (targetBearing === null) targetBearing = proj.bearingDeg;
            curve = {
              poly: routePoly,
              fromAlongM: proj.alongMeters,
              toAlongM: proj.alongMeters,
            };
          }
        }

        this.tracks.set(id, {
          vehicleId: id,
          tripId: bus.tripId ?? null,
          lastRawLat: bus.lat,
          lastRawLon: bus.lon,
          lastPacketAtMs: nowMs,
          fromLat: targetLat,
          fromLon: targetLon,
          toLat: targetLat,
          toLon: targetLon,
          fromBearing: targetBearing,
          toBearing: targetBearing,
          startedAtMs: nowMs,
          durationMs: 0,
          settled: true,
          curve,
        });
        continue;
      }

      const rawStepMeters = distanceCoords(
        prev.lastRawLat,
        prev.lastRawLon,
        bus.lat,
        bus.lon,
      );

      // Ten sam pakiet GPS (np. re-render z innego powodu): zachowujemy płynną animację w toku!
      if (rawStepMeters < 0.05) {
        if (rawBearing !== null && prev.toBearing === null) {
          prev.toBearing = rawBearing;
        }
        // Jeśli dla wybranego autobusu właśnie dociągnęła się geometria kursu GTFS:
        if (routePoly && !prev.curve && prev.settled) {
          const proj = projectPointOntoPolyline(routePoly, bus.lat, bus.lon);
          if (proj.distanceMeters <= ROUTE_SNAP_MAX_METERS) {
            prev.toLat = proj.lat;
            prev.toLon = proj.lon;
            prev.fromLat = proj.lat;
            prev.fromLon = proj.lon;
            prev.curve = {
              poly: routePoly,
              fromAlongM: proj.alongMeters,
              toAlongM: proj.alongMeters,
            };
          }
        }
        continue;
      }

      // Punkt startowy kolejnego odcinka bierzemy z aktualnie wyświetlanej klatki (brak szarpnięcia!).
      const current = this.evaluateTrack(prev, nowMs);
      const packetGapMs = nowMs - prev.lastPacketAtMs;
      const tripChanged =
        Boolean(prev.tripId && bus.tripId && prev.tripId !== bus.tripId);

      prev.lastRawLat = bus.lat;
      prev.lastRawLon = bus.lon;
      prev.lastPacketAtMs = nowMs;
      prev.tripId = bus.tripId ?? null;

      // Postój / mikro-szum GPS (< 0,8 m): nie generujemy drgań.
      if (rawStepMeters < STATIONARY_CUTOFF_METERS) {
        if (rawBearing !== null) {
          prev.toBearing = rawBearing;
        }
        continue;
      }

      // Duży skok (> 650 m), powrót po długiej przerwie (> 25 s) lub zmiana kursu: natychmiastowy snap.
      if (
        rawStepMeters > TELEPORT_CUTOFF_METERS ||
        packetGapMs > STALE_PACKET_GAP_MS ||
        tripChanged
      ) {
        let snapLat = bus.lat;
        let snapLon = bus.lon;
        let snapBearing = rawBearing ?? prev.toBearing;
        let curve: BusMotionTrack["curve"] = null;
        if (routePoly) {
          const proj = projectPointOntoPolyline(routePoly, bus.lat, bus.lon);
          if (proj.distanceMeters <= ROUTE_SNAP_MAX_METERS) {
            snapLat = proj.lat;
            snapLon = proj.lon;
            if (snapBearing === null) snapBearing = proj.bearingDeg;
            curve = {
              poly: routePoly,
              fromAlongM: proj.alongMeters,
              toAlongM: proj.alongMeters,
            };
          }
        }
        prev.fromLat = snapLat;
        prev.fromLon = snapLon;
        prev.toLat = snapLat;
        prev.toLon = snapLon;
        prev.fromBearing = snapBearing;
        prev.toBearing = snapBearing;
        prev.startedAtMs = nowMs;
        prev.durationMs = 0;
        prev.settled = true;
        prev.curve = curve;
        continue;
      }

      // Normalny krok jazdy między pakietami GPS (0,8 m .. 650 m): płynna interpolacja!
      const durationMs =
        packetGapMs >= 900 && packetGapMs <= 8_000
          ? clamp(
              Math.round(packetGapMs * 0.96),
              MIN_GLIDE_DURATION_MS,
              MAX_GLIDE_DURATION_MS,
            )
          : DEFAULT_GLIDE_DURATION_MS;

      let nextToLat = bus.lat;
      let nextToLon = bus.lon;
      let nextCurve: BusMotionTrack["curve"] = null;
      let curveEndBearing: number | null = null;

      if (routePoly) {
        const hintFrom = prev.curve?.poly === routePoly ? prev.curve.toAlongM : null;
        const projFrom = projectPointOntoPolyline(
          routePoly,
          current.lat,
          current.lon,
          hintFrom,
        );
        const projTo = projectPointOntoPolyline(
          routePoly,
          bus.lat,
          bus.lon,
          projFrom.alongMeters,
        );
        const alongDelta = Math.abs(projTo.alongMeters - projFrom.alongMeters);
        const directStep = distanceCoords(
          current.lat,
          current.lon,
          bus.lat,
          bus.lon,
        );

        if (
          projFrom.distanceMeters <= ROUTE_SNAP_MAX_METERS &&
          projTo.distanceMeters <= ROUTE_SNAP_MAX_METERS &&
          alongDelta <= Math.max(directStep * 1.75, 65)
        ) {
          nextToLat = projTo.lat;
          nextToLon = projTo.lon;
          nextCurve = {
            poly: routePoly,
            fromAlongM: projFrom.alongMeters,
            toAlongM: projTo.alongMeters,
          };
          if (alongDelta >= 3) {
            curveEndBearing =
              projTo.alongMeters >= projFrom.alongMeters
                ? projTo.bearingDeg
                : normalizeBearingDeg(projTo.bearingDeg + 180);
          }
        }
      }

      const stepFromCurrentMeters = distanceCoords(
        current.lat,
        current.lon,
        nextToLat,
        nextToLon,
      );

      const derivedBearing =
        stepFromCurrentMeters >= DERIVED_BEARING_MIN_METERS
          ? computeBearingDeg(current.lat, current.lon, nextToLat, nextToLon)
          : null;

      const targetBearing =
        curveEndBearing ?? rawBearing ?? derivedBearing ?? current.bearingDeg;
      const startBearing = current.bearingDeg ?? targetBearing;

      prev.fromLat = current.lat;
      prev.fromLon = current.lon;
      prev.toLat = nextToLat;
      prev.toLon = nextToLon;
      prev.fromBearing = startBearing;
      prev.toBearing = targetBearing;
      prev.startedAtMs = nowMs;
      prev.durationMs = durationMs;
      prev.settled = stepFromCurrentMeters < STATIONARY_CUTOFF_METERS;
      prev.curve = nextCurve;
    }

    for (const id of this.tracks.keys()) {
      if (!activeIds.has(id)) {
        this.tracks.delete(id);
      }
    }
  }

  sample(vehicleId: string, nowMs: number): BusInterpolatedSample | null {
    const track = this.tracks.get(vehicleId);
    if (!track) return null;
    return this.evaluateTrack(track, nowMs);
  }

  hasActiveAnimations(
    nowMs: number,
    visibleVehicleIds?: ReadonlySet<string>,
  ): boolean {
    for (const [id, track] of this.tracks) {
      if (visibleVehicleIds && !visibleVehicleIds.has(id)) continue;
      if (!track.settled && nowMs - track.startedAtMs < track.durationMs) {
        return true;
      }
    }
    return false;
  }
}
