import { distanceCoords } from "./core/spatial";
import {
  DEPOT_ROUTE_CODES,
  isDepotRoute,
  isTechnicalRoute,
  TECHNICAL_ROUTE_CODES,
} from "./core/text";
import type { WalbrzychOperatorKey } from "./types";

export const TECHNICAL_LINES = TECHNICAL_ROUTE_CODES;
export const DEPOT_LINES = DEPOT_ROUTE_CODES;
export const isTechnicalLine = isTechnicalRoute;
export const isDepotLine = isDepotRoute;

const SPLIT_BREAK_MS = 90 * 60_000;
const MIN_DEADHEAD_STRAIGHT_M = 350;
const ROAD_DETOUR_FACTOR = 1.28;

export interface BrigadeMetricTrip {
  lineId: string;
  startMs: number;
  endMs: number;
  length: number;
  firstStop?: { id?: string; name?: string; lat?: number; lon?: number };
  lastStop?: { id?: string; name?: string; lat?: number; lon?: number };
}

export interface LineWorkShare {
  lineId: string;
  trips: number;
  meters: number;
  drivingMinutes: number;
}

export interface BrigadeMetrics {
  trips: number;
  /** Od pierwszego do ostatniego kursu (pełna rozpiętość służby). */
  durationMinutes: number;
  /** Suma czasów bloków pracy bez długich przerw międzyszczytowych (> 90 min). */
  workBlockMinutes: number;
  /** Suma czasów przejazdów (czysta jazda wg rozkładu). */
  drivingMinutes: number;
  /** Postoje wyrównawcze na krańcach wewnątrz bloków pracy (<= 90 min). */
  layoverMinutes: number;
  /** Długie przerwy międzyszczytowe (> 90 min) w brygadach przerywanych. */
  splitBreakMinutes: number;
  /** Liczba ciągłych bloków pracy (1 = ciągła, >= 2 = przerywana / szczytowa). */
  shiftCount: number;
  /** Orientacyjna liczba zmian kierowców (1 do 10 h pracy ciągłej, 2 powyżej lub przy B). */
  estimatedDriverShifts: number;
  /** Wozokilometry z rozkładu GTFS (suma długości kursów). */
  totalMeters: number;
  /** Kilometry kursów pasażerskich (liniowe). */
  revenueMeters: number;
  /** Kilometry przejazdów technicznych jawnie wpisanych w GTFS (WY/ZJ/PRZ). */
  technicalMeters: number;
  /** Podzbiór technicznych z GTFS: wyjazd/zjazd z bazy. */
  depotMeters: number;
  /** Podzbiór technicznych z GTFS: przejazdy między krańcami, serwis. */
  transferMeters: number;
  /** Szacowane przejazdy techniczne między różnymi krańcami kolejnych kursów (> 350 m). */
  deadheadMeters: number;
  /** Liczba zmian krańca wymagających przejazdu technicznego między kursami. */
  deadheadCount: number;
  /** Łączny przebieg operacyjny: wozokilometry z GTFS + przejazdy między krańcami. */
  totalWithDeadheadMeters: number;
  /** Prędkość komunikacyjna w blokach pracy (km/h). */
  commercialSpeedKmh: number;
  /** Prędkość techniczna samej jazdy (km/h). */
  runningSpeedKmh: number;
  /** Udział czasu jazdy w czasie bloków pracy (%). */
  utilizationPercent: number;
  /** Rozbicie kursów, km i czasu jazdy na poszczególne linie w brygadzie. */
  lineBreakdown: LineWorkShare[];
  revenueTrips: number;
  technicalTrips: number;
  /** Czy źródło ma jawne kursy techniczne (WY/ZJ/PRZ). */
  hasTechnicalData: boolean;
  /** Ile kursów ma nieznaną długość (0 m). */
  missingLengthTrips: number;
}

const validLength = (value: number) =>
  Number.isFinite(value) && value > 0 ? value : 0;

