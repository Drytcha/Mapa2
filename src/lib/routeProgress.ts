/**
 * Podział przebiegu kursu na część **już przejechaną** przez autobus i część
 * **przed autobusem**. Dzięki temu na mapie widać jednym spojrzeniem, gdzie
 * pojazd jest w trasie: odcinek za nim rysujemy na szaro, a odcinek przed nim
 * na zielono.
 *
 * Podział liczymy na geometrii, a nie na przystankach: autobus bywa między
 * przystankami, a przy rzadkim próbkowaniu kształtu (`shapes.txt`) wierzchołki
 * są co kilkaset metrów. Dlatego punkt przecięcia jest rzutowany na najbliższy
 * **odcinek** trasy i wstawiany do obu połówek — linia jest ciągła, bez dziury
 * i bez „kresek”.
 */

export type RoutePoint = [number, number];

export interface RouteProgress {
  /** Indeks odcinka trasy, przy którym jest autobus (do zachowania ciągłości). */
  index: number;
  /** Punkt na trasie najbliższy autobusowi — wspólny koniec obu połówek. */
  point: RoutePoint;
  /** Odległość autobusu od trasy w metrach (GPS bywa niedokładny). */
  offsetMeters: number;
  /**
   * Trasa od początku kursu do autobusu. Pusta, gdy autobus dopiero startuje
   * (nie ma czego wyszarzać).
   */
  passed: RoutePoint[];
  /**
   * Trasa od autobusu do końca kursu. Pusta na końcu kursu — wtedy cała trasa
   * jest już przejechana i rysuje się na szaro.
   */
  remaining: RoutePoint[];
}

export interface SplitRouteOptions {
  /**
   * Ostatnio użyty odcinek. Gdy trasa przecina tę samą ulicę dwa razy (pętla,
   * trasa „tam i z powrotem”), wybieramy odcinek najbliższy poprzedniemu, żeby
   * granica „przejechane / przed nami” nie przeskakiwała na drugą nitkę.
   */
  nearIndex?: number | null;
  /** Powyżej tej odległości uznajemy, że GPS nie trzyma się trasy (brak podziału). */
  maxOffRouteMeters?: number;
  /** Krótszy odcinek nie jest rysowany jako osobny kolor (za mało pikseli). */
  minPartMeters?: number;
}

const M_PER_DEG_LAT = 111_320;
const DEFAULT_MAX_OFF_ROUTE_M = 250;
const DEFAULT_MIN_PART_M = 8;
/** Odcinki równie bliskie autobusowi (np. dwie nitki tej samej ulicy). */
const TIE_METERS = 20;

const metersPerDegLon = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

function distanceMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const kx = metersPerDegLon((aLat + bLat) / 2);
  const dx = (bLon - aLon) * kx;
  const dy = (bLat - aLat) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

function samePoint(a: RoutePoint, b: RoutePoint): boolean {
  return distanceMeters(a[0], a[1], b[0], b[1]) < 0.5;
}

/** Rzut punktu na odcinek A–B w lokalnym układzie metrycznym. */
function projectOnSegment(
  point: { lat: number; lon: number },
  a: RoutePoint,
  b: RoutePoint,
): { t: number; lat: number; lon: number; meters: number } {
  const kx = metersPerDegLon((a[0] + b[0]) / 2);
  const bx = (b[1] - a[1]) * kx;
  const by = (b[0] - a[0]) * M_PER_DEG_LAT;
  const px = (point.lon - a[1]) * kx;
  const py = (point.lat - a[0]) * M_PER_DEG_LAT;
  const lengthSq = bx * bx + by * by;
  const raw = lengthSq > 0 ? (px * bx + py * by) / lengthSq : 0;
  const t = Math.min(1, Math.max(0, raw));
  const meters = Math.hypot(px - t * bx, py - t * by);
  return {
    t,
    lat: a[0] + (b[0] - a[0]) * t,
    lon: a[1] + (b[1] - a[1]) * t,
    meters,
  };
}

/**
 * Dzieli trasę w miejscu, w którym jest autobus. Zwraca `null`, gdy nie da się
 * tego zrobić sensownie (za krótka trasa albo autobus daleko od trasy). Na
 * starcie kursu `passed` jest puste, na końcu — puste jest `remaining`.
 */
