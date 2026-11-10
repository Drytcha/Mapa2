/**
 * Verification of the "only stops served by buses" rule against the real Wałbrzych GTFS.
 *
 * Run: node tests/served-stops-verify.mjs
 *
 * Independently (plain CSV parsing, no app code) it computes the set of stops that
 * have at least one boarding/alighting stop_time on a trip whose service is active
 * inside the feed_info.txt window, then checks that the application pipeline
 * (parseArchiveBytes → buildTimetableStops) returns EXACTLY those stops:
 *  1. every stop on the map is a GTFS stop with scheduled calls,
 *  2. no served GTFS stop is missing,
 *  3. no rozklad.walbrzych.eu-only or OpenStreetMap stop sneaks in,
 *  4. line badges and call counters come from the trips that really call there.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { unzipSync, strFromU8 } from "fflate";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const bundledZip = path.join(projectRoot, "public", "data", "walbrzych-gtfs.zip");
const tmpZip = path.join(os.tmpdir(), "walbrzych-gtfs.zip");
const zipPath = process.env.GTFS_ZIP || (fs.existsSync(bundledZip) ? bundledZip : tmpZip);
if (!fs.existsSync(zipPath)) {
  console.error(
    "Brak archiwum GTFS. Pobierz: curl -sL https://api.zbiorkom.live/api6-open/walbrzych/gtfs/default -o /tmp/walbrzych-gtfs.zip"
  );
  process.exit(1);
}

/* ------------------------------- CSV ------------------------------------- */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const clean = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === '"') {
      if (quoted && clean[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && clean[i + 1] === "\n") i += 1;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map((cols) =>
    Object.fromEntries(header.map((key, index) => [key, cols[index] ?? ""]))
  );
}

const zipBytes = new Uint8Array(fs.readFileSync(zipPath));
const files = unzipSync(zipBytes);
const csv = (name) => parseCsv(strFromU8(files[name]));

const feedInfo = csv("feed_info.txt")[0] ?? {};
const feedFrom = Number.parseInt(feedInfo.feed_start_date ?? "", 10) || 0;
const feedTo = Number.parseInt(feedInfo.feed_end_date ?? "", 10) || 0;
console.log(`feed_info: ważność ${feedFrom} – ${feedTo}, wersja ${feedInfo.feed_version}`);

const routes = csv("routes.txt");
const calendar = csv("calendar_dates.txt");
const gtfsStops = csv("stops.txt");
const gtfsTrips = csv("trips.txt");
const stopTimes = csv("stop_times.txt");

/* ------------------- Independent "served stops" reference ------------------ */
const activeServices = new Set();
for (const c of calendar) {
  if (c.exception_type !== "1" && c.exception_type !== "") continue;
  const d = Number.parseInt(c.date, 10);
  if (!Number.isFinite(d)) continue;
  if ((feedFrom && d < feedFrom) || (feedTo && d > feedTo)) continue;
  activeServices.add(c.service_id);
}
assert.ok(activeServices.size > 0, "calendar_dates.txt nie zawiera aktywnych usług w oknie feedu");

const routeShort = new Map(routes.map((r) => [r.route_id, r.route_short_name || r.route_id]));
const tripById = new Map(gtfsTrips.map((t) => [t.trip_id, t]));
const expectedServed = new Set();
const expectedLines = new Map();
let passThroughRows = 0;
for (const st of stopTimes) {
  const trip = tripById.get(st.trip_id);
  if (!trip || !activeServices.has(trip.service_id)) continue;
  if (st.pickup_type === "1" && st.drop_off_type === "1") {
    passThroughRows += 1;
    continue;
  }
  expectedServed.add(st.stop_id);
  const lines = expectedLines.get(st.stop_id) ?? new Set();
  lines.add(routeShort.get(trip.route_id) ?? trip.route_id);
  expectedLines.set(st.stop_id, lines);
}
const stopIds = new Set(gtfsStops.map((s) => s.stop_id));
const unservedInFeed = gtfsStops.filter((s) => !expectedServed.has(s.stop_id));
console.log(
  `stops.txt: ${gtfsStops.length} · obsługiwane przez aktywne kursy: ${expectedServed.size} · bez kursów: ${unservedInFeed.length} · przejazdy bez zatrzymania: ${passThroughRows}`
);
for (const s of unservedInFeed) console.log(`  ✗ pomijany (brak kursów): ${s.stop_id} ${s.stop_name}`);

/* ----------------------------- App pipeline -------------------------------- */
const outfile = path.join(os.tmpdir(), `mapplaner-served-stops-${Date.now()}.cjs`);
await build({
  stdin: {
    contents: `
      export { parseArchiveBytes } from "./src/lib/engine/gtfsStore";
      export { buildTimetableStops } from "./src/lib/engine/timetableStops";
      export { isServedStop, stopCallsTotal } from "./src/lib/busStops";
    `,
    resolveDir: projectRoot,
    loader: "ts",
  },
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
  alias: { "@": path.join(projectRoot, "src") },
  define: { "import.meta.env": "{}" },
});
const { parseArchiveBytes, buildTimetableStops, isServedStop, stopCallsTotal } = require(outfile);

const base = parseArchiveBytes(zipBytes, "test");
assert.equal(base.stops.length, gtfsStops.length, "parser zgubił przystanki ze stops.txt");
assert.deepEqual(
  [...base.servedStopIds].sort(),
  [...expectedServed].sort(),
  "servedStopIds różni się od niezależnie policzonego zbioru obsługiwanych przystanków"
);

const result = buildTimetableStops({ base });
const shownIds = result.stops.map((s) => s.gtfsId);

// 1 + 3: only GTFS stops with scheduled calls – nothing from rozklad.walbrzych.eu-only or OSM.
for (const stop of result.stops) {
  assert.equal(stop.source, "timetable", `${stop.name}: nieoczekiwane źródło ${stop.source}`);
  assert.ok(stop.gtfsId && stopIds.has(stop.gtfsId), `${stop.name}: brak w stops.txt`);
  assert.ok(expectedServed.has(stop.gtfsId), `${stop.name}: żaden aktywny kurs tu nie staje`);
  assert.ok(!stop.id.startsWith("rj-"), `${stop.name}: przystanek tylko z rozklad.walbrzych.eu`);
  assert.ok(isServedStop(stop), `${stop.name}: isServedStop() = false`);
  assert.ok(stopCallsTotal(stop) > 0, `${stop.name}: zero kursów w licznikach`);
  // 4: lines come from real calls.
  assert.deepEqual(
    [...stop.lines].sort(),
    [...(expectedLines.get(stop.gtfsId) ?? [])].sort(),
    `${stop.name}: linie nie odpowiadają kursom`
  );
}
// 2: nothing served is missing, no duplicates.
assert.equal(new Set(shownIds).size, shownIds.length, "zduplikowane przystanki");
assert.deepEqual(
  [...shownIds].sort(),
  [...expectedServed].sort(),
  "na mapie brakuje obsługiwanych przystanków lub są nadmiarowe"
);
assert.equal(result.meta.unservedGtfs, unservedInFeed.length);

console.log(
  `Mapa: ${result.stops.length} przystanków (wszystkie z kursami) · pominięte GTFS bez kursów: ${result.meta.unservedGtfs} · pominięte tylko-rozklad.walbrzych.eu: ${result.meta.officialOnly}`
);
const busiest = [...result.stops].sort((a, b) => stopCallsTotal(b) - stopCallsTotal(a)).slice(0, 3);
for (const s of busiest) {
  console.log(
    `  ✓ ${s.name}: dni rob. ${s.calls.weekday}, sob. ${s.calls.saturday}, niedz. ${s.calls.sunday} · linie ${s.lines.join(",")}`
  );
}
fs.rmSync(outfile, { force: true });
console.log("OK — na mapie są wyłącznie przystanki obsługiwane przez kursy.");
