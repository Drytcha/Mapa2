/**
 * Porównanie dwóch wersji rozkładu GTFS (np. okres 387 vs 388 w jednej paczce,
 * dwa różne typy dni albo dwa osobne pliki GTFS .zip).
 *
 * Liczy:
 *  - kursy dodane (+), usunięte (-), zmienione (~: przesunięcie odjazdu, zmiana
 *    końcówki / liczby przystanków, zmiana brygady),
 *  - podsumowanie per linia,
 *  - wozokilometry (wzkm), liczbę kursów i godziny pracy każdej brygady (Δ km, Δ %).
 */

import { strFromU8, unzipSync } from "fflate";
import { polylineLengthMeters } from "../core/spatial";
import { compareLineCodes, foldStopKey, formatDutyCode, parseDutyPair } from "../core/text";
import { minutesToClock } from "../core/time";
import { describeServiceIds } from "./brigades";
import { resolveDutyOperator } from "./brigadeVerification";
import {
  ensureGtfsSeeded,
  getTripLengthMap,
  WALBRZYCH_ROUTE_COLORS,
  type RawTripDetail,
} from "./gtfsStore";

export interface ScheduleTripSnapshot {
  tripId: string;
  routeShort: string;
  routeColor: string;
  routeTextColor: string;
  serviceId: string;
  directionId: number;
  kursowkaCode: string;
  operatorKey: string;
  firstStopName: string;
  lastStopName: string;
  headsign: string;
  startMinutes: number;
  endMinutes: number;
  stopCount: number;
  lengthMeters: number;
  technicalCode?: string;
}

export interface ScheduleServiceOption {
  serviceId: string;
  periodId: string;
  dayType: string;
  dayLabel: string;
  label: string;
  fromDate: number;
  toDate: number;
  dateCount: number;
  tripCount: number;
  lineCount: number;
}

export interface SchedulePeriodOption {
  periodId: string;
  label: string;
  fromDate: number;
  toDate: number;
  serviceIds: string[];
  dayTypes: string[];
  totalTrips: number;
}

export interface ScheduleSourceArchive {
  id: string;
  label: string;
  feedVersion: string;
  fromDate: number;
  toDate: number;
  services: ScheduleServiceOption[];
  periods: SchedulePeriodOption[];
  tripsByService: Map<string, ScheduleTripSnapshot[]>;
  routeMeta: Map<string, { color: string; textColor: string; longName: string }>;
}

export type TripDiffKind = "added" | "removed" | "changed" | "unchanged";

export interface TripDiffItem {
  id: string;
  kind: TripDiffKind;
  routeShort: string;
  routeColor: string;
  routeTextColor: string;
  directionId: number;
  oldTrip: ScheduleTripSnapshot | null;
  newTrip: ScheduleTripSnapshot | null;
  /** Dodatnie = opóźnienie / późniejszy odjazd w nowym rozkładzie. */
  departureDeltaMin: number;
  arrivalDeltaMin: number;
  durationDeltaMin: number;
  lengthDeltaMeters: number;
  stopCountDelta: number;
  timeChanged: boolean;
  routeChanged: boolean;
  brigadeChanged: boolean;
}

export type EntityDiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface LineScheduleDiff {
  routeShort: string;
  color: string;
  textColor: string;
  status: EntityDiffStatus;
  tripsOld: number;
  tripsNew: number;
  tripsDelta: number;
  addedCount: number;
  removedCount: number;
  changedCount: number;
  unchangedCount: number;
  brigadesOld: number;
  brigadesNew: number;
  brigadesDelta: number;
  metersOld: number;
  metersNew: number;
  metersDelta: number;
}

export interface BrigadeScheduleDiff {
  key: string;
  brigadeCode: string;
  unassigned: boolean;
  routeShort: string;
  routeColor: string;
  routeTextColor: string;
  operatorKey: string;
  status: EntityDiffStatus;
  tripsOld: number;
  tripsNew: number;
  tripsDelta: number;
  addedTrips: number;
  removedTrips: number;
  changedTrips: number;
  metersOld: number;
  metersNew: number;
  metersDelta: number;
  metersDeltaPct: number | null;
  firstDepOld: number | null;
  lastArrOld: number | null;
  firstDepNew: number | null;
  lastArrNew: number | null;
  tripDiffs: TripDiffItem[];
}

export interface ScheduleDiffTotals {
  tripsOld: number;
  tripsNew: number;
  tripsDelta: number;
  addedCount: number;
  removedCount: number;
  changedCount: number;
  unchangedCount: number;
  timeShiftedCount: number;
  routeChangedCount: number;
  brigadeChangedCount: number;
  metersOld: number;
  metersNew: number;
  metersDelta: number;
  brigadesOld: number;
  brigadesNew: number;
  brigadesDelta: number;
  linesOld: number;
  linesNew: number;
  linesWithChanges: number;
}

export interface ScheduleDiffResult {
  labelA: string;
  labelB: string;
  totals: ScheduleDiffTotals;
  lines: LineScheduleDiff[];
  trips: TripDiffItem[];
  brigades: BrigadeScheduleDiff[];
}

const DAY_TYPE_ORDER: readonly string[] = ["RS", "SO", "NS", "NH"];

const MAX_TIME_SHIFT_MATCH_MIN = 20;

export function formatYyyymmdd(value: number): string {
  if (!value || value < 19000101) return "—";
  const s = String(value);
  if (s.length !== 8) return s;
  return `${s.slice(6, 8)}.${s.slice(4, 6)}.${s.slice(0, 4)}`;
}

export function dayTypeLabel(dayType: string): string {
  switch (dayType.toUpperCase()) {
    case "RS":
      return "Dzień roboczy (RS)";
    case "SO":
      return "Sobota (SO)";
    case "NS":
      return "Niedziela / Święto (NS)";
    case "NH":
      return "Niedziela handlowa (NH)";
    case "ALL":
      return "Wszystkie typy dni";
    default:
      return dayType;
  }
}

