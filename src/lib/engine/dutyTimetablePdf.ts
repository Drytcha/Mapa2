import { jsPDF } from "jspdf";
import { DateTime } from "luxon";
import { summariseBrigade } from "../brigadeMetrics";
import { distanceCoords } from "../core/spatial";
import { isTechnicalRoute } from "../core/text";
import {
  legendCodeForTrip,
  legendLineLabel,
  legendLines,
  legendText,
  lineLegend,
} from "../lineLegend";
import type { WalbrzychOperatorKey } from "../types";
import { BRIGADE_ZONE, describeServiceIds, loadBrigades, loadBrigadeTrips, type BrigadeItem, type BrigadeTripView } from "./brigades";
import { ensureGtfsSeeded, type GtfsLineItem, type GtfsStopTimeRecord } from "./gtfsStore";
import { OPERATOR_NAMES } from "./fleetOperators";

export type TimetableExportScope =
  | { kind: "duty"; blockId: string }
  | { kind: "line"; line: string }
  | { kind: "company"; company: WalbrzychOperatorKey };

export interface TimetablePdfTrip {
  trip: BrigadeTripView;
  stops: Array<{ name: string; arrival: number; departure: number; stopHeadsign?: string }>;
}
export interface TimetablePdfDuty {
  item: BrigadeItem;
  trips: TimetablePdfTrip[];
}
export interface TimetablePdfData {
  dateId: string;
  feedFrom: number;
  feedTo: number;
  serviceLabel: string;
  scopeLabel: string;
  duties: TimetablePdfDuty[];
  notice?: string;
}

/** Select full duties for a line; unassigned trips are restricted to that line. */
export function selectTimetableDuties(items: BrigadeItem[], scope: TimetableExportScope): BrigadeItem[] {
  if (scope.kind === "duty") return items.filter((item) => item.blockId === scope.blockId);
  if (scope.kind === "company") return items.filter((item) => item.operatorKey === scope.company);
  const line = scope.line.trim().toUpperCase();
  return items.flatMap((item) => {
    if (!item.unassigned) return item.lineIds.some((id) => id.toUpperCase() === line) || item.primaryLine.toUpperCase() === line ? [item] : [];
    const trips = item.trips.filter((trip) => trip.lineId.toUpperCase() === line);
    return trips.length ? [{ ...item, trips, tripCount: trips.length, lineIds: [line] }] : [];
  });
}

export async function collectTimetablePdfData(routes: GtfsLineItem[], dateId: string, scope: TimetableExportScope): Promise<TimetablePdfData> {
  // Always load the complete day's catalogue: company exports must not inherit
  // the current line/search filters, and line exports need full multi-line duties.
  const result = await loadBrigades(routes, "all", dateId);
  if (result.error) throw new Error(result.error);
  const chosen = selectTimetableDuties(result.items, scope);
  if (!chosen.length) throw new Error("Brak kursów dla wybranego zakresu i dnia.");
  const store = await ensureGtfsSeeded();
  const duties: TimetablePdfDuty[] = [];
  for (const item of chosen) {
    const trips = await loadBrigadeTrips(item);
    if (!trips.length || trips.length < item.tripCount) throw new Error(`Niepełna lista kursów: ${item.number || "bez kursówki"}.`);
    const rows: TimetablePdfTrip[] = [];
    for (const trip of [...trips].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))) {
      const times: GtfsStopTimeRecord[] | undefined = store.base.rawStopTimesByTrip.get(trip.id);
      if (!times?.length) throw new Error(`Brak przystanków GTFS dla kursu ${trip.id}. Nie można przygotować kompletnego PDF.`);
      const stops = times.map((time) => {
        const name = store.base.stopsById.get(time.stopId)?.name ?? store.base.stopNamesById.get(time.stopId);
        if (!name) throw new Error(`Brak przystanku ${time.stopId} w kursie ${trip.id}.`);
        return { name, arrival: time.arrivalMinutes, departure: time.departureMinutes, stopHeadsign: time.stopHeadsign };
      });
      rows.push({ trip, stops });
    }
    duties.push({ item, trips: rows });
  }
  const scopeLabel = scope.kind === "line" ? `Linia ${scope.line}` : scope.kind === "company" ? `Firma: ${OPERATOR_NAMES[scope.company]}` : `Kursówka: ${chosen[0].number.replace(/-([0-9]+)$/, "/$1") || "nieprzypisana"}`;
  return { dateId, feedFrom: result.feedFrom, feedTo: result.feedTo, serviceLabel: result.serviceLabel || describeServiceIds(result.serviceIds ?? []), scopeLabel, duties, notice: result.notice };
}

