import { DateTime } from "luxon";
import { distanceCoords } from "@/lib/core/spatial";
import { foldStopKey } from "@/lib/core/text";
import { formatWarsawClock, formatWarsawShortDate, WARSAW_ZONE } from "@/lib/core/time";
import type { BusStop, StopDepartureItem } from "@/lib/types";
import type { getStopDepartures } from "./gtfsStore";

const API = "https://api.zbiorkom.live/api6-open/walbrzych";
const STOP_LIST_TTL_MS = 10 * 60_000;
const MATCH_RADIUS_M = 12;
const MAX_PAGES = 10;

type StopScheduleResult = Awaited<ReturnType<typeof getStopDepartures>>;

interface RemoteStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

interface RemoteDeparture {
  trip?: {
    route?: { name?: unknown; color?: unknown };
    headsign?: unknown;
  };
  scheduledDeparture?: unknown;
  delay?: unknown;
  isRealtime?: unknown;
  isCancelled?: unknown;
}

let cachedStops: { at: number; stops: RemoteStop[] } | null = null;

/** Bound the optional fallback and cancel it when the user chooses another stop. */
async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 6_000);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Rozkład awaryjny: HTTP ${response.status}.`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

async function getRemoteStops(signal: AbortSignal): Promise<RemoteStop[]> {
  if (cachedStops && Date.now() - cachedStops.at < STOP_LIST_TTL_MS) return cachedStops.stops;
  const json = await fetchJson(`${API}/stops`, signal) as { stops?: unknown };
  if (!Array.isArray(json?.stops)) throw new Error("Nieprawidłowa lista przystanków awaryjnych.");
  const stops: RemoteStop[] = [];
  for (const row of json.stops) {
    // api6-open exposes compact tuples: [id, city, name, ..., [lon, lat], ...].
    if (!Array.isArray(row) || typeof row[0] !== "string" || typeof row[2] !== "string" || !Array.isArray(row[4])) continue;
    const [lon, lat] = row[4];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stops.push({ id: row[0], name: row[2], lat, lon });
  }
  if (!stops.length) throw new Error("Pusta lista przystanków awaryjnych.");
  cachedStops = { at: Date.now(), stops };
  return stops;
}

/** Never guess the opposite platform when matching two different data sources. */
export function matchFallbackStop(stop: BusStop, stops: readonly RemoteStop[]): RemoteStop | null {
  const name = foldStopKey(stop.name);
  if (!name) return null;
  const candidates = stops
    .filter((candidate) => foldStopKey(candidate.name) === name)
    .map((candidate) => ({
      candidate,
      distance: distanceCoords(stop.lat, stop.lon, candidate.lat, candidate.lon),
    }))
    .filter(({ distance }) => distance <= MATCH_RADIUS_M)
    .sort((a, b) => a.distance - b.distance);
  const exactId = stop.gtfsId && candidates.find(({ candidate }) => candidate.id === stop.gtfsId);
  if (exactId) return exactId.candidate;
  if (!candidates.length) return null;
  if (candidates[1] && candidates[1].distance - candidates[0].distance < 3) return null;
  return candidates[0].candidate;
}

/**
 * Independent, clearly-labelled fallback for when the GTFS ZIP is unavailable or
 * still loading. Times are fetched for the selected calendar day, not invented
 * from the saved stop snapshot. The API does not expose course IDs here.
 */
export async function getFallbackStopDepartures(
  stop: BusStop,
  fromMs: number,
  toMs: number,
  signal: AbortSignal
): Promise<StopScheduleResult> {
  const remote = matchFallbackStop(stop, await getRemoteStops(signal));
  if (!remote) throw new Error("Nie udało się jednoznacznie dopasować przystanku do rozkładu awaryjnego.");

  const departures = new Map<string, StopDepartureItem>();
  let cursor = fromMs;
  let finished = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const json = await fetchJson(
      `${API}/stops/${encodeURIComponent(remote.id)}?limit=500&time=${cursor}`,
      signal
    ) as { departures?: unknown };
    if (!Array.isArray(json?.departures)) throw new Error("Nieprawidłowy rozkład awaryjny.");
    const rows = json.departures as RemoteDeparture[];
    if (!rows.length) {
      finished = true;
      break;
    }
    let last = -Infinity;
    for (const row of rows) {
      const atMs = row?.scheduledDeparture;
      if (typeof atMs !== "number" || !Number.isFinite(atMs)) continue;
      last = Math.max(last, atMs);
      if (atMs < fromMs || atMs >= toMs || row.isCancelled === true) continue;
      const line = typeof row.trip?.route?.name === "string" ? row.trip.route.name.trim().toUpperCase() : "";
      if (!line) continue;
      const headsign = typeof row.trip?.headsign === "string" ? row.trip.headsign.trim() : "";
      const rawColor = typeof row.trip?.route?.color === "string" ? row.trip.route.color : "";
      const color = /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor : "#0d4f3b";
      const dt = DateTime.fromMillis(atMs, { zone: WARSAW_ZONE });
      const key = `${line}|${headsign}|${atMs}`;
      departures.set(key, {
        // This key identifies a displayed row only; it is not a GTFS trip ID.
        tripId: `fallback:${key}`,
        canPreviewCourse: false,
        serviceDateId: dt.toFormat("yyyyLLdd"),
        kursowkaId: "",
        kursowka: "",
        brigadeSource: "none",
        routeShort: line,
        routeColor: color,
        routeTextColor: "#ffffff",
        routeLong: "",
        headsign,
        finalStop: headsign || "Nieznany kierunek",
        direction: 0,
        minutes: dt.hour * 60 + dt.minute,
        atMs,
        clock: formatWarsawClock(atMs),
        dateLabel: formatWarsawShortDate(atMs),
        isRealtime: row.isRealtime === true,
        delaySeconds: typeof row.delay === "number" && Number.isFinite(row.delay) ? Math.round(row.delay / 1000) : 0,
        vehicleId: null,
        operatorName: null,
        operatorKey: null,
      });
    }
    if (!Number.isFinite(last)) throw new Error("Nieprawidłowe godziny w rozkładzie awaryjnym.");
    if (last >= toMs) {
      finished = true;
      break;
    }
    if (last <= cursor) {
      // The endpoint is inclusive. A single repeated final row means no more
      // departures; a full page at one timestamp would be ambiguous.
      if (rows.length >= 100) throw new Error("Nie udało się pobrać pełnego rozkładu awaryjnego.");
      finished = true;
      break;
    }
    // Repeat the boundary timestamp and deduplicate so simultaneous departures
    // at the end of a page are not discarded.
    cursor = last;
  }
  if (!finished) throw new Error("Nie udało się pobrać pełnego rozkładu awaryjnego.");
  return {
    matched: {
      id: remote.id,
      name: remote.name,
      lat: remote.lat,
      lon: remote.lon,
      agency: "zbiorkom.live",
      distanceMeters: Math.round(distanceCoords(stop.lat, stop.lon, remote.lat, remote.lon)),
    },
    departures: [...departures.values()].sort((a, b) => a.atMs - b.atMs),
  };
}
