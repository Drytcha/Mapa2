/**
 * Katalog linii Wałbrzycha: dla każdej linii (2, 4, 5, 7 …) jej warianty tras
 * zbudowane z `shapes.txt` oraz ewentualnych zapisanych korekt Planisty — po
 * jednym wariancie na każdy odrębny kształt trasy.
 * Dane pochodzą z tej samej paczki GTFS co kursówki, więc linia 30 (od 1 grudnia)
 * i linie planistyczne S1–S4 są w niej, o ile są w paczce „GTFS (full).zip".
 */
import { DateTime } from "luxon";
import { polylineLengthMeters } from "../core/spatial";
import { WARSAW_ZONE } from "../core/time";
import {
  ensureGtfsSeeded,
  ensureShapesReady,
  resolveTripShape,
  shapeForTripStops,
  stopPointFor,
} from "./gtfsStore";
import {
  findLineRouteOverride,
  getOverridesRevision,
  getOverrideStatus,
  initLineRouteOverrides,
  type OverrideSyncStatus,
} from "./lineRouteOverrides";

type LatLng = [number, number];
type Store = Awaited<ReturnType<typeof ensureGtfsSeeded>>;
type RawTrip = Store["base"]["rawTrips"][number];

export interface LineVariant {
  /** shape_id (albo para przystanków, gdy kurs nie ma kształtu). */
  key: string;
  directionId: number;
  /** Kierunek = ostatni przystanek kursu z rozkładu (nie `trip_headsign`). */
  headsign: string;
  firstStopId: string;
  lastStopId: string;
  firstStop: string;
  lastStop: string;
  stopCount: number;
  /** Wszystkie kursy tego wariantu w całym feedzie. */
  tripCount: number;
  /** Kursy tego wariantu w dniu odniesienia linii (dzień roboczy). */
  refCount: number;
  /** Czy wariant w ogóle kursuje w dniu odniesienia (a nie tylko w innym okresie). */
  activeOnRef: boolean;
  lengthMeters: number;
  /** Kurs, z którego pochodzi geometria i lista przystanków. */
  representativeTripId: string;
  /** Pierwszy wariant danego kierunku, który kursuje w dniu odniesienia. */
  main: boolean;
  /** true = brak shapes.txt i brak korekty Planisty, trasa to łamana po przystankach. */
  approximate: boolean;
  /** Aktywna ścieżka (korekta Planisty albo oryginał GTFS). */
  path: LatLng[];
  /** Oryginalna ścieżka z GTFS (do podglądu porównawczego i przywrócenia w edytorze). */
  originalPath: LatLng[];
  /** true = wariant ma zapisany poprawiony przebieg z edytora Planisty. */
  customized: boolean;
  customStatus: OverrideSyncStatus;
  customNote?: string;
  customUpdatedAt?: string;
}

export interface LineEntry {
  shortName: string;
  longName: string;
  color: string;
  textColor: string;
  /** Pierwszy i ostatni dzień (YYYYMMDD), w którym linia ma jakikolwiek kurs. */
  from: number;
  to: number;
  /** Dzień roboczy użyty do policzenia kursów wariantów. */
  refDate: number;
  refTrips: number;
  variants: LineVariant[];
}

