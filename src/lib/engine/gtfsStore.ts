import { strFromU8, unzipSync } from "fflate";
import { DateTime } from "luxon";
import { formatVehicleNumber } from "../delay";
import { assetUrl } from "../services";
import { normalizeDutyCode, serviceForDate } from "../transit";
import type { LiveBusVehicle, StopDepartureItem, WalbrzychOperatorKey } from "../types";
import { assignDuties, type DutyObservation, type ScheduleTrip } from "./dutyAssignment";
import { getLiveWalbrzychBuses, subscribeObservationUpdates } from "./gtfsRt";
import { idbGetKv, idbSetKv, loadLiveObservations } from "./storage";

export const DUTY_SCHEMA_VERSION = "gps-anchored-v3";
const LIVE_GTFS_URL = "https://api.zbiorkom.live/api6-open/walbrzych/gtfs/default";
const ARCHIVE_KV_KEY = "gtfs_archive_v1";
const ARCHIVE_MAX_AGE_MS = 12 * 3600 * 1000;
const ZONE = "Europe/Warsaw";

export interface GtfsFeedInfo {
  id: string;
  source: string;
  version: string;
  generatedAt: string;
  stopsCount: number;
  routesCount: number;
  tripsCount: number;
  kursowkiCount: number;
}

export interface GtfsRouteRecord {
  id: string;
  shortName: string;
  longName: string;
  color: string;
  textColor: string;
  agencyName: string;
  sortOrder: number;
}

export interface GtfsStopRecord {
  id: string;
  name: string;
  normalizedName: string;
  lat: number;
  lon: number;
  code: string | null;
  platformCode: string | null;
  agency: string;
}

export interface GtfsServiceRecord {
  serviceId: string;
  label: string;
  datesJson: number[];
}

export interface GtfsKursowkaRecord {
  id: string;
  routeId: string;
  routeShort: string;
  serviceId: string;
  kursowkaCode: string;
  brigadeNum: string;
  source: string;
  tripCount: number;
  firstDepartureMin: number;
  lastArrivalMin: number;
}

export interface GtfsTripRecord {
  id: string;
  rawTripId: string;
  routeId: string;
  serviceId: string;
  kursowkaId: string;
  kursowkaCode: string;
  brigadeNum: string;
  brigadeSource: string;
  headsign: string;
  directionId: number;
  shapeId: string | null;
  startMinutes: number;
  endMinutes: number;
  firstStopName: string;
  lastStopName: string;
  stopCount: number;
}

export interface GtfsStopTimeRecord {
  tripId: string;
  stopId: string;
  stopSequence: number;
  arrivalMinutes: number;
  departureMinutes: number;
  pickupType: number;
  dropOffType: number;
}

interface RawTripDetail {
  rawTripId: string;
  routeId: string;
  routeShort: string;
  serviceId: string;
  rawBrigade: string;
  headsign: string;
  directionId: number;
  shapeId: string | null;
  startMinutes: number;
  endMinutes: number;
  firstStopId: string;
  lastStopId: string;
  firstStopName: string;
  lastStopName: string;
  stopCount: number;
}

interface ParsedArchiveBase {
  source: string;
  feedVersion: string;
  routes: GtfsRouteRecord[];
  routesById: Map<string, GtfsRouteRecord>;
  stops: GtfsStopRecord[];
  stopsById: Map<string, GtfsStopRecord>;
  services: GtfsServiceRecord[];
  dayTypeServices: Record<string, Set<string>>;
  rawTrips: RawTripDetail[];
  rawTripsById: Map<string, RawTripDetail>;
  rawStopTimesByTrip: Map<string, GtfsStopTimeRecord[]>;
  shapesById: Map<string, [number, number][]>;
  linesByStopId: Map<string, Set<string>>;
  topDestByStopId: Map<string, string>;
}

interface StopTimeWithTripMeta {
  tripId: string;
  rawTripId: string;
  departureMinutes: number;
  arrivalMinutes: number;
  routeId: string;
  serviceId: string;
  kursowkaId: string;
  kursowkaCode: string;
  brigadeSource: string;
  headsign: string;
  directionId: number;
  lastStopName: string;
}

export interface GtfsMemoryStore {
  base: ParsedArchiveBase;
  feed: GtfsFeedInfo;
  kursowki: GtfsKursowkaRecord[];
  kursowkiById: Map<string, GtfsKursowkaRecord>;
  tripsByKursowkaId: Map<string, GtfsTripRecord[]>;
  stopTimesByStopId: Map<string, StopTimeWithTripMeta[]>;
}

export interface DutySummary {
  id: string;
  routeId: string;
  routeShort: string;
  serviceId: string;
  kursowkaCode: string;
  brigadeNum: string;
  source: string;
  tripCount: number;
  firstDepartureMin: number | null;
  lastArrivalMin: number | null;
  firstStopName: string;
  lastStopName: string;
  vehicleId: string | null;
  operatorName: string | null;
  hasSchedule: boolean;
  unassigned: boolean;
  availableServices: string[];
  liveBus: LiveBusVehicle | null;
}

export interface GtfsLineItem extends GtfsRouteRecord {
  perService: Record<string, { kursowkiCount: number; tripsCount: number }>;
}

export interface GtfsLinesPayload {
  feed: GtfsFeedInfo | null;
  todayKey: number;
  defaultServiceId: string;
  feedCoversToday: boolean;
  uniqueDutiesCount: number;
  services: Array<{
    serviceId: string;
    label: string;
    isToday: boolean;
    datesCount: number;
  }>;
  routes: GtfsLineItem[];
}

export interface DutyDetailTripStop {
  tripId: string;
  stopId: string;
  stopSequence: number;
  arrivalMinutes: number;
  departureMinutes: number;
  stopName: string;
  lat: number;
  lon: number;
  arrivalClock: string;
  departureClock: string;
}

