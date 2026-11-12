import type { LiveBusVehicle, LiveTrafficSummary } from "@/lib/types";
import { DateTime } from "luxon";
import {
  DUTY_VERIFICATION_ZONE,
  ensureDutyRosters,
  resolveFleetDuties,
} from "./brigadeVerification";
import { loadOperatorOverrides, resolveWalbrzychOperator } from "./fleetOperators";
import { upsertLiveObservations, type LiveTripObservation } from "./storage";
import { pruneSpeedHistory, trackSpeed } from "./vehicleSpeed";

const ZBIORKOM_POSITIONS_URL =
  "https://api.zbiorkom.live/api6-open/walbrzych/positions/16.00,50.55,16.60,50.95";
const ZBIORKOM_GTFS_RT_URL =
  "https://api.zbiorkom.live/api6-open/walbrzych/gtfsRealtime/default/vehiclePositions,tripUpdates";

export type { LiveBusVehicle, LiveTrafficSummary };
export { resolveWalbrzychOperator };

export interface LiveFleetPayload {
  vehicles: LiveBusVehicle[];
  traffic: LiveTrafficSummary;
  source: string;
}

type ObservationListener = () => void;
const observationListeners = new Set<ObservationListener>();

export function subscribeObservationUpdates(listener: ObservationListener): () => void {
  observationListeners.add(listener);
  return () => observationListeners.delete(listener);
}

/**
 * Dawniej ta funkcja sklejała linię z sygnałem brygady, tworząc fałszywe kody
 * typu „19/01” lub „8/WY/04”. Sygnał operatora jest teraz tylko surowym
 * numerem pomocniczym — pełny kod może powstać wyłącznie w resolverze
 * rozkładu brygad (brigadeVerification.ts).
 */
export function rawBrigadeSignal(brigade?: string | null): string {
  return (brigade ?? "").trim();
}

/* ---------------- GTFS-RT decoder (schema-aware, zero-dep) ---------------- */

type WireValue = number | Uint8Array;
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let factor = 1;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result += (byte & 0x7f) * factor;
    if (!(byte & 0x80)) break;
    factor *= 128;
  }
  return [result, pos];
}

/** Flat wire-format reader; length-delimited fields stay raw bytes. */
function wireFields(buf: Uint8Array): Array<[number, WireValue]> {
  const fields: Array<[number, WireValue]> = [];
  let pos = 0;
  while (pos < buf.length) {
    const [tag, afterTag] = readVarint(buf, pos);
    pos = afterTag;
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 0) throw new Error("GTFS-RT: invalid field");
    if (wire === 0) {
      const [value, next] = readVarint(buf, pos);
      pos = next;
      fields.push([field, value]);
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (pos + size > buf.length) throw new Error("GTFS-RT: truncated");
      fields.push([field, buf.subarray(pos, pos + size)]);
      pos += size;
    } else if (wire === 2) {
      const [length, next] = readVarint(buf, pos);
      pos = next;
      if (pos + length > buf.length) throw new Error("GTFS-RT: truncated");
      fields.push([field, buf.subarray(pos, pos + length)]);
      pos += length;
    } else {
      throw new Error("GTFS-RT: unsupported wire type");
    }
  }
  return fields;
}

const asText = (value: WireValue): string =>
  value instanceof Uint8Array ? utf8Decoder.decode(value) : "";

export interface RtVehicleTrip {
  tripId: string;
  routeId: string;
  /** TripDescriptor.start_time, e.g. "08:44:00" (may exceed 24:00). */
  startTime: string;
  /** TripDescriptor.start_date = service day, e.g. "20261112". */
  startDate: string;
  label: string;
}

function decodeTripDescriptor(bytes: Uint8Array): Omit<RtVehicleTrip, "label"> {
  const trip = { tripId: "", routeId: "", startTime: "", startDate: "" };
  for (const [field, value] of wireFields(bytes)) {
    if (field === 1) trip.tripId = asText(value);
    else if (field === 2) trip.startTime = asText(value);
    else if (field === 3) trip.startDate = asText(value);
    else if (field === 5) trip.routeId = asText(value);
  }
  return trip;
}

function decodeVehicleLabel(bytes: Uint8Array): string {
  let id = "";
  let label = "";
  for (const [field, value] of wireFields(bytes)) {
    if (field === 1) id = asText(value);
    else if (field === 2) label = asText(value);
  }
  return (label || id.split(":").pop() || "").trim();
}

