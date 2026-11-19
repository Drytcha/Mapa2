import assert from "node:assert/strict";
import { DateTime } from "luxon";
import sample from "./fixtures/zbiorkom-stop-sample.json";
import { getSnapshotBusStops } from "../src/lib/busStops";
import { getFallbackStopDepartures, matchFallbackStop } from "../src/lib/engine/stopScheduleFallback";

// The sample contains real, historical API responses; every test below is a
// deterministic replay, not a claim about current service.
const stop = getSnapshotBusStops().find((entry) => entry.id === "snapshot-3")!;
assert.ok(stop);
const actual = { id: "pilsudskiego-plac-tuwima-a8ncm", name: stop.name, lat: stop.lat, lon: stop.lon };
const opposite = { ...actual, id: "opposite", lat: actual.lat + 0.0003 };
assert.equal(matchFallbackStop(stop, [opposite, actual])?.id, actual.id);
assert.equal(matchFallbackStop(stop, [{ ...actual, name: "Inny przystanek" }]), null);
assert.equal(matchFallbackStop(stop, [{ ...actual, lat: actual.lat + 0.001 }]), null);
assert.equal(matchFallbackStop(stop, [actual, { ...actual, id: "ambiguous" }]), null);
assert.equal(matchFallbackStop({ ...stop, gtfsId: "ambiguous" }, [actual, { ...actual, id: "ambiguous" }])?.id, "ambiguous");

const from = DateTime.fromISO("2026-11-19", { zone: "Europe/Warsaw" }).startOf("day").toMillis();
const to = DateTime.fromISO("2026-11-20", { zone: "Europe/Warsaw" }).startOf("day").toMillis();
const realRows = sample.departuresByStop["pilsudskiego-plac-tuwima-a8ncm"];
// Add synthetic simultaneous and cancelled departures to exercise paging.
const rows = [
  realRows[0],
  { ...realRows[0], scheduledDeparture: realRows[0].scheduledDeparture + 60_000, isCancelled: true },
  realRows[1],
  { ...realRows[1], trip: { ...realRows[1].trip, route: { ...realRows[1].trip.route, name: "7" } } },
  realRows[2],
  realRows[3],
];
let mode: "ok" | "bad" | "hang" = "ok";
let pageRequests = 0;
let started: (() => void) | undefined;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/stops")) return Response.json({ stops: sample.stops });
  assert.equal(url.pathname.split("/").at(-1), actual.id);
  pageRequests += 1;
  if (mode === "bad") return Response.json({ wrong: [] });
  if (mode === "hang") return new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener("abort", abort, { once: true });
    started?.();
  });
  const cursor = Number(url.searchParams.get("time"));
  // Simulate a service-imposed page limit and inclusive boundary timestamps.
  return Response.json({ departures: rows.filter((row) => row.scheduledDeparture >= cursor).slice(0, 3) });
};

const result = await getFallbackStopDepartures(stop, from, to, new AbortController().signal);
assert.equal(result.matched?.id, actual.id);
assert.deepEqual(result.departures.map((d) => [d.routeShort, d.clock]), [
  ["5", "04:30"], ["20", "04:40"], ["7", "04:40"], ["15", "05:01"],
]);
assert.ok(result.departures.every((d) => d.canPreviewCourse === false));
assert.ok(result.departures.every((d) => d.atMs >= from && d.atMs < to));
assert.ok(pageRequests > 1, "server page limit should not silently truncate the day");

mode = "bad";
await assert.rejects(getFallbackStopDepartures(stop, from, to, new AbortController().signal), /Nieprawidłowy rozkład/);
mode = "hang";
const controller = new AbortController();
const requestStarted = new Promise<void>((resolve) => { started = resolve; });
const pending = getFallbackStopDepartures(stop, from, to, controller.signal);
await requestStarted;
controller.abort();
await assert.rejects(pending, (error) => error instanceof DOMException && error.name === "AbortError");
console.log("fallback timetable matching, paging and cancellation tests passed");
