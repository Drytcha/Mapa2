import { distanceCoords } from "./core/spatial";
import type { RouteStep } from "./types";

/**
 * Statyczne strzałki kierunku dla wyznaczonej trasy.
 *
 * Zastępują animowaną „płynącą” linię: bez animacji, bez ruchu. Strzałki
 * pojawiają się:
 *  - przy skrętach/skrzyżowaniach (manewry z OSRM),
 *  - na odcinkach, które trasa przejeżdża dwa razy w przeciwnych kierunkach
 *    (ta sama ulica w obie strony) — wtedy widać oba kierunki,
 *  - awaryjnie na długich prostych bez skrętów, żeby kierunek był czytelny.
 *
 * Wszystko jest liczone raz z geometrii trasy — bez timera i bez animacji CSS.
 */

export type RouteArrowKind = "turn" | "reverse" | "straight";

export interface RouteArrowPoint {
  lat: number;
  lon: number;
  /** Kurs w stopniach: 0 = północ, 90 = wschód. */
  bearing: number;
  kind: RouteArrowKind;
  /** Odległość od początku trasy (m) — do porządkowania i testów. */
  distance: number;
  /** Krótki opis do title/aria, np. „skręt w prawo”. */
  label: string;
}

export interface RouteArrowOptions {
  /** Minimalny odstęp między strzałkami (m). */
  minGapMeters?: number;
  /** Górny limit strzałek, żeby trasa nie zamieniła się w sznur znaczników. */
  maxArrows?: number;
  /** Odstęp strzałek na odcinku jechanym w obie strony (m). */
  reverseSpacingMeters?: number;
  /** Maksymalna cisza bez strzałki na prostej (m). */
  straightMaxGapMeters?: number;
}

const DEFAULTS = {
  minGapMeters: 55,
  maxArrows: 40,
  reverseSpacingMeters: 130,
  straightMaxGapMeters: 1100,
};

/** Odcinki krótsze niż to nie są kandydatami do „tej samej ulicy w obie strony”. */
const OVERLAP_METERS = 26;
const OPPOSITE_DOT = -0.6;
const TURN_OFFSET_METERS = 10;

const MANEUVER_LABELS: Record<string, string> = {
  left: "skręt w lewo",
  right: "skręt w prawo",
  "slight left": "lekko w lewo",
  "slight right": "lekko w prawo",
  "sharp left": "ostro w lewo",
  "sharp right": "ostro w prawo",
  straight: "prosto",
  uturn: "zawracanie",
  "u-turn": "zawracanie",
};

/** Czy manewr oznacza skrzyżowanie/skręt (a nie tylko zmianę nazwy ulicy). */
export function isTurnManeuver(step: Pick<RouteStep, "maneuver" | "modifier">): boolean {
  const maneuver = (step.maneuver ?? "").toLowerCase().trim();
  const modifier = (step.modifier ?? "").toLowerCase().trim();
  if (!maneuver) return false;
  if (["depart", "arrive", "continue", "new name", "notification"].includes(maneuver)) {
    return false;
  }
  if (/(^|[\s-])(turn|fork|roundabout|rotary|ramp|merge|uturn|u-turn)/.test(maneuver)) {
    // „prosto” na skrzyżowaniu nie zmienia kierunku — strzałka i tak jest
    // rysowana na prostej, więc nie dublujemy jej na manewrze.
    return modifier !== "straight";
  }
  return /left|right|uturn|u-turn/.test(maneuver) || /left|right|uturn/.test(modifier);
}

/** Opis manewru po polsku (do title/aria). */
export function maneuverArrowLabel(step: Pick<RouteStep, "maneuver" | "modifier">): string {
  const modifier = (step.modifier ?? "").toLowerCase().trim();
  if (modifier && MANEUVER_LABELS[modifier]) return MANEUVER_LABELS[modifier];
  const maneuver = (step.maneuver ?? "").toLowerCase();
  if (maneuver.includes("uturn") || maneuver.includes("u-turn")) return "zawracanie";
  if (maneuver.includes("roundabout") || maneuver.includes("rotary")) return "rondo";
  return "skrzyżowanie";
}