export function parseServiceIdParts(serviceId: string): {
  periodId: string;
  dayType: string;
  dayLabel: string;
} {
  const trimmed = serviceId.trim();
  const match = trimmed.match(/^([A-Za-z0-9]+)_([A-Za-z0-9]+)$/);
  if (match) {
    const periodId = match[1].toUpperCase();
    const dayType = match[2].toUpperCase();
    return {
      periodId,
      dayType,
      dayLabel: dayTypeLabel(dayType),
    };
  }
  const upper = trimmed.toUpperCase();
  return {
    periodId: "MAIN",
    dayType: upper,
    dayLabel: describeServiceIds([trimmed]) || trimmed,
  };
}

function compareDayTypes(a: string, b: string): number {
  const ia = DAY_TYPE_ORDER.indexOf(a.toUpperCase());
  const ib = DAY_TYPE_ORDER.indexOf(b.toUpperCase());
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return a.localeCompare(b, "pl", { numeric: true });
}

function compareBrigadeKeys(a: BrigadeScheduleDiff, b: BrigadeScheduleDiff): number {
  const lineCmp = compareLineCodes(a.routeShort, b.routeShort);
  if (lineCmp !== 0) return lineCmp;
  if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1;
  const pa = parseDutyPair(a.brigadeCode);
  const pb = parseDutyPair(b.brigadeCode);
  if (pa && pb) return Number(pa.suffix) - Number(pb.suffix);
  return a.brigadeCode.localeCompare(b.brigadeCode, "pl", { numeric: true });
}

function buildArchiveIndex(params: {
  id: string;
  label: string;
  feedVersion: string;
  fromDate: number;
  toDate: number;
  serviceDates: Map<string, number[]>;
  trips: ScheduleTripSnapshot[];
  routeMeta: Map<string, { color: string; textColor: string; longName: string }>;
}): ScheduleSourceArchive {
  const tripsByService = new Map<string, ScheduleTripSnapshot[]>();
  const linesByService = new Map<string, Set<string>>();

  for (const trip of params.trips) {
    const list = tripsByService.get(trip.serviceId);
    if (list) list.push(trip);
    else tripsByService.set(trip.serviceId, [trip]);

    let lines = linesByService.get(trip.serviceId);
    if (!lines) {
      lines = new Set<string>();
      linesByService.set(trip.serviceId, lines);
    }
    lines.add(trip.routeShort);
  }

  const allServiceIds = new Set<string>([
    ...params.serviceDates.keys(),
    ...tripsByService.keys(),
  ]);

  const services: ScheduleServiceOption[] = [];
  for (const serviceId of allServiceIds) {
    const tripList = tripsByService.get(serviceId) ?? [];
    if (tripList.length === 0) continue;
    const dates = [...(params.serviceDates.get(serviceId) ?? [])].sort((a, b) => a - b);
    const { periodId, dayType, dayLabel } = parseServiceIdParts(serviceId);
    const fromDate = dates[0] ?? params.fromDate;
    const toDate = dates[dates.length - 1] ?? params.toDate;
    const niceLabel =
      describeServiceIds([serviceId]) ||
      (periodId !== "MAIN" ? `Okres ${periodId} · ${dayLabel}` : dayLabel);

    services.push({
      serviceId,
      periodId,
      dayType,
      dayLabel,
      label: niceLabel,
      fromDate,
      toDate,
      dateCount: dates.length,
      tripCount: tripList.length,
      lineCount: linesByService.get(serviceId)?.size ?? 0,
    });
  }

  services.sort(
    (a, b) =>
      a.periodId.localeCompare(b.periodId, "pl", { numeric: true }) ||
      compareDayTypes(a.dayType, b.dayType) ||
      a.serviceId.localeCompare(b.serviceId, "pl", { numeric: true }),
  );

  // Group into periods (e.g. 387, 388)
  const periodMap = new Map<
    string,
    {
      fromDate: number;
      toDate: number;
      serviceIds: string[];
      dayTypes: Set<string>;
      totalTrips: number;
    }
  >();

  for (const svc of services) {
    const entry = periodMap.get(svc.periodId);
    if (!entry) {
      periodMap.set(svc.periodId, {
        fromDate: svc.fromDate,
        toDate: svc.toDate,
        serviceIds: [svc.serviceId],
        dayTypes: new Set([svc.dayType]),
        totalTrips: svc.tripCount,
      });
    } else {
      if (svc.fromDate > 0 && (entry.fromDate === 0 || svc.fromDate < entry.fromDate)) {
        entry.fromDate = svc.fromDate;
      }
      if (svc.toDate > entry.toDate) entry.toDate = svc.toDate;
      entry.serviceIds.push(svc.serviceId);
      entry.dayTypes.add(svc.dayType);
      entry.totalTrips += svc.tripCount;
    }
  }

  const periods: SchedulePeriodOption[] = [...periodMap.entries()]
    .map(([periodId, p]) => ({
      periodId,
      label:
        periodId === "MAIN"
          ? `Rozkład główny (${formatYyyymmdd(p.fromDate)}–${formatYyyymmdd(p.toDate)})`
          : `Okres ${periodId} (${formatYyyymmdd(p.fromDate)}–${formatYyyymmdd(p.toDate)})`,
      fromDate: p.fromDate,
      toDate: p.toDate,
      serviceIds: p.serviceIds,
      dayTypes: [...p.dayTypes].sort(compareDayTypes),
      totalTrips: p.totalTrips,
    }))
    .sort(
      (a, b) =>
        a.fromDate - b.fromDate ||
        a.periodId.localeCompare(b.periodId, "pl", { numeric: true }),
    );

  return {
    id: params.id,
    label: params.label,
    feedVersion: params.feedVersion,
    fromDate: params.fromDate,
    toDate: params.toDate,
    services,
    periods,
    tripsByService,
    routeMeta: params.routeMeta,
  };
}

