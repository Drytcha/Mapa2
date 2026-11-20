import { jsPDF } from "jspdf";
import { DateTime } from "luxon";
import { summariseBrigade } from "../brigadeMetrics";
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
  stops: Array<{ name: string; arrival: number; departure: number }>;
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
    if (!item.unassigned) return item.lineIds.some((id) => id.toUpperCase() === line) ? [item] : [];
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
        const stop = store.base.stopsById.get(time.stopId);
        if (!stop) throw new Error(`Brak przystanku ${time.stopId} w kursie ${trip.id}.`);
        return { name: stop.name, arrival: time.arrivalMinutes, departure: time.departureMinutes };
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
    if (shade) { doc.setFillColor(237, 237, 237); doc.rect(x, y, width, height, "F"); }
    doc.setDrawColor(160); doc.setLineWidth(0.12); doc.rect(x, y, width, height);
    // Baseline centred within the available height, even for densely packed duties.
    fitText(value, x + 0.7, y + height / 2 + size * 0.11, Math.max(0.1, width - 1.4), size);
  };

  sheets.forEach(({ duty, part, parts }, index) => {
    if (index) doc.addPage();
    const number = duty.item.unassigned ? `Bez przypisanej kursówki${parts > 1 ? ` (${part}/${parts})` : ""}` : duty.item.number.replace(/-([0-9]+)$/, "/$1");
    fitText(`MAPA2 / ROZKŁAD KURSÓW   |   ${dateLabel}   |   ${data.scopeLabel}`, margin, 8, tableW - (data.notice ? 6 : 0), 8);
    fitText(`Okres danych GTFS: ${formatDate(data.feedFrom)} – ${formatDate(data.feedTo)}   |   ${data.serviceLabel || "typ dnia według GTFS"}`, margin, 12, tableW, 7);
    const metrics = summariseBrigade(duty.trips.map((row) => row.trip));
    const km = metrics.missingLengthTrips ? `Długość: niepełne dane (${metrics.missingLengthTrips} kurs.)` : `Długość kursów: ${(metrics.totalMeters / 1000).toLocaleString("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
    const boxes = [
      number,
      `Firma: ${duty.item.operatorName}`,
      duty.item.unassigned ? "Czas służby: nie dotyczy" : `Rozpiętość: ${duration(metrics.durationMinutes)}  |  praca szac.: ${duration(metrics.workBlockMinutes)}`,
      duty.item.unassigned ? km : `${km}  |  przerwy > 90 min: ${duration(metrics.splitBreakMinutes)}`,
    ];
    const boxWidths = [42, 68, 80, tableW - 190];
    let bx = margin;
    boxes.forEach((value, i) => { cell(value, bx, 15, boxWidths[i], 9, i === 0 ? 9 : 7.2); bx += boxWidths[i]; });

    const headerY = 26, headerH = 5;
    cell("Linia", xs[0], headerY, ws[0], headerH, 7, true);
    cell("Godz.", xs[1], headerY, ws[1], headerH, 7, true);
    cell("Początek", xs[2], headerY, ws[2], headerH, 7, true);
    cell("Wybrane przystanki pośrednie · godzina odjazdu", xs[3], headerY, xs[11] - xs[3], headerH, 7, true);
    cell("Koniec", xs[11], headerY, ws[11], headerH, 7, true);
    cell("Przyj.", xs[12], headerY, ws[12], headerH, 7, true);
    const bodyTop = headerY + headerH;
    const bodyBottom = pageH - 14;
    const rowHeight = Math.min(5, (bodyBottom - bodyTop) / Math.max(1, duty.trips.length));
    const fontSize = Math.min(7.5, rowHeight * 1.55);
    let y = bodyTop;
    for (const { trip, stops } of duty.trips) {
      if (!stops.length) throw new Error(`Brak przystanków dla kursu ${trip.id}.`);
      const intermediate = selectTimetableCheckpoints(stops);
      const values = [trip.lineId, clock(stops[0].departure), stops[0].name];
      for (let i = 0; i < 4; i++) values.push(intermediate[i] ? clock(intermediate[i].departure) : "", intermediate[i]?.name ?? "");
      values.push(stops[stops.length - 1].name, clock(stops[stops.length - 1].arrival));
      for (let i = 0; i < values.length; i++) cell(values[i], xs[i], y, ws[i], rowHeight, fontSize);
      y += rowHeight;
    }
    fitText("Pokazano do czterech wybranych przystanków pośrednich, nie pełną listę. Godziny od 24:00 dotyczą następnej doby.", margin, pageH - 9, tableW - 24, 6.3);
    fitText(`${data.notice ? "UWAGA: niepełne dane GTFS — szczegóły w notatce PDF. " : ""}GTFS, nie dokument urzędowy. Firma wg katalogu; czas pracy i długość orientacyjne.`, margin, pageH - 5, tableW - 24, 6.3);
    if (data.notice) doc.createAnnotation({ type: "text", title: "Niepełne dane GTFS", contents: data.notice, bounds: { x: pageW - margin - 4, y: 5, w: 4, h: 4 } });
    fitText(`${index + 1} / ${sheets.length}`, pageW - margin - 18, pageH - 5, 18, 6.3);
  });
  return doc;
}

export function timetablePdfFilename(dateId: string, scope: TimetableExportScope): string {
  const suffix = scope.kind === "line" ? `linia-${scope.line}` : scope.kind === "company" ? `firma-${scope.company}` : `kursowka-${scope.blockId}`;
  return `rozklad-${dateId}-${suffix.replace(/[^a-zA-Z0-9_-]+/g, "-")}.pdf`;
}
