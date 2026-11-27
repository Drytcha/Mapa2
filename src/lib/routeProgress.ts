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
  /** Przedział odcinków między ostatnim i kolejnym przystankiem. */
  minIndex?: number;
  maxIndex?: number;
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

  const firstIndex = Math.max(0, options.minIndex ?? 0);
  const lastIndex = Math.min(path.length - 2, options.maxIndex ?? path.length - 2);
  const candidates: Array<{ index: number; meters: number; lat: number; lon: number }> = [];
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = firstIndex; i <= lastIndex; i += 1) {
    const projected = projectOnSegment(bus, path[i], path[i + 1]);
    candidates.push({ index: i, meters: projected.meters, lat: projected.lat, lon: projected.lon });
    nearest = Math.min(nearest, projected.meters);
  }
  let best: typeof candidates[number] | null = null;
  for (const candidate of candidates) {
    if (candidate.meters > maxOffRoute || candidate.meters > nearest + (nearIndex === null ? 0 : TIE_METERS)) continue;
    if (!best || (nearIndex !== null && Math.abs(candidate.index - nearIndex) < Math.abs(best.index - nearIndex)) ||
      (nearIndex === null && candidate.meters < best.meters)) best = candidate;
  }
  if (!best || best.meters > maxOffRoute) return null;

  const point: RoutePoint = [best.lat, best.lon];
  const passed: RoutePoint[] = path.slice(0, best.index + 1);
  const lastPassed = passed[passed.length - 1];
  if (lastPassed[0] !== point[0] || lastPassed[1] !== point[1]) passed.push(point);

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
  if (passedMeters < minPart && remainingMeters < minPart) return null;
  // Na krańcach nie zostawiamy białej obwódki bez koloru: cała geometria
  // należy do jednego z odcinków, aż drugi stanie się wystarczająco długi.
  const startPassed = passedMeters < minPart ? [] : remainingMeters < minPart ? [...path] : passed;
  const startRemaining = remainingMeters < minPart ? [] : passedMeters < minPart ? [...path] : remaining;

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
export const PAST_ROUTE_COLOR = { light: "#6b6b6b", dark: "#b8b8b8" } as const;

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

/**
 * Gdy pozycja GPS jest zbyt daleko od kształtu, rysujemy postęp tylko do
 * ostatniego potwierdzonego przystanku. Jest to dolne oszacowanie, nie GPS.
 */
export function splitRouteAtLastPassedStop(
  path: readonly RoutePoint[],
  stops: ReadonlyArray<{ lat: number; lon: number; sequence?: number }>,
  nextSequence: number | undefined,
  options: Pick<SplitRouteOptions, "nearIndex"> = {},
): RouteProgress | null {
  if (nextSequence == null || !Number.isFinite(nextSequence) || !stops.length) return null;
  const knownStops = stops.filter((stop) => stop.sequence != null && Number.isFinite(stop.sequence));
  if (!knownStops.some((stop) => stop.sequence === nextSequence)) return null;
  const passed = knownStops.filter((stop) => stop.sequence! < nextSequence);
  if (!passed.length) {
    return path.length >= 2 ? { index: 0, point: path[0], offsetMeters: 0, passed: [], remaining: [...path] } : null;
  }
  const last = passed[passed.length - 1];
  return splitRouteAtBus(path, last, options);
}

/**
 * Kolejne przystanki przyporządkowane do geometrii w kolejności kursu.
 * Pomaga wybrać właściwą nitkę, gdy autobus wraca tą samą ulicą.
 * Przy niezgodnych danych zwracamy null zamiast narzucać błędny przedział.
 */
export function routeStopAnchors(
  path: readonly RoutePoint[],
  stops: ReadonlyArray<{ lat: number; lon: number; sequence?: number }>,
): number[] | null {
  if (path.length < 2 || stops.length < 2) return null;
  const result: number[] = [];
  let position = 0;
  for (let stopIndex = 0; stopIndex < stops.length; stopIndex += 1) {
    const stop = stops[stopIndex];
    let best: { index: number; t: number; meters: number } | null = null;
    for (let i = Math.floor(position); i < path.length - 1; i += 1) {
      const p = projectOnSegment(stop, path[i], path[i + 1]);
      if (i + p.t + 1e-8 < position) continue;
      if (!best || p.meters < best.meters - 0.01 ||
          (stopIndex === stops.length - 1 && Math.abs(p.meters - best.meters) <= 0.01)) {
        best = { index: i, t: p.t, meters: p.meters };
      }
    }
    if (!best || best.meters > DEFAULT_MAX_OFF_ROUTE_M) return null;
    position = best.index + best.t;
    result.push(best.index);
  }
  return result;
}

