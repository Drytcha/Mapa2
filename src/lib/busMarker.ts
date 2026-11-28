import { escapeHtml, formatDutyCode, isSameDutyLine, parseDutyPair } from "./core/text";
import {
  DELAY_STYLES,
  delayTone,
  describeDelay,
  formatDelay,
  formatSpeed,
  formatVehicleNumber,
} from "./delay";
import type { LiveBusVehicle } from "./types";

/** Direction, line, vehicle number, speed and delay stay visible; extra duty is optional. */
export interface BusLabelOptions {
  kursowka: boolean;
  vehicleNumber: boolean;
  /**
   * Kierunek z rozkładu (ostatni przystanek kursu). Ma pierwszeństwo nad
   * tablicą kierunkową GPS, która bywa nieaktualna — np. linia 11 pokazywała
   * „Nowy Julianów”, choć kurs kończy na pętli Strzegomska – Kozice.
   */
  destination?: string | null;
}

/** Zwraca oczyszczony numer linii albo pusty ciąg, gdy autobus nie ma wybranej linii. */
export function normalizeBusLine(routeName: string | null | undefined): string {
  const cleaned = String(routeName ?? "").trim();
  if (!cleaned || cleaned === "?" || cleaned === "-" || cleaned === "—") return "";
  if (/^(brak|null|none|undefined)$/i.test(cleaned)) return "";
  return cleaned;
}

/**
 * Builds deduplicated label HTML for a live bus marker:
 * - No selected line (`routeName` empty / `"?"`): renders ONLY the vehicle number (`#340`), never `?`.
 * - With line (`routeName = "15"`, `vehicleId = "340"`): renders `15 | #340` visible at all zoom levels
 *   (including zoomed-out city/far map views) when `options.vehicleNumber` is enabled.
 * - Optional duty (`options.kursowka`): `/03` or `| 9/01` stays `.live-bus-extra` (shown up close / selected).
 */
function buildMarkerLabelHtml(
  bus: Pick<LiveBusVehicle, "kursowka" | "routeName" | "vehicleId">,
  options: BusLabelOptions
): { labelHtml: string; hasExtra: boolean } {
  const line = normalizeBusLine(bus.routeName);
  const vehicle = formatVehicleNumber(bus.vehicleId);
  const rawDuty = options.kursowka ? bus.kursowka.trim() : "";
  const canonicalDuty = rawDuty ? formatDutyCode(rawDuty, "/") : "";
  const parsedDuty = canonicalDuty ? parseDutyPair(canonicalDuty) : null;

  // Gdy autobus nie ma wybranej linii — pokazujemy wyłącznie sam numer autobusu.
  if (!line) {
    const soloLabel = vehicle || "?";
    const parts = [
      `<span class="live-bus-veh live-bus-veh--solo">${escapeHtml(soloLabel)}</span>`,
    ];
    let hasExtra = false;
    if (canonicalDuty) {
      parts.push(
        `<span class="live-bus-extra"><span class="live-bus-sep">|</span>${escapeHtml(canonicalDuty)}</span>`
      );
      hasExtra = true;
    }
    return { labelHtml: parts.join(""), hasExtra };
  }

  const parts: string[] = [];
  let hasExtra = false;

  if (canonicalDuty && isSameDutyLine(line, canonicalDuty)) {
    if (parsedDuty) {
      parts.push(
        `<span class="live-bus-primary"><span class="live-bus-line">${escapeHtml(parsedDuty.line)}</span><span class="live-bus-extra">/${escapeHtml(parsedDuty.suffix)}</span></span>`
      );
      hasExtra = true;
    } else {
      parts.push(`<span class="live-bus-line">${escapeHtml(line)}</span>`);
    }
  } else {
    parts.push(`<span class="live-bus-line">${escapeHtml(line)}</span>`);
    if (canonicalDuty) {
      parts.push(
        `<span class="live-bus-extra"><span class="live-bus-sep">|</span>${escapeHtml(canonicalDuty)}</span>`
      );
      hasExtra = true;
    }
  }

  if (options.vehicleNumber && vehicle) {
    parts.push(
      `<span class="live-bus-veh-group"><span class="live-bus-sep">|</span><span class="live-bus-veh">${escapeHtml(vehicle)}</span></span>`
    );
    hasExtra = true;
  }

  return { labelHtml: parts.join(""), hasExtra };
}

