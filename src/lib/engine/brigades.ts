import { DateTime } from "luxon";
import { ensureGtfsSeeded, type GtfsLineItem } from "./gtfsStore";
import { loadOfficialStops } from "./officialStops";
import { loadLiveObservations } from "./storage";
import { getLiveWalbrzychBuses } from "./gtfsRt";
import { blockNumber, fetchLiveBlocks, fetchLiveTrips } from "./liveBrigades";
import { dutyCodeFromBlock } from "./brigadeVerification";
import {
  buildBrigadesFromTrips,
  resolveActiveServices,
  type BuilderTrip,
  type BuilderStop,
} from "./brigadeBuilder";

export const BRIGADE_ZONE = "Europe/Warsaw";
const WORK_BLOCK_GAP_MS = 1.5 * 60 * 60 * 1000;

export interface BrigadeStop {
  id: string;
  name: string;
  lat?: number;
  lon?: number;
}

export interface BrigadeTripView {
  id: string;
  lineId: string;
  destination: string;
  length: number;
  startMs: number;
  endMs: number;
  firstStop: BrigadeStop;
  lastStop: BrigadeStop;
  vehicleId?: string;
}

export interface BrigadeItem {
  blockId: string;
  /** Real on-board duty number, e.g. "2-03" ("" for unconfirmed GTFS runs). */
  number: string;
  primaryLine: string;
  times: [number, number][];
  tripCount: number;
  workSpans: string[];
  lineIds: string[];
  source: "live" | "gtfs";
  unassigned: boolean;
  trips: BrigadeTripView[];
  vehicleId?: string;
}

export interface BrigadesResult {
  items: BrigadeItem[];
  source: "live" | "gtfs";
  /** Blocking problem (invalid date, no timetable). */
  error?: string;
  /** Non-blocking explanation (e.g. live roster unavailable for this date). */
  notice?: string;
  feedFrom: number;
  feedTo: number;
}

export interface BrigadeDate {
  id: string;
  offset: number;
  label: string;
  shortDate: string;
  weekday: string;
  current: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Date helpers                                                              */
/* -------------------------------------------------------------------------- */

export function formatBrigadeClock(ms: number): string {
  return DateTime.fromMillis(ms, { zone: BRIGADE_ZONE }).toFormat("HH:mm");
}

export function shiftDateId(dateId: string, days: number): string {
  const parsed = DateTime.fromFormat(dateId, "yyyyLLdd", { zone: BRIGADE_ZONE });
  const base = parsed.isValid ? parsed : DateTime.now().setZone(BRIGADE_ZONE);
  return base.plus({ days }).toFormat("yyyyLLdd");
}

/** Yesterday / today / tomorrow in the Europe/Warsaw transit day (switch at 04:00). */
export function getActiveDates(now = Date.now()): BrigadeDate[] {
  let base = DateTime.fromMillis(now, { zone: BRIGADE_ZONE }).minus({ minutes: 5 });
  if (base.hour < 4) base = base.minus({ days: 1 });
  return [-1, 0, 1].map((offset) => {
    const date = base.plus({ days: offset });
    return {
      id: date.toFormat("yyyyLLdd"),
      offset,
      label: offset === -1 ? "Wczoraj" : offset === 1 ? "Jutro" : "Dziś",
      shortDate: date.setLocale("pl").toFormat("d LLL"),
      weekday: date.setLocale("pl").toFormat("ccc"),
      current: offset === 0,
    };
  });
}

export function formatBrigadeDate(dateId: string): string {
  const parsed = DateTime.fromFormat(dateId, "yyyyLLdd", { zone: BRIGADE_ZONE });
  return parsed.isValid ? parsed.setLocale("pl").toFormat("cccc, d LLLL yyyy") : dateId;
}

export function resolveBrigadeReference(
  initialKursowkaId?: string | null,
  initialKursowkaCode?: string | null
): { lineId?: string; brigadeNumber?: string } {
  const raw = (initialKursowkaCode || initialKursowkaId || "").trim();
  if (!raw) return {};
  const code = raw.includes("|") ? raw.split("|").at(-1) || "" : raw;
  const match = code.trim().match(/^([A-Za-z0-9]+)\s*[/:\-]\s*(\d+)$/);
  if (!match) return {};
  const line = match[1].toUpperCase();
  return { lineId: line, brigadeNumber: `${line}-${match[2].padStart(2, "0")}` };
}

export function brigadeNumber(blockId: string): string {
  return blockNumber(blockId);
}

/** Split a duty into work spans at breaks > 1.5 h. */
export function computeWorkSpans(times: [number, number][]): string[] {
  if (!times.length) return [];
  const ordered = [...times].sort((a, b) => a[0] - b[0]);
  const boundaries: number[] = [ordered[0][0]];
  for (let i = 1; i < ordered.length; i += 1) {
    const prevEnd = ordered[i - 1][1];
    const nextStart = ordered[i][0];
    if (nextStart - prevEnd > WORK_BLOCK_GAP_MS) {
      boundaries.push(prevEnd);
      boundaries.push(nextStart);
    }
  }
  if (boundaries.length % 2 !== 0) boundaries.push(ordered[ordered.length - 1][1]);
  const spans: string[] = [];
  for (let i = 0; i < boundaries.length; i += 2) {
    spans.push(`${formatBrigadeClock(boundaries[i])} – ${formatBrigadeClock(boundaries[i + 1])}`);
  }
  return spans;
}

export function brigadeMatchesVehicle(number: string, kursowka: string): boolean {
  if (!number) return false;
  const norm = (value: string) => {
    const clean = value.trim().toUpperCase().replace(/\s+/g, "");
    const match = clean.match(/^([A-Za-z0-9]+)[/:\-](\d+)$/);
    return match ? `${match[1]}-${match[2].padStart(2, "0")}` : clean;
  };
  return norm(number) === norm(kursowka);
}

/* -------------------------------------------------------------------------- */
/*  Catalogue                                                                 */
/* -------------------------------------------------------------------------- */

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
      while (next < items.length) {
        const index = next++;
        result[index] = await worker(items[index]);
      }
    })
  );
  return result;
}

