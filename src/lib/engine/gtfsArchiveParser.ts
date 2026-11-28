import { strFromU8, unzipSync } from "fflate";
import { DateTime } from "luxon";
import { CSV_CHUNK_ROWS, yieldToMain } from "../core/cooperative";
import { createLap, measureSync } from "../core/perfMarks";
import { foldStopKey, formatDutyCode } from "../core/text";
import { WARSAW_ZONE } from "../core/time";
import type { WalbrzychOperatorKey } from "../types";
import {
  dutyCodeFromBlock,
  resolveDutyOperator,
} from "./brigadeVerification";
import { technicalTripCode, type TechnicalTripCode } from "./technicalTrips";

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

export interface GtfsStopTimeRecord {
  tripId: string;
  stopId: string;
  stopSequence: number;
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

export interface ParsedArchiveBase {
  source: string;
  feedVersion: string;
  routes: GtfsRouteRecord[];
  routesById: Map<string, GtfsRouteRecord>;
  stops: GtfsStopRecord[];
  stopsById: Map<string, GtfsStopRecord>;
  stopNamesById: Map<string, string>;
  stationById: Map<string, { name: string; lat: number; lon: number }>;
  services: GtfsServiceRecord[];
  dayTypeServices: Record<string, Set<string>>;
  serviceIdsByDate: Map<number, Set<string>>;
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

const normalizeStopName = foldStopKey;

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

/**
 * Rozpakowuje i parsuje archiwum GTFS (bez `shapes.txt`).
 * Gdy `cooperative = false` (wewnątrz Web Workera), działa z pełną prędkością
 * bez oddawania sterowania do głównego wątku UI.
 */
export async function parseArchiveBytesDirect(
  zipBytes: Uint8Array,
  source: string,
  options: { nowMs?: number; cooperative?: boolean } = {},
): Promise<ParsedArchiveBase> {
  const cooperative = options.cooperative ?? true;
  const nowMs = options.nowMs ?? Date.now();
  const maybeYield = cooperative ? yieldToMain : () => Promise.resolve();

  const files = measureSync("gtfs:unzip", () =>
    unzipSync(zipBytes, { filter: (file) => file.name !== "shapes.txt" }),
  );
  const lap = createLap();
  const readTxt = (name: string) => (files[name] ? strFromU8(files[name]) : "");

  const feedRows = parseCsvRows(readTxt("feed_info.txt"));
  const agencyRows = parseCsvRows(readTxt("agency.txt"));
  const defaultAgency = agencyRows[0]?.agency_name || "ZDKiUM / MPK Wałbrzych";
  const feedVersion =
    feedRows[0]?.feed_version || new Date(nowMs).toISOString().slice(0, 10);
  const feedStartDate =
    Number.parseInt(feedRows[0]?.feed_start_date ?? "", 10) || 0;
  const feedEndDate =
    Number.parseInt(feedRows[0]?.feed_end_date ?? "", 10) || 0;

  lap("gtfs:csv:feed");
  await maybeYield();
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
    const prev = canonicalByShort.get(upperShort);
    if (!prev || rec.longName.length > prev.longName.length) {
      canonicalByShort.set(upperShort, rec);
    }
  }
  const routes = Array.from(canonicalByShort.values()).sort(
    (a, b) => a.sortOrder - b.sortOrder || a.shortName.localeCompare(b.shortName, "pl", { numeric: true }),
  );

  lap("gtfs:csv:routes");
  await maybeYield();
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
  await maybeYield();
  const rawServiceDates = new Map<string, Set<number>>();
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
      const dow = cursor.weekday % 7;
      if (cal[weekdayCols[dow]] === "1") {
        set.add(Number(cursor.toFormat("yyyyLLdd")));
      }
      cursor = cursor.plus({ days: 1 });
    }
    if (set.size > 0) rawServiceDates.set(sid, set);
  }

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

  const todayNum = Number(DateTime.fromMillis(nowMs).setZone(WARSAW_ZONE).toFormat("yyyyLLdd"));
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
  await maybeYield();
  const rawStopTimesByTrip = new Map<string, GtfsStopTimeRecord[]>();
  {
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
        if (cooperative && processed % CSV_CHUNK_ROWS === 0) await maybeYield();
      }
      cols = reader.next();
    }
  }

  lap("gtfs:csv:stop_times");
  await maybeYield();
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
      verifiedKursowka || rawBrigade,
    );

    const detail: RawTripDetail = {
      rawTripId: t.trip_id,
      routeId: t.route_id,
      routeShort,
      technicalCode: technicalTripCode(
        routeShort,
        t.trip_short_name || "",
        t.trip_headsign || "",
        route?.longName || "",
      ),
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

    if (hasCalendarFilter && !activeCalendarServices.has(t.service_id)) {
      continue;
    }

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
  await maybeYield();
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
  await maybeYield();
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

/**
 * Rozpakowuje i parsuje `shapes.txt` z paczki GTFS.
 */
export async function parseShapesBytesDirect(
  zipBytes: Uint8Array,
  options: { cooperative?: boolean } = {},
): Promise<Map<string, [number, number][]>> {
  const cooperative = options.cooperative ?? true;
  const shapesById = new Map<string, [number, number][]>();
  const files = unzipSync(zipBytes, { filter: (file) => file.name === "shapes.txt" });
  const entry = files["shapes.txt"];
  if (!entry) return shapesById;

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
        if (cooperative && processed % CSV_CHUNK_ROWS === 0) await yieldToMain();
      }
    }
    cols = reader.next();
  }
  for (const [shapeId, points] of buckets) {
    points.sort((a, b) => a.block - b.block || a.seq - b.seq);
    shapesById.set(
      shapeId,
      points.map((point) => [point.lat, point.lon] as [number, number]),
    );
  }
  return shapesById;
}
