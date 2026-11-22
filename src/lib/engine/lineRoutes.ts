/**
 * Katalog linii Wałbrzycha: dla każdej linii (2, 4, 5, 7 …) jej warianty tras
 * zbudowane z `shapes.txt` — po jednym wariancie na każdy odrębny kształt trasy.
 * Dane pochodzą z tej samej paczki GTFS co kursówki, więc linia 30 (od 1 grudnia)
 * i linie planistyczne S1–S4 są w niej, o ile są w paczce „GTFS (full).zip".
 */
import { DateTime } from "luxon";
import { polylineLengthMeters } from "../core/spatial";
import { WARSAW_ZONE } from "../core/time";
import {
  connectEndsToStops,
  ensureGtfsSeeded,
  ensureShapesReady,
  stopPointFor,
} from "./gtfsStore";

type LatLng = [number, number];
type Store = Awaited<ReturnType<typeof ensureGtfsSeeded>>;
type RawTrip = Store["base"]["rawTrips"][number];

export interface LineVariant {
  /** shape_id (albo para przystanków, gdy kurs nie ma kształtu). */
  key: string;
  directionId: number;
  headsign: string;
  firstStop: string;
  lastStop: string;
  stopCount: number;
  /** Wszystkie kursy tego wariantu w całym feedzie. */
  tripCount: number;
  /** Kursy tego wariantu w dniu odniesienia linii (dzień roboczy). */
  refCount: number;
  lengthMeters: number;
  /** Kurs, z którego pochodzi geometria i lista przystanków. */
  representativeTripId: string;
  /** Pierwszy wariant danego kierunku, który kursuje w dniu odniesienia. */
  main: boolean;
  /** true = brak shapes.txt, trasa to łamana po przystankach. */
  approximate: boolean;
  path: LatLng[];
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

let cache: { base: unknown; entries: LineEntry[] } | null = null;

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
  const store = await ensureGtfsSeeded();
  // Warianty linii rysują się po `shapes.txt`; bez tego pierwszą geometrię
  // powstałaby z samych przystanków (linia łamana przez budynki).
  await ensureShapesReady(store);
  const base = store.base;
  if (cache && cache.base === base) return cache.entries;

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
    const refDate =
      workdays.find((day) => day >= Math.max(today, from)) ?? workdays[workdays.length - 1] ?? from;
    const activeOnRef = base.serviceIdsByDate.get(refDate) ?? new Set<string>();

    const groups = new Map<string, RawTrip[]>();
    for (const trip of trips) {
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
      let path: LatLng[];
      let approximate = false;
      if (shape && shape.length >= 2) {
        // Kształt rysujemy w całości, dociągnięty do pierwszego i ostatniego
        // przystanku wariantu (pętla bywa dalej niż koniec kształtu).
        path = connectEndsToStops(shape, firstPoint, lastPoint);
      } else {
        approximate = true;
        path = [];
        for (const st of tripStopTimes) {
          const stop = stopPointFor(base, st.stopId);
          if (stop) path.push([stop.lat, stop.lon]);
        }
      }
      if (path.length < 2) continue;

      variants.push({
        key,
        directionId: representative.directionId,
        headsign: headsign || representative.lastStopName,
        firstStop: representative.firstStopName,
        lastStop: representative.lastStopName,
        stopCount: Math.max(...group.map((trip) => trip.stopCount)),
        tripCount: group.length,
        refCount: group.filter((trip) => activeOnRef.has(trip.serviceId)).length,
        lengthMeters: polylineLengthMeters(path),
        representativeTripId: representative.rawTripId,
        main: false,
        approximate,
        path,
      });
    }
    if (!variants.length) continue;

    variants.sort(
      (a, b) =>
        a.directionId - b.directionId ||
        b.refCount - a.refCount ||
        b.tripCount - a.tripCount ||
        a.headsign.localeCompare(b.headsign, "pl")
    );
    const seenDirections = new Set<number>();
    for (const variant of variants) {
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
      refTrips: variants.reduce((sum, variant) => sum + variant.refCount, 0),
      variants,
    });
  }

  cache = { base, entries };
  return entries;
}
