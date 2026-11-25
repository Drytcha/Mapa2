/**
 * Kreator własnych linii GTFS oraz silnik łączenia z plikiem źródłowym GTFS (.zip).
 *
 * Pozwala Planiście:
 *  - zdefiniować dowolną liczbę nowych linii (numer, nazwa, kolor, warianty/kierunki,
 *    kolejne przystanki z bazy GTFS lub nowe przystanki GPS, czasy przejazdu między
 *    przystankami, przebieg po ulicach do `shapes.txt`, kursy / takt / brygady),
 *  - wybrać dokładnie KTÓRE z utworzonych linii mają zostać dopisane do źródłowego
 *    pliku GTFS (`.zip`) i wyeksportowane jako kompletna, gotowa paczka GTFS,
 *  - opcjonalnie wbudować do `shapes.txt` także poprawione kształty z Edytora linii.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  cumulativeRouteMeters,
  distanceCoords,
  pointToSegmentMeters,
} from "../core/spatial";
import {
  sanitizePath,
  sliceCorridorForTrip,
  type LatLng,
} from "../routeEditorGeometry";
import {
  sanitizeGtfsId,
  type RouteExportEntry,
} from "../routeExportFormats";
import {
  isDirectionOverride,
  normalizeLineShort,
  type LineRouteOverride,
} from "./lineRouteOverrides";
import { idbGetKv, idbSetKv } from "./storage";

const CUSTOM_LINES_KV_KEY = "custom_gtfs_lines_v1";

export interface CustomGtfsStop {
  id: string;
  /** Istniejący `stop_id` z GTFS lub własny identyfikator nowego przystanku. */
  stopId: string;
  name: string;
  lat: number;
  lon: number;
  code?: string;
  /** true = nowy przystanek, zostanie dopisany do `stops.txt` przy eksporcie. */
  isCustomStop?: boolean;
  /** Skumulowany czas przejazdu w minutach od startu kursu (0, 2, 5, 9…). */
  offsetMinutes: number;
  /** Opcjonalny czas postoju na przystanku w minutach (domyślnie 0). */
  dwellMinutes?: number;
  pickupType?: number;
  dropOffType?: number;
}

export interface CustomGtfsVariant {
  id: string;
  name: string;
  directionId: number;
  headsign: string;
  shapeId: string;
  stops: CustomGtfsStop[];
  /** Polilinia do `shapes.txt` (np. poprowadzona po drogach OSRM). */
  path: LatLng[];
}

export interface CustomGtfsTrip {
  id: string;
  variantId: string;
  /** `service_id` z pliku źródłowego (np. `388_RS`) albo z własnego kalendarza. */
  serviceId: string;
  /** Minuta odjazdu od północy (np. 360 = 06:00, 1455 = 24:15). */
  departureMinutes: number;
  /** Opcjonalna brygada / kursówka (`block_id`, np. `S5/01`). */
  blockId?: string;
  tripShortName?: string;
  /** Opcjonalne nadpisanie czasów przejazdu dla tego konkretnego kursu. */
  customOffsets?: number[];
}

