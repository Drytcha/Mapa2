import assert from "node:assert/strict";
import { distanceCoords } from "../src/lib/core/spatial";
import { timetableDisplayRows, type TimetablePdfDuty, type TimetablePdfTrip } from "../src/lib/engine/dutyTimetablePdf";
import type { BrigadeItem, BrigadeStop, BrigadeTripView } from "../src/lib/engine/brigades";

const stop = (id: string, lat?: number): BrigadeStop => ({ id, name: id, ...(lat === undefined ? {} : { lat, lon: 16 }) });
const row = (id: string, startMin: number, endMin: number, first: BrigadeStop, last: BrigadeStop, lineId = "8"): TimetablePdfTrip => ({
  trip: { id, lineId, destination: last.name, length: 0, startMs: startMin * 60000, endMs: endMin * 60000, firstStop: first, lastStop: last } as BrigadeTripView,
  stops: [{ name: first.name, arrival: startMin, departure: startMin }, { name: last.name, arrival: endMin, departure: endMin }],
});
const duty = (trips: TimetablePdfTrip[], unassigned = false): TimetablePdfDuty => ({ item: { unassigned } as BrigadeItem, trips });
const sequence = (d: TimetablePdfDuty) => timetableDisplayRows(d).rows.map((r) => r.kind === "inferred" ? r.code : r.row.trip.id);
const a = stop("A", 50), b = stop("B", 50.001);
const first = row("first", 360, 380, a, b);
// Threshold is strict: exactly two hours is not a split; >2 h is.
assert.deepEqual(sequence(duty([first, row("same", 500, 520, b, a)])), ["WY", "first", "same", "ZJ"]);
assert.deepEqual(sequence(duty([first, row("after", 501, 520, b, a)])), ["WY", "first", "ZJ", "WY", "after", "ZJ"]);
const degrees = (meters: number) => meters / 6371000 * 180 / Math.PI;
const near = stop("near", 50.001 + degrees(399.9));
const far = stop("far", 50.001 + degrees(400.1));
assert.ok(distanceCoords(b.lat!, b.lon!, near.lat!, near.lon!) < 400);
assert.ok(distanceCoords(b.lat!, b.lon!, far.lat!, far.lon!) > 400);
assert.deepEqual(sequence(duty([first, row("near-trip", 400, 420, near, a)])), ["WY", "first", "near-trip", "ZJ"]);
assert.deepEqual(sequence(duty([first, row("far-trip", 400, 420, far, a)])), ["WY", "first", "PRZ", "far-trip", "ZJ"]);
const unknown = duty([first, row("unknown", 400, 420, stop("unknown"), a)]);
assert.equal(timetableDisplayRows(unknown).missingCoordinates, true);
assert.deepEqual(sequence(unknown), ["WY", "first", "unknown", "ZJ"]);
assert.deepEqual(sequence(duty([first, row("same-id", 400, 420, stop("B"), a)])), ["WY", "first", "same-id", "ZJ"]);
assert.equal(timetableDisplayRows(duty([first, row("same-id", 400, 420, stop("B"), a)])).missingCoordinates, false);
assert.deepEqual(sequence(duty([first], true)), ["first"], "unassigned runs are not a duty");
const explicitWy = row("real-wy", 340, 360, a, a, "WY");
const explicitZJ = row("real-zj", 381, 390, b, a, "ZJ");
const next = row("next", 600, 620, a, b);
assert.deepEqual(sequence(duty([explicitWy, first, explicitZJ, next])), ["real-wy", "first", "real-zj", "WY", "next", "ZJ"]);
const explicitPrz = row("real-prz", 385, 395, b, far, "PRZ");
assert.deepEqual(sequence(duty([first, explicitPrz, row("next", 400, 420, far, a)])), ["WY", "first", "real-prz", "next", "ZJ"], "do not duplicate an explicit technical transfer");
assert.deepEqual(sequence(duty([first, explicitZJ, row("real-wy2", 590, 600, a, a, "WY"), next])), ["WY", "first", "real-zj", "real-wy2", "next", "ZJ"], "do not duplicate explicit ZJ/WY around a long break");
const depot = stop("Zajezdnia", 50);
const depotRows = timetableDisplayRows(duty([row("depot-trip", 500, 510, depot, depot)])).rows;
assert.deepEqual(depotRows.map((r) => r.kind === "inferred" ? [r.code, r.from, r.to] : r.row.trip.id), [
  ["WY", "Zajezdnia (do ustalenia)", "Do ustalenia (kurs z zajezdni)"], "depot-trip", ["ZJ", "Do ustalenia (kurs w zajezdni)", "Zajezdnia (do ustalenia)"],
]);
console.log("inferred WY/PRZ/ZJ candidate placement and boundaries passed");
