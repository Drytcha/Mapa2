import { DateTime } from "luxon";
import {
  formatKilometresExact,
  formatServiceHours,
  summariseBrigade,
  type BrigadeMetrics,
} from "../brigadeMetrics";
import { getLatestFleetSnapshot } from "../core/runtimeHub";
import { compareLineCodes, dedupeLines, formatDutyCode, parseDutyPair } from "../core/text";
import { formatWarsawClock, WARSAW_ZONE } from "../core/time";
import { OPERATOR_STYLES } from "../transit";
import type { WalbrzychOperatorKey } from "../types";
import {
  buildBrigadesFromTrips,
  resolveActiveServices,
  type BuilderStop,
  type BuilderTrip,
} from "./brigadeBuilder";
import {
  resolveDutyOperator,
  resolveDutyOperatorForDate,
  rosterDutiesForTrips,
} from "./brigadeVerification";
import { OPERATOR_NAMES } from "./fleetOperators";
import {
  ensureGtfsSeeded,
  getTripLengthMap,
  type GtfsLineItem,
} from "./gtfsStore";
import { getLiveWalbrzychBuses } from "./gtfsRt";
import { blockNumber, fetchLiveTrips } from "./liveBrigades";
import { OFFICIAL_STOPS_BY_ID } from "./officialStops";
import { loadLiveObservations } from "./storage";

export const BRIGADE_ZONE = WARSAW_ZONE;
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
  shapeId?: string | null;
  operatorKey?: WalbrzychOperatorKey;
  vehicleId?: string;
}

export interface BrigadeItem {
  blockId: string;
  /** Real on-board duty number, e.g. "2-03" ("" for unconfirmed GTFS runs). */
  number: string;
  primaryLine: string;
  operatorKey: WalbrzychOperatorKey;
  operatorLabel: string;
  operatorName: string;
  serviceIds: string[];
  times: [number, number][];
  tripCount: number;
  workSpans: string[];
  lineIds: string[];
  source: "official_gtfs" | "live" | "gtfs";
  unassigned: boolean;
  trips: BrigadeTripView[];
  metrics: BrigadeMetrics;
  vehicleId?: string;
}

