/**
 * Wyszukiwarka połączeń A → B po rozkładzie GTFS Wałbrzycha (fasada).
 *
 * Ciężkie obliczenia (algorytm RAPTOR, rozkład dnia, geometria `shapes.txt`
 * oraz weryfikacja dojść pieszych) wykonują się poza wątkiem głównym UI
 * w `gtfsWorker.ts`, z automatycznym fallbackiem do `journeyPlannerCore.ts`
 * w środowiskach bez `Worker` (np. testy Node).
 */

import { WARSAW_ZONE } from "./core/time";
import {
  ensureGtfsSeeded,
  ensureShapesReady,
  getActiveGtfsWorkerContext,
} from "./engine/gtfsStore";
import { planJourneysViaWorker } from "./engine/gtfsWorkerClient";
import { initLineRouteOverrides } from "./engine/lineRouteOverrides";
import { repairShapeGaps } from "./engine/shapeRepair";
import type {
  Journey,
  JourneyBusLeg,
  JourneyLeg,
  JourneyPlan,
  JourneyPoint,
  JourneyStop,
  JourneyWalkLeg,
} from "./journeyPlannerCore";
import type { LiveBusVehicle } from "./types";

export const JOURNEY_ZONE = WARSAW_ZONE;

export type {
  Journey,
  JourneyBusLeg,
  JourneyLeg,
  JourneyPlan,
  JourneyPoint,
  JourneyStop,
  JourneyWalkLeg,
};

export async function planJourneys(options: {
  origin: JourneyPoint;
  destination: JourneyPoint;
  departMs?: number;
  liveBuses: LiveBusVehicle[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<JourneyPlan> {
  const nowMs = Date.now();
  options.signal?.throwIfAborted();

  options.onProgress?.("Wczytuję rozkład jazdy i mapę przystanków...");
  const [store] = await Promise.all([
    ensureGtfsSeeded(),
    initLineRouteOverrides().catch(() => undefined),
  ]);
  options.signal?.throwIfAborted();

  const workerCtx = getActiveGtfsWorkerContext();
  const workerPlan = await planJourneysViaWorker({
    identity: workerCtx.identity,
    source: workerCtx.source,
    getZipBytes: workerCtx.getZipBytes,
    origin: options.origin,
    destination: options.destination,
    departMs: options.departMs,
    nowMs,
    liveBuses: options.liveBuses,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  if (workerPlan) {
    return workerPlan;
  }

  void ensureShapesReady(store);
  const { planJourneysFromBase } = await import("./journeyPlannerCore");
  return planJourneysFromBase(store.base, {
    ...options,
    nowMs,
  });
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

/**
 * Same as `journeyToMapGeometry`, but bus legs are split at GTFS shape gaps and
 * bridged with road geometry. Meant for the one journey actually drawn on the map.
 */
export async function journeyToRepairedMapGeometry(
  journey: Journey,
  signal?: AbortSignal,
): Promise<{ legs: JourneyMapLeg[]; markers: JourneyMapMarker[] }> {
  const { legs, markers } = journeyToMapGeometry(journey);
  const repaired: JourneyMapLeg[] = [];
  for (const leg of legs) {
    if (leg.kind !== "bus" || leg.path.length < 3) {
      repaired.push(leg);
      continue;
    }
    const { polylines } = await repairShapeGaps(leg.path, signal);
    for (const path of polylines) repaired.push({ ...leg, path });
  }
  return { legs: repaired, markers };
}