function clock(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return "—";
  const n = Math.round(minutes);
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}
function duration(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(Math.round(minutes % 60)).padStart(2, "0")}`;
}
function formatDate(id: number | string): string {
  const s = String(id);
  return /^\d{8}$/.test(s) ? `${s.slice(6, 8)}.${s.slice(4, 6)}.${s.slice(0, 4)}` : "brak danych";
}

/** Four representative stops, evenly spread along the route. They are not
 * claimed to be the operator's official timing points. */
export function selectTimetableCheckpoints(stops: TimetablePdfTrip["stops"]): TimetablePdfTrip["stops"] {
  const middle = stops.slice(1, -1);
  if (middle.length <= 4) return middle;
  return Array.from({ length: 4 }, (_, index) => middle[Math.round(index * (middle.length - 1) / 3)]);
}

/** Unassigned runs are not a duty. Split that potentially huge collection into
 * labelled sheets instead of making an illegibly tiny pseudo-duty. */
export function timetablePdfSheets(duties: TimetablePdfDuty[]): Array<{ duty: TimetablePdfDuty; part: number; parts: number }> {
  return duties.flatMap((duty) => {
    const parts = duty.item.unassigned ? Math.max(1, Math.ceil(duty.trips.length / 32)) : 1;
    return Array.from({ length: parts }, (_, index) => ({
      duty: parts === 1 ? duty : { ...duty, trips: duty.trips.slice(index * 32, (index + 1) * 32) },
      part: index + 1, parts,
    }));
  });
}

/**
 * Ile linijek stopki rezerwuje legenda na wydruku. Stała wartość = stała
 * geometria wierszy tabeli (testy i podgląd zależą od tego układu).
 */
export const TIMETABLE_LEGEND_RESERVED_LINES = 3;

const TECHNICAL_CODES = ["WY", "PRZ", "ZJ"];
const isTechnicalLine = (lineId: string) =>
  TECHNICAL_CODES.includes(lineId.trim().toUpperCase());

/** „zjazd” w kierunku lub w opisie przystanku — nie osobny kurs techniczny. */
const mentionsZjazd = (value: string | undefined) =>
  /(?:^|[^\p{L}\p{N}])zjazd(?=$|[^\p{L}\p{N}])/iu.test(value ?? "");

/**
 * Czy kurs pasażerski kończy się zjazdem do zajezdni.
 *
 * Taki zjazd NIE jest dopisywany do numeru linii (żadnego „C/ZJ*”). Kurs
 * dostaje samą linię, a zjazd jest zawsze osobnym wierszem `ZJ`.
 */
export function tripEndsInZjazd(row: TimetablePdfTrip): boolean {
  if (isTechnicalLine(row.trip.lineId)) return false;
  return (
    mentionsZjazd(row.trip.destination) ||
    row.stops.some((stop) => mentionsZjazd(stop.stopHeadsign))
  );
}

/**
 * Litera oficjalnego wariantu kursu (legenda linii, np. `b` na linii 2).
 * Kurs bez litery jest kursem podstawowym.
 */
export function timetableVariantCode(row: TimetablePdfTrip): string {
  if (isTechnicalLine(row.trip.lineId)) return "";
  return legendCodeForTrip(row.trip.lineId, {
    destination: row.trip.destination,
    stops: row.stops.map((stop) => stop.name),
  });
}

/** Numer linii na wydruku: sama linia (bez „/ZJ*”), plus litera wariantu. */
export function timetableLineLabel(row: TimetablePdfTrip): string {
  return legendLineLabel(row.trip.lineId, timetableVariantCode(row));
}

/** Warianty użyte w kursówce — do legendy na wydruku (kolejność oficjalna). */
export function timetableLegendRows(
  duty: TimetablePdfDuty,
): Array<{ line: string; code: string; text: string }> {
  const seen = new Set<string>();
  const rows: Array<{ line: string; code: string; text: string }> = [];
  for (const row of duty.trips) {
    const line = row.trip.lineId.trim();
    if (isTechnicalLine(line)) continue;
    const code = timetableVariantCode(row);
    if (!code) continue;
    const key = `${line.toUpperCase()}|${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ line, code, text: legendText(line, code) });
  }
  const known = legendLines();
  const lineOrder = (line: string) => {
    const index = known.indexOf(line.trim().toUpperCase());
    return index === -1 ? known.length : index;
  };
  const codeOrder = (line: string, code: string) => {
    const index = (lineLegend(line) ?? []).findIndex((entry) => entry.code === code);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return rows.sort(
    (a, b) =>
      lineOrder(a.line) - lineOrder(b.line) ||
      codeOrder(a.line, a.code) - codeOrder(b.line, b.code) ||
      a.code.localeCompare(b.code, "pl"),
  );
}

