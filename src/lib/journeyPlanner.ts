/**
 * Planer połączeń dla pasażera — algorytm RAPTOR na rozkładzie GTFS Wałbrzycha
 * z korektą opóźnień z GPS.
 *
 *  • Punkt startowy i cel są dowolnymi współrzędnymi; planer dobiera przystanki
 *    w zasięgu dojścia po sieci dróg i ścieżek dla pieszych.
 *  • Każda kolejna runda szuka kursu OD GODZINY PRZYJAZDU na przystanek
 *    przesiadkowy (plus bufor na przesiadkę), nigdy od „teraz".
 *  • Przystanki i kursy pochodzą wprost z stop_times (po ID), więc kurs do
 *    innego krańca nigdy nie zostanie przypisany do przystanku o podobnej nazwie.
 *  • Wozy GPS: jeśli kurs ma pojazd na żywo, czasy są przesuwane o jego
 *    opóźnienie, a przystanki, które wóz już minął, nie są oferowane do wsiadania.
 */

import { DateTime } from "luxon";
import {
  ensureGtfsSeeded,
  type GtfsMemoryStore,
  type GtfsStopRecord,
} from "./engine/gtfsStore";
import type { LiveBusVehicle } from "./types";
import {
  getWalkingRoute,
  walkingKey,
  type WalkingPoint,
  type WalkingRoute,
} from "./walkingRouter";

export const JOURNEY_ZONE = "Europe/Warsaw";

const WALK_SPEED_MPS = 1.3;
const ACCESS_RADIUS_FALLBACK_M = 1600;
const TRANSFER_RADIUS_M = 320;
const SAME_STOP_TRANSFER_S = 90;
const BOARDING_BUFFER_S = 30;
const MAX_WALK_REFINEMENTS = 4;
const MAX_ROUNDS = 3; // ≤ 2 przesiadki
const MAX_JOURNEYS = 4;
const MAX_ITERATIONS = 10;
const SEARCH_WINDOW_S = 4 * 3600;
/** Górny limit sprawdzeń pieszych przy szukaniu prawdziwie najbliższego słupka. */
const MAX_NEAREST_ACCESS_CHECKS = 4;
/** Minimalna liczba zapytań o dojścia dla wariantów po sprawdzeniu najbliższych. */
const WALK_VERIFICATION_BUDGET = 6;
/** Przystanki w tym promieniu tworzą jeden węzeł dojścia (np. dwa kierunki ulicy). */
const SAME_ACCESS_GROUP_M = 50;
/** Kurs z dodatkową przesiadką musi być o tyle szybszy, by trafić na listę. */
const EXTRA_TRANSFER_GAIN_S = 300;
const INF = 0x7fffffff;

export interface JourneyPoint {
  lat: number;
  lon: number;
  label: string;
  stopId?: string;
}

export interface JourneyStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface JourneyWalkLeg {
  kind: "walk";
  role: "access" | "transfer" | "egress";
  from: { name: string; lat: number; lon: number };
  to: { name: string; lat: number; lon: number };
  meters: number;
  seconds: number;
  path: [number, number][];
  departMs: number;
  arriveMs: number;
}

export interface JourneyBusLeg {
  kind: "bus";
  tripId: string;
  routeShort: string;
  routeColor: string;
  routeTextColor: string;
  headsign: string;
  board: JourneyStop;
  alight: JourneyStop;
  departMs: number;
  arriveMs: number;
  scheduledDepartMs: number;
  scheduledArriveMs: number;
  /** Opóźnienie z GPS (s, dodatnie = spóźniony); null gdy brak wozu na żywo. */
  delaySeconds: number | null;
  live: LiveBusVehicle | null;
  stops: Array<JourneyStop & { atMs: number }>;
  path: [number, number][];
}

export type JourneyLeg = JourneyWalkLeg | JourneyBusLeg;

export interface Journey {
  id: string;
  legs: JourneyLeg[];
  departMs: number;
  arriveMs: number;
  transfers: number;
  walkMeters: number;
  /** Rzeczywiste dojście po sieci pieszej do pierwszego przystanku. */
  accessMeters: number;
  accessStop: JourneyStop;
  durationMinutes: number;
}

export interface JourneyPlan {
  journeys: Journey[];
  searchedFromMs: number;
  note: string | null;
  /** Najbliższy przystanek według potwierdzonego dojścia pieszego. */
  nearestAccess: { id: string; name: string; meters: number } | null;
}

/* -------------------------------------------------------------------------- */
/*  Geometria                                                                 */
/* -------------------------------------------------------------------------- */

const fastDist = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const dy = (lat2 - lat1) * 111_320;
  const dx =
    (lon2 - lon1) * 111_320 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.sqrt(dx * dx + dy * dy);
};

class JourneyWalking {
  routes = new Map<string, WalkingRoute | null>();

  cost(
    from: WalkingPoint,
    to: WalkingPoint,
    role: JourneyWalkLeg["role"],
    meters: number,
  ): WalkingRoute | null {
    if (from.lat === to.lat && from.lon === to.lon) {
      return { meters: 0, seconds: 0, path: [[from.lat, from.lon]] };
    }
    const route = this.routes.get(walkingKey(from, to));
    if (route === null) return null;
    if (route) {
      const maximum =
        role === "transfer" ? TRANSFER_RADIUS_M : ACCESS_RADIUS_FALLBACK_M;
      return route.meters <= maximum ? route : null;
    }
    // An optimistic search bound, never a displayed route. Every winning edge
    // must be replaced by a pedestrian-network path before results are returned.
    return { meters, seconds: Math.ceil(meters / WALK_SPEED_MPS), path: [] };
  }

