import { runDeduped } from "./core/runtimeHub";
import { readStorageText, writeStorageText } from "./core/time";
import type { JourneyPoint } from "./journeyPlanner";

const CLIENT_ID_STORAGE_KEY = "mapplaner.travelerClientId.v1";

export interface SavedTravelerPlace {
  id: number;
  label: string;
  lat: number;
  lon: number;
  stopId?: string;
  createdAt: string;
}

export function getTravelerClientId(): string {
  if (typeof window === "undefined") return "";
  const stored = readStorageText(CLIENT_ID_STORAGE_KEY)?.trim();
  if (stored && /^[a-zA-Z0-9_-]{8,80}$/.test(stored)) return stored;
  const generated = `trv_${
    globalThis.crypto?.randomUUID?.().replace(/[^a-zA-Z0-9_-]/g, "") ??
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
  }`;
  writeStorageText(CLIENT_ID_STORAGE_KEY, generated);
  return generated;
}

async function travelerFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T | null> {
  const clientId = getTravelerClientId();
  if (!clientId) return null;
  const headers = new Headers(init.headers);
  headers.set("x-client-id", clientId);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export function fetchSavedTravelerPlaces(): Promise<SavedTravelerPlace[]> {
  return runDeduped("traveler:places:get", async () => {
    const data = await travelerFetch<{ places?: SavedTravelerPlace[] }>(
      "/api/traveler/places",
      { cache: "no-store" }
    );
    return Array.isArray(data?.places) ? data.places : [];
  });
}

export async function saveTravelerPlace(
  point: JourneyPoint
): Promise<SavedTravelerPlace | null> {
  const data = await travelerFetch<{ place?: SavedTravelerPlace }>(
    "/api/traveler/places",
    {
      method: "POST",
      body: JSON.stringify({
        lat: point.lat,
        lon: point.lon,
        label: point.label,
        stopId: point.stopId,
      }),
    }
  );
  return data?.place ?? null;
}

export async function deleteTravelerPlace(id: number): Promise<boolean> {
  const data = await travelerFetch<{ ok?: boolean }>(
    `/api/traveler/places/${id}`,
    { method: "DELETE" }
  );
  return Boolean(data?.ok);
}

export function fetchLastTravelerTrip(): Promise<{
  origin: JourneyPoint | null;
  destination: JourneyPoint | null;
}> {
  return runDeduped("traveler:last-trip:get", async () => {
    const data = await travelerFetch<{
      origin?: JourneyPoint | null;
      destination?: JourneyPoint | null;
    }>("/api/traveler/last-trip", { cache: "no-store" });
    return {
      origin: data?.origin ?? null,
      destination: data?.destination ?? null,
    };
  });
}

export async function saveLastTravelerTrip(
  origin: JourneyPoint | null,
  destination: JourneyPoint | null
): Promise<void> {
  await travelerFetch("/api/traveler/last-trip", {
    method: "PUT",
    body: JSON.stringify({ origin, destination }),
  });
}