/**
 * Buduje indeks okresów i kursów z aktualnie załadowanego archiwum GTFS w aplikacji.
 */
export async function loadCurrentScheduleArchive(): Promise<ScheduleSourceArchive> {
  const store = await ensureGtfsSeeded();
  const tripLengths = await getTripLengthMap();

  const routeMeta = new Map<
    string,
    { color: string; textColor: string; longName: string }
  >();
  for (const r of store.base.routes) {
    routeMeta.set(r.shortName.toUpperCase(), {
      color: r.color,
      textColor: r.textColor,
      longName: r.longName,
    });
  }

  const serviceDates = new Map<string, number[]>();
  for (const svc of store.base.services) {
    serviceDates.set(svc.serviceId, svc.datesJson);
  }
  for (const [dateKey, sids] of store.base.serviceIdsByDate) {
    for (const sid of sids) {
      const list = serviceDates.get(sid);
      if (list) {
        if (!list.includes(dateKey)) list.push(dateKey);
      } else {
        serviceDates.set(sid, [dateKey]);
      }
    }
  }

  const toSnapshot = (trip: RawTripDetail): ScheduleTripSnapshot => {
    const route = store.base.routesById.get(trip.routeId);
    const meta = routeMeta.get(trip.routeShort.toUpperCase());
    const cleanCode = trip.kursowkaCode
      ? formatDutyCode(trip.kursowkaCode, "/")
      : "";
    const operatorKey = cleanCode
      ? resolveDutyOperator(trip.serviceId, cleanCode) || trip.operatorKey || ""
      : trip.operatorKey || "";

    return {
      tripId: trip.rawTripId,
      routeShort: trip.routeShort.trim().toUpperCase(),
      routeColor: route?.color ?? meta?.color ?? "#0d4f3b",
      routeTextColor: route?.textColor ?? meta?.textColor ?? "#ffffff",
      serviceId: trip.serviceId,
      directionId: trip.directionId,
      kursowkaCode: cleanCode,
      operatorKey,
      firstStopName: trip.firstStopName,
      lastStopName: trip.lastStopName,
      headsign: trip.headsign || trip.lastStopName,
      startMinutes: trip.startMinutes,
      endMinutes: trip.endMinutes,
      stopCount: trip.stopCount,
      lengthMeters: tripLengths.get(trip.rawTripId) ?? 0,
      technicalCode: trip.technicalCode,
    };
  };

  return buildArchiveIndex({
    id: "current",
    label: `Aktualny GTFS (${store.base.feedVersion || store.feed.source})`,
    feedVersion: store.base.feedVersion,
    fromDate: store.base.feedStartDate,
    toDate: store.base.feedEndDate,
    serviceDates,
    trips: store.base.rawTrips.map(toSnapshot),
    routeMeta,
  });
}

/* -------------------------------------------------------------------------- */
/*  Opcjonalny parser zewnętrznego archiwum GTFS (.zip) do porównania 2 paczek */
/* -------------------------------------------------------------------------- */

function parseCsvRows(text: string): Record<string, string>[] {
  const clean = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    if (row.some((cell) => cell.length > 0)) rows.push(row);
  }
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c += 1) {
      obj[headers[c]] = (cells[c] ?? "").trim();
    }
    out.push(obj);
  }
  return out;
}

function parseGtfsTimeMinutes(raw: string): number {
  const parts = raw.trim().split(":");
  if (parts.length < 2) return 0;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

function extractDutyCodeFromZipTrip(
  routeShort: string,
  blockId: string,
  tripShortName: string,
): string {
  const candidates = [blockId, tripShortName];
  for (const raw of candidates) {
    if (!raw) continue;
    const pair = parseDutyPair(raw);
    if (pair) return `${pair.line}/${pair.suffix}`;
    const numOnly = raw.trim().match(/^(\d{1,2})$/);
    if (numOnly && routeShort) {
      return `${routeShort}/${numOnly[1].padStart(2, "0")}`;
    }
  }
  return "";
}

function findZipText(files: Record<string, Uint8Array>, fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const [key, bytes] of Object.entries(files)) {
    const base = key.split("/").pop()?.toLowerCase() ?? "";
    if (base === lower) return strFromU8(bytes);
  }
  return "";
}

/**
 * Wczytuje zewnętrzny plik GTFS `.zip` w pamięci przeglądarki, dzięki czemu
 * Planista może porównać także dwie osobne paczki (np. archiwalną z dysku z aktualną).
 */
