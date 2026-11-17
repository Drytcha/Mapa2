/**
 * Metryki jednej kursówki (brygady): czas służby, czas jazdy i wozokilometry.
 *
 * Podział kilometrów:
 *  • liniowe (revenue) — kursy z rozkładu pasażerskiego,
 *  • techniczne — kursy oznaczone linią techniczną (PRZ, WY, ZJ, …):
 *      – dojazdowe: wyjazd z bazy / zjazd do bazy (WY, ZJ, WYJAZD, ZJAZD, DOJAZD),
 *      – przejazdy techniczne: przejazd między krańcami / serwis (PRZ, TECH, SERWIS, TEST).
 *
 * Feed GTFS Wałbrzycha zawiera wyłącznie kursy pasażerskie, więc podział na
 * techniczne bywa zerowy. Nie dopisujemy kilometrów, których nie ma w danych —
 * `hasTechnicalData` mówi wprost, czy źródło w ogóle je zawiera.
 */

export const TECHNICAL_LINES = new Set([
  "PRZ",
  "WY",
  "ZJ",
  "WYJAZD",
  "ZJAZD",
  "DOJAZD",
  "TECH",
  "TECHN",
  "SERWIS",
  "TEST",
]);

/** Wyjazd/zjazd z bazy — kilometry dojazdowe. */
export const DEPOT_LINES = new Set(["WY", "ZJ", "WYJAZD", "ZJAZD", "DOJAZD"]);

const normaliseLine = (line: string) => line.trim().toUpperCase();

export function isTechnicalLine(line: string): boolean {
  return TECHNICAL_LINES.has(normaliseLine(line));
}

export function isDepotLine(line: string): boolean {
  return DEPOT_LINES.has(normaliseLine(line));
}

export interface BrigadeMetricTrip {
  lineId: string;
  startMs: number;
  endMs: number;
  length: number;
}

export interface BrigadeMetrics {
  trips: number;
  /** Od pierwszego do ostatniego kursu (czas służby). */
  durationMinutes: number;
  /** Suma czasów przejazdów (bez przerw). */
  drivingMinutes: number;
  /** Przerwy i oczekiwania między kursami. */
  layoverMinutes: number;
  /** Wozokilometry — wszystkie przejechane kilometry. */
  totalMeters: number;
  /** Kilometry kursów pasażerskich. */
  revenueMeters: number;
  /** Kilometry przejazdów technicznych (dojazdowe + przejazdy). */
  technicalMeters: number;
  /** Podzbiór technicznych: wyjazd/zjazd z bazy. */
  depotMeters: number;
  /** Podzbiór technicznych: przejazdy między krańcami, serwis. */
  transferMeters: number;
  revenueTrips: number;
  technicalTrips: number;
  /** Czy źródło ma jakiekolwiek kursy techniczne (podział ma sens). */
  hasTechnicalData: boolean;
  /** Ile kursów ma nieznaną długość (0 m). */
  missingLengthTrips: number;
}

const validLength = (value: number) =>
  Number.isFinite(value) && value > 0 ? value : 0;

/** Czysta funkcja — używana też w testach i w komponencie. */
export function summariseBrigade(trips: BrigadeMetricTrip[]): BrigadeMetrics {
  if (!trips.length) {
    return {
      trips: 0,
      durationMinutes: 0,
      drivingMinutes: 0,
      layoverMinutes: 0,
      totalMeters: 0,
      revenueMeters: 0,
      technicalMeters: 0,
      depotMeters: 0,
      transferMeters: 0,
      revenueTrips: 0,
      technicalTrips: 0,
      hasTechnicalData: false,
      missingLengthTrips: 0,
    };
  }
  const ordered = [...trips].sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
  );
  const first = ordered[0].startMs;
  const last = ordered.reduce(
    (max, trip) => Math.max(max, trip.endMs),
    ordered[0].endMs,
  );
  let driving = 0;
  let total = 0;
  let revenue = 0;
  let technical = 0;
  let depot = 0;
  let transfer = 0;
  let revenueTrips = 0;
  let technicalTrips = 0;
  let missing = 0;

  for (const trip of ordered) {
    const length = validLength(trip.length);
    if (!length) missing += 1;
    driving += Math.max(0, trip.endMs - trip.startMs);
    total += length;
    if (isTechnicalLine(trip.lineId)) {
      technical += length;
      technicalTrips += 1;
      if (isDepotLine(trip.lineId)) depot += length;
      else transfer += length;
    } else {
      revenue += length;
      revenueTrips += 1;
    }
  }

  const durationMinutes = Math.max(0, Math.round((last - first) / 60_000));
  const drivingMinutes = Math.round(driving / 60_000);
  return {
    trips: ordered.length,
    durationMinutes,
    drivingMinutes,
    layoverMinutes: Math.max(0, durationMinutes - drivingMinutes),
    totalMeters: total,
    revenueMeters: revenue,
    technicalMeters: technical,
    depotMeters: depot,
    transferMeters: transfer,
    revenueTrips,
    technicalTrips,
    hasTechnicalData: technicalTrips > 0,
    missingLengthTrips: missing,
  };
}

/** Liczba km bez zbędnych zer, np. 12,4 km. */
export function formatKilometres(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return "0 km";
  const km = meters / 1000;
  const digits = km < 10 ? 1 : km < 100 ? 1 : 0;
  return `${km.toLocaleString("pl-PL", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
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
      Array.isArray(pair) && pair.every(Number.isFinite) && pair[1] >= pair[0],
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
