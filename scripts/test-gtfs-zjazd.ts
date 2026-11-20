import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { getGtfsLines, ensureGtfsSeeded } from "../src/lib/engine/gtfsStore";
import { collectTimetablePdfData, createTimetablePdf, timetableLineLabel, technicalTripsNote } from "../src/lib/engine/dutyTimetablePdf";

// The uploaded 387/388 feed uses both trip_headsign and stop_headsign for
// "Zjazd" on passenger trips. Include a stop-level label outside the four
// displayed checkpoints to ensure we inspect the entire stop sequence.
const csv: Record<string, string> = {
  "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.com,pl,20261107,20261231\n",
  "routes.txt": "route_id,route_short_name,route_long_name,route_type\nr11,11,Linia 11,3\n",
  "stops.txt": Array.from({ length: 10 }, (_, i) => `${i},Przystanek ${i},50.78,16.28`).join("\n").replace(/^/, "stop_id,stop_name,stop_lat,stop_lon\n"),
  "trips.txt": "route_id,service_id,trip_id,trip_headsign,block_id\nr11,387_RS,marked-stop,PLAC GRUNWALDZKI,11/02\nr11,387_RS,marked-trip,PLAC GRUNWALDZKI Zjazd,11/02\nr11,387_RS,regular,Przejazdowa,11/02\n",
  "calendar_dates.txt": "service_id,date,exception_type\n387_RS,20261120,1\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type\n" +
    Array.from({ length: 10 }, (_, i) => `marked-stop,20:${String(i).padStart(2, "0")}:00,20:${String(i).padStart(2, "0")}:00,${i},${i + 1},${i === 2 ? "PLAC GRUNWALDZKI Zjazd" : ""},0,0`).join("\n") +
    "\nmarked-trip,21:00:00,21:00:00,0,1,,0,0\nmarked-trip,21:10:00,21:10:00,1,2,,0,0\nregular,22:00:00,22:00:00,0,1,,0,0\nregular,22:10:00,22:10:00,1,2,,0,0\n",
};
const zip = zipSync(Object.fromEntries(Object.entries(csv).map(([name, text]) => [name, strToU8(text)])));
globalThis.fetch = async (input) => String(input).includes("walbrzych-gtfs.zip") ? new Response(zip) : new Response("", { status: 404 });
const routes = (await getGtfsLines()).routes;
const store = await ensureGtfsSeeded();
assert.equal(store.base.rawStopTimesByTrip.get("marked-stop")?.[2].stopHeadsign, "PLAC GRUNWALDZKI Zjazd");
const data = await collectTimetablePdfData(routes, "20261120", { kind: "line", line: "11" });
const duty = data.duties[0];
assert.deepEqual(duty.trips.map((row) => [row.trip.id, row.trip.lineId, timetableLineLabel(row)]), [
  ["marked-stop", "11", "11/ZJ*"], ["marked-trip", "11", "11/ZJ*"], ["regular", "11", "11"],
]);
assert.equal(duty.item.metrics.revenueTrips, 3);
assert.equal(duty.item.metrics.technicalTrips, 0);
assert.match(technicalTripsNote(duty), /Brak osobnych przejazdów technicznych w danych: WY, PRZ, ZJ/);
assert.equal((await createTimetablePdf(data)).getNumberOfPages(), 1);
assert.equal(timetableLineLabel({ ...duty.trips[2], trip: { ...duty.trips[2].trip, destination: "Zjazdowa", lineId: "11" } }), "11");
console.log("GTFS direction zjazd is marked without creating or reclassifying trips");
