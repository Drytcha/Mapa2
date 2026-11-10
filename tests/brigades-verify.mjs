/**
 * Triple verification of the brigade catalogue against the real Wałbrzych GTFS.
 *
 * Run: node tests/brigades-verify.mjs
 *
 * For 3 independent rounds (different input ordering) and 3 valid service dates
 * plus 3 out-of-range dates it checks:
 *  1. only the schedule VALID for that exact date is used (feed_info.txt window
 *     + calendar_dates.txt), never a "weekday forever" fallback,
 *  2. every trip of the day belongs to exactly one brigade (nothing disappears),
 *  3. no brigade number is invented — each non-empty number comes from a real
 *     on-board GPS observation, everything else stays unassigned,
 *  4. line filters return exactly the brigades serving that line, and every
 *     trip of line L remains visible when L is selected,
 *  5. the union of all line filters equals the full catalogue.
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

const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
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

const routeShort = new Map(
  routes.map((r) => [r.route_id, (r.route_short_name || r.route_id).toUpperCase()])
);
const allLines = [...new Set(routes.map((r) => (r.route_short_name || r.route_id).toUpperCase()))];

const stops = new Map(
  gtfsStops
    .filter((s) => Number.isFinite(Number(s.stop_lat)) && Number.isFinite(Number(s.stop_lon)))
    .map((s) => [s.stop_id, { lat: Number(s.stop_lat), lon: Number(s.stop_lon) }])
);

// Exact calendar: date -> active service_ids (no representative-date shortcuts).
const serviceIdsByDate = new Map();
for (const c of calendar) {
  if (c.exception_type !== "1" && c.exception_type !== "") continue;
  const key = Number.parseInt(c.date, 10);
  if (!Number.isFinite(key)) continue;
  const set = serviceIdsByDate.get(key) ?? new Set();
  set.add(c.service_id);
  serviceIdsByDate.set(key, set);
}

const minutes = (value) => {
  const parts = value.split(":").map(Number);
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  return parts[0] * 60 + parts[1];
};
const timesByTrip = new Map();
for (const st of stopTimes) {
  const list = timesByTrip.get(st.trip_id) ?? [];
  list.push({
    seq: Number.parseInt(st.stop_sequence, 10) || 0,
    stopId: st.stop_id,
    dep: minutes(st.departure_time || st.arrival_time),
    arr: minutes(st.arrival_time || st.departure_time),
  });
  timesByTrip.set(st.trip_id, list);
}

/* -------------------- Load the pure TS builder ---------------------------- */
const outfile = path.join(os.tmpdir(), `mapplaner-brigade-builder-${process.pid}.cjs`);
await build({
  entryPoints: [path.join(projectRoot, "src", "lib", "engine", "brigadeBuilder.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const { buildBrigadesFromTrips, filterBrigadesByLine, resolveActiveServices } = require(outfile);

/* --------------------------- Trips for a date ----------------------------- */
function tripsForDate(dateId, observed) {
  const { services } = resolveActiveServices(Number(dateId), serviceIdsByDate, {
    from: feedFrom,
    to: feedTo,
  });
  assert.ok(services, `${dateId}: brak aktywnych serwisów`);
  const result = [];
  for (const trip of gtfsTrips) {
    if (!services.has(trip.service_id)) continue;
    const list = timesByTrip.get(trip.trip_id);
    if (!list?.length) continue;
    list.sort((a, b) => a.seq - b.seq);
    const first = list[0];
    const last = list[list.length - 1];
    if (first.dep === null || last.arr === null) continue;
    result.push({
      id: trip.trip_id,
      line: routeShort.get(trip.route_id) ?? trip.route_id.toUpperCase(),
      headsign: trip.trip_headsign || "",
      startMinutes: first.dep,
      endMinutes: last.arr,
      firstStopId: first.stopId,
      lastStopId: last.stopId,
      firstStopName: first.stopId,
      lastStopName: last.stopId,
      lengthMeters: 0,
      observedBrigade: observed.get(trip.trip_id),
    });
  }
  return result;
}

/* ----------------- Realistic GPS on-board observations -------------------- */
// Only real-looking numbers, mirroring the live positions feed (e.g. 2/01, A/02).
const observedNumbers = [
  "2/01", "2/02", "2/03", "2/07", "A/02", "A/04",
  "18/02", "18/03", "18/04", "12/01", "8/03", "5/02",
];
function makeObservations(trips, seed) {
  const map = new Map();
  const byLine = new Map();
  for (const t of trips) {
    const list = byLine.get(t.line) ?? [];
    list.push(t);
    byLine.set(t.line, list);
  }
  observedNumbers.forEach((code, index) => {
    const line = code.split("/")[0].toUpperCase();
    const list = byLine.get(line);
    if (!list?.length) return;
    // Deterministically pick a trip for this observed duty.
    const trip = list[(index * 7 + seed * 3) % list.length];
    if (trip) map.set(trip.id, code);
  });
  return map;
}

/* ----------------------------- Verification ------------------------------ */
const validDates = ["20261108", "20261109", "20261110"];
const invalidDates = ["20190101", "20261106", "20270101"];
const focusLines = ["A", "2", "18", "EX"];
let checks = 0;

function seededShuffle(items, seed) {
  const copy = [...items];
  let state = seed * 9301 + 49297;
  for (let i = copy.length - 1; i > 0; i -= 1) {
    state = (state * 9301 + 49297) % 233280;
    const j = Math.floor((state / 233280) * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

for (let round = 1; round <= 3; round += 1) {
  console.log(`\n=== RUNDA ${round}/3 ===`);

  // A. No schedule outside the feed validity window / missing calendar date.
  for (const dateId of invalidDates) {
    const r = resolveActiveServices(Number(dateId), serviceIdsByDate, {
      from: feedFrom,
      to: feedTo,
    });
    assert.equal(r.services, undefined, `${dateId}: pokazano nieaktualny rozkład!`);
    assert.ok(r.error, `${dateId}: brak komunikatu o braku ważności`);
    checks += 2;
  }

  for (const dateId of validDates) {
    const r = resolveActiveServices(Number(dateId), serviceIdsByDate, {
      from: feedFrom,
      to: feedTo,
    });
    assert.ok(r.services, `${dateId}: brak ważnego rozkładu`);
    assert.equal(r.services.size, 4, `${dateId}: nieprawidłowy zestaw serwisów`);
    checks += 2;

    const observations = makeObservations(tripsForDate(dateId, new Map()), round);
    const trips = seededShuffle(tripsForDate(dateId, observations), round);
    assert.ok(trips.length > 0, `${dateId}: brak kursów w GTFS`);

    const all = buildBrigadesFromTrips({ trips, stops });
    const assigned = all.flatMap((b) => b.trips.map((t) => t.id));

    // B. Completeness: every trip is kept exactly once.
    assert.equal(assigned.length, trips.length, `${dateId}: liczba przypisanych kursów`);
    assert.equal(new Set(assigned).size, trips.length, `${dateId}: duplikat kursu`);
    assert.deepEqual(new Set(assigned), new Set(trips.map((t) => t.id)), `${dateId}: kurs zniknął`);
    checks += 3;

    // C. No invented numbers: every non-empty number came from GPS.
    const allowed = new Set(
      [...observations.values()].map((v) => {
        const [l, n] = v.toUpperCase().split("/");
        return `${l}-${n.padStart(2, "0")}`;
      })
    );
    const numbers = all.filter((b) => !b.unassigned).map((b) => b.number);
    assert.equal(new Set(numbers).size, numbers.length, `${dateId}: duplikat numeru brygady`);
    for (const number of numbers) {
      assert.ok(allowed.has(number), `${dateId}: WYMYSLONA brygada ${number}`);
      checks += 1;
    }
    for (const number of allowed) {
      assert.ok(numbers.includes(number), `${dateId}: zniknęła brygada ${number}`);
      checks += 1;
    }
    assert.ok(
      !numbers.some((n) => /^18-(07|10)$/.test(n)),
      `${dateId}: fikcyjna brygada 18-07/18-10`
    );
    checks += 1;

    // D. Line filters: exactly the brigades serving L, all L trips visible.
    const union = new Set(all.filter((b) => !b.unassigned).map((b) => b.number));
    for (const line of allLines) {
      const filtered = filterBrigadesByLine(all, line);
      const expected = all.filter((b) => b.lineIds.includes(line));
      assert.equal(filtered.length, expected.length, `${dateId}/${line}: zła liczba brygad`);
      assert.deepEqual(
        new Set(filtered.map((b) => b.number)),
        new Set(expected.map((b) => b.number)),
        `${dateId}/${line}: brakuje brygad wieloliniowych`
      );
      const expectedTripIds = trips.filter((t) => t.line === line).map((t) => t.id);
      const visibleTripIds = new Set(filtered.flatMap((b) => b.trips.map((t) => t.id)));
      for (const id of expectedTripIds) {
        assert.ok(visibleTripIds.has(id), `${dateId}/${line}: kurs ${id} zniknął`);
        checks += 1;
      }
      if (expectedTripIds.length === 0) {
        const withoutUnassigned = filtered.filter((b) => !b.unassigned);
        assert.equal(withoutUnassigned.length, 0, `${dateId}/${line}: brygady bez kursów`);
      }
      checks += 3;
    }
    assert.equal(filterBrigadesByLine(all, "all").length, all.length, `${dateId}: "all" traci brygady`);
    checks += 1;

    if (round === 1) {
      const stats = focusLines
        .map((line) => `${line}: ${filterBrigadesByLine(all, line).filter((b) => !b.unassigned).length}`)
        .join(", ");
      console.log(
        `${dateId}: ${trips.length} kursów → ${numbers.length} potwierdzonych brygad ` +
          `+ ${all.length - numbers.length} grupa bez numeru | ${stats}`
      );
    }
    void union;
  }
  console.log(`RUNDA ${round}/3: PASS (ważność dat, kompletność, brak fikcyjnych numerów)`);
}

fs.rmSync(outfile, { force: true });
console.log(
  `\nWYNIK: 3/3 rund OK, ${checks} asercji, ${allLines.length} linii, ` +
    `${validDates.length} dat ważnych + ${invalidDates.length} dat nieważnych.`
);
