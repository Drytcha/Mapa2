import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import {
  fetchBusStops,
  findRefreshedBusStop,
  getSnapshotBusStops,
  mergeRefreshedBusStops,
  stopDisplayName,
  WALBRZYCH_BOUNDS,
} from "../src/lib/busStops";
import type { BusStop } from "../src/lib/types";
import { ensureGtfsSeeded, getStopDepartures } from "../src/lib/engine/gtfsStore";

const files: Record<string, string> = {
  "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.com,pl,20260101,20261231\n",
  "routes.txt": "route_id,route_short_name,route_long_name,route_type\nr1,7,Test,3\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\na,Piłsudskiego - Plac Tuwima,50.76697,16.28661\nb,Północ,50.82,16.29\nc,Koniec,50.83,16.29\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign\nr1,daily,t1,Koniec\nr1,daily,t2,Koniec\n",
  "calendar_dates.txt": "service_id,date,exception_type\ndaily,20261119,1\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nt1,08:00:00,08:00:00,a,1,0,0\nt1,08:10:00,08:10:00,c,2,0,0\nt2,08:00:00,08:00:00,b,1,0,0\nt2,08:10:00,08:10:00,c,2,0,0\n",
};
const zip = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), { level: 0 });
const calls: string[] = [];
let overpassMode: "timeout" | "success" | "hang" = "timeout";
let overpassStarted: (() => void) | undefined;

globalThis.fetch = async (input, init) => {
  const url = String(input);
  calls.push(url);
  // Vite and some static hosts return the app shell with HTTP 200 for a missing ZIP.
  if (url.includes("data/walbrzych-gtfs.zip")) return new Response("<html>" + "x".repeat(1600) + "</html>");
  if (url.includes("api.zbiorkom.live") && url.includes("/gtfs/default")) return new Response(zip);
  if (url.includes("overpass")) {
    if (overpassMode === "timeout") throw new DOMException("Timed out", "AbortError");
    if (overpassMode === "success") return Response.json({ elements: [{
      type: "node", id: 1, lat: 50.76697, lon: 16.28661,
      tags: { highway: "bus_stop", name: "Piłsudskiego - Plac Tuwima", shelter: "yes" },
    }] });
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      overpassStarted?.();
    });
  }
  return new Response("", { status: 404 });
};

const snapshot = getSnapshotBusStops();
assert.ok(snapshot.length > 400, "the built-in snapshot should make stops available immediately");
assert.ok(snapshot.every((stop) => stop.source === "snapshot" && stop.lines.length > 0 && !stop.gtfsId));
const snapshotStop = snapshot.find((stop) => stop.name === "Piłsudskiego - Plac Tuwima");
assert.ok(snapshotStop);
assert.equal(stopDisplayName(snapshotStop), snapshotStop.name);

const stops = await fetchBusStops(WALBRZYCH_BOUNDS);
assert.deepEqual(stops.map((stop) => stop.gtfsId).sort(), ["a", "b"]);
assert.ok(calls.some((url) => url.includes("api.zbiorkom.live") && url.includes("/gtfs/default")), "HTML must not be treated as a GTFS ZIP");
const a = stops.find((stop) => stop.gtfsId === "a")!;
const b = stops.find((stop) => stop.gtfsId === "b")!;
assert.equal(findRefreshedBusStop(snapshotStop, stops), a);
assert.equal(findRefreshedBusStop(snapshotStop, [{ ...a, lat: a.lat + 0.01 }]), null);
assert.equal(findRefreshedBusStop(snapshotStop, [{ ...a, name: "Inny" }]), null);
assert.equal(findRefreshedBusStop(snapshotStop, [a, { ...a, id: "tt-other" }]), null);

// Never present the closest unrelated or ambiguous platform as this stop's
// timetable; a real GTFS ID remains authoritative.
const store = await ensureGtfsSeeded();
const gtfsA = store.base.stopsById.get("a")!;
const duplicate = { ...gtfsA, id: "duplicate" };
store.base.stops.push(duplicate);
store.base.activeStopIds.add(duplicate.id);
const window = { lat: a.lat, lon: a.lon, fromMs: Date.parse("2026-11-19T00:00:00+01:00"), toMs: Date.parse("2026-11-20T00:00:00+01:00"), includeLive: false };
assert.equal((await getStopDepartures({ ...window, name: "Inna ulica" })).matched, null);
assert.equal((await getStopDepartures({ ...window, name: a.name })).matched, null);
assert.equal((await getStopDepartures({ ...window, name: a.name, stopId: "a" })).matched?.id, "a");

const viewport = { south: 50.76, west: 16.28, north: 50.77, east: 16.29 };
const updated: BusStop = { ...a, shelter: true };
assert.deepEqual(mergeRefreshedBusStops(stops, [updated], viewport).map((stop) => stop.id).sort(), [a.id, b.id].sort());
assert.equal(mergeRefreshedBusStops(stops, [updated], viewport).find((stop) => stop.id === a.id)?.shelter, true);
assert.deepEqual(mergeRefreshedBusStops(stops, [], viewport).map((stop) => stop.id), [b.id]);

// A timeout in optional shelter enrichment must still return all GTFS stops.
const onTimeout = await fetchBusStops(WALBRZYCH_BOUNDS, { force: true });
assert.deepEqual(onTimeout.map((stop) => stop.id).sort(), [a.id, b.id].sort());
assert.equal(onTimeout.find((stop) => stop.id === a.id)?.shelter, false);
overpassMode = "success";
const onSuccess = await fetchBusStops(WALBRZYCH_BOUNDS, { force: true });
assert.equal(onSuccess.find((stop) => stop.id === a.id)?.shelter, true);

// A genuine caller cancellation must still propagate and not populate a stale result.
overpassMode = "hang";
const started = new Promise<void>((resolve) => { overpassStarted = resolve; });
const controller = new AbortController();
const pending = fetchBusStops(WALBRZYCH_BOUNDS, { force: true, signal: controller.signal });
await started;
controller.abort();
await assert.rejects(pending, (error) => error instanceof DOMException && error.name === "AbortError");
console.log("stop fallback and refresh tests passed");
