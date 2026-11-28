import assert from "node:assert/strict";
import { buildSyntheticGtfs } from "./lib/syntheticGtfs";
import {
  BusMotionInterpolator,
  computeBearingDeg,
  indexRoutePolyline,
  interpolateBearingDeg,
  projectPointOntoPolyline,
  shortestAngleDeltaDeg,
} from "../src/lib/busInterpolation";
import { buildBusMarker } from "../src/lib/busMarker";
import { distanceCoords } from "../src/lib/core/spatial";
import {
  buildCourseNavRoute,
  computeCoursePunctuality,
} from "../src/lib/courseNavigation";
import {
  exportDynamicDutyOperators,
  updateDynamicDutyOperators,
} from "../src/lib/engine/brigadeVerification";
import {
  parseArchiveBytesDirect,
  parseShapesBytesDirect,
} from "../src/lib/engine/gtfsArchiveParser";
import {
  applyOverridesOverlay,
  exportOverridesOverlay,
  initLineRouteOverrides,
} from "../src/lib/engine/lineRouteOverrides";
import type { LiveBusVehicle } from "../src/lib/types";

function makeBus(overrides: Partial<LiveBusVehicle> = {}): LiveBusVehicle {
  return {
    vehicleId: "340",
    tripId: "trip-15-1",
    routeId: "15",
    routeName: "15",
    routeColor: "#7c44a9",
    headsign: "Podzamcze",
    kursowka: "15/02",
    dutySource: "schedule",
    operatorKey: "mzuk",
    operatorName: "MZUK Wałbrzych",
    lat: 50.766,
    lon: 16.282,
    bearing: 0,
    speedKmh: 36,
    delaySeconds: 15,
    updatedAt: 1_700_000_000_000,
    upcomingStops: [],
    ...overrides,
  };
}