/**
 * Pełna oficjalna legenda linii, które występują w kursówce — nie tylko litery
 * użyte w tym dniu. Kierowca podmieniający kurs ma wtedy pod ręką znaczenie
 * każdej litery, a nie tylko tych, które wypadły w jego rozkładzie.
 */
export function timetableFullLegendRows(
  duty: TimetablePdfDuty,
): Array<{ line: string; code: string; text: string }> {
  const seenLines = new Set<string>();
  const rows: Array<{ line: string; code: string; text: string }> = [];
  const known = legendLines();
  const lineOrder = (line: string) => {
    const index = known.indexOf(line.trim().toUpperCase());
    return index === -1 ? known.length : index;
  };
  for (const row of duty.trips) {
    const line = row.trip.lineId.trim();
    if (isTechnicalLine(line)) continue;
    const key = line.toUpperCase();
    if (seenLines.has(key)) continue;
    seenLines.add(key);
    for (const entry of lineLegend(line) ?? []) {
      rows.push({ line, code: entry.code, text: entry.text });
    }
  }
  // Stabilne sortowanie tylko po linii — litery zostają w kolejności oficjalnej.
  return rows.sort((a, b) => lineOrder(a.line) - lineOrder(b.line));
}

const formatLegend = (entries: Array<{ line: string; code: string; text: string }>) => {
  const grouped = new Map<string, string[]>();
  for (const entry of entries) {
    const items = grouped.get(entry.line) ?? [];
    items.push(`${entry.code} – ${entry.text}`);
    grouped.set(entry.line, items);
  }
  return [...grouped.entries()]
    .map(([line, items]) => `${line}: ${items.join(", ")}`)
    .join(" · ");
};

/** Jednolinijkowy opis legendy wariantów użytych w kursówce. */
export function timetableLegendText(duty: TimetablePdfDuty): string {
  const entries = timetableLegendRows(duty);
  if (!entries.length) return "";
  return `Legenda wariantów: ${formatLegend(entries)}`;
}

/**
 * Legenda do wydruku: pełna oficjalna rozpiska linii z kursówki.
 *
 * Druk próbuje najpierw tej wersji (każda litera linii, także te niewystępujące
 * w danym dniu), a gdy zabraknie miejsca na stopce — skraca się do wariantów
 * faktycznie użytych w kursówce.
 */
