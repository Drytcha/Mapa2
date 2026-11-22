import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import {
  ensureGtfsSeeded,
  getCoursePreview,
  getVehicleRouteOverlay,
  getVehicleTripStops,
} from "../src/lib/engine/gtfsStore";
import { buildBusMarker } from "../src/lib/busMarker";
import { DELAY_STYLES, delayTone } from "../src/lib/delay";
import { computeFleetSignature, type LiveFleetSnapshot } from "../src/lib/core/runtimeHub";
import { liveBusTap } from "../src/lib/liveBusProgress";
import type { LiveBusVehicle } from "../src/lib/types";

/**
 * Klik w autobus ma narysować trasę jego kursu na mapie (myBus 3.0), a nie
 * tylko odświeżać listę przystanków. Ten test sprawdza, że dla pojazdu z GPS
 * da się ustalić kurs i że podgląd trasy naprawdę zwraca polilinię.
 */
const files: Record<string, string> = {
  "feed_info.txt":
    "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.com,pl,20261101,20261231\n",
  "routes.txt":
    "route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\nr9,9,Linia 9,3,1E6FBF,FFFFFF\n",
  "stops.txt": [
    "stop_id,stop_name,stop_lat,stop_lon",
    "a,Wałbrzych Rynek,50.780,16.280",
    "b,Piaskowa Góra,50.790,16.290",
    "c,Kozice,50.800,16.300",
  ].join("\n"),
  "trips.txt": [
    "route_id,service_id,trip_id,trip_headsign,block_id,shape_id",
    "r9,RS,t-bus,Kozice,9/01,",
  ].join("\n"),
  // Celowo BEZ dnia kursu: trasa autobusu nie może zależeć od kalendarza.
  "calendar_dates.txt": "service_id,date,exception_type\nRS,20261201,1\n",
  "stop_times.txt": [
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type",
    "t-bus,10:00:00,10:00:00,a,1,0,0",
    "t-bus,10:10:00,10:10:00,b,2,0,0",
    "t-bus,10:20:00,10:20:00,c,3,0,0",
  ].join("\n"),
};

const zip = zipSync(
  Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
  { level: 0 },
);
globalThis.fetch = async (input) =>
  String(input).includes("walbrzych-gtfs.zip")
    ? new Response(zip, { status: 200 })
    : new Response("", { status: 404 });

const data = new Map<string, string>();
const storage = {
  get length() {
    return data.size;
  },
  key: (i: number) => [...data.keys()][i] ?? null,
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => {
    data.set(k, v);
  },
  removeItem: (k: string) => {
    data.delete(k);
  },
  clear: () => data.clear(),
};
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

await ensureGtfsSeeded();

const stopB = Date.parse("2026-11-20T10:10:00+01:00");
/** GPS nie podaje tripId — kurs trzeba dopasować po linii, przystanku i godzinie. */
const bus: LiveBusVehicle = {
  vehicleId: "1234",
  model: null,
  operatorKey: "mzuk",
  operatorName: "MZUK",
  operatorSource: "auto",
  routeName: "9",
  routeColor: "#1e6fbf",
  brigade: "01",
  kursowka: "",
  tripId: null,
  lat: 50.79,
  lon: 16.29,
  bearing: null,
  delaySeconds: 0,
  speedKmh: 28,
  headsign: "Kozice",
  timestamp: stopB,
  upcomingStops: [
    { sequence: 2, name: "Piaskowa Góra", scheduledArrival: stopB, scheduledDeparture: stopB },
    { sequence: 3, name: "Kozice", scheduledArrival: stopB + 600_000, scheduledDeparture: stopB + 600_000 },
  ],
};

// Cztery kolory, włącznie z granicami, niezależnie od przewoźnika.
for (const [seconds, tone] of [[-61, "early-big"], [-60, "early-small"], [0, "early-small"], [1, "late"], [180, "late"], [181, "late-high"]] as const) {
  assert.equal(delayTone(seconds), tone);
  for (const operatorKey of ["mzuk", "ska", "other"] as const) {
    const { html } = buildBusMarker({ ...bus, delaySeconds: seconds, operatorKey }, { kursowka: false, vehicleNumber: false }, false);
    assert.ok(html.includes(`--delay-bg:${DELAY_STYLES[tone].bg}`));
    assert.ok(!html.includes("--operator-bg"));
  }
}
const snapshot = { vehicles: [bus], traffic: { recommendedPeakPercent: 0 }, source: "test" } as LiveFleetSnapshot;
const nextSnapshot = { ...snapshot, vehicles: [{ ...bus, upcomingStops: bus.upcomingStops.slice(1) }] };
assert.notEqual(computeFleetSignature(snapshot), computeFleetSignature(nextSnapshot), "sam postęp przystanku wywołuje aktualizację floty");

// 1. Trasa do narysowania powstaje bez pytania kalendarza o dzień obsługi.
const overlay = await getVehicleRouteOverlay(bus);
assert.ok(overlay, "bez trasy klik w autobus nie pokazuje nic na mapie");
assert.match(overlay.title, /Trasa linii 9/);
assert.equal(overlay.stops.length, 3);
assert.deepEqual(overlay.stops.map((stop) => stop.sequence), [1, 2, 3]);
assert.ok(overlay.polylines.length > 0, "trasa musi mieć co najmniej jedną polilinię");
assert.ok(overlay.polylines.some((line) => line.length >= 2), "polilinia musi mieć ≥ 2 punkty");
assert.ok(
  overlay.polylines[0].every(([lat, lon]) => Math.abs(lat - 50.79) < 1 && Math.abs(lon - 16.29) < 1),
  "punkty trasy są w rejonie Wałbrzycha",
);

// 2. Dlaczego nie używamy podglądu kursu: bez obsługi w danym dniu zwraca null.
assert.equal(
  await getCoursePreview("t-bus", "20261120"),
  null,
  "podgląd kursu wymaga aktywnej obsługi dnia — dlatego trasa autobusu idzie inną drogą",
);

// 3. Ta sama trasa jest podstawą listy przystanków w karcie — oba widoki są spójne.
const run = await getVehicleTripStops(bus);
assert.equal(run.complete, true);
assert.deepEqual(
  run.stops.map((stop) => [stop.name, stop.passed]),
  [
    ["Wałbrzych Rynek", true],
    ["Piaskowa Góra", false],
    ["Kozice", false],
  ],
);

// 4. Klik w ten sam autobus zamyka kartę, w inny — otwiera i rysuje trasę.
assert.equal(liveBusTap(null, "1234"), "select");
assert.equal(liveBusTap("1234", "1234"), "close");
assert.equal(liveBusTap("1234", "5678"), "select");

// 5. Pojazd bez dopasowania nie dostaje wymyślonej trasy.
const unknown = { ...bus, tripId: null, routeName: "77", headsign: "Nigdzie", upcomingStops: [] };
assert.equal(await getVehicleRouteOverlay(unknown), null);

// 6. Gdy GPS podaje tripId, trasa powstaje nawet bez dopasowania po godzinie.
const byTripId = { ...bus, tripId: "t-bus", routeName: "77", upcomingStops: [] };
const direct = await getVehicleRouteOverlay(byTripId);
assert.ok(direct, "tripId z GPS wystarcza do narysowania trasy");
assert.equal(direct.stops.length, 3);

console.log("OK: klik w autobus daje kurs i polilinię do narysowania na mapie");