export function parseExternalGtfsZipForDiff(
  bytes: Uint8Array,
  fileName: string,
): ScheduleSourceArchive {
  const unzipped = unzipSync(bytes);
  const routesRows = parseCsvRows(findZipText(unzipped, "routes.txt"));
  const stopsRows = parseCsvRows(findZipText(unzipped, "stops.txt"));
  const tripsRows = parseCsvRows(findZipText(unzipped, "trips.txt"));
  const stopTimesRows = parseCsvRows(findZipText(unzipped, "stop_times.txt"));
  const shapesRows = parseCsvRows(findZipText(unzipped, "shapes.txt"));
  const calendarDatesRows = parseCsvRows(findZipText(unzipped, "calendar_dates.txt"));
  const feedInfoRows = parseCsvRows(findZipText(unzipped, "feed_info.txt"));

  if (!tripsRows.length || !stopTimesRows.length) {
    throw new Error("Plik ZIP nie zawiera poprawnych tabel GTFS (trips.txt i stop_times.txt).");
  }

  const routeById = new Map<
    string,
    { shortName: string; longName: string; color: string; textColor: string }
  >();
  const routeMeta = new Map<string, { color: string; textColor: string; longName: string }>();
  for (const r of routesRows) {
    const shortName = (r.route_short_name || r.route_id || "").trim().toUpperCase();
    const rawColor = (r.route_color || "").replace(/^#/, "").trim();
    const color =
      /^[0-9a-fA-F]{6}$/.test(rawColor)
        ? `#${rawColor.toLowerCase()}`
        : WALBRZYCH_ROUTE_COLORS[shortName] ?? "#0d4f3b";
    const rawText = (r.route_text_color || "").replace(/^#/, "").trim();
    const textColor = /^[0-9a-fA-F]{6}$/.test(rawText)
      ? `#${rawText.toLowerCase()}`
      : "#ffffff";
    const info = {
      shortName,
      longName: r.route_long_name || shortName,
      color,
      textColor,
    };
    routeById.set(r.route_id, info);
    routeMeta.set(shortName, { color, textColor, longName: info.longName });
  }

  const stopById = new Map<string, { name: string; lat: number; lon: number }>();
  for (const s of stopsRows) {
    stopById.set(s.stop_id, {
      name: s.stop_name || s.stop_id,
      lat: Number(s.stop_lat) || 0,
      lon: Number(s.stop_lon) || 0,
    });
  }

  const shapeLenById = new Map<string, number>();
  if (shapesRows.length) {
    const ptsByShape = new Map<string, Array<{ seq: number; lat: number; lon: number }>>();
    for (const sh of shapesRows) {
      const lat = Number(sh.shape_pt_lat);
      const lon = Number(sh.shape_pt_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const list = ptsByShape.get(sh.shape_id);
      const item = { seq: Number(sh.shape_pt_sequence) || 0, lat, lon };
      if (list) list.push(item);
      else ptsByShape.set(sh.shape_id, [item]);
    }
    for (const [shapeId, list] of ptsByShape) {
      list.sort((a, b) => a.seq - b.seq);
      const coords = list.map((p): [number, number] => [p.lat, p.lon]);
      shapeLenById.set(shapeId, Math.round(polylineLengthMeters(coords)));
    }
  }

  // Group stop_times by trip_id
  const stopTimesByTrip = new Map<
    string,
    Array<{ seq: number; stopId: string; depMin: number; arrMin: number }>
  >();
  for (const st of stopTimesRows) {
    const dep = parseGtfsTimeMinutes(st.departure_time || st.arrival_time);
    const arr = parseGtfsTimeMinutes(st.arrival_time || st.departure_time);
    const item = {
      seq: Number(st.stop_sequence) || 0,
      stopId: st.stop_id,
      depMin: dep,
      arrMin: arr,
    };
    const list = stopTimesByTrip.get(st.trip_id);
    if (list) list.push(item);
    else stopTimesByTrip.set(st.trip_id, [item]);
  }

  const serviceDates = new Map<string, number[]>();
  let minDate = Infinity;
  let maxDate = 0;
  for (const cd of calendarDatesRows) {
    if (cd.exception_type && cd.exception_type !== "1") continue;
    const d = Number(cd.date);
    if (!Number.isFinite(d) || d < 19000101) continue;
    if (d < minDate) minDate = d;
    if (d > maxDate) maxDate = d;
    const list = serviceDates.get(cd.service_id);
    if (list) list.push(d);
    else serviceDates.set(cd.service_id, [d]);
  }

  const trips: ScheduleTripSnapshot[] = [];
  for (const t of tripsRows) {
    const stops = stopTimesByTrip.get(t.trip_id);
    if (!stops || stops.length < 2) continue;
    stops.sort((a, b) => a.seq - b.seq);
    const route = routeById.get(t.route_id);
    const routeShort = route?.shortName ?? t.route_id.toUpperCase();
    const first = stopById.get(stops[0].stopId);
    const last = stopById.get(stops[stops.length - 1].stopId);

    const stopCoords: [number, number][] = [];
    for (const s of stops) {
      const rec = stopById.get(s.stopId);
      if (rec && rec.lat !== 0 && rec.lon !== 0) stopCoords.push([rec.lat, rec.lon]);
    }
    const byStops = Math.round(polylineLengthMeters(stopCoords));
    const byShape = t.shape_id ? shapeLenById.get(t.shape_id) : undefined;
    const lengthMeters =
      byShape && byShape > 0 && !(byStops > 0 && byShape > byStops * 2.4)
        ? byShape
        : byStops;

    const kursowkaCode = extractDutyCodeFromZipTrip(
      routeShort,
      t.block_id || "",
      t.trip_short_name || "",
    );

    trips.push({
      tripId: t.trip_id,
      routeShort,
      routeColor: route?.color ?? "#0d4f3b",
      routeTextColor: route?.textColor ?? "#ffffff",
      serviceId: t.service_id,
      directionId: Number(t.direction_id) || 0,
      kursowkaCode,
      operatorKey: kursowkaCode ? resolveDutyOperator(t.service_id, kursowkaCode) : "",
      firstStopName: first?.name ?? stops[0].stopId,
      lastStopName: last?.name ?? stops[stops.length - 1].stopId,
      headsign: t.trip_headsign || last?.name || "",
      startMinutes: stops[0].depMin,
      endMinutes: stops[stops.length - 1].arrMin,
      stopCount: stops.length,
      lengthMeters,
    });
  }

  const fi = feedInfoRows[0];
  const fromDate =
    Number(fi?.feed_start_date) || (Number.isFinite(minDate) ? minDate : 0);
  const toDate = Number(fi?.feed_end_date) || maxDate;

  return buildArchiveIndex({
    id: `zip:${fileName}:${Date.now()}`,
    label: `Plik: ${fileName}`,
    feedVersion: fi?.feed_version || fileName,
    fromDate,
    toDate,
    serviceDates,
    trips,
    routeMeta,
  });
}

/* -------------------------------------------------------------------------- */
/*  Domyślny wybór pary okresów (np. 387_RS vs 388_RS)                        */
/* -------------------------------------------------------------------------- */

export interface DefaultComparisonSelection {
  serviceIdA: string;
  serviceIdB: string;
  periodIdA: string;
  periodIdB: string;
  dayType: string;
  hasMultiplePeriods: boolean;
}

export function pickDefaultComparison(
  archive: ScheduleSourceArchive,
): DefaultComparisonSelection | null {
  if (!archive.services.length) return null;

  if (archive.periods.length >= 2) {
    const periodA = archive.periods[archive.periods.length - 2];
    const periodB = archive.periods[archive.periods.length - 1];
    const commonDayTypes = periodA.dayTypes.filter((dt) =>
      periodB.dayTypes.includes(dt),
    );
    const chosenDay =
      commonDayTypes.find((dt) => dt === "RS") ??
      commonDayTypes[0] ??
      periodB.dayTypes[0] ??
      periodA.dayTypes[0];

    const svcA =
      archive.services.find(
        (s) => s.periodId === periodA.periodId && s.dayType === chosenDay,
      ) ?? archive.services.find((s) => s.periodId === periodA.periodId)!;
    const svcB =
      archive.services.find(
        (s) => s.periodId === periodB.periodId && s.dayType === chosenDay,
      ) ?? archive.services.find((s) => s.periodId === periodB.periodId)!;

    return {
      serviceIdA: svcA.serviceId,
      serviceIdB: svcB.serviceId,
      periodIdA: periodA.periodId,
      periodIdB: periodB.periodId,
      dayType: chosenDay,
      hasMultiplePeriods: true,
    };
  }

  const first = archive.services[0];
  const second = archive.services[1] ?? first;
  return {
    serviceIdA: first.serviceId,
    serviceIdB: second.serviceId,
    periodIdA: first.periodId,
    periodIdB: second.periodId,
    dayType: first.dayType,
    hasMultiplePeriods: false,
  };
}

/* -------------------------------------------------------------------------- */
/*  Silnik porównywania kursów, linii i wozokilometrów brygad                 */
/* -------------------------------------------------------------------------- */

function stopKeysEqual(a: string, b: string): boolean {
  return foldStopKey(a) === foldStopKey(b);
}

function buildDiffItem(
  id: string,
  kind: TripDiffKind,
  oldTrip: ScheduleTripSnapshot | null,
  newTrip: ScheduleTripSnapshot | null,
): TripDiffItem {
  const ref = newTrip ?? oldTrip!;
  if (!oldTrip || !newTrip) {
    return {
      id,
      kind,
      routeShort: ref.routeShort,
      routeColor: ref.routeColor,
      routeTextColor: ref.routeTextColor,
      directionId: ref.directionId,
      oldTrip,
      newTrip,
      departureDeltaMin: 0,
      arrivalDeltaMin: 0,
      durationDeltaMin: 0,
      lengthDeltaMeters: newTrip ? newTrip.lengthMeters : -(oldTrip?.lengthMeters ?? 0),
      stopCountDelta: newTrip ? newTrip.stopCount : -(oldTrip?.stopCount ?? 0),
      timeChanged: false,
      routeChanged: false,
      brigadeChanged: false,
    };
  }

  const departureDeltaMin = newTrip.startMinutes - oldTrip.startMinutes;
  const arrivalDeltaMin = newTrip.endMinutes - oldTrip.endMinutes;
  const durationDeltaMin =
    newTrip.endMinutes - newTrip.startMinutes - (oldTrip.endMinutes - oldTrip.startMinutes);
  const lengthDeltaMeters = newTrip.lengthMeters - oldTrip.lengthMeters;
  const stopCountDelta = newTrip.stopCount - oldTrip.stopCount;
  const timeChanged = departureDeltaMin !== 0 || arrivalDeltaMin !== 0;
  const routeChanged =
    !stopKeysEqual(oldTrip.firstStopName, newTrip.firstStopName) ||
    !stopKeysEqual(oldTrip.lastStopName, newTrip.lastStopName) ||
    stopCountDelta !== 0;
  const brigadeChanged = oldTrip.kursowkaCode !== newTrip.kursowkaCode;

  const actualKind: TripDiffKind =
    timeChanged || routeChanged || brigadeChanged || Math.abs(lengthDeltaMeters) >= 150
      ? "changed"
      : "unchanged";

  return {
    id,
    kind: actualKind,
    routeShort: ref.routeShort,
    routeColor: ref.routeColor,
    routeTextColor: ref.routeTextColor,
    directionId: ref.directionId,
    oldTrip,
    newTrip,
    departureDeltaMin,
    arrivalDeltaMin,
    durationDeltaMin,
    lengthDeltaMeters,
    stopCountDelta,
    timeChanged,
    routeChanged,
    brigadeChanged,
  };
}

export function compareScheduleTrips(
  tripsA: readonly ScheduleTripSnapshot[],
  tripsB: readonly ScheduleTripSnapshot[],
  labelA: string,
  labelB: string,
): ScheduleDiffResult {
  // Group by (routeShort, directionId) for deterministic, fast matching.
  const groups = new Map<
    string,
    { a: ScheduleTripSnapshot[]; b: ScheduleTripSnapshot[] }
  >();
  const groupKey = (t: ScheduleTripSnapshot) => `${t.routeShort}|${t.directionId}`;

  for (const t of tripsA) {
    const k = groupKey(t);
    const g = groups.get(k);
    if (g) g.a.push(t);
    else groups.set(k, { a: [t], b: [] });
  }
  for (const t of tripsB) {
    const k = groupKey(t);
    const g = groups.get(k);
    if (g) g.b.push(t);
    else groups.set(k, { a: [], b: [t] });
  }

  const allDiffs: TripDiffItem[] = [];
  let seq = 0;

  for (const { a, b } of groups.values()) {
    const usedA = new Uint8Array(a.length);
    const usedB = new Uint8Array(b.length);

    // Pass 1: Exact match (same start, end, endpoints, stops, brigade)
    const exactBucketB = new Map<string, number[]>();
    for (let j = 0; j < b.length; j += 1) {
      const tb = b[j];
      const sig = `${tb.startMinutes}|${tb.endMinutes}|${foldStopKey(tb.firstStopName)}|${foldStopKey(tb.lastStopName)}|${tb.stopCount}|${tb.kursowkaCode}`;
      const list = exactBucketB.get(sig);
      if (list) list.push(j);
      else exactBucketB.set(sig, [j]);
    }
    for (let i = 0; i < a.length; i += 1) {
      const ta = a[i];
      const sig = `${ta.startMinutes}|${ta.endMinutes}|${foldStopKey(ta.firstStopName)}|${foldStopKey(ta.lastStopName)}|${ta.stopCount}|${ta.kursowkaCode}`;
      const list = exactBucketB.get(sig);
      if (list && list.length > 0) {
        const j = list.shift()!;
        usedA[i] = 1;
        usedB[j] = 1;
        seq += 1;
        allDiffs.push(buildDiffItem(`d_${seq}`, "unchanged", ta, b[j]));
      }
    }

    // Pass 2 & 3: Cost-ranked 1-to-1 matching for time-shifted / modified trips (<= 20 min)
    interface PairCandidate {
      i: number;
      j: number;
      cost: number;
    }
    const candidates: PairCandidate[] = [];
    for (let i = 0; i < a.length; i += 1) {
      if (usedA[i]) continue;
      const ta = a[i];
      for (let j = 0; j < b.length; j += 1) {
        if (usedB[j]) continue;
        const tb = b[j];
        const dt = Math.abs(tb.startMinutes - ta.startMinutes);
        if (dt > MAX_TIME_SHIFT_MATCH_MIN) continue;

        const sameFirst = stopKeysEqual(ta.firstStopName, tb.firstStopName);
        const sameLast = stopKeysEqual(ta.lastStopName, tb.lastStopName);
        // Require at least one matching endpoint so unrelated short turns don't collide.
        if (!sameFirst && !sameLast) continue;

        const sameBrigade =
          ta.kursowkaCode !== "" && ta.kursowkaCode === tb.kursowkaCode;
        const cost =
          dt * 12 +
          (sameFirst && sameLast ? 0 : 45) +
          (sameBrigade ? 0 : 14) +
          Math.abs(tb.stopCount - ta.stopCount) * 4 +
          Math.abs(tb.endMinutes - ta.endMinutes) * 0.5;
        candidates.push({ i, j, cost });
      }
    }

    candidates.sort((x, y) => x.cost - y.cost || x.i - y.i || x.j - y.j);
    for (const c of candidates) {
      if (usedA[c.i] || usedB[c.j]) continue;
      usedA[c.i] = 1;
      usedB[c.j] = 1;
      seq += 1;
      allDiffs.push(buildDiffItem(`d_${seq}`, "changed", a[c.i], b[c.j]));
    }

    // Pass 4: Remaining unmatched = removed / added
    for (let i = 0; i < a.length; i += 1) {
      if (usedA[i]) continue;
      seq += 1;
      allDiffs.push(buildDiffItem(`d_${seq}`, "removed", a[i], null));
    }
    for (let j = 0; j < b.length; j += 1) {
      if (usedB[j]) continue;
      seq += 1;
      allDiffs.push(buildDiffItem(`d_${seq}`, "added", null, b[j]));
    }
  }

  // Sort trips cleanly: by line, direction, departure time
  allDiffs.sort((x, y) => {
    const lineCmp = compareLineCodes(x.routeShort, y.routeShort);
    if (lineCmp !== 0) return lineCmp;
    if (x.directionId !== y.directionId) return x.directionId - y.directionId;
    const xMin = x.newTrip?.startMinutes ?? x.oldTrip?.startMinutes ?? 0;
    const yMin = y.newTrip?.startMinutes ?? y.oldTrip?.startMinutes ?? 0;
    return xMin - yMin;
  });

  // Aggregate per-line stats
  const lineMap = new Map<
    string,
    {
      routeShort: string;
      color: string;
      textColor: string;
      tripsOld: number;
      tripsNew: number;
      addedCount: number;
      removedCount: number;
      changedCount: number;
      unchangedCount: number;
      brigadesOldSet: Set<string>;
      brigadesNewSet: Set<string>;
      metersOld: number;
      metersNew: number;
    }
  >();

  const getLineAgg = (ref: ScheduleTripSnapshot) => {
    let agg = lineMap.get(ref.routeShort);
    if (!agg) {
      agg = {
        routeShort: ref.routeShort,
        color: ref.routeColor,
        textColor: ref.routeTextColor,
        tripsOld: 0,
        tripsNew: 0,
        addedCount: 0,
        removedCount: 0,
        changedCount: 0,
        unchangedCount: 0,
        brigadesOldSet: new Set<string>(),
        brigadesNewSet: new Set<string>(),
        metersOld: 0,
        metersNew: 0,
      };
      lineMap.set(ref.routeShort, agg);
    }
    return agg;
  };

  // Aggregate per-brigade vehicle-km (wozokilometry)
  interface BrigadeAgg {
    key: string;
    brigadeCode: string;
    unassigned: boolean;
    routeShort: string;
    routeColor: string;
    routeTextColor: string;
    operatorKey: string;
    tripsOld: number;
    tripsNew: number;
    addedTrips: number;
    removedTrips: number;
    changedTrips: number;
    metersOld: number;
    metersNew: number;
    firstDepOld: number | null;
    lastArrOld: number | null;
    firstDepNew: number | null;
    lastArrNew: number | null;
    tripDiffs: TripDiffItem[];
  }

  const brigadeMap = new Map<string, BrigadeAgg>();
  const brigadeKeyFor = (t: ScheduleTripSnapshot): { key: string; code: string; unassigned: boolean } => {
    if (t.kursowkaCode) {
      return { key: t.kursowkaCode, code: t.kursowkaCode, unassigned: false };
    }
    return {
      key: `${t.routeShort}::unassigned`,
      code: `${t.routeShort} (bez brygady)`,
      unassigned: true,
    };
  };

  const getBrigadeAgg = (t: ScheduleTripSnapshot): BrigadeAgg => {
    const info = brigadeKeyFor(t);
    let agg = brigadeMap.get(info.key);
    if (!agg) {
      agg = {
        key: info.key,
        brigadeCode: info.code,
        unassigned: info.unassigned,
        routeShort: t.routeShort,
        routeColor: t.routeColor,
        routeTextColor: t.routeTextColor,
        operatorKey: t.operatorKey,
        tripsOld: 0,
        tripsNew: 0,
        addedTrips: 0,
        removedTrips: 0,
        changedTrips: 0,
        metersOld: 0,
        metersNew: 0,
        firstDepOld: null,
        lastArrOld: null,
        firstDepNew: null,
        lastArrNew: null,
        tripDiffs: [],
      };
      brigadeMap.set(info.key, agg);
    } else if (!agg.operatorKey && t.operatorKey) {
      agg.operatorKey = t.operatorKey;
    }
    return agg;
  };

  let addedCount = 0;
  let removedCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;
  let timeShiftedCount = 0;
  let routeChangedCount = 0;
  let brigadeChangedCount = 0;

  for (const item of allDiffs) {
    const ref = item.newTrip ?? item.oldTrip!;
    const lineAgg = getLineAgg(ref);

    if (item.kind === "added") addedCount += 1;
    else if (item.kind === "removed") removedCount += 1;
    else if (item.kind === "changed") changedCount += 1;
    else unchangedCount += 1;

    if (item.kind === "changed") {
      if (item.timeChanged) timeShiftedCount += 1;
      if (item.routeChanged) routeChangedCount += 1;
      if (item.brigadeChanged) brigadeChangedCount += 1;
    }

    if (item.kind === "added") lineAgg.addedCount += 1;
    else if (item.kind === "removed") lineAgg.removedCount += 1;
    else if (item.kind === "changed") lineAgg.changedCount += 1;
    else lineAgg.unchangedCount += 1;

    if (item.oldTrip) {
      const ot = item.oldTrip;
      lineAgg.tripsOld += 1;
      lineAgg.metersOld += ot.lengthMeters;
      if (ot.kursowkaCode) lineAgg.brigadesOldSet.add(ot.kursowkaCode);

      const bOld = getBrigadeAgg(ot);
      bOld.tripsOld += 1;
      bOld.metersOld += ot.lengthMeters;
      bOld.firstDepOld =
        bOld.firstDepOld === null ? ot.startMinutes : Math.min(bOld.firstDepOld, ot.startMinutes);
      bOld.lastArrOld =
        bOld.lastArrOld === null ? ot.endMinutes : Math.max(bOld.lastArrOld, ot.endMinutes);
      if (item.kind === "removed") {
        bOld.removedTrips += 1;
        bOld.tripDiffs.push(item);
      } else if (item.kind === "changed") {
        bOld.changedTrips += 1;
        bOld.tripDiffs.push(item);
      }
    }

    if (item.newTrip) {
      const nt = item.newTrip;
      lineAgg.tripsNew += 1;
      lineAgg.metersNew += nt.lengthMeters;
      if (nt.kursowkaCode) lineAgg.brigadesNewSet.add(nt.kursowkaCode);

      const bNew = getBrigadeAgg(nt);
      bNew.tripsNew += 1;
      bNew.metersNew += nt.lengthMeters;
      bNew.firstDepNew =
        bNew.firstDepNew === null ? nt.startMinutes : Math.min(bNew.firstDepNew, nt.startMinutes);
      bNew.lastArrNew =
        bNew.lastArrNew === null ? nt.endMinutes : Math.max(bNew.lastArrNew, nt.endMinutes);
      if (item.kind === "added") {
        bNew.addedTrips += 1;
        bNew.tripDiffs.push(item);
      } else if (item.kind === "changed") {
        // Avoid double-pushing when old and new belong to the same brigade
        const sameBrigade =
          item.oldTrip && brigadeKeyFor(item.oldTrip).key === brigadeKeyFor(nt).key;
        if (!sameBrigade) {
          bNew.changedTrips += 1;
          bNew.tripDiffs.push(item);
        }
      }
    }
  }

  const lines: LineScheduleDiff[] = [...lineMap.values()]
    .map((agg): LineScheduleDiff => {
      const status: EntityDiffStatus =
        agg.tripsOld === 0
          ? "added"
          : agg.tripsNew === 0
            ? "removed"
            : agg.addedCount > 0 || agg.removedCount > 0 || agg.changedCount > 0
              ? "changed"
              : "unchanged";
      return {
        routeShort: agg.routeShort,
        color: agg.color,
        textColor: agg.textColor,
        status,
        tripsOld: agg.tripsOld,
        tripsNew: agg.tripsNew,
        tripsDelta: agg.tripsNew - agg.tripsOld,
        addedCount: agg.addedCount,
        removedCount: agg.removedCount,
        changedCount: agg.changedCount,
        unchangedCount: agg.unchangedCount,
        brigadesOld: agg.brigadesOldSet.size,
        brigadesNew: agg.brigadesNewSet.size,
        brigadesDelta: agg.brigadesNewSet.size - agg.brigadesOldSet.size,
        metersOld: agg.metersOld,
        metersNew: agg.metersNew,
        metersDelta: agg.metersNew - agg.metersOld,
      };
    })
    .sort((a, b) => compareLineCodes(a.routeShort, b.routeShort));

  const brigades: BrigadeScheduleDiff[] = [...brigadeMap.values()]
    .map((agg): BrigadeScheduleDiff => {
      const metersDelta = agg.metersNew - agg.metersOld;
      const metersDeltaPct =
        agg.metersOld > 0 ? (metersDelta / agg.metersOld) * 100 : null;
      const status: EntityDiffStatus =
        agg.tripsOld === 0
          ? "added"
          : agg.tripsNew === 0
            ? "removed"
            : agg.addedTrips > 0 ||
                agg.removedTrips > 0 ||
                agg.changedTrips > 0 ||
                Math.abs(metersDelta) >= 100
              ? "changed"
              : "unchanged";
      return {
        key: agg.key,
        brigadeCode: agg.brigadeCode,
        unassigned: agg.unassigned,
        routeShort: agg.routeShort,
        routeColor: agg.routeColor,
        routeTextColor: agg.routeTextColor,
        operatorKey: agg.operatorKey,
        status,
        tripsOld: agg.tripsOld,
        tripsNew: agg.tripsNew,
        tripsDelta: agg.tripsNew - agg.tripsOld,
        addedTrips: agg.addedTrips,
        removedTrips: agg.removedTrips,
        changedTrips: agg.changedTrips,
        metersOld: agg.metersOld,
        metersNew: agg.metersNew,
        metersDelta,
        metersDeltaPct,
        firstDepOld: agg.firstDepOld,
        lastArrOld: agg.lastArrOld,
        firstDepNew: agg.firstDepNew,
        lastArrNew: agg.lastArrNew,
        tripDiffs: agg.tripDiffs,
      };
    })
    .sort(compareBrigadeKeys);

  const metersOld = lines.reduce((sum, l) => sum + l.metersOld, 0);
  const metersNew = lines.reduce((sum, l) => sum + l.metersNew, 0);
  const brigadesOld = brigades.filter((b) => !b.unassigned && b.tripsOld > 0).length;
  const brigadesNew = brigades.filter((b) => !b.unassigned && b.tripsNew > 0).length;

  return {
    labelA,
    labelB,
    totals: {
      tripsOld: tripsA.length,
      tripsNew: tripsB.length,
      tripsDelta: tripsB.length - tripsA.length,
      addedCount,
      removedCount,
      changedCount,
      unchangedCount,
      timeShiftedCount,
      routeChangedCount,
      brigadeChangedCount,
      metersOld,
      metersNew,
      metersDelta: metersNew - metersOld,
      brigadesOld,
      brigadesNew,
      brigadesDelta: brigadesNew - brigadesOld,
      linesOld: lines.filter((l) => l.tripsOld > 0).length,
      linesNew: lines.filter((l) => l.tripsNew > 0).length,
      linesWithChanges: lines.filter((l) => l.status !== "unchanged").length,
    },
    lines,
    trips: allDiffs,
    brigades,
  };
}

function csvCell(value: string | number): string {
  const str = String(value);
  if (/[;"\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/**
 * Eksportuje pełny raport porównania (wozokilometry brygad + wszystkie zmiany kursów)
 * w formacie CSV z separatorem `;` gotowym do otwarcia w polskim Excelu.
 */
export function exportScheduleDiffCsv(diff: ScheduleDiffResult): string {
  const lines: string[] = [];
  lines.push(
    ["Porównanie rozkładów GTFS", diff.labelA, "→", diff.labelB].map(csvCell).join(";"),
  );
  lines.push("");
  lines.push("BRYGADY I WOZOKILOMETRY");
  lines.push(
    [
      "Linia",
      "Brygada",
      "Przewoźnik",
      "Status",
      "Kursy (stary)",
      "Kursy (nowy)",
      "Zmiana kursów",
      "Wzkm stary [km]",
      "Wzkm nowy [km]",
      "Różnica wzkm [km]",
    ]
      .map(csvCell)
      .join(";"),
  );

  for (const b of diff.brigades) {
    lines.push(
      [
        b.routeShort,
        b.brigadeCode,
        b.operatorKey || "—",
        b.status === "added"
          ? "Nowa"
          : b.status === "removed"
            ? "Zlikwidowana"
            : b.status === "changed"
              ? "Zmieniona"
              : "Bez zmian",
        b.tripsOld,
        b.tripsNew,
        b.tripsDelta,
        (b.metersOld / 1000).toFixed(2).replace(".", ","),
        (b.metersNew / 1000).toFixed(2).replace(".", ","),
        (b.metersDelta / 1000).toFixed(2).replace(".", ","),
      ]
        .map(csvCell)
        .join(";"),
    );
  }

  lines.push("");
  lines.push("ZMIANY KURSÓW");
  lines.push(
    [
      "Typ zmiany",
      "Linia",
      "Brygada (stary)",
      "Brygada (nowy)",
      "Odjazd (stary)",
      "Odjazd (nowy)",
      "Przesunięcie [min]",
      "Trasa (stary)",
      "Trasa (nowy)",
      "Różnica km",
    ]
      .map(csvCell)
      .join(";"),
  );

  for (const t of diff.trips) {
    if (t.kind === "unchanged") continue;
    lines.push(
      [
        t.kind === "added"
          ? "Dodany"
          : t.kind === "removed"
            ? "Usunięty"
            : "Zmieniony",
        t.routeShort,
        t.oldTrip?.kursowkaCode || "—",
        t.newTrip?.kursowkaCode || "—",
        t.oldTrip ? minutesToClock(t.oldTrip.startMinutes) : "—",
        t.newTrip ? minutesToClock(t.newTrip.startMinutes) : "—",
        t.kind === "changed" ? t.departureDeltaMin : 0,
        t.oldTrip ? `${t.oldTrip.firstStopName} → ${t.oldTrip.lastStopName}` : "—",
        t.newTrip ? `${t.newTrip.firstStopName} → ${t.newTrip.lastStopName}` : "—",
        (t.lengthDeltaMeters / 1000).toFixed(2).replace(".", ","),
      ]
        .map(csvCell)
        .join(";"),
    );
  }

  return `\uFEFF${lines.join("\r\n")}`;
}
