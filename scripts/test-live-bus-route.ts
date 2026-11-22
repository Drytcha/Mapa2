import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { ensureGtfsSeeded, getCoursePreview, getVehicleCourseTrip, getVehicleTripStops } from "../src/lib/engine/gtfsStore";
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
  "calendar_dates.txt": "service_id,date,exception_type\nRS,20261120,1\n",
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

// 1. Pojazd da się przypisać do kursu i dnia obsługi.
const course = await getVehicleCourseTrip(bus);
assert.ok(course, "bez kursu nie ma czego narysować na mapie");
assert.equal(course.tripId, "t-bus");
assert.equal(course.dateId, "20261120");

// 2. Podgląd kursu zwraca polilinię do narysowania (bez shapes.txt — po przystankach).
const preview = await getCoursePreview(course.tripId, course.dateId);
assert.ok(preview, "podgląd kursu musi istnieć, inaczej mapa zostaje pusta");
assert.ok(preview.polylines.length > 0, "trasa musi mieć co najmniej jedną polilinię");
assert.ok(preview.polylines.some((line) => line.length >= 2), "polilinia musi mieć ≥ 2 punkty");
assert.equal(preview.stops.length, 3);
assert.equal(preview.approximate, true, "bez shapes.txt trasa idzie po przystankach");

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
const unknown = { ...bus, routeName: "77", headsign: "Nigdzie", upcomingStops: [] };
assert.equal(await getVehicleCourseTrip(unknown), null);

console.log("OK: klik w autobus daje kurs i polilinię do narysowania na mapie");
