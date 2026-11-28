import type { CoursePreview } from "./engine/gtfsStore";

export type NavPoint = [number, number];

export type CourseManeuverKind =
  | "depart"
  | "straight"
  | "slight-left"
  | "left"
  | "sharp-left"
  | "slight-right"
  | "right"
  | "sharp-right"
  | "uturn"
  | "arrive";

export interface CourseNavStop {
  index: number;
  number: number;
  name: string;
  lat: number;
  lon: number;
  alongMeters: number;
  arrivalMs: number | null;
  departureMs: number | null;
  afterMidnight?: boolean;
}

export interface CourseNavManeuver {
  kind: CourseManeuverKind;
  instruction: string;
  alongMeters: number;
  lat: number;
  lon: number;
  nearStopName?: string;
}

export interface CourseNavRoute {
  id: string;
  routeShort: string;
  headsign: string;
  dutyCode: string;
  title: string;
  color: string;
  textColor: string;
  hasScheduleTimes: boolean;
  startMs: number | null;
  endMs: number | null;
  path: NavPoint[];
  cumMeters: number[];
  totalMeters: number;
  stops: CourseNavStop[];
  maneuvers: CourseNavManeuver[];
}

export interface CourseNavOverlayInput {
  title: string;
  color: string;
  polylines: [number, number][][];
  stops: Array<{ name: string; lat: number; lon: number; sequence?: number }>;
  course?: CoursePreview;
}

export interface CourseNavGpsFix {
  lat: number;
  lon: number;
  accuracy?: number;
  speedKmh?: number | null;
  heading?: number | null;
}

export interface CourseNavState {
  mode: "gps" | "sim";
  position: NavPoint;
  snappedPoint: NavPoint;
  bearing: number;
  alongMeters: number;
  remainingMeters: number;
  progress: number;
  finished: boolean;
  offRoute: boolean;
  offRouteMeters: number;
  bearingToRoute: number;
  passedStopCount: number;
  nextStopIndex: number;
  nextStop: CourseNavStop | null;
  followingStop: CourseNavStop | null;
  distanceToNextStopMeters: number;
  atStopZone: boolean;
  nextManeuver: CourseNavManeuver;
  distanceToManeuverMeters: number;
  /** Konwencja jak w delay.ts: > 0 = opóźnienie (-m:ss), < 0 = przyspieszenie (+m:ss), 0 = planowo. */
  scheduleDeltaSeconds: number | null;
  plannedClockAtNextStopMs: number | null;
  splitPath: {
    passed: NavPoint[];
    remaining: NavPoint[];
  };
}

const M_PER_DEG_LAT = 111_320;

