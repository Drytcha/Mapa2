import {
  DELAY_STYLES,
  delayTone,
  describeDelay,
  formatDelay,
  formatSpeed,
  formatVehicleNumber,
} from "./delay";
import { OPERATOR_STYLES } from "./transit";
import type { LiveBusVehicle } from "./types";

/** Direction, line, speed and delay stay visible; only extra identifiers are optional. */
export interface BusLabelOptions {
  kursowka: boolean;
  vehicleNumber: boolean;
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[
        character
      ] as string
  );

/** Always start with the line, followed by optional duty and fleet identifiers. */
export function busLabelParts(
  bus: Pick<LiveBusVehicle, "kursowka" | "routeName" | "vehicleId">,
  options: BusLabelOptions
): string[] {
  const line = bus.routeName.trim() || "?";
  const parts: string[] = [line];
  if (options.kursowka) {
    const kursowka = bus.kursowka.trim();
    if (kursowka && kursowka !== line) parts.push(kursowka);
  }
  if (options.vehicleNumber) {
    const vehicle = formatVehicleNumber(bus.vehicleId);
    if (vehicle) parts.push(vehicle);
  }
  return parts;
}

const SEPARATOR = '<span class="live-bus-sep">|</span>';

/** HTML of the Leaflet divIcon and the hover tooltip for one live bus. */
export function buildBusMarker(
  bus: LiveBusVehicle,
  options: BusLabelOptions,
  selected: boolean
): { html: string; tooltip: string } {
  const style = DELAY_STYLES[delayTone(bus.delaySeconds)];
  const company = OPERATOR_STYLES[bus.operatorKey] ?? OPERATOR_STYLES.other;
  const parts = busLabelParts(bus, options);
  const compact = parts.length === 1;
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
  const labelHtml = parts
    .map((part, index) => `<span${index === 0 ? ' class="live-bus-line"' : ""}>${escapeHtml(part)}</span>`)
    .join(SEPARATOR);
  const pill = `${operatorBadge}${direction}<span class="live-bus-label">${labelHtml}</span>`;

  const html = [
    `<div class="live-bus-wrap${selected ? " live-bus-wrap--selected" : ""}" style="--delay-bg:${style.bg};--delay-fg:${style.fg};--operator-bg:${company.bg};--operator-fg:${company.fg}">`,
    `<div class="live-bus${compact ? " live-bus--compact" : ""}${selected ? " live-bus--selected" : ""}" style="--route-color:${escapeHtml(bus.routeColor || "#0d4f3b")}">`,
    pill,
    `</div>`,
    `<div class="live-bus-chip"><span>${escapeHtml(speedText)}</span>${SEPARATOR}`,
    `<span class="live-bus-delay" title="${escapeHtml(delayDescription)}">${escapeHtml(delayText)}</span></div></div>`,
  ].join("");

  const tooltip = [
    parts[0] === "?" ? "Brak numeru linii" : `Linia ${parts[0]}`,
    bus.headsign ? `Kierunek: ${bus.headsign}` : "",
    ...parts.slice(1),
    `${speedText} | ${delayDescription}`,
  ]
    .filter(Boolean)
    .map(escapeHtml)
    .join(" · ");

  return { html, tooltip };
}
