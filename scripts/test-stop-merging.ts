import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { getSnapshotBusStops } from "../src/lib/busStops";
import { getTimetableStops } from "../src/lib/engine/timetableStops";
import { getStopDepartures } from "../src/lib/engine/gtfsStore";
import { mergeTimetableStops } from "../src/lib/engine/mergeTimetableStops";
import type { BusStop } from "../src/lib/types";
import { getFallbackStopDepartures } from "../src/lib/engine/stopScheduleFallback";

const snapshot = getSnapshotBusStops();
const wilczaSnapshot = snapshot.filter((s) => s.snapshotIds?.includes("503") || s.snapshotIds?.includes("949"));
assert.equal(wilczaSnapshot.length, 1);
assert.deepEqual(wilczaSnapshot[0].snapshotIds?.sort(), ["503", "949"]);

const stop = (id: string, lat = 50.8): BusStop => ({ id, name: "Test", lat, lon: 16.3, lines: [id], shelter: false, source: "timetable", gtfsId: id });
const stops = [stop("a"), stop("b"), stop("opposite"), stop("unknown"), stop("far", 50.81)];
const evidence = new Map([
  ["a", { vectors: [[0, 1] as [number, number]] }],
  ["b", { vectors: [[0, 1] as [number, number]] }],
  ["opposite", { vectors: [[0, -1] as [number, number]] }],
]);
const groups = mergeTimetableStops(stops, evidence);
assert.deepEqual(groups.find((s) => s.gtfsId === "a")?.gtfsIds, ["a", "b"]);
assert.ok(groups.some((s) => s.gtfsId === "opposite"));
assert.ok(groups.some((s) => s.gtfsId === "unknown"));
assert.ok(groups.some((s) => s.gtfsId === "far"));
assert.equal(mergeTimetableStops(stops.slice(0, 2), new Map([["a", { symbol: "1" }], ["b", { symbol: "2" }]])).length, 2);
assert.equal(mergeTimetableStops(stops.slice(0, 2), new Map([["a", { symbol: "1", vectors: [[0, 1]] }], ["b", { symbol: "1", vectors: [[0, -1]] }]])).length, 2);

const files: Record<string, string> = {
  "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.com,pl,20260101,20261231\n",
  "routes.txt": "route_id,route_short_name,route_long_name,route_type\nr1,8,Test,3\nr2,9,Test,3\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\n503,Wilcza - Lubiechów,50.83347,16.33941\n949,Wilcza - Lubiechów,50.83348,16.33941\nrev,Wilcza - Lubiechów,50.83347,16.33941\nprev,Początek,50.832,16.33941\nsol,Solicka,50.835,16.34\ncastle,Zamek Książ,50.836,16.34\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign,block_id\nr1,daily,t1,Solicka,8/01\nr2,daily,t2,Zamek Książ,9/01\nr1,daily,t3,Początek,8/02\n",
  "calendar_dates.txt": "service_id,date,exception_type\ndaily,20261119,1\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,07:50:00,07:50:00,prev,1\nt1,08:00:00,08:00:00,503,2\nt1,08:10:00,08:10:00,sol,3\nt2,08:50:00,08:50:00,prev,1\nt2,09:00:00,09:00:00,949,2\nt2,09:10:00,09:10:00,castle,3\nt3,09:50:00,09:50:00,sol,1\nt3,10:00:00,10:00:00,rev,2\nt3,10:10:00,10:10:00,prev,3\n",
};
const zip = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
const start = Date.parse("2026-11-19T00:00:00+01:00");
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("walbrzych-gtfs.zip")) return new Response(zip);
  if (url.endsWith("/stops")) return Response.json({ stops: [
    ["503", "", "Wilcza - Lubiechów", null, [16.33941, 50.83347]],
    ["949", "", "Wilcza - Lubiechów", null, [16.33941, 50.83348]],
  ] });
  if (url.includes("/stops/")) {
    const id = new URL(url).pathname.split("/").at(-1);
    const time = id === "503" ? start + 8 * 3600000 : start + 9 * 3600000;
    return Response.json({ departures: [{ scheduledDeparture: time, trip: { route: { name: id === "503" ? "8" : "9" }, headsign: id === "503" ? "Solicka" : "Zamek Książ" } }] });
  }
  return new Response("", { status: 404 });
};
const { stops: gtfs } = await getTimetableStops();
const grouped = gtfs.find((s) => s.gtfsIds?.includes("503"));
assert.ok(grouped);
assert.deepEqual(grouped.gtfsIds, ["503", "949"]);
assert.deepEqual(grouped.lines, ["8", "9"]);
assert.ok(gtfs.some((s) => s.gtfsId === "rev"), "opposite direction must remain separate even at identical coordinates");
const args = { lat: grouped.lat, lon: grouped.lon, name: grouped.name, stopIds: grouped.gtfsIds, fromMs: start, toMs: start + 86400000, includeLive: false };
const result = await getStopDepartures(args);
assert.deepEqual(result.departures.map((d) => [d.clock, d.finalStop]), [["08:00", "Solicka"], ["09:00", "Zamek Książ"]]);
assert.deepEqual((await getStopDepartures({ ...args, limit: 1 })).departures.map((d) => d.clock), ["08:00"]);
await assert.rejects(getStopDepartures({ ...args, stopIds: ["503", "missing"] }), /Brak identyfikatora/);
const fallback = await getFallbackStopDepartures(grouped, start, start + 86400000, new AbortController().signal);
assert.deepEqual(fallback.departures.map((d) => d.finalStop), ["Solicka", "Zamek Książ"]);
await assert.rejects(getFallbackStopDepartures({ ...grouped, gtfsIds: ["503", "missing"] }, start, start + 86400000, new AbortController().signal), /wszystkich części/);
console.log("same-platform merging and combined timetable tests passed");