export function timetablePrintLegendText(duty: TimetablePdfDuty): string {
  const entries = timetableFullLegendRows(duty);
  if (!entries.length) return "";
  return `Legenda wariantów: ${formatLegend(entries)}`;
}

/** Missing codes are a warning, not proof that each run should exist. */
export function technicalTripsNote(duty: TimetablePdfDuty): string {
  const codes = new Set(duty.trips.map(({ trip }) => trip.lineId.trim().toUpperCase()));
  const missing = ["WY", "PRZ", "ZJ"].filter((code) => !codes.has(code));
  return missing.length
    ? `Brak osobnych przejazdów technicznych w danych: ${missing.join(", ")}. Sprawdź kompletność.`
    : "WY/PRZ/ZJ według dostępnych danych; nie dopisano brakujących przejazdów.";
}

export type TimetableDisplayRow =
  | { kind: "scheduled"; row: TimetablePdfTrip }
  | { kind: "inferred"; code: "WY" | "PRZ" | "ZJ"; from: string; to: string };

/**
 * Apply the planner's rules only to assigned duties. Inferred rows have no
 * scheduled times or operator-specific depot: they are candidates to verify,
 * not GTFS trips. Real technical trips are never replaced or duplicated.
 *
 * Zjazd jest ZAWSZE osobnym wierszem `ZJ` — nigdy dopiskiem do numeru linii.
 * Wiersz nie powstaje, gdy kurs i tak zaczyna się albo kończy na zajezdni.
 */
export function timetableDisplayRows(duty: TimetablePdfDuty): { rows: TimetableDisplayRow[]; missingCoordinates: boolean } {
  const trips = duty.trips;
  if (duty.item.unassigned || !trips.length) {
    return { rows: trips.map((row) => ({ kind: "scheduled", row })), missingCoordinates: false };
  }
  const rows: TimetableDisplayRow[] = [];
  let missingCoordinates = false;
  const isDepot = (name: string) => /^zajezdnia$/iu.test(name.trim());
  const firstStopName = (row: TimetablePdfTrip) => row.stops[0]?.name ?? row.trip.firstStop.name;
  const lastStopName = (row: TimetablePdfTrip) => row.stops.at(-1)?.name ?? row.trip.lastStop.name;
  const lineOf = (row: TimetablePdfTrip) => row.trip.lineId.trim().toUpperCase();
  const wy = (next: TimetablePdfTrip) => {
    const name = firstStopName(next);
    // Kurs już zaczyna się na zajezdni: nie ma osobnego wyjazdu do dopisania.
    if (isDepot(name)) return;
    rows.push({ kind: "inferred", code: "WY", from: "Zajezdnia", to: name });
  };
  const zj = (prev: TimetablePdfTrip) => {
    const name = lastStopName(prev);
    // Kurs kończy się na zajezdni: zjazd jest już w rozkładzie kursu.
    if (isDepot(name)) return;
    rows.push({ kind: "inferred", code: "ZJ", from: name, to: "Zajezdnia" });
  };
  if (lineOf(trips[0]) !== "WY") wy(trips[0]);
  for (let i = 0; i < trips.length; i++) {
    const current = trips[i];
    if (i > 0) {
      const prev = trips[i - 1];
      const gap = current.trip.startMs - prev.trip.endMs;
      if (gap > 2 * 60 * 60_000) {
        if (lineOf(prev) !== "ZJ") zj(prev);
        if (lineOf(current) !== "WY") wy(current);
      } else if (!isTechnicalRoute(prev.trip.lineId) && !isTechnicalRoute(current.trip.lineId)) {
        const a = prev.trip.lastStop, b = current.trip.firstStop;
        if (!a.id || !b.id || a.id !== b.id) {
          if ([a.lat, a.lon, b.lat, b.lon].every((v) => typeof v === "number" && Number.isFinite(v))) {
            if (distanceCoords(a.lat!, a.lon!, b.lat!, b.lon!) > 400) {
              rows.push({ kind: "inferred", code: "PRZ", from: a.name, to: b.name });
            }
          } else {
            missingCoordinates = true;
          }
        }
      }
    }
    rows.push({ kind: "scheduled", row: current });
    // Kurs pasażerski z „zjazdem” w kierunku: zjazd jako osobny wiersz,
    // bez zmiany numeru linii.
    if (tripEndsInZjazd(current)) zj(current);
  }
  const last = trips[trips.length - 1];
  if (lineOf(last) !== "ZJ" && !tripEndsInZjazd(last)) zj(last);
  return { rows, missingCoordinates };
}

