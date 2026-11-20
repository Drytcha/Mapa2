import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { getGtfsLines, ensureGtfsSeeded } from "../src/lib/engine/gtfsStore";
import { collectTimetablePdfData, createTimetablePdf, technicalTripsNote } from "../src/lib/engine/dutyTimetablePdf";
import { technicalTripCode } from "../src/lib/engine/technicalTrips";

assert.equal(technicalTripCode("8", "WY", "Wrocławska"), "WY");
assert.equal(technicalTripCode("8", "", "Zjazd do zajezdni"), "ZJ");
assert.equal(technicalTripCode("PRZ", "", "Plac"), "PRZ");
assert.equal(technicalTripCode("8", "", "Zajezdnia"), undefined, "a depot destination does not prove a technical trip");
assert.equal(technicalTripCode("8", "", "Przejazdowa - Wyjazd"), undefined, "do not guess from substrings");

const csv: Record<string, string> = {
  "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.com,pl,20260101,20261231\n",
  "routes.txt": "route_id,route_short_name,route_long_name,route_type\nr8,8,Linia 8,3\ntech,PRZ,Przejazd,3\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\na,Zajezdnia,,\nb,Początek,50.78,16.28\nc,Koniec,50.79,16.28\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign,trip_short_name,block_id\nr8,daily,out,Początek,WY,8/01\nr8,daily,bus,Koniec,,8/01\nr8,daily,move,Przejazd techniczny,,8/01\nr8,daily,return,Zjazd do zajezdni,,8/01\nr8,daily,regular,Zajezdnia,,8/01\ntech,daily,other,Inny,,9/02\nr8,otherday,inactive,Początek,WY,8/01\n",
  "calendar_dates.txt": "service_id,date,exception_type\ndaily,20261119,1\notherday,20261120,1\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nout,06:00:00,06:00:00,a,1,1,1\nout,06:10:00,06:10:00,b,2,1,1\nbus,06:15:00,06:15:00,b,1,0,0\nbus,06:25:00,06:25:00,c,2,0,0\nmove,06:30:00,06:30:00,c,1,1,1\nmove,06:40:00,06:40:00,b,2,1,1\nreturn,06:45:00,06:45:00,b,1,1,1\nreturn,07:00:00,07:00:00,a,2,1,1\nregular,07:05:00,07:05:00,b,1,0,0\nregular,07:15:00,07:15:00,a,2,0,0\nother,08:00:00,08:00:00,a,1,1,1\nother,08:15:00,08:15:00,b,2,1,1\ninactive,09:00:00,09:00:00,a,1,1,1\ninactive,09:15:00,09:15:00,b,2,1,1\n",
};
const zip = zipSync(Object.fromEntries(Object.entries(csv).map(([name, text]) => [name, strToU8(text)])), { level: 0 });
globalThis.fetch = async (input) => String(input).includes("walbrzych-gtfs.zip") ? new Response(zip) : new Response("", { status: 404 });
const routes = (await getGtfsLines()).routes;
const store = await ensureGtfsSeeded();
assert.equal(store.base.rawTripsById.get("out")?.technicalCode, "WY");
assert.equal(store.base.stopsById.has("a"), false, "a depot without coordinates is not placed on the map");
assert.equal(store.base.stopNamesById.get("a"), "Zajezdnia");
assert.equal(store.base.rawTripsById.get("move")?.technicalCode, "PRZ");
assert.equal(store.base.rawTripsById.get("return")?.technicalCode, "ZJ");
assert.equal(store.base.rawTripsById.get("regular")?.technicalCode, undefined);
const data = await collectTimetablePdfData(routes, "20261119", { kind: "line", line: "8" });
assert.equal(data.duties.length, 1);
const duty = data.duties[0];
assert.deepEqual(duty.trips.map(({ trip }) => [trip.id, trip.lineId]), [["out", "WY"], ["bus", "8"], ["move", "PRZ"], ["return", "ZJ"], ["regular", "8"]]);
assert.deepEqual(duty.trips[0].stops.map((s) => [s.name, s.departure]), [["Zajezdnia", 360], ["Początek", 370]]);
assert.deepEqual(duty.trips[2].stops.map((s) => [s.name, s.departure]), [["Koniec", 390], ["Początek", 400]]);
assert.deepEqual(duty.trips[3].stops.map((s) => [s.name, s.departure]), [["Początek", 405], ["Zajezdnia", 420]]);
assert.match(technicalTripsNote(duty), /według dostępnych danych/);
assert.match(technicalTripsNote({ ...duty, trips: duty.trips.filter(({ trip }) => trip.lineId === "8") }), /Nie znaleziono w danych: WY, PRZ, ZJ/);
const pdf = await createTimetablePdf(data);
assert.equal(pdf.getNumberOfPages(), 1);
if (process.env.DUTY_PDF_TECHNICAL_OUTPUT) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(process.env.DUTY_PDF_TECHNICAL_OUTPUT, Buffer.from(pdf.output("arraybuffer")));
}
const other = await collectTimetablePdfData(routes, "20261119", { kind: "line", line: "9" });
assert.deepEqual(other.duties[0].trips.map(({ trip }) => trip.lineId), ["PRZ"], "technical-only duty still belongs to its numbered line");
console.log("explicit technical GTFS trips and missing-data warning tests passed");