const toRad = Math.PI / 180;

/** Kurs (bearing) z punktu A do B w stopniach, 0 = północ, zgodnie z ruchem zegara. */
export function bearingBetween(
  a: [number, number],
  b: [number, number],
): number {
  const lat1 = a[0] * toRad;
  const lat2 = b[0] * toRad;
  const dLon = (b[1] - a[1]) * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

const isFiniteCoord = (point: [number, number]) =>
  Number.isFinite(point?.[0]) && Number.isFinite(point?.[1]);

/** Usuwa niepoprawne i powtórzone punkty (zero-length segmenty). */
function cleanCoords(coords: readonly [number, number][]): [number, number][] {
  const clean: [number, number][] = [];
  for (const point of coords) {
    if (!isFiniteCoord(point)) continue;
    const last = clean[clean.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    clean.push([point[0], point[1]]);
  }
  return clean;
}

function cumulativeDistances(points: readonly [number, number][]): number[] {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(
      cumulative[i - 1] +
        distanceCoords(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]),
    );
  }
  return cumulative;
}

function indexAtDistance(cumulative: readonly number[], meters: number): number {
  let low = 0;
  let high = cumulative.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (cumulative[mid] < meters) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Siatka punktów trasy (~66 m), żeby dopasować manewry bez skanowania całości. */
const GRID_DEGREES = 0.0006;

type PointGrid = Map<string, number[]>;

function buildPointGrid(points: readonly [number, number][]): PointGrid {
  const grid: PointGrid = new Map();
  const key = (lat: number, lon: number) =>
    `${Math.round(lat / GRID_DEGREES)}:${Math.round(lon / GRID_DEGREES)}`;
  for (let i = 0; i < points.length; i++) {
    const cell = key(points[i][0], points[i][1]);
    const list = grid.get(cell);
    if (list) list.push(i);
    else grid.set(cell, [i]);
  }
  return grid;
}

/** Indeks punktu najbliższego lokalizacji manewru (albo -1, gdy daleko od trasy). */
function nearestRouteIndex(
  points: readonly [number, number][],
  grid: PointGrid,
  location: [number, number],
  maxMeters: number,
): number {
  const centerLat = Math.round(location[0] / GRID_DEGREES);
  const centerLon = Math.round(location[1] / GRID_DEGREES);
  let best = -1;
  let bestDistance = maxMeters;
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -1; dLon <= 1; dLon++) {
      const list = grid.get(`${centerLat + dLat}:${centerLon + dLon}`);
      if (!list) continue;
      for (const index of list) {
        const distance = distanceCoords(
          location[0],
          location[1],
          points[index][0],
          points[index][1],
        );
        if (distance <= bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
    }
  }
  return best;
}

interface SegmentInfo {
  /** Wektor jednostkowy w lokalnym układzie: x = wschód, y = północ. */
  x: number;
  y: number;
  lat: number;
  lon: number;
}

function segmentInfo(
  a: [number, number],
  b: [number, number],
): SegmentInfo | null {
  const metersEast = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * toRad) * 111_320;
  const metersNorth = (b[0] - a[0]) * 110_540;
  const length = Math.hypot(metersEast, metersNorth);
  if (length < 0.5) return null;
  return {
    x: metersEast / length,
    y: metersNorth / length,
    lat: (a[0] + b[0]) / 2,
    lon: (a[1] + b[1]) / 2,
  };
}

/**
 * Odcinki, po których trasa jedzie dwa razy w przeciwnych kierunkach
 * (ta sama ulica w obie strony). Siatka zamiast porównań O(n²).
 */