/** Exactly one A4 sheet per assigned duty and exactly one table row per trip. */
export async function createTimetablePdf(data: TimetablePdfData): Promise<jsPDF> {
  if (!data.duties.length) throw new Error("Brak kursówek do wydrukowania.");
  const { LATO_REGULAR_TTF } = await import("../latoFont");
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true, putOnlyUsedFonts: true });
  doc.addFileToVFS("Lato-Regular.ttf", LATO_REGULAR_TTF);
  doc.addFont("Lato-Regular.ttf", "Lato", "normal");
  doc.setFont("Lato", "normal");
  doc.setProperties({
    title: `Rozkład służb — ${data.scopeLabel} — ${formatDate(data.dateId)}`,
    subject: "Rozkład na wybrany dzień na podstawie GTFS",
    creator: "Mapa2",
    ...(data.notice ? { keywords: data.notice } : {}),
  });
  const margin = 6;
  const pageW = doc.internal.pageSize.getWidth(), pageH = doc.internal.pageSize.getHeight();
  const tableW = pageW - 2 * margin;
  const widths = [10, 13, 40, 11, 29, 11, 29, 11, 29, 11, 29, 46, 14];
  const scale = tableW / widths.reduce((sum, width) => sum + width, 0);
  const ws = widths.map((width) => width * scale);
  const xs = [margin];
  for (const width of ws) xs.push(xs[xs.length - 1] + width);
  const date = DateTime.fromFormat(data.dateId, "yyyyLLdd", { zone: BRIGADE_ZONE }).setLocale("pl");
  const dateLabel = date.isValid ? date.toFormat("cccc, dd.MM.yyyy") : formatDate(data.dateId);
  const sheets = timetablePdfSheets(data.duties);

  // Horizontal scaling preserves the full stop name without wrapping into a
  // second row or silently cutting it off. Long names remain selectable text.
  const fitText = (value: string, x: number, y: number, width: number, size: number) => {
    if (!value) return;
    doc.setFontSize(size);
    const clean = value.replace(/\s+/g, " ").trim();
    const measured = doc.getTextWidth(clean);
    doc.text(clean, x, y, { horizontalScale: measured > width ? width / measured : 1 });
  };
  const cell = (value: string, x: number, y: number, width: number, height: number, size: number, shade = false) => {
    if (shade) { doc.setFillColor(242, 242, 242); doc.rect(x, y, width, height, "F"); }
    doc.setDrawColor(160); doc.setLineWidth(0.12); doc.rect(x, y, width, height);
    // Baseline centred within the available height, even for densely packed duties.
    fitText(value, x + 0.7, y + height / 2 + size * 0.11, Math.max(0.1, width - 1.4), size);
  };

  // Legenda wariantów na dole strony (maks. 3 linijki, patrz TIMETABLE_LEGEND_RESERVED_LINES).
  const legendFooter = (duty: TimetablePdfDuty, width: number) => {
    // Kursówka bez ani jednego wariantu nie potrzebuje legendy — stopka nie
    // zabiera wtedy miejsca tabeli.
    if (!timetableLegendRows(duty).length) return { lines: [] as string[], size: 6 };
    // Najpierw pełna legenda linii z kursówki (do 3 linijek), potem tylko
    // warianty użyte w tym dniu.
    const candidates = [
      { text: timetablePrintLegendText(duty), maxLines: 3 },
      { text: timetableLegendText(duty), maxLines: 3 },
    ].filter((candidate) => candidate.text);
    for (const candidate of candidates) {
      for (const size of [6, 5.6, 5.2, 4.8]) {
        doc.setFontSize(size);
        const lines = doc.splitTextToSize(candidate.text, width) as string[];
        if (lines.length <= Math.min(candidate.maxLines, TIMETABLE_LEGEND_RESERVED_LINES)) {
          return { lines, size };
        }
      }
    }
    if (!candidates.length) return { lines: [] as string[], size: 6 };
    doc.setFontSize(4.8);
    const lines = (doc.splitTextToSize(candidates.at(-1)!.text, width) as string[]).slice(
      0,
      TIMETABLE_LEGEND_RESERVED_LINES,
    );
    lines[lines.length - 1] = `${lines[lines.length - 1]}…`;
    return { lines, size: 4.8 };
  };

  sheets.forEach(({ duty, part, parts }, index) => {
    if (index) doc.addPage();
    const number = duty.item.unassigned ? `Bez przypisanej kursówki${parts > 1 ? ` (${part}/${parts})` : ""}` : duty.item.number.replace(/-([0-9]+)$/, "/$1");
    // Two compact metadata lines above a labelled summary, keeping the duty
    // identifier prominent and the service day separate from the date.
    fitText("MAPA2 / ROZKŁAD KURSÓW", margin, 8, 160, 8);
    fitText(`Dzień: ${dateLabel}`, margin + 180, 8, tableW - 180 - (data.notice ? 6 : 0), 8);
    fitText(`Ważność GTFS: ${formatDate(data.feedFrom)} – ${formatDate(data.feedTo)}`, margin, 12, 145, 7);
    fitText(`Zakres: ${data.scopeLabel}`, margin + 148, 12, tableW - 148, 7);
    const metrics = summariseBrigade(duty.trips.map((row) => row.trip));
    const km = metrics.missingLengthTrips ? `Niepełne dane (${metrics.missingLengthTrips} kurs.)` : `${(metrics.totalMeters / 1000).toLocaleString("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
    const boxes = [
      { label: "KURSÓWKA", value: number },
      { label: "RODZAJ DNIA", value: data.serviceLabel || "Według GTFS" },
      { label: "FIRMA", value: duty.item.operatorName },
      { label: "ROZPIĘTOŚĆ / PRACA SZAC.", value: duty.item.unassigned ? "Nie dotyczy" : `${duration(metrics.durationMinutes)} / ${duration(metrics.workBlockMinutes)}` },
      { label: "PRZERWY > 90 MIN", value: duty.item.unassigned ? "Nie dotyczy" : duration(metrics.splitBreakMinutes) },
      { label: "DŁUGOŚĆ KURSÓW", value: km },
    ];
    const boxWidths = [34, 52, 59, 57, 39, tableW - 241];
    let bx = margin;
    boxes.forEach(({ label, value }, i) => {
      const width = boxWidths[i];
      doc.setDrawColor(160); doc.setLineWidth(0.12); doc.rect(bx, 15, width, 9);
      fitText(label, bx + 0.8, 18.1, width - 1.6, 6);
      fitText(value, bx + 0.8, 22.3, width - 1.6, i === 0 ? 9.5 : 8);
      bx += width;
    });

    const headerY = 26, headerH = 5;
    cell("Linia", xs[0], headerY, ws[0], headerH, 7, true);
    cell("Godz.", xs[1], headerY, ws[1], headerH, 7, true);
    cell("Początek", xs[2], headerY, ws[2], headerH, 7, true);
    cell("Wybrane przystanki pośrednie · godzina odjazdu", xs[3], headerY, xs[11] - xs[3], headerH, 7, true);
    cell("Koniec", xs[11], headerY, ws[11], headerH, 7, true);
    cell("Przyj.", xs[12], headerY, ws[12], headerH, 7, true);
    const display = timetableDisplayRows(duty);
    const bodyTop = headerY + headerH;
    const legend = legendFooter(duty, tableW - 24);
    // Wysokość stopki jest stała, gdy legenda istnieje — tabela zawsze kończy
    // się w tym samym miejscu, niezależnie od tego, ile wariantów ma linia.
    const legendReserve = legend.lines.length ? TIMETABLE_LEGEND_RESERVED_LINES : 0;
    const bodyBottom = pageH - 18 - Math.max(0, legendReserve - 1) * 3.6;
    const rowHeight = Math.min(5, (bodyBottom - bodyTop) / Math.max(1, display.rows.length));
    const fontSize = Math.min(7.5, rowHeight * 1.55);
    let y = bodyTop;
    for (const [rowIndex, displayRow] of display.rows.entries()) {
      // Header is the first shaded row: the first course is white, the
      // second grey, and the pattern restarts on each duty sheet.
      if (rowIndex % 2 === 1) {
        doc.setFillColor(242, 242, 242);
        doc.rect(margin, y, tableW, rowHeight, "F");
      }
      let values: string[];
      if (displayRow.kind === "inferred") {
        values = [`${displayRow.code}~`, "—", displayRow.from, "", "", "", "", "", "", "", "", displayRow.to, "—"];
      } else {
        const { row } = displayRow;
        const { trip, stops } = row;
        if (!stops.length) throw new Error(`Brak przystanków dla kursu ${trip.id}.`);
        const intermediate = selectTimetableCheckpoints(stops);
        values = [timetableLineLabel(row), clock(stops[0].departure), stops[0].name];
        for (let i = 0; i < 4; i++) values.push(intermediate[i] ? clock(intermediate[i].departure) : "", intermediate[i]?.name ?? "");
        values.push(stops[stops.length - 1].name, clock(stops[stops.length - 1].arrival));
      }
      for (let i = 0; i < values.length; i++) cell(values[i], xs[i], y, ws[i], rowHeight, fontSize);
      y += rowHeight;
    }
    legend.lines.forEach((line, lineIndex) => {
      fitText(
        line,
        margin,
        pageH - 16.6 - (legend.lines.length - 1 - lineIndex) * 3.6,
        tableW - 24,
        legend.size,
      );
    });
    fitText("WY: wyjazd, PRZ: przejazd techniczny, ZJ: zjazd. ~: według reguł, niepotwierdzone; godziny i zajezdnia do ustalenia.", margin, pageH - 13, tableW - 24, 6.3);
    fitText(`Zjazd zawsze osobnym wierszem (ZJ) — nie dopisujemy go do numeru linii. Do 4 przystanków pośrednich; od 24:00 następna doba.${display.missingCoordinates ? " Brak współrzędnych: PRZ mogą być niepełne." : ""}`, margin, pageH - 9, tableW - 24, 6.3);
    fitText(`${data.notice ? "UWAGA: niepełne dane GTFS — szczegóły w notatce PDF. " : ""}GTFS, nie dokument urzędowy. Podsumowanie bez wierszy ~; czas pracy i długość orientacyjne.`, margin, pageH - 5, tableW - 24, 6.3);
    if (data.notice) doc.createAnnotation({ type: "text", title: "Niepełne dane GTFS", contents: data.notice, bounds: { x: pageW - margin - 4, y: 5, w: 4, h: 4 } });
    fitText(`${index + 1} / ${sheets.length}`, pageW - margin - 18, pageH - 5, 18, 6.3);
  });
  return doc;
}

export function timetablePdfFilename(dateId: string, scope: TimetableExportScope): string {
  const suffix = scope.kind === "line" ? `linia-${scope.line}` : scope.kind === "company" ? `firma-${scope.company}` : `kursowka-${scope.blockId}`;
  return `rozklad-${dateId}-${suffix.replace(/[^a-zA-Z0-9_-]+/g, "-")}.pdf`;
}
