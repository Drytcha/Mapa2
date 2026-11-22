// npm run test:load
// Test wczytywania danych GTFS: brak ponownego parsowania tej samej paczki,
// parsowanie porcjami (interfejs nie dostaje jednego długiego zadania) oraz
// leniwe kształty tras.
import assert from "node:assert/strict";
import { buildSyntheticGtfs } from "./lib/syntheticGtfs";

const feed = buildSyntheticGtfs({
  routes: 12,
  stops: 300,
  tripsPerService: 260,
  stopsPerTrip: 24,
  shapes: 40,
  pointsPerShape: 120,
});

const zip = feed.zip;
const realFetch = globalThis.fetch;
(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("kind=operators")) {
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes(".zip") || url.includes("/api/transit/gtfs")) {
    return new Response(zip, { status: 200, headers: { "content-type": "application/zip" } });
  }
  throw new Error(`nieoczekiwane zapytanie: ${url}`);
}) as typeof fetch;

const { clearTimings, getTimings } = await import("../src/lib/core/perfMarks");
const {
  ensureGtfsSeeded,
  getLineRouteGeometry,
  getGtfsLines,
  ensureShapesReady,
  syncWalbrzychGtfs,
} = await import("../src/lib/engine/gtfsStore");

const stages = () => getTimings().map((timing) => timing.name);

// 1. Pierwsze wczytanie: rozpakowanie + CSV, ale BEZ shapes.txt.
clearTimings();
const first = performance.now();
const store = await ensureGtfsSeeded();
const firstMs = performance.now() - first;
const firstStages = [...stages()];
assert.ok(store.base.rawTrips.length > 0, "rozkład musi się wczytać");
assert.ok(firstStages.includes("gtfs:unzip"), "zimny start rozpakowuje paczkę");
assert.ok(!firstStages.includes("gtfs:shapes"), "shapes.txt nie może być parsowany na starcie");
assert.equal(store.base.shapesById.size, 0, "kształty dochodzą leniwie");

// 2. Parsowanie jest przerywane: w trakcie wczytywania przeglądarka dostaje
//    sterowanie (timer wykonuje się, zanim wczytywanie się skończy).
await syncWalbrzychGtfs({ forceLive: true });
let ticks = 0;
const timer = setInterval(() => {
  ticks += 1;
}, 1);
const reload = syncWalbrzychGtfs({ forceLive: true });
await reload;
clearInterval(timer);
assert.ok(ticks > 0, `wczytywanie musi oddawać sterowanie (ticki: ${ticks})`);

// 3. Ta sama paczka nie jest parsowana drugi raz.
clearTimings();
const again = performance.now();
await syncWalbrzychGtfs();
const againMs = performance.now() - again;
assert.ok(!stages().includes("gtfs:unzip"), "ta sama paczka nie jest rozpakowywana ponownie");
assert.ok(againMs < firstMs, `powtórne wczytanie (${Math.round(againMs)} ms) szybsze od zimnego (${Math.round(firstMs)} ms)`);

// 4. Kształty: pobierane dopiero przy rysowaniu trasy i tylko raz.
const current = await ensureGtfsSeeded();
const lines = await getGtfsLines();
assert.ok(lines.routes[0], "paczka ma linie");
const before = getTimings().length;
const geometry = await getLineRouteGeometry(lines.routes[0].shortName);
assert.ok(stages().includes("gtfs:shapes"), "rysowanie trasy dociąga shapes.txt");
assert.ok(current.base.shapesById.size > 0, "kształty trafiają do bazy");
assert.ok(geometry && geometry.points.length >= 2, "trasa ma geometrię z shapes.txt");

clearTimings();
await ensureShapesReady(current);
assert.ok(!stages().includes("gtfs:shapes"), "kształty parsowane są tylko raz");
assert.ok(before >= 0);

(globalThis as { fetch: typeof fetch }).fetch = realFetch;
console.log("OK: wczytywanie GTFS — bez ponownego parsowania, porcjami, kształty leniwie");