export function splitRouteAtBus(
  path: readonly RoutePoint[],
  bus: { lat: number; lon: number },
  options: SplitRouteOptions = {},
): RouteProgress | null {
  if (path.length < 2) return null;
  const maxOffRoute = options.maxOffRouteMeters ?? DEFAULT_MAX_OFF_ROUTE_M;
  const minPart = options.minPartMeters ?? DEFAULT_MIN_PART_M;
  const nearIndex = options.nearIndex ?? null;

  let best: { index: number; meters: number; lat: number; lon: number } | null = null;
  for (let i = 0; i < path.length - 1; i += 1) {
    const projected = projectOnSegment(bus, path[i], path[i + 1]);
    if (!best || projected.meters < best.meters) {
      best = { index: i, meters: projected.meters, lat: projected.lat, lon: projected.lon };
      continue;
    }
    // Równie bliski odcinek: przy pętli wybieramy ten bliżej poprzedniego podziału.
    if (
      nearIndex !== null &&
      Math.abs(projected.meters - best.meters) <= TIE_METERS &&
      Math.abs(i - nearIndex) < Math.abs(best.index - nearIndex)
    ) {
      best = { index: i, meters: projected.meters, lat: projected.lat, lon: projected.lon };
    }
  }
  if (!best || best.meters > maxOffRoute) return null;

  const point: RoutePoint = [best.lat, best.lon];
  const passed: RoutePoint[] = path.slice(0, best.index + 1);
  if (!samePoint(passed[passed.length - 1], point)) passed.push(point);

  const remaining: RoutePoint[] = [point];
  for (let i = best.index + 1; i < path.length; i += 1) {
    if (samePoint(remaining[remaining.length - 1], path[i])) continue;
    remaining.push(path[i]);
  }
  // Odcinki krótsze niż kilka metrów nie są warte osobnego koloru — zostawiamy
  // całą trasę w jednym kolorze, żeby nie tworzyć „kreski” przy autobusie.
  let passedMeters = 0;
  for (let i = 0; i < passed.length - 1; i += 1) {
    passedMeters += distanceMeters(passed[i][0], passed[i][1], passed[i + 1][0], passed[i + 1][1]);
  }
  let remainingMeters = 0;
  for (let i = 0; i < remaining.length - 1; i += 1) {
    remainingMeters += distanceMeters(
      remaining[i][0],
      remaining[i][1],
      remaining[i + 1][0],
      remaining[i + 1][1],
    );
  }
  const startPassed = passedMeters >= minPart ? passed : [];
  const startRemaining = remainingMeters >= minPart ? remaining : [];
  // Autobus dokładnie na starcie i na końcu trasy jednocześnie: brak podziału.
  if (!startPassed.length && !startRemaining.length) return null;
  if (startPassed.length === 1) startPassed.push(startRemaining[0] ?? point);
  if (startRemaining.length === 1) startRemaining.unshift(startPassed[startPassed.length - 1] ?? point);

  return {
    index: best.index,
    point,
    offsetMeters: best.meters,
    passed: startPassed,
    remaining: startRemaining,
  };
}

/**
 * Kolor odcinka już przejechanego: neutralna szarość (nie kolor innej linii),
 * czytelna na jasnych i ciemnych kafelkach.
 */
export const PAST_ROUTE_COLOR = { light: "#b0bcb4", dark: "#6b7b72" } as const;

export function pastRouteColor(dark: boolean): string {
  return dark ? PAST_ROUTE_COLOR.dark : PAST_ROUTE_COLOR.light;
}

/** Ten sam zielony kolor trasy i nieprzejechanych przystanków. */
export const FUTURE_ROUTE_COLOR = "#16803c";

/** GPS podaje numer kolejnego przystanku; bez niego nie zgadujemy postępu. */
export function liveStopProgress(sequence: number | undefined, nextSequence: number | undefined): "passed" | "upcoming" | "unknown" {
  if (sequence == null || nextSequence == null || !Number.isFinite(sequence) || !Number.isFinite(nextSequence)) return "unknown";
  return sequence < nextSequence ? "passed" : "upcoming";
}
