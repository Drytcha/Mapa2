import { runDeduped } from "./core/runtimeHub";
import { readStorageJson, readStorageText, writeStorageJson, writeStorageText } from "./core/time";
import type { JourneyPoint } from "./journeyPlanner";

const CLIENT_ID_STORAGE_KEY = "mapplaner.travelerClientId.v1";
const STATIC_PAGES = process.env.NEXT_PUBLIC_STATIC_EXPORT === "1";
const LOCAL_PLACES_KEY = "mapplaner.pages.savedPlaces.v1";
const LOCAL_TRIP_KEY = "mapplaner.pages.lastTrip.v1";

type LastTrip = { origin: JourneyPoint | null; destination: JourneyPoint | null };

export interface SavedTravelerPlace {
  id: number;
  label: string;
  lat: number;
  lon: number;
  stopId?: string;
  createdAt: string;
}

function isPoint(value: unknown): value is JourneyPoint {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.label === "string" && typeof p.lat === "number" &&
    Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && typeof p.lon === "number" &&
    Number.isFinite(p.lon) && Math.abs(p.lon) <= 180;
}

function localPlaces(): SavedTravelerPlace[] {
  const rows = readStorageJson<unknown>(LOCAL_PLACES_KEY);
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => isPoint(row) && "id" in row &&
    typeof row.id === "number" && Number.isSafeInteger(row.id)).slice(0, 20);
}

export function getTravelerClientId(): string {
  if (typeof window === "undefined") return "";
  const stored = readStorageText(CLIENT_ID_STORAGE_KEY)?.trim();
  if (stored && /^[a-zA-Z0-9_-]{8,80}$/.test(stored)) return stored;
  const generated = `trv_${globalThis.crypto?.randomUUID?.().replace(/[^a-zA-Z0-9_-]/g, "") ??
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`}`;
  writeStorageText(CLIENT_ID_STORAGE_KEY, generated);
  return generated;
}

async function travelerFetch<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const clientId = getTravelerClientId();
  if (!clientId) return null;
  const headers = new Headers(init.headers);
  headers.set("x-client-id", clientId);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export function fetchSavedTravelerPlaces(): Promise<SavedTravelerPlace[]> {
  if (STATIC_PAGES) return Promise.resolve(localPlaces());
  return runDeduped("traveler:places:get", async () => {
    const data = await travelerFetch<{ places?: SavedTravelerPlace[] }>(
      "/api/traveler/places", { cache: "no-store" }
    );
    return Array.isArray(data?.places) ? data.places : [];
  });
}

export async function saveTravelerPlace(point: JourneyPoint): Promise<SavedTravelerPlace | null> {
  if (STATIC_PAGES) {
    if (!isPoint(point)) return null;
    const places = localPlaces();
    const existing = places.find((p) => Math.abs(p.lat - point.lat) < 0.00012 && Math.abs(p.lon - point.lon) < 0.00012);
    const place: SavedTravelerPlace = {
      id: existing?.id ?? Math.max(Date.now(), ...places.map((p) => p.id + 1)),
      lat: point.lat, lon: point.lon, label: point.label.slice(0, 120),
      stopId: point.stopId ?? existing?.stopId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    const next = [place, ...places.filter((p) => p.id !== place.id)].slice(0, 20);
    return writeStorageJson(LOCAL_PLACES_KEY, next) ? place : null;
  }
  const data = await travelerFetch<{ place?: SavedTravelerPlace }>("/api/traveler/places", {
    method: "POST", body: JSON.stringify(point),
  });
  return data?.place ?? null;
}

export async function deleteTravelerPlace(id: number): Promise<boolean> {
  if (STATIC_PAGES) return writeStorageJson(LOCAL_PLACES_KEY, localPlaces().filter((p) => p.id !== id));
  const data = await travelerFetch<{ ok?: boolean }>(`/api/traveler/places/${id}`, { method: "DELETE" });
  return Boolean(data?.ok);
}

export function fetchLastTravelerTrip(): Promise<LastTrip> {
  if (STATIC_PAGES) {
    const trip = readStorageJson<Partial<LastTrip>>(LOCAL_TRIP_KEY);
    return Promise.resolve({
      origin: isPoint(trip?.origin) ? trip.origin : null,
      destination: isPoint(trip?.destination) ? trip.destination : null,
    });
  }
  return runDeduped("traveler:last-trip:get", async () => {
    const data = await travelerFetch<Partial<LastTrip>>("/api/traveler/last-trip", { cache: "no-store" });
    return { origin: data?.origin ?? null, destination: data?.destination ?? null };
  });
}

export async function saveLastTravelerTrip(origin: JourneyPoint | null, destination: JourneyPoint | null): Promise<void> {
  if (STATIC_PAGES) {
    if (!writeStorageJson(LOCAL_TRIP_KEY, { origin, destination })) {
      throw new Error("Nie udało się zapisać trasy w pamięci przeglądarki.");
    }
    return;
  }
  await travelerFetch("/api/traveler/last-trip", {
    method: "PUT", body: JSON.stringify({ origin, destination }),
  });
}
