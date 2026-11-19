import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { getTimetableStops } from "../src/lib/engine/timetableStops";
import { ensureGtfsSeeded } from "../src/lib/engine/gtfsStore";
import { fetchBusStops, WALBRZYCH_BOUNDS } from "../src/lib/busStops";
import { emitRuntimeEvent } from "../src/lib/core/runtimeHub";

const files: Record<string, string> = {
  "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.com,pl,20260101,20261231\n",
  "routes.txt": "route_id,route_short_name,route_long_name,route_type\nr1,7,L1,3\nr2,9,L2,3\nold,99,Old,3\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\na,Start,50.77,16.28\nb,Wspólny,50.771,16.28\nc,Koniec,50.772,16.28\nd,Tylko wysiadanie,50.773,16.28\ne,Koniec 2,50.774,16.28\nf,Stary,50.775,16.28\ng,Brak numeracji,50.776,16.28\nh,Koniec 3,50.777,16.28\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign\nr1,week,t1,Wspólny\nr2,weekend,t2,Koniec\nold,expired,t3,Stary\nr2,week,t4,Koniec 3\n",
  "calendar_dates.txt": "service_id,date,exception_type\nweek,20261119,1\nweekend,20261121,1\nexpired,20270101,1\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nt1,08:00:00,08:00:00,a,1,0,0\nt1,08:05:00,08:05:00,d,2,1,0\nt1,08:10:00,08:10:00,b,3,0,0\nt2,09:00:00,09:00:00,b,1,0,0\nt2,09:05:00,09:05:00,c,2,0,0\nt2,09:10:00,09:10:00,e,3,0,0\nt3,10:00:00,10:00:00,c,1,0,0\nt3,10:10:00,10:10:00,f,2,0,0\nt4,11:00:00,11:00:00,g,0,0,0\nt4,11:10:00,11:10:00,h,0,0,0\n",
};
if (process.env.NO_BOARDABLE === "1") {
  files["stop_times.txt"] = files["stop_times.txt"].replace(/,0,0$/gm, ",1,0");
}
const zip = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), { level: 0 });
globalThis.fetch = async (input) => String(input).includes("walbrzych-gtfs.zip")
  ? new Response(zip, { status: 200 }) : new Response("", { status: 404 });

const data = new Map<string, string>();
const storage = {
  get length() { return data.size; },
  key: (i: number) => [...data.keys()][i] ?? null,
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => { data.set(k, v); },
  removeItem: (k: string) => { data.delete(k); },
  clear: () => data.clear(),
};
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
const boundsKey = [WALBRZYCH_BOUNDS.south, WALBRZYCH_BOUNDS.west, WALBRZYCH_BOUNDS.north, WALBRZYCH_BOUNDS.east].map((v) => v.toFixed(3)).join(",");
storage.setItem(`mapplaner.stops.v7.${boundsKey}`, JSON.stringify({ at: Date.now(), stops: [{ id: "stale", lines: ["7"] }] }));

const { stops } = await getTimetableStops();
const expected = process.env.NO_BOARDABLE === "1" ? ["a", "b", "c", "d", "e", "g", "h"] : ["a", "b", "c", "g"];
assert.deepEqual(stops.map((s) => s.gtfsId).sort(), expected);
if (process.env.NO_BOARDABLE !== "1") {
  assert.deepEqual(stops.find((s) => s.gtfsId === "b")?.lines, ["9"]); // terminal on 7, origin on 9
  assert.deepEqual(stops.find((s) => s.gtfsId === "c")?.lines, ["9"]); // inactive 99 excluded
}
const mapStops = await fetchBusStops(WALBRZYCH_BOUNDS);
assert.deepEqual(mapStops.map((s) => s.gtfsId).sort(), expected);
assert.equal(storage.getItem(`mapplaner.stops.v7.${boundsKey}`), null);
assert.ok(storage.getItem(`mapplaner.stops.v8.${boundsKey}`));
emitRuntimeEvent("gtfs:updated", { version: "test" });
assert.equal(storage.getItem(`mapplaner.stops.v8.${boundsKey}`), null);
const store = await ensureGtfsSeeded();
assert.equal(store.base.rawStopTimesByTrip.get("t2")?.at(-1)?.stopId, "e"); // terminal retained in trip data
console.log("boardable stop tests passed");