export async function loadBrigades(
  routes: GtfsLineItem[],
  lineId: string,
  dateId: string,
  _signal?: AbortSignal
): Promise<BrigadesResult> {
  const store = await ensureGtfsSeeded();
  const feedFrom = store.base.feedStartDate;
  const feedTo = store.base.feedEndDate;
  const dateKey = Number(dateId);

  // Only the timetable that is actually valid on THIS date.
  const resolved = resolveActiveServices(dateKey, store.base.serviceIdsByDate, {
    from: feedFrom,
    to: feedTo,
  });
  if (!resolved.services) {
    return { items: [], source: "gtfs", error: resolved.error, feedFrom, feedTo };
  }

  // 1) Primary source: real duty rosters (numbers come from the operator).
  try {
    type Entry = { times: [number, number][]; lines: Set<string> };
    const merged = new Map<string, Entry>();

    if (lineId === "all") {
      const fetched = await mapLimit(routes, 4, async (route) => {
        const line = route.shortName.toUpperCase();
        try {
          return { line, blocks: await fetchLiveBlocks(line, dateId) };
        } catch {
          return { line, blocks: [] };
        }
      });
      for (const { line, blocks } of fetched) {
        for (const block of blocks) {
          const entry = merged.get(block.blockId) ?? { times: [], lines: new Set<string>() };
          entry.times = block.times;
          entry.lines.add(line);
          merged.set(block.blockId, entry);
        }
      }
    } else {
      const selected = lineId.toUpperCase();
      const blocks = await fetchLiveBlocks(selected, dateId);
      for (const block of blocks) {
        const number = blockNumber(block.blockId);
        merged.set(block.blockId, {
          times: block.times,
          lines: new Set([number.split("-")[0], selected]),
        });
      }
    }

    if (merged.size > 0) {
      const items: BrigadeItem[] = [...merged.entries()]
        .flatMap(([blockId, entry]) => {
          const number = blockNumber(blockId);
          // Numer brygady musi mieć prawdziwy prefiks linii z rozkładu.
          // Dzięki temu „WY/04” nigdy nie trafi do katalogu.
          const verified = dutyCodeFromBlock(number);
          if (!verified) return [];
          const dutyLine = verified.split("/")[0];
          const lines = new Set(entry.lines);
          if (number.includes("-")) lines.add(dutyLine);
          const times = [...entry.times].sort((a, b) => a[0] - b[0]);
          return [{
            blockId,
            number,
            primaryLine: dutyLine,
            times,
            tripCount: times.length,
            workSpans: computeWorkSpans(times),
            lineIds: [...lines].filter(Boolean).sort((a, b) =>
              a.localeCompare(b, "pl", { numeric: true })
            ),
            source: "live" as const,
            unassigned: false,
            trips: [],
          }];
        })
        .sort((a, b) => a.number.localeCompare(b.number, "pl", { numeric: true }));

      return { items, source: "live", feedFrom, feedTo };
    }
  } catch {
    /* Network unavailable — fall back to the local GTFS reconstruction. */
  }

  // 2) Fallback: reconstruct runs from GTFS, without inventing duty numbers.
  const fallback = await buildLocalBrigades(store, lineId, dateId, resolved.services);
  return {
    items: fallback,
    source: "gtfs",
    feedFrom,
    feedTo,
    notice:
      "Źródło potwierdzonych numerów brygad udostępnia rozkład na Wczoraj / Dziś / Jutro. Dla tej daty pokazano kursy z GTFS w jednej grupie bez przypisanego numeru — numery nie są wymyślane.",
  };
}

