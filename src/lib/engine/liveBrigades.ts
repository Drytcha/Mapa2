import { idbGetKv, idbSetKv } from "./storage";

/**
 * Brigade rosters exactly as the Wałbrzych open-data ecosystem publishes them
 * (api.livetransport.eu — the same service that powers livetransport.eu).
 *
 * The API answers with real on-board duty numbers ("2-01", "18-04", …) and
 * already contains cross-line duties (e.g. 8-02 also running line 2). That is
 * why it is the primary source: numbers are never invented.
 *
 * The API allows CORS only from its own origin, so a static GitHub Pages build
 * reaches it through text proxies. Every successful payload is cached in
 * IndexedDB, so once a day has been opened it keeps working offline.
 */

const API_BASE = "https://api.livetransport.eu/walbrzych";

export interface LiveBlock {
  blockId: string;
  times: [number, number][];
}

export interface LiveTrip {
  id: string;
  lineId: string;
  destination: string;
  length: number;
  stops: Array<{ id: string; scheduled: number }>;
  vehicleId?: string;
}

const BLOCK_TTL_MS = 30 * 60_000;
const TRIP_TTL_MS = 7 * 24 * 60 * 60_000;

const memoryBlocks = new Map<string, { at: number; value: LiveBlock[] }>();
const memoryTrips = new Map<string, { at: number; value: LiveTrip[] }>();

const PROXIES: Array<(url: string) => string> = [
  (url) => `https://r.jina.ai/${url}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
];

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json, text/plain" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Text proxies wrap JSON in a Markdown document — extract the array payload. */
function extractArray<T>(text: string): T[] | null {
  const trimmed = text.trim();
  try {
    const direct = JSON.parse(trimmed) as unknown;
    if (Array.isArray(direct)) return direct as T[];
  } catch {
    /* fall through */
  }
  const marker = "Markdown Content:";
  const index = trimmed.indexOf(marker);
  let payload = (index >= 0 ? trimmed.slice(index + marker.length) : trimmed)
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = payload.indexOf("[");
  const end = payload.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  payload = payload.slice(start, end + 1);
  try {
    const parsed = JSON.parse(payload) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestArray<T>(path: string): Promise<T[]> {
  const target = `${API_BASE}/${path}`;
  const attempts = [
    () => fetchText(target, 3_000), // direct, in case CORS opens
    () => fetchText(PROXIES[0](target), 14_000),
    () => fetchText(PROXIES[1](target), 14_000),
    () => fetchText(PROXIES[2](target), 14_000),
    // Second pass after the proxy rate-limit window.
    () => fetchText(PROXIES[0](target), 16_000),
  ];
  let lastError: unknown = null;
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      const parsed = extractArray<T>(await attempts[i]());
      if (parsed) return parsed;
      lastError = new Error("Nieprawidłowa odpowiedź źródła brygad");
    } catch (error) {
      lastError = error;
    }
    if (i > 0) await sleep(600 + i * 400);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Nie udało się pobrać brygad z otwartego źródła.");
}

export function blockNumber(blockId: string): string {
  return blockId.includes("_") ? blockId.split("_").at(-1) || blockId : blockId;
}

/** Block list for one line and date (contains cross-line duties too). */
export async function fetchLiveBlocks(
  line: string,
  dateId: string
): Promise<LiveBlock[]> {
  const key = `${dateId}|${line.toUpperCase()}`;
  const cachedMemory = memoryBlocks.get(key);
  if (cachedMemory && Date.now() - cachedMemory.at < BLOCK_TTL_MS) return cachedMemory.value;

  const stored = await idbGetKv<{ at: number; value: LiveBlock[] }>(`brigades.live.${key}`);
  if (stored && Date.now() - stored.at < BLOCK_TTL_MS && Array.isArray(stored.value)) {
    memoryBlocks.set(key, stored);
    return stored.value;
  }

  const raw = await requestArray<LiveBlock>(
    `brigades/${encodeURIComponent(line.toUpperCase())}?date=${dateId}`
  );
  const value = raw
    .filter(
      (block) =>
        typeof block?.blockId === "string" &&
        Array.isArray(block.times) &&
        block.times.every(
          (pair) => Array.isArray(pair) && pair.length >= 2 && pair.every(Number.isFinite)
        )
    )
    .map((block) => ({
      blockId: block.blockId,
      times: block.times.map((pair) => [pair[0], pair[1]] as [number, number]),
    }));

  memoryBlocks.set(key, { at: Date.now(), value });
  if (value.length) {
    void idbSetKv(`brigades.live.${key}`, { at: Date.now(), value });
  }
  return value;
}

/** All trips of one duty — complete roster, including line changes. */
export async function fetchLiveTrips(blockId: string): Promise<LiveTrip[]> {
  const cachedMemory = memoryTrips.get(blockId);
  if (cachedMemory && Date.now() - cachedMemory.at < TRIP_TTL_MS) return cachedMemory.value;

  const stored = await idbGetKv<{ at: number; value: LiveTrip[] }>(
    `brigades.trips.${blockId}`
  );
  if (stored && stored.value && Array.isArray(stored.value)) {
    memoryTrips.set(blockId, stored);
    return stored.value;
  }

  const raw = await requestArray<LiveTrip>(`brigade/${encodeURIComponent(blockId)}`);
  const value = raw
    .filter((trip) => Array.isArray(trip?.stops) && trip.stops.length >= 2)
    .map((trip) => ({
      ...trip,
      lineId: String(trip.lineId ?? "").toUpperCase(),
      destination: trip.destination || "",
      length: Number(trip.length) || 0,
    }));

  memoryTrips.set(blockId, { at: Date.now(), value });
  void idbSetKv(`brigades.trips.${blockId}`, { at: Date.now(), value });
  return value;
}

export function clearLiveBrigadeCache(): void {
  memoryBlocks.clear();
  memoryTrips.clear();
}
