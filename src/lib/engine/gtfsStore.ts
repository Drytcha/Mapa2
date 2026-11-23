import { strFromU8, unzipSync } from "fflate";
import { DateTime } from "luxon";
import {
  emitRuntimeEvent,
  getLatestFleetSnapshot,
  LruTtlCache,
  runDeduped,
} from "../core/runtimeHub";
import { distanceCoords, polylineLengthMeters } from "../core/spatial";
import { foldStopKey, formatDutyCode } from "../core/text";
import {
  formatWarsawShortDate,
  minutesToClock,
  WARSAW_ZONE,
} from "../core/time";
import { formatVehicleNumber } from "../delay";
import { legendCodeForTrip, legendText, lineLegendNeedsStops } from "../lineLegend";
import { assetUrl } from "../services";
import { normalizeDutyCode, serviceForDate } from "../transit";
import type {
  LiveBusVehicle,
  StopDepartureItem,
  WalbrzychOperatorKey,
} from "../types";
import {
  assignDuties,
  type DutyObservation,
  type ScheduleTrip,
} from "./dutyAssignment";
import { OPERATOR_NAMES } from "./fleetOperators";
import { getLiveWalbrzychBuses, subscribeObservationUpdates } from "./gtfsRt";
import {
  dutyCodeFromBlock,
  getDutyRosterRevision,
  registerLineSevenRosters,
  resolveDutyOperator,
  rosterDutiesForTrips,
  updateDynamicDutyOperators,
} from "./brigadeVerification";
import { reconstructLineSevenDuty } from "./lineSevenDuty";
import { technicalTripCode, type TechnicalTripCode } from "./technicalTrips";
import { repairShapeGaps } from "./shapeRepair";
import type { BuilderStop, BuilderTrip } from "./brigadeBuilder";
import { CSV_CHUNK_ROWS, yieldToMain } from "../core/cooperative";
import { createLap, measureSync, recordTiming } from "../core/perfMarks";
import {
  idbGetKv,
  idbSetKv,
  loadLiveObservations,
  type LiveTripObservation,
} from "./storage";

/**
 * Wersja schematu archiwum trzymanego w IndexedDB. Zmiana unieważnia stare kopie —
 * w v2 mogła tkwić paczka "GTFS.zip" bez linii 30 (brygady 30/01, 30/02 od 1 grudnia)
 * i bez linii S1–S4, która nie była odświeżana przez kolejne 12 godzin.
 */
export const DUTY_SCHEMA_VERSION = "walbrzych-eu-st-387-388-v4-full";
/** Cache dopasowania kursu z GPS do rozkładu (czyszczone przy nowym feedzie). */
const tripMatchCache = new Map<
  string,
  { tripId: string; dayStartMs: number }
>();
const TRIP_MATCH_CACHE_MAX = 600;
const STATIC_PAGES = process.env.NEXT_PUBLIC_STATIC_EXPORT === "1";
const OFFICIAL_GTFS_PROXY_URL = "/api/transit/gtfs";
const ZBIORKOM_FALLBACK_GTFS_URL =
  "https://api.zbiorkom.live/api6-open/walbrzych/gtfs/default";
const ARCHIVE_KV_KEY = "gtfs_archive_walbrzych_eu_v2";
/**
 * Gotowa baza po parsowaniu (Mapy/Set-y są klonowalne przez structured clone,
 * więc IndexedDB przechowuje je bez konwersji do JSON). Dzięki temu powrót na
 * stronę nie rozpakowuje ZIP-a ani nie parsuje dziesiątek tysięcy wierszy CSV.
 */
const PARSED_KV_KEY = "gtfs_parsed_walbrzych_eu_v1";
const ARCHIVE_MAX_AGE_MS = 12 * 3600 * 1000;
const ZONE = WARSAW_ZONE;

/** Oficjalna paleta barw linii komunikacji miejskiej Wałbrzycha. */
export const WALBRZYCH_ROUTE_COLORS: Readonly<Record<string, string>> = {
  "2": "#00658d",
  "4": "#ae2e3e",
  "5": "#a6218f",
  "7": "#006e28",
  "8": "#006e22",
  "9": "#954a00",
  "10": "#5d4eb9",
  "11": "#a2356c",
  "12": "#934c00",
  "15": "#7c44a9",
  "18": "#466800",
  "19": "#b4281f",
  "20": "#0059c9",
  "30": "#0284c7",
  "52": "#aa1697",
  A: "#7f5700",
  C: "#4e6700",
  EX: "#00696f",
  S1: "#be123c",
  S2: "#0f766e",
  S3: "#b45309",
  S4: "#4338ca",
};

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
  /** Optional destination displayed from this stop, not a separate trip. */
  stopHeadsign?: string;
  arrivalMinutes: number;
  departureMinutes: number;
  pickupType: number;
  dropOffType: number;
}

export interface RawTripDetail {
  rawTripId: string;
  routeId: string;
  routeShort: string;
  /** An explicit technical label from GTFS, not inferred from route gaps. */
  technicalCode?: TechnicalTripCode;
  serviceId: string;
  rawBrigade: string;
  kursowkaCode: string;
  operatorKey: WalbrzychOperatorKey;
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
  /** Names are also retained for depot/technical stops without coordinates. */
  stopNamesById: Map<string, string>;
  /**
   * Węzły `location_type=1` (pętle, dworce) z własnymi współrzędnymi. Nie są
   * przystankami do wsiadania, ale kursy potrafią kończyć się właśnie na nich —
   * bez tego ostatni przystanek kursu (np. pętla Kozice na linii 11) znikał,
   * a linia kończyła się ~300 m wcześniej.
   */
  stationById: Map<string, { name: string; lat: number; lon: number }>;
  services: GtfsServiceRecord[];
  dayTypeServices: Record<string, Set<string>>;
  /** Exact GTFS calendar: date (YYYYMMDD) -> active service_ids. No "forever" fallback. */
  serviceIdsByDate: Map<number, Set<string>>;
  /** feed_info.txt validity window — no timetable outside this range. */
  feedStartDate: number;
  feedEndDate: number;
  rawTrips: RawTripDetail[];
  rawTripsById: Map<string, RawTripDetail>;
  rawStopTimesByTrip: Map<string, GtfsStopTimeRecord[]>;
  shapesById: Map<string, [number, number][]>;
  linesByStopId: Map<string, Set<string>>;
  topDestByStopId: Map<string, string>;
  activeStopIds: Set<string>;
}

interface StopTimeWithTripMeta {
  tripId: string;
  canBoard: boolean;
  rawTripId: string;
  rawServiceId: string;
  departureMinutes: number;
  arrivalMinutes: number;
  routeId: string;
  serviceId: string;
  kursowkaId: string;
  kursowkaCode: string;
  operatorKey: WalbrzychOperatorKey;
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
  /** Human-readable day-type label, e.g. "Dni robocze" or "Tylko GPS". */
  serviceLabel: string;
}

export interface DutyCatalogCounts {
  total: number;
  withSchedule: number;
  onGps: number;
  unassigned: number;
}

export interface GtfsLineItem extends GtfsRouteRecord {
  perService: Record<string, { kursowkiCount: number; tripsCount: number }>;
}

