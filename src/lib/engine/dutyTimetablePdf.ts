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

/** Build one landscape PDF, with one or more pages per duty. All intermediate
 * stops are printed, in continuation rows when there are more than four. */
export async function createTimetablePdf(data: TimetablePdfData): Promise<jsPDF> {
  if (!data.duties.length) throw new Error("Brak kursówek do wydrukowania.");
  const { LATO_REGULAR_TTF } = await import("../latoFont");
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true, putOnlyUsedFonts: true });
  doc.addFileToVFS("Lato-Regular.ttf", LATO_REGULAR_TTF);
  doc.addFont("Lato-Regular.ttf", "Lato", "normal");
  doc.setFont("Lato", "normal");
  doc.setProperties({ title: `Rozkład służb — ${data.scopeLabel} — ${formatDate(data.dateId)}`, subject: "Rozkład na wybrany dzień na podstawie GTFS", creator: "Mapa2" });
  const margin = 7, pageW = doc.internal.pageSize.getWidth(), pageH = doc.internal.pageSize.getHeight();
  const tableW = pageW - 2 * margin;
  // Line, start time, start, four time/stop pairs, end, end time.
  const widths = [10, 13, 40, 11, 29, 11, 29, 11, 29, 11, 29, 46, 14];
  const scale = tableW / widths.reduce((sum, width) => sum + width, 0);
  const ws = widths.map((width) => width * scale);
  const xs = [margin];
  for (const width of ws) xs.push(xs[xs.length - 1] + width);
  let pageNo = 0;
  const text = (value: string, x: number, y: number, size = 8) => { doc.setFontSize(size); doc.text(value, x, y); };
  const cell = (value: string, x: number, y: number, width: number, height: number, size = 8, shade = false) => {
    if (shade) { doc.setFillColor(237, 237, 237); doc.rect(x, y, width, height, "F"); }
    doc.setDrawColor(150); doc.setLineWidth(0.15); doc.rect(x, y, width, height);
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(value || "", Math.max(1, width - 2)) as string[];
    doc.text(lines, x + 1, y + 3.3, { lineHeightFactor: 1.12 });
  };
  const date = DateTime.fromFormat(data.dateId, "yyyyLLdd", { zone: BRIGADE_ZONE }).setLocale("pl");
  const dateLabel = date.isValid ? date.toFormat("cccc, dd.MM.yyyy") : formatDate(data.dateId);
  let y = 0;
  const header = (duty: TimetablePdfDuty, continuation: boolean) => {
    if (pageNo++) doc.addPage();
    text("MAPA2  /  ROZKŁAD KURSÓW", margin, 8, 8);
    text(`Dzień: ${dateLabel}   |   ${data.scopeLabel}`, margin, 14, 9);
    doc.setFontSize(7.5);
    const serviceText = `Okres danych GTFS: ${formatDate(data.feedFrom)} – ${formatDate(data.feedTo)}   |   ${data.serviceLabel || "typ dnia według GTFS"}`;
    const serviceLines = doc.splitTextToSize(serviceText, tableW) as string[];
    doc.text(serviceLines, margin, 19, { lineHeightFactor: 1.12 });
    const top = 22 + Math.max(0, serviceLines.length - 1) * 3;
    const trips = duty.trips.map((row) => row.trip);
    const metrics = summariseBrigade(trips);
    const number = duty.item.unassigned ? "Bez przypisanej kursówki" : duty.item.number.replace(/-([0-9]+)$/, "/$1");
    cell(number + (continuation ? " (cd.)" : ""), margin, top, 52, 16, 11);
    cell(`Firma: ${duty.item.operatorName}`, margin + 52, top, 67, 16, 8.5);
    cell(duty.item.unassigned ? "Czas służby: nie dotyczy" : `Rozpiętość: ${duration(metrics.durationMinutes)}\nPraca szac. bez przerw > 90 min: ${duration(metrics.workBlockMinutes)}`, margin + 119, top, 63, 16, 8);
    const km = metrics.missingLengthTrips ? `Długość: niepełne dane (${metrics.missingLengthTrips} kurs.)` : `Długość kursów (obliczona): ${(metrics.totalMeters / 1000).toLocaleString("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
    cell(`${km}\n${duty.item.unassigned ? "Przerwy: nie dotyczy" : `Przerwy > 90 min: ${duration(metrics.splitBreakMinutes)}`}`, margin + 182, top, tableW - 182, 16, 8);
    y = top + 18;
    cell("Linia", xs[0], y, ws[0], 9, 7, true);
    cell("Godz.", xs[1], y, ws[1], 9, 7, true);
    cell("Początek", xs[2], y, ws[2], 9, 7, true);
    cell("Przystanki pośrednie · godzina odjazdu", xs[3], y, xs[11] - xs[3], 9, 8, true);
    cell("Koniec", xs[11], y, ws[11], 9, 7, true);
    cell("Przyj.", xs[12], y, ws[12], 9, 7, true);
    y += 9;
  };
  const rowHeight = (values: string[]) => {
    doc.setFontSize(7.5);
    const lines = values.map((value, i) => (doc.splitTextToSize(value || "", Math.max(1, ws[i] - 2)) as string[]).length);
    return Math.max(6, Math.max(...lines) * 3.05 + 1.5);
  };
  if (data.notice) {
    // The catalogue can identify duties missing from a partial feed. Do not
    // silently turn that incomplete feed into an apparently complete export.
    pageNo++;
    text("UWAGA: NIEPEŁNE DANE GTFS", margin, 12, 13);
    text(`${data.scopeLabel}  |  ${dateLabel}`, margin, 19, 9);
    doc.setFontSize(9);
    const lines = doc.splitTextToSize(data.notice, tableW - 2) as string[];
    let warningY = 27;
    for (const line of lines) {
      if (warningY > pageH - 18) { doc.addPage(); pageNo++; warningY = 14; }
      text(line, margin, warningY, 9);
      warningY += 4.5;
    }
  }
  for (const duty of data.duties) {
    header(duty, false);
    for (const { trip, stops } of duty.trips) {
      const middle = stops.slice(1, -1);
      const chunks = Math.max(1, Math.ceil(middle.length / 4));
      for (let part = 0; part < chunks; part++) {
        const intermediate = middle.slice(part * 4, part * 4 + 4);
        const values = [part ? "cd." : trip.lineId, part ? "" : clock(stops[0].departure), part ? "(ciąg dalszy)" : stops[0].name];
        for (let i = 0; i < 4; i++) values.push(intermediate[i] ? clock(intermediate[i].departure) : "", intermediate[i]?.name ?? "");
        values.push(part ? "" : stops[stops.length - 1].name, part ? "" : clock(stops[stops.length - 1].arrival));
        doc.setFontSize(7.5);
        const wrapped = values.map((value, i) => doc.splitTextToSize(value || "", Math.max(1, ws[i] - 2)) as string[]);
        const sections = Math.max(1, Math.ceil(Math.max(...wrapped.map((lines) => lines.length)) / 30));
        for (let section = 0; section < sections; section++) {
          const cells = wrapped.map((lines) => lines.slice(section * 30, (section + 1) * 30).join("\n"));
          const height = rowHeight(cells);
          if (y + height > pageH - 15) header(duty, true);
          for (let i = 0; i < cells.length; i++) cell(cells[i], xs[i], y, ws[i], height, 7.5);
          y += height;
        }
      }
    }
  }
  // Repeat truthful limitations on every page, not just the final duty.
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    text("Zestawienie z GTFS, nie dokument urzędowy. Godziny od 24:00: następna doba. Brakujących przejazdów technicznych nie dopisywano.", margin, pageH - 8, 6.5);
    text("Firma wg przypisania w katalogu; czasy pracy i długości są obliczane orientacyjnie.", margin, pageH - 4, 6.5);
    text(`Strona ${page} / ${pages}`, pageW - margin - 23, pageH - 4, 6.5);
  }
  return doc;
}

export function timetablePdfFilename(dateId: string, scope: TimetableExportScope): string {
  const suffix = scope.kind === "line" ? `linia-${scope.line}` : scope.kind === "company" ? `firma-${scope.company}` : `kursowka-${scope.blockId}`;
  return `rozklad-${dateId}-${suffix.replace(/[^a-zA-Z0-9_-]+/g, "-")}.pdf`;
}