function metersPerDegLon(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

export function navDistanceMeters(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const kx = metersPerDegLon((aLat + bLat) / 2);
  const dx = (bLon - aLon) * kx;
  const dy = (bLat - aLat) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

export function navBearingDeg(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const kx = metersPerDegLon((aLat + bLat) / 2);
  const dx = (bLon - aLon) * kx;
  const dy = (bLat - aLat) * M_PER_DEG_LAT;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return 0;
  const rad = Math.atan2(dx, dy);
  return ((rad * 180) / Math.PI + 360) % 360;
}

function normalizeDeltaDeg(delta: number): number {
  let d = ((delta + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

function projectPointOnSegment(
  lat: number,
  lon: number,
  a: NavPoint,
  b: NavPoint,
): { t: number; lat: number; lon: number; distMeters: number } {
  const kx = metersPerDegLon((a[0] + b[0]) / 2);
  const bx = (b[1] - a[1]) * kx;
  const by = (b[0] - a[0]) * M_PER_DEG_LAT;
  const px = (lon - a[1]) * kx;
  const py = (lat - a[0]) * M_PER_DEG_LAT;
  const lenSq = bx * bx + by * by;
  const raw = lenSq > 0 ? (px * bx + py * by) / lenSq : 0;
  const t = Math.min(1, Math.max(0, raw));
  const distMeters = Math.hypot(px - t * bx, py - t * by);
  return {
    t,
    lat: a[0] + t * (b[0] - a[0]),
    lon: a[1] + t * (b[1] - a[1]),
    distMeters,
  };
}

/** Łączy wieloodcinkowe polilinie w jedną spójną ścieżkę bez duplikatów sąsiednich wierzchołków. */
function buildContinuousPath(
  polylines: [number, number][][],
  fallbackStops: Array<{ lat: number; lon: number }>,
): NavPoint[] {
  const raw: NavPoint[] = [];
  for (const seg of polylines) {
    for (const pt of seg) {
      if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
      const prev = raw[raw.length - 1];
      if (!prev || navDistanceMeters(prev[0], prev[1], pt[0], pt[1]) >= 0.8) {
        raw.push([pt[0], pt[1]]);
      }
    }
  }
  if (raw.length >= 2) return raw;
  return fallbackStops.map((s) => [s.lat, s.lon]);
}

function buildCumulativeMeters(path: NavPoint[]): number[] {
  const cum = [0];
  for (let i = 1; i < path.length; i += 1) {
    const step = navDistanceMeters(
      path[i - 1][0],
      path[i - 1][1],
      path[i][0],
      path[i][1],
    );
    cum.push(cum[i - 1] + step);
  }
  return cum;
}

export function pointAtCourseMeters(
  path: NavPoint[],
  cumMeters: number[],
  targetMeters: number,
): { point: NavPoint; bearing: number; segIndex: number } {
  if (path.length === 0) {
    return { point: [50.7714, 16.2843], bearing: 0, segIndex: 0 };
  }
  if (path.length === 1) {
    return { point: path[0], bearing: 0, segIndex: 0 };
  }
  const total = cumMeters[cumMeters.length - 1] ?? 0;
  const clamped = Math.max(0, Math.min(total, targetMeters));

  let lo = 0;
  let hi = cumMeters.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cumMeters[mid] <= clamped) lo = mid;
    else hi = mid - 1;
  }

  const segIndex = lo;
  const segStart = cumMeters[segIndex];
  const segLen = Math.max(0, cumMeters[segIndex + 1] - segStart);
  const t = segLen > 1e-6 ? Math.min(1, Math.max(0, (clamped - segStart) / segLen)) : 0;
  const a = path[segIndex];
  const b = path[segIndex + 1];
  return {
    point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
    bearing: navBearingDeg(a[0], a[1], b[0], b[1]),
    segIndex,
  };
}

function splitPolylineAtMeters(
  path: NavPoint[],
  cumMeters: number[],
  alongMeters: number,
): { passed: NavPoint[]; remaining: NavPoint[] } {
  if (path.length < 2) {
    return { passed: [], remaining: path };
  }
  const total = cumMeters[cumMeters.length - 1] ?? 0;
  if (alongMeters <= 3) {
    return { passed: [], remaining: path };
  }
  if (alongMeters >= total - 3) {
    return { passed: path, remaining: [] };
  }
  const { point, segIndex } = pointAtCourseMeters(path, cumMeters, alongMeters);
  const passed: NavPoint[] = path.slice(0, segIndex + 1);
  const lastPassed = passed[passed.length - 1];
  if (!lastPassed || navDistanceMeters(lastPassed[0], lastPassed[1], point[0], point[1]) > 0.5) {
    passed.push(point);
  }
  const remaining: NavPoint[] = [point];
  for (let i = segIndex + 1; i < path.length; i += 1) {
    const pt = path[i];
    const prev = remaining[remaining.length - 1];
    if (navDistanceMeters(prev[0], prev[1], pt[0], pt[1]) > 0.5) {
      remaining.push(pt);
    }
  }
  return { passed, remaining };
}

/** Monotoniczne rzutowanie kolejnych przystanków 1..N na polilinię kursu (obsługa pętli i wjazdów kieszeniowych). */
function projectStopsAlongPath(
  rawStops: Array<{
    name: string;
    lat: number;
    lon: number;
    arrivalMs?: number | null;
    departureMs?: number | null;
    afterMidnight?: boolean;
  }>,
  path: NavPoint[],
  cumMeters: number[],
): CourseNavStop[] {
  if (!rawStops.length) return [];
  const total = cumMeters[cumMeters.length - 1] ?? 0;
  if (path.length < 2 || total <= 0) {
    return rawStops.map((s, index) => ({
      index,
      number: index + 1,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      alongMeters: 0,
      arrivalMs: s.arrivalMs ?? null,
      departureMs: s.departureMs ?? null,
      afterMidnight: s.afterMidnight,
    }));
  }

  let minSeg = 0;
  let minAlong = 0;

  return rawStops.map((stop, index) => {
    if (index === 0) {
      return {
        index,
        number: 1,
        name: stop.name,
        lat: stop.lat,
        lon: stop.lon,
        alongMeters: 0,
        arrivalMs: stop.arrivalMs ?? null,
        departureMs: stop.departureMs ?? null,
        afterMidnight: stop.afterMidnight,
      };
    }
    if (index === rawStops.length - 1) {
      return {
        index,
        number: index + 1,
        name: stop.name,
        lat: stop.lat,
        lon: stop.lon,
        alongMeters: total,
        arrivalMs: stop.arrivalMs ?? null,
        departureMs: stop.departureMs ?? null,
        afterMidnight: stop.afterMidnight,
      };
    }

    let bestScore = Infinity;
    let bestAlong = minAlong;
    let bestSeg = minSeg;

    for (let i = minSeg; i < path.length - 1; i += 1) {
      const proj = projectPointOnSegment(stop.lat, stop.lon, path[i], path[i + 1]);
      const segLen = cumMeters[i + 1] - cumMeters[i];
      const along = cumMeters[i] + proj.t * segLen;
      if (along + 8 < minAlong) continue;
      // Lekka preferencja bliższego odcinka w przód, żeby na pętlach nie przeskoczyć na powrót
      const forwardJumpPenalty = Math.max(0, along - minAlong - 2400) * 0.018;
      const score = proj.distMeters + forwardJumpPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestAlong = Math.max(minAlong, along);
        bestSeg = i;
      }
    }

    minSeg = bestSeg;
    minAlong = bestAlong;

    return {
      index,
      number: index + 1,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      alongMeters: bestAlong,
      arrivalMs: stop.arrivalMs ?? null,
      departureMs: stop.departureMs ?? null,
      afterMidnight: stop.afterMidnight,
    };
  });
}

function classifyTurn(turnDeg: number): {
  kind: CourseManeuverKind;
  verb: string;
} | null {
  const abs = Math.abs(turnDeg);
  if (abs < 34) return null;
  if (abs >= 158) {
    return { kind: "uturn", verb: "Zawróć" };
  }
  if (turnDeg > 0) {
    if (abs >= 122) return { kind: "sharp-right", verb: "Ostro w prawo" };
    if (abs >= 56) return { kind: "right", verb: "Skręć w prawo" };
    return { kind: "slight-right", verb: "Trzymaj się prawej" };
  }
  if (abs >= 122) return { kind: "sharp-left", verb: "Ostro w lewo" };
  if (abs >= 56) return { kind: "left", verb: "Skręć w lewo" };
  return { kind: "slight-left", verb: "Trzymaj się lewej" };
}

/** Wyciąga czytelne manewry drogowe bezpośrednio z geometrii trasy kursu. */
export function extractCourseManeuvers(
  path: NavPoint[],
  cumMeters: number[],
  stops: CourseNavStop[],
): CourseNavManeuver[] {
  const total = cumMeters[cumMeters.length - 1] ?? 0;
  if (path.length < 2) return [];

  const firstStopName = stops[0]?.name;
  const lastStopName = stops[stops.length - 1]?.name;

  const maneuvers: CourseNavManeuver[] = [
    {
      kind: "depart",
      instruction: firstStopName
        ? `Ruszaj z przystanku: ${firstStopName}`
        : "Ruszaj po wyznaczonej trasie linii",
      alongMeters: 0,
      lat: path[0][0],
      lon: path[0][1],
      nearStopName: firstStopName,
    },
  ];

  const LOOK_WINDOW_M = 28;
  const MIN_GAP_M = 55;

  let lastAddedAlong = 20;
  let lastTurnAbs = 0;

  for (let i = 1; i < path.length - 1; i += 1) {
    const centerAlong = cumMeters[i];
    if (centerAlong < 25 || centerAlong > total - 25) continue;

    const before = pointAtCourseMeters(
      path,
      cumMeters,
      Math.max(0, centerAlong - LOOK_WINDOW_M),
    ).point;
    const center = path[i];
    const after = pointAtCourseMeters(
      path,
      cumMeters,
      Math.min(total, centerAlong + LOOK_WINDOW_M),
    ).point;

    const d1 = navDistanceMeters(before[0], before[1], center[0], center[1]);
    const d2 = navDistanceMeters(center[0], center[1], after[0], after[1]);
    if (d1 < 8 || d2 < 8) continue;

    const inBearing = navBearingDeg(before[0], before[1], center[0], center[1]);
    const outBearing = navBearingDeg(center[0], center[1], after[0], after[1]);
    const delta = normalizeDeltaDeg(outBearing - inBearing);
    const classified = classifyTurn(delta);
    if (!classified) continue;

    const upcomingStop = stops.find(
      (s) => s.alongMeters >= centerAlong - 20 && s.alongMeters <= centerAlong + 160,
    );
    const streetHint = upcomingStop
      ? upcomingStop.name.split(" - ")[0]?.trim()
      : undefined;
    const instruction = streetHint
      ? `${classified.verb} (kier. ${streetHint})`
      : classified.verb;

    const absTurn = Math.abs(delta);
    if (centerAlong - lastAddedAlong < MIN_GAP_M && maneuvers.length > 1) {
      if (absTurn > lastTurnAbs) {
        maneuvers[maneuvers.length - 1] = {
          kind: classified.kind,
          instruction,
          alongMeters: centerAlong,
          lat: center[0],
          lon: center[1],
          nearStopName: upcomingStop?.name,
        };
        lastAddedAlong = centerAlong;
        lastTurnAbs = absTurn;
      }
      continue;
    }

    maneuvers.push({
      kind: classified.kind,
      instruction,
      alongMeters: centerAlong,
      lat: center[0],
      lon: center[1],
      nearStopName: upcomingStop?.name,
    });
    lastAddedAlong = centerAlong;
    lastTurnAbs = absTurn;
  }

  const endPt = path[path.length - 1];
  maneuvers.push({
    kind: "arrive",
    instruction: lastStopName
      ? `Koniec kursu: ${lastStopName}`
      : "Koniec trasy kursu",
    alongMeters: total,
    lat: endPt[0],
    lon: endPt[1],
    nearStopName: lastStopName,
  });

  return maneuvers;
}

/** Buduje gotową strukturę nawigacji z podglądu kursu (`CoursePreview`) albo z dowolnej nakładki linii (`KursowkaShapeOverlay`). */
export function buildCourseNavRoute(
  input: CoursePreview | CourseNavOverlayInput,
): CourseNavRoute | null {
  if ("tripId" in input) {
    const course = input;
    const path = buildContinuousPath(
      course.polylines.length ? course.polylines : course.path.length ? [course.path] : [],
      course.stops,
    );
    if (path.length < 2) return null;
    const cumMeters = buildCumulativeMeters(path);
    const stops = projectStopsAlongPath(course.stops, path, cumMeters);
    const maneuvers = extractCourseManeuvers(path, cumMeters, stops);
    const hasScheduleTimes = stops.some(
      (s) => typeof s.departureMs === "number" && s.departureMs > 0,
    );
    return {
      id: `${course.tripId}|${course.dateId}`,
      routeShort: course.routeShort,
      headsign: course.headsign || stops[stops.length - 1]?.name || course.routeLong,
      dutyCode: course.dutyCode || "",
      title: `Linia ${course.routeShort} → ${course.headsign || stops[stops.length - 1]?.name || ""}`,
      color: course.color || "#0d4f3b",
      textColor: course.textColor || "#ffffff",
      hasScheduleTimes,
      startMs: hasScheduleTimes ? course.startMs : null,
      endMs: hasScheduleTimes ? course.endMs : null,
      path,
      cumMeters,
      totalMeters: cumMeters[cumMeters.length - 1] ?? 0,
      stops,
      maneuvers,
    };
  }

  if (input.course) {
    return buildCourseNavRoute(input.course);
  }

  const path = buildContinuousPath(input.polylines, input.stops);
  if (path.length < 2) return null;
  const cumMeters = buildCumulativeMeters(path);
  const stops = projectStopsAlongPath(input.stops, path, cumMeters);
  const maneuvers = extractCourseManeuvers(path, cumMeters, stops);
  const lineMatch = input.title.match(/Linia\s+([^\s·]+)/i);
  const routeShort = lineMatch?.[1] ?? "•";
  const headsign = stops[stops.length - 1]?.name ?? input.title;

  return {
    id: `overlay:${input.title}`,
    routeShort,
    headsign,
    dutyCode: "",
    title: input.title,
    color: input.color || "#0d4f3b",
    textColor: "#ffffff",
    hasScheduleTimes: false,
    startMs: null,
    endMs: null,
    path,
    cumMeters,
    totalMeters: cumMeters[cumMeters.length - 1] ?? 0,
    stops,
    maneuvers,
  };
}

/** Rzutuje pozycję GPS na trasę kursu z pamięcią postępu (nie przeskakuje wstecz na pętlach). */
export function projectGpsOntoCourse(
  route: CourseNavRoute,
  lat: number,
  lon: number,
  prevAlongMeters = 0,
): {
  snapped: NavPoint;
  alongMeters: number;
  offsetMeters: number;
  bearing: number;
} {
  let bestScore = Infinity;
  let bestDist = Infinity;
  let bestAlong = prevAlongMeters;
  let bestPoint: NavPoint = route.path[0];
  let bestBearing = 0;

  for (let i = 0; i < route.path.length - 1; i += 1) {
    const a = route.path[i];
    const b = route.path[i + 1];
    const proj = projectPointOnSegment(lat, lon, a, b);
    const segLen = route.cumMeters[i + 1] - route.cumMeters[i];
    const along = route.cumMeters[i] + proj.t * segLen;

    // Delikatna kara za skok o kilometr wstecz lub kilka km w przód na skrzyżowaniu pętli
    const deltaAlong = along - prevAlongMeters;
    const loopBias =
      deltaAlong < -120
        ? Math.min(90, Math.abs(deltaAlong) * 0.035)
        : deltaAlong > 1800
          ? Math.min(70, (deltaAlong - 1800) * 0.02)
          : 0;

    const score = proj.distMeters + loopBias;
    if (score < bestScore) {
      bestScore = score;
      bestDist = proj.distMeters;
      bestAlong = along;
      bestPoint = [proj.lat, proj.lon];
      bestBearing = navBearingDeg(a[0], a[1], b[0], b[1]);
    }
  }

  return {
    snapped: bestPoint,
    alongMeters: bestAlong,
    offsetMeters: bestDist,
    bearing: bestBearing,
  };
}

function interpolatePlannedTimeMs(
  route: CourseNavRoute,
  alongMeters: number,
): number | null {
  if (!route.hasScheduleTimes || route.stops.length === 0) return null;
  const stops = route.stops;
  if (alongMeters <= stops[0].alongMeters) {
    return stops[0].departureMs ?? stops[0].arrivalMs;
  }
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i];
    const b = stops[i + 1];
    if (alongMeters <= b.alongMeters || i === stops.length - 2) {
      const tA = a.departureMs ?? a.arrivalMs;
      const tB = b.arrivalMs ?? b.departureMs;
      if (tA == null || tB == null) return tB ?? tA ?? null;
      const span = Math.max(1, b.alongMeters - a.alongMeters);
      const ratio = Math.min(1, Math.max(0, (alongMeters - a.alongMeters) / span));
      return tA + ratio * (tB - tA);
    }
  }
  const last = stops[stops.length - 1];
  return last.arrivalMs ?? last.departureMs;
}

