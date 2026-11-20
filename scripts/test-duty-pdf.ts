import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { TIMETABLE_LEGEND_RESERVED_LINES, collectTimetablePdfData, createTimetablePdf, selectTimetableDuties, selectTimetableCheckpoints, timetableLegendText, timetablePdfSheets, timetablePdfFilename, timetableDisplayRows } from "../src/lib/engine/dutyTimetablePdf";
import { getGtfsLines } from "../src/lib/engine/gtfsStore";
import { summariseBrigade } from "../src/lib/brigadeMetrics";
import type { BrigadeItem, BrigadeTripView } from "../src/lib/engine/brigades";

const trip = (id: string, lineId: string): BrigadeTripView => ({ id, lineId, destination: "Cel", length: 1000, startMs: 100000000, endMs: 100060000, firstStop: { id: "a", name: "A" }, lastStop: { id: "b", name: "B" } });
const makeItem = (number: string, operatorKey: "mzuk" | "ska" | "other", trips: BrigadeTripView[], unassigned = false): BrigadeItem => ({
  number, operatorKey, operatorLabel: operatorKey, operatorName: operatorKey, blockId: number || "loose", primaryLine: trips[0]?.lineId ?? "", lineIds: [...new Set(trips.map((t) => t.lineId))], serviceIds: [], times: [], tripCount: trips.length, workSpans: [], source: "gtfs", unassigned, trips, metrics: summariseBrigade(trips),
});
const items = [makeItem("8-01", "mzuk", [trip("one", "8"), trip("two", "9")]), makeItem("9-02", "ska", [trip("three", "9")]), makeItem("", "other", [trip("four", "8"), trip("five", "9")], true)];
assert.deepEqual(selectTimetableDuties(items, { kind: "duty", blockId: "8-01" }).map((i) => i.number), ["8-01"]);
assert.deepEqual(selectTimetableDuties(items, { kind: "company", company: "mzuk" }).map((i) => i.number), ["8-01"]);
const lineEight = selectTimetableDuties(items, { kind: "line", line: "8" });
assert.deepEqual(lineEight.map((i) => i.trips.map((t) => t.id)), [["one", "two"], ["four"]]);
assert.equal(items[2].trips.length, 2, "filter must not mutate the catalogue");
assert.match(timetablePdfFilename("20261119", { kind: "line", line: "S1" }), /20261119-linia-S1\.pdf$/);