export interface CustomGtfsServiceDef {
  serviceId: string;
  label: string;
  /** YYYYMMDD */
  startDate: string;
  /** YYYYMMDD */
  endDate: string;
  /** [pon, wt, śr, czw, pt, sob, niedz] */
  days: [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
}

export interface CustomGtfsLine {
  id: string;
  routeId: string;
  shortName: string;
  longName: string;
  /** GTFS route_type: 3 = Autobus, 0 = Tramwaj, 2 = Kolej, 11 = Trolejbus */
  routeType: number;
  color: string;
  textColor: string;
  agencyId?: string;
  note?: string;
  variants: CustomGtfsVariant[];
  trips: CustomGtfsTrip[];
  customServices?: CustomGtfsServiceDef[];
  updatedAt: string;
}

export interface GtfsSourceMetadata {
  label: string;
  fileCount: number;
  routeCount: number;
  stopCount: number;
  tripCount: number;
  agencyIds: string[];
  serviceIds: string[];
  feedStartDate: string;
  feedEndDate: string;
}

export interface GtfsMergeOptions {
  /** Bajty źródłowego GTFS `.zip` (albo `null` = samodzielny GTFS tylko z wybranych linii). */
  sourceZipBytes: Uint8Array | null;
  /** Wybrane przez Planistę dodatkowe linie do dołączenia i wyeksportowania. */
  selectedLines: readonly CustomGtfsLine[];
  /** Opcjonalne poprawki geometrii z Edytora linii do wbudowania w `shapes.txt`. */
  routeOverrides?: readonly LineRouteOverride[];
}

export interface GtfsExportSummary {
  includedLines: string[];
  addedRoutes: number;
  addedStops: number;
  addedShapes: number;
  addedTrips: number;
  addedStopTimes: number;
  addedServices: number;
  updatedOverrideShapes: number;
  totalFilesInZip: number;
  zipSizeBytes: number;
}

export interface GtfsMergeResult {
  zipBytes: Uint8Array;
  summary: GtfsExportSummary;
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/*  Funkcje pomocnicze: formatowanie czasu, generowanie wariantów i kursów     */
/* -------------------------------------------------------------------------- */

function makeUid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Formatuje minuty od północy jako pełny czas GTFS `HH:MM:SS` (obsługuje >= 24:00:00). */
export function formatGtfsClockHms(totalMinutes: number): string {
  const safe = Math.max(0, Math.round(totalMinutes));
  const hh = String(Math.floor(safe / 60)).padStart(2, "0");
  const mm = String(safe % 60).padStart(2, "0");
  return `${hh}:${mm}:00`;
}

/** Formatuje minuty od północy jako `HH:MM` (z obsługą 24:xx dla kursów nocnych). */
export function formatGtfsClockHm(totalMinutes: number): string {
  const safe = Math.max(0, Math.round(totalMinutes));
  const hh = String(Math.floor(safe / 60)).padStart(2, "0");
  const mm = String(safe % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Parsuje pojedynczą godzinę `HH:MM` lub `H:MM` (np. `5:30`, `24:15`) na minuty. */
export function parseClockToMinutes(raw: string): number | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 36 || mm > 59) {
    return null;
  }
  return hh * 60 + mm;
}

/**
 * Parsuje wklejoną listę godzin odjazdów (oddzieloną przecinkami, spacjami, średnikami
 * lub nowymi liniami — np. prosto z Excela) na posortowane minuty od północy.
 */
export function parseDepartureTimesText(rawText: string): number[] {
  const tokens = rawText.split(/[\s,;|]+/).filter(Boolean);
  const mins: number[] = [];
  for (const token of tokens) {
    const parsed = parseClockToMinutes(token);
    if (parsed !== null) mins.push(parsed);
  }
  return [...new Set(mins)].sort((a, b) => a - b);
}

/** Generuje serię kursów w stałym takcie (np. od 05:30 do 22:30 co 30 min). */
export function generateHeadwayTrips(params: {
  variantId: string;
  serviceId: string;
  startMinutes: number;
  endMinutes: number;
  intervalMinutes: number;
  blockId?: string;
}): CustomGtfsTrip[] {
  const step = Math.max(1, Math.round(params.intervalMinutes));
  const start = Math.max(0, Math.round(params.startMinutes));
  const end = Math.max(start, Math.round(params.endMinutes));
  const out: CustomGtfsTrip[] = [];
  for (let m = start; m <= end && out.length < 300; m += step) {
    out.push({
      id: makeUid("trip"),
      variantId: params.variantId,
      serviceId: params.serviceId.trim(),
      departureMinutes: m,
      blockId: params.blockId?.trim() || undefined,
    });
  }
  return out;
}

/** Tworzy pusty szablon nowej linii własnej gotowy do edycji. */
export function createEmptyCustomLine(
  shortName = "S5",
  defaultServiceId = "",
): CustomGtfsLine {
  const cleanShort = shortName.trim().toUpperCase() || "NOWA";
  const safeId = sanitizeGtfsId(cleanShort, "LINE");
  const var0Id = makeUid("var");
  return {
    id: makeUid("cline"),
    routeId: `CUSTOM_${safeId}`,
    shortName: cleanShort,
    longName: `Nowa linia ${cleanShort}`,
    routeType: 3,
    color: "#1d4ed8",
    textColor: "#ffffff",
    variants: [
      {
        id: var0Id,
        name: "Kierunek 1 (Tam)",
        directionId: 0,
        headsign: "",
        shapeId: `CUSTOM_SHAPE_${safeId}_0`,
        stops: [],
        path: [],
      },
    ],
    trips: [],
    customServices: defaultServiceId
      ? []
      : [
          {
            serviceId: `CUSTOM_${safeId}_RS`,
            label: "Dni robocze (własny)",
            startDate: "20260101",
            endDate: "20271231",
            days: [true, true, true, true, true, false, false],
          },
        ],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Tworzy wariant w kierunku przeciwnym z odwróconą kolejnością przystanków,
 * przeliczonymi symetrycznie czasami przejazdu i odwróconym kształtem trasy.
 */
export function createOppositeVariant(
  source: CustomGtfsVariant,
  lineShort: string,
  overrideReversedPath?: LatLng[],
): CustomGtfsVariant {
  const nextDir = source.directionId === 0 ? 1 : 0;
  const totalOffset =
    source.stops.length > 0
      ? source.stops[source.stops.length - 1].offsetMinutes
      : 0;
  const reversedStops: CustomGtfsStop[] = [...source.stops]
    .reverse()
    .map((stop, idx) => ({
      ...stop,
      id: makeUid("stp"),
      offsetMinutes: idx === 0 ? 0 : Math.max(0, totalOffset - stop.offsetMinutes),
    }));

  const firstName = reversedStops[0]?.name || "";
  const lastName = reversedStops[reversedStops.length - 1]?.name || "";
  const path = overrideReversedPath
    ? sanitizePath(overrideReversedPath)
    : sanitizePath([...source.path].reverse());

  return {
    id: makeUid("var"),
    name:
      firstName && lastName
        ? `Powrót: ${firstName} → ${lastName}`
        : `Kierunek ${nextDir + 1} (Powrót)`,
    directionId: nextDir,
    headsign: lastName || source.headsign,
    shapeId: `CUSTOM_SHAPE_${sanitizeGtfsId(lineShort, "LINE")}_${nextDir}_${Math.random().toString(36).slice(2, 5)}`,
    stops: reversedStops,
    path,
  };
}

/** Konwertuje warianty wybranych linii własnych do formatu eksportu GPX/GeoJSON/shapes.txt. */
export function customLinesToExportEntries(
  lines: readonly CustomGtfsLine[],
): RouteExportEntry[] {
  const out: RouteExportEntry[] = [];
  for (const line of lines) {
    for (const variant of line.variants) {
      const path =
        variant.path.length >= 2
          ? variant.path
          : variant.stops.map((s): LatLng => [s.lat, s.lon]);
      if (path.length < 2) continue;
      out.push({
        shapeId: sanitizeGtfsId(
          variant.shapeId,
          `CUSTOM_${line.shortName}_${variant.directionId}`,
        ),
        lineShort: line.shortName,
        name: `Linia ${line.shortName} · ${variant.name || variant.headsign}`,
        directionId: variant.directionId,
        firstStopName: variant.stops[0]?.name,
        lastStopName: variant.stops[variant.stops.length - 1]?.name,
        note: line.note,
        updatedAt: line.updatedAt,
        path,
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Trwałe przechowywanie projektów własnych linii (IndexedDB + JSON)          */
/* -------------------------------------------------------------------------- */

function sanitizeCustomLine(raw: unknown): CustomGtfsLine | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : makeUid("cline");
  const shortName =
    typeof obj.shortName === "string" && obj.shortName.trim()
      ? obj.shortName.trim().toUpperCase()
      : "";
  if (!shortName) return null;

  const variantsRaw = Array.isArray(obj.variants) ? obj.variants : [];
  const variants: CustomGtfsVariant[] = [];
  for (const vr of variantsRaw) {
    if (!vr || typeof vr !== "object") continue;
    const v = vr as Record<string, unknown>;
    const stopsRaw = Array.isArray(v.stops) ? v.stops : [];
    const stops: CustomGtfsStop[] = [];
    for (const sr of stopsRaw) {
      if (!sr || typeof sr !== "object") continue;
      const s = sr as Record<string, unknown>;
      const lat = Number(s.lat);
      const lon = Number(s.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      stops.push({
        id: typeof s.id === "string" && s.id ? s.id : makeUid("stp"),
        stopId: typeof s.stopId === "string" && s.stopId.trim() ? s.stopId.trim() : makeUid("CS"),
        name: typeof s.name === "string" ? s.name.trim() : "Przystanek",
        lat,
        lon,
        code: typeof s.code === "string" && s.code.trim() ? s.code.trim() : undefined,
        isCustomStop: Boolean(s.isCustomStop),
        offsetMinutes: Math.max(0, Math.round(Number(s.offsetMinutes) || 0)),
        dwellMinutes: Math.max(0, Math.round(Number(s.dwellMinutes) || 0)),
        pickupType: typeof s.pickupType === "number" ? s.pickupType : 0,
        dropOffType: typeof s.dropOffType === "number" ? s.dropOffType : 0,
      });
    }
    const rawPath = Array.isArray(v.path)
      ? (v.path as unknown[]).filter(
          (p): p is LatLng =>
            Array.isArray(p) &&
            p.length === 2 &&
            Number.isFinite(Number(p[0])) &&
            Number.isFinite(Number(p[1])),
        )
      : [];

    variants.push({
      id: typeof v.id === "string" && v.id ? v.id : makeUid("var"),
      name: typeof v.name === "string" && v.name.trim() ? v.name.trim() : "Wariant",
      directionId: Number(v.directionId) === 1 ? 1 : 0,
      headsign: typeof v.headsign === "string" ? v.headsign.trim() : "",
      shapeId:
        typeof v.shapeId === "string" && v.shapeId.trim()
          ? v.shapeId.trim()
          : `CUSTOM_SHAPE_${sanitizeGtfsId(shortName)}_${variants.length}`,
      stops,
      path: sanitizePath(rawPath),
    });
  }

  const tripsRaw = Array.isArray(obj.trips) ? obj.trips : [];
  const trips: CustomGtfsTrip[] = [];
  for (const tr of tripsRaw) {
    if (!tr || typeof tr !== "object") continue;
    const t = tr as Record<string, unknown>;
    if (typeof t.variantId !== "string" || typeof t.serviceId !== "string") continue;
    const dep = Number(t.departureMinutes);
    if (!Number.isFinite(dep) || dep < 0) continue;
    trips.push({
      id: typeof t.id === "string" && t.id ? t.id : makeUid("trip"),
      variantId: t.variantId,
      serviceId: t.serviceId.trim(),
      departureMinutes: Math.round(dep),
      blockId: typeof t.blockId === "string" && t.blockId.trim() ? t.blockId.trim() : undefined,
      tripShortName:
        typeof t.tripShortName === "string" && t.tripShortName.trim()
          ? t.tripShortName.trim()
          : undefined,
      customOffsets: Array.isArray(t.customOffsets)
        ? t.customOffsets.map((n) => Math.max(0, Math.round(Number(n) || 0)))
        : undefined,
    });
  }

  const customServicesRaw = Array.isArray(obj.customServices) ? obj.customServices : [];
  const customServices: CustomGtfsServiceDef[] = [];
  for (const cs of customServicesRaw) {
    if (!cs || typeof cs !== "object") continue;
    const c = cs as Record<string, unknown>;
    if (typeof c.serviceId !== "string" || !c.serviceId.trim()) continue;
    const daysArr = Array.isArray(c.days) && c.days.length === 7
      ? (c.days.map(Boolean) as [boolean, boolean, boolean, boolean, boolean, boolean, boolean])
      : ([true, true, true, true, true, false, false] as [boolean, boolean, boolean, boolean, boolean, boolean, boolean]);
    customServices.push({
      serviceId: c.serviceId.trim(),
      label: typeof c.label === "string" && c.label.trim() ? c.label.trim() : c.serviceId.trim(),
      startDate:
        typeof c.startDate === "string" && /^\d{8}$/.test(c.startDate)
          ? c.startDate
          : "20260101",
      endDate:
        typeof c.endDate === "string" && /^\d{8}$/.test(c.endDate)
          ? c.endDate
          : "20271231",
      days: daysArr,
    });
  }

  return {
    id,
    routeId:
      typeof obj.routeId === "string" && obj.routeId.trim()
        ? obj.routeId.trim()
        : `CUSTOM_${sanitizeGtfsId(shortName)}`,
    shortName,
    longName:
      typeof obj.longName === "string" && obj.longName.trim()
        ? obj.longName.trim()
        : `Linia ${shortName}`,
    routeType:
      typeof obj.routeType === "number" && Number.isFinite(obj.routeType)
        ? Math.trunc(obj.routeType)
        : 3,
    color:
      typeof obj.color === "string" && /^#[0-9a-fA-F]{6}$/.test(obj.color.trim())
        ? obj.color.trim()
        : "#1d4ed8",
    textColor:
      typeof obj.textColor === "string" && /^#[0-9a-fA-F]{6}$/.test(obj.textColor.trim())
        ? obj.textColor.trim()
        : "#ffffff",
    agencyId:
      typeof obj.agencyId === "string" && obj.agencyId.trim()
        ? obj.agencyId.trim()
        : undefined,
    note: typeof obj.note === "string" && obj.note.trim() ? obj.note.trim() : undefined,
    variants,
    trips,
    customServices,
    updatedAt:
      typeof obj.updatedAt === "string" && obj.updatedAt.trim()
        ? obj.updatedAt.trim()
        : new Date().toISOString(),
  };
}

export async function loadCustomGtfsLines(): Promise<CustomGtfsLine[]> {
  const stored = await idbGetKv<unknown[]>(CUSTOM_LINES_KV_KEY);
  if (!Array.isArray(stored)) return [];
  return stored
    .map(sanitizeCustomLine)
    .filter((line): line is CustomGtfsLine => line !== null);
}

export async function saveAllCustomGtfsLines(
  lines: readonly CustomGtfsLine[],
): Promise<CustomGtfsLine[]> {
  const clean = lines
    .map(sanitizeCustomLine)
    .filter((line): line is CustomGtfsLine => line !== null);
  await idbSetKv(CUSTOM_LINES_KV_KEY, clean);
  return clean;
}

export async function upsertCustomGtfsLine(
  line: CustomGtfsLine,
): Promise<CustomGtfsLine[]> {
  const current = await loadCustomGtfsLines();
  const nextLine = { ...line, updatedAt: new Date().toISOString() };
  const idx = current.findIndex((item) => item.id === nextLine.id);
  const next =
    idx >= 0
      ? current.map((item, i) => (i === idx ? nextLine : item))
      : [...current, nextLine];
  return saveAllCustomGtfsLines(next);
}

export async function deleteCustomGtfsLine(
  lineId: string,
): Promise<CustomGtfsLine[]> {
  const current = await loadCustomGtfsLines();
  return saveAllCustomGtfsLines(current.filter((item) => item.id !== lineId));
}

export function exportCustomGtfsLinesJson(
  lines: readonly CustomGtfsLine[],
): string {
  return JSON.stringify(
    {
      version: 1,
      exportedAt: new Date().toISOString(),
      lines,
    },
    null,
    2,
  );
}

export function parseCustomGtfsLinesJson(jsonText: string): CustomGtfsLine[] {
  const parsed = JSON.parse(jsonText) as unknown;
  const rawList = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { lines?: unknown }).lines)
      ? (parsed as { lines: unknown[] }).lines
      : null;
  if (!rawList) {
    throw new Error("Nieprawidłowy format pliku JSON z projektami linii GTFS.");
  }
  return rawList
    .map(sanitizeCustomLine)
    .filter((line): line is CustomGtfsLine => line !== null);
}

/* -------------------------------------------------------------------------- */
/*  Parser i pisarz CSV zachowujący kolumny pliku źródłowego GTFS              */
/* -------------------------------------------------------------------------- */

interface CsvTable {
  headers: string[];
  rows: string[][];
}

function parseCsvTable(text: string): CsvTable {
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
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    if (row.some((c) => c.length > 0)) rows.push(row);
  }
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  const dataRows = rows.slice(1).map((r) => {
    if (r.length === headers.length) return r;
    const padded = r.slice(0, headers.length);
    while (padded.length < headers.length) padded.push("");
    return padded;
  });
  return { headers, rows: dataRows };
}

function csvEscape(value: string): string {
  if (/[,"\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function serializeCsvTable(table: CsvTable): string {
  const lines: string[] = [table.headers.map(csvEscape).join(",")];
  for (const row of table.rows) {
    const cells: string[] = [];
    for (let i = 0; i < table.headers.length; i += 1) {
      cells.push(csvEscape(row[i] ?? ""));
    }
    lines.push(cells.join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function ensureColumns(table: CsvTable, requiredCols: readonly string[]): void {
  if (table.headers.length === 0) {
    table.headers = [...requiredCols];
    return;
  }
  const missing = requiredCols.filter((col) => !table.headers.includes(col));
  if (!missing.length) return;
  table.headers.push(...missing);
  for (const row of table.rows) {
    for (let i = 0; i < missing.length; i += 1) row.push("");
  }
}

function makeRowFromMap(headers: readonly string[], values: Record<string, string>): string[] {
  return headers.map((h) => values[h] ?? "");
}

function colIndex(headers: readonly string[], col: string): number {
  return headers.indexOf(col);
}

function resolveZipKey(files: Record<string, Uint8Array>, target: string): string {
  const lower = target.toLowerCase();
  for (const key of Object.keys(files)) {
    const base = key.split("/").pop()?.toLowerCase() ?? "";
    if (base === lower) return key;
  }
  return target;
}

/** Odczytuje metadane dowolnego źródłowego pliku GTFS `.zip` (okresy, `service_id`, agencje). */
export function inspectGtfsSourceZip(
  zipBytes: Uint8Array,
  label: string,
): GtfsSourceMetadata {
  const files = unzipSync(zipBytes, {
    filter: (f) => !f.name.toLowerCase().endsWith("shapes.txt") && !f.name.toLowerCase().endsWith("stop_times.txt"),
  });
  const readTable = (name: string) => {
    const key = resolveZipKey(files, name);
    return files[key] ? parseCsvTable(strFromU8(files[key])) : { headers: [], rows: [] };
  };

  const agencyTbl = readTable("agency.txt");
  const routesTbl = readTable("routes.txt");
  const stopsTbl = readTable("stops.txt");
  const tripsTbl = readTable("trips.txt");
  const calTbl = readTable("calendar.txt");
  const calDatesTbl = readTable("calendar_dates.txt");
  const feedTbl = readTable("feed_info.txt");

  const agencyIdx = colIndex(agencyTbl.headers, "agency_id");
  const agencyIds = [
    ...new Set(
      agencyTbl.rows
        .map((r) => (agencyIdx >= 0 ? r[agencyIdx]?.trim() : ""))
        .filter(Boolean),
    ),
  ];

  const serviceSet = new Set<string>();
  const addServices = (tbl: CsvTable) => {
    const idx = colIndex(tbl.headers, "service_id");
    if (idx < 0) return;
    for (const r of tbl.rows) {
      const sid = r[idx]?.trim();
      if (sid) serviceSet.add(sid);
    }
  };
  addServices(calTbl);
  addServices(calDatesTbl);
  addServices(tripsTbl);

  const fStartIdx = colIndex(feedTbl.headers, "feed_start_date");
  const fEndIdx = colIndex(feedTbl.headers, "feed_end_date");
  const feedStartDate =
    fStartIdx >= 0 && feedTbl.rows[0]?.[fStartIdx]
      ? feedTbl.rows[0][fStartIdx].trim()
      : "";
  const feedEndDate =
    fEndIdx >= 0 && feedTbl.rows[0]?.[fEndIdx]
      ? feedTbl.rows[0][fEndIdx].trim()
      : "";

  return {
    label,
    fileCount: Object.keys(files).length,
    routeCount: routesTbl.rows.length,
    stopCount: stopsTbl.rows.length,
    tripCount: tripsTbl.rows.length,
    agencyIds,
    serviceIds: [...serviceSet].sort((a, b) => a.localeCompare(b, "pl", { numeric: true })),
    feedStartDate,
    feedEndDate,
  };
}

function hexWithoutHash(color: string, fallback: string): string {
  const clean = color.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(clean) ? clean.toUpperCase() : fallback;
}

/**
 * Łączy wybrane przez Planistę własne linie (oraz opcjonalnie poprawione kształty
 * z Edytora linii) ze źródłową paczką GTFS i pakuje kompletny plik `.zip`.
 */
export function buildMergedGtfsZip(options: GtfsMergeOptions): GtfsMergeResult {
  const warnings: string[] = [];
  const sourceFiles: Record<string, Uint8Array> = options.sourceZipBytes
    ? unzipSync(options.sourceZipBytes)
    : {};

  // Preserve directory prefix if source zip had one (usually root "").
  const routesKey = resolveZipKey(sourceFiles, "routes.txt");
  const prefix = routesKey.includes("/")
    ? routesKey.slice(0, routesKey.lastIndexOf("/") + 1)
    : "";

  const keyFor = (baseName: string): string => {
    const found = resolveZipKey(sourceFiles, baseName);
    return sourceFiles[found] ? found : `${prefix}${baseName}`;
  };

  const readTable = (baseName: string): CsvTable => {
    const k = keyFor(baseName);
    return sourceFiles[k]
      ? parseCsvTable(strFromU8(sourceFiles[k]))
      : { headers: [], rows: [] };
  };

  const agencyTbl = readTable("agency.txt");
  const routesTbl = readTable("routes.txt");
  const stopsTbl = readTable("stops.txt");
  const tripsTbl = readTable("trips.txt");
  const stopTimesTbl = readTable("stop_times.txt");
  const shapesTbl = readTable("shapes.txt");
  const calendarTbl = readTable("calendar.txt");
  const calendarDatesTbl = readTable("calendar_dates.txt");

  // Standalone mode: ensure valid minimal agency.txt
  let defaultAgencyId = "1";
  if (agencyTbl.rows.length === 0) {
    ensureColumns(agencyTbl, [
      "agency_id",
      "agency_name",
      "agency_url",
      "agency_timezone",
      "agency_lang",
    ]);
    agencyTbl.rows.push(
      makeRowFromMap(agencyTbl.headers, {
        agency_id: defaultAgencyId,
        agency_name: "ZDKiUM Wałbrzych (Planer)",
        agency_url: "https://zdkium.walbrzych.pl",
        agency_timezone: "Europe/Warsaw",
        agency_lang: "pl",
      }),
    );
  } else {
    const idx = colIndex(agencyTbl.headers, "agency_id");
    if (idx >= 0 && agencyTbl.rows[0]?.[idx]?.trim()) {
      defaultAgencyId = agencyTbl.rows[0][idx].trim();
    }
  }

  // Ensure necessary columns across all GTFS tables without breaking existing columns
  ensureColumns(routesTbl, [
    "route_id",
    "agency_id",
    "route_short_name",
    "route_long_name",
    "route_type",
    "route_color",
    "route_text_color",
  ]);
  ensureColumns(stopsTbl, [
    "stop_id",
    "stop_name",
    "stop_lat",
    "stop_lon",
    "stop_code",
  ]);
  ensureColumns(tripsTbl, [
    "route_id",
    "service_id",
    "trip_id",
    "trip_headsign",
    "direction_id",
    "block_id",
    "shape_id",
  ]);
  ensureColumns(stopTimesTbl, [
    "trip_id",
    "arrival_time",
    "departure_time",
    "stop_id",
    "stop_sequence",
    "pickup_type",
    "drop_off_type",
  ]);
  ensureColumns(shapesTbl, [
    "shape_id",
    "shape_pt_lat",
    "shape_pt_lon",
    "shape_pt_sequence",
    "shape_dist_traveled",
  ]);

  // Index existing IDs so merges are idempotent and collision-free
  const existingStopIds = new Set<string>();
  const stopIdCol = colIndex(stopsTbl.headers, "stop_id");
  for (const r of stopsTbl.rows) {
    const sid = r[stopIdCol]?.trim();
    if (sid) existingStopIds.add(sid);
  }

  const existingServiceIds = new Set<string>();
  const collectSvcIds = (tbl: CsvTable) => {
    const idx = colIndex(tbl.headers, "service_id");
    if (idx < 0) return;
    for (const r of tbl.rows) {
      const sid = r[idx]?.trim();
      if (sid) existingServiceIds.add(sid);
    }
  };
  collectSvcIds(calendarTbl);
  collectSvcIds(calendarDatesTbl);

  const selectedRouteIds = new Set(
    options.selectedLines.map((l) => sanitizeGtfsId(l.routeId, `CUSTOM_${l.shortName}`)),
  );
  const selectedShapeIds = new Set<string>();
  for (const line of options.selectedLines) {
    for (const v of line.variants) {
      selectedShapeIds.add(
        sanitizeGtfsId(v.shapeId, `CUSTOM_SHAPE_${line.shortName}_${v.directionId}`),
      );
    }
  }

  // Remove any previously exported rows for the exact same custom route_ids / shape_ids
  const routeIdCol = colIndex(routesTbl.headers, "route_id");
  const tripRouteIdCol = colIndex(tripsTbl.headers, "route_id");
  const tripIdCol = colIndex(tripsTbl.headers, "trip_id");
  const stTripIdCol = colIndex(stopTimesTbl.headers, "trip_id");
  const shapeIdCol = colIndex(shapesTbl.headers, "shape_id");

  const replacedTripIds = new Set<string>();
  routesTbl.rows = routesTbl.rows.filter((r) => !selectedRouteIds.has(r[routeIdCol]?.trim()));
  tripsTbl.rows = tripsTbl.rows.filter((r) => {
    if (selectedRouteIds.has(r[tripRouteIdCol]?.trim())) {
      const tid = r[tripIdCol]?.trim();
      if (tid) replacedTripIds.add(tid);
      return false;
    }
    return true;
  });
  if (replacedTripIds.size > 0) {
    stopTimesTbl.rows = stopTimesTbl.rows.filter(
      (r) => !replacedTripIds.has(r[stTripIdCol]?.trim()),
    );
  }
  shapesTbl.rows = shapesTbl.rows.filter((r) => !selectedShapeIds.has(r[shapeIdCol]?.trim()));

  // Track counts
  const includedLines: string[] = [];
  let addedRoutes = 0;
  let addedStops = 0;
  let addedShapes = 0;
  let addedTrips = 0;
  let addedStopTimes = 0;
  let addedServices = 0;
  let updatedOverrideShapes = 0;

  // 1. Append selected custom lines
  for (const line of options.selectedLines) {
    const routeId = sanitizeGtfsId(line.routeId, `CUSTOM_${line.shortName}`);
    const validVariants = line.variants.filter((v) => v.stops.length >= 2);
    if (!validVariants.length) {
      warnings.push(
        `Pominięto linię ${line.shortName}: żaden wariant nie ma co najmniej 2 przystanków.`,
      );
      continue;
    }

    includedLines.push(line.shortName);
    routesTbl.rows.push(
      makeRowFromMap(routesTbl.headers, {
        route_id: routeId,
        agency_id: line.agencyId?.trim() || defaultAgencyId,
        route_short_name: line.shortName,
        route_long_name: line.longName || line.shortName,
        route_type: String(line.routeType ?? 3),
        route_color: hexWithoutHash(line.color, "1D4ED8"),
        route_text_color: hexWithoutHash(line.textColor, "FFFFFF"),
      }),
    );
    addedRoutes += 1;

    const variantMap = new Map<string, { variant: CustomGtfsVariant; shapeId: string }>();

    for (let vIdx = 0; vIdx < validVariants.length; vIdx += 1) {
      const variant = validVariants[vIdx];
      const shapeId = sanitizeGtfsId(
        variant.shapeId,
        `CUSTOM_SHAPE_${line.shortName}_${variant.directionId}_${vIdx}`,
      );
      variantMap.set(variant.id, { variant, shapeId });

      // Append any custom/missing stops to stops.txt
      for (const stop of variant.stops) {
        const cleanStopId = stop.stopId.trim();
        if (!existingStopIds.has(cleanStopId)) {
          existingStopIds.add(cleanStopId);
          stopsTbl.rows.push(
            makeRowFromMap(stopsTbl.headers, {
              stop_id: cleanStopId,
              stop_name: stop.name,
              stop_lat: stop.lat.toFixed(6),
              stop_lon: stop.lon.toFixed(6),
              stop_code: stop.code || "",
              location_type: "0",
            }),
          );
          addedStops += 1;
        }
      }

      // Append shape points to shapes.txt
      const shapePath: LatLng[] =
        variant.path.length >= 2
          ? sanitizePath(variant.path)
          : sanitizePath(variant.stops.map((s): LatLng => [s.lat, s.lon]));
      if (shapePath.length >= 2) {
        const cumDist = cumulativeRouteMeters(shapePath);
        for (let i = 0; i < shapePath.length; i += 1) {
          shapesTbl.rows.push(
            makeRowFromMap(shapesTbl.headers, {
              shape_id: shapeId,
              shape_pt_lat: shapePath[i][0].toFixed(6),
              shape_pt_lon: shapePath[i][1].toFixed(6),
              shape_pt_sequence: String(i + 1),
              shape_dist_traveled: (cumDist[i] ?? 0).toFixed(1),
            }),
          );
        }
        addedShapes += 1;
      }
    }

    // Collect custom service definitions for this line
    const customSvcById = new Map<string, CustomGtfsServiceDef>();
    for (const cs of line.customServices ?? []) {
      customSvcById.set(cs.serviceId.trim(), cs);
    }

    const lineTrips = line.trips.filter((t) => variantMap.has(t.variantId));
    if (!lineTrips.length) {
      warnings.push(
        `Linia ${line.shortName} nie ma zdefiniowanych kursów (dodano tylko definicję trasy i kształty).`,
      );
    }

    for (let tIdx = 0; tIdx < lineTrips.length; tIdx += 1) {
      const trip = lineTrips[tIdx];
      const entry = variantMap.get(trip.variantId)!;
      const { variant, shapeId } = entry;
      const serviceId =
        trip.serviceId.trim() ||
        [...existingServiceIds][0] ||
        `CUSTOM_${sanitizeGtfsId(line.shortName)}_RS`;

      // Ensure serviceId exists in calendar.txt if not already in source feed
      if (!existingServiceIds.has(serviceId)) {
        existingServiceIds.add(serviceId);
        ensureColumns(calendarTbl, [
          "service_id",
          "monday",
          "tuesday",
          "wednesday",
          "thursday",
          "friday",
          "saturday",
          "sunday",
          "start_date",
          "end_date",
        ]);
        const def = customSvcById.get(serviceId);
        const days = def?.days ?? [true, true, true, true, true, false, false];
        calendarTbl.rows.push(
          makeRowFromMap(calendarTbl.headers, {
            service_id: serviceId,
            monday: days[0] ? "1" : "0",
            tuesday: days[1] ? "1" : "0",
            wednesday: days[2] ? "1" : "0",
            thursday: days[3] ? "1" : "0",
            friday: days[4] ? "1" : "0",
            saturday: days[5] ? "1" : "0",
            sunday: days[6] ? "1" : "0",
            start_date: def?.startDate || "20260101",
            end_date: def?.endDate || "20271231",
          }),
        );
        addedServices += 1;
      }

      const tripId = sanitizeGtfsId(
        `${routeId}_${serviceId}_${variant.directionId}_${tIdx + 1}_${trip.departureMinutes}`,
      );
      const headsign =
        variant.headsign ||
        variant.stops[variant.stops.length - 1]?.name ||
        line.shortName;

      tripsTbl.rows.push(
        makeRowFromMap(tripsTbl.headers, {
          route_id: routeId,
          service_id: serviceId,
          trip_id: tripId,
          trip_headsign: headsign,
          trip_short_name: trip.tripShortName || "",
          direction_id: String(variant.directionId),
          block_id: trip.blockId || "",
          shape_id: shapeId,
        }),
      );
      addedTrips += 1;

      for (let sIdx = 0; sIdx < variant.stops.length; sIdx += 1) {
        const stop = variant.stops[sIdx];
        const offset =
          trip.customOffsets && trip.customOffsets[sIdx] !== undefined
            ? trip.customOffsets[sIdx]
            : stop.offsetMinutes;
        const arrMin = trip.departureMinutes + offset;
        const depMin = arrMin + (stop.dwellMinutes ?? 0);

        stopTimesTbl.rows.push(
          makeRowFromMap(stopTimesTbl.headers, {
            trip_id: tripId,
            arrival_time: formatGtfsClockHms(arrMin),
            departure_time: formatGtfsClockHms(depMin),
            stop_id: stop.stopId.trim(),
            stop_sequence: String(sIdx + 1),
            pickup_type: String(stop.pickupType ?? 0),
            drop_off_type: String(stop.dropOffType ?? 0),
          }),
        );
        addedStopTimes += 1;
      }
    }
  }

  // 2. Optional: bake Planner's edited route shapes (LineRouteOverrides) into shapes.txt
  const activeOverrides = options.routeOverrides ?? [];
  if (activeOverrides.length > 0 && options.sourceZipBytes) {
    const routeShortById = new Map<string, string>();
    const rShortCol = colIndex(routesTbl.headers, "route_short_name");
    for (const r of routesTbl.rows) {
      const rid = r[routeIdCol]?.trim();
      const rs = r[rShortCol]?.trim();
      if (rid && rs) routeShortById.set(rid, normalizeLineShort(rs));
    }

    const stopCoordById = new Map<string, { lat: number; lon: number }>();
    const sLatCol = colIndex(stopsTbl.headers, "stop_lat");
    const sLonCol = colIndex(stopsTbl.headers, "stop_lon");
    for (const r of stopsTbl.rows) {
      const sid = r[stopIdCol]?.trim();
      const lat = Number(r[sLatCol]);
      const lon = Number(r[sLonCol]);
      if (sid && Number.isFinite(lat) && Number.isFinite(lon)) {
        stopCoordById.set(sid, { lat, lon });
      }
    }

    const replacements = new Map<string, LatLng[]>();

    // 2a. Direct variant overrides matching existing shape_id
    for (const ovr of activeOverrides) {
      if (isDirectionOverride(ovr) || ovr.path.length < 2) continue;
      replacements.set(ovr.variantKey, sanitizePath(ovr.path));
    }

    // 2b. Direction-wide corridors -> match & slice per existing shape_id of that line!
    const dirOverridesByLine = new Map<string, LineRouteOverride[]>();
    for (const ovr of activeOverrides) {
      if (!isDirectionOverride(ovr) || ovr.path.length < 2) continue;
      const key = normalizeLineShort(ovr.lineShort);
      const list = dirOverridesByLine.get(key);
      if (list) list.push(ovr);
      else dirOverridesByLine.set(key, [ovr]);
    }

    if (dirOverridesByLine.size > 0) {
      const tripShapeCol = colIndex(tripsTbl.headers, "shape_id");
      const stStopCol = colIndex(stopTimesTbl.headers, "stop_id");
      const stSeqCol = colIndex(stopTimesTbl.headers, "stop_sequence");

      // Pick one representative trip per (lineShort, shapeId) for affected lines
      const repTripByShape = new Map<string, { lineShort: string; tripId: string }>();
      for (const tr of tripsTbl.rows) {
        const rid = tr[tripRouteIdCol]?.trim();
        const lineShort = rid ? routeShortById.get(rid) : undefined;
        if (!lineShort || !dirOverridesByLine.has(lineShort)) continue;
        const shId = tr[tripShapeCol]?.trim();
        const tid = tr[tripIdCol]?.trim();
        if (!shId || !tid || replacements.has(shId) || repTripByShape.has(shId)) {
          continue;
        }
        repTripByShape.set(shId, { lineShort, tripId: tid });
      }

      if (repTripByShape.size > 0) {
        const wantedTrips = new Set([...repTripByShape.values()].map((v) => v.tripId));
        const stopsByTrip = new Map<string, Array<{ seq: number; lat: number; lon: number }>>();
        for (const st of stopTimesTbl.rows) {
          const tid = st[stTripIdCol]?.trim();
          if (!tid || !wantedTrips.has(tid)) continue;
          const coord = stopCoordById.get(st[stStopCol]?.trim());
          if (!coord) continue;
          const list = stopsByTrip.get(tid);
          const item = { seq: Number(st[stSeqCol]) || 0, lat: coord.lat, lon: coord.lon };
          if (list) list.push(item);
          else stopsByTrip.set(tid, [item]);
        }

        for (const [shId, info] of repTripByShape) {
          const tripStops = (stopsByTrip.get(info.tripId) ?? []).sort((a, b) => a.seq - b.seq);
          if (tripStops.length < 2) continue;
          const corridors = dirOverridesByLine.get(info.lineShort) ?? [];
          let bestScore = -Infinity;
          let bestPath: LatLng[] | null = null;
          for (const corr of corridors) {
            const { match, path } = sliceCorridorForTrip(corr.path, tripStops);
            if (match.matched && path && path.length >= 2 && match.score > bestScore) {
              bestScore = match.score;
              bestPath = path;
            }
          }
          if (bestPath) {
            replacements.set(shId, bestPath);
          }
        }
      }
    }

    if (replacements.size > 0) {
      const existingShapeIdsInFile = new Set(
        shapesTbl.rows.map((r) => r[shapeIdCol]?.trim()).filter(Boolean),
      );
      const activeReplacements = new Map<string, LatLng[]>();
      for (const [shId, path] of replacements) {
        if (existingShapeIdsInFile.has(shId)) {
          activeReplacements.set(shId, path);
        }
      }
      if (activeReplacements.size > 0) {
        shapesTbl.rows = shapesTbl.rows.filter(
          (r) => !activeReplacements.has(r[shapeIdCol]?.trim()),
        );
        for (const [shId, path] of activeReplacements) {
          const cum = cumulativeRouteMeters(path);
          for (let i = 0; i < path.length; i += 1) {
            shapesTbl.rows.push(
              makeRowFromMap(shapesTbl.headers, {
                shape_id: shId,
                shape_pt_lat: path[i][0].toFixed(6),
                shape_pt_lon: path[i][1].toFixed(6),
                shape_pt_sequence: String(i + 1),
                shape_dist_traveled: (cum[i] ?? 0).toFixed(1),
              }),
            );
          }
          updatedOverrideShapes += 1;
        }
      }
    }
  }

  // 3. Serialize modified tables back into ZIP file map
  const outFiles: Record<string, Uint8Array> = { ...sourceFiles };
  outFiles[keyFor("agency.txt")] = strToU8(serializeCsvTable(agencyTbl));
  outFiles[keyFor("routes.txt")] = strToU8(serializeCsvTable(routesTbl));
  outFiles[keyFor("stops.txt")] = strToU8(serializeCsvTable(stopsTbl));
  outFiles[keyFor("trips.txt")] = strToU8(serializeCsvTable(tripsTbl));
  outFiles[keyFor("stop_times.txt")] = strToU8(serializeCsvTable(stopTimesTbl));
  outFiles[keyFor("shapes.txt")] = strToU8(serializeCsvTable(shapesTbl));
  if (calendarTbl.rows.length > 0) {
    outFiles[keyFor("calendar.txt")] = strToU8(serializeCsvTable(calendarTbl));
  }

  const zipBytes = zipSync(outFiles, { level: 6 });
  return {
    zipBytes,
    summary: {
      includedLines,
      addedRoutes,
      addedStops,
      addedShapes,
      addedTrips,
      addedStopTimes,
      addedServices,
      updatedOverrideShapes,
      totalFilesInZip: Object.keys(outFiles).length,
      zipSizeBytes: zipBytes.byteLength,
    },
    warnings,
  };
}

/* ── Automatyczny generator czasów przejazdu między przystankami ────────── */

export interface EstimateStopTimesOptions {
  /** Prędkość jazdy między przystankami w km/h (np. 18 centrum, 22 miejska, 28 podmiejska). */
  averageSpeedKmh?: number;
  /** Dodatkowy czas obsługi przystanku (hamowanie, drzwi, wymiana pasażerów, ruszenie) w sekundach. */
  stopPenaltySeconds?: number;
  /** Współczynnik wydłużenia trasy po ulicach względem linii prostej, gdy brak narysowanej polilinii. */
  straightLineDetourFactor?: number;
}

export interface EstimatedStopTimesResult {
  stops: CustomGtfsStop[];
  segmentMeters: number[];
  totalMeters: number;
  totalMinutes: number;
  usedRoutePath: boolean;
  effectiveCommercialSpeedKmh: number;
}

/**
 * Rzutuje punkt na polilinię od zadanego indeksu odcinka w przód (monotonicznie),
 * zwracając dystans wzdłuż ścieżki oraz odległość boczną od trasy.
 */
function projectStopAlongPathMonotonic(
  path: readonly LatLng[],
  cumMeters: readonly number[],
  stop: { lat: number; lon: number },
  minSegmentIndex: number,
): { segIndex: number; alongMeters: number; offsetMeters: number } | null {
  if (path.length < 2) return null;
  let bestSeg = -1;
  let bestAlong = 0;
  let bestDist = Infinity;

  const start = Math.max(0, Math.min(minSegmentIndex, path.length - 2));
  for (let i = start; i < path.length - 1; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    const res = pointToSegmentMeters(stop.lat, stop.lon, a[0], a[1], b[0], b[1]);
    if (res.distance < bestDist) {
      bestDist = res.distance;
      bestSeg = i;
      const segLen = Math.max(0, (cumMeters[i + 1] ?? 0) - (cumMeters[i] ?? 0));
      bestAlong = (cumMeters[i] ?? 0) + res.t * segLen;
    }
  }
  if (bestSeg < 0) return null;
  return { segIndex: bestSeg, alongMeters: bestAlong, offsetMeters: bestDist };
}

/**
 * Automatycznie szacuje czasy przejazdu (`offsetMinutes`) między kolejnymi przystankami
 * wariantu na podstawie długości odcinków wzdłuż narysowanej / OSRM trasy (albo odległości
 * drogowej szacowanej z współrzędnych przystanków) oraz zadanej prędkości i czasu obsługi przystanku.
 */
export function estimateVariantStopTimes(
  variant: Pick<CustomGtfsVariant, "stops" | "path">,
  options: EstimateStopTimesOptions = {},
): EstimatedStopTimesResult {
  const stops = variant.stops;
  const speedKmh = Math.max(5, Math.min(90, options.averageSpeedKmh ?? 22));
  const stopPenaltySec = Math.max(0, Math.min(300, options.stopPenaltySeconds ?? 25));
  const detourFactor = Math.max(1, Math.min(2, options.straightLineDetourFactor ?? 1.22));

  if (stops.length === 0) {
    return {
      stops: [],
      segmentMeters: [],
      totalMeters: 0,
      totalMinutes: 0,
      usedRoutePath: false,
      effectiveCommercialSpeedKmh: 0,
    };
  }
  if (stops.length === 1) {
    return {
      stops: [{ ...stops[0], offsetMinutes: 0 }],
      segmentMeters: [],
      totalMeters: 0,
      totalMinutes: 0,
      usedRoutePath: false,
      effectiveCommercialSpeedKmh: 0,
    };
  }

  const cleanPath = sanitizePath(variant.path);
  const hasPath = cleanPath.length >= 2;
  const cumPath = hasPath ? cumulativeRouteMeters(cleanPath) : [];

  // Rzutujemy przystanki wzdłuż trasy (jeśli trasa istnieje i przystanki leżą blisko niej <= 450 m).
  const projections: Array<number | null> = [];
  let searchFromSeg = 0;
  let projectedCount = 0;
  if (hasPath) {
    for (const stop of stops) {
      const proj = projectStopAlongPathMonotonic(
        cleanPath,
        cumPath,
        stop,
        searchFromSeg,
      );
      if (proj && proj.offsetMeters <= 450) {
        projections.push(proj.alongMeters);
        searchFromSeg = proj.segIndex;
        projectedCount += 1;
      } else {
        projections.push(null);
      }
    }
  }

  const speedMps = (speedKmh * 1000) / 3600;
  const segmentMeters: number[] = [];
  let usedRoutePath = false;
  let totalMeters = 0;
  let cumulativeSec = 0;

  const updated: CustomGtfsStop[] = [{ ...stops[0], offsetMinutes: 0 }];

  for (let i = 1; i < stops.length; i += 1) {
    const prev = stops[i - 1];
    const curr = stops[i];

    const straightMeters = distanceCoords(prev.lat, prev.lon, curr.lat, curr.lon);
    let segMeters = straightMeters * detourFactor;

    const pPrev = projections[i - 1];
    const pCurr = projections[i];
    if (
      pPrev !== null &&
      pPrev !== undefined &&
      pCurr !== null &&
      pCurr !== undefined &&
      pCurr > pPrev + 5
    ) {
      segMeters = pCurr - pPrev;
      usedRoutePath = true;
    }

    segmentMeters.push(Math.round(segMeters));
    totalMeters += segMeters;

    const prevDwellSec = Math.max(0, prev.dwellMinutes ?? 0) * 60;
    const legSec = segMeters / speedMps + stopPenaltySec + prevDwellSec;
    cumulativeSec += legSec;

    const prevOffset = updated[i - 1].offsetMinutes;
    let nextOffset = Math.round(cumulativeSec / 60);
    // Dwa wyraźnie oddalone przystanki (> 180 m) nie powinny mieć dokładnie tej samej minuty,
    // jeśli łączny czas odcinka przekroczył już 30 s od poprzedniego zaokrąglenia.
    if (nextOffset <= prevOffset && segMeters >= 180 && cumulativeSec >= prevOffset * 60 + 30) {
      nextOffset = prevOffset + 1;
    }
    if (nextOffset < prevOffset) nextOffset = prevOffset;

    updated.push({
      ...curr,
      offsetMinutes: nextOffset,
    });
  }

  const totalMinutes = updated[updated.length - 1]?.offsetMinutes ?? 0;
  const effectiveCommercialSpeedKmh =
    totalMinutes > 0 && totalMeters > 0
      ? Number(((totalMeters / 1000) / (totalMinutes / 60)).toFixed(1))
      : 0;

  return {
    stops: updated,
    segmentMeters,
    totalMeters: Math.round(totalMeters),
    totalMinutes,
    usedRoutePath: usedRoutePath && projectedCount >= 2,
    effectiveCommercialSpeedKmh,
  };
}

/* ── Walidacja własnych linii przed eksportem lub podglądem GTFS ────────── */

export interface CustomGtfsValidationReport {
  errors: string[];
  warnings: string[];
}

export function validateCustomGtfsLines(
  lines: readonly CustomGtfsLine[],
  knownServiceIds: readonly string[] = [],
): CustomGtfsValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const knownServices = new Set(knownServiceIds);

  for (const line of lines) {
    const label = line.shortName.trim() || "(bez numeru)";
    if (!line.shortName.trim()) {
      errors.push(`Linia „${line.longName || line.id}” nie ma wpisanego numeru (route_short_name).`);
    }
    if (!line.variants.length) {
      errors.push(`Linia ${label}: dodaj co najmniej jeden wariant kierunku.`);
      continue;
    }

    const lineCustomServices = new Set(
      (line.customServices ?? []).map((s) => s.serviceId),
    );

    for (const variant of line.variants) {
      if (variant.stops.length < 2) {
        errors.push(
          `Linia ${label} (${variant.name}): wariant musi mieć co najmniej 2 przystanki.`,
        );
        continue;
      }

      if (variant.path.length < 2) {
        warnings.push(
          `Linia ${label} (${variant.name}): brak narysowanej trasy — eksport użyje linii prostej między przystankami.`,
        );
      }

      for (let i = 1; i < variant.stops.length; i += 1) {
        const prev = variant.stops[i - 1];
        const curr = variant.stops[i];
        if (curr.offsetMinutes < prev.offsetMinutes) {
          errors.push(
            `Linia ${label} (${variant.name}): czas na przystanku „${curr.name}” (${curr.offsetMinutes} min) jest wcześniejszy niż na „${prev.name}” (${prev.offsetMinutes} min).`,
          );
          break;
        }
        const deltaMin = curr.offsetMinutes - prev.offsetMinutes;
        if (deltaMin > 0) {
          const distKm = distanceCoords(prev.lat, prev.lon, curr.lat, curr.lon) / 1000;
          const speedKmh = distKm / (deltaMin / 60);
          if (speedKmh > 85) {
            warnings.push(
              `Linia ${label} (${variant.name}): nierealistyczna prędkość ~${Math.round(speedKmh)} km/h między „${prev.name}” a „${curr.name}” — użyj „Wylicz czasy (auto)”.`,
            );
            break;
          }
        }
      }
    }

    if (line.trips.length === 0) {
      warnings.push(
        `Linia ${label}: brak zaplanowanych odjazdów (w zakładce „3. Rozkład i czasy” dodaj kursy, inaczej linia nie pojawi się w tablicach przystankowych).`,
      );
    } else if (knownServices.size > 0) {
      const missingServices = new Set<string>();
      for (const trip of line.trips) {
        if (
          !knownServices.has(trip.serviceId) &&
          !lineCustomServices.has(trip.serviceId)
        ) {
          missingServices.add(trip.serviceId);
        }
      }
      if (missingServices.size > 0) {
        warnings.push(
          `Linia ${label}: kalendarz ${[...missingServices].join(", ")} nie istnieje w źródłowym GTFS (zostanie dopisany domyślnie na wszystkie dni).`,
        );
      }
    }
  }

  return { errors, warnings };
}