/** GTFS-only reconstruction: honest "?" group, no fictional numbers. */
async function buildLocalBrigades(
  store: Awaited<ReturnType<typeof ensureGtfsSeeded>>,
  lineId: string,
  dateId: string,
  activeServices: Set<string>
): Promise<BrigadeItem[]> {
  const day = DateTime.fromFormat(dateId, "yyyyLLdd", { zone: BRIGADE_ZONE });
  const dayStart = day.isValid
    ? day.startOf("day")
    : DateTime.now().setZone(BRIGADE_ZONE).startOf("day");

  const confirmed = new Map<string, string>();
  for (const obs of await loadLiveObservations()) {
    if (obs.tripId && obs.kursowkaCode && obs.verified) {
      confirmed.set(obs.tripId, obs.kursowkaCode.toUpperCase());
    }
  }
  try {
    const { vehicles } = await getLiveWalbrzychBuses();
    for (const bus of vehicles) {
      if (bus.tripId && bus.dutyStatus === "confirmed" && bus.dutyCode) {
        confirmed.set(bus.tripId, bus.dutyCode.toUpperCase());
      }
    }
  } catch {
    /* GPS offline */
  }

  const stops: Map<string, BuilderStop> = new Map();
  for (const [id, stop] of store.base.stopsById) {
    stops.set(id, { lat: stop.lat, lon: stop.lon });
  }

  const trips: BuilderTrip[] = [];
  for (const rawTrip of store.base.rawTrips) {
    if (!activeServices.has(rawTrip.serviceId)) continue;
    const line = (
      store.base.routesById.get(rawTrip.routeId)?.shortName ?? rawTrip.routeShort
    ).toUpperCase();
    trips.push({
      id: rawTrip.rawTripId,
      line,
      headsign: rawTrip.headsign,
      startMinutes: rawTrip.startMinutes,
      endMinutes: rawTrip.endMinutes,
      firstStopId: rawTrip.firstStopId,
      lastStopId: rawTrip.lastStopId,
      firstStopName: rawTrip.firstStopName,
      lastStopName: rawTrip.lastStopName,
      lengthMeters: 0,
      observedBrigade: confirmed.get(rawTrip.rawTripId),
    });
  }

  const built = buildBrigadesFromTrips({ trips, stops });
  const confirmedBuilt = built.filter((b) => !b.unassigned);
  const looseTrips = built
    .filter((b) => b.unassigned)
    .flatMap((b) => b.trips)
    .filter((trip) => lineId === "all" || trip.line === lineId.toUpperCase());

  const toStop = (id: string, fallbackName: string): BrigadeStop => {
    const gtfs = store.base.stopsById.get(id);
    let official: { name: string; lat: number; lon: number } | undefined;
    try {
      official = loadOfficialStops().stops.find((s) => String(s.id) === id);
    } catch {
      official = undefined;
    }
    return {
      id,
      name: official?.name ?? gtfs?.name ?? fallbackName,
      lat: official?.lat ?? gtfs?.lat,
      lon: official?.lon ?? gtfs?.lon,
    };
  };

  // Confirmed duties always come from real observations, never generated labels.
  const items: BrigadeItem[] = confirmedBuilt.map((brigade) => {
    const times: [number, number][] = brigade.trips.map((trip) => [
      dayStart.plus({ minutes: trip.startMinutes }).toMillis(),
      dayStart.plus({ minutes: trip.endMinutes }).toMillis(),
    ]);
    return {
      blockId: `${dateId}_${brigade.number}`,
      number: brigade.number,
      primaryLine: brigade.primaryLine,
      times,
      tripCount: brigade.trips.length,
      workSpans: computeWorkSpans(times),
      lineIds: brigade.lineIds,
      source: "live",
      unassigned: false,
      trips: brigade.trips.map((trip) => ({
        id: trip.id,
        lineId: trip.line,
        destination: trip.headsign || trip.lastStopName,
        length: trip.lengthMeters,
        startMs: dayStart.plus({ minutes: trip.startMinutes }).toMillis(),
        endMs: dayStart.plus({ minutes: trip.endMinutes }).toMillis(),
        firstStop: toStop(trip.firstStopId, trip.firstStopName),
        lastStop: toStop(trip.lastStopId, trip.lastStopName),
        vehicleId: trip.vehicleId,
      })),
    };
  });

  if (looseTrips.length) {
    const times: [number, number][] = looseTrips.map((trip) => [
      dayStart.plus({ minutes: trip.startMinutes }).toMillis(),
      dayStart.plus({ minutes: trip.endMinutes }).toMillis(),
    ]);
    items.push({
      blockId: `${dateId}_unassigned`,
      number: "",
      primaryLine: lineId === "all" ? "" : lineId.toUpperCase(),
      times,
      tripCount: looseTrips.length,
      workSpans: computeWorkSpans(times),
      lineIds: [...new Set(looseTrips.map((trip) => trip.line))],
      source: "gtfs",
      unassigned: true,
      trips: looseTrips
        .sort((a, b) => a.startMinutes - b.startMinutes || a.id.localeCompare(b.id))
        .slice(0, 400)
        .map((trip) => ({
          id: trip.id,
          lineId: trip.line,
          destination: trip.headsign || trip.lastStopName,
          length: trip.lengthMeters,
          startMs: dayStart.plus({ minutes: trip.startMinutes }).toMillis(),
          endMs: dayStart.plus({ minutes: trip.endMinutes }).toMillis(),
          firstStop: toStop(trip.firstStopId, trip.firstStopName),
          lastStop: toStop(trip.lastStopId, trip.lastStopName),
          vehicleId: trip.vehicleId,
        })),
    });
  }

  return items.filter(
    (item) => lineId === "all" || item.unassigned || item.lineIds.includes(lineId.toUpperCase())
  );
}

