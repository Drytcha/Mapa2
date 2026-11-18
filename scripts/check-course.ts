// Diagnostyka: czy podgląd kursu to JEDNA ciągła linia (nawet gdy OSRM nie działa)?
// Użycie: npx tsx scripts/check-course.ts <GTFS (full).zip> [online]
import fs from "node:fs";

process.env.NEXT_PUBLIC_STATIC_EXPORT = "1";
const online = process.argv[3] === "online";
const bytes = new Uint8Array(fs.readFileSync(process.argv[2]));
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("walbrzych-gtfs.zip")) return new Response(bytes, { status: 200 });
  if (online) return realFetch(input, init);
  throw new Error("offline"); // OSRM niedostępny = najgorszy przypadek
}) as typeof fetch;

const { ensureGtfsSeeded, getCoursePreview } = await import("../src/lib/engine/gtfsStore");
const { distanceCoords } = await import("../src/lib/core/spatial");
const store = await ensureGtfsSeeded();
const dateId = "20261201";
const active = store.base.serviceIdsByDate.get(Number(dateId))!;

const trips = [...store.base.rawTripsById.values()].filter((t) => active.has(t.serviceId));
const byShape = new Map<string, string>();
for (const t of trips) if (t.shapeId && !byShape.has(t.shapeId)) byShape.set(t.shapeId, t.rawTripId);
const sample = online ? [...byShape.values()].slice(0, 6) : [...byShape.values()];

let checked = 0, split = 0, approximate = 0, longestChord = 0, started = Date.now();
for (const tripId of sample) {
  const c = await getCoursePreview(tripId, dateId);
  if (!c) continue;
  if (c.approximate) { approximate += 1; continue; }
  checked += 1;
  if (c.polylines.length !== 1) split += 1;
  const line = c.polylines[0] ?? [];
  for (let i = 1; i < line.length; i++) {
    longestChord = Math.max(longestChord, distanceCoords(line[i-1][0], line[i-1][1], line[i][0], line[i][1]));
  }
}
console.log(`mode=${online ? "ONLINE (OSRM)" : "OFFLINE (worst case)"}  courses with shape: ${checked}  stop-chain only: ${approximate}`);
console.log(`courses NOT one continuous line: ${split}   (must be 0; before the fix: 172 of 210)`);
console.log(`longest straight chord left in a line: ${Math.round(longestChord)} m   time: ${((Date.now() - started) / 1000).toFixed(1)} s`);

const c30 = await getCoursePreview("388_3247", dateId);
console.log(`388_3247 (30/01 06:10 ${c30?.headsign}): polylines=${c30?.polylines.length} points=${c30?.polylines[0]?.length} stops=${c30?.stops.length}`);
process.exit(0);
