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

/** Direction, line, speed and delay stay visible; only extra identifiers are optional. */
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

interface MarkerLabelSegment {
  primary?: boolean;
  html: string;
}

const SEPARATOR = '<span class="live-bus-sep live-bus-extra">|</span>';

/**
 * Builds deduplicated label segments for a live bus marker:
 * - Same-line duty (`routeName = "2"`, `kursowka = "2/03"`): renders `2/03` once (never `2 | 2/03` or `2 | 2`).
 * - Cross-line duty (`routeName = "19"`, `kursowka = "9/01"`): renders `19 | 9/01` (distinct current line + duty).
 * - Identical raw values (`routeName = "2"`, `kursowka = "2"`): renders `2` once.
 */
function buildMarkerSegments(
  bus: Pick<LiveBusVehicle, "kursowka" | "routeName" | "vehicleId">,
  options: BusLabelOptions
): { segments: MarkerLabelSegment[]; hasExtra: boolean } {
  const line = bus.routeName.trim() || "?";
  const segments: MarkerLabelSegment[] = [];
  let hasExtra = false;

  const rawDuty = options.kursowka ? bus.kursowka.trim() : "";
  const canonicalDuty = rawDuty ? formatDutyCode(rawDuty, "/") : "";
  const parsedDuty = canonicalDuty ? parseDutyPair(canonicalDuty) : null;

  if (canonicalDuty && isSameDutyLine(line, canonicalDuty)) {
    if (parsedDuty) {
      // Same line as duty prefix (e.g. line "2" + duty "2/03") -> single combined "2/03"
      segments.push({
        primary: true,
        html: `<span class="live-bus-line">${escapeHtml(parsedDuty.line)}</span><span class="live-bus-extra">/${escapeHtml(parsedDuty.suffix)}</span>`,
      });
      hasExtra = true;
    } else {
      // Exact duplicate (e.g. "2" and "2") -> render line once
      segments.push({
        primary: true,
        html: `<span class="live-bus-line">${escapeHtml(line)}</span>`,
      });
    }
  } else {
    segments.push({
      primary: true,
      html: `<span class="live-bus-line">${escapeHtml(line)}</span>`,
    });
    if (canonicalDuty) {
      // Cross-line trip (e.g. line "19" served by duty "9/01")
      segments.push({
        html: `<span class="live-bus-extra">${escapeHtml(canonicalDuty)}</span>`,
      });
      hasExtra = true;
    }
  }

  if (options.vehicleNumber) {
    const vehicle = formatVehicleNumber(bus.vehicleId);
    if (vehicle) {
      segments.push({ html: `<span class="live-bus-extra">${escapeHtml(vehicle)}</span>` });
      hasExtra = true;
    }
  }

  return { segments, hasExtra };
}

/** HTML of the Leaflet divIcon and the hover tooltip for one live bus. */
export function buildBusMarker(
  bus: LiveBusVehicle,
  options: BusLabelOptions,
  selected: boolean
): { html: string; tooltip: string } {
  const style = DELAY_STYLES[delayTone(bus.delaySeconds)];
  // Kierunek z rozkładu jest pewniejszy niż tablica kierunkowa GPS.
  const directionLabel = options.destination || bus.headsign || "";
  const { segments, hasExtra } = buildMarkerSegments(bus, options);
  const compact = !hasExtra && segments.length === 1;
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
  const labelHtml = segments.map((s) => s.html).join(SEPARATOR);
  const pill = `${operatorBadge}${direction}<span class="live-bus-label">${labelHtml}</span>`;

  const html = [
    `<div class="live-bus-wrap${selected ? " live-bus-wrap--selected" : ""}" data-vehicle-id="${escapeHtml(bus.vehicleId)}" style="--delay-bg:${style.bg};--delay-fg:${style.fg};">`,
    `<div class="live-bus${compact ? " live-bus--compact" : ""}${selected ? " live-bus--selected" : ""}" style="--route-color:${escapeHtml(bus.routeColor || "#0d4f3b")}">`,
    pill,
    `</div>`,
    `<div class="live-bus-chip"><span>${escapeHtml(speedText)}</span><span class="live-bus-sep">|</span>`,
    `<span class="live-bus-delay" title="${escapeHtml(delayDescription)}">${escapeHtml(delayText)}</span></div></div>`,
  ].join("");

  const line = bus.routeName.trim() || "?";
  const canonicalDuty = bus.kursowka.trim() ? formatDutyCode(bus.kursowka.trim(), "/") : "";
  const vehicleNumber = formatVehicleNumber(bus.vehicleId);
  const tooltipRows = [
    { key: "Linia", value: line === "?" ? "brak numeru linii" : line },
    ...(options.kursowka && canonicalDuty && canonicalDuty.toUpperCase() !== line.toUpperCase()
      ? [{ key: "Brygada / kursówka", value: canonicalDuty }]
      : []),
    ...(options.vehicleNumber && vehicleNumber
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

  return { html, tooltip };
}