export interface BrigadesResult {
  items: BrigadeItem[];
  source: "official_gtfs" | "live" | "gtfs";
  /** Active GTFS service IDs on this date (e.g. ["387_RS"] or ["388_NH"]). */
  serviceIds?: string[];
  serviceLabel?: string;
  feedVersion?: string;
  feedSource?: string;
  /** Blocking problem (invalid date, no timetable). */
  error?: string;
  /** Non-blocking explanation. */
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
/*  Date & code helpers                                                       */
/* -------------------------------------------------------------------------- */

export const formatBrigadeClock = formatWarsawClock;

export function shiftDateId(dateId: string, days: number): string {
  const parsed = DateTime.fromFormat(dateId, "yyyyLLdd", {
    zone: BRIGADE_ZONE,
  });
  const base = parsed.isValid ? parsed : DateTime.now().setZone(BRIGADE_ZONE);
  return base.plus({ days }).toFormat("yyyyLLdd");
}

/** Yesterday / today / tomorrow in the Europe/Warsaw transit day (switch at 04:00). */
export function getActiveDates(now = Date.now()): BrigadeDate[] {
  let base = DateTime.fromMillis(now, { zone: BRIGADE_ZONE }).minus({
    minutes: 5,
  });
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
  const parsed = DateTime.fromFormat(dateId, "yyyyLLdd", {
    zone: BRIGADE_ZONE,
  });
  return parsed.isValid
    ? parsed.setLocale("pl").toFormat("cccc, d LLLL yyyy")
    : dateId;
}

export function describeServiceIds(serviceIds: Iterable<string>): string {
  const list = [...serviceIds];
  if (!list.length) return "";
  const labels = list.map((sid) => {
    const upper = sid.toUpperCase();
    const period = upper.includes("_") ? upper.split("_")[0] : "";
    const tag = period === "387" ? "XI" : period === "388" ? "XII" : period;
    if (upper.endsWith("_RS")) return tag ? `Roboczy (${tag})` : "Dzień roboczy";
    if (upper.endsWith("_SO")) return tag ? `Sobota (${tag})` : "Sobota";
    if (upper.endsWith("_NH")) return tag ? `Niedziela handlowa (${tag})` : "Niedziela handlowa";
    if (upper.endsWith("_NS")) return tag ? `Niedziela / Święto (${tag})` : "Niedziela / Święto";
    return sid;
  });
  return [...new Set(labels)].join(", ");
}

export function resolveBrigadeReference(
  initialKursowkaId?: string | null,
  initialKursowkaCode?: string | null
): { lineId?: string; brigadeNumber?: string } {
  const raw = (initialKursowkaCode || initialKursowkaId || "").trim();
  if (!raw) return {};
  const code = raw.includes("|") ? raw.split("|").at(-1) || "" : raw;
  const parsed = parseDutyPair(code);
  if (!parsed) return {};
  return {
    lineId: parsed.line,
    brigadeNumber: `${parsed.line}-${parsed.suffix}`,
  };
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
  if (boundaries.length % 2 !== 0) {
    boundaries.push(ordered[ordered.length - 1][1]);
  }
  const spans: string[] = [];
  for (let i = 0; i < boundaries.length; i += 2) {
    spans.push(
      `${formatBrigadeClock(boundaries[i])} – ${formatBrigadeClock(boundaries[i + 1])}`
    );
  }
  return spans;
}

export function brigadeMatchesVehicle(number: string, kursowka: string): boolean {
  if (!number || !kursowka) return false;
  return formatDutyCode(number, "-") === formatDutyCode(kursowka, "-");
}

export function mergeDutyTimes(
  existing: [number, number][],
  incoming: [number, number][]
): [number, number][] {
  return [
    ...new Map(
      [...existing, ...incoming].map((pair) => [`${pair[0]}:${pair[1]}`, pair])
    ).values(),
  ].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function compareBrigadeNumbers(a: string, b: string): number {
  const pa = parseDutyPair(a);
  const pb = parseDutyPair(b);
  if (pa && pb) {
    const lineCmp = compareLineCodes(pa.line, pb.line);
    if (lineCmp !== 0) return lineCmp;
    return Number(pa.suffix) - Number(pb.suffix);
  }
  return a.localeCompare(b, "pl", { numeric: true });
}

/* -------------------------------------------------------------------------- */
/*  Official GTFS Brigade Catalogue (gtfs.walbrzych.eu + ŚKA / MZUK)          */
/* -------------------------------------------------------------------------- */

export async function loadBrigades(
  _routes: GtfsLineItem[],
  lineId: string,
  dateId: string,
  _signal?: AbortSignal
): Promise<BrigadesResult> {
  const store = await ensureGtfsSeeded();
  const feedFrom = store.base.feedStartDate;
  const feedTo = store.base.feedEndDate;
  const feedVersion = store.base.feedVersion;
  const feedSource = store.feed.source;
  const dateKey = Number(dateId);

  const resolved = resolveActiveServices(dateKey, store.base.serviceIdsByDate, {
    from: feedFrom,
    to: feedTo,
  });
  if (!resolved.services) {
    return {
      items: [],
      source: "gtfs",
      error: resolved.error,
      feedFrom,
      feedTo,
      feedVersion,
      feedSource,
    };
  }

  const activeServices = resolved.services;
  const serviceList = [...activeServices].sort();
  const serviceLabel = describeServiceIds(serviceList);

  const day = DateTime.fromFormat(dateId, "yyyyLLdd", { zone: BRIGADE_ZONE });
  const dayStartMs = (
    day.isValid ? day.startOf("day") : DateTime.now().setZone(BRIGADE_ZONE).startOf("day")
  ).toMillis();

  const tripLengths = await getTripLengthMap();
  const officialById = OFFICIAL_STOPS_BY_ID;

  const toStop = (id: string, fallbackName: string): BrigadeStop => {
    const gtfs = store.base.stopsById.get(id);
    const official = officialById.get(id);
    return {
      id,
      name: gtfs?.name ?? official?.name ?? fallbackName,
      lat: gtfs?.lat ?? official?.lat,
      lon: gtfs?.lon ?? official?.lon,
    };
  };

  // Check live GPS fleet for vehicle attribution
  const liveVehicleByDuty = new Map<string, string>();
  const liveSnapshot =
    getLatestFleetSnapshot() ??
    (await getLiveWalbrzychBuses().catch(() => ({ vehicles: [] })));
  for (const bus of liveSnapshot.vehicles) {
    if (bus.dutyStatus === "confirmed" && bus.dutyCode) {
      liveVehicleByDuty.set(formatDutyCode(bus.dutyCode, "-"), bus.vehicleId);
    }
  }

  // Partition day's trips into official block_id brigades vs any unassigned trips
  const groupedOfficial = new Map<
    string,
    {
      number: string;
      primaryLine: string;
      operatorCounts: Record<WalbrzychOperatorKey, number>;
      serviceIds: Set<string>;
      lineIds: Set<string>;
      trips: BrigadeTripView[];
    }
  >();
  const unnumberedRaw: typeof store.base.rawTrips = [];

  for (const rawTrip of store.base.rawTrips) {
    if (!activeServices.has(rawTrip.serviceId)) continue;
    if (!rawTrip.kursowkaCode) {
      unnumberedRaw.push(rawTrip);
      continue;
    }

    const dashNumber = formatDutyCode(rawTrip.kursowkaCode, "-");
    const parsedPair = parseDutyPair(dashNumber);
    const primaryLine = parsedPair?.line ?? rawTrip.routeShort.toUpperCase();
    const lineShort = (
      store.base.routesById.get(rawTrip.routeId)?.shortName ?? rawTrip.routeShort
    ).toUpperCase();

    const opKey =
      rawTrip.operatorKey !== "other"
        ? rawTrip.operatorKey
        : resolveDutyOperator(rawTrip.serviceId, rawTrip.kursowkaCode);

    let bucket = groupedOfficial.get(dashNumber);
    if (!bucket) {
      bucket = {
        number: dashNumber,
        primaryLine,
        operatorCounts: { mzuk: 0, ska: 0, other: 0 },
        serviceIds: new Set<string>(),
        lineIds: new Set<string>(),
        trips: [],
      };
      groupedOfficial.set(dashNumber, bucket);
    }
    bucket.operatorCounts[opKey] += 1;
    bucket.serviceIds.add(rawTrip.serviceId);
    bucket.lineIds.add(lineShort);

    const startMs = dayStartMs + rawTrip.startMinutes * 60_000;
    const endMs = dayStartMs + rawTrip.endMinutes * 60_000;
    bucket.trips.push({
      id: rawTrip.rawTripId,
      lineId: lineShort,
      destination: rawTrip.headsign || rawTrip.lastStopName,
      length: tripLengths.get(rawTrip.rawTripId) ?? 0,
      startMs,
      endMs,
      firstStop: toStop(rawTrip.firstStopId, rawTrip.firstStopName),
      lastStop: toStop(rawTrip.lastStopId, rawTrip.lastStopName),
      shapeId: rawTrip.shapeId,
      operatorKey: opKey,
    });
  }

  const items: BrigadeItem[] = [];

  for (const bucket of groupedOfficial.values()) {
    bucket.trips.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
    let operatorKey: WalbrzychOperatorKey =
      bucket.operatorCounts.mzuk > 0 && bucket.operatorCounts.mzuk >= bucket.operatorCounts.ska
        ? "mzuk"
        : bucket.operatorCounts.ska > 0
          ? "ska"
          : resolveDutyOperatorForDate(dateId, bucket.number, bucket.serviceIds);

    const times: [number, number][] = bucket.trips.map((t) => [t.startMs, t.endMs]);
    const metrics = summariseBrigade(bucket.trips);
    const lineIds = dedupeLines(bucket.lineIds);

    items.push({
      blockId: `${dateId}_${bucket.number}`,
      number: bucket.number,
      primaryLine: bucket.primaryLine,
      operatorKey,
      operatorLabel: OPERATOR_STYLES[operatorKey].label,
      operatorName: OPERATOR_NAMES[operatorKey],
      serviceIds: [...bucket.serviceIds].sort(),
      times,
      tripCount: bucket.trips.length,
      workSpans: computeWorkSpans(times),
      lineIds,
      source: "official_gtfs",
      unassigned: false,
      trips: bucket.trips,
      metrics,
      vehicleId: liveVehicleByDuty.get(bucket.number),
    });
  }

  // Fallback only if feed contains trips without block_id
  if (unnumberedRaw.length > 0) {
    const fallbackItems = await buildFallbackUnnumberedBrigades(
      store,
      unnumberedRaw,
      dateId,
      dayStartMs,
      tripLengths,
      toStop
    );
    items.push(...fallbackItems);
  }

  items.sort(
    (a, b) =>
      Number(a.unassigned) - Number(b.unassigned) ||
      compareBrigadeNumbers(a.number, b.number)
  );

  const wantedLine = lineId.trim().toUpperCase();
  const filteredByLine =
    wantedLine === "ALL"
      ? items
      : items.filter(
          (item) =>
            item.unassigned ||
            item.lineIds.includes(wantedLine) ||
            item.primaryLine === wantedLine
        );

  return {
    items: filteredByLine,
    source: unnumberedRaw.length === 0 ? "official_gtfs" : "gtfs",
    serviceIds: serviceList,
    serviceLabel,
    feedVersion,
    feedSource,
    feedFrom,
    feedTo,
  };
}

async function buildFallbackUnnumberedBrigades(
  store: Awaited<ReturnType<typeof ensureGtfsSeeded>>,
  rawSubList: Awaited<ReturnType<typeof ensureGtfsSeeded>>["base"]["rawTrips"],
  dateId: string,
  dayStartMs: number,
  tripLengths: Map<string, number>,
  toStop: (id: string, fallbackName: string) => BrigadeStop
): Promise<BrigadeItem[]> {
  const confirmed = new Map<string, string>();
  for (const obs of await loadLiveObservations()) {
    if (obs.tripId && obs.kursowkaCode && obs.verified) {
      confirmed.set(obs.tripId, obs.kursowkaCode.toUpperCase());
    }
  }

  const stops: Map<string, BuilderStop> = new Map();
  for (const [id, stop] of store.base.stopsById) {
    stops.set(id, { lat: stop.lat, lon: stop.lon });
  }

  const builderTrips: BuilderTrip[] = rawSubList.map((rawTrip) => {
    const line = (
      store.base.routesById.get(rawTrip.routeId)?.shortName ?? rawTrip.routeShort
    ).toUpperCase();
    return {
      id: rawTrip.rawTripId,
      line,
      headsign: rawTrip.headsign,
      startMinutes: rawTrip.startMinutes,
      endMinutes: rawTrip.endMinutes,
      firstStopId: rawTrip.firstStopId,
      lastStopId: rawTrip.lastStopId,
      firstStopName: rawTrip.firstStopName,
      lastStopName: rawTrip.lastStopName,
      lengthMeters: tripLengths.get(rawTrip.rawTripId) ?? 0,
      observedBrigade: confirmed.get(rawTrip.rawTripId),
    };
  });

  const dutyByTrip = rosterDutiesForTrips(
    dateId,
    builderTrips.map((trip) => ({
      id: trip.id,
      line: trip.line,
      startMs: dayStartMs + trip.startMinutes * 60_000,
    }))
  );
  for (const trip of builderTrips) {
    const rosterDuty = dutyByTrip.get(trip.id);
    if (!trip.observedBrigade && rosterDuty) {
      trip.observedBrigade = formatDutyCode(rosterDuty, "-");
    }
  }

  const built = buildBrigadesFromTrips({
    trips: builderTrips,
    stops,
    attachUnconfirmedToConfirmed: false,
  });

  const out: BrigadeItem[] = [];
  for (const brigade of built) {
    if (brigade.unassigned) continue;
    const opKey = resolveDutyOperatorForDate(dateId, brigade.number);
    const trips: BrigadeTripView[] = brigade.trips.map((trip) => ({
      id: trip.id,
      lineId: trip.line,
      destination: trip.headsign || trip.lastStopName,
      length: tripLengths.get(trip.id) ?? trip.lengthMeters,
      startMs: dayStartMs + trip.startMinutes * 60_000,
      endMs: dayStartMs + trip.endMinutes * 60_000,
      firstStop: toStop(trip.firstStopId, trip.firstStopName),
      lastStop: toStop(trip.lastStopId, trip.lastStopName),
      operatorKey: opKey,
      vehicleId: trip.vehicleId,
    }));
    const times: [number, number][] = trips.map((t) => [t.startMs, t.endMs]);
    out.push({
      blockId: `${dateId}_${brigade.number}`,
      number: brigade.number,
      primaryLine: brigade.primaryLine,
      operatorKey: opKey,
      operatorLabel: OPERATOR_STYLES[opKey].label,
      operatorName: OPERATOR_NAMES[opKey],
      serviceIds: [],
      times,
      tripCount: trips.length,
      workSpans: computeWorkSpans(times),
      lineIds: dedupeLines(brigade.lineIds),
      source: "gtfs",
      unassigned: false,
      trips,
      metrics: summariseBrigade(trips),
      vehicleId: brigade.vehicleId,
    });
  }

  const loose = built.filter((b) => b.unassigned).flatMap((b) => b.trips);
  if (loose.length > 0) {
    const sortedLoose = [...loose]
      .sort((a, b) => a.startMinutes - b.startMinutes || a.id.localeCompare(b.id))
      .slice(0, 400);
    const trips: BrigadeTripView[] = sortedLoose.map((trip) => ({
      id: trip.id,
      lineId: trip.line,
      destination: trip.headsign || trip.lastStopName,
      length: tripLengths.get(trip.id) ?? trip.lengthMeters,
      startMs: dayStartMs + trip.startMinutes * 60_000,
      endMs: dayStartMs + trip.endMinutes * 60_000,
      firstStop: toStop(trip.firstStopId, trip.firstStopName),
      lastStop: toStop(trip.lastStopId, trip.lastStopName),
      operatorKey: "other",
      vehicleId: trip.vehicleId,
    }));
    const times: [number, number][] = trips.map((t) => [t.startMs, t.endMs]);
    out.push({
      blockId: `${dateId}_unassigned`,
      number: "",
      primaryLine: "",
      operatorKey: "other",
      operatorLabel: OPERATOR_STYLES.other.label,
      operatorName: OPERATOR_NAMES.other,
      serviceIds: [],
      times,
      tripCount: loose.length,
      workSpans: computeWorkSpans(times),
      lineIds: dedupeLines(loose.map((t) => t.line)),
      source: "gtfs",
      unassigned: true,
      trips,
      metrics: summariseBrigade(trips),
    });
  }

  return out;
}

/** Full trip list of a duty — already populated in O(1) for gtfs.walbrzych.eu duties. */
export async function loadBrigadeTrips(
  item: BrigadeItem,
  _signal?: AbortSignal
): Promise<BrigadeTripView[]> {
  if (item.unassigned || item.trips.length > 0) return item.trips;

  const raw = await fetchLiveTrips(item.blockId);
  if (!raw.length) return item.trips;

  const officialById = OFFICIAL_STOPS_BY_ID;
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

  const tripLengths = await getTripLengthMap();
  return raw
    .map((trip) => {
      const first = trip.stops[0];
      const last = trip.stops[trip.stops.length - 1];
      return {
        id: trip.id,
        lineId: trip.lineId,
        destination: trip.destination || "Kurs techniczny",
        length: trip.length > 0 ? trip.length : (tripLengths.get(trip.id) ?? 0),
        startMs: first?.scheduled ?? 0,
        endMs: last?.scheduled ?? 0,
        firstStop: resolveStop(first),
        lastStop: resolveStop(last),
        operatorKey: item.operatorKey,
        vehicleId: trip.vehicleId,
      };
    })
    .sort((a, b) => a.startMs - b.startMs);
}

/** Generuje plik CSV rozliczenia brygad (firmy, km, godziny, linie) dla planisty. */
export function buildBrigadesCsv(items: BrigadeItem[], dateId: string): string {
  const escapeCsv = (val: string | number) => {
    const str = String(val);
    return /[;"\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const header = [
    "Data",
    "Brygada",
    "Przewoznik",
    "Linia glowna",
    "Obslugiwane linie",
    "Typ brygady",
    "Kursy",
    "Godziny pracy",
    "Rozpietosc sluzby",
    "Czas blokow pracy",
    "Czas jazdy",
    "Postoje wyrownawcze",
    "Przerwa miedzyszczytowa",
    "Km liniowe (GTFS)",
    "Przejazdy miedzy krancami (szac.)",
    "Km lacznie",
    "Predkosc komunikacyjna (km/h)",
    "Podzial km wg linii",
  ];
  const rows = items
    .filter((item) => !item.unassigned)
    .map((item) => {
      const m = item.metrics;
      const dutyCode = formatDutyCode(item.number, "/");
      const lineShare = m.lineBreakdown
        .map(
          (l) =>
            `${l.lineId}: ${(l.meters / 1000).toFixed(1).replace(".", ",")} km (${l.trips} k.)`
        )
        .join(", ");
      return [
        dateId,
        dutyCode,
        item.operatorLabel,
        item.primaryLine,
        item.lineIds.join(", "),
        m.shiftCount >= 2 ? `Przerywana (${m.shiftCount} bloki)` : "Ciagla",
        m.trips,
        item.workSpans.join(" / "),
        formatServiceHours(m.durationMinutes),
        formatServiceHours(m.workBlockMinutes),
        formatServiceHours(m.drivingMinutes),
        formatServiceHours(m.layoverMinutes),
        m.splitBreakMinutes > 0 ? formatServiceHours(m.splitBreakMinutes) : "0 min",
        formatKilometresExact(m.revenueMeters).replace(" km", ""),
        formatKilometresExact(m.deadheadMeters).replace(" km", ""),
        formatKilometresExact(m.totalWithDeadheadMeters).replace(" km", ""),
        String(m.commercialSpeedKmh).replace(".", ","),
        lineShare,
      ]
        .map(escapeCsv)
        .join(";");
    });
  return `\uFEFF${header.join(";")}\n${rows.join("\n")}\n`;
}
