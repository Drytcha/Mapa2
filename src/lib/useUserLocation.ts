import { useCallback, useEffect, useRef, useState } from "react";

export type LocationStatus =
  | "idle"
  | "requesting"
  | "active"
  | "denied"
  | "unavailable";

export interface UserLocation {
  lat: number;
  lon: number;
  /** Promień dokładności w metrach. */
  accuracy: number;
  altitude: number | null;
  /** Kierunek ruchu w stopniach (0 = północ), jeśli jest wiarygodny. */
  heading: number | null;
  speedKmh: number | null;
  speedSource: "gps" | "derived" | null;
  timestamp: number;
  /** Największa prędkość od otwarcia strony. */
  maxSpeedKmh: number;
  /** Przebyty dystans od otwarcia strony w metrach. */
  distanceM: number;
}

export interface RawFix {
  lat: number;
  lon: number;
  accuracy: number;
  altitude: number | null;
  /** Prędkość z czujnika w m/s, jeśli urządzenie ją podaje. */
  speedMs: number | null;
  heading: number | null;
  timestamp: number;
}

export interface MotionState {
  lat: number;
  lon: number;
  accuracy: number;
  timestamp: number;
  speedKmh: number | null;
  heading: number | null;
  maxSpeedKmh: number;
  distanceM: number;
}

export interface MotionResult {
  speedKmh: number | null;
  speedSource: "gps" | "derived" | null;
  heading: number | null;
  maxSpeedKmh: number;
  distanceM: number;
}

const MAX_PLAUSIBLE_KMH = 250;
const MAX_FIX_GAP_S = 60;
/** Poniżej tej prędkości uznajemy, że stoimy (szum GPS). */
const STANDSTILL_KMH = 1;
/** Kierunek z czujnika ma sens dopiero w ruchu. */
const HEADING_MIN_KMH = 3;

import { distanceCoords } from "./core/spatial";

const toRad = (value: number) => (value * Math.PI) / 180;

export function distanceMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  return distanceCoords(a.lat, a.lon, b.lat, b.lon);
}