const stopRows = Array.from({ length: 90 }, (_, i) => `s${i},Przystanek ${i} Zażółć gęślą jaźń,50.${String(77000 + i).padStart(5, "0")},16.28`).join("\n");
const timeRows = Array.from({ length: 90 }, (_, i) => `t1,${String(23 + Math.floor((30 + i) / 60)).padStart(2, "0")}:${String((30 + i) % 60).padStart(2, "0")}:00,${String(23 + Math.floor((30 + i) / 60)).padStart(2, "0")}:${String((30 + i) % 60).padStart(2, "0")}:00,s${i},${i + 1}`).join("\n");
const files: Record<string, string> = {
  "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.com,pl,20260101,20261231\n",
  "routes.txt": "route_id,route_short_name,route_long_name,route_type\nr1,8,Test,3\nr2,9,Test,3\n",
  "stops.txt": `stop_id,stop_name,stop_lat,stop_lon\n${stopRows}\n`,
  "trips.txt": "route_id,service_id,trip_id,trip_headsign,block_id\nr1,daily,t1,Przystanek 89,8/01\nr2,daily,t2,Przystanek 1,8/01\nr2,daily,t3,Przystanek 1,9/02\n",
  "calendar_dates.txt": "service_id,date,exception_type\ndaily,20261119,1\n",
  "stop_times.txt": `trip_id,arrival_time,departure_time,stop_id,stop_sequence\n${timeRows}\nt2,08:00:00,08:00:00,s0,1\nt2,08:10:00,08:10:00,s1,2\nt3,10:00:00,10:00:00,s0,1\nt3,10:10:00,10:10:00,s1,2\n`,
};
const zip = zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])));
globalThis.fetch = async (input) => String(input).includes("walbrzych-gtfs.zip") ? new Response(zip) : new Response("", { status: 404 });
const routes = (await getGtfsLines()).routes;
const data = await collectTimetablePdfData(routes, "20261119", { kind: "line", line: "8" });
assert.equal(data.duties.length, 1);
const selectedDuty = data.duties[0].item;
const singleDuty = await collectTimetablePdfData(routes, "20261119", { kind: "duty", blockId: selectedDuty.blockId });
assert.deepEqual(singleDuty.duties.map((entry) => entry.item.blockId), [selectedDuty.blockId]);
const company = await collectTimetablePdfData(routes, "20261119", { kind: "company", company: selectedDuty.operatorKey });
assert.ok(company.duties.some((entry) => entry.item.blockId === selectedDuty.blockId));
assert.ok(company.duties.every((entry) => entry.item.operatorKey === selectedDuty.operatorKey));
assert.deepEqual(data.duties[0].trips.map((row) => row.trip.id), ["t2", "t1"], "full multi-line duty in chronological order");
assert.equal(data.duties[0].trips[1].stops.length, 90);
assert.equal(data.duties[0].trips[1].stops[89].name, "Przystanek 89 Zażółć gęślą jaźń");
assert.ok(data.duties[0].trips[1].stops.some((s) => s.departure >= 1440));
const pdf = await createTimetablePdf(data);
assert.equal(pdf.getNumberOfPages(), 1, "one complete duty always occupies one page, even with 90 stops");
await assert.rejects(createTimetablePdf({ ...data, duties: [{ ...data.duties[0], trips: [{ ...data.duties[0].trips[0], stops: [] }] }] }), /Brak przystanków/);
const checkpoints = selectTimetableCheckpoints(data.duties[0].trips[1].stops);
assert.equal(checkpoints.length, 4);
assert.equal(checkpoints[0].name, data.duties[0].trips[1].stops[1].name);
assert.equal(checkpoints[3].name, data.duties[0].trips[1].stops[88].name);
assert.deepEqual(selectTimetableCheckpoints(data.duties[0].trips[1].stops.slice(0, 4)), data.duties[0].trips[1].stops.slice(1, 3));
assert.deepEqual(selectTimetableCheckpoints(data.duties[0].trips[1].stops.slice(0, 2)), []);
const dense = { ...data, duties: [{ ...data.duties[0], trips: Array.from({ length: 80 }, (_, i) => ({ ...data.duties[0].trips[i % 2], trip: { ...data.duties[0].trips[i % 2].trip, id: `dense-${i}` } })) }] };
const densePdf = await createTimetablePdf({ ...dense, notice: "Brak kursówki testowej" });
if (process.env.DUTY_PDF_TEST_DENSE_OUTPUT) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(process.env.DUTY_PDF_TEST_DENSE_OUTPUT, Buffer.from(densePdf.output("arraybuffer")));
}
assert.equal(densePdf.getNumberOfPages(), 1, "dense duty and warning must not create another page");
const pages = densePdf.internal.pages as unknown as string[][];
// Six summary boxes, six shaded header cells (background + border), one
// background for every other row and thirteen bordered cells per row.
const denseRowCount = timetableDisplayRows(dense.duties[0]).rows.length;
assert.equal(pages[1].filter((instruction) => / re(?:\s|$)/.test(instruction)).length, 6 + 12 + Math.floor(denseRowCount / 2) + 13 * denseRowCount);
// Full-width fills must be on the second, fourth, ... course only. The
// header is already shaded; do not shade the first course too.
const stripeRects = (page: string[]) => page.filter((instruction) => {
  if (!/ re(?:\s|$)/.test(instruction)) return false;
  const [, , width] = instruction.split(" ").map(Number);
  return width > 800;
});
const denseStripes = stripeRects(pages[1]);
assert.equal(denseStripes.length, Math.floor(denseRowCount / 2));
// Stopka rezerwuje stałą liczbę linijek, gdy legenda istnieje.
const legendLines = timetableLegendText(dense.duties[0]) ? TIMETABLE_LEGEND_RESERVED_LINES : 0;
const legendHeight = Math.max(0, legendLines - 1) * 3.6;
const rowHeight = (densePdf.internal.pageSize.getHeight() - 18 - legendHeight - 31) / denseRowCount;
for (let i = 0; i < denseStripes.length; i++) {
  const y = Number(denseStripes[i].split(" ")[1]);
  const expectedY = (densePdf.internal.pageSize.getHeight() - 31 - (i * 2 + 1) * rowHeight) * 72 / 25.4;
  assert.ok(Math.abs(y - expectedY) < 0.01, `Wrong zebra stripe at row ${i * 2 + 1}`);
}
const multi = await createTimetablePdf({ ...data, duties: [data.duties[0], data.duties[0]] });
assert.equal(multi.getNumberOfPages(), 2, "each of two duties occupies exactly one page");
const multiPages = multi.internal.pages as unknown as string[][];
const perDutyStripes = Math.floor(timetableDisplayRows(data.duties[0]).rows.length / 2);
assert.equal(stripeRects(multiPages[1]).length, perDutyStripes);
assert.equal(stripeRects(multiPages[2]).length, perDutyStripes, "zebra striping restarts after each header");
const loose = { ...dense.duties[0], item: { ...dense.duties[0].item, unassigned: true } };
const looseSheets = timetablePdfSheets([loose]);
assert.deepEqual(looseSheets.map((sheet) => sheet.duty.trips.length), [32, 32, 16]);
assert.equal((await createTimetablePdf({ ...data, duties: [loose] })).getNumberOfPages(), 3, "unassigned runs are labelled batches, not one fictitious duty");
assert.ok(pdf.output("arraybuffer").byteLength > 5000);
if (process.env.DUTY_PDF_TEST_OUTPUT) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(process.env.DUTY_PDF_TEST_OUTPUT, Buffer.from(pdf.output("arraybuffer")));
}
await assert.rejects(collectTimetablePdfData(routes, "20261119", { kind: "line", line: "404" }), /Brak kursów/);
await assert.rejects(collectTimetablePdfData(routes, "20270101", { kind: "line", line: "8" }));
console.log("duty PDF selection, one-page duties and one-row trips tests passed");