/** Zakres segmentów geometrii pomiędzy potwierdzonymi przystankami kursu. */
export function stopSegmentRange(
  stops: ReadonlyArray<{ sequence?: number }>, anchors: readonly number[] | null, nextSequence: number | undefined,
): { minIndex: number; maxIndex: number } | null {
  if (!anchors || anchors.length !== stops.length || nextSequence == null) return null;
  const next = stops.findIndex((stop) => stop.sequence === nextSequence);
  if (next < 0) return null;
  return { minIndex: next > 0 ? anchors[next - 1] : 0, maxIndex: anchors[next] };
}

/* -------------------------------------------------------------------------- */
/*  Trasa „do przystanku"                                                     */
/* -------------------------------------------------------------------------- */

export interface StopDwell {
  arrivalMs: number;
  departureMs: number;
}

/** Przystanek kursu: punkt na mapie i godziny rozkładowe. */
export type TimedStop = { lat: number; lon: number } & StopDwell;

export interface CourseUpToStop {
  /** Geometria od startu kursu do wybranego przystanku (włącznie z tym przystankiem). */
  path: RoutePoint[];
  /** Indeks przystanku, na którym kończy się trasa (0 = start kursu). */
  stopIndex: number;
  meters: number;
  /** Czas jazdy według rozkładu do tego przystanku (ms). */
  rideMs: number;
  departMs: number;
  arriveMs: number;
}

/**
 * Wycinek przebiegu kursu **do wybranego przystanku** — nie tylko do końca.
 *
 * Pasażer chce wiedzieć, jak dojedzie do swojego przystanku, a nie do pętli.
 * Stąd dwie zasady:
 *  - geometrię tniemy dokładnie pod wybranym przystankiem (rzut na odcinek
 *    trasy, a nie na najbliższy wierzchołek), więc linia nie urywa się
 *    kilkaset metrów przed przystankiem;
 *  - gdy tego samego dnia kurs jedzie tą ulicą dwa razy (pętla, „tam i z
 *    powrotem”), bierzemy **pierwsze** dojechanie do przystanku — to jest
 *    trasa do przystanku, a nie objazd całej pętli.
 *
 * Zwraca `null`, gdy przystanek nie leży na geometrii (rozwichrzone dane) —
 * lepiej nie rysować niczego niż oznaczyć pasażerowi niewłaściwy autobus.
 */
export function courseUpToStop(
  path: readonly RoutePoint[],
  stops: readonly TimedStop[],
  stopIndex: number,
): CourseUpToStop | null {
  if (path.length < 2 || !stops.length) return null;
  if (!Number.isInteger(stopIndex) || stopIndex < 0 || stopIndex >= stops.length) return null;
  const target = stops[stopIndex];

  // Rzut przystanku na geometrię — punkt, w którym kończymy trasę. Dla
  // przystanku końcowego bierzemy ostatnie trafienie (pętla na końcu trasy),
  // dla pozostałych pierwsze (przystanek obsługiwany w drodze „tam").
  const lastHit = stopIndex === stops.length - 1;
  let best: { index: number; meters: number; lat: number; lon: number } | null = null;
  for (let i = 0; i < path.length - 1; i += 1) {
    const projected = projectOnSegment(target, path[i], path[i + 1]);
    if (projected.meters > DEFAULT_MAX_OFF_ROUTE_M) continue;
    if (!best || projected.meters < best.meters - 0.01 || lastHit) {
      best = { index: i, meters: projected.meters, lat: projected.lat, lon: projected.lon };
    }
  }
  if (!best) return null;

  const cut: RoutePoint = [best.lat, best.lon];
  const result: RoutePoint[] = [];
  for (let i = 0; i <= best.index; i += 1) {
    const point = path[i];
    if (!result.length || !samePoint(result[result.length - 1], point)) result.push(point);
  }
  if (!samePoint(result[result.length - 1], cut)) result.push(cut);

  let meters = 0;
  for (let i = 0; i < result.length - 1; i += 1) {
    meters += distanceMeters(result[i][0], result[i][1], result[i + 1][0], result[i + 1][1]);
  }

  const departMs = stops[0].departureMs;
  // Na przystanku końcowym rozkład podaje przyjazd; wcześniej odjazd.
  const arriveMs = stopIndex === stops.length - 1 ? target.arrivalMs : target.departureMs;
  return {
    path: result,
    stopIndex,
    meters,
    rideMs: Math.max(0, arriveMs - departMs),
    departMs,
    arriveMs,
  };
}