/** Wylicza pełne metryki pracy przewozowej jednej brygady dla planisty. */
export function summariseBrigade(trips: BrigadeMetricTrip[]): BrigadeMetrics {
  if (!trips.length) {
    return {
      trips: 0,
      durationMinutes: 0,
      workBlockMinutes: 0,
      drivingMinutes: 0,
      layoverMinutes: 0,
      splitBreakMinutes: 0,
      shiftCount: 0,
      estimatedDriverShifts: 0,
      totalMeters: 0,
      revenueMeters: 0,
      technicalMeters: 0,
      depotMeters: 0,
      transferMeters: 0,
      deadheadMeters: 0,
      deadheadCount: 0,
      totalWithDeadheadMeters: 0,
      commercialSpeedKmh: 0,
      runningSpeedKmh: 0,
      utilizationPercent: 0,
      lineBreakdown: [],
      revenueTrips: 0,
      technicalTrips: 0,
      hasTechnicalData: false,
      missingLengthTrips: 0,
    };
  }

  const ordered = [...trips].sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs
  );
  const first = ordered[0].startMs;
  const last = ordered.reduce(
    (max, trip) => Math.max(max, trip.endMs),
    ordered[0].endMs
  );

  let drivingMs = 0;
  let splitBreakMs = 0;
  let shiftCount = 1;
  let total = 0;
  let revenue = 0;
  let technical = 0;
  let depot = 0;
  let transfer = 0;
  let deadheadMeters = 0;
  let deadheadCount = 0;
  let revenueTrips = 0;
  let technicalTrips = 0;
  let missing = 0;

  const byLine = new Map<string, { trips: number; meters: number; drivingMs: number }>();

  for (let i = 0; i < ordered.length; i += 1) {
    const trip = ordered[i];
    const length = validLength(trip.length);
    if (!length) missing += 1;
    const tripDriveMs = Math.max(0, trip.endMs - trip.startMs);
    drivingMs += tripDriveMs;
    total += length;

    const lineKey = trip.lineId.trim().toUpperCase() || "?";
    if (isTechnicalLine(lineKey)) {
      technical += length;
      technicalTrips += 1;
      if (isDepotLine(lineKey)) depot += length;
      else transfer += length;
    } else {
      revenue += length;
      revenueTrips += 1;
      const prevLine = byLine.get(lineKey);
      if (prevLine) {
        prevLine.trips += 1;
        prevLine.meters += length;
        prevLine.drivingMs += tripDriveMs;
      } else {
        byLine.set(lineKey, { trips: 1, meters: length, drivingMs: tripDriveMs });
      }
    }

    if (i > 0) {
      const prev = ordered[i - 1];
      const gapMs = trip.startMs - prev.endMs;
      if (gapMs > SPLIT_BREAK_MS) {
        splitBreakMs += gapMs;
        shiftCount += 1;
      }
      const a = prev.lastStop;
      const b = trip.firstStop;
      if (
        a &&
        b &&
        a.id !== b.id &&
        typeof a.lat === "number" &&
        typeof a.lon === "number" &&
        typeof b.lat === "number" &&
        typeof b.lon === "number"
      ) {
        const straight = distanceCoords(a.lat, a.lon, b.lat, b.lon);
        // Ignore turnaround loops on the same terminal complex (< 350 m or same terminal name)
        const sameTerminalName =
          a.name &&
          b.name &&
          a.name.split("-")[0].trim().toLowerCase() ===
            b.name.split("-")[0].trim().toLowerCase() &&
          straight < 1_400;
        if (straight >= MIN_DEADHEAD_STRAIGHT_M && !sameTerminalName) {
          deadheadCount += 1;
          deadheadMeters += Math.round(straight * ROAD_DETOUR_FACTOR);
        }
      }
    }
  }

  const totalSpanMs = Math.max(0, last - first);
  const workBlockMs = Math.max(drivingMs, totalSpanMs - splitBreakMs);
  const durationMinutes = Math.round(totalSpanMs / 60_000);
  const workBlockMinutes = Math.round(workBlockMs / 60_000);
  const drivingMinutes = Math.round(drivingMs / 60_000);
  const splitBreakMinutes = Math.round(splitBreakMs / 60_000);
  const layoverMinutes = Math.max(0, workBlockMinutes - drivingMinutes);

  const estimatedDriverShifts =
    shiftCount >= 2 || workBlockMinutes > 10 * 60 ? 2 : 1;

  const revenueKm = revenue / 1000;
  const commercialSpeedKmh =
    workBlockMinutes > 0
      ? Math.round((revenueKm / (workBlockMinutes / 60)) * 10) / 10
      : 0;
  const runningSpeedKmh =
    drivingMinutes > 0
      ? Math.round((revenueKm / (drivingMinutes / 60)) * 10) / 10
      : 0;
  const utilizationPercent =
    workBlockMinutes > 0
      ? Math.min(100, Math.round((drivingMinutes / workBlockMinutes) * 100))
      : 0;

  const lineBreakdown: LineWorkShare[] = [...byLine.entries()]
    .map(([lineId, stats]) => ({
      lineId,
      trips: stats.trips,
      meters: stats.meters,
      drivingMinutes: Math.round(stats.drivingMs / 60_000),
    }))
    .sort(
      (a, b) =>
        b.meters - a.meters ||
        a.lineId.localeCompare(b.lineId, "pl", { numeric: true })
    );

  return {
    trips: ordered.length,
    durationMinutes,
    workBlockMinutes,
    drivingMinutes,
    layoverMinutes,
    splitBreakMinutes,
    shiftCount,
    estimatedDriverShifts,
    totalMeters: total,
    revenueMeters: revenue,
    technicalMeters: technical,
    depotMeters: depot,
    transferMeters: transfer,
    deadheadMeters,
    deadheadCount,
    totalWithDeadheadMeters: total + deadheadMeters,
    commercialSpeedKmh,
    runningSpeedKmh,
    utilizationPercent,
    lineBreakdown,
    revenueTrips,
    technicalTrips,
    hasTechnicalData: technicalTrips > 0,
    missingLengthTrips: missing,
  };
}