export interface DutyDetailTrip extends GtfsTripRecord {
  startClock: string;
  endClock: string;
  durationMinutes: number;
  layoverMinutes: number | null;
  stops: DutyDetailTripStop[];
}

export interface DutyDetailPayload {
  route: GtfsRouteRecord | null;
  kursowka: DutySummary;
  notice: string | null;
  liveError: string | null;
  trips: DutyDetailTrip[];
  shapes: Record<string, [number, number][]>;
}

export function normalizeStopName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l")
    .replace(/\bn[zż]\b/g, "")
    .replace(/na zadanie|na żądanie/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(",").map((v) => v.trim());
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/**
 * Column-indexed CSV streamer: avoids allocating tens of thousands of intermediate
 * Record<string, string> objects when parsing large GTFS files like stop_times.txt.
 */
function forEachCsvRow(
  text: string,
  cb: (cols: string[], colIndex: (name: string) => number) => void
): void {
  if (!text) return;
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let pos = 0;
  const len = clean.length;

  const nextLine = (): string | null => {
    while (pos < len) {
      let end = clean.indexOf("\n", pos);
      if (end === -1) end = len;
      const sliceEnd = end > pos && clean.charCodeAt(end - 1) === 13 ? end - 1 : end;
      const line = clean.slice(pos, sliceEnd);
      pos = end + 1;
      if (line.trim().length > 0) return line;
    }
    return null;
  };

  const headerLine = nextLine();
  if (!headerLine) return;
  const headers = parseCsvLine(headerLine);
  const indexMap = new Map<string, number>();
  headers.forEach((h, idx) => indexMap.set(h, idx));
  const colIndex = (name: string) => indexMap.get(name) ?? -1;

  let line = nextLine();
  while (line !== null) {
    cb(parseCsvLine(line), colIndex);
    line = nextLine();
  }
}

function parseCsvRows(text: string): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  let keys: string[] | null = null;
  if (!text) return rows;
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = clean.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (!keys) {
      keys = cols;
      continue;
    }
    const row: Record<string, string> = {};
    for (let j = 0; j < keys.length; j += 1) {
      row[keys[j]] = cols[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

function timeToMinutes(hhmmss: string): number {
  const parts = hhmmss.split(":");
  if (parts.length < 2) return 0;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = parts[2] ? Number(parts[2]) : 0;
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m + Math.round((Number.isFinite(s) ? s : 0) / 60);
}

function routeSortOrder(shortName: string): number {
  const num = Number.parseInt(shortName, 10);
  if (/^\d+$/.test(shortName.trim()) && Number.isFinite(num)) return num;
  const upper = shortName.trim().toUpperCase();
  if (upper === "A") return 1001;
  if (upper === "C") return 1002;
  if (upper === "EX") return 1003;
  return 1100 + upper.charCodeAt(0);
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * 110540;
  const dLon = (lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

function clock(totalMinutes: number): string {
  const minutes = ((totalMinutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function parseArchiveBytes(zipBytes: Uint8Array, source: string): ParsedArchiveBase {
  const files = unzipSync(zipBytes);
  const readTxt = (name: string) => (files[name] ? strFromU8(files[name]) : "");

  const feedRows = parseCsvRows(readTxt("feed_info.txt"));
  const agencyRows = parseCsvRows(readTxt("agency.txt"));
  const defaultAgency = agencyRows[0]?.agency_name || "ZDKiUM / MPK Wałbrzych";
  const feedVersion = feedRows[0]?.feed_version || new Date().toISOString().slice(0, 10);

  const routesById = new Map<string, GtfsRouteRecord>();
  for (const r of parseCsvRows(readTxt("routes.txt"))) {
    const id = r.route_id;
    if (!id) continue;
    const shortName = (r.route_short_name || id).trim();
    const rawColor = (r.route_color || "0d4f3b").replace(/^#/, "");
    const rawText = (r.route_text_color || "ffffff").replace(/^#/, "");
    routesById.set(id, {
      id,
      shortName,
      longName: r.route_long_name || shortName,
      color: `#${rawColor}`,
      textColor: `#${rawText}`,
      agencyName: defaultAgency,
      sortOrder: routeSortOrder(shortName),
    });
  }
  const routes = Array.from(routesById.values()).sort((a, b) => a.sortOrder - b.sortOrder);

  const stopsById = new Map<string, GtfsStopRecord>();
  for (const s of parseCsvRows(readTxt("stops.txt"))) {
    const lat = Number.parseFloat(s.stop_lat);
    const lon = Number.parseFloat(s.stop_lon);
    if (!s.stop_id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stopsById.set(s.stop_id, {
      id: s.stop_id,
      name: s.stop_name || s.stop_id,
      normalizedName: normalizeStopName(s.stop_name || s.stop_id),
      lat,
      lon,
      code: s.stop_code || null,
      platformCode: s.platform_code || null,
      agency: defaultAgency,
    });
  }
  const stops = Array.from(stopsById.values());

  const rawServiceDates = new Map<string, Set<number>>();
  for (const cd of parseCsvRows(readTxt("calendar_dates.txt"))) {
    if (cd.exception_type !== "1" && cd.exception_type !== "") continue;
    const dateNum = Number.parseInt(cd.date, 10);
    if (!Number.isFinite(dateNum)) continue;
    const set = rawServiceDates.get(cd.service_id) ?? new Set<number>();
    set.add(dateNum);
    rawServiceDates.set(cd.service_id, set);
  }

  const dayTypeDates = {
    weekday: [] as number[],
    saturday: [] as number[],
    sunday: [] as number[],
  };
  const allDates = new Set<number>();
  for (const set of rawServiceDates.values()) {
    for (const d of set) allDates.add(d);
  }
  for (const d of allDates) {
    const ds = String(d);
    const y = Number(ds.slice(0, 4));
    const m = Number(ds.slice(4, 6)) - 1;
    const day = Number(ds.slice(6, 8));
    const dow = new Date(Date.UTC(y, m, day)).getUTCDay();
    if (rawServiceDates.get("0_NS")?.has(d) || dow === 0) {
      dayTypeDates.sunday.push(d);
    } else if (rawServiceDates.get("0_SO")?.has(d) || dow === 6) {
      dayTypeDates.saturday.push(d);
    } else {
      dayTypeDates.weekday.push(d);
    }
  }
  dayTypeDates.weekday.sort((a, b) => a - b);
  dayTypeDates.saturday.sort((a, b) => a - b);
  dayTypeDates.sunday.sort((a, b) => a - b);

  const repDates: Record<string, number> = {
    weekday: dayTypeDates.weekday[0] ?? 20261109,
    saturday: dayTypeDates.saturday[0] ?? 20261114,
    sunday: dayTypeDates.sunday[0] ?? 20261115,
  };
  const dayTypeServices: Record<string, Set<string>> = {
    weekday: new Set(),
    saturday: new Set(),
    sunday: new Set(),
  };
  for (const [dayKey, repDate] of Object.entries(repDates)) {
    for (const [sid, dates] of rawServiceDates.entries()) {
      if (dates.has(repDate)) dayTypeServices[dayKey].add(sid);
    }
  }

  const rawStopTimesByTrip = new Map<string, GtfsStopTimeRecord[]>();
  {
    let iTrip = -1;
    let iStop = -1;
    let iSeq = -1;
    let iArr = -1;
    let iDep = -1;
    let iPick = -1;
    let iDrop = -1;
    let initialized = false;
    forEachCsvRow(readTxt("stop_times.txt"), (cols, col) => {
      if (!initialized) {
        iTrip = col("trip_id");
        iStop = col("stop_id");
        iSeq = col("stop_sequence");
        iArr = col("arrival_time");
        iDep = col("departure_time");
        iPick = col("pickup_type");
        iDrop = col("drop_off_type");
        initialized = true;
      }
      const tripId = iTrip >= 0 ? cols[iTrip] : "";
      const stopId = iStop >= 0 ? cols[iStop] : "";
      if (!tripId || !stopId) return;
      const arrStr = iArr >= 0 ? cols[iArr] : "";
      const depStr = iDep >= 0 ? cols[iDep] : "";
      const arr = timeToMinutes(arrStr || depStr);
      const dep = timeToMinutes(depStr || arrStr);
      const seq = iSeq >= 0 ? Number.parseInt(cols[iSeq], 10) || 0 : 0;
      const list = rawStopTimesByTrip.get(tripId) ?? [];
      list.push({
        tripId,
        stopId,
        stopSequence: seq,
        arrivalMinutes: arr,
        departureMinutes: dep,
        pickupType: iPick >= 0 ? Number.parseInt(cols[iPick], 10) || 0 : 0,
        dropOffType: iDrop >= 0 ? Number.parseInt(cols[iDrop], 10) || 0 : 0,
      });
      rawStopTimesByTrip.set(tripId, list);
    });
  }

  const rawTrips: RawTripDetail[] = [];
  const rawTripsById = new Map<string, RawTripDetail>();
  const linesByStopId = new Map<string, Set<string>>();
  const destCountByStop = new Map<string, Map<string, number>>();

  for (const t of parseCsvRows(readTxt("trips.txt"))) {
    const sts = rawStopTimesByTrip.get(t.trip_id);
    if (!sts || !sts.length) continue;
    sts.sort((a, b) => a.stopSequence - b.stopSequence);
    const first = sts[0];
    const last = sts[sts.length - 1];
    const route = routesById.get(t.route_id);
    const routeShort = route?.shortName ?? t.route_id;
    const firstStop = stopsById.get(first.stopId);
    const lastStop = stopsById.get(last.stopId);
    const lastStopName = lastStop?.name ?? last.stopId;

    const detail: RawTripDetail = {
      rawTripId: t.trip_id,
      routeId: t.route_id,
      routeShort,
      serviceId: t.service_id,
      rawBrigade: (t.block_id || t.brigade || "").trim(),
      headsign: t.trip_headsign || lastStopName || "",
      directionId: Number.parseInt(t.direction_id, 10) || 0,
      shapeId: t.shape_id || null,
      startMinutes: first.departureMinutes,
      endMinutes: last.arrivalMinutes,
      firstStopId: first.stopId,
      lastStopId: last.stopId,
      firstStopName: firstStop?.name ?? first.stopId,
      lastStopName,
      stopCount: sts.length,
    };
    rawTrips.push(detail);
    rawTripsById.set(t.trip_id, detail);

    for (const st of sts) {
      let lineSet = linesByStopId.get(st.stopId);
      if (!lineSet) {
        lineSet = new Set();
        linesByStopId.set(st.stopId, lineSet);
      }
      lineSet.add(routeShort);

      let counts = destCountByStop.get(st.stopId);
      if (!counts) {
        counts = new Map();
        destCountByStop.set(st.stopId, counts);
      }
      counts.set(lastStopName, (counts.get(lastStopName) ?? 0) + 1);
    }
  }

  const topDestByStopId = new Map<string, string>();
  for (const [stopId, counts] of destCountByStop) {
    let bestDest = "";
    let bestCount = -1;
    for (const [dest, cnt] of counts) {
      if (cnt > bestCount) {
        bestCount = cnt;
        bestDest = dest;
      }
    }
    if (bestDest) topDestByStopId.set(stopId, bestDest);
  }

  const shapeBuckets = new Map<string, Array<{ seq: number; lat: number; lon: number }>>();
  {
    let iId = -1;
    let iLat = -1;
    let iLon = -1;
    let iSeq = -1;
    let initialized = false;
    forEachCsvRow(readTxt("shapes.txt"), (cols, col) => {
      if (!initialized) {
        iId = col("shape_id");
        iLat = col("shape_pt_lat");
        iLon = col("shape_pt_lon");
        iSeq = col("shape_pt_sequence");
        initialized = true;
      }
      const shapeId = iId >= 0 ? cols[iId] : "";
      if (!shapeId) return;
      const lat = iLat >= 0 ? Number.parseFloat(cols[iLat]) : Number.NaN;
      const lon = iLon >= 0 ? Number.parseFloat(cols[iLon]) : Number.NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const seq = iSeq >= 0 ? Number.parseInt(cols[iSeq], 10) || 0 : 0;
      const list = shapeBuckets.get(shapeId) ?? [];
      list.push({ seq, lat, lon });
      shapeBuckets.set(shapeId, list);
    });
  }
  const shapesById = new Map<string, [number, number][]>();
  for (const [shapeId, pts] of shapeBuckets) {
    pts.sort((a, b) => a.seq - b.seq);
    shapesById.set(
      shapeId,
      pts.map((p) => [p.lat, p.lon] as [number, number])
    );
  }

  const services: GtfsServiceRecord[] = [
    { serviceId: "weekday", label: "Dni robocze", datesJson: dayTypeDates.weekday },
    { serviceId: "saturday", label: "Soboty", datesJson: dayTypeDates.saturday },
    { serviceId: "sunday", label: "Niedziele i święta", datesJson: dayTypeDates.sunday },
  ];

  return {
    source,
    feedVersion,
    routes,
    routesById,
    stops,
    stopsById,
    services,
    dayTypeServices,
    rawTrips,
    rawTripsById,
    rawStopTimesByTrip,
    shapesById,
    linesByStopId,
    topDestByStopId,
  };
}

function buildDutyIndex(base: ParsedArchiveBase, observations: DutyObservation[]): GtfsMemoryStore {
  const kursowki: GtfsKursowkaRecord[] = [];
  const kursowkiById = new Map<string, GtfsKursowkaRecord>();
  const tripsByKursowkaId = new Map<string, GtfsTripRecord[]>();
  const stopTimesByStopId = new Map<string, StopTimeWithTripMeta[]>();
  let totalTripsCount = 0;

  for (const svc of base.services) {
    const activeRawServices = base.dayTypeServices[svc.serviceId];
    const tripsForDay = new Map<string, RawTripDetail[]>();
    for (const trip of base.rawTrips) {
      if (!activeRawServices.has(trip.serviceId)) continue;
      const list = tripsForDay.get(trip.routeId) ?? [];
      list.push(trip);
      tripsForDay.set(trip.routeId, list);
    }

    for (const [routeId, routeTrips] of tripsForDay) {
      const schedule: ScheduleTrip[] = routeTrips.map((trip) => ({
        ...trip,
        explicitBrigade: trip.rawBrigade,
      }));
      const assignments = assignDuties(schedule, base.stopsById, observations);
      for (const duty of assignments) {
        const kursowkaId = `${routeId}|${svc.serviceId}|${duty.kursowkaCode}`;
        const firstTrip = base.rawTripsById.get(duty.trips[0].trip.rawTripId)!;
        const lastTrip = base.rawTripsById.get(duty.trips[duty.trips.length - 1].trip.rawTripId)!;
        const kRec: GtfsKursowkaRecord = {
          id: kursowkaId,
          routeId,
          routeShort: duty.routeShort,
          serviceId: svc.serviceId,
          kursowkaCode: duty.kursowkaCode,
          brigadeNum: duty.brigadeNum,
          source: duty.source,
          tripCount: duty.trips.length,
          firstDepartureMin: firstTrip.startMinutes,
          lastArrivalMin: lastTrip.endMinutes,
        };
        kursowki.push(kRec);
        kursowkiById.set(kursowkaId, kRec);

        const tripList: GtfsTripRecord[] = [];
        for (const { trip, source } of duty.trips) {
          const detail = base.rawTripsById.get(trip.rawTripId)!;
          const tripDbId = `${trip.rawTripId}_${svc.serviceId}`;
          totalTripsCount += 1;
          const tRec: GtfsTripRecord = {
            id: tripDbId,
            rawTripId: trip.rawTripId,
            routeId,
            serviceId: svc.serviceId,
            kursowkaId,
            kursowkaCode: duty.kursowkaCode,
            brigadeNum: duty.brigadeNum,
            brigadeSource: source,
            headsign: detail.headsign,
            directionId: detail.directionId,
            shapeId: detail.shapeId,
            startMinutes: detail.startMinutes,
            endMinutes: detail.endMinutes,
            firstStopName: detail.firstStopName,
            lastStopName: detail.lastStopName,
            stopCount: detail.stopCount,
          };
          tripList.push(tRec);

          for (const st of base.rawStopTimesByTrip.get(trip.rawTripId) ?? []) {
            const arr = stopTimesByStopId.get(st.stopId) ?? [];
            arr.push({
              tripId: tripDbId,
              rawTripId: trip.rawTripId,
              departureMinutes: st.departureMinutes,
              arrivalMinutes: st.arrivalMinutes,
              routeId,
              serviceId: svc.serviceId,
              kursowkaId,
              kursowkaCode: duty.kursowkaCode,
              brigadeSource: source,
              headsign: detail.headsign,
              directionId: detail.directionId,
              lastStopName: detail.lastStopName,
            });
            stopTimesByStopId.set(st.stopId, arr);
          }
        }
        tripList.sort((a, b) => a.startMinutes - b.startMinutes || a.id.localeCompare(b.id));
        tripsByKursowkaId.set(kursowkaId, tripList);
      }
    }
  }

  return {
    base,
    feed: {
      id: "walbrzych",
      source: base.source,
      version: `${base.feedVersion}+${DUTY_SCHEMA_VERSION}`,
      generatedAt: new Date().toISOString(),
      stopsCount: base.stops.length,
      routesCount: base.routes.length,
      tripsCount: totalTripsCount,
      kursowkiCount: kursowki.length,
    },
    kursowki,
    kursowkiById,
    tripsByKursowkaId,
    stopTimesByStopId,
  };
}

let memoryStore: GtfsMemoryStore | null = null;
let observationsDirty = false;
let seedLock: Promise<GtfsMemoryStore> | null = null;
let activeSync: Promise<SyncResult> | null = null;

subscribeObservationUpdates(() => {
  observationsDirty = true;
});

interface StoredArchive {
  version: string;
  source: string;
  cachedAt: number;
  bytes: Uint8Array;
}

export interface SyncResult {
  source: string;
  version: string;
  routes: number;
  stops: number;
  trips: number;
  kursowki: number;
}

async function fetchArchiveBytes(forceLive: boolean): Promise<{ bytes: Uint8Array; source: string }> {
  const sourceLive = "api.zbiorkom.live (Wałbrzych GTFS)";
  const sourceFallback = "Lokalny snapshot Wałbrzych GTFS";

  if (forceLive) {
    const res = await fetch(LIVE_GTFS_URL, {
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`Nie udało się pobrać Wałbrzych GTFS: HTTP ${res.status}`);
    }
    return { bytes: new Uint8Array(await res.arrayBuffer()), source: sourceLive };
  }

  const cached = await idbGetKv<StoredArchive>(ARCHIVE_KV_KEY);
  if (
    cached &&
    cached.version === DUTY_SCHEMA_VERSION &&
    cached.bytes instanceof Uint8Array &&
    cached.bytes.byteLength > 1000 &&
    Date.now() - cached.cachedAt < ARCHIVE_MAX_AGE_MS
  ) {
    return { bytes: cached.bytes, source: cached.source };
  }

  try {
    const res = await fetch(LIVE_GTFS_URL, {
      signal: AbortSignal.timeout(4_500),
      cache: "no-store",
    });
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > 1000) {
        return { bytes, source: sourceLive };
      }
    }
  } catch {
    // Fall back to bundled snapshot
  }

  const fallbackRes = await fetch(assetUrl("data/walbrzych-gtfs.zip"), { cache: "default" });
  if (!fallbackRes.ok) {
    if (cached?.bytes instanceof Uint8Array && cached.bytes.byteLength > 1000) {
      return { bytes: cached.bytes, source: cached.source };
    }
    throw new Error("Brak lokalnego archiwum walbrzych-gtfs.zip i brak połączenia z GTFS.");
  }
  return { bytes: new Uint8Array(await fallbackRes.arrayBuffer()), source: sourceFallback };
}

async function loadAndBuild(forceLive: boolean): Promise<GtfsMemoryStore> {
  const { bytes, source } = await fetchArchiveBytes(forceLive);
  const base = parseArchiveBytes(bytes, source);
  const observations = await loadLiveObservations();
  const store = buildDutyIndex(base, observations);
  memoryStore = store;
  observationsDirty = false;
  await idbSetKv<StoredArchive>(ARCHIVE_KV_KEY, {
    version: DUTY_SCHEMA_VERSION,
    source,
    cachedAt: Date.now(),
    bytes,
  });
  return store;
}

export async function ensureGtfsSeeded(): Promise<GtfsMemoryStore> {
  if (memoryStore) {
    if (observationsDirty) {
      observationsDirty = false;
      const observations = await loadLiveObservations();
      memoryStore = buildDutyIndex(memoryStore.base, observations);
    }
    return memoryStore;
  }
  if (seedLock) return seedLock;
  seedLock = loadAndBuild(false).finally(() => {
    seedLock = null;
  });
  return seedLock;
}

export async function syncWalbrzychGtfs(
  options: { forceLive?: boolean } = {}
): Promise<SyncResult> {
  if (activeSync) return activeSync;
  activeSync = (async () => {
    const store = await loadAndBuild(Boolean(options.forceLive));
    return {
      source: store.feed.source,
      version: store.feed.version,
      routes: store.feed.routesCount,
      stops: store.feed.stopsCount,
      trips: store.feed.tripsCount,
      kursowki: store.feed.kursowkiCount,
    };
  })().finally(() => {
    activeSync = null;
  });
  return activeSync;
}

export async function getGtfsStatus(): Promise<{ feed: GtfsFeedInfo }> {
  const store = await ensureGtfsSeeded();
  return { feed: store.feed };
}

export async function getGtfsLines(): Promise<GtfsLinesPayload> {
  const store = await ensureGtfsSeeded();
  const now = DateTime.now().setZone(ZONE);
  const todayKey = Number(now.toFormat("yyyyMMdd"));
  const defaultServiceId = serviceForDate(store.base.services, todayKey, now.weekday);
  const order: Record<string, number> = { weekday: 1, saturday: 2, sunday: 3 };
  const sortedServices = [...store.base.services].sort(
    (a, b) => (order[a.serviceId] ?? 9) - (order[b.serviceId] ?? 9)
  );

  return {
    feed: {
      ...store.feed,
      version: store.feed.version.split("+")[0],
    },
    todayKey,
    defaultServiceId,
    feedCoversToday: store.base.services.some((s) => s.datesJson.includes(todayKey)),
    uniqueDutiesCount: new Set(
      store.kursowki.filter((d) => d.brigadeNum !== "?").map((d) => d.kursowkaCode)
    ).size,
    services: sortedServices.map((s) => ({
      serviceId: s.serviceId,
      label: s.label,
      isToday: s.serviceId === defaultServiceId,
      datesCount: s.datesJson.length,
    })),
    routes: store.base.routes.map((route) => {
      const perService: Record<string, { kursowkiCount: number; tripsCount: number }> = {};
      for (const service of store.base.services) {
        const matches = store.kursowki.filter(
          (duty) => duty.routeId === route.id && duty.serviceId === service.serviceId
        );
        if (matches.length) {
          perService[service.serviceId] = {
            kursowkiCount: matches.filter((duty) => duty.brigadeNum !== "?").length,
            tripsCount: matches.reduce((sum, duty) => sum + duty.tripCount, 0),
          };
        }
      }
      return { ...route, perService };
    }),
  };
}

export async function getDutyCatalog(
  options: { routeId?: string; serviceId?: string } = {}
): Promise<{
  items: DutySummary[];
  routes: GtfsRouteRecord[];
  services: GtfsServiceRecord[];
  route: GtfsRouteRecord | null;
  liveError: string | null;
  vehicleNumbers: Record<string, string>;
}> {
  const store = await ensureGtfsSeeded();
  const routeId = options.routeId?.trim() || undefined;
  const serviceId = options.serviceId?.trim() || "weekday";

  if (!["all", "weekday", "saturday", "sunday"].includes(serviceId)) {
    throw new Error("Nieznany typ dnia.");
  }
  if (routeId && !store.base.routesById.has(routeId)) {
    throw new Error("Nie znaleziono linii.");
  }

  const rows = store.kursowki.filter(
    (row) =>
      (!routeId || row.routeId === routeId) &&
      (serviceId === "all" || row.serviceId === serviceId)
  );

  let vehicles: LiveBusVehicle[] = [];
  let liveError: string | null = null;
  try {
    vehicles = (await getLiveWalbrzychBuses()).vehicles;
  } catch {
    liveError = "GPS chwilowo niedostępny. Rozkład GTFS pozostaje dostępny.";
  }

  if (routeId) {
    const targetRoute = store.base.routesById.get(routeId);
    vehicles = vehicles.filter(
      (bus) => bus.routeName.toUpperCase() === targetRoute?.shortName.toUpperCase()
    );
  }

  const live = new Map(
    vehicles
      .filter((bus) => bus.brigade && bus.kursowka.includes("/"))
      .map((bus) => [bus.kursowka, bus])
  );

  const available = new Map<string, string[]>();
  for (const row of rows) {
    const list = available.get(row.kursowkaCode) ?? [];
    list.push(row.serviceId);
    available.set(row.kursowkaCode, list);
  }

  const items: DutySummary[] = rows.map((row) => {
    const dutyTrips = store.tripsByKursowkaId.get(row.id) ?? [];
    const firstStopName = dutyTrips[0]?.firstStopName ?? "";
    const lastStopName = dutyTrips[dutyTrips.length - 1]?.lastStopName ?? "";
    return {
      ...row,
      firstDepartureMin: row.tripCount ? row.firstDepartureMin : null,
      lastArrivalMin: row.tripCount ? row.lastArrivalMin : null,
      firstStopName,
      lastStopName,
      vehicleId: null,
      operatorName: null,
      hasSchedule: row.tripCount > 0,
      unassigned: row.brigadeNum === "?",
      availableServices: available.get(row.kursowkaCode) ?? [],
      liveBus: live.get(row.kursowkaCode) ?? null,
    };
  });

  const represented = new Set(items.map((item) => item.kursowkaCode));
  for (const bus of live.values()) {
    if (represented.has(bus.kursowka)) continue;
    const route = store.base.routes.find(
      (r) => r.shortName.toUpperCase() === bus.routeName.toUpperCase()
    );
    if (!route || (routeId && route.id !== routeId)) continue;
    items.push({
      id: `live|${route.id}|${bus.kursowka}`,
      routeId: route.id,
      routeShort: route.shortName,
      serviceId: serviceId !== "all" ? serviceId : "live",
      kursowkaCode: bus.kursowka,
      brigadeNum: bus.brigade,
      source: "live_gps",
      tripCount: 0,
      firstDepartureMin: null,
      lastArrivalMin: null,
      firstStopName: "",
      lastStopName: "",
      vehicleId: bus.vehicleId,
      operatorName: bus.operatorName,
      hasSchedule: false,
      unassigned: false,
      availableServices: available.get(bus.kursowka) ?? [],
      liveBus: bus,
    });
    represented.add(bus.kursowka);
  }

  items.sort(
    (a, b) =>
      a.routeShort.localeCompare(b.routeShort, "pl", { numeric: true }) ||
      Number(a.unassigned) - Number(b.unassigned) ||
      a.brigadeNum.localeCompare(b.brigadeNum, "pl", { numeric: true }) ||
      a.serviceId.localeCompare(b.serviceId)
  );

  return {
    items,
    routes: store.base.routes,
    services: store.base.services,
    route: routeId ? (store.base.routesById.get(routeId) ?? null) : null,
    liveError,
    vehicleNumbers: Object.fromEntries(
      vehicles.map((bus) => [bus.vehicleId, formatVehicleNumber(bus.vehicleId)])
    ),
  };
}

export async function getDutyDetail(options: {
  id?: string;
  code?: string;
  serviceId?: string;
}): Promise<DutyDetailPayload> {
  const store = await ensureGtfsSeeded();
  const id = options.id?.trim() || "";
  const code = normalizeDutyCode(options.code || "");
  const requestedService = options.serviceId?.trim() || "";
  const catalog = await getDutyCatalog({ serviceId: "all" });

  const now = DateTime.now().setZone(ZONE);
  const todayService = serviceForDate(
    catalog.services,
    Number(now.toFormat("yyyyMMdd")),
    now.weekday
  );

  let selected: DutySummary | undefined;
  if (id) selected = catalog.items.find((item) => item.id === id);
  if (!selected && (code || id)) {
    const parts = (id.startsWith("live|") ? id.slice(5) : id).split("|");
    const wantedCode = code || normalizeDutyCode(parts.at(-1) || "");
    const routeId = id.includes("|") ? parts[0] : undefined;
    const service = requestedService || (id.includes("|") ? parts[1] : todayService);
    const candidates = catalog.items.filter(
      (item) =>
        item.kursowkaCode === wantedCode &&
        (!routeId || item.routeId === routeId) &&
        !item.unassigned
    );
    selected =
      candidates.find((item) => item.serviceId === service) ??
      candidates.find((item) => item.liveBus) ??
      candidates.find((item) => item.serviceId === todayService) ??
      candidates[0];
    if (!selected && id.startsWith("live|")) {
      const liveRoute = catalog.routes.find((route) => route.id === routeId);
      if (liveRoute && wantedCode.startsWith(`${liveRoute.shortName.toUpperCase()}/`)) {
        selected = {
          id,
          routeId: liveRoute.id,
          routeShort: liveRoute.shortName,
          serviceId: service,
          kursowkaCode: wantedCode,
          brigadeNum: wantedCode.split("/")[1],
          source: "live_gps",
          tripCount: 0,
          firstDepartureMin: null,
          lastArrivalMin: null,
          firstStopName: "",
          lastStopName: "",
          vehicleId: null,
          operatorName: null,
          hasSchedule: false,
          unassigned: false,
          availableServices: [],
          liveBus: null,
        };
      }
    }
    if (selected && requestedService && selected.serviceId !== requestedService) {
      selected = {
        ...selected,
        id: `live|${selected.routeId}|${selected.kursowkaCode}`,
        serviceId: requestedService,
        hasSchedule: false,
        tripCount: 0,
        firstDepartureMin: null,
        lastArrivalMin: null,
        firstStopName: "",
        lastStopName: "",
      };
    }
  }

  if (!selected) {
    throw new Error("Nie znaleziono kursówki. Wyszukaj ją po numerze linii i kursówki, np. 2/03.");
  }

  const route = store.base.routesById.get(selected.routeId) ?? null;
  const trips = selected.hasSchedule ? (store.tripsByKursowkaId.get(selected.id) ?? []) : [];

  const shapes: Record<string, [number, number][]> = {};
  for (const trip of trips) {
    if (trip.shapeId && !shapes[trip.shapeId]) {
      const pts = store.base.shapesById.get(trip.shapeId);
      if (pts) shapes[trip.shapeId] = pts;
    }
  }

  return {
    route,
    kursowka: selected,
    notice: !selected.hasSchedule
      ? selected.liveBus
        ? "Ta kursówka jest widoczna w GPS, ale nie ma przypisanych kursów w wybranym typie dnia. Możesz znaleźć autobus na mapie."
        : "Ta kursówka była widoczna w GPS, ale autobus nie nadaje teraz pozycji i brak kursów w wybranym typie dnia."
      : selected.source === "conflict"
        ? "Niektóre kursy mają nakładające się godziny w danych źródłowych. Zachowujemy numery z GPS i oznaczamy tę kursówkę do weryfikacji."
        : null,
    liveError: catalog.liveError,
    trips: trips.map((trip, index) => {
      const rawStopTimes = store.base.rawStopTimesByTrip.get(trip.rawTripId) ?? [];
      return {
        ...trip,
        startClock: clock(trip.startMinutes),
        endClock: clock(trip.endMinutes),
        durationMinutes: Math.max(1, trip.endMinutes - trip.startMinutes),
        layoverMinutes:
          !selected.unassigned && trips[index + 1]
            ? Math.max(0, trips[index + 1].startMinutes - trip.endMinutes)
            : null,
        stops: rawStopTimes.map((st) => {
          const stop = store.base.stopsById.get(st.stopId);
          return {
            tripId: trip.id,
            stopId: st.stopId,
            stopSequence: st.stopSequence,
            arrivalMinutes: st.arrivalMinutes,
            departureMinutes: st.departureMinutes,
            stopName: stop?.name ?? st.stopId,
            lat: stop?.lat ?? 0,
            lon: stop?.lon ?? 0,
            arrivalClock: clock(st.arrivalMinutes),
            departureClock: clock(st.departureMinutes),
          };
        }),
      };
    }),
    shapes,
  };
}

export async function getStopDepartures(options: {
  lat: number;
  lon: number;
  name?: string;
  stopId?: string;
  fromMs?: number;
  limit?: number;
}): Promise<{
  matched: {
    id: string;
    name: string;
    lat: number;
    lon: number;
    agency: string;
    distanceMeters: number;
  } | null;
  departures: StopDepartureItem[];
}> {
  const store = await ensureGtfsSeeded();
  const { lat, lon } = options;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("Wymagane współrzędne lat i lon.");
  }
  const limit = Math.min(40, Math.max(1, options.limit ?? 10));
  const fromTime = Number.isFinite(options.fromMs) ? options.fromMs! : Date.now();
  const fromDate = new Date(fromTime);

  const targetNorm = options.name ? normalizeStopName(options.name) : "";
  let matched = options.stopId ? (store.base.stopsById.get(options.stopId) ?? null) : null;
  let bestDist = matched ? distanceMeters(lat, lon, matched.lat, matched.lon) : 180;

  if (!matched) {
    for (const s of store.base.stops) {
      const dist = distanceMeters(lat, lon, s.lat, s.lon);
      if (dist > bestDist) continue;
      if (targetNorm) {
        const comp =
          s.normalizedName === targetNorm ||
          s.normalizedName.includes(targetNorm) ||
          targetNorm.includes(s.normalizedName);
        if (!comp) continue;
      }
      bestDist = dist;
      matched = s;
    }
  }

  if (!matched) {
    bestDist = 95;
    for (const s of store.base.stops) {
      const dist = distanceMeters(lat, lon, s.lat, s.lon);
      if (dist < bestDist) {
        bestDist = dist;
        matched = s;
      }
    }
  }

  if (!matched) {
    return { matched: null, departures: [] };
  }

  const serviceMap = new Map(
    store.base.services.map((s) => [s.serviceId, new Set(s.datesJson)])
  );
  const stopTimesRows = store.stopTimesByStopId.get(matched.id) ?? [];

  type LiveMatchItem = {
    vehicleId: string;
    operatorName: string;
    kursowka: string;
    delaySeconds: number;
    timestamp: number;
    operatorKey: WalbrzychOperatorKey;
  };
  const liveByTrip = new Map<string, LiveMatchItem>();
  const liveBySchedule = new Map<string, LiveMatchItem>();

  try {
    const live = await getLiveWalbrzychBuses();
    for (const v of live.vehicles) {
      const item: LiveMatchItem = {
        vehicleId: v.vehicleId,
        operatorName: v.operatorName,
        kursowka: v.kursowka,
        delaySeconds: v.delaySeconds,
        timestamp: v.timestamp,
        operatorKey: v.operatorKey,
      };
      if (v.tripId) liveByTrip.set(v.tripId, item);
      for (const st of v.upcomingStops) {
        liveBySchedule.set(`${v.kursowka}|${st.scheduledDeparture}`, item);
      }
    }
  } catch {
    // Non-fatal
  }

  const liveStopMatches: Array<{
    routeShort: string;
    headsign: string;
    scheduledDeparture: number;
    delaySeconds: number;
    isRealtime: boolean;
  }> = [];
  try {
    const res = await fetch(
      `https://api.zbiorkom.live/api6-open/walbrzych/stops/${encodeURIComponent(matched.id)}?limit=40&time=${Math.floor(fromTime / 1000) * 1000}`,
      { signal: AbortSignal.timeout(3500), cache: "no-store" }
    );
    if (res.ok) {
      const json = (await res.json()) as {
        departures?: Array<{
          trip?: { route?: { name?: string }; headsign?: string };
          scheduledDeparture?: number;
          delay?: number;
          isRealtime?: boolean;
        }>;
      };
      for (const d of json.departures ?? []) {
        if (d.scheduledDeparture) {
          liveStopMatches.push({
            routeShort: String(d.trip?.route?.name ?? "").toUpperCase(),
            headsign: String(d.trip?.headsign ?? ""),
            scheduledDeparture: d.scheduledDeparture,
            delaySeconds: Math.round((d.delay ?? 0) / 1000),
            isRealtime: Boolean(d.isRealtime),
          });
        }
      }
    }
  } catch {
    // Non-fatal
  }

  const results: StopDepartureItem[] = [];
  const baseDt = DateTime.fromJSDate(fromDate, { zone: ZONE });

  for (const dayOffset of [-1, 0, 1]) {
    const serviceDay = baseDt.plus({ days: dayOffset }).startOf("day");
    const dateKey = Number(serviceDay.toFormat("yyyyMMdd"));
    const activeServices = new Set<string>();
    for (const [sid, dates] of serviceMap) {
      if (dates.has(dateKey)) activeServices.add(sid);
    }
    if (!activeServices.size) continue;

    const dayStartMs = serviceDay.toMillis();
    for (const row of stopTimesRows) {
      if (!activeServices.has(row.serviceId)) continue;
      const atMs = dayStartMs + row.departureMinutes * 60_000;
      if (atMs < fromTime - 60_000) continue;

      const route = store.base.routesById.get(row.routeId);
      const routeShort = route?.shortName ?? row.routeId;
      const byTrip = liveByTrip.get(row.rawTripId);
      const liveMatch =
        (byTrip && Math.abs(atMs - byTrip.timestamp) < 90 * 60_000 ? byTrip : undefined) ??
        liveBySchedule.get(`${row.kursowkaCode}|${atMs}`);
      const liveStop = liveStopMatches.find(
        (m) =>
          m.routeShort === routeShort.toUpperCase() &&
          Math.abs(m.scheduledDeparture - atMs) <= 90_000
      );

      const atDt = DateTime.fromMillis(atMs, { zone: ZONE });
      const finalStop = row.headsign || row.lastStopName || route?.longName || "Końcowy";

      results.push({
        tripId: row.tripId,
        kursowkaId: row.kursowkaId,
        kursowka: liveMatch?.kursowka || row.kursowkaCode,
        brigadeSource: liveMatch ? "live_gps" : row.brigadeSource,
        routeShort,
        routeColor: route?.color ?? "#0d4f3b",
        routeTextColor: route?.textColor ?? "#ffffff",
        routeLong: route?.longName ?? "",
        headsign: row.headsign,
        finalStop,
        direction: row.directionId,
        minutes: row.departureMinutes,
        atMs,
        clock: atDt.toFormat("HH:mm"),
        dateLabel: atDt.setLocale("pl").toFormat("ccc, dd.MM"),
        isRealtime: Boolean(liveMatch || liveStop?.isRealtime),
        delaySeconds: liveMatch?.delaySeconds ?? liveStop?.delaySeconds ?? 0,
        vehicleId: liveMatch?.vehicleId ?? null,
        operatorName: liveMatch?.operatorName ?? null,
        operatorKey: liveMatch?.operatorKey ?? null,
      });
    }
  }

  results.sort((a, b) => a.atMs - b.atMs);

  return {
    matched: {
      id: matched.id,
      name: matched.name,
      lat: matched.lat,
      lon: matched.lon,
      agency: matched.agency,
      distanceMeters: Math.round(bestDist),
    },
    departures: results.slice(0, limit),
  };
}