export function twoWaySegments(points: readonly [number, number][]): boolean[] {
  const segments = new Array<boolean>(Math.max(0, points.length - 1)).fill(false);
  if (points.length < 6) return segments;
  const infos: Array<SegmentInfo | null> = [];
  for (let i = 0; i < points.length - 1; i++) {
    infos.push(segmentInfo(points[i], points[i + 1]));
  }
  const cellDegrees = 0.0006; // ok. 66 m
  const key = (lat: number, lon: number) =>
    `${Math.round(lat / cellDegrees)}:${Math.round(lon / cellDegrees)}`;
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    if (!info) continue;
    const bucket = key(info.lat, info.lon);
    const list = buckets.get(bucket) ?? [];
    list.push(i);
    buckets.set(bucket, list);
  }
  const neighbors = (lat: number, lon: number) => {
    const centerLat = Math.round(lat / cellDegrees);
    const centerLon = Math.round(lon / cellDegrees);
    const found: number[] = [];
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const list = buckets.get(`${centerLat + dLat}:${centerLon + dLon}`);
        if (list) found.push(...list);
      }
    }
    return found;
  };
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    if (!info) continue;
    for (const j of neighbors(info.lat, info.lon)) {
      // Sąsiednie odcinki tej samej ulicy to nie „dwa kierunki”.
      if (Math.abs(i - j) <= 4) continue;
      const other = infos[j];
      if (!other) continue;
      if (info.x * other.x + info.y * other.y > OPPOSITE_DOT) continue;
      const gap = distanceCoords(info.lat, info.lon, other.lat, other.lon);
      if (gap > OVERLAP_METERS) continue;
      segments[i] = true;
      segments[j] = true;
    }
  }
  return segments;
}

/**
 * Wylicza strzałki kierunku dla trasy. Zwraca maksymalnie `maxArrows` punktów
 * posortowanych od początku trasy.
 */