  /**
   * Potwierdza piesze odcinki w kolejności ważności (najpierw najbliższy
   * przystanek). Limit chroni publiczną usługę i czas odpowiedzi.
   */
  async verify(journeys: Journey[], signal?: AbortSignal, maxEdges = Infinity) {
    const pending = new Map<string, JourneyWalkLeg>();
    for (const journey of journeys) {
      for (const leg of journey.legs) {
        if (leg.kind !== "walk" || leg.path.length) continue;
        const key = walkingKey(leg.from, leg.to);
        if (pending.has(key)) continue;
        if (pending.size >= maxEdges) break;
        pending.set(key, leg);
      }
      if (pending.size >= maxEdges) break;
    }
    let resolved = 0;
    for (const [key, leg] of pending) {
      signal?.throwIfAborted();
      this.routes.set(key, await getWalkingRoute(leg.from, leg.to, signal));
      resolved += 1;
    }
    return resolved;
  }

  async resolve(from: WalkingPoint, to: WalkingPoint, signal?: AbortSignal) {
    const key = walkingKey(from, to);
    if (this.routes.has(key)) return this.routes.get(key) ?? null;
    const route = await getWalkingRoute(from, to, signal);
    this.routes.set(key, route);
    return route;
  }
}

const CELL = 0.005;
const cellKey = (lat: number, lon: number) =>
  `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;

interface StopGraph {
  stops: GtfsStopRecord[];
  indexById: Map<string, number>;
  transfers: Array<Array<[number, number]>>;
  cells: Map<string, number[]>;
}

const graphCache = new WeakMap<GtfsMemoryStore, StopGraph>();

function nearbyIndices(
  cells: Map<string, number[]>,
  lat: number,
  lon: number,
  radius: number,
) {
  const dLat = radius / 111_320;
  const dLon = radius / (111_320 * Math.cos((lat * Math.PI) / 180));
  const out: number[] = [];
  for (
    let la = Math.floor((lat - dLat) / CELL);
    la <= Math.floor((lat + dLat) / CELL);
    la += 1
  ) {
    for (
      let lo = Math.floor((lon - dLon) / CELL);
      lo <= Math.floor((lon + dLon) / CELL);
      lo += 1
    ) {
      const bucket = cells.get(`${la}:${lo}`);
      if (bucket) out.push(...bucket);
    }
  }
  return out;
}

function getStopGraph(store: GtfsMemoryStore): StopGraph {
  const cached = graphCache.get(store);
  if (cached) return cached;
  const stops = store.base.stops.filter((s) =>
    store.base.activeStopIds.has(s.id),
  );
  const indexById = new Map<string, number>();
  const cells = new Map<string, number[]>();
  stops.forEach((s, i) => {
    indexById.set(s.id, i);
    const key = cellKey(s.lat, s.lon);
    const bucket = cells.get(key);
    if (bucket) bucket.push(i);
    else cells.set(key, [i]);
  });
  const transfers: Array<Array<[number, number]>> = stops.map(() => []);
  stops.forEach((s, i) => {
    for (const j of nearbyIndices(cells, s.lat, s.lon, TRANSFER_RADIUS_M)) {
      if (j === i) continue;
      const d = fastDist(s.lat, s.lon, stops[j].lat, stops[j].lon);
      if (d <= TRANSFER_RADIUS_M) transfers[i].push([j, Math.round(d)]);
    }
  });
  const graph = { stops, indexById, transfers, cells };
  graphCache.set(store, graph);
  return graph;
}

function stopsWithin(
  graph: StopGraph,
  lat: number,
  lon: number,
  radius: number,
) {
  const out: Array<[number, number]> = [];
  for (const i of nearbyIndices(graph.cells, lat, lon, radius)) {
    const s = graph.stops[i];
    const d = fastDist(lat, lon, s.lat, s.lon);
    if (d <= radius) out.push([i, Math.round(d)]);
  }
  return out.sort((a, b) => a[1] - b[1]);
}

/* -------------------------------------------------------------------------- */
/*  Rozkład dnia: wzorce tras (pattern = trasa + identyczna sekwencja przystanków) */
/* -------------------------------------------------------------------------- */

interface PatternTrip {
  tripId: string;
  runKey: string;
  headsign: string;
  shapeId: string | null;
  arr: Int32Array;
  dep: Int32Array;
  seq: Int32Array;
  noBoard: Uint8Array | null;
  noAlight: Uint8Array | null;
  startSec: number;
  endSec: number;
}

interface Pattern {
  routeId: string;
  routeShort: string;
  stops: Int32Array;
  trips: PatternTrip[];
}

interface Timetable {
  dateKey: number;
  dayStartMs: number;
  patterns: Pattern[];
  patternsByStop: Array<Array<[number, number]>>;
  runsByTripId: Map<string, Array<[number, number]>>;
  runsByRouteStart: Map<string, Array<[number, number]>>;
}

let timetableCache: {
  store: GtfsMemoryStore;
  dateKey: number;
  tt: Timetable;
} | null = null;

function buildTimetable(
  store: GtfsMemoryStore,
  graph: StopGraph,
  dayStart: DateTime,
): Timetable {
  const base = store.base;
  const dateKey = Number(dayStart.toFormat("yyyyMMdd"));
  const prevKey = Number(dayStart.minus({ days: 1 }).toFormat("yyyyMMdd"));
  const todaySvc = base.serviceIdsByDate.get(dateKey) ?? new Set<string>();
  const prevSvc = base.serviceIdsByDate.get(prevKey) ?? new Set<string>();

  const patternMap = new Map<string, Pattern>();
  const patterns: Pattern[] = [];

  const addRun = (trip: (typeof base.rawTrips)[number], offsetSec: number) => {
    const sts = base.rawStopTimesByTrip.get(trip.rawTripId);
    if (!sts || sts.length < 2) return;
    const kept = sts.filter((st) => graph.indexById.has(st.stopId));
    if (kept.length < 2) return;
    const stopIdx = kept.map((st) => graph.indexById.get(st.stopId)!);
    const key = `${trip.routeId}|${stopIdx.join(",")}`;
    let pattern = patternMap.get(key);
    if (!pattern) {
      pattern = {
        routeId: trip.routeId,
        routeShort: trip.routeShort,
        stops: Int32Array.from(stopIdx),
        trips: [],
      };
      patternMap.set(key, pattern);
      patterns.push(pattern);
    }
    const n = kept.length;
    const arr = new Int32Array(n);
    const dep = new Int32Array(n);
    const seq = new Int32Array(n);
    let noBoard: Uint8Array | null = null;
    let noAlight: Uint8Array | null = null;
    for (let i = 0; i < n; i += 1) {
      const st = kept[i];
      arr[i] = st.arrivalMinutes * 60 + offsetSec;
      dep[i] = Math.max(st.departureMinutes * 60 + offsetSec, arr[i]);
      seq[i] = st.stopSequence;
      if (st.pickupType === 1) {
        if (!noBoard) noBoard = new Uint8Array(n);
        noBoard[i] = 1;
      }
      if (st.dropOffType === 1) {
        if (!noAlight) noAlight = new Uint8Array(n);
        noAlight[i] = 1;
      }
    }
    pattern.trips.push({
      tripId: trip.rawTripId,
      runKey: `${trip.rawTripId}@${offsetSec}`,
      headsign: trip.headsign || trip.lastStopName,
      shapeId: trip.shapeId,
      arr,
      dep,
      seq,
      noBoard,
      noAlight,
      startSec: dep[0],
      endSec: arr[n - 1],
    });
  };

  for (const trip of base.rawTrips) {
    if (todaySvc.has(trip.serviceId)) addRun(trip, 0);
    if (prevSvc.has(trip.serviceId) && trip.endMinutes >= 24 * 60)
      addRun(trip, -86_400);
  }

  const patternsByStop: Array<Array<[number, number]>> = graph.stops.map(
    () => [],
  );
  const runsByTripId = new Map<string, Array<[number, number]>>();
  const runsByRouteStart = new Map<string, Array<[number, number]>>();
  patterns.forEach((pattern, p) => {
    pattern.trips.sort((a, b) => a.startSec - b.startSec);
    for (let i = 0; i < pattern.stops.length; i += 1) {
      patternsByStop[pattern.stops[i]].push([p, i]);
    }
    pattern.trips.forEach((trip, t) => {
      const byTrip = runsByTripId.get(trip.tripId);
      if (byTrip) byTrip.push([p, t]);
      else runsByTripId.set(trip.tripId, [[p, t]]);
      const startKey = `${pattern.routeShort.toUpperCase()}|${Math.round(trip.startSec / 60)}`;
      const byStart = runsByRouteStart.get(startKey);
      if (byStart) byStart.push([p, t]);
      else runsByRouteStart.set(startKey, [[p, t]]);
    });
  });

  return {
    dateKey,
    dayStartMs: dayStart.toMillis(),
    patterns,
    patternsByStop,
    runsByTripId,
    runsByRouteStart,
  };
}

function getTimetable(
  store: GtfsMemoryStore,
  graph: StopGraph,
  dayStart: DateTime,
): Timetable {
  const dateKey = Number(dayStart.toFormat("yyyyMMdd"));
  if (
    timetableCache &&
    timetableCache.store === store &&
    timetableCache.dateKey === dateKey
  ) {
    return timetableCache.tt;
  }
  const tt = buildTimetable(store, graph, dayStart);
  timetableCache = { store, dateKey, tt };
  return tt;
}

/* -------------------------------------------------------------------------- */
/*  Korekta z GPS                                                             */
/* -------------------------------------------------------------------------- */

interface LiveRun {
  delay: number;
  minBoardIdx: number;
  vehicle: LiveBusVehicle;
}

interface LiveAdjust {
  byRun: Map<string, LiveRun>;
}

function buildLiveAdjust(
  tt: Timetable,
  graph: StopGraph,
  buses: LiveBusVehicle[],
  nowSec: number,
): LiveAdjust {
  const byRun = new Map<string, LiveRun>();
  for (const bus of buses) {
    let runs: Array<[number, number]> | undefined;
    if (bus.tripId) runs = tt.runsByTripId.get(bus.tripId);
    if ((!runs || !runs.length) && bus.tripRouteShort && bus.tripStartMs) {
      const startMin = Math.round((bus.tripStartMs - tt.dayStartMs) / 60_000);
      runs = tt.runsByRouteStart.get(
        `${bus.tripRouteShort.toUpperCase()}|${startMin}`,
      );
    }
    if (!runs || !runs.length) continue;

    let pick = runs[0];
    if (runs.length > 1) {
      let bestGap = Infinity;
      for (const run of runs) {
        const trip = tt.patterns[run[0]].trips[run[1]];
        const mid = (trip.startSec + trip.endSec) / 2;
        const gap = Math.abs(mid - nowSec);
        if (gap < bestGap) {
          bestGap = gap;
          pick = run;
        }
      }
    }
    const pattern = tt.patterns[pick[0]];
    const trip = pattern.trips[pick[1]];

    let minBoardIdx = 0;
    const nextSeq = bus.upcomingStops?.[0]?.sequence;
    if (typeof nextSeq === "number" && Number.isFinite(nextSeq)) {
      let idx = -1;
      for (let i = 0; i < trip.seq.length; i += 1) {
        if (trip.seq[i] >= nextSeq) {
          idx = i;
          break;
        }
      }
      minBoardIdx = idx < 0 ? trip.seq.length : idx;
    } else if (Number.isFinite(bus.lat) && Number.isFinite(bus.lon)) {
      let bestI = 0;
      let bestD = Infinity;
      for (let i = 0; i < pattern.stops.length; i += 1) {
        const s = graph.stops[pattern.stops[i]];
        const d = fastDist(bus.lat, bus.lon, s.lat, s.lon);
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      minBoardIdx = bestI;
    }

    byRun.set(trip.runKey, {
      delay: Math.round(
        Number.isFinite(bus.delaySeconds) ? bus.delaySeconds : 0,
      ),
      minBoardIdx,
      vehicle: bus,
    });
  }
  return { byRun };
}

/* -------------------------------------------------------------------------- */
/*  RAPTOR                                                                    */
/* -------------------------------------------------------------------------- */

type Parent =
  | { type: "origin"; meters: number; round: 0 }
  | { type: "walk"; from: number; meters: number; round: number }
  | {
      type: "bus";
      p: number;
      t: number;
      boardIdx: number;
      alightIdx: number;
      round: number;
    };

interface RaptorHit {
  round: number;
  stop: number;
  arrival: number;
}

function earliestTrip(
  pattern: Pattern,
  stopIdx: number,
  ready: number,
  live: LiveAdjust,
): [number, number] | null {
  const trips = pattern.trips;
  if (!trips.length) return null;

  let bestIdx = -1;
  let bestDep = INF;
  let bestDelay = 0;
  // GPS delays can reorder departures; sorting by the start of a trip is not
  // sufficient for binary search or an early break at an intermediate stop.
  for (let t = 0; t < trips.length; t += 1) {
    const trip = trips[t];
    const adj = live.byRun.get(trip.runKey);
    const delay = adj ? adj.delay : 0;
    if (adj && stopIdx < adj.minBoardIdx) continue;
    if (trip.noBoard && trip.noBoard[stopIdx]) continue;
    const dep = trip.dep[stopIdx] + delay;
    if (dep < ready) continue;
    if (dep < bestDep) {
      bestDep = dep;
      bestIdx = t;
      bestDelay = delay;
    }
  }
  return bestIdx >= 0 ? [bestIdx, bestDelay] : null;
}

function runRaptor(
  tt: Timetable,
  graph: StopGraph,
  access: Array<[number, number]>,
  egress: Array<[number, number]>,
  departSec: number,
  live: LiveAdjust,
  walking: JourneyWalking,
  origin: JourneyPoint,
  destination: JourneyPoint,
  horizonSec: number,
): { hits: RaptorHit[]; parents: Array<Array<Parent | null>> } {
  const n = graph.stops.length;
  const best = new Int32Array(n).fill(INF);
  const tau: Int32Array[] = [new Int32Array(n).fill(INF)];
  const parents: Array<Array<Parent | null>> = [
    new Array<Parent | null>(n).fill(null),
  ];
  let marked = new Set<number>();

  for (const [s, meters] of access) {
    const walk = walking.cost(origin, graph.stops[s], "access", meters);
    if (!walk) continue;
    const t = departSec + walk.seconds;
    if (t < tau[0][s]) {
      tau[0][s] = t;
      best[s] = t;
      parents[0][s] = { type: "origin", meters, round: 0 };
      marked.add(s);
    }
  }

  const egressWalk: Array<[number, number]> = [];
  for (const [s, m] of egress) {
    const walk = walking.cost(graph.stops[s], destination, "egress", m);
    if (walk) egressWalk.push([s, walk.seconds]);
  }
  let bestDest = INF;
  const hits: RaptorHit[] = [];

  for (let k = 1; k <= MAX_ROUNDS && marked.size; k += 1) {
    tau[k] = Int32Array.from(tau[k - 1]);
    parents[k] = parents[k - 1].slice();

    const queue = new Map<number, number>();
    for (const s of marked) {
      for (const [p, i] of tt.patternsByStop[s]) {
        const cur = queue.get(p);
        if (cur === undefined || i < cur) queue.set(p, i);
      }
    }
    marked = new Set<number>();

    for (const [p, startIdx] of queue) {
      const pattern = tt.patterns[p];
      const stops = pattern.stops;
      let trip: PatternTrip | null = null;
      let tripIdx = -1;
      let boardIdx = -1;
      let tripDelay = 0;

      for (let i = startIdx; i < stops.length; i += 1) {
        const s = stops[i];
        if (trip) {
          const arrT = trip.arr[i] + tripDelay;
          const canAlight = !(trip.noAlight && trip.noAlight[i]);
          if (canAlight && arrT < best[s] && arrT < bestDest) {
            tau[k][s] = arrT;
            best[s] = arrT;
            parents[k][s] = {
              type: "bus",
              p,
              t: tripIdx,
              boardIdx,
              alightIdx: i,
              round: k,
            };
            marked.add(s);
          }
        }
        const prevT = tau[k - 1][s];
        if (prevT === INF) continue;
        const prevParent = parents[k - 1][s];
        const ready =
          prevT +
          (prevParent?.type === "origin"
            ? BOARDING_BUFFER_S
            : SAME_STOP_TRANSFER_S);
        if (trip && ready >= trip.dep[i] + tripDelay) continue;
        const found = earliestTrip(pattern, i, ready, live);
        if (
          found &&
          pattern.trips[found[0]].dep[i] + found[1] <= horizonSec &&
          (!trip ||
            pattern.trips[found[0]].dep[i] + found[1] < trip.dep[i] + tripDelay)
        ) {
          tripIdx = found[0];
          trip = pattern.trips[tripIdx];
          tripDelay = found[1];
          boardIdx = i;
        }
      }
    }

    const reachedByBus = Array.from(marked, (s) => [s, tau[k][s]] as const);
    for (const [s, base] of reachedByBus) {
      for (const [t, meters] of graph.transfers[s]) {
        const walk = walking.cost(
          graph.stops[s],
          graph.stops[t],
          "transfer",
          meters,
        );
        if (!walk) continue;
        const nt = base + walk.seconds;
        if (nt < best[t] && nt < bestDest) {
          tau[k][t] = nt;
          best[t] = nt;
          parents[k][t] = { type: "walk", from: s, meters, round: k };
          marked.add(t);
        }
      }
    }

    let roundBest = INF;
    let roundStop = -1;
    for (const [s, w] of egressWalk) {
      if (tau[k][s] === INF) continue;
      const c = tau[k][s] + w;
      if (c < roundBest) {
        roundBest = c;
        roundStop = s;
      }
    }
    if (roundStop >= 0 && roundBest < bestDest) {
      bestDest = roundBest;
      hits.push({ round: k, stop: roundStop, arrival: roundBest });
    }
  }

  return { hits, parents };
}

/* -------------------------------------------------------------------------- */
/*  Rekonstrukcja i materializacja                                            */
/* -------------------------------------------------------------------------- */

interface ChainItem {
  parent: Parent;
  stop: number;
}

function reconstruct(
  tt: Timetable,
  parents: Array<Array<Parent | null>>,
  hit: RaptorHit,
): ChainItem[] | null {
  const chain: ChainItem[] = [];
  let cur = hit.stop;
  let round = hit.round;
  for (let guard = 0; guard < 32; guard += 1) {
    let parent = parents[round]?.[cur] ?? null;
    if (!parent) return null;
    if (parent.round < round) {
      round = parent.round;
      parent = parents[round]?.[cur] ?? null;
      if (!parent) return null;
    }
    chain.push({ parent, stop: cur });
    if (parent.type === "origin") break;
    if (parent.type === "walk") {
      cur = parent.from;
      continue;
    }
    cur = tt.patterns[parent.p].stops[parent.boardIdx];
    round = parent.round - 1;
  }
  chain.reverse();
  return chain[0]?.parent.type === "origin" ? chain : null;
}

function shapeSlice(
  shape: [number, number][],
  pts: [number, number][],
): [number, number][] | null {
  if (shape.length < 2 || pts.length < 2) return null;
  let from = 0;
  const idx: number[] = [];
  for (const pt of pts) {
    let bestI = -1;
    let bestD = Infinity;
    for (let i = from; i < shape.length; i += 1) {
      const d = fastDist(shape[i][0], shape[i][1], pt[0], pt[1]);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    if (bestI < 0 || bestD > 260) return null;
    idx.push(bestI);
    from = bestI;
  }
  const a = idx[0];
  const b = idx[idx.length - 1];
  if (b <= a) return null;
  return [pts[0], ...shape.slice(a + 1, b + 1), pts[pts.length - 1]];
}

function materialize(
  store: GtfsMemoryStore,
  tt: Timetable,
  graph: StopGraph,
  chain: ChainItem[],
  origin: JourneyPoint,
  destination: JourneyPoint,
  egressMeters: number,
  live: LiveAdjust,
  walking: JourneyWalking,
): Journey | null {
  const toMs = (sec: number) => tt.dayStartMs + sec * 1000;
  const stopOf = (idx: number): JourneyStop => {
    const s = graph.stops[idx];
    return { id: s.id, name: s.name, lat: s.lat, lon: s.lon };
  };

  const legs: JourneyLeg[] = [];
  const addWalk = (
    role: JourneyWalkLeg["role"],
    from: JourneyWalkLeg["from"],
    to: JourneyWalkLeg["to"],
    meters: number,
  ) => {
    const cost = walking.cost(from, to, role, meters);
    if (!cost) return false;
    legs.push({
      kind: "walk",
      role,
      from,
      to,
      ...cost,
      departMs: 0,
      arriveMs: 0,
    });
    return true;
  };
  for (const item of chain) {
    const parent = item.parent;
    if (parent.type === "origin") {
      if (
        !addWalk(
          "access",
          { name: origin.label, lat: origin.lat, lon: origin.lon },
          stopOf(item.stop),
          parent.meters,
        )
      )
        return null;
    } else if (parent.type === "walk") {
      if (
        !addWalk(
          "transfer",
          stopOf(parent.from),
          stopOf(item.stop),
          parent.meters,
        )
      )
        return null;
    } else {
      const pattern = tt.patterns[parent.p];
      const trip = pattern.trips[parent.t];
      const adj = live.byRun.get(trip.runKey);
      const delay = adj ? adj.delay : 0;
      const route = store.base.routesById.get(pattern.routeId);
      const stops: Array<JourneyStop & { atMs: number }> = [];
      for (let i = parent.boardIdx; i <= parent.alightIdx; i += 1) {
        stops.push({
          ...stopOf(pattern.stops[i]),
          atMs: toMs(
            (i === parent.boardIdx ? trip.dep[i] : trip.arr[i]) + delay,
          ),
        });
      }
      const coords = stops.map((s) => [s.lat, s.lon] as [number, number]);
      const shape = trip.shapeId
        ? store.base.shapesById.get(trip.shapeId)
        : undefined;
      const path = (shape && shapeSlice(shape, coords)) || coords;
      legs.push({
        kind: "bus",
        tripId: trip.tripId,
        routeShort: pattern.routeShort,
        routeColor: route?.color ?? "#0d4f3b",
        routeTextColor: route?.textColor ?? "#ffffff",
        headsign: trip.headsign,
        board: stops[0],
        alight: stops[stops.length - 1],
        departMs: toMs(trip.dep[parent.boardIdx] + delay),
        arriveMs: toMs(trip.arr[parent.alightIdx] + delay),
        scheduledDepartMs: toMs(trip.dep[parent.boardIdx]),
        scheduledArriveMs: toMs(trip.arr[parent.alightIdx]),
        delaySeconds: adj ? adj.delay : null,
        live: adj?.vehicle ?? null,
        stops,
        path,
      });
    }
  }

  const lastStopIdx = chain[chain.length - 1]?.stop;
  if (lastStopIdx === undefined) return null;
  if (
    !addWalk(
      "egress",
      stopOf(lastStopIdx),
      { name: destination.label, lat: destination.lat, lon: destination.lon },
      egressMeters,
    )
  )
    return null;

  if (!legs.some((leg) => leg.kind === "bus")) return null;

  /* Czas spacerów: dojście tak, by zdążyć na pierwszy wóz; dalej — od przyjazdu. */
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i];
    if (leg.kind !== "walk") continue;
    if (leg.role === "access") {
      const next = legs[i + 1];
      const arrive = next ? next.departMs - BOARDING_BUFFER_S * 1000 : 0;
      leg.arriveMs = arrive;
      leg.departMs = arrive - leg.seconds * 1000;
    } else {
      const prev = legs[i - 1];
      leg.departMs = prev ? prev.arriveMs : 0;
      leg.arriveMs = leg.departMs + leg.seconds * 1000;
    }
  }

  const busLegs = legs.filter(
    (leg): leg is JourneyBusLeg => leg.kind === "bus",
  );
  const walkMeters = legs.reduce(
    (sum, leg) => sum + (leg.kind === "walk" ? leg.meters : 0),
    0,
  );
  const accessLeg = legs.find(
    (leg): leg is JourneyWalkLeg =>
      leg.kind === "walk" && leg.role === "access",
  );
  if (!accessLeg) return null;
  const departMs = legs[0].departMs;
  const arriveMs = legs[legs.length - 1].arriveMs;
  for (let i = 1; i < legs.length; i += 1) {
    const current = legs[i];
    const previous = legs[i - 1];
    const buffer =
      current.kind === "bus"
        ? (previous.kind === "walk" && previous.role === "access"
            ? BOARDING_BUFFER_S
            : SAME_STOP_TRANSFER_S) * 1000
        : 0;
    if (
      current.departMs < previous.arriveMs + buffer ||
      current.arriveMs < current.departMs
    )
      return null;
  }
  return {
    id: busLegs
      .map((leg) => `${leg.tripId}:${leg.board.id}:${leg.alight.id}`)
      .join(">"),
    legs,
    departMs,
    arriveMs,
    transfers: busLegs.length - 1,
    walkMeters,
    accessMeters: accessLeg.meters,
    accessStop: busLegs[0].board,
    durationMinutes: Math.max(1, Math.round((arriveMs - departMs) / 60_000)),
  };
}

/* -------------------------------------------------------------------------- */
/*  API                                                                       */
/* -------------------------------------------------------------------------- */

export async function planJourneys(options: {
  origin: JourneyPoint;
  destination: JourneyPoint;
  departMs?: number;
  liveBuses: LiveBusVehicle[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<JourneyPlan> {
  const { origin, destination } = options;
  options.signal?.throwIfAborted();
  const store = await ensureGtfsSeeded();
  options.signal?.throwIfAborted();
  const graph = getStopGraph(store);
  const departMs = options.departMs ?? Date.now();
  const dayStart = DateTime.fromMillis(departMs, {
    zone: JOURNEY_ZONE,
  }).startOf("day");
  const tt = getTimetable(store, graph, dayStart);
  const departSec = Math.round((departMs - tt.dayStartMs) / 1000);
  const nowSec = Math.round((Date.now() - tt.dayStartMs) / 1000);

  if (!tt.patterns.length) {
    return {
      journeys: [],
      searchedFromMs: departMs,
      note: "Brak rozkładu jazdy na ten dzień w danych GTFS.",
      nearestAccess: null,
    };
  }

  const access = stopsWithin(
    graph,
    origin.lat,
    origin.lon,
    ACCESS_RADIUS_FALLBACK_M,
  ).filter(([s]) => !origin.stopId || graph.stops[s].id === origin.stopId);
  const egress = stopsWithin(
    graph,
    destination.lat,
    destination.lon,
    ACCESS_RADIUS_FALLBACK_M,
  ).filter(
    ([s]) => !destination.stopId || graph.stops[s].id === destination.stopId,
  );
  if (!access.length) {
    return {
      journeys: [],
      searchedFromMs: departMs,
      note: "W zasięgu spaceru (1,6 km) od punktu startowego nie ma czynnego przystanku.",
      nearestAccess: null,
    };
  }
  if (!egress.length) {
    return {
      journeys: [],
      searchedFromMs: departMs,
      note: "W zasięgu spaceru (1,6 km) od celu nie ma czynnego przystanku.",
      nearestAccess: null,
    };
  }

  const live = buildLiveAdjust(tt, graph, options.liveBuses, nowSec);
  const egressMeters = new Map(egress);
  const walking = new JourneyWalking();

  /* Pieszo sprawdzamy kilka najbliższych słupków. Dopiero rzeczywista trasa
     pozwala odróżnić przystanek 100 m od takiego, do którego jest 200 m drogą. */
  let nearestAccess: JourneyPlan["nearestAccess"] = null;
  const nearestAccessGroup: Array<[number, number]> = [];
  const verifiedAccess: Array<{ index: number; meters: number }> = [];
  let bestVerifiedMeters = Infinity;
  /* `access` jest posortowane po odległości w linii prostej. Droga nie może być
     krótsza niż prosta, więc gdy kolejny słupek jest dalej niż dotychczas
     potwierdzone dojście + 50 m, nie może już być bliżej i można przerwać. */
  for (
    let candidate = 0;
    candidate < access.length && candidate < MAX_NEAREST_ACCESS_CHECKS;
    candidate += 1
  ) {
    const [stopIndex, crowMeters] = access[candidate];
    if (crowMeters > bestVerifiedMeters + SAME_ACCESS_GROUP_M) break;
    const stop = graph.stops[stopIndex];
    options.signal?.throwIfAborted();
    options.onProgress?.(
      `Sprawdzam pieszo najbliższy przystanek: ${stop.name}...`,
    );
    const route = await walking.resolve(origin, stop, options.signal);
    if (route) {
      verifiedAccess.push({ index: stopIndex, meters: route.meters });
      bestVerifiedMeters = Math.min(bestVerifiedMeters, route.meters);
    }
  }
  verifiedAccess.sort((a, b) => a.meters - b.meters || a.index - b.index);
  if (verifiedAccess.length) {
    const closest = verifiedAccess[0];
    const closestStop = graph.stops[closest.index];
    nearestAccess = {
      id: closestStop.id,
      name: closestStop.name,
      meters: closest.meters,
    };
    for (const item of verifiedAccess) {
      if (item.meters > closest.meters + SAME_ACCESS_GROUP_M) continue;
      nearestAccessGroup.push([item.index, item.meters]);
    }
  } else {
    return {
      journeys: [],
      searchedFromMs: departMs,
      note: "Nie udało się potwierdzić dojścia pieszego z punktu startowego po drogach lub ścieżkach. Przesuń start na chodnik, ulicę albo przystanek — nie prowadzimy trasy przez teren.",
      nearestAccess: null,
    };
  }

  const collect = (
    accessStops: Array<[number, number]> = access,
    limit = MAX_JOURNEYS,
  ) => {
    const journeys: Journey[] = [];
    const seen = new Set<string>();
    const earliest =
      options.departMs === undefined
        ? Math.max(departSec, Math.ceil((Date.now() - tt.dayStartMs) / 1000))
        : departSec;
    let cursor = earliest;
    for (
      let iteration = 0;
      iteration < MAX_ITERATIONS && journeys.length < limit;
      iteration += 1
    ) {
      const { hits, parents } = runRaptor(
        tt,
        graph,
        accessStops,
        egress,
        cursor,
        live,
        walking,
        origin,
        destination,
        departSec + SEARCH_WINDOW_S,
      );
      if (!hits.length) break;
      const batch: Journey[] = [];
      let lastKeptArrival = INF;
      for (const hit of hits) {
        if (
          batch.length &&
          hit.arrival > lastKeptArrival - EXTRA_TRANSFER_GAIN_S
        )
          continue;
        const chain = reconstruct(tt, parents, hit);
        if (!chain) continue;
        const journey = materialize(
          store,
          tt,
          graph,
          chain,
          origin,
          destination,
          egressMeters.get(hit.stop) ?? 0,
          live,
          walking,
        );
        if (!journey || journey.departMs < tt.dayStartMs + earliest * 1000)
          continue;
        batch.push(journey);
        lastKeptArrival = hit.arrival;
      }
      if (!batch.length) break;
      let earliestLeave = INF;
      for (const journey of batch) {
        earliestLeave = Math.min(
          earliestLeave,
          Math.round((journey.departMs - tt.dayStartMs) / 1000),
        );
        if (!seen.has(journey.id)) {
          seen.add(journey.id);
          journeys.push(journey);
        }
      }
      cursor = Math.max(earliestLeave + 60, cursor + 60);
      if (cursor - departSec > SEARCH_WINDOW_S) break;
    }
    return journeys
      .sort((a, b) => a.departMs - b.departMs || a.arriveMs - b.arriveMs)
      .slice(0, limit);
  };

  const belongsToNearestGroup = (journey: Journey) =>
    nearestAccess !== null &&
    journey.accessMeters <= nearestAccess.meters + SAME_ACCESS_GROUP_M;
  const boardsAtNearest = (journey: Journey) =>
    nearestAccess !== null && journey.accessStop.id === nearestAccess.id;

  /**
   * Osobno szukamy połączenia z samego najbliższego przystanku i z jego
   * bezpośredniego węzła. Dzięki temu opcja z 100 m nie zniknie tylko dlatego,
   * że autobus z dalszego przystanku przyjeżdża wcześniej.
   * Domyślna kolejność: dokładnie najbliższy → węzeł do 50 m → pozostałe.
   */
  const collectPreferred = () => {
    const strictNearestIndex = verifiedAccess[0]?.index;
    const strictNearestJourneys =
      strictNearestIndex === undefined
        ? []
        : collect([[strictNearestIndex, verifiedAccess[0].meters]], 2);
    const groupJourneys =
      nearestAccessGroup.length > 1 ? collect(nearestAccessGroup, 2) : [];
    const allJourneys = collect(access, MAX_JOURNEYS + 2);
    const unique = new Map<string, Journey>();
    for (const journey of [
      ...strictNearestJourneys,
      ...groupJourneys,
      ...allJourneys,
    ]) {
      if (!unique.has(journey.id)) unique.set(journey.id, journey);
    }
    const rank = (journey: Journey) =>
      boardsAtNearest(journey) ? 0 : belongsToNearestGroup(journey) ? 1 : 2;
    return [...unique.values()]
      .sort((a, b) => {
        const rankGap = rank(a) - rank(b);
        if (rankGap !== 0) return rankGap;
        if (rank(a) === 1) {
          return a.accessMeters - b.accessMeters || a.arriveMs - b.arriveMs;
        }
        return a.arriveMs - b.arriveMs || a.departMs - b.departMs;
      })
      .slice(0, MAX_JOURNEYS);
  };

  const nearestNote = (journeys: Journey[]): string | null => {
    if (!nearestAccess || !journeys.length) return null;
    // Drugi słupek tego samego węzła (do 50 m) traktujemy jak ten sam przystanek.
    if (journeys.some(belongsToNearestGroup)) return null;
    const first = journeys[0];
    return `Najbliższy przystanek „${nearestAccess.name}” (${nearestAccess.meters} m pieszo) nie ma połączenia do celu w podanym czasie. Najbliższe dostępne połączenie odjeżdża z „${first.accessStop.name}” (${first.accessMeters} m pieszo).`;
  };

  // Refine only candidate walking edges, then search again with measured times.
  // A longer road approach can invalidate boarding or require a later transfer.
  // The budget stops public-routing request storms while still confirming the
  // nearest stop and its first alternatives.
  let walkBudget = WALK_VERIFICATION_BUDGET;
  let fallback: Journey[] = [];
  for (let pass = 0; pass < MAX_WALK_REFINEMENTS; pass += 1) {
    options.signal?.throwIfAborted();
    const journeys = collectPreferred();
    const pending = journeys.some((j) =>
      j.legs.some((leg) => leg.kind === "walk" && !leg.path.length),
    );
    if (!pending) {
      fallback = journeys;
      break;
    }
    if (walkBudget <= 0) break;
    options.onProgress?.(
      "Sprawdzam dojścia i przesiadki po drogach i ścieżkach...",
    );
    const used = await walking.verify(journeys, options.signal, walkBudget);
    walkBudget -= used;
    const verified = collectPreferred().filter((journey) =>
      journey.legs.every((leg) => leg.kind !== "walk" || leg.path.length > 0),
    );
    if (verified.length) fallback = verified;
    if (used === 0) break;
  }

  const finalJourneys = collectPreferred().filter((journey) =>
    journey.legs.every((leg) => leg.kind !== "walk" || leg.path.length > 0),
  );
  const journeys = finalJourneys.length ? finalJourneys : fallback;
  return {
    journeys,
    searchedFromMs: departMs,
    note: journeys.length
      ? nearestNote(journeys)
      : nearestAccess
        ? `Najbliższy przystanek „${nearestAccess.name}” nie ma połączenia do celu w ciągu 4 godzin.`
        : "Brak połączenia z potwierdzonym dojściem pieszym w ciągu 4 godzin. Sprawdź położenie punktów przy drodze lub ścieżce.",
    nearestAccess,
  };
}

/* -------------------------------------------------------------------------- */
/*  Geometria dla mapy                                                        */
/* -------------------------------------------------------------------------- */

export interface JourneyMapLeg {
  kind: "walk" | "bus";
  path: [number, number][];
  color?: string;
  label?: string;
}

export interface JourneyMapMarker {
  kind: "board" | "alight";
  lat: number;
  lon: number;
  label: string;
  routeShort?: string;
  color?: string;
  textColor?: string;
}

export function journeyToMapGeometry(journey: Journey): {
  legs: JourneyMapLeg[];
  markers: JourneyMapMarker[];
} {
  const legs: JourneyMapLeg[] = [];
  const markers: JourneyMapMarker[] = [];
  for (const leg of journey.legs) {
    if (leg.kind === "walk") {
      if (leg.meters < 15) continue;
      legs.push({
        kind: "walk",
        path: leg.path,
        label: `Pieszo: ${leg.meters} m, około ${Math.ceil(leg.seconds / 60)} min`,
      });
      continue;
    }
    legs.push({
      kind: "bus",
      path: leg.path,
      color: leg.routeColor,
      label: `Linia ${leg.routeShort} → ${leg.headsign}`,
    });
    markers.push({
      kind: "board",
      lat: leg.board.lat,
      lon: leg.board.lon,
      label: leg.board.name,
      routeShort: leg.routeShort,
      color: leg.routeColor,
      textColor: leg.routeTextColor,
    });
    markers.push({
      kind: "alight",
      lat: leg.alight.lat,
      lon: leg.alight.lon,
      label: leg.alight.name,
    });
  }
  return { legs, markers };
}