/** Vehicle label → its current trip (id, route, service day, start time). */
async function fetchGtfsRtTrips(): Promise<Map<string, RtVehicleTrip>> {
  const map = new Map<string, RtVehicleTrip>();
  try {
    const res = await fetch(ZBIORKOM_GTFS_RT_URL, {
      signal: AbortSignal.timeout(6000),
      cache: "no-store",
    });
    if (!res.ok) return map;
    const buf = new Uint8Array(await res.arrayBuffer());
    for (const [field, entity] of wireFields(buf)) {
      if (field !== 2 || !(entity instanceof Uint8Array)) continue;
      try {
        for (const [kind, body] of wireFields(entity)) {
          // FeedEntity: 3 = trip_update, 4 = vehicle position.
          if ((kind !== 3 && kind !== 4) || !(body instanceof Uint8Array)) continue;
          let trip: Omit<RtVehicleTrip, "label"> | null = null;
          let label = "";
          for (const [inner, value] of wireFields(body)) {
            if (!(value instanceof Uint8Array)) continue;
            if (inner === 1) trip = decodeTripDescriptor(value);
            else if ((kind === 4 && inner === 8) || (kind === 3 && inner === 3)) {
              label = decodeVehicleLabel(value);
            }
          }
          if (!label || !trip?.tripId) continue;
          if (kind === 4 || !map.has(label)) map.set(label, { ...trip, label });
        }
      } catch {
        /* One malformed entity must not hide the remaining vehicles. */
      }
    }
  } catch {
    // Non-fatal: positions JSON still works without GTFS-RT trip data
  }
  return map;
}

function rtTripStartMs(trip: RtVehicleTrip | undefined): number | null {
  if (!trip || !/^\d{8}$/.test(trip.startDate)) return null;
  const match = trip.startTime.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const day = DateTime.fromFormat(trip.startDate, "yyyyLLdd", { zone: DUTY_VERIFICATION_ZONE });
  if (!day.isValid) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);
  return day.startOf("day").toMillis() + seconds * 1000;
}

interface RawZbiorkomPosition {
  vehicle?: { id?: string; type?: string; agency?: string; model?: string | null };
  routeName?: string;
  routeColor?: string;
  brigade?: string;
  location?: [number, number];
  timestamp?: number;
  bearing?: number;
  delay?: number;
  headsign?: string | null;
  upcomingStops?: Array<{
    sequence: number;
    name: string;
    scheduledArrival: number;
    scheduledDeparture: number;
  }>;
}

let liveCache: { at: number; data: LiveFleetPayload } | null = null;
const LIVE_CACHE_TTL_MS = 8_000;

export function invalidateLiveBusCache(): void {
  liveCache = null;
}