export function routeArrowPoints(
  coords: readonly [number, number][],
  steps: readonly RouteStep[] = [],
  options: RouteArrowOptions = {},
): RouteArrowPoint[] {
  const config = { ...DEFAULTS, ...options };
  const points = cleanCoords(coords);
  if (points.length < 2) return [];
  const cumulative = cumulativeDistances(points);
  const total = cumulative[cumulative.length - 1];
  if (!(total >= 40)) return [];

  const arrows: RouteArrowPoint[] = [];
  const nearestExisting = (distance: number) =>
    arrows.reduce((best, arrow) => Math.min(best, Math.abs(arrow.distance - distance)), Infinity);

  const push = (arrow: RouteArrowPoint, gap: number) => {
    if (arrows.length >= config.maxArrows) return false;
    if (nearestExisting(arrow.distance) < gap) return false;
    arrows.push(arrow);
    return true;
  };

  /** Punkt na trasie w zadanej odległości (z interpolacją w środku odcinka). */
  const pointAtDistance = (distance: number) => {
    const clamped = Math.max(0, Math.min(distance, total));
    const index = indexAtDistance(cumulative, clamped);
    if (index <= 0) {
      const segment = points.length > 1 ? bearingBetween(points[0], points[1]) : null;
      return segment == null
        ? null
        : { lat: points[0][0], lon: points[0][1], bearing: segment };
    }
    const previous = points[index - 1];
    const current = points[index];
    const segmentLength = cumulative[index] - cumulative[index - 1];
    if (!(segmentLength > 0.5)) return null;
    const ratio = (clamped - cumulative[index - 1]) / segmentLength;
    return {
      lat: previous[0] + (current[0] - previous[0]) * ratio,
      lon: previous[1] + (current[1] - previous[1]) * ratio,
      bearing: bearingBetween(previous, current),
    };
  };

  /** Strzałka w zadanym miejscu trasy. */
  const arrowAt = (
    distance: number,
    kind: RouteArrowKind,
    label: string,
    gap: number,
  ) => {
    const position = pointAtDistance(distance);
    if (!position) return false;
    return push(
      {
        lat: position.lat,
        lon: position.lon,
        bearing: position.bearing,
        kind,
        distance: Math.max(0, Math.min(distance, total)),
        label,
      },
      gap,
    );
  };

  // 1. Skrzyżowania i skręty z opisu manewrów OSRM.
  const grid = buildPointGrid(points);
  for (const step of steps) {
    if (!step.location || !isTurnManeuver(step)) continue;
    const index = nearestRouteIndex(points, grid, step.location, 70);
    if (index < 0) continue;
    // Strzałka tuż za skrzyżowaniem, nie w jego środku.
    arrowAt(
      cumulative[index] + TURN_OFFSET_METERS,
      "turn",
      maneuverArrowLabel(step),
      40,
    );
  }

  // 2. Ta sama ulica w obie strony — strzałki w obu kierunkach.
  const twoWay = twoWaySegments(points);
  let lastReverse = -Infinity;
  for (let i = 0; i < twoWay.length; i++) {
    if (!twoWay[i]) continue;
    const distance = cumulative[i];
    if (distance - lastReverse < config.reverseSpacingMeters) continue;
    if (
      arrowAt(distance, "reverse", "ten odcinek w obie strony", config.minGapMeters)
    ) {
      lastReverse = distance;
    }
  }

  // 3. Długie proste bez skrętów: pojedyncze strzałki, żeby kierunek był czytelny.
  const placed = arrows.map((arrow) => arrow.distance).sort((a, b) => a - b);
  const boundaries = [0, ...placed, total];
  for (let i = 1; i < boundaries.length; i++) {
    const from = boundaries[i - 1];
    const to = boundaries[i];
    const gap = to - from;
    if (gap < config.straightMaxGapMeters) continue;
    const count = Math.floor(gap / config.straightMaxGapMeters);
    for (let k = 0; k < count; k++) {
      arrowAt(
        from + (gap * (k + 0.5)) / count,
        "straight",
        "kierunek jazdy",
        config.minGapMeters,
      );
    }
  }

  // 4. Trasa bez ani jednej strzałki (np. schemat punktów): pokaż kierunek.
  if (!arrows.length) {
    const fractions = total > 1500 ? [0.3, 0.7] : [0.5];
    for (const fraction of fractions) {
      arrowAt(total * fraction, "straight", "kierunek jazdy", 0);
    }
  }

  return arrows.sort((a, b) => a.distance - b.distance);
}

/**
 * Ramię strzałki w układzie `viewBox="0 0 24 24"`. Grocik celuje w **górę**,
 * bo `rotate(0deg)` w CSS ma znaczyć „na północ" (bearing 0° = N).
 */
export const ROUTE_ARROW_PATH = "M4.6 15.6 L12 6.6 L19.4 15.6";

const ARROW_SIZES: Record<RouteArrowKind, number> = {
  turn: 22,
  reverse: 20,
  straight: 18,
};

/** Bok kwadratu ikony (px) — skręt jest największy, strzałka na prostej najmniejsza. */
export function routeArrowIconSize(arrow: RouteArrowPoint): number {
  return ARROW_SIZES[arrow.kind] ?? 20;
}

const escapeAttr = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

/**
 * HTML ikony strzałki (bez animacji!). Obrót = bearing trasy, więc grocik
 * zawsze pokazuje kierunek jazdy.
 */
export function routeArrowIconHtml(arrow: RouteArrowPoint): string {
  return (
    `<span class="route-arrow route-arrow--${arrow.kind}"` +
    ` style="transform:rotate(${arrow.bearing.toFixed(1)}deg)"` +
    ` title="${escapeAttr(arrow.label)}">` +
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    `<path class="route-arrow-casing" d="${ROUTE_ARROW_PATH}" />` +
    `<path class="route-arrow-body" d="${ROUTE_ARROW_PATH}" />` +
    "</svg></span>"
  );
}
