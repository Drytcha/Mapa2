import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { groupDeparturesByLine } from "../src/lib/departureGroups";
import { ensureGtfsSeeded, getStopDepartures } from "../src/lib/engine/gtfsStore";

/**
 * Rozkład na przystanku musi podawać litery z oficjalnej legendy linii —
 * wykryte po kierunku I trasie kursu (warianty „przez …”), nie po pierwszej
 * literze nazwy celu.
 */
const files: Record<string, string> = {
  "feed_info.txt":
    "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.com,pl,20261101,20261231\n",
  "routes.txt":
    "route_id,route_short_name,route_long_name,route_type\nr8,8,Linia 8,3\nr2,2,Linia 2,3\n",
  "stops.txt": [
    "stop_id,stop_name,stop_lat,stop_lon",
    "a,Szczawienko,50.780,16.280",
    "b,Stare Bogaczowice,50.830,16.160",
    "c,Chwaliszów,50.840,16.150",
    "d,Gostków,50.850,16.120",
    "e,Lubiechów,50.760,16.140",
    "f,Zamek Książ,50.755,16.130",
    "g,Struga,50.730,16.200",
    "h,Al. Podwale,50.790,16.260",
    "i,Galeria Victoria,50.792,16.265",
    "j,Boguszów-Gorce Dworzec,50.820,16.280",
    "k,Bystrzycka,50.700,16.300",
  ].join("\n"),
  "trips.txt": [
    "route_id,service_id,trip_id,trip_headsign,block_id",
    "r8,RS,t-y,Gostków,8/01",
    "r8,RS,t-g,Gostków,8/01",
    "r8,RS,t-z,Zamek Książ,8/01",
    "r8,RS,t-s,Struga,8/01",
    "r8,RS,t-a,Bystrzycka,8/01",
    "r2,RS,t-2b,Boguszów-Gorce Dworzec,2/01",
    "r2,RS,t-2base,Bystrzycka,2/01",
    "r2,RS,t-2v,Bystrzycka,2/01",
  ].join("\n"),
  "calendar_dates.txt": "service_id,date,exception_type\nRS,20261120,1\n",
  "stop_times.txt": [
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type",
    "t-y,08:00:00,08:00:00,a,1,0,0",
    "t-y,08:20:00,08:20:00,b,2,0,0",
    "t-y,08:30:00,08:30:00,c,3,0,0",
    "t-y,08:45:00,08:45:00,d,4,0,0",
    "t-g,09:00:00,09:00:00,a,1,0,0",
    "t-g,09:20:00,09:20:00,b,2,0,0",
    "t-g,09:35:00,09:35:00,d,3,0,0",
    "t-z,10:00:00,10:00:00,a,1,0,0",
    "t-z,10:20:00,10:20:00,e,2,0,0",
    "t-z,10:30:00,10:30:00,f,3,0,0",
    "t-s,11:00:00,11:00:00,a,1,0,0",
    "t-s,11:20:00,11:20:00,g,2,0,0",
    "t-a,12:00:00,12:00:00,a,1,0,0",
    "t-a,12:05:00,12:05:00,h,2,0,0",
    "t-a,12:20:00,12:20:00,k,3,0,0",
    "t-2b,13:00:00,13:00:00,a,1,0,0",
    "t-2b,13:30:00,13:30:00,j,2,0,0",
    "t-2base,14:00:00,14:00:00,a,1,0,0",
    "t-2base,14:30:00,14:30:00,k,2,0,0",
    "t-2v,15:00:00,15:00:00,a,1,0,0",
    "t-2v,15:10:00,15:10:00,i,2,0,0",
    "t-2v,15:30:00,15:30:00,k,3,0,0",
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
const { departures } = await getStopDepartures({
  stopId: "a",
  lat: 50.78,
  lon: 16.28,
  fromMs: Date.parse("2026-11-20T00:00:00+01:00"),
  toMs: Date.parse("2026-11-21T00:00:00+01:00"),
  includeLive: false,
});

const byTrip = new Map(departures.map((item) => [item.tripId, item]));
const codes = Object.fromEntries(
  ["t-y", "t-g", "t-z", "t-s", "t-a", "t-2b", "t-2base", "t-2v"].map((tripId) => [
    tripId,
    byTrip.get(tripId)?.legendCode,
  ]),
);
assert.deepEqual(codes, {
  "t-y": "y",
  "t-g": "g",
  "t-z": "z",
  "t-s": "s",
  "t-a": "a",
  "t-2b": "b",
  "t-2base": "",
  "t-2v": "v",
});
assert.equal(
  byTrip.get("t-2v")?.legendText,
  "kurs przez Galerię Victoria",
  "ten sam kierunek (Bystrzycka), inna trasa — litera v z trasy, nie z nazwy celu",
);
assert.equal(byTrip.get("t-y")?.legendText, "kurs przedłużony do Gostkowa przez Chwaliszów i Stare Bogaczowice");
assert.equal(byTrip.get("t-s")?.legendText, "kurs przedłużony do Strugi");
assert.equal(byTrip.get("t-2base")?.legendText, "");

const groups = groupDeparturesByLine(departures);
const line8 = groups.find((group) => group.line === "8")!;
assert.deepEqual(
  line8.directions.map(({ suffix, legendText }) => [suffix, legendText ?? ""]),
  [
    ["a", "kurs przez Al. Podwale"],
    ["z", "kurs przedłużony do Zamku Książ przez Lubiechów"],
    ["g", "kurs przedłużony przez Stare Bogaczowice do Gostkowa"],
    ["s", "kurs przedłużony do Strugi"],
    ["y", "kurs przedłużony do Gostkowa przez Chwaliszów i Stare Bogaczowice"],
  ],
  "kolejność liter jak w oficjalnej legendzie linii 8",
);
assert.deepEqual(
  line8.departures.map(({ direction }) => direction.suffix),
  ["y", "g", "z", "s", "a"],
  "każdy kurs dostaje literę swojego wariantu",
);
const line2 = groups.find((group) => group.line === "2")!;
assert.deepEqual(
  line2.directions.map(({ suffix }) => suffix),
  ["", "b", "v"],
  "kurs na Bystrzycką (podstawa) bez litery, Boguszów-Gorce jako 2b, przez Victorię jako 2v",
);

console.log("stop timetable letters come from the official line legend");