async function main() {
  // 1. Najkrótszy kąt obrotu strzałki przez północ (352° -> 8° = +16°, a nie -344°)
  assert.equal(Math.round(shortestAngleDeltaDeg(352, 8)), 16);
  assert.equal(Math.round(shortestAngleDeltaDeg(8, 352)), -16);
  const midNorth = interpolateBearingDeg(352, 8, 0.5);
  assert.ok(midNorth < 1 || midNorth > 359, `Expected ~0°, got ${midNorth}`);

  // 2. Płynny ruch między pakietami GPS + brak przelotu z (0,0) przy pierwszym pakiecie
  const interp = new BusMotionInterpolator();
  const busT0 = makeBus({ lat: 50.766, lon: 16.282, bearing: 350 });
  interp.syncFleet([busT0], 1_000);
  const s0 = interp.sample("340", 1_000);
  assert.ok(s0 && s0.settled);
  assert.equal(s0.lat, 50.766);

  // Krok ~65 m na północny wschód po 3,0 s
  const busT1 = makeBus({ lat: 50.76655, lon: 16.28235, bearing: 10 });
  interp.syncFleet([busT1], 4_000);
  assert.equal(interp.hasActiveAnimations(4_100), true);

  const sMid = interp.sample("340", 5_440); // ~50% z ~2880 ms
  assert.ok(sMid && !sMid.settled);
  assert.ok(sMid.lat > 50.7661 && sMid.lat < 50.7665);
  assert.ok(
    sMid.bearingDeg !== null && (sMid.bearingDeg >= 350 || sMid.bearingDeg <= 10),
    `Shortest-arc heading expected near north, got ${sMid.bearingDeg}`,
  );

  const sDone = interp.sample("340", 7_500);
  assert.ok(sDone && sDone.settled);
  assert.ok(Math.abs(sDone.lat - 50.76655) < 1e-6);

  // 3. Szum postoju (< 0,8 m) nie uruchamia drgań markera
  const tinyNoise = makeBus({ lat: 50.766552, lon: 16.282351, bearing: 10 });
  interp.syncFleet([tinyNoise], 10_500);
  const sStill = interp.sample("340", 11_000);
  assert.ok(sStill && sStill.settled);

  // 4. Duży skok (> 650 m) robi natychmiastowy snap zamiast lecieć przez pół miasta
  const jumped = makeBus({ lat: 50.81, lon: 16.31, bearing: 90 });
  interp.syncFleet([jumped], 13_500);
  const sJump = interp.sample("340", 13_600);
  assert.ok(sJump && sJump.settled);
  assert.equal(sJump.lat, 50.81);

  // 5. Wyliczanie kierunku jazdy z wektora ruchu, gdy pakiet GPS ma bearing: null
  const noHeadingInterp = new BusMotionInterpolator();
  noHeadingInterp.syncFleet(
    [makeBus({ vehicleId: "212", lat: 50.76, lon: 16.28, bearing: null })],
    1_000,
  );
  noHeadingInterp.syncFleet(
    [makeBus({ vehicleId: "212", lat: 50.7604, lon: 16.28, bearing: null })],
    4_000,
  );
  const sDerived = noHeadingInterp.sample("212", 5_000);
  assert.ok(sDerived && sDerived.bearingDeg !== null);
  assert.ok(
    sDerived.bearingDeg < 5 || sDerived.bearingDeg > 355,
    `Expected due-north derived heading (~0°), got ${sDerived.bearingDeg}`,
  );
  assert.ok(computeBearingDeg(50.76, 16.28, 50.76, 16.29) > 85);

  // 6. Przyciąganie i jazda po zakręcie geometrii kursu GTFS (zamiast ścinania narożnika)
  const cornerPath: [number, number][] = [
    [50.766, 16.28],
    [50.7668, 16.28], // ~89 m na północ
    [50.7668, 16.2812], // ~85 m na wschód (zakręt 90°)
  ];
  const poly = indexRoutePolyline(cornerPath);
  assert.ok(poly && poly.totalMeters > 160);
  const routesMap = new Map([["500", poly]]);
  const curveInterp = new BusMotionInterpolator();
  curveInterp.syncFleet(
    [makeBus({ vehicleId: "500", lat: 50.7662, lon: 16.28002, bearing: 0 })],
    1_000,
    routesMap,
  );
  curveInterp.syncFleet(
    [makeBus({ vehicleId: "500", lat: 50.76679, lon: 16.2809, bearing: 90 })],
    4_000,
    routesMap,
  );
  // W połowie przejścia autobus powinien jechać blisko narożnika ulicy, a nie po cięciwie!
  const midCorner = curveInterp.sample("500", 5_440);
  assert.ok(midCorner && !midCorner.settled);
  const projMid = projectPointOntoPolyline(poly, midCorner.lat, midCorner.lon);
  assert.ok(
    projMid.distanceMeters < 0.5,
    `Expected bus to stay on street polyline (<0.5 m), got ${projMid.distanceMeters} m`,
  );
  // Cięciwa byłaby >25 m od narożnika [50.7668, 16.28]
  const distToCorner = distanceCoords(
    midCorner.lat,
    midCorner.lon,
    50.7668,
    16.28,
  );
  assert.ok(
    distToCorner < 18,
    `Expected midpoint near street corner, got ${distToCorner.toFixed(1)} m`,
  );

  // 7. templateKey w buildBusMarker nie zmienia się przy samej zmianie kąta obrotu strzałki
  const m1 = buildBusMarker(
    makeBus({ bearing: 15 }),
    { kursowka: false, vehicleNumber: true },
    false,
  );
  const m2 = buildBusMarker(
    makeBus({ bearing: 142 }),
    { kursowka: false, vehicleNumber: true },
    false,
  );
  assert.equal(m1.templateKey, m2.templateKey);
  assert.notEqual(m1.html, m2.html);

  // 8. Parser archiwum GTFS dla Web Workera (tryb niekooperatywny / pełna prędkość wątku roboczego)
  const synthetic = buildSyntheticGtfs({
    routes: 8,
    stops: 120,
    tripsPerService: 80,
    stopsPerTrip: 16,
    shapes: 16,
    pointsPerShape: 60,
  });
  const parsedBase = await parseArchiveBytesDirect(synthetic.zip, "synthetic", {
    cooperative: false,
  });
  assert.equal(parsedBase.routes.length, 8);
  assert.equal(parsedBase.stops.length, 120);
  assert.ok(parsedBase.rawTrips.length >= 80);
  assert.equal(parsedBase.shapesById.size, 0);

  const shapes = await parseShapesBytesDirect(synthetic.zip, { cooperative: false });
  assert.equal(shapes.size, 16);

  // 9. Synchronizacja nakładek korekt tras oraz operatorów dla Web Workera
  await initLineRouteOverrides();
  const overlaySnap = exportOverridesOverlay();
  applyOverridesOverlay(overlaySnap);
  const ops = exportDynamicDutyOperators();
  assert.ok(Object.keys(ops).length > 10);
  updateDynamicDutyOperators(ops);

  // 10. Odizolowane wyliczanie punktualności w CourseNavigationHud
  const navRoute = buildCourseNavRoute({
    title: "Linia 15",
    routeShort: "15",
    color: "#7c44a9",
    textColor: "#ffffff",
    polylines: [cornerPath],
    stops: [
      {
        stopId: "s1",
        name: "Start",
        sequence: 1,
        lat: cornerPath[0][0],
        lon: cornerPath[0][1],
      },
      {
        stopId: "s2",
        name: "Meta",
        sequence: 2,
        lat: cornerPath[2][0],
        lon: cornerPath[2][1],
      },
    ],
    course: {
      tripId: "t1",
      dateId: "20261127",
      serviceLabel: "Dni robocze",
      routeShort: "15",
      routeColor: "#7c44a9",
      routeTextColor: "#ffffff",
      headsign: "Podzamcze",
      dutyCode: "15/01",
      operatorName: "MZUK",
      approximate: false,
      startClock: "12:00",
      endClock: "12:04",
      startMs: 1_000_000,
      endMs: 1_240_000,
      polylines: [cornerPath],
      stops: [
        {
          stopId: "s1",
          name: "Start",
          sequence: 1,
          lat: cornerPath[0][0],
          lon: cornerPath[0][1],
          arrivalClock: "12:00",
          departureClock: "12:00",
          arrivalMs: 1_000_000,
          departureMs: 1_000_000,
          afterMidnight: false,
          canBoard: true,
          onDemand: false,
        },
        {
          stopId: "s2",
          name: "Meta",
          sequence: 2,
          lat: cornerPath[2][0],
          lon: cornerPath[2][1],
          arrivalClock: "12:04",
          departureClock: "12:04",
          arrivalMs: 1_240_000,
          departureMs: 1_240_000,
          afterMidnight: false,
          canBoard: true,
          onDemand: false,
        },
      ],
    },
  });
  assert.ok(navRoute);
  const deltaSchedule = computeCoursePunctuality(
    navRoute,
    0,
    1_090_000, // +90s po planowym starcie na starcie trasy
    1_000_000,
    "schedule",
  );
  assert.equal(deltaSchedule, 90);

  console.log("test-optimizations: ALL ASSERTIONS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