export interface GtfsLinesPayload {
  feed: GtfsFeedInfo | null;
  todayKey: number;
  /** feed_info.txt validity window (YYYYMMDD); 0 when the feed does not declare it. */
  feedFrom: number;
  feedTo: number;
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

export const normalizeStopName = foldStopKey;

/** Czy pole wymaga przycięcia? Większość paczek GTFS nie ma spacji w komórkach. */
function needsTrim(text: string): boolean {
  if (text.length === 0) return false;
  const first = text.charCodeAt(0);
  const last = text.charCodeAt(text.length - 1);
  return first <= 0x20 || last <= 0x20;
}

function parseCsvLine(line: string): string[] {
  if (!line.includes('"')) {
    const parts = line.split(",");
    for (let i = 0; i < parts.length; i += 1) {
      if (needsTrim(parts[i])) parts[i] = parts[i].trim();
    }
    return parts;
  }
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
      out.push(needsTrim(cur) ? cur.trim() : cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(needsTrim(cur) ? cur.trim() : cur);
  return out;
}

/**
 * Strumień wierszy CSV bez alokacji obiektów `Record<string, string>`.
 *
 * `next()` zwraca kolejne pola jako tablicę (albo `null` na końcu). Dzięki temu
 * pętle mogą przerywać pracę co N wierszy (`await yieldToMain()`) — długi plik
 * `stop_times.txt` nie musi blokować interfejsu jednym „long taskiem”.
 */
function createCsvReader(text: string): {
  header: string[];
  index: (name: string) => number;
  next: () => string[] | null;
} {
  const clean = text && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let pos = 0;
  const len = clean.length;

  const nextLine = (): string | null => {
    while (pos < len) {
      let end = clean.indexOf("\n", pos);
      if (end === -1) end = len;
      const sliceEnd =
        end > pos && clean.charCodeAt(end - 1) === 13 ? end - 1 : end;
      const line = clean.slice(pos, sliceEnd);
      pos = end + 1;
      if (line.length > 0) return line;
    }
    return null;
  };

  const headerLine = nextLine();
  const header = headerLine ? parseCsvLine(headerLine) : [];
  const indexMap = new Map<string, number>();
  header.forEach((h, idx) => indexMap.set(h, idx));

  return {
    header,
    index: (name: string) => indexMap.get(name) ?? -1,
    next: () => {
      const line = nextLine();
      return line === null ? null : parseCsvLine(line);
    },
  };
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

/**
 * „hh:mm:ss” → minuty od północy. Bez `split(":")`, bo przy kilkudziesięciu
 * tysiącach wierszy `stop_times.txt` alokacja tablicy na wiersz to realny koszt.
 */
function timeToMinutes(hhmmss: string): number {
  const len = hhmmss.length;
  if (len === 0) return 0;
  let i = 0;
  let h = 0;
  let m = 0;
  let s = 0;
  let colons = 0;
  for (; i < len; i += 1) {
    const code = hhmmss.charCodeAt(i);
    if (code === 58) break;
    if (code < 48 || code > 57) return 0;
    h = h * 10 + (code - 48);
  }
  if (i < len && hhmmss.charCodeAt(i) === 58) colons += 1;
  i += 1;
  for (; i < len; i += 1) {
    const code = hhmmss.charCodeAt(i);
    if (code === 58) break;
    if (code < 48 || code > 57) return 0;
    m = m * 10 + (code - 48);
  }
  if (i < len && hhmmss.charCodeAt(i) === 58) colons += 1;
  i += 1;
  for (; i < len; i += 1) {
    const code = hhmmss.charCodeAt(i);
    if (code < 48 || code > 57) break;
    s = s * 10 + (code - 48);
  }
  if (colons === 0) return 0;
  return h * 60 + m + Math.round(s / 60);
}

function routeSortOrder(shortName: string): number {
  const clean = shortName.trim().toUpperCase();
  if (/^\d+$/.test(clean)) return Number.parseInt(clean, 10);
  if (clean === "A") return 1001;
  if (clean === "C") return 1002;
  if (clean === "EX") return 1003;
  const sMatch = clean.match(/^S(\d+)$/);
  if (sMatch) return 1020 + Number.parseInt(sMatch[1], 10);
  return 1100 + clean.charCodeAt(0);
}

const distanceMeters = distanceCoords;
const clock = minutesToClock;

async function parseArchiveBytes(
  zipBytes: Uint8Array,
  source: string,
): Promise<ParsedArchiveBase> {
  // `shapes.txt` rozpakowujemy osobno i tylko wtedy, gdy ktoś rysuje trasę —
  // dekompresja największego pliku paczki nie może opóźniać pierwszego ekranu.
  const files = measureSync("gtfs:unzip", () =>
    unzipSync(zipBytes, { filter: (file) => file.name !== "shapes.txt" })
  );
  const lap = createLap();
  const readTxt = (name: string) => (files[name] ? strFromU8(files[name]) : "");

  const feedRows = parseCsvRows(readTxt("feed_info.txt"));
  const agencyRows = parseCsvRows(readTxt("agency.txt"));
  const defaultAgency = agencyRows[0]?.agency_name || "ZDKiUM / MPK Wałbrzych";
  const feedVersion =
    feedRows[0]?.feed_version || new Date().toISOString().slice(0, 10);
  const feedStartDate =
    Number.parseInt(feedRows[0]?.feed_start_date ?? "", 10) || 0;
  const feedEndDate =
    Number.parseInt(feedRows[0]?.feed_end_date ?? "", 10) || 0;

  lap("gtfs:csv:feed");
  await yieldToMain();
  const routesById = new Map<string, GtfsRouteRecord>();
  const canonicalByShort = new Map<string, GtfsRouteRecord>();
  for (const r of parseCsvRows(readTxt("routes.txt"))) {
    const id = r.route_id?.trim();
    if (!id) continue;
    const rawShort = (r.route_short_name || id).trim();
    const upperShort = (rawShort.includes("_") ? rawShort.split("_").pop()! : rawShort)
      .trim()
      .toUpperCase();
    const fallbackColor = (WALBRZYCH_ROUTE_COLORS[upperShort] ?? "#0d4f3b").replace(/^#/, "");
    const rawColor = (r.route_color?.trim() || fallbackColor).replace(/^#/, "");
    const rawText = (r.route_text_color?.trim() || "ffffff").replace(/^#/, "");
    const rec: GtfsRouteRecord = {
      id,
      shortName: upperShort,
      longName: (r.route_long_name || upperShort).trim(),
      color: `#${rawColor}`,
      textColor: `#${rawText}`,
      agencyName: defaultAgency,
      sortOrder: routeSortOrder(upperShort),
    };
    routesById.set(id, rec);
    // Merge multi-period route definitions (e.g. 387_2 + 388_2) under one canonical entry
    const prev = canonicalByShort.get(upperShort);
    if (!prev || rec.longName.length > prev.longName.length) {
      canonicalByShort.set(upperShort, rec);
    }
  }
  const routes = Array.from(canonicalByShort.values()).sort(
    (a, b) => a.sortOrder - b.sortOrder || a.shortName.localeCompare(b.shortName, "pl", { numeric: true }),
  );

  lap("gtfs:csv:routes");
  await yieldToMain();
  const stopsById = new Map<string, GtfsStopRecord>();
  const stopNamesById = new Map<string, string>();
  const stationById = new Map<string, { name: string; lat: number; lon: number }>();
  for (const s of parseCsvRows(readTxt("stops.txt"))) {
    if (s.stop_id && s.stop_name?.trim()) stopNamesById.set(s.stop_id, s.stop_name.trim());
    if (s.location_type === "1") {
      const stationLat = Number.parseFloat(s.stop_lat);
      const stationLon = Number.parseFloat(s.stop_lon);
      if (s.stop_id && Number.isFinite(stationLat) && Number.isFinite(stationLon)) {
        stationById.set(s.stop_id, {
          name: s.stop_name?.trim() || s.stop_id,
          lat: stationLat,
          lon: stationLon,
        });
      }
      continue;
    }
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

  lap("gtfs:csv:stops");
  await yieldToMain();
  const rawServiceDates = new Map<string, Set<number>>();
  // 1. Expand standard calendar.txt weekday masks if any are enabled
  const weekdayCols = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ] as const;
  for (const cal of parseCsvRows(readTxt("calendar.txt"))) {
    const sid = cal.service_id;
    const startNum = Number.parseInt(cal.start_date ?? "", 10);
    const endNum = Number.parseInt(cal.end_date ?? "", 10);
    if (!sid || !Number.isFinite(startNum) || !Number.isFinite(endNum)) continue;
    const hasMask = weekdayCols.some((col) => cal[col] === "1");
    if (!hasMask) continue;
    const set = rawServiceDates.get(sid) ?? new Set<number>();
    let cursor = DateTime.fromFormat(String(startNum), "yyyyLLdd", { zone: "UTC" });
    const limit = DateTime.fromFormat(String(endNum), "yyyyLLdd", { zone: "UTC" });
    let guard = 0;
    while (cursor.isValid && limit.isValid && cursor <= limit && guard < 400) {
      guard += 1;
      const dow = cursor.weekday % 7; // 0 = Sun .. 6 = Sat
      if (cal[weekdayCols[dow]] === "1") {
        set.add(Number(cursor.toFormat("yyyyLLdd")));
      }
      cursor = cursor.plus({ days: 1 });
    }
    if (set.size > 0) rawServiceDates.set(sid, set);
  }

  // 2. Apply calendar_dates.txt additions (1) and removals (2)
  for (const cd of parseCsvRows(readTxt("calendar_dates.txt"))) {
    const dateNum = Number.parseInt(cd.date, 10);
    if (!cd.service_id || !Number.isFinite(dateNum)) continue;
    if (cd.exception_type === "2") {
      rawServiceDates.get(cd.service_id)?.delete(dateNum);
      continue;
    }
    if (cd.exception_type !== "1" && cd.exception_type !== "") continue;
    const set = rawServiceDates.get(cd.service_id) ?? new Set<number>();
    set.add(dateNum);
    rawServiceDates.set(cd.service_id, set);
  }

  const serviceIdsByDate = new Map<number, Set<string>>();
  for (const [serviceId, dates] of rawServiceDates) {
    for (const dateKey of dates) {
      const set = serviceIdsByDate.get(dateKey) ?? new Set<string>();
      set.add(serviceId);
      serviceIdsByDate.set(dateKey, set);
    }
  }

  const dayTypeDates = {
    weekday: [] as number[],
    saturday: [] as number[],
    sunday: [] as number[],
  };
  for (const [d, sids] of serviceIdsByDate) {
    const ds = String(d);
    const y = Number(ds.slice(0, 4));
    const m = Number(ds.slice(4, 6)) - 1;
    const day = Number(ds.slice(6, 8));
    const dow = new Date(Date.UTC(y, m, day)).getUTCDay();
    const sidList = [...sids].map((s) => s.toUpperCase());
    const isSun =
      sidList.some((s) => s.endsWith("_NS") || s.endsWith("_NH")) || dow === 0;
    const isSat = !isSun && (sidList.some((s) => s.endsWith("_SO")) || dow === 6);
    if (isSun) dayTypeDates.sunday.push(d);
    else if (isSat) dayTypeDates.saturday.push(d);
    else dayTypeDates.weekday.push(d);
  }
  dayTypeDates.weekday.sort((a, b) => a - b);
  dayTypeDates.saturday.sort((a, b) => a - b);
  dayTypeDates.sunday.sort((a, b) => a - b);

  const todayNum = Number(DateTime.now().setZone(ZONE).toFormat("yyyyLLdd"));
  const pickNearestDate = (list: number[], fallback: number) =>
    list.find((d) => d >= todayNum) ?? list[list.length - 1] ?? fallback;

  const repDates: Record<string, number> = {
    weekday: pickNearestDate(dayTypeDates.weekday, 20261118),
    saturday: pickNearestDate(dayTypeDates.saturday, 20261121),
    sunday: pickNearestDate(dayTypeDates.sunday, 20261122),
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

  lap("gtfs:csv:calendar");
  await yieldToMain();
  const rawStopTimesByTrip = new Map<string, GtfsStopTimeRecord[]>();
  {
    // Największy plik paczki (dziesiątki tysięcy wierszy) — czytany porcjami,
    // żeby między nimi przeglądarka mogła odmalować mapę.
    const reader = createCsvReader(readTxt("stop_times.txt"));
    const col = reader.index;
    const iTrip = col("trip_id");
    const iStop = col("stop_id");
    const iSeq = col("stop_sequence");
    const iHeadsign = col("stop_headsign");
    const iArr = col("arrival_time");
    const iDep = col("departure_time");
    const iPick = col("pickup_type");
    const iDrop = col("drop_off_type");
    let cols = reader.next();
    let processed = 0;
    while (cols !== null) {
      const tripId = iTrip >= 0 ? cols[iTrip] : "";
      const stopId = iStop >= 0 ? cols[iStop] : "";
      if (tripId && stopId) {
        const arrStr = iArr >= 0 ? cols[iArr] : "";
        const depStr = iDep >= 0 ? cols[iDep] : "";
        const arr = timeToMinutes(arrStr || depStr);
        const dep = timeToMinutes(depStr || arrStr);
        const seq = iSeq >= 0 ? Number.parseInt(cols[iSeq], 10) || 0 : 0;
        const list = rawStopTimesByTrip.get(tripId);
        const row: GtfsStopTimeRecord = {
          tripId,
          stopId,
          stopSequence: seq,
          stopHeadsign: iHeadsign >= 0 ? cols[iHeadsign]?.trim() || undefined : undefined,
          arrivalMinutes: arr,
          departureMinutes: dep,
          pickupType: iPick >= 0 ? Number.parseInt(cols[iPick], 10) || 0 : 0,
          dropOffType: iDrop >= 0 ? Number.parseInt(cols[iDrop], 10) || 0 : 0,
        };
        if (list) list.push(row);
        else rawStopTimesByTrip.set(tripId, [row]);
        processed += 1;
        if (processed % CSV_CHUNK_ROWS === 0) await yieldToMain();
      }
      cols = reader.next();
    }
  }

  lap("gtfs:csv:stop_times");
  await yieldToMain();
  const activeCalendarServices = new Set<string>();
  for (const [dateKey, sids] of serviceIdsByDate) {
    if (feedStartDate > 0 && dateKey < feedStartDate) continue;
    if (feedEndDate > 0 && dateKey > feedEndDate) continue;
    for (const sid of sids) activeCalendarServices.add(sid);
  }
  const hasCalendarFilter = activeCalendarServices.size > 0;

  const rawTrips: RawTripDetail[] = [];
  const rawTripsById = new Map<string, RawTripDetail>();
  const linesByStopId = new Map<string, Set<string>>();
  const destCountByStop = new Map<string, Map<string, number>>();
  const activeStopIds = new Set<string>();

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
    const lastStopName = lastStop?.name ?? stopNamesById.get(last.stopId) ?? last.stopId;

    const rawBrigade = (t.block_id || t.brigade || "").trim();
    const verifiedKursowka =
      (rawBrigade && rawBrigade !== "0" && rawBrigade !== "1"
        ? dutyCodeFromBlock(rawBrigade) ?? formatDutyCode(rawBrigade, "/")
        : "") || "";
    const operatorKey = resolveDutyOperator(
      t.service_id,
      verifiedKursowka || rawBrigade
    );

    const detail: RawTripDetail = {
      rawTripId: t.trip_id,
      routeId: t.route_id,
      routeShort,
      technicalCode: technicalTripCode(routeShort, t.trip_short_name || "", t.trip_headsign || "", route?.longName || ""),
      serviceId: t.service_id,
      rawBrigade,
      kursowkaCode: verifiedKursowka,
      operatorKey,
      headsign: t.trip_headsign || lastStopName || "",
      directionId: Number.parseInt(t.direction_id, 10) || 0,
      shapeId: t.shape_id || null,
      startMinutes: first.departureMinutes,
      endMinutes: last.arrivalMinutes,
      firstStopId: first.stopId,
      lastStopId: last.stopId,
      firstStopName: firstStop?.name ?? stopNamesById.get(first.stopId) ?? first.stopId,
      lastStopName,
      stopCount: sts.length,
    };
    rawTrips.push(detail);
    rawTripsById.set(t.trip_id, detail);

    if (hasCalendarFilter && !activeCalendarServices.has(t.service_id))
      continue;

    for (const st of sts) {
      if (!stopsById.has(st.stopId)) continue;
      if (st.pickupType === 1 && st.dropOffType === 1) continue;
      activeStopIds.add(st.stopId);

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

  lap("gtfs:csv:trips");
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

  lap("gtfs:csv:destinations");
  await yieldToMain();
  // `shapes.txt` to najdroższy plik paczki i nie jest potrzebny do pierwszego
  // ekranu (mapa, przystanki, odjazdy). Geometria linii dochodzi leniwie —
  // patrz `ensureShapesReady()`.
  const shapesById = new Map<string, [number, number][]>();

  const services: GtfsServiceRecord[] = [
    {
      serviceId: "weekday",
      label: "Dni robocze",
      datesJson: dayTypeDates.weekday,
    },
    {
      serviceId: "saturday",
      label: "Soboty",
      datesJson: dayTypeDates.saturday,
    },
    {
      serviceId: "sunday",
      label: "Niedziele i święta",
      datesJson: dayTypeDates.sunday,
    },
  ];

  lap("gtfs:csv:services");
  await yieldToMain();
  return {
    source,
    feedVersion,
    routes,
    routesById,
    stops,
    stopsById,
    stopNamesById,
    stationById,
    services,
    dayTypeServices,
    serviceIdsByDate,
    feedStartDate,
    feedEndDate,
    rawTrips,
    rawTripsById,
    rawStopTimesByTrip,
    shapesById,
    linesByStopId,
    topDestByStopId,
    activeStopIds,
  };
}

function registerMissingLineSevenDuty(
  base: ParsedArchiveBase,
  observations: LiveTripObservation[],
): void {
  const sevenTrips = base.rawTrips.filter(
    (trip) => trip.routeShort.toUpperCase() === "7",
  );
  const verifiedByTrip = new Map(
    observations
      .filter((entry) => entry.verified && entry.routeShort.toUpperCase() === "7")
      .map((entry) => [entry.tripId, entry.kursowkaCode]),
  );
  if (!sevenTrips.length) {
    registerLineSevenRosters(new Map());
    return;
  }
  const stops = new Map<string, BuilderStop>(
    [...base.stopsById].map(([id, stop]) => [id, { lat: stop.lat, lon: stop.lon }]),
  );
  const rosters = new Map<
    string,
    Array<{ id: string; startMs: number; endMs: number }>
  >();

  // Kursy linii 7 pogrupowane po `service_id` — bez tego każda data filtrowała
  // całą listę kursów od nowa (90 dat × kilkaset kursów).
  const tripsByService = new Map<string, BuilderTrip[]>();
  for (const trip of sevenTrips) {
    const builderTrip: BuilderTrip = {
      id: trip.rawTripId,
      line: "7",
      headsign: trip.headsign,
      startMinutes: trip.startMinutes,
      endMinutes: trip.endMinutes,
      firstStopId: trip.firstStopId,
      lastStopId: trip.lastStopId,
      firstStopName: trip.firstStopName,
      lastStopName: trip.lastStopName,
      lengthMeters: 0,
      observedBrigade: verifiedByTrip.get(trip.rawTripId),
    };
    const list = tripsByService.get(trip.serviceId);
    if (list) list.push(builderTrip);
    else tripsByService.set(trip.serviceId, [builderTrip]);
  }
  // Ten sam zestaw rozkładów (np. wszystkie dni robocze) daje identyczną
  // obsadę — rekonstrukcja brygad liczy się raz, nie dla każdej daty.
  const rosterBySignature = new Map<string, ReturnType<typeof reconstructLineSevenDuty>>();

  for (const [dateKey, activeServices] of base.serviceIdsByDate) {
    if (
      (base.feedStartDate && dateKey < base.feedStartDate) ||
      (base.feedEndDate && dateKey > base.feedEndDate)
    ) {
      continue;
    }
    const services = [...activeServices]
      .filter((serviceId) => tripsByService.has(serviceId))
      .sort();
    if (!services.length) continue;
    const signature = services.join("|");
    let dutyTrips = rosterBySignature.get(signature);
    if (!dutyTrips) {
      const serviceTrips: BuilderTrip[] = [];
      for (const serviceId of services) {
        const list = tripsByService.get(serviceId);
        if (list) serviceTrips.push(...list);
      }
      dutyTrips = reconstructLineSevenDuty(serviceTrips, stops);
      rosterBySignature.set(signature, dutyTrips);
    }
    if (!dutyTrips.length) continue;
    const dateId = String(dateKey);
    const midnight = DateTime.fromFormat(dateId, "yyyyLLdd", { zone: ZONE }).startOf("day");
    if (!midnight.isValid) continue;
    rosters.set(
      dateId,
      dutyTrips.map((trip) => ({
        id: trip.id,
        startMs: midnight.plus({ minutes: trip.startMinutes }).toMillis(),
        endMs: midnight.plus({ minutes: trip.endMinutes }).toMillis(),
      })),
    );
  }
  registerLineSevenRosters(rosters);
}

function buildDutyIndex(
  base: ParsedArchiveBase,
  observations: DutyObservation[],
): GtfsMemoryStore {
  const kursowki: GtfsKursowkaRecord[] = [];
  const kursowkiById = new Map<string, GtfsKursowkaRecord>();
  const tripsByKursowkaId = new Map<string, GtfsTripRecord[]>();
  const stopTimesByStopId = new Map<string, StopTimeWithTripMeta[]>();
  let totalTripsCount = 0;

  // Index all stop_times directly by raw service_id so every date (387_*, 388_*, NH, NS, SO, RS)
  // resolves exact official departures, brigades and operators without synthetic-day loss.
  for (const detail of base.rawTrips) {
    const tripStopTimes = base.rawStopTimesByTrip.get(detail.rawTripId) ?? [];
    if (!tripStopTimes.length) continue;
    const kursowkaId = detail.kursowkaCode
      ? `${detail.routeId}|${detail.serviceId}|${detail.kursowkaCode}`
      : "";
    const brigadeSource = detail.kursowkaCode ? "gtfs" : "none";
    for (const [index, st] of tripStopTimes.entries()) {
      let arr = stopTimesByStopId.get(st.stopId);
      if (!arr) {
        arr = [];
        stopTimesByStopId.set(st.stopId, arr);
      }
      arr.push({
        tripId: detail.rawTripId,
        canBoard: st.pickupType !== 1 && index < tripStopTimes.length - 1,
        rawTripId: detail.rawTripId,
        rawServiceId: detail.serviceId,
        departureMinutes: st.departureMinutes,
        arrivalMinutes: st.arrivalMinutes,
        routeId: detail.routeId,
        serviceId: detail.serviceId,
        kursowkaId,
        kursowkaCode: detail.kursowkaCode,
        operatorKey: detail.operatorKey,
        brigadeSource,
        headsign: detail.headsign,
        directionId: detail.directionId,
        lastStopName: detail.lastStopName,
      });
    }
  }

  const canonicalRouteByShort = new Map(
    base.routes.map((r) => [r.shortName.toUpperCase(), r] as const)
  );

  for (const svc of base.services) {
    const activeRawServices = base.dayTypeServices[svc.serviceId];
    const tripsForDay = new Map<string, RawTripDetail[]>();
    for (const trip of base.rawTrips) {
      if (!activeRawServices.has(trip.serviceId)) continue;
      const canonical = canonicalRouteByShort.get(trip.routeShort.toUpperCase());
      const canonicalId = canonical?.id ?? trip.routeId;
      const list = tripsForDay.get(canonicalId) ?? [];
      list.push(trip);
      tripsForDay.set(canonicalId, list);
    }

    for (const [routeId, routeTrips] of tripsForDay) {
      const schedule: ScheduleTrip[] = routeTrips.map((trip) => ({
        ...trip,
        routeId,
        explicitBrigade: trip.rawBrigade,
      }));
      const assignments = assignDuties(schedule, base.stopsById, observations);
      for (const duty of assignments) {
        const kursowkaId = `${routeId}|${svc.serviceId}|${duty.kursowkaCode}`;
        const firstTrip = base.rawTripsById.get(duty.trips[0].trip.rawTripId)!;
        const lastTrip = base.rawTripsById.get(
          duty.trips[duty.trips.length - 1].trip.rawTripId,
        )!;
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
          tripList.push({
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
          });
        }
        tripList.sort(
          (a, b) => a.startMinutes - b.startMinutes || a.id.localeCompare(b.id),
        );
        tripsByKursowkaId.set(kursowkaId, tripList);
      }
    }
  }
  totalTripsCount = base.rawTrips.length;

  return {
    base,
    feed: {
      id: "walbrzych",
      source: base.source,
      version: `${base.feedVersion}+${DUTY_SCHEMA_VERSION}`,
      generatedAt: new Date().toISOString(),
      stopsCount: base.activeStopIds.size,
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

interface StoredParsedBase {
  version: string;
  identity: string;
  base: ParsedArchiveBase;
}

export interface SyncResult {
  source: string;
  version: string;
  routes: number;
  stops: number;
  trips: number;
  kursowki: number;
}

async function refreshOperatorRosterFromServer(force: boolean): Promise<void> {
  if (STATIC_PAGES) return; // The bundled operator roster works without a server.
  try {
    const res = await fetch(
      `${OFFICIAL_GTFS_PROXY_URL}?kind=operators${force ? "&force=1" : ""}`,
      {
        signal: AbortSignal.timeout(force ? 20_000 : 8_000),
        cache: force ? "no-store" : "default",
      }
    );
    if (!res.ok) return;
    const data = (await res.json()) as {
      dutyOperators?: Record<string, "ska" | "mzuk">;
    };
    if (data?.dutyOperators) {
      updateDynamicDutyOperators(data.dutyOperators);
    }
  } catch {
    /* Bundled live-duty-snapshot.json already holds SKA/MZUK assignments */
  }
}

// A missing static asset can be served as the SPA's HTML with HTTP 200.
function isZipArchive(bytes: Uint8Array): boolean {
  return bytes.byteLength > 1000 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
    bytes[2] === 0x03 && bytes[3] === 0x04;
}

let archiveFromIndexedDb = false;

async function fetchArchiveBytes(
  forceLive: boolean,
): Promise<{ bytes: Uint8Array; source: string }> {
  const sourceOfficial = "gtfs.walbrzych.eu (ST/GTFS full + ŚKA + MZUK)";

  if (forceLive) {
    await refreshOperatorRosterFromServer(true);
    const res = await fetch(STATIC_PAGES ? ZBIORKOM_FALLBACK_GTFS_URL : `${OFFICIAL_GTFS_PROXY_URL}?force=1`, {
      signal: AbortSignal.timeout(25_000),
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(
        `Nie udało się pobrać rozkładu z gtfs.walbrzych.eu: HTTP ${res.status}`,
      );
    }
    const headerSource = res.headers.get("X-Gtfs-Source");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!isZipArchive(bytes)) throw new Error("Pobrany rozkład GTFS nie jest poprawnym archiwum ZIP.");
    return {
      bytes,
      source: headerSource ? decodeURIComponent(headerSource) : (STATIC_PAGES ? "api.zbiorkom.live (Wałbrzych GTFS)" : sourceOfficial),
    };
  }

  const cached = await idbGetKv<StoredArchive>(ARCHIVE_KV_KEY);
  if (
    cached &&
    cached.version === DUTY_SCHEMA_VERSION &&
    cached.bytes instanceof Uint8Array &&
    isZipArchive(cached.bytes) &&
    Date.now() - cached.cachedAt < ARCHIVE_MAX_AGE_MS
  ) {
    archiveFromIndexedDb = true;
    return { bytes: cached.bytes, source: cached.source };
  }

  // Fast initial load: bundled official gtfs.walbrzych.eu archive
  try {
    const bundledRes = await fetch(assetUrl("data/walbrzych-gtfs.zip"), {
      signal: AbortSignal.timeout(8_000),
      cache: "default",
    });
    if (bundledRes.ok) {
      const bytes = new Uint8Array(await bundledRes.arrayBuffer());
      if (isZipArchive(bytes)) {
        void refreshOperatorRosterFromServer(false);
        return { bytes, source: sourceOfficial };
      }
    }
  } catch {
    /* Fall through to server proxy */
  }

  if (!STATIC_PAGES) {
    try {
      await refreshOperatorRosterFromServer(false);
      const res = await fetch(OFFICIAL_GTFS_PROXY_URL, {
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (isZipArchive(bytes)) {
          const headerSource = res.headers.get("X-Gtfs-Source");
          return {
            bytes,
            source: headerSource ? decodeURIComponent(headerSource) : sourceOfficial,
          };
        }
      }
    } catch {
      /* Fall through to zbiorkom fallback */
    }
  }

  try {
    const res = await fetch(ZBIORKOM_FALLBACK_GTFS_URL, {
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (isZipArchive(bytes)) {
        return { bytes, source: "api.zbiorkom.live (Wałbrzych GTFS)" };
      }
    }
  } catch {
    /* Fall through to stale IndexedDB archive */
  }

  if (cached?.bytes instanceof Uint8Array && isZipArchive(cached.bytes)) {
    return { bytes: cached.bytes, source: cached.source };
  }
  throw new Error(
    "Nie udało się pobrać Wałbrzych GTFS. Spróbuj odświeżyć stronę.",
  );
}

/**
 * Tożsamość paczki: długość + sumy kontrolne skrajnych fragmentów + źródło.
 * Wystarcza, żeby nie parsować drugi raz tych samych bajtów (i żeby nie
 * nadpisywać wpisu w IndexedDB, gdy nic się nie zmieniło).
 */
function archiveIdentity(bytes: Uint8Array, source: string): string {
  let head = 0;
  let tail = 0;
  const end = bytes.length;
  for (let i = 0; i < Math.min(2048, end); i += 1) head = (head * 31 + bytes[i]) >>> 0;
  for (let i = Math.max(0, end - 2048); i < end; i += 1) tail = (tail * 31 + bytes[i]) >>> 0;
  return `${end}:${head.toString(36)}:${tail.toString(36)}:${source}`;
}

let currentArchive: { bytes: Uint8Array; source: string; identity: string } | null = null;

/**
 * Zapis samych bajtów paczki (kopia offline + źródło dla `shapes.txt`) także
 * czeka na spokojniejszy moment. Structured clone wielomegabajtowego bufora
 * potrafi zablokować wątek główny na kilkaset milisekund.
 */
function scheduleArchiveCacheWrite(source: string, bytes: Uint8Array): void {
  const write = () => {
    const started = Date.now();
    void idbSetKv<StoredArchive>(ARCHIVE_KV_KEY, {
      version: DUTY_SCHEMA_VERSION,
      source,
      cachedAt: Date.now(),
      bytes,
    })
      .catch(() => undefined)
      .finally(() => recordTiming("gtfs:cache", Date.now() - started));
  };
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  setTimeout(() => {
    if (typeof idle === "function") idle(write, { timeout: 6_000 });
    else write();
  }, 2_500);
}

/**
 * Zapis sparsowanej bazy po pierwszym ekranie.
 *
 * Structured clone tak dużego obiektu (dziesiątki tysięcy wierszy) to praca na
 * wątku głównym, więc zapis czeka, aż strona będzie naprawdę bezczynna —
 * inaczej konkurowałby z pierwszym rysowaniem mapy i autobusów.
 */
function scheduleParsedCacheWrite(identity: string, base: ParsedArchiveBase): void {
  const write = () => {
    const started = Date.now();
    // Kształty trzymamy osobno (dochodzą leniwie) — kopia bez nich jest mniejsza
    // i zawsze spójna.
    const snapshot: ParsedArchiveBase = { ...base, shapesById: new Map() };
    void idbSetKv<StoredParsedBase>(PARSED_KV_KEY, {
      version: DUTY_SCHEMA_VERSION,
      identity,
      base: snapshot,
    })
      .catch(() => undefined)
      .finally(() => recordTiming("gtfs:cache:parsed", Date.now() - started));
  };
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  const later = () => {
    if (typeof idle === "function") idle(write, { timeout: 6_000 });
    else setTimeout(write, 1_500);
  };
  setTimeout(later, 2_000);
}
let bakedIdentity: string | null = null;

async function loadAndBuild(forceLive: boolean): Promise<GtfsMemoryStore> {
  const archiveLap = createLap();
  // Trzy niezależne od siebie zapytania ruszają równocześnie: paczka (sieć lub
  // IndexedDB), gotowa baza z poprzedniego wejścia i obserwacje GPS. Sekwencyjnie
  // sumowały się w jedną, długą blokadę startu.
  const archivePromise = fetchArchiveBytes(forceLive);
  const parsedPromise = forceLive
    ? Promise.resolve(null)
    : idbGetKv<StoredParsedBase>(PARSED_KV_KEY);
  const observationsPromise = loadLiveObservations();
  const { bytes, source } = await archivePromise;
  archiveLap("gtfs:archive");
  currentArchive = { bytes, source, identity: archiveIdentity(bytes, source) };

  // Ponowne „wczytanie” tej samej paczki (np. ręczne odświeżenie rozkładu bez
  // nowych danych) nie może kosztować kolejnego rozpakowania i parsowania.
  if (!forceLive && memoryStore && bakedIdentity === currentArchive.identity) {
    return memoryStore;
  }

  tripMatchCache.clear();
  const lap = createLap();
  // 1. Gotowa baza z poprzedniego wejścia (ten sam plik, ten sam schemat).
  const parsed = await parsedPromise;
  let base: ParsedArchiveBase | null = null;
  if (
    parsed &&
    parsed.version === DUTY_SCHEMA_VERSION &&
    parsed.identity === currentArchive.identity &&
    parsed.base?.rawTrips?.length
  ) {
    base = parsed.base;
  }
  lap("gtfs:parsedCache");
  // 2. Zimny start: rozpakowanie + CSV. Zapis gotowej bazy robimy w tle,
  //    po pierwszym ekranie (structured clone dużego obiektu to praca CPU).
  if (!base) {
    base = await parseArchiveBytes(bytes, source);
    scheduleParsedCacheWrite(currentArchive.identity, base);
  }
  const feedBase = base;
  const observations = await observationsPromise;
  archiveLap("gtfs:observations");
  registerMissingLineSevenDuty(feedBase, observations);
  lap("gtfs:line7");
  const store = buildDutyIndex(feedBase, observations);
  lap("gtfs:index");
  memoryStore = store;
  bakedIdentity = currentArchive.identity;
  observationsDirty = false;
  emitRuntimeEvent("gtfs:updated", { version: store.feed.version });
  // Bajty zapisujemy tylko wtedy, gdy naprawdę pochodzą z sieci — przy trafieniu
  // w cache IndexedDB zapis byłby przepisaniem wielomegabajtowego obiektu bez powodu.
  if (!archiveFromIndexedDb) {
    scheduleArchiveCacheWrite(source, bytes);
  }
  archiveFromIndexedDb = false;
  if (feedBase.shapesById.size === 0) scheduleIdleShapes(store);
  return store;
}

/* -------------------------------------------------------------------------- */
/*  Leniwe kształty (shapes.txt)                                              */
/* -------------------------------------------------------------------------- */

const shapeTaskByBase = new WeakMap<ParsedArchiveBase, Promise<void>>();

/** Wypełnia `base.shapesById` z paczki (raz na bazę, porcjami, bez blokady UI). */
async function parseShapesInto(base: ParsedArchiveBase, zipBytes: Uint8Array): Promise<void> {
  const files = unzipSync(zipBytes, { filter: (file) => file.name === "shapes.txt" });
  const entry = files["shapes.txt"];
  if (!entry) return;
  const reader = createCsvReader(strFromU8(entry));
  const col = reader.index;
  const iId = col("shape_id");
  const iLat = col("shape_pt_lat");
  const iLon = col("shape_pt_lon");
  const iSeq = col("shape_pt_sequence");
  const buckets = new Map<
    string,
    Array<{ block: number; seq: number; lat: number; lon: number }>
  >();
  // Ten sam `shape_id` bywa w paczce opisany w kilku blokach (np. osobno dla
  // obu kierunków) — wtedy numeracja `shape_pt_sequence` zaczyna się od nowa.
  // Bez rozdzielenia bloków sortowanie mieszało punkty i linia „skakała”.
  const lastSeqByShape = new Map<string, number>();
  const blockByShape = new Map<string, number>();
  let cols = reader.next();
  let processed = 0;
  while (cols !== null) {
    const shapeId = iId >= 0 ? cols[iId] : "";
    if (shapeId) {
      const lat = iLat >= 0 ? Number.parseFloat(cols[iLat]) : Number.NaN;
      const lon = iLon >= 0 ? Number.parseFloat(cols[iLon]) : Number.NaN;
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const seq = iSeq >= 0 ? Number.parseInt(cols[iSeq], 10) || 0 : 0;
        const previous = lastSeqByShape.get(shapeId);
        let block = blockByShape.get(shapeId) ?? 0;
        if (previous !== undefined && seq <= previous) {
          block += 1;
          blockByShape.set(shapeId, block);
        }
        lastSeqByShape.set(shapeId, seq);
        const point = { block, seq, lat, lon };
        const list = buckets.get(shapeId);
        if (list) list.push(point);
        else buckets.set(shapeId, [point]);
        processed += 1;
        if (processed % CSV_CHUNK_ROWS === 0) await yieldToMain();
      }
    }
    cols = reader.next();
  }
  for (const [shapeId, points] of buckets) {
    points.sort((a, b) => a.block - b.block || a.seq - b.seq);
    base.shapesById.set(
      shapeId,
      points.map((point) => [point.lat, point.lon] as [number, number]),
    );
  }
}

async function archiveBytesForShapes(): Promise<Uint8Array | null> {
  if (currentArchive) return currentArchive.bytes;
  const cached = await idbGetKv<StoredArchive>(ARCHIVE_KV_KEY);
  if (cached?.bytes instanceof Uint8Array && isZipArchive(cached.bytes)) {
    currentArchive = {
      bytes: cached.bytes,
      source: cached.source,
      identity: archiveIdentity(cached.bytes, cached.source),
    };
    return cached.bytes;
  }
  try {
    const { bytes, source } = await fetchArchiveBytes(false);
    currentArchive = { bytes, source, identity: archiveIdentity(bytes, source) };
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Geometria linii (`shapes.txt`) wczytuje się dopiero wtedy, gdy ktoś naprawdę
 * rysuje trasę — a i wtedy porcjami. Dzięki temu pierwszy ekran nie czeka na
 * najdroższy plik paczki.
 */
export function ensureShapesReady(store: GtfsMemoryStore): Promise<void> {
  const base = store.base;
  if (base.shapesById.size > 0) return Promise.resolve();
  const running = shapeTaskByBase.get(base);
  if (running) return running;
  const task = (async () => {
    const bytes = await archiveBytesForShapes();
    if (!bytes) return;
    const started = Date.now();
    await parseShapesInto(base, bytes);
    recordTiming("gtfs:shapes", Date.now() - started);
  })().finally(() => {
    shapeTaskByBase.delete(base);
  });
  shapeTaskByBase.set(base, task);
  return task;
}

/** W tle, po pierwszym ekranie: pierwsze rysowanie trasy nie czeka na shapes.txt. */
function scheduleIdleShapes(store: GtfsMemoryStore): void {
  const prewarm = () => {
    void ensureShapesReady(store).catch(() => undefined);
  };
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof idle === "function") setTimeout(() => idle(prewarm, { timeout: 5_000 }), 2_500);
  else setTimeout(prewarm, 3_000);
}

export async function ensureGtfsSeeded(): Promise<GtfsMemoryStore> {
  if (memoryStore) {
    if (observationsDirty) {
      observationsDirty = false;
      const observations = await loadLiveObservations();
      registerMissingLineSevenDuty(memoryStore.base, observations);
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
  options: { forceLive?: boolean } = {},
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

const KOZICE_LOOP_LAT = 50.77238;
const KOZICE_LOOP_LON = 16.32741;

function normalizeStopPoint(
  id: string,
  name: string,
  lat: number,
  lon: number,
): { id: string; name: string; lat: number; lon: number } {
  // Przystanek „Strzegomska -Kozice” (8541) w paczce GTFS ma błędne
  // współrzędne w Nowym Julianowie (50.7812, 16.33933) zamiast pętli Kozice.
  const norm = name.toLowerCase().replace(/\s+/g, "");
  if (
    (id === "8541" || norm === "strzegomska-kozice") &&
    distanceCoords(lat, lon, KOZICE_LOOP_LAT, KOZICE_LOOP_LON) > 400
  ) {
    return { id, name: "Strzegomska - Kozice", lat: KOZICE_LOOP_LAT, lon: KOZICE_LOOP_LON };
  }
  return { id, name, lat, lon };
}

/**
 * Punkt przystanku do rysowania: normalny przystanek, a gdy GTFS wstawia w
 * `stop_times` węzeł (`location_type=1`, np. pętla), bierzemy współrzędne węzła.
 * Wcześniej taki wpis był po cichu pomijany i trasa kończyła się o ~300 m za wcześnie.
 */
export function stopPointFor(
  base: ParsedArchiveBase,
  stopId: string,
): { id: string; name: string; lat: number; lon: number } | null {
  const stop = base.stopsById.get(stopId);
  if (stop) return normalizeStopPoint(stop.id, stop.name, stop.lat, stop.lon);
  const station = base.stationById?.get(stopId);
  if (station) return normalizeStopPoint(stopId, station.name, station.lat, station.lon);
  return null;
}

/**
 * Dociąga końcówki polilinii do pierwszego i ostatniego przystanku kursu.
 *
 * Kształty w paczce Wałbrzycha potrafią skończyć się na skrzyżowaniu przed
 * pętlą (linia 11, Kozice: ostatni przystanek jest ~360 m za końcem kształtu).
 * Linia musi dojechać do przystanku końcowego, ale nie dorysowujemy dowolnie
 * długich „ogonów” — tylko do 400 m, żeby nie tworzyć sztucznych odcinków.
 */
export function connectEndsToStops(
  path: [number, number][],
  first: { lat: number; lon: number } | null,
  last: { lat: number; lon: number } | null,
  maxSpurMeters = 400,
): [number, number][] {
  if (path.length < 2) return path;
  const out: [number, number][] = path.map((point) => [point[0], point[1]]);
  const MIN_SPUR_M = 6;
  if (first) {
    const gap = distanceCoords(first.lat, first.lon, out[0][0], out[0][1]);
    if (gap > MIN_SPUR_M && gap <= maxSpurMeters) out.unshift([first.lat, first.lon]);
  }
  if (last) {
    const end = out[out.length - 1];
    const gap = distanceCoords(last.lat, last.lon, end[0], end[1]);
    if (gap > MIN_SPUR_M && gap <= maxSpurMeters) out.push([last.lat, last.lon]);
  }
  return out;
}

function nearestVertexIndex(
  path: [number, number][],
  target: { lat: number; lon: number },
): { index: number; meters: number } {
  let index = -1;
  let meters = Number.POSITIVE_INFINITY;
  for (let i = 0; i < path.length; i += 1) {
    const d = distanceCoords(target.lat, target.lon, path[i][0], path[i][1]);
    if (d < meters) {
      meters = d;
      index = i;
    }
  }
  return { index, meters };
}

function pathLengthMeters(path: [number, number][], from = 0, to = path.length - 1): number {
  let sum = 0;
  for (let i = from; i < to; i += 1) {
    sum += distanceCoords(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
  }
  return sum;
}

/**
 * Przycina kształt do łańcucha przystanków kursu.
 *
 * `shapes.txt` bywa wspólny dla kilku wariantów linii: kształt linii 11 sięga
 * dalej niż przystanek końcowy kursu (np. do wcześniejszego końca trasy), więc
 * rysowana linia „jechała” poza faktyczną pętlę. Tu obcinamy ogon (i początek)
 * kształtu, gdy poza skrajnym przystankiem kursu zostaje więcej niż
 * `maxOvershootMeters` trasy, a sam przystanek leży przy kształcie (≤ `maxSpurMeters`).
 * Pętla na końcu trasy (kilkadziesiąt metrów) zostaje nietknięta, podobnie jak
 * kształt, który kończy się *przed* przystankiem — ten dociąga `connectEndsToStops`.
 */
export function trimShapeToStops(
  shape: [number, number][],
  first: { lat: number; lon: number } | null,
  last: { lat: number; lon: number } | null,
  maxSpurMeters = 400,
  maxOvershootMeters = 120,
): [number, number][] {
  if (shape.length < 3) return shape;
  const total = pathLengthMeters(shape);
  if (!(total > 0)) return shape;
  let points: [number, number][] = shape.map((point) => [point[0], point[1]]);

  if (last) {
    const near = nearestVertexIndex(points, last);
    if (near.index > 0 && near.index < points.length - 1 && near.meters <= maxSpurMeters) {
      const tail = pathLengthMeters(points, near.index);
      const kept = pathLengthMeters(points, 0, near.index);
      // Zostawiamy sensowną większość kształtu — inaczej przy pętli startującej
      // blisko końca obcięlibyśmy całą trasę.
      if (tail > maxOvershootMeters && kept >= total * 0.25) points = points.slice(0, near.index + 1);
    }
  }

  if (first) {
    const near = nearestVertexIndex(points, first);
    if (near.index > 0 && near.index < points.length - 1 && near.meters <= maxSpurMeters) {
      const head = pathLengthMeters(points, 0, near.index);
      const kept = pathLengthMeters(points, near.index);
      if (head > maxOvershootMeters && kept >= total * 0.25) points = points.slice(near.index);
    }
  }

  return points;
}

/**
 * Kształt gotowy do rysowania: przycięty do przystanków kursu i dociągnięty do
 * pierwszego/ostatniego przystanku. Wszystkie widoki trasy (karta autobusu,
 * kursówka, katalog linii, kurs w planerze) muszą rysować przez tę funkcję,
 * żeby linia nigdy nie wybiegała poza swój przystanek końcowy.
 */
function stripZeromskiegoDetour(points: [number, number][]): [number, number][] {
  if (points.length < 4) return points;
  // Usuń stary objazd przez Europejkę (na południe od ul. Żeromskiego między
  // przystankami Żeromskiego - Oczki a Wańkowicza - Bema).
  return points.filter(
    ([lat, lon]) => !(lat < 50.7873 && lon > 16.269 && lon < 16.28),
  );
}

export function shapeForTripStops(
  shape: [number, number][],
  first: { lat: number; lon: number } | null,
  last: { lat: number; lon: number } | null,
  maxSpurMeters = 400,
): [number, number][] {
  return connectEndsToStops(
    stripZeromskiegoDetour(trimShapeToStops(shape, first, last, maxSpurMeters)),
    first,
    last,
    maxSpurMeters,
  );
}

/** Store z gotowymi kształtami tras — dla funkcji, które rysują geometrię. */
async function seededWithShapes(): Promise<GtfsMemoryStore> {
  const store = await ensureGtfsSeeded();
  await ensureShapesReady(store);
  return store;
}

export async function getGtfsStatus(): Promise<{ feed: GtfsFeedInfo }> {
  const store = await ensureGtfsSeeded();
  return { feed: store.feed };
}

export async function getGtfsLines(): Promise<GtfsLinesPayload> {
  const store = await ensureGtfsSeeded();
  const now = DateTime.now().setZone(ZONE);
  const todayKey = Number(now.toFormat("yyyyMMdd"));
  const defaultServiceId = serviceForDate(
    store.base.services,
    todayKey,
    now.weekday,
  );
  const order: Record<string, number> = { weekday: 1, saturday: 2, sunday: 3 };
  const sortedServices = [...store.base.services].sort(
    (a, b) => (order[a.serviceId] ?? 9) - (order[b.serviceId] ?? 9),
  );

  return {
    feed: {
      ...store.feed,
      version: store.feed.version.split("+")[0],
    },
    todayKey,
    feedFrom: store.base.feedStartDate,
    feedTo: store.base.feedEndDate,
    defaultServiceId,
    feedCoversToday: store.base.serviceIdsByDate.has(todayKey),
    uniqueDutiesCount: new Set(
      store.kursowki
        .filter((d) => d.brigadeNum !== "?")
        .map((d) => d.kursowkaCode),
    ).size,
    services: sortedServices.map((s) => ({
      serviceId: s.serviceId,
      label: s.label,
      isToday: s.serviceId === defaultServiceId,
      datesCount: s.datesJson.length,
    })),
    routes: Array.from(
      new Map(
        store.base.routes.map((route) => [route.shortName.trim().toUpperCase(), route])
      ).values()
    ).map((route) => {
      const targetShort = route.shortName.trim().toUpperCase();
      const perService: Record<
        string,
        { kursowkiCount: number; tripsCount: number }
      > = {};
      for (const service of store.base.services) {
        const matches = store.kursowki.filter(
          (duty) =>
            duty.routeShort.trim().toUpperCase() === targetShort &&
            duty.serviceId === service.serviceId
        );
        if (matches.length) {
          perService[service.serviceId] = {
            kursowkiCount: new Set(
              matches
                .filter((duty) => duty.brigadeNum !== "?")
                .map((duty) => duty.kursowkaCode)
            ).size,
            tripsCount: matches.reduce((sum, duty) => sum + duty.tripCount, 0),
          };
        }
      }
      return { ...route, perService };
    }),
  };
}

export async function getDutyCatalog(
  options: { routeId?: string; serviceId?: string } = {},
): Promise<{
  items: DutySummary[];
  routes: GtfsRouteRecord[];
  services: GtfsServiceRecord[];
  route: GtfsRouteRecord | null;
  liveError: string | null;
  counts: DutyCatalogCounts;
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
      (serviceId === "all" || row.serviceId === serviceId),
  );

  const labelOf = (sid: string) =>
    store.base.services.find((s) => s.serviceId === sid)?.label ??
    (sid === "live" ? "Tylko GPS" : sid);

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
      (bus) =>
        bus.routeName.toUpperCase() === targetRoute?.shortName.toUpperCase(),
    );
  }

  const live = new Map(
    vehicles
      .filter(
        (bus) =>
          bus.dutyStatus === "confirmed" &&
          Boolean(bus.dutyCode) &&
          (bus.dutyCode ?? "").includes("/"),
      )
      .map((bus) => [bus.dutyCode!, bus]),
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
      serviceLabel: labelOf(row.serviceId),
    };
  });

  const represented = new Set(items.map((item) => item.kursowkaCode));
  for (const bus of live.values()) {
    if (represented.has(bus.kursowka)) continue;
    const route = store.base.routes.find(
      (r) => r.shortName.toUpperCase() === bus.routeName.toUpperCase(),
    );
    if (!route || (routeId && route.id !== routeId)) continue;
    items.push({
      id: `live|${route.id}|${bus.kursowka}`,
      routeId: route.id,
      routeShort: route.shortName,
      serviceId: serviceId !== "all" ? serviceId : "live",
      kursowkaCode: bus.dutyCode ?? "",
      brigadeNum: bus.dutyCode?.split("/")[1] ?? "",
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
      serviceLabel: labelOf(serviceId !== "all" ? serviceId : "live"),
    });
    represented.add(bus.kursowka);
  }

  items.sort(
    (a, b) =>
      a.routeShort.localeCompare(b.routeShort, "pl", { numeric: true }) ||
      Number(a.unassigned) - Number(b.unassigned) ||
      a.brigadeNum.localeCompare(b.brigadeNum, "pl", { numeric: true }) ||
      a.serviceId.localeCompare(b.serviceId),
  );

  return {
    items,
    routes: store.base.routes,
    services: store.base.services,
    route: routeId ? (store.base.routesById.get(routeId) ?? null) : null,
    liveError,
    counts: {
      total: items.length,
      withSchedule: items.filter((item) => item.hasSchedule).length,
      onGps: items.filter((item) => item.liveBus).length,
      unassigned: items.filter((item) => item.unassigned).length,
    },
    vehicleNumbers: Object.fromEntries(
      vehicles.map((bus) => [
        bus.vehicleId,
        formatVehicleNumber(bus.vehicleId),
      ]),
    ),
  };
}

export async function getDutyDetail(options: {
  id?: string;
  code?: string;
  serviceId?: string;
}): Promise<DutyDetailPayload> {
  const store = await seededWithShapes();
  const id = options.id?.trim() || "";
  const code = normalizeDutyCode(options.code || "");
  const rawService = options.serviceId?.trim() || "";
  /** "all" means "any day type" — it must never be matched as a concrete calendar. */
  const requestedService = rawService === "all" ? "" : rawService;
  const catalog = await getDutyCatalog({ serviceId: "all" });

  const now = DateTime.now().setZone(ZONE);
  const todayService = serviceForDate(
    catalog.services,
    Number(now.toFormat("yyyyMMdd")),
    now.weekday,
  );

  let selected: DutySummary | undefined;
  if (id) selected = catalog.items.find((item) => item.id === id);
  if (!selected && (code || id)) {
    const parts = (id.startsWith("live|") ? id.slice(5) : id).split("|");
    const wantedCode = code || normalizeDutyCode(parts.at(-1) || "");
    const routeId = id.includes("|") ? parts[0] : undefined;
    const service =
      requestedService || (id.includes("|") ? parts[1] : todayService);
    const candidates = catalog.items.filter(
      (item) =>
        item.kursowkaCode === wantedCode &&
        (!routeId || item.routeId === routeId) &&
        !item.unassigned,
    );
    selected =
      candidates.find((item) => item.serviceId === service) ??
      candidates.find((item) => item.liveBus) ??
      candidates.find((item) => item.serviceId === todayService) ??
      candidates[0];
    if (!selected && id.startsWith("live|")) {
      const liveRoute = catalog.routes.find((route) => route.id === routeId);
      if (
        liveRoute &&
        wantedCode.startsWith(`${liveRoute.shortName.toUpperCase()}/`)
      ) {
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
          serviceLabel:
            catalog.services.find((s) => s.serviceId === service)?.label ??
            "Tylko GPS",
        };
      }
    }
    if (
      selected &&
      requestedService &&
      selected.serviceId !== requestedService
    ) {
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
        serviceLabel:
          catalog.services.find((s) => s.serviceId === requestedService)
            ?.label ?? "Tylko GPS",
      };
    }
  }

  if (!selected) {
    throw new Error(
      "Nie znaleziono kursówki. Wyszukaj ją po numerze linii i kursówki, np. 2/03.",
    );
  }

  const route = store.base.routesById.get(selected.routeId) ?? null;
  const trips = selected.hasSchedule
    ? (store.tripsByKursowkaId.get(selected.id) ?? [])
    : [];

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
      const rawStopTimes =
        store.base.rawStopTimesByTrip.get(trip.rawTripId) ?? [];
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
          const stop = stopPointFor(store.base, st.stopId);
          return {
            tripId: trip.id,
            stopId: st.stopId,
            stopSequence: st.stopSequence,
            arrivalMinutes: st.arrivalMinutes,
            departureMinutes: st.departureMinutes,
            stopName: stop?.name ?? store.base.stopNamesById.get(st.stopId) ?? st.stopId,
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

/**
 * Litera i opis oficjalnego wariantu kursu (legenda linii).
 *
 * Lista przystanków jest potrzebna tylko dla wariantów „przez …”; wynik jest
 * liczony raz na kurs i trzymany przy danym archiwum GTFS (WeakMap czyści się
 * razem ze starym feedem). Brak trasy nie tworzy litery: kurs zostaje
 * podstawowy, zamiast zgadywać kierunek z pierwszej litery nazwy.
 */
const legendCacheByBase = new WeakMap<
  ParsedArchiveBase,
  Map<string, { code: string; text: string }>
>();

function tripLegend(
  base: ParsedArchiveBase,
  rawTripId: string,
  line: string,
  destination: string,
  headsign: string,
): { code: string; text: string } {
  let cache = legendCacheByBase.get(base);
  if (!cache) {
    cache = new Map();
    legendCacheByBase.set(base, cache);
  }
  const hit = cache.get(rawTripId);
  if (hit) return hit;
  const stops = lineLegendNeedsStops(line)
    ? (base.rawStopTimesByTrip.get(rawTripId) ?? []).map(
        (st) => base.stopsById.get(st.stopId)?.name ?? base.stopNamesById.get(st.stopId) ?? "",
      )
    : undefined;
  // Końcowy przystanek z rozkładu jest pewniejszy niż `headsign` z GTFS.
  const code = legendCodeForTrip(line, {
    terminus: stops?.length ? stops[stops.length - 1] : undefined,
    destination,
    headsign,
    stops,
  });
  const value = { code, text: legendText(line, code) };
  cache.set(rawTripId, value);
  return value;
}

export async function getStopDepartures(options: {
  lat: number;
  lon: number;
  name?: string;
  stopId?: string;
  stopIds?: readonly string[];
  fromMs?: number;
  /** Exclusive end of a timetable window; with no limit, return every departure. */
  toMs?: number;
  limit?: number;
  /** Return the scheduled times without waiting for the optional GPS services. */
  includeLive?: boolean;
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
  /** The requested day is outside the feed's explicitly declared validity. */
  outsideFeedValidity?: boolean;
}> {
  // Read each original platform ID independently (including its live feed),
  // then merge before applying the limit so no branch of the timetable is lost.
  const ids = [...new Set(options.stopIds ?? [])];
  if (ids.length > 1) {
    const store = await ensureGtfsSeeded();
    if (ids.some((id) => !store.base.stopsById.has(id))) throw new Error("Brak identyfikatora połączonego przystanku w GTFS.");
    const parts = await Promise.all(ids.map((stopId) => getStopDepartures({
      ...options, stopId, stopIds: undefined, limit: undefined,
      // Unbounded requests otherwise default to ten results per source.
      toMs: options.toMs ?? Number.MAX_SAFE_INTEGER,
    })));
    const departures = new Map<string, StopDepartureItem>();
    for (const part of parts) for (const departure of part.departures) {
      departures.set(`${departure.tripId}|${departure.serviceDateId}|${departure.atMs}`, departure);
    }
    const limit = options.limit === undefined && Number.isFinite(options.toMs)
      ? Infinity : Math.min(500, Math.max(1, options.limit ?? 10));
    return {
      matched: parts[0].matched,
      departures: [...departures.values()].sort((a, b) => a.atMs - b.atMs).slice(0, limit),
      outsideFeedValidity: parts.some((part) => part.outsideFeedValidity),
    };
  }
  const store = await ensureGtfsSeeded();
  const { lat, lon } = options;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("Wymagane współrzędne lat i lon.");
  }
  const boundedWindow = Number.isFinite(options.toMs);
  const limit =
    boundedWindow && options.limit === undefined
      ? Infinity
      : Math.min(500, Math.max(1, options.limit ?? 10));
  const fromTime = Number.isFinite(options.fromMs)
    ? options.fromMs!
    : Date.now();
  const toTime = boundedWindow ? options.toMs! : Infinity;
  const fromDate = new Date(fromTime);
  const requestedDate = Number(DateTime.fromJSDate(fromDate, { zone: ZONE }).toFormat("yyyyLLdd"));
  const outsideFeedValidity =
    (store.base.feedStartDate > 0 && requestedDate < store.base.feedStartDate) ||
    (store.base.feedEndDate > 0 && requestedDate > store.base.feedEndDate);

  const targetNorm = options.name ? normalizeStopName(options.name) : "";
  let matched = options.stopId
    ? (store.base.stopsById.get(options.stopId) ?? null)
    : null;
  let bestDist = matched ? distanceMeters(lat, lon, matched.lat, matched.lon) : Infinity;

  const candidateStops = getActiveStopsForBase(store.base);

  if (!matched && targetNorm) {
    // Snapshot/OSM stops have no GTFS ID. Match both the complete name and
    // location; falling back to a different nearby stop can show the timetable
    // of the opposite platform or even another street.
    const candidates = candidateStops
      .filter((stop) => stop.normalizedName === targetNorm)
      .map((stop) => ({ stop, distance: distanceMeters(lat, lon, stop.lat, stop.lon) }))
      .filter(({ distance }) => distance < 50)
      .sort((a, b) => a.distance - b.distance);
    if (candidates[0] && (!candidates[1] || candidates[1].distance - candidates[0].distance >= 3)) {
      matched = candidates[0].stop;
      bestDist = candidates[0].distance;
    }
  } else if (!matched && !targetNorm) {
    // Coordinate-only requests can still ask for the nearest stop.
    bestDist = 95;
    for (const stop of candidateStops) {
      const distance = distanceMeters(lat, lon, stop.lat, stop.lon);
      if (distance < bestDist) {
        bestDist = distance;
        matched = stop;
      }
    }
  }

  if (!matched) {
    return { matched: null, departures: [], outsideFeedValidity };
  }

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

  const nowMs = Date.now();
  const windowIncludesLiveNow =
    nowMs >= fromTime - 2 * 3600_000 && nowMs <= toTime + 30 * 60_000;

  let liveStopMatches: LiveStopDepartureMatch[] = [];
  if (options.includeLive !== false && windowIncludesLiveNow) {
    const [liveFleet, stopMatches] = await Promise.all([
      (async () => {
        try {
          return getLatestFleetSnapshot() ?? (await getLiveWalbrzychBuses());
        } catch {
          return null;
        }
      })(),
      fetchLiveStopDeparturesCached(
        matched.id,
        Math.floor(Math.max(fromTime, Math.min(nowMs, toTime - 1)) / 10_000) * 10_000
      ),
    ]);

    liveStopMatches = stopMatches;
    if (liveFleet) {
      for (const v of liveFleet.vehicles) {
        const item: LiveMatchItem = {
          vehicleId: v.vehicleId,
          operatorName: v.operatorName,
          kursowka: v.kursowka,
          delaySeconds: v.delaySeconds,
          timestamp: v.timestamp,
          operatorKey: v.operatorKey,
        };
        if (v.tripId) liveByTrip.set(v.tripId, item);
        if (v.kursowka) {
          for (const st of v.upcomingStops) {
            liveBySchedule.set(`${v.kursowka}|${st.scheduledDeparture}`, item);
          }
        }
      }
    }
  }

  const results: StopDepartureItem[] = [];
  const baseDt = DateTime.fromJSDate(fromDate, { zone: ZONE });

  for (const dayOffset of [-1, 0, 1]) {
    const serviceDay = baseDt.plus({ days: dayOffset }).startOf("day");
    const dateStr = serviceDay.toFormat("yyyyLLdd");
    const dateKey = Number(dateStr);
    if (
      (store.base.feedStartDate > 0 && dateKey < store.base.feedStartDate) ||
      (store.base.feedEndDate > 0 && dateKey > store.base.feedEndDate)
    ) continue;
    const activeServices = store.base.serviceIdsByDate.get(dateKey);
    if (!activeServices?.size) continue;

    const dayStartMs = serviceDay.toMillis();
    const sameDayDateLabel = formatWarsawShortDate(dayStartMs + 12 * 3600_000);
    const nextDayDateLabel = formatWarsawShortDate(dayStartMs + 36 * 3600_000);
    // Official GTFS provides a real block_id for every course. Only reconstruct
    // a roster when a source feed actually lacks a block_id.
    const needsRoster = stopTimesRows.some(
      (row) => activeServices.has(row.rawServiceId) && !row.kursowkaCode
    );
    const dutyByTrip = needsRoster
      ? getCachedRosterDutiesForDay(store, dateStr, dateKey, dayStartMs)
      : null;

    for (const row of stopTimesRows) {
      if (!row.canBoard) continue;
      if (!activeServices.has(row.rawServiceId)) continue;
      const atMs = dayStartMs + row.departureMinutes * 60_000;
      if (atMs < fromTime - (boundedWindow ? 0 : 60_000) || atMs >= toTime)
        continue;

      const route = store.base.routesById.get(row.routeId);
      const routeShort = route?.shortName ?? row.routeId;
      const routeShortUpper = routeShort.toUpperCase();
      const rosterCode = dutyByTrip?.get(row.rawTripId) ?? null;
      const verifiedDuty = row.kursowkaCode || rosterCode;
      const byTrip = liveByTrip.get(row.rawTripId);
      const liveMatch =
        (byTrip && Math.abs(atMs - byTrip.timestamp) < 90 * 60_000
          ? byTrip
          : undefined) ??
        (verifiedDuty ? liveBySchedule.get(`${verifiedDuty}|${atMs}`) : undefined);
      const dutyCode = verifiedDuty || liveMatch?.kursowka || "";
      const scheduledOperator =
        row.operatorKey !== "other"
          ? row.operatorKey
          : dutyCode
            ? resolveDutyOperator(row.rawServiceId, dutyCode)
            : "other";
      const operatorKey =
        liveMatch?.operatorKey ??
        (scheduledOperator !== "other" ? scheduledOperator : null);

      let liveStop: LiveStopDepartureMatch | undefined;
      if (liveStopMatches.length > 0) {
        const expectedHeadsign = normalizeStopName(row.headsign || row.lastStopName);
        liveStop = liveStopMatches.find(
          (m) =>
            m.routeShort === routeShortUpper &&
            (!m.headsignNorm || m.headsignNorm === expectedHeadsign) &&
            Math.abs(m.scheduledDeparture - atMs) <= 90_000
        );
      }

      // Kierunek odjazdu = **ostatni przystanek kursu z rozkładu**. `trip_headsign`
      // z paczki bywa nieaktualny (linia 11: „Nowy Julianów”, choć kurs kończy na
      // pętli Strzegomska – Kozice), a to on trafiał na tablicę odjazdów.
      const finalStop =
        row.lastStopName || row.headsign || route?.longName || "Końcowy";
      const legend = tripLegend(store.base, row.rawTripId, routeShort, finalStop, row.headsign);

      results.push({
        tripId: row.tripId,
        serviceDateId: dateStr,
        kursowkaId: dutyCode ? `roster|${dutyCode}` : "",
        kursowka: dutyCode,
        brigadeSource: row.kursowkaCode
          ? "gtfs"
          : liveMatch?.kursowka
            ? "live_gps"
            : rosterCode
              ? "roster"
              : "none",
        routeShort,
        routeColor: route?.color ?? "#0d4f3b",
        routeTextColor: route?.textColor ?? "#ffffff",
        routeLong: route?.longName ?? "",
        headsign: row.headsign,
        finalStop,
        legendCode: legend.code,
        legendText: legend.text,
        direction: row.directionId,
        minutes: row.departureMinutes,
        atMs,
        clock: clock(row.departureMinutes),
        dateLabel: row.departureMinutes >= 1440 ? nextDayDateLabel : sameDayDateLabel,
        isRealtime: Boolean(liveMatch || liveStop?.isRealtime),
        delaySeconds: liveMatch?.delaySeconds ?? liveStop?.delaySeconds ?? 0,
        vehicleId: liveMatch?.vehicleId ?? null,
        operatorName: liveMatch?.operatorName ?? (operatorKey ? OPERATOR_NAMES[operatorKey] : null),
        operatorKey,
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
    outsideFeedValidity,
  };
}

/**
 * Długość kursu w metrach — po kształcie trasy (shapes.txt), a gdy go brak,
 * po kolejnych przystankach. Wyliczana raz na dany feed.
 */
interface LiveStopDepartureMatch {
  routeShort: string;
  headsign: string;
  headsignNorm: string;
  scheduledDeparture: number;
  delaySeconds: number;
  isRealtime: boolean;
}

const activeStopsByBase = new WeakMap<ParsedArchiveBase, GtfsStopRecord[]>();
const dayRosterDutyCache = new WeakMap<
  GtfsMemoryStore,
  Map<string, Map<string, string>>
>();
const liveStopDeparturesCache = new LruTtlCache<
  string,
  LiveStopDepartureMatch[]
>(80, 15_000);

function getActiveStopsForBase(base: ParsedArchiveBase): GtfsStopRecord[] {
  let cached = activeStopsByBase.get(base);
  if (!cached) {
    cached = base.stops.filter((s) => base.activeStopIds.has(s.id));
    activeStopsByBase.set(base, cached);
  }
  return cached;
}

function getCachedRosterDutiesForDay(
  store: GtfsMemoryStore,
  dateStr: string,
  dateKey: number,
  dayStartMs: number
): Map<string, string> {
  let perStore = dayRosterDutyCache.get(store);
  if (!perStore) {
    perStore = new Map();
    dayRosterDutyCache.set(store, perStore);
  }
  const cacheKey = `${dateStr}|${getDutyRosterRevision()}`;
  const hit = perStore.get(cacheKey);
  if (hit) return hit;

  const rawServices = store.base.serviceIdsByDate.get(dateKey);
  if (!rawServices?.size) {
    const empty = new Map<string, string>();
    perStore.set(cacheKey, empty);
    return empty;
  }

  const mapped = rosterDutiesForTrips(
    dateStr,
    store.base.rawTrips
      .filter((trip) => rawServices.has(trip.serviceId))
      .map((trip) => ({
        id: trip.rawTripId,
        line:
          store.base.routesById.get(trip.routeId)?.shortName ?? trip.routeShort,
        startMs: dayStartMs + trip.startMinutes * 60_000,
      }))
  );
  perStore.set(cacheKey, mapped);
  return mapped;
}

function fetchLiveStopDeparturesCached(
  stopId: string,
  bucketTimeMs: number
): Promise<LiveStopDepartureMatch[]> {
  const key = `${stopId}|${bucketTimeMs}`;
  const cached = liveStopDeparturesCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);

  return runDeduped(`stopLive:${key}`, async () => {
    const matches: LiveStopDepartureMatch[] = [];
    try {
      const res = await fetch(
        `https://api.zbiorkom.live/api6-open/walbrzych/stops/${encodeURIComponent(stopId)}?limit=40&time=${bucketTimeMs}`,
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
            const headsign = String(d.trip?.headsign ?? "");
            matches.push({
              routeShort: String(d.trip?.route?.name ?? "").toUpperCase(),
              headsign,
              headsignNorm: headsign ? normalizeStopName(headsign) : "",
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
    liveStopDeparturesCache.set(key, matches);
    return matches;
  });
}

const tripLengthCache = new WeakMap<GtfsMemoryStore, Map<string, number>>();
const polylineMeters = polylineLengthMeters;

/** Mapa długości wszystkich kursów danego dnia w metrach. */
export async function getTripLengthMap(): Promise<Map<string, number>> {
  const store = await seededWithShapes();
  const cached = tripLengthCache.get(store);
  if (cached) return cached;
  const lengths = new Map<string, number>();
  for (const trip of store.base.rawTrips) {
    const stops = store.base.rawStopTimesByTrip.get(trip.rawTripId) ?? [];
    const stopPoints: [number, number][] = [];
    for (const st of stops) {
      const stop = store.base.stopsById.get(st.stopId);
      if (stop) stopPoints.push([stop.lat, stop.lon]);
    }
    const shape = trip.shapeId
      ? store.base.shapesById.get(trip.shapeId)
      : undefined;
    let meters = 0;
    if (shape && shape.length >= 2) {
      const byShape = polylineMeters(shape);
      const byStops = polylineMeters(stopPoints);
      // Kształt bywa dłuższy niż kurs (warianty, pętle) — wybieramy wiarygodniejszy.
      meters = byStops > 0 && byShape > byStops * 2.4 ? byStops : byShape;
    } else {
      meters = polylineMeters(stopPoints);
    }
    lengths.set(trip.rawTripId, Math.max(0, Math.round(meters)));
  }
  tripLengthCache.set(store, lengths);
  return lengths;
}

export interface LineRouteGeometry {
  routeId: string;
  routeShort: string;
  routeName: string;
  /** Stabilny odcisk zestawu kształtów — klucz pamięci podręcznej OSM. */
  signature: string;
  /** Polilinia wszystkich wariantów trasy; do liczenia odległości obiektów OSM. */
  points: [number, number][];
  stops: Array<{ id: string; name: string; lat: number; lon: number }>;
}

const lineGeometryCache = new WeakMap<
  GtfsMemoryStore,
  Map<string, LineRouteGeometry | null>
>();

function geometrySignature(routeId: string, shapeIds: string[]): string {
  // FNV-1a: krótki, stabilny klucz cache bez zależności od kolejności wariantów.
  let hash = 0x811c9dc5;
  for (const char of `${routeId}|${[...shapeIds].sort().join(",")}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${routeId}-${(hash >>> 0).toString(36)}`;
}

/** Geometria i przystanki linii — wszystkie warianty kierunkowe z shapes.txt. */
export async function getLineRouteGeometry(
  routeShort: string,
): Promise<LineRouteGeometry | null> {
  const store = await seededWithShapes();
  const wanted = routeShort.trim().toUpperCase();
  let cache = lineGeometryCache.get(store);
  if (!cache) {
    cache = new Map();
    lineGeometryCache.set(store, cache);
  }
  if (cache.has(wanted)) return cache.get(wanted) ?? null;

  const base = store.base;
  const route = base.routes.find(
    (item) =>
      item.shortName.trim().toUpperCase() === wanted || item.id === routeShort,
  );
  if (!route) {
    cache.set(wanted, null);
    return null;
  }
  const allTrips = base.rawTrips.filter((trip) => trip.routeId === route.id);
  // Paczka zawiera kilka okresów rozkładowych. Geometria linii ma pokazywać
  // trasę z aktualnego rozkładu, a nie sumę kształtów z całej paczki — inaczej
  // linia jechała do przystanku, którego już nie obsługuje (linia 11 → Julianów).
  const today = Number(DateTime.now().setZone(ZONE).toFormat("yyyyLLdd"));
  const refDateKey = [...base.serviceIdsByDate.keys()].sort(
    (a, b) => Math.abs(a - today) - Math.abs(b - today) || a - b,
  )[0];
  const refServices = refDateKey === undefined ? undefined : base.serviceIdsByDate.get(refDateKey);
  const activeTrips = refServices?.size
    ? allTrips.filter((trip) => refServices.has(trip.serviceId))
    : [];
  const trips = activeTrips.length ? activeTrips : allTrips;
  const shapeIds = [
    ...new Set(
      trips
        .map((trip) => trip.shapeId)
        .filter((id): id is string => Boolean(id)),
    ),
  ]
    .filter((id) => (base.shapesById.get(id)?.length ?? 0) >= 2)
    .sort(
      (a, b) =>
        (base.shapesById.get(b)?.length ?? 0) -
        (base.shapesById.get(a)?.length ?? 0),
    )
    .slice(0, 16);

  const points: [number, number][] = [];
  const seen = new Set<string>();
  const pushPoint = (lat: number, lon: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    if (seen.has(key)) return;
    seen.add(key);
    points.push([lat, lon]);
  };
  for (const id of shapeIds) {
    for (const point of base.shapesById.get(id) ?? [])
      pushPoint(point[0], point[1]);
  }

  const stopById = new Map<
    string,
    { id: string; name: string; lat: number; lon: number }
  >();
  for (const trip of trips) {
    for (const st of base.rawStopTimesByTrip.get(trip.rawTripId) ?? []) {
      if (stopById.has(st.stopId)) continue;
      const stop = base.stopsById.get(st.stopId);
      if (!stop) continue;
      stopById.set(st.stopId, {
        id: stop.id,
        name: stop.name,
        lat: stop.lat,
        lon: stop.lon,
      });
    }
  }
  const stops = [...stopById.values()];

  // Linie bez shapes.txt: przybliżona polilinia przez przystanki wariantów.
  if (points.length < 2) {
    for (const stop of stops) pushPoint(stop.lat, stop.lon);
  }
  if (points.length < 2) {
    cache.set(wanted, null);
    return null;
  }

  const result: LineRouteGeometry = {
    routeId: route.id,
    routeShort: route.shortName,
    routeName: route.longName,
    signature: geometrySignature(route.id, shapeIds),
    points,
    stops,
  };
  cache.set(wanted, result);
  return result;
}

/** Proste wyszukiwanie przystanków GTFS po nazwie (do planera podróży). */
export async function searchGtfsStops(
  query: string,
  limit = 8,
): Promise<GtfsStopRecord[]> {
  const store = await ensureGtfsSeeded();
  const q = normalizeStopName(query);
  if (q.length < 2) return [];
  const exact: GtfsStopRecord[] = [];
  const partial: GtfsStopRecord[] = [];
  for (const s of store.base.stops) {
    if (!store.base.activeStopIds.has(s.id)) continue;
    if (s.normalizedName === q) exact.push(s);
    else if (s.normalizedName.includes(q)) partial.push(s);
  }
  const merged = [...exact, ...partial].sort((a, b) =>
    a.name.localeCompare(b.name, "pl"),
  );
  return merged.slice(0, limit);
}

interface VehicleTripMatch {
  tripId: string;
  /** Początek dnia obsługi kursu (ms); obsługuje kursy po północy (>24:00). */
  dayStartMs: number;
  /** Przesunięcie numeracji przystanków między GPS a GTFS (0 lub 1). */
  seqOffset: number;
  /** Numer przystanku, na którym autobus jest teraz (lub tuż przed nim). */
  minSeq: number;
  stops: GtfsStopTimeRecord[];
  liveBySeq: Map<number, LiveBusVehicle["upcomingStops"][number]>;
}

/**
 * Dopasowuje pojazd GPS do kursu w paczce GTFS (albo po `tripId`, albo po
 * linii + przystanku + godzinie) i zwraca **cały** kurs: przebyte przystanki,
 * bieżący i pozostałe. Wspólne źródło dla karty „Przystanki do końcowego”
 * i dla pełnego przebiegu kursu (jak w myBus 3.0).
 */
async function resolveVehicleTrip(bus: LiveBusVehicle): Promise<VehicleTripMatch | null> {
  const fallback = bus.upcomingStops ?? [];
  const store = await ensureGtfsSeeded();

  const firstLive = fallback[0];
  const refMs = firstLive?.scheduledDeparture || bus.timestamp || Date.now();
  const refDt = DateTime.fromMillis(refMs, { zone: ZONE });
  // Handle late-night GTFS trips (>24:00) by checking both current day and previous service day
  const candidateDays = [
    refDt.startOf("day"),
    refDt.minus({ days: 1 }).startOf("day"),
  ];

  let matchedTripId: string | null =
    bus.tripId && store.base.rawStopTimesByTrip.has(bus.tripId)
      ? bus.tripId
      : null;
  let matchedDayStartMs = refDt.startOf("day").toMillis();

  if (matchedTripId && firstLive) {
    const sts = store.base.rawStopTimesByTrip.get(matchedTripId);
    const matchSt = sts?.find((s) => s.stopSequence === firstLive.sequence);
    if (matchSt) {
      for (const day of candidateDays) {
        const at = day.toMillis() + matchSt.departureMinutes * 60_000;
        if (Math.abs(at - firstLive.scheduledDeparture) <= 120_000) {
          matchedDayStartMs = day.toMillis();
          break;
        }
      }
    }
  }

  // Full scan of all trips is expensive, so the match result is cached by
  // (route, stop, sequence, minute) — vehicles on the same trip reuse it.
  let cachedMatch: { tripId: string; dayStartMs: number } | undefined;
  let cacheKey = "";

  if (!matchedTripId && firstLive && bus.routeName) {
    const wantedRoute = bus.routeName.trim().toUpperCase();
    const wantedStopNorm = normalizeStopName(firstLive.name);
    const wantedHeadsignNorm = bus.headsign
      ? normalizeStopName(bus.headsign)
      : "";
    cacheKey = `${wantedRoute}|${wantedStopNorm}|${firstLive.sequence}|${Math.round(
      (firstLive.scheduledDeparture - candidateDays[0].toMillis()) / 60_000,
    )}`;
    cachedMatch = tripMatchCache.get(cacheKey);
    if (tripMatchCache.size > TRIP_MATCH_CACHE_MAX) tripMatchCache.clear();
    if (cachedMatch) {
      matchedTripId = cachedMatch.tripId;
      matchedDayStartMs = cachedMatch.dayStartMs;
    }

    let bestScore = -1;
    for (const day of candidateDays) {
      if (cachedMatch) break;
      const dateKey = Number(day.toFormat("yyyyMMdd"));
      const activeServices = store.base.serviceIdsByDate.get(dateKey);
      const dayStartMs = day.toMillis();
      const targetMin = Math.round(
        (firstLive.scheduledDeparture - dayStartMs) / 60_000,
      );
      if (targetMin < 0 || targetMin > 30 * 60) continue;

      for (const trip of store.base.rawTrips) {
        if (trip.routeShort.toUpperCase() !== wantedRoute) continue;
        if (
          activeServices &&
          activeServices.size > 0 &&
          !activeServices.has(trip.serviceId)
        ) {
          continue;
        }
        const sts = store.base.rawStopTimesByTrip.get(trip.rawTripId);
        if (!sts || !sts.length) continue;
        // zbiorkom uses 0-based stop sequence while gtfs.walbrzych.eu uses 1-based stop_sequence
        const st = sts.find((item) => {
          if (
            item.stopSequence !== firstLive.sequence &&
            item.stopSequence !== firstLive.sequence + 1
          ) {
            return false;
          }
          if (Math.abs(item.departureMinutes - targetMin) > 2) return false;
          const stopRec = store.base.stopsById.get(item.stopId);
          return Boolean(stopRec && stopRec.normalizedName === wantedStopNorm);
        });
        if (!st) continue;

        let score = 10 - Math.abs(st.departureMinutes - targetMin);
        if (
          wantedHeadsignNorm &&
          normalizeStopName(trip.headsign) === wantedHeadsignNorm
        ) {
          score += 5;
        }
        if (score > bestScore) {
          bestScore = score;
          matchedTripId = trip.rawTripId;
          matchedDayStartMs = dayStartMs;
        }
      }
    }
  }

  if (matchedTripId && !cachedMatch) {
    tripMatchCache.set(cacheKey, {
      tripId: matchedTripId,
      dayStartMs: matchedDayStartMs,
    });
  }

  if (!matchedTripId) return null;

  const stops = store.base.rawStopTimesByTrip.get(matchedTripId);
  if (!stops || !stops.length) return null;

  const seqOffset =
    stops[0].stopSequence === 1 &&
    firstLive &&
    stops.some(
      (item) =>
        item.stopSequence === firstLive.sequence + 1 &&
        store.base.stopsById.get(item.stopId)?.normalizedName ===
          normalizeStopName(firstLive.name)
    )
      ? 1
      : 0;

  return {
    tripId: matchedTripId,
    dayStartMs: matchedDayStartMs,
    seqOffset,
    minSeq: firstLive ? firstLive.sequence + seqOffset : stops[0].stopSequence,
    stops,
    liveBySeq: new Map(
      fallback.map((item) => [item.sequence + seqOffset, item] as const),
    ),
  };
}

function matchToRemaining(
  match: VehicleTripMatch,
  store: Awaited<ReturnType<typeof ensureGtfsSeeded>>,
): LiveBusVehicle["upcomingStops"] {
  const full: LiveBusVehicle["upcomingStops"] = [];
  for (const st of match.stops) {
    if (st.stopSequence < match.minSeq) continue;
    const liveItem = match.liveBySeq.get(st.stopSequence);
    const stopRec = store.base.stopsById.get(st.stopId);
    full.push({
      sequence: st.stopSequence,
      name: liveItem?.name ?? stopRec?.name ?? st.stopId,
      scheduledArrival:
        liveItem?.scheduledArrival ??
        match.dayStartMs + st.arrivalMinutes * 60_000,
      scheduledDeparture:
        liveItem?.scheduledDeparture ??
        match.dayStartMs + st.departureMinutes * 60_000,
    });
  }
  return full;
}

/**
 * Trasa kursu, którym jedzie autobus — do narysowania na mapie po kliknięciu
 * pojazdu (myBus 3.0). **Nie wymaga aktywnej obsługi w wybranym dniu**: autobus
 * jedzie tym kursem teraz, więc wystarczy kurs w paczce GTFS. Dopasowanie idzie
 * po `tripId`, a gdy GPS go nie podaje — po linii, przystanku i godzinie
 * (to samo `resolveVehicleTrip` co lista przystanków w karcie).
 */
export async function getVehicleRouteOverlay(
  bus: LiveBusVehicle,
): Promise<{
  title: string;
  color: string;
  polylines: [number, number][][];
  stops: Array<{ name: string; lat: number; lon: number; sequence: number }>;
  /** Różnica między numeracją GPS a stop_sequence w tym kursie. */
  liveSequenceOffset: number;
} | null> {
  const store = await seededWithShapes();
  const match = await resolveVehicleTrip(bus);
  const tripId =
    match?.tripId ??
    (bus.tripId && store.base.rawStopTimesByTrip.has(bus.tripId) ? bus.tripId : null);
  if (!tripId) return null;
  const trip = store.base.rawTripsById.get(tripId);
  if (!trip) return null;

  const stops: Array<{ name: string; lat: number; lon: number; sequence: number }> = [];
  for (const st of store.base.rawStopTimesByTrip.get(tripId) ?? []) {
    const stop = stopPointFor(store.base, st.stopId);
    if (stop) stops.push({ name: stop.name, lat: stop.lat, lon: stop.lon, sequence: st.stopSequence });
  }
  const shape = trip.shapeId ? store.base.shapesById.get(trip.shapeId) : null;
  const fromShape = Boolean(shape && shape.length >= 2);
  // Kształt jest geometrią oficjalną: rysujemy go w całości i dociągamy do
  // pierwszego/ostatniego przystanku kursu (pętla bywa dalej niż koniec kształtu).
  const path: [number, number][] = fromShape
    ? shapeForTripStops(shape as [number, number][], stops[0] ?? null, stops[stops.length - 1] ?? null)
    : stops.map((stop): [number, number] => [stop.lat, stop.lon]);
  if (path.length < 2) return null;

  const repaired = await repairShapeGaps(path, undefined, !fromShape);
  const polylines = repaired.polylines.length > 0 ? repaired.polylines : [path];
  const route = store.base.routesById.get(trip.routeId);
  return {
    title: `Trasa linii ${bus.routeName || trip.routeShort}`,
    color: route?.color || bus.routeColor || "#0d4f3b",
    polylines,
    stops,
    liveSequenceOffset: match?.seqOffset ?? 0,
  };
}

export async function getVehicleRemainingStops(
  bus: LiveBusVehicle,
): Promise<LiveBusVehicle["upcomingStops"]> {
  const fallback = bus.upcomingStops ?? [];
  const store = await seededWithShapes();
  const match = await resolveVehicleTrip(bus);
  if (!match) return fallback;
  const full = matchToRemaining(match, store);
  return full.length >= fallback.length ? full : fallback;
}

/**
 * Kierunek (ostatni przystanek z rozkładu) dla wielu autobusów naraz — używane
 * przez podpowiedzi na mapie. Tablica kierunkowa GPS bywa nieaktualna, więc
 * każdy widok pokazuje kierunek z rozkładu, gdy kurs da się dopasować.
 */
export async function getVehicleDestinations(
  buses: LiveBusVehicle[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!buses.length) return out;
  const store = await ensureGtfsSeeded();
  for (const bus of buses) {
    const match = await resolveVehicleTrip(bus);
    const stops = match?.stops;
    if (!stops?.length) continue;
    const last = stopPointFor(store.base, stops[stops.length - 1].stopId);
    if (last?.name) out.set(bus.vehicleId, last.name);
  }
  return out;
}

export interface VehicleTripStop {
  sequence: number;
  name: string;
  scheduledArrival: number;
  scheduledDeparture: number;
  /** Przystanek już za autobusem (na podstawie numeru przystanku z GPS). */
  passed: boolean;
}

/**
 * Pełny przebieg kursu autobusu — **wszystkie** przystanki od początku do
 * końcowego, także przebyte (myBus 3.0: „jak jedzie, każdy przystanek”).
 * Gdy kursu nie da się dopasować do paczki, zwraca `complete: false` i tylko
 * znane przystanki z GPS — nigdy nie wymyśla wcześniejszej trasy.
 */
export async function getVehicleTripStops(bus: LiveBusVehicle): Promise<{
  complete: boolean;
  stops: VehicleTripStop[];
  /** Ostatni przystanek kursu z rozkładu (kierunek pewniejszy niż tablica GPS). */
  destination: string | null;
}> {
  const fallback = bus.upcomingStops ?? [];
  const store = await seededWithShapes();
  const match = await resolveVehicleTrip(bus);
  if (!match) {
    return {
      complete: false,
      stops: fallback.map((item) => ({
        sequence: item.sequence,
        name: item.name,
        scheduledArrival: item.scheduledArrival,
        scheduledDeparture: item.scheduledDeparture,
        passed: false,
      })),
      // Kurs nierozpoznany w rozkładzie: zostaje to, co podaje GPS.
      destination: fallback.length ? fallback[fallback.length - 1].name : null,
    };
  }
  const stops: VehicleTripStop[] = [];
  for (const st of match.stops) {
    const liveItem = match.liveBySeq.get(st.stopSequence);
    // Kurs może kończyć się na węźle (pętla) — nazwa musi się rozwiązać także wtedy.
    const stopRec = stopPointFor(store.base, st.stopId);
    stops.push({
      sequence: st.stopSequence,
      name: liveItem?.name ?? stopRec?.name ?? st.stopId,
      scheduledArrival:
        liveItem?.scheduledArrival ??
        match.dayStartMs + st.arrivalMinutes * 60_000,
      scheduledDeparture:
        liveItem?.scheduledDeparture ??
        match.dayStartMs + st.departureMinutes * 60_000,
      passed: st.stopSequence < match.minSeq,
    });
  }
  // Kierunek bierzemy z rozkładu (ostatni przystanek kursu), a nie z tablicy
  // kierunkowej GPS: ta potrafi pokazywać nieaktualny kierunek (np. linię 11
  // „do Nowego Julianowa”, choć kurs kończy na pętli Kozice).
  const destination = stops.length ? stops[stops.length - 1].name : null;
  return { complete: stops.length >= fallback.length, stops, destination };
}

/** Zwraca uporządkowaną listę przystanków pojedynczego kursu do wczytania w Planerze tras. */
export async function getTripStopWaypoints(
  rawTripId: string
): Promise<Array<{ id: string; name: string; lat: number; lon: number }>> {
  const store = await seededWithShapes();
  const sts = store.base.rawStopTimesByTrip.get(rawTripId) ?? [];
  const out: Array<{ id: string; name: string; lat: number; lon: number }> = [];
  for (const st of sts) {
    const stop = stopPointFor(store.base, st.stopId);
    if (!stop) continue;
    out.push({
      id: stop.id,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
    });
  }
  return out;
}

/** Buduje polilinie z shapes.txt oraz listę przystanków dla podglądu brygady na mapie. */
export async function getBrigadeShapeOverlay(
  title: string,
  color: string,
  tripIds: string[]
): Promise<{
  title: string;
  color: string;
  polylines: [number, number][][];
  unresolvedGaps: number;
  stops: Array<{ name: string; lat: number; lon: number }>;
} | null> {
  if (!tripIds.length) return null;
  const store = await seededWithShapes();
  const seenShapes = new Set<string>();
  const polylines: Array<{ path: [number, number][]; stopChain: boolean }> = [];
  const seenStopChains = new Set<string>();
  const stopMap = new Map<string, { name: string; lat: number; lon: number }>();

  for (const tripId of tripIds) {
    const trip = store.base.rawTripsById.get(tripId);
    if (!trip) continue;
    const pts = trip.shapeId ? store.base.shapesById.get(trip.shapeId) : undefined;
    const sts = store.base.rawStopTimesByTrip.get(tripId) ?? [];
    if (pts && pts.length >= 2 && trip.shapeId) {
      if (!seenShapes.has(trip.shapeId)) {
        seenShapes.add(trip.shapeId);
        const firstPoint = sts[0] ? stopPointFor(store.base, sts[0].stopId) : null;
        const lastPoint = sts.length ? stopPointFor(store.base, sts[sts.length - 1].stopId) : null;
        polylines.push({
          // Ten sam kurs = ten sam przystanek końcowy; kształt nie może biec dalej.
          path: shapeForTripStops(pts, firstPoint, lastPoint),
          stopChain: false,
        });
      }
    } else {
      const key = JSON.stringify(sts.map((st) => st.stopId));
      if (!seenStopChains.has(key)) {
        seenStopChains.add(key);
        const path: [number, number][] = [];
        for (const st of sts) {
          const stop = stopPointFor(store.base, st.stopId);
          if (stop) path.push([stop.lat, stop.lon]);
        }
        if (path.length >= 2) polylines.push({ path, stopChain: true });
      }
    }
    for (const st of sts) {
      if (stopMap.has(st.stopId)) continue;
      const stop = stopPointFor(store.base, st.stopId);
      if (stop) {
        stopMap.set(st.stopId, {
          name: stop.name,
          lat: stop.lat,
          lon: stop.lon,
        });
      }
    }
  }

  if (!polylines.length) return null;

  const repaired = await Promise.all(
    polylines.map(({ path, stopChain }) => repairShapeGaps(path, undefined, stopChain))
  );

  return {
    title,
    color,
    polylines: repaired.flatMap((r) => r.polylines),
    unresolvedGaps: repaired.reduce((sum, r) => sum + r.gapsTotal - r.gapsRepaired, 0),
    stops: [...stopMap.values()],
  };
}

/** One scheduled course, as opposed to all courses of its brigade. */
export interface CoursePreviewStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  sequence: number;
  arrivalMs: number;
  departureMs: number;
  afterMidnight: boolean;
}

export interface CoursePreview {
  tripId: string;
  dateId: string;
  routeShort: string;
  routeLong: string;
  headsign: string;
  dutyCode: string;
  operatorKey: WalbrzychOperatorKey;
  operatorName: string;
  color: string;
  textColor: string;
  startMs: number;
  endMs: number;
  distanceMeters: number;
  /** Raw GTFS geometry (or stop chain when `approximate`). */
  path: [number, number][];
  /** Road geometry and verified GTFS runs; unresolved gaps are omitted. */
  polylines: [number, number][][];
  approximate: boolean;
  unresolvedGaps: number;
  stops: CoursePreviewStop[];
}

/**
 * Returns the exact trip's GTFS shape and ordered, timed stops. Reuses the
 * in-memory GTFS index; no extra network request is made for each preview.
 * The service date is checked against calendar_dates.txt, including after-midnight trips.
 */
export async function getCoursePreview(
  tripId: string,
  dateId: string
): Promise<CoursePreview | null> {
  if (!/^\d{8}$/.test(dateId)) return null;
  const serviceDay = DateTime.fromFormat(dateId, "yyyyLLdd", { zone: ZONE });
  if (!serviceDay.isValid) return null;

  const store = await seededWithShapes();
  const trip = store.base.rawTripsById.get(tripId);
  if (!trip || !store.base.serviceIdsByDate.get(Number(dateId))?.has(trip.serviceId)) {
    return null;
  }

  const dayStartMs = serviceDay.startOf("day").toMillis();
  const stops: CoursePreviewStop[] = [];
  for (const st of store.base.rawStopTimesByTrip.get(tripId) ?? []) {
    const stop = stopPointFor(store.base, st.stopId);
    if (!stop) continue;
    stops.push({
      id: stop.id,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      sequence: st.stopSequence,
      arrivalMs: dayStartMs + st.arrivalMinutes * 60_000,
      departureMs: dayStartMs + st.departureMinutes * 60_000,
      afterMidnight: st.arrivalMinutes >= 1440 || st.departureMinutes >= 1440,
    });
  }
  if (stops.length < 2) return null;

  const shape = trip.shapeId ? store.base.shapesById.get(trip.shapeId) : null;
  const approximate = !shape || shape.length < 2;
  // Kształt rysujemy w całości i dociągamy do przystanku początkowego/końcowego
  // (np. pętla Kozice leży ~360 m za końcem kształtu linii 11).
  const path: [number, number][] = approximate
    ? stops.map((stop) => [stop.lat, stop.lon])
    : shapeForTripStops(
        shape as [number, number][],
        stops[0] ?? null,
        stops[stops.length - 1] ?? null,
      );
  const route = store.base.routesById.get(trip.routeId);
  const operatorKey =
    trip.operatorKey !== "other"
      ? trip.operatorKey
      : resolveDutyOperator(trip.serviceId, trip.kursowkaCode);
  const lengths = await getTripLengthMap();
  const repaired = await repairShapeGaps(path, undefined, approximate);
  // Naprawa luk idzie przez OSRM (sieć). Gdy serwer nie odpowie, nie rysujemy
  // NIC — a wtedy klik w autobus nie pokazuje trasy. W takim razie rysujemy
  // surową linię po przystankach/kształcie, żeby trasa była widoczna zawsze.
  const polylines =
    repaired.polylines.length > 0
      ? repaired.polylines
      : path.length >= 2
        ? [path]
        : [];

  return {
    tripId,
    dateId,
    routeShort: route?.shortName ?? trip.routeShort,
    routeLong: route?.longName ?? trip.routeShort,
    // Kurs kończy się na ostatnim przystanku z rozkładu — `trip_headsign`
    // z paczki bywa nieaktualny (linia 11: „Nowy Julianów” zamiast Kozic).
    headsign: stops[stops.length - 1].name || trip.headsign,
    dutyCode: trip.kursowkaCode,
    operatorKey,
    operatorName: OPERATOR_NAMES[operatorKey],
    color: route?.color ?? "#0d4f3b",
    textColor: route?.textColor ?? "#ffffff",
    startMs: dayStartMs + trip.startMinutes * 60_000,
    endMs: dayStartMs + trip.endMinutes * 60_000,
    distanceMeters: lengths.get(tripId) ?? polylineLengthMeters(path),
    path,
    polylines,
    approximate,
    unresolvedGaps: repaired.gapsTotal - repaired.gapsRepaired,
    stops,
  };
}