export function evaluateCourseNavigation(params: {
  route: CourseNavRoute;
  mode: "gps" | "sim";
  gps: CourseNavGpsFix | null;
  simMeters: number;
  prevAlongMeters: number;
  manualStopOffset?: number;
  nowMs: number;
  startedAtMs: number;
  punctualityMode: "schedule" | "relative";
}): CourseNavState {
  const {
    route,
    mode,
    gps,
    simMeters,
    prevAlongMeters,
    manualStopOffset = 0,
    nowMs,
    startedAtMs,
    punctualityMode,
  } = params;

  let alongMeters = 0;
  let position: NavPoint = route.path[0];
  let snappedPoint: NavPoint = route.path[0];
  let bearing = 0;
  let offRoute = false;
  let offRouteMeters = 0;
  let bearingToRoute = 0;

  if (mode === "gps" && gps) {
    const proj = projectGpsOntoCourse(route, gps.lat, gps.lon, prevAlongMeters);
    alongMeters = proj.alongMeters;
    snappedPoint = proj.snapped;
    offRouteMeters = proj.offsetMeters;
    const threshold = Math.max(65, (gps.accuracy ?? 15) * 1.35);
    offRoute = offRouteMeters > threshold;
    position = offRoute ? [gps.lat, gps.lon] : proj.snapped;
    bearing =
      typeof gps.heading === "number" && Number.isFinite(gps.heading) && (gps.speedKmh ?? 0) >= 3
        ? gps.heading
        : proj.bearing;
    bearingToRoute = offRoute
      ? navBearingDeg(gps.lat, gps.lon, proj.snapped[0], proj.snapped[1])
      : proj.bearing;
  } else {
    alongMeters = Math.max(0, Math.min(route.totalMeters, simMeters));
    const at = pointAtCourseMeters(route.path, route.cumMeters, alongMeters);
    position = at.point;
    snappedPoint = at.point;
    bearing = at.bearing;
    bearingToRoute = at.bearing;
  }

  const remainingMeters = Math.max(0, route.totalMeters - alongMeters);
  const progress =
    route.totalMeters > 0 ? Math.min(1, Math.max(0, alongMeters / route.totalMeters)) : 0;
  const finished = remainingMeters <= 18;

  // Wyznacz następny przystanek (z tolerancją 22 m po minięciu słupka)
  let autoNextIdx = route.stops.findIndex((s) => s.alongMeters > alongMeters + 22);
  if (autoNextIdx === -1) {
    autoNextIdx = Math.max(0, route.stops.length - 1);
  }
  const nextStopIndex = Math.min(
    Math.max(0, autoNextIdx + manualStopOffset),
    Math.max(0, route.stops.length - 1),
  );
  const passedStopCount = finished ? route.stops.length : nextStopIndex;
  const nextStop = route.stops[nextStopIndex] ?? null;
  const followingStop = route.stops[nextStopIndex + 1] ?? null;
  const distanceToNextStopMeters = nextStop
    ? offRoute && gps
      ? navDistanceMeters(gps.lat, gps.lon, nextStop.lat, nextStop.lon)
      : Math.max(0, nextStop.alongMeters - alongMeters)
    : 0;
  const atStopZone = !offRoute && distanceToNextStopMeters <= 40;

  // Wybierz najbliższy manewr przed pojazdem
  const upcomingManeuver =
    route.maneuvers.find((m) => m.alongMeters >= alongMeters + 12) ??
    route.maneuvers[route.maneuvers.length - 1];
  const distanceToManeuverMeters = Math.max(
    0,
    upcomingManeuver.alongMeters - alongMeters,
  );

  // Odchyłka od rozkładu (jak na sterowniku w autobusie)
  let scheduleDeltaSeconds: number | null = null;
  const plannedMs = interpolatePlannedTimeMs(route, alongMeters);
  if (plannedMs !== null && route.startMs !== null) {
    const referenceNowMs =
      punctualityMode === "relative"
        ? route.startMs + Math.max(0, nowMs - startedAtMs)
        : nowMs;
    scheduleDeltaSeconds = Math.round((referenceNowMs - plannedMs) / 1000);
  }

  const plannedClockAtNextStopMs = nextStop
    ? (nextStop.index === route.stops.length - 1
        ? nextStop.arrivalMs ?? nextStop.departureMs
        : nextStop.departureMs ?? nextStop.arrivalMs)
    : null;

  const splitPath = splitPolylineAtMeters(
    route.path,
    route.cumMeters,
    alongMeters,
  );

  return {
    mode,
    position,
    snappedPoint,
    bearing,
    alongMeters,
    remainingMeters,
    progress,
    finished,
    offRoute,
    offRouteMeters,
    bearingToRoute,
    passedStopCount,
    nextStopIndex,
    nextStop,
    followingStop,
    distanceToNextStopMeters,
    atStopZone,
    nextManeuver: upcomingManeuver,
    distanceToManeuverMeters,
    scheduleDeltaSeconds,
    plannedClockAtNextStopMs,
    splitPath,
  };
}

export function computeCoursePunctuality(
  route: CourseNavRoute,
  alongMeters: number,
  nowMs: number,
  startedAtMs: number,
  punctualityMode: "schedule" | "relative",
): number | null {
  const plannedMs = interpolatePlannedTimeMs(route, alongMeters);
  if (plannedMs === null || route.startMs === null) return null;
  const referenceNowMs =
    punctualityMode === "relative"
      ? route.startMs + Math.max(0, nowMs - startedAtMs)
      : nowMs;
  return Math.round((referenceNowMs - plannedMs) / 1000);
}

export function formatNavDistance(meters: number): string {
  const m = Math.max(0, Math.round(meters));
  if (m < 1000) {
    const rounded = m >= 100 ? Math.round(m / 10) * 10 : m;
    return `${rounded} m`;
  }
  const km = meters / 1000;
  return `${km.toFixed(1).replace(".", ",")} km`;
}