let cache: { base: unknown; overridesRevision: number; entries: LineEntry[] } | null = null;

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = "";
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export async function getLineCatalogue(): Promise<LineEntry[]> {
  void initLineRouteOverrides();
  const store = await ensureGtfsSeeded();
  // Warianty linii rysują się po `shapes.txt`; bez tego pierwszą geometrię
  // powstałaby z samych przystanków (linia łamana przez budynki).
  await ensureShapesReady(store);
  const base = store.base;
  const overridesRevision = getOverridesRevision();
  if (cache && cache.base === base && cache.overridesRevision === overridesRevision) {
    return cache.entries;
  }

  const today = Number(DateTime.now().setZone(WARSAW_ZONE).toFormat("yyyyLLdd"));

  // Okres obowiązywania każdego rozkładu (service_id) i lista dni roboczych.
  const span = new Map<string, { from: number; to: number }>();
  const workdays: number[] = [];
  for (const [date, serviceIds] of base.serviceIdsByDate) {
    let workday = false;
    for (const serviceId of serviceIds) {
      const current = span.get(serviceId);
      if (!current) span.set(serviceId, { from: date, to: date });
      else {
        if (date < current.from) current.from = date;
        if (date > current.to) current.to = date;
      }
      if (serviceId.toUpperCase().endsWith("_RS")) workday = true;
    }
    if (workday) workdays.push(date);
  }
  workdays.sort((a, b) => a - b);

  const tripsByLine = new Map<string, RawTrip[]>();
  for (const trip of base.rawTrips) {
    const key = trip.routeShort.toUpperCase();
    const list = tripsByLine.get(key);
    if (list) list.push(trip);
    else tripsByLine.set(key, [trip]);
  }

  const entries: LineEntry[] = [];
  for (const route of base.routes) {
    const trips = tripsByLine.get(route.shortName.toUpperCase());
    if (!trips?.length) continue;

    let from = Number.POSITIVE_INFINITY;
    let to = 0;
    for (const serviceId of new Set(trips.map((trip) => trip.serviceId))) {
      const range = span.get(serviceId);
      if (!range) continue;
      from = Math.min(from, range.from);
      to = Math.max(to, range.to);
    }
    if (!Number.isFinite(from)) from = 0;

    // Linia 30 działa dopiero od grudnia — dzień odniesienia nie może być wcześniejszy.
    // Gdy w paczce nie ma nazw `*_RS` (inny przewoźnik/format), bierzemy datę
    // najbliższą dzisiejszej, żeby katalog nadal pokazywał jeden okres rozkładowy.
    const nearestDate = [...base.serviceIdsByDate.keys()].sort(
      (a, b) => Math.abs(a - today) - Math.abs(b - today) || a - b,
    )[0];
    const refDate =
      workdays.find((day) => day >= Math.max(today, from)) ??
      workdays[workdays.length - 1] ??
      nearestDate ??
      from;
    const activeOnRef = base.serviceIdsByDate.get(refDate) ?? new Set<string>();

    // Warianty liczymy z kursów, które w dniu odniesienia naprawdę jadą.
    // Paczka obejmuje kilka okresów rozkładowych (np. 387 i 388) i bez tego
    // filtra na liście (oraz na mapie) zostawały warianty z wygasłego okresu —
    // tak „linia 11 jechała” do przystanku, którego już nie obsługuje.
    const activeTrips = trips.filter((trip) => activeOnRef.has(trip.serviceId));
    const tripsForVariants = activeTrips.length ? activeTrips : trips;

    const groups = new Map<string, RawTrip[]>();
    for (const trip of tripsForVariants) {
      const key = trip.shapeId || `${trip.firstStopId}>${trip.lastStopId}`;
      const list = groups.get(key);
      if (list) list.push(trip);
      else groups.set(key, [trip]);
    }

    const variants: LineVariant[] = [];
    for (const [key, group] of groups) {
      const headsign = mostCommon(group.map((trip) => trip.headsign));
      const matching = group.filter((trip) => trip.headsign === headsign);
      const representative =
        matching.find((trip) => activeOnRef.has(trip.serviceId)) ?? matching[0] ?? group[0];

      const shape = representative.shapeId ? base.shapesById.get(representative.shapeId) : undefined;
      const tripStopTimes = base.rawStopTimesByTrip.get(representative.rawTripId) ?? [];
      const firstPoint = tripStopTimes[0] ? stopPointFor(base, tripStopTimes[0].stopId) : null;
      const lastPoint = tripStopTimes.length
        ? stopPointFor(base, tripStopTimes[tripStopTimes.length - 1].stopId)
        : null;

      let originalPath: LatLng[];
      if (shape && shape.length >= 2) {
        originalPath = shapeForTripStops(shape, firstPoint, lastPoint);
      } else {
        originalPath = [];
        for (const st of tripStopTimes) {
          const stop = stopPointFor(base, st.stopId);
          if (stop) originalPath.push([stop.lat, stop.lon]);
        }
      }

      const resolved = resolveTripShape(
        base,
        representative,
        firstPoint,
        lastPoint,
        originalPath,
      );
      const path = resolved.path;
      const approximate = resolved.approximate;
      if (path.length < 2) continue;

      const terminus = lastPoint?.name || representative.lastStopName || headsign;
      const origin = firstPoint?.name || representative.firstStopName;
      const matchedOverride = findLineRouteOverride({
        lineShort: route.shortName,
        shapeId: representative.shapeId,
        firstStopId: representative.firstStopId,
        lastStopId: representative.lastStopId,
        firstStopName: origin,
        lastStopName: terminus,
        directionId: representative.directionId,
      });

      variants.push({
        key,
        directionId: representative.directionId,
        headsign: terminus,
        firstStopId: representative.firstStopId,
        lastStopId: representative.lastStopId,
        firstStop: origin,
        lastStop: terminus,
        stopCount: Math.max(...group.map((trip) => trip.stopCount)),
        tripCount: group.length,
        refCount: group.filter((trip) => activeOnRef.has(trip.serviceId)).length,
        activeOnRef: activeTrips.length > 0 && group.some((trip) => activeOnRef.has(trip.serviceId)),
        lengthMeters: polylineLengthMeters(path),
        representativeTripId: representative.rawTripId,
        main: false,
        approximate,
        path,
        originalPath: originalPath.length >= 2 ? originalPath : path,
        customized: resolved.isOverride,
        customStatus: getOverrideStatus(route.shortName, key),
        customNote: matchedOverride?.override.note,
        customUpdatedAt: matchedOverride?.override.updatedAt,
      });
    }
    if (!variants.length) continue;

    // Katalog pokazuje wyłącznie warianty z dnia odniesienia. Warianty z innych
    // okresów rozkładowych (np. dawny koniec linii 11) nie mogą się rysować ani
    // pojawiać na liście.
    const shown = variants.some((variant) => variant.activeOnRef)
      ? variants.filter((variant) => variant.activeOnRef)
      : variants;

    shown.sort(
      (a, b) =>
        a.directionId - b.directionId ||
        b.refCount - a.refCount ||
        b.tripCount - a.tripCount ||
        a.headsign.localeCompare(b.headsign, "pl")
    );
    const seenDirections = new Set<number>();
    for (const variant of shown) {
      if (variant.refCount > 0 && !seenDirections.has(variant.directionId)) {
        seenDirections.add(variant.directionId);
        variant.main = true;
      }
    }

    entries.push({
      shortName: route.shortName,
      longName: route.longName,
      color: route.color,
      textColor: route.textColor,
      from,
      to,
      refDate,
      refTrips: shown.reduce((sum, variant) => sum + variant.refCount, 0),
      variants: shown,
    });
  }

  cache = { base, overridesRevision, entries };
  return entries;
}