export function bearingDegrees(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

export function compassLabel(degrees: number): string {
  const normalized = ((degrees % 360) + 360) % 360;
  return COMPASS[Math.round(normalized / 45) % 8];
}

/**
 * Prędkość i kierunek z kolejnych odczytów. Preferuje prędkość z czujnika
 * (Doppler), a gdy jej brak (np. komputery) liczy ją z przemieszczenia,
 * pomijając drgania w granicach błędu GPS.
 */
export function deriveMotion(prev: MotionState | null, fix: RawFix): MotionResult {
  const moved = prev ? distanceMeters(prev, fix) : 0;
  const dt = prev ? (fix.timestamp - prev.timestamp) / 1000 : 0;
  const noise = prev
    ? Math.max(5, ((fix.accuracy + prev.accuracy) / 2) * 0.5)
    : Infinity;
  const usable = Boolean(prev) && dt >= 0.5 && dt <= MAX_FIX_GAP_S;

  let speed: number | null = null;
  let source: "gps" | "derived" | null = null;
  let derivedHeading: number | null = null;

  if (fix.speedMs !== null && Number.isFinite(fix.speedMs) && fix.speedMs >= 0) {
    speed = fix.speedMs * 3.6;
    source = "gps";
  } else if (prev && usable) {
    if (moved < noise) {
      speed = 0;
    } else {
      const raw = (moved / dt) * 3.6;
      speed = prev.speedKmh !== null ? raw * 0.6 + prev.speedKmh * 0.4 : raw;
      derivedHeading = bearingDegrees(prev, fix);
    }
    source = "derived";
  }

  if (speed !== null) {
    if (speed > MAX_PLAUSIBLE_KMH) speed = null;
    else if (speed < STANDSTILL_KMH) speed = 0;
  }
  if (speed === null) source = null;

  let heading: number | null = null;
  if (
    fix.heading !== null &&
    Number.isFinite(fix.heading) &&
    speed !== null &&
    speed >= HEADING_MIN_KMH
  ) {
    heading = ((fix.heading % 360) + 360) % 360;
  } else if (derivedHeading !== null && speed !== null && speed >= STANDSTILL_KMH) {
    heading = derivedHeading;
  } else if (speed !== null && speed >= STANDSTILL_KMH) {
    heading = prev?.heading ?? null;
  }

  const counted =
    usable && moved >= noise && fix.accuracy <= 50 && moved / dt <= MAX_PLAUSIBLE_KMH / 3.6;
  return {
    speedKmh: speed,
    speedSource: source,
    heading,
    maxSpeedKmh: Math.max(prev?.maxSpeedKmh ?? 0, speed ?? 0),
    distanceM: (prev?.distanceM ?? 0) + (counted ? moved : 0),
  };
}

export interface UseUserLocation {
  status: LocationStatus;
  location: UserLocation | null;
  /** Rozpoczyna (lub ponawia) śledzenie lokalizacji; pyta o zgodę przeglądarki. */
  start: () => void;
}

/**
 * Śledzi lokalizację GPS użytkownika. Po zamontowaniu automatycznie prosi o
 * zgodę i na bieżąco aktualizuje pozycję, prędkość i kierunek.
 */
export function useUserLocation({ autoStart = true } = {}): UseUserLocation {
  const [status, setStatus] = useState<LocationStatus>("idle");
  const [location, setLocation] = useState<UserLocation | null>(null);
  const watchRef = useRef<number | null>(null);
  const motionRef = useRef<MotionState | null>(null);
  const lastEmittedRef = useRef<UserLocation | null>(null);
  const lastEmitAtRef = useRef(0);

  const stop = useCallback(() => {
    if (watchRef.current !== null && typeof navigator !== "undefined") {
      navigator.geolocation?.clearWatch(watchRef.current);
    }
    watchRef.current = null;
  }, []);

  const start = useCallback(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setStatus("unavailable");
      return;
    }
    if (watchRef.current !== null) return;
    setStatus((current) => (current === "active" ? current : "requesting"));
    watchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const { coords } = position;
        const fix: RawFix = {
          lat: coords.latitude,
          lon: coords.longitude,
          accuracy: Number.isFinite(coords.accuracy) ? coords.accuracy : 0,
          altitude:
            coords.altitude !== null && Number.isFinite(coords.altitude)
              ? coords.altitude
              : null,
          speedMs:
            coords.speed !== null && Number.isFinite(coords.speed) ? coords.speed : null,
          heading:
            coords.heading !== null && Number.isFinite(coords.heading)
              ? coords.heading
              : null,
          timestamp: position.timestamp || Date.now(),
        };
        if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return;
        const motion = deriveMotion(motionRef.current, fix);
        motionRef.current = {
          lat: fix.lat,
          lon: fix.lon,
          accuracy: fix.accuracy,
          timestamp: fix.timestamp,
          speedKmh: motion.speedKmh,
          heading: motion.heading,
          maxSpeedKmh: motion.maxSpeedKmh,
          distanceM: motion.distanceM,
        };
        // GPS potrafi „drgać" o metr nawet gdy telefon leży na biurku. Każdy taki
        // odczyt przerysowywał całą stronę planisty, więc pomijamy drobne szumy:
        // emitujemy nową pozycję dopiero po realnym ruchu (albo po 3 s ciszy).
        const next: UserLocation = {
          lat: fix.lat,
          lon: fix.lon,
          accuracy: fix.accuracy,
          altitude: fix.altitude,
          heading: motion.heading,
          speedKmh: motion.speedKmh,
          speedSource: motion.speedSource,
          timestamp: fix.timestamp,
          maxSpeedKmh: motion.maxSpeedKmh,
          distanceM: motion.distanceM,
        };
        const previous = lastEmittedRef.current;
        const now = Date.now();
        const movedMeters = previous
          ? distanceCoords(previous.lat, previous.lon, next.lat, next.lon)
          : Infinity;
        const meaningfullyDifferent =
          !previous ||
          movedMeters >= 1.5 ||
          Math.abs(next.accuracy - previous.accuracy) >= 5 ||
          Math.abs((next.speedKmh ?? 0) - (previous.speedKmh ?? 0)) >= 2 ||
          now - lastEmitAtRef.current >= 3_000;
        if (meaningfullyDifferent) {
          lastEmittedRef.current = next;
          lastEmitAtRef.current = now;
          setLocation(next);
        }
        setStatus("active");
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          stop();
          setStatus("denied");
        } else {
          // Chwilowy brak sygnału lub timeout — czekamy dalej na kolejny odczyt.
          setStatus((current) => (current === "active" ? current : "requesting"));
        }
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
  }, [stop]);

  useEffect(() => {
    if (autoStart) start();
    return stop;
  }, [autoStart, start, stop]);

  return { status, location, start };
}