export interface OperatorSummaryBucket {
  operatorKey: WalbrzychOperatorKey | "all";
  label: string;
  brigades: number;
  splitBrigades: number;
  trips: number;
  revenueMeters: number;
  deadheadMeters: number;
  totalWithDeadheadMeters: number;
  workBlockMinutes: number;
  drivingMinutes: number;
  layoverMinutes: number;
  durationMinutes: number;
  commercialSpeedKmh: number;
}

export function summariseFleetByOperator(
  items: Array<{
    operatorKey?: WalbrzychOperatorKey;
    unassigned?: boolean;
    metrics?: BrigadeMetrics;
    trips: BrigadeMetricTrip[];
  }>
): {
  mzuk: OperatorSummaryBucket;
  ska: OperatorSummaryBucket;
  other: OperatorSummaryBucket;
  total: OperatorSummaryBucket;
} {
  const empty = (
    operatorKey: WalbrzychOperatorKey | "all",
    label: string
  ): OperatorSummaryBucket => ({
    operatorKey,
    label,
    brigades: 0,
    splitBrigades: 0,
    trips: 0,
    revenueMeters: 0,
    deadheadMeters: 0,
    totalWithDeadheadMeters: 0,
    workBlockMinutes: 0,
    drivingMinutes: 0,
    layoverMinutes: 0,
    durationMinutes: 0,
    commercialSpeedKmh: 0,
  });

  const mzuk = empty("mzuk", "MZUK");
  const ska = empty("ska", "ŚKA");
  const other = empty("other", "Inne");
  const total = empty("all", "Razem");

  const add = (bucket: OperatorSummaryBucket, m: BrigadeMetrics, isUnassigned: boolean) => {
    if (!isUnassigned) bucket.brigades += 1;
    if (!isUnassigned && m.shiftCount >= 2) bucket.splitBrigades += 1;
    bucket.trips += m.trips;
    bucket.revenueMeters += m.revenueMeters;
    bucket.deadheadMeters += m.deadheadMeters;
    bucket.totalWithDeadheadMeters += m.totalWithDeadheadMeters;
    bucket.workBlockMinutes += m.workBlockMinutes;
    bucket.drivingMinutes += m.drivingMinutes;
    bucket.layoverMinutes += m.layoverMinutes;
    bucket.durationMinutes += m.durationMinutes;
  };

  for (const item of items) {
    const m = item.metrics ?? summariseBrigade(item.trips);
    const key = item.operatorKey ?? "other";
    const bucket = key === "mzuk" ? mzuk : key === "ska" ? ska : other;
    add(bucket, m, Boolean(item.unassigned));
    add(total, m, Boolean(item.unassigned));
  }

  for (const bucket of [mzuk, ska, other, total]) {
    bucket.commercialSpeedKmh =
      bucket.workBlockMinutes > 0
        ? Math.round(
            ((bucket.revenueMeters / 1000) / (bucket.workBlockMinutes / 60)) * 10
          ) / 10
        : 0;
  }

  return { mzuk, ska, other, total };
}

/** Liczba km bez zbędnych zer, np. 12,4 km lub 1 425,6 km. */
export function formatKilometres(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return "0 km";
  const km = meters / 1000;
  const digits = km < 100 ? 1 : 0;
  return `${km.toLocaleString("pl-PL", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} km`;
}

/** Zawsze z 1 miejscem po przecinku do tabel rozliczeniowych planisty. */
export function formatKilometresExact(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return "0,0 km";
  return `${(meters / 1000).toLocaleString("pl-PL", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} km`;
}

/** Czas trwania: „9 h 42 min", „48 min", „1 h". */
export function formatServiceHours(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (!hours) return `${rest} min`;
  if (!rest) return `${hours} h`;
  return `${hours} h ${rest} min`;
}

/**
 * Lekki wariant dla listy brygad: lista potwierdzonych kursówek ma od razu
 * przedziały pracy (bez pełnych kursów), więc czas liczymy z tych przedziałów.
 */
export function summariseTimeSpans(times: Array<[number, number]>): {
  durationMinutes: number;
  drivingMinutes: number;
  layoverMinutes: number;
} {
  const valid = times.filter(
    (pair) =>
      Array.isArray(pair) && pair.every(Number.isFinite) && pair[1] >= pair[0]
  );
  if (!valid.length)
    return { durationMinutes: 0, drivingMinutes: 0, layoverMinutes: 0 };
  const start = Math.min(...valid.map((pair) => pair[0]));
  const end = Math.max(...valid.map((pair) => pair[1]));
  const driving = valid.reduce((sum, pair) => sum + (pair[1] - pair[0]), 0);
  const durationMinutes = Math.max(0, Math.round((end - start) / 60_000));
  const drivingMinutes = Math.round(driving / 60_000);
  return {
    durationMinutes,
    drivingMinutes,
    layoverMinutes: Math.max(0, durationMinutes - drivingMinutes),
  };
}
