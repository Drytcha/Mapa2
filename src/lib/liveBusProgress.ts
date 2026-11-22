import {
  DELAY_STYLES,
  WAITING_STYLE,
  delayTone,
  formatDelay,
  formatVehicleNumber,
  type DelayStyle,
  type DelayTone,
} from "./delay";
import type { VehicleTripStop } from "./engine/gtfsStore";
import { legendCodeForTrip, legendText } from "./lineLegend";
import { DateTime } from "luxon";
import { formatWarsawClock, WARSAW_ZONE } from "./core/time";

/**
 * Przebieg kursu wybranego autobusu (wzór: myBus 3.0, ekran „Pojazdy na żywo”
 * → pojazd → „Odjazdy”): każdy przystanek od początku do końca, przebyte
 * wyszarzone, autobus zaznaczony na osi, obok godzina planowa i prognoza GPS.
 */
export type TripStopStatus = "passed" | "current" | "next" | "final" | "upcoming";

export interface TripStopRow {
  key: string;
  /** Numer przystanku w kursie (GTFS stop_sequence). */
  sequence: number;
  name: string;
  /** Godzina z rozkładu (ms). */
  plannedMs: number;
  /** Prognoza GPS (ms) — tylko gdy pojazd nadaje opóźnienie. */
  predictedMs: number | null;
  /** Różnica prognozy do rozkładu (s); null bez GPS. */
  deltaSeconds: number | null;
  status: TripStopStatus;
  tone: DelayTone;
  toneStyle: DelayStyle;
}

export interface TripProgressOptions {
  /** Opóźnienie pojazdu (s) z GPS. */
  delaySeconds?: number;
  /** Czy pojazd w ogóle nadaje GPS (inaczej pokazujemy tylko rozkład). */
  isRealtime?: boolean;
}

/** Indeks przystanku, na którym autobus jest teraz (pierwszy nieprzebyty). */
export function currentStopIndex(stops: readonly VehicleTripStop[]): number {
  const index = stops.findIndex((stop) => !stop.passed);
  return index === -1 ? stops.length - 1 : index;
}

/**
 * Buduje listę przystanków kursu ze statusami. Kolejność: przebyty → końcowy
 * → bieżący → następny → kolejne. Przebyte przystanki **zostają na liście**,
 * żeby było widać całą trasę, tak jak w myBus 3.0.
 */
export function buildTripProgress(
  stops: readonly VehicleTripStop[],
  options: TripProgressOptions = {},
): TripStopRow[] {
  if (!stops.length) return [];
  const { delaySeconds = 0, isRealtime = false } = options;
  const currentIndex = currentStopIndex(stops);
  const lastIndex = stops.length - 1;
  return stops.map((stop, index) => {
    const predictedMs = isRealtime ? stop.scheduledDeparture + delaySeconds * 1000 : null;
    const deltaSeconds = isRealtime ? delaySeconds : null;
    let status: TripStopStatus;
    if (stop.passed) status = "passed";
    else if (index === lastIndex) status = "final";
    else if (index === currentIndex) status = "current";
    else if (index === currentIndex + 1) status = "next";
    else status = "upcoming";
    const tone = delayTone(deltaSeconds ?? 0);
    return {
      key: `${stop.sequence}-${stop.name}`,
      sequence: stop.sequence,
      name: stop.name,
      plannedMs: stop.scheduledDeparture,
      predictedMs,
      deltaSeconds,
      status,
      tone,
      toneStyle: DELAY_STYLES[tone],
    };
  });
}

/** Czy autobus stoi na przystanku początkowym i czeka na odjazd (myBus: „Czeka na odjazd o 10:01”). */
export function waitingForDeparture(
  stops: readonly VehicleTripStop[],
  options: TripProgressOptions & { nowMs?: number } = {},
): { waiting: boolean; atMs: number; label: string } {
  const first = stops[0];
  if (!first) return { waiting: false, atMs: 0, label: "" };
  const { delaySeconds = 0, isRealtime = false, nowMs = Date.now() } = options;
  const departureMs = first.scheduledDeparture + (isRealtime ? delaySeconds * 1000 : 0);
  const waiting = currentStopIndex(stops) === 0 && nowMs < departureMs;
  return {
    waiting,
    atMs: departureMs,
    label: waiting ? `Czeka na odjazd o ${formatWarsawClock(departureMs)}` : "",
  };
}

/** „planowo”, „+0:30”, „-2:10” — konwencja aplikacji (minus = za rozkładem). */
export function describeStopDelta(deltaSeconds: number | null): string {
  if (deltaSeconds === null) return "planowo";
  if (Math.abs(deltaSeconds) < 30) return "planowo";
  return formatDelay(deltaSeconds);
}

/** Krótki opis pojazdu do nagłówka karty: „Pojazd #1”. */
export function vehicleChipLabel(vehicleId: string | null | undefined): string {
  const number = formatVehicleNumber(vehicleId);
  return number ? `Pojazd ${number}` : "Pojazd";
}

/**
 * Oficjalna litera wariantu i jej opis dla kursu autobusu — z legendy linii,
 * wyłącznie na podstawie trasy kursu (nigdy zgadywana).
 */
export function tripVariantLabel(
  line: string,
  stops: readonly VehicleTripStop[],
  headsign?: string | null,
): { code: string; text: string } {
  if (!line || stops.length < 2) return { code: "", text: "" };
  const code = legendCodeForTrip(line, {
    destination: stops[stops.length - 1]?.name,
    headsign: headsign ?? undefined,
    stops: stops.map((stop) => stop.name),
  });
  return { code, text: code ? legendText(line, code) : "" };
}

/** Kolory punktualności z legendą — łącznie ze stanem „czeka na odjazd”. */
export const TRIP_LEGEND: Array<{ label: string; style: DelayStyle }> = [
  { label: DELAY_STYLES["early-small"].label, style: DELAY_STYLES["early-small"] },
  { label: DELAY_STYLES.late.label, style: DELAY_STYLES.late },
  { label: DELAY_STYLES["late-high"].label, style: DELAY_STYLES["late-high"] },
  { label: DELAY_STYLES["early-big"].label, style: DELAY_STYLES["early-big"] },
  { label: WAITING_STYLE.label, style: WAITING_STYLE },
];

/** Dzień obsługi kursu (YYYYMMDD) dla znacznika czasu GPS lub startu kursu. */
export function serviceDateId(ms: number): string {
  return DateTime.fromMillis(ms, { zone: WARSAW_ZONE }).toFormat("yyyyMMdd");
}

/**
 * Co robi klik w autobus: ten sam pojazd zamyka kartę, inny — otwiera go
 * i rysuje trasę jego kursu (myBus 3.0).
 */
export function liveBusTap(
  selectedVehicleId: string | null,
  clickedVehicleId: string,
): "close" | "select" {
  return selectedVehicleId && selectedVehicleId === clickedVehicleId
    ? "close"
    : "select";
}