export async function getLiveWalbrzychBuses(forceRefresh = false): Promise<LiveFleetPayload> {
  if (!forceRefresh && liveCache && Date.now() - liveCache.at < LIVE_CACHE_TTL_MS) {
    return liveCache.data;
  }

  const [posRes, tripMap] = await Promise.all([
    fetch(ZBIORKOM_POSITIONS_URL, {
      signal: AbortSignal.timeout(7000),
      cache: "no-store",
    }),
    fetchGtfsRtTrips(),
  ]);

  if (!posRes.ok) {
    throw new Error(`Błąd pobierania pozycji GPS: HTTP ${posRes.status}`);
  }

  const json = (await posRes.json()) as { positions?: RawZbiorkomPosition[] };
  const rawPositions = Array.isArray(json.positions) ? json.positions : [];

  const overrides = loadOperatorOverrides();
  const vehicles: LiveBusVehicle[] = [];
  const operatorBreakdown = { mzuk: 0, ska: 0, other: 0 };
  const delays: number[] = [];
  let onTimeCount = 0;
  let delayedCount = 0;
  let trackedOnTripCount = 0;

  for (const pos of rawPositions) {
    const vehicleId = String(pos.vehicle?.id ?? "").trim();
    const loc = pos.location;
    if (!vehicleId || !Array.isArray(loc) || loc.length < 2) continue;
    const [lon, lat] = loc;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const op = resolveWalbrzychOperator(vehicleId, pos.vehicle?.model, overrides);
    operatorBreakdown[op.key] += 1;

    const routeName = String(pos.routeName ?? "").trim();
    const brigade = rawBrigadeSignal(pos.brigade === undefined ? "" : String(pos.brigade));
    const rtMatch = tripMap.get(vehicleId);
    const tripId = rtMatch?.tripId ?? null;
    const tripStartMs = rtTripStartMs(rtMatch);
    if (tripId) trackedOnTripCount += 1;

    const delaySeconds = Math.round(Number(pos.delay ?? 0) / 1000);
    delays.push(delaySeconds);
    if (delaySeconds > 120) delayedCount += 1;
    else onTimeCount += 1;

    const rawColor = String(pos.routeColor ?? "").trim();
    const routeColor = rawColor
      ? rawColor.startsWith("#")
        ? rawColor
        : `#${rawColor}`
      : "#0d4f3b";

    vehicles.push({
      vehicleId,
      model: pos.vehicle?.model ?? null,
      operatorKey: op.key,
      operatorName: op.name,
      operatorSource: op.source,
      routeName,
      routeColor,
      brigade,
      rawBrigade: brigade,
      // Pełny kod zostanie nadany wyłącznie po potwierdzeniu w rozkładzie.
      kursowka: "",
      dutyCode: null,
      dutyStatus: "unresolved",
      dutyLine: null,
      dutySource: "none",
      dutyNote: "Numer brygady czeka na weryfikację w rozkładzie operatora.",
      tripId,
      tripStartMs,
      tripServiceDate: rtMatch?.startDate || null,
      tripRouteShort: rtMatch?.routeId ? rtMatch.routeId.trim().toUpperCase() : null,
      lat,
      lon,
      bearing: typeof pos.bearing === "number" ? pos.bearing : null,
      delaySeconds,
      speedKmh: trackSpeed(
        vehicleId,
        lat,
        lon,
        typeof pos.timestamp === "number" ? pos.timestamp : Date.now()
      ),
      headsign: pos.headsign ?? null,
      timestamp: typeof pos.timestamp === "number" ? pos.timestamp : Date.now(),
      upcomingStops: Array.isArray(pos.upcomingStops) ? pos.upcomingStops : [],
    });
  }

  pruneSpeedHistory();

  // Brygady: każdy wóz jest dopasowywany do rozkładu brygad po swoim kursie
  // (GTFS-RT: linia + godzina startu), a numer z wozu tylko to potwierdza.
  // Kod nigdy nie powstaje ze sklejenia aktualnej linii z numerem (np. 19/01).
  const fleet = resolveFleetDuties(vehicles);
  if (fleet.missingDates.length) ensureDutyRosters(fleet.missingDates);
  const dutiesResolved = fleet.vehicles;

  void persistLiveBrigades(dutiesResolved);

  const positiveDelays = delays.map((d) => Math.max(0, d));
  const avgDelaySeconds = positiveDelays.length
    ? Math.round(positiveDelays.reduce((a, b) => a + b, 0) / positiveDelays.length)
    : 0;
  const maxDelaySeconds = positiveDelays.length ? Math.max(...positiveDelays) : 0;
  const delayedShare = vehicles.length ? delayedCount / vehicles.length : 0;
  const congestionLevel: LiveTrafficSummary["congestionLevel"] =
    avgDelaySeconds >= 150 || delayedShare >= 0.35
      ? "wysoki"
      : avgDelaySeconds >= 45 || delayedShare >= 0.15
        ? "umiarkowany"
        : "niski";

  const recommendedPeakPercent = Math.min(
    80,
    Math.max(10, Math.round((avgDelaySeconds / 300) * 45 + delayedShare * 35))
  );

  const payload: LiveFleetPayload = {
    vehicles: dutiesResolved,
    traffic: {
      totalVehicles: dutiesResolved.length,
      trackedOnTripCount,
      avgDelaySeconds,
      maxDelaySeconds,
      delayedCount,
      onTimeCount,
      congestionLevel,
      recommendedPeakPercent,
      operatorBreakdown,
      fetchedAt: Date.now(),
    },
    source: "api.zbiorkom.live (MZUK / ŚKA Wałbrzych)",
  };

  liveCache = { at: Date.now(), data: payload };
  return payload;
}

let lastPersistAt = 0;

async function persistLiveBrigades(vehicles: LiveBusVehicle[]): Promise<void> {
  if (Date.now() - lastPersistAt < 25_000) return;
  lastPersistAt = Date.now();
  const candidates: LiveTripObservation[] = vehicles
    .filter(
      (v) =>
        v.tripId &&
        v.routeName &&
        v.dutyStatus === "confirmed" &&
        Boolean(v.dutyCode)
    )
    .map((v) => ({
      tripId: v.tripId!,
      routeShort: v.routeName.toUpperCase(),
      brigadeNum: v.dutyCode!.split("/")[1] ?? v.brigade,
      kursowkaCode: v.dutyCode!,
      dutyLine: v.dutyLine ?? null,
      verified: true as const,
      vehicleId: v.vehicleId,
      operatorName: v.operatorName,
      observedAt: Date.now(),
    }));
  if (!candidates.length) return;
  try {
    const changed = await upsertLiveObservations(candidates);
    if (changed) {
      for (const listener of observationListeners) listener();
    }
  } catch {
    // Non-fatal
  }
}