/** Full trip list of a duty — from the live roster when available. */
export async function loadBrigadeTrips(
  item: BrigadeItem,
  _signal?: AbortSignal
): Promise<BrigadeTripView[]> {
  if (item.unassigned || item.trips.length) return item.trips;

  const raw = await fetchLiveTrips(item.blockId);
  if (!raw.length) return item.trips;

  type StopInfo = { name: string; lat: number; lon: number };
  const officialById = new Map<string, StopInfo>();
  try {
    for (const stop of loadOfficialStops().stops) {
      officialById.set(String(stop.id), { name: stop.name, lat: stop.lat, lon: stop.lon });
    }
  } catch {
    /* names from the API fallback below */
  }

  const resolveStop = (rawStop?: { id: string; scheduled: number }): BrigadeStop => {
    if (!rawStop) return { id: "", name: "—" };
    const official = officialById.get(String(rawStop.id));
    return {
      id: String(rawStop.id),
      name: official?.name ?? `Przystanek ${rawStop.id}`,
      lat: official?.lat,
      lon: official?.lon,
    };
  };

  return raw
    .map((trip) => {
      const first = trip.stops[0];
      const last = trip.stops[trip.stops.length - 1];
      return {
        id: trip.id,
        lineId: trip.lineId,
        destination: trip.destination || "Kurs techniczny",
        length: trip.length,
        startMs: first?.scheduled ?? 0,
        endMs: last?.scheduled ?? 0,
        firstStop: resolveStop(first),
        lastStop: resolveStop(last),
        vehicleId: trip.vehicleId,
      };
    })
    .sort((a, b) => a.startMs - b.startMs);
}