/** HTML of the Leaflet divIcon and the hover tooltip for one live bus. */
export function buildBusMarker(
  bus: LiveBusVehicle,
  options: BusLabelOptions,
  selected: boolean
): { html: string; tooltip: string; templateKey: string } {
  const style = DELAY_STYLES[delayTone(bus.delaySeconds)];
  // Kierunek z rozkładu jest pewniejszy niż tablica kierunkowa GPS.
  const directionLabel = options.destination || bus.headsign || "";
  const { labelHtml, hasExtra } = buildMarkerLabelHtml(bus, options);
  const compact = !hasExtra;
  const speedText = formatSpeed(bus.speedKmh);
  const delayText = formatDelay(bus.delaySeconds);
  const delayDescription = describeDelay(bus.delaySeconds);

  const hasBearing = typeof bus.bearing === "number" && Number.isFinite(bus.bearing);
  const bearing = hasBearing ? ((bus.bearing! % 360) + 360) % 360 : 0;
  const direction = hasBearing
    ? `<span class="live-bus-arrow" style="transform:rotate(${bearing}deg)" aria-hidden="true"><svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M12 2L20.5 20.5L12 16.2L3.5 20.5L12 2Z" fill="currentColor" stroke="rgba(255,255,255,0.9)" stroke-width="2.2" stroke-linejoin="round"/></svg></span>`
    : '<span class="live-bus-dot" title="Brak danych o kierunku jazdy" aria-hidden="true"></span>';

  const opLetter = bus.operatorKey === "mzuk" ? "M" : bus.operatorKey === "ska" ? "Ś" : "?";
  const operatorBadge = compact
    ? ""
    : `<span class="live-bus-op live-bus-op--${bus.operatorKey}">${opLetter}</span>`;
  const pill = `${operatorBadge}${direction}<span class="live-bus-label">${labelHtml}</span>`;

  const html = [
    `<div class="live-bus-wrap${selected ? " live-bus-wrap--selected" : ""}" data-vehicle-id="${escapeHtml(bus.vehicleId)}" style="--delay-bg:${style.bg};--delay-fg:${style.fg};">`,
    `<div class="live-bus${compact ? " live-bus--compact" : " live-bus--with-op"}${selected ? " live-bus--selected" : ""}" style="--route-color:${escapeHtml(bus.routeColor || "#0d4f3b")}">`,
    pill,
    `</div>`,
    `<div class="live-bus-chip"><span>${escapeHtml(speedText)}</span><span class="live-bus-sep">|</span>`,
    `<span class="live-bus-delay" title="${escapeHtml(delayDescription)}">${escapeHtml(delayText)}</span></div></div>`,
  ].join("");

  const line = normalizeBusLine(bus.routeName);
  const canonicalDuty = bus.kursowka.trim() ? formatDutyCode(bus.kursowka.trim(), "/") : "";
  const vehicleNumber = formatVehicleNumber(bus.vehicleId);
  const tooltipRows = [
    { key: "Linia", value: line || "brak wybranej linii" },
    ...(options.kursowka && canonicalDuty && canonicalDuty.toUpperCase() !== line.toUpperCase()
      ? [{ key: "Brygada / kursówka", value: canonicalDuty }]
      : []),
    ...((options.vehicleNumber || !line) && vehicleNumber
      ? [{ key: "Numer taborowy wozu", value: vehicleNumber }]
      : []),
    ...(directionLabel ? [{ key: "Kierunek", value: directionLabel }] : []),
    { key: "Prędkość | punktualność", value: `${speedText} | ${delayDescription}` },
  ];
  const tooltip = [
    `<div class="bus-tooltip-title">Oznaczenie autobusu</div>`,
    ...tooltipRows.map(
      (row) =>
        `<div class="bus-tooltip-row"><span class="bus-tooltip-key">${escapeHtml(row.key)}</span><span class="bus-tooltip-value">${escapeHtml(row.value)}</span></div>`
    ),
  ].join("");

  const directionTemplate = hasBearing
    ? `<span class="live-bus-arrow" style="transform:rotate(0deg)" aria-hidden="true"><svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M12 2L20.5 20.5L12 16.2L3.5 20.5L12 2Z" fill="currentColor" stroke="rgba(255,255,255,0.9)" stroke-width="2.2" stroke-linejoin="round"/></svg></span>`
    : direction;
  const templateKey = `${selected ? 1 : 0}|${style.bg}|${style.fg}|${bus.routeColor || "#0d4f3b"}|${operatorBadge}|${directionTemplate}|${labelHtml}|${speedText}|${delayText}|${delayDescription}`;

  return { html, tooltip, templateKey };
}
