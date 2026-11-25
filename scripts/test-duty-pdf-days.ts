import assert from "node:assert/strict";
import { closestTimetableDate, timetableBlockForDate, timetableDayChoices } from "../src/lib/engine/dutyPdfDays";

const dates = new Map<number, Set<string>>([
  [20261109, new Set(["387_RS"])],
  [20261111, new Set(["387_NS"])], // Wednesday holiday uses Sunday pattern
  [20261120, new Set(["387_RS"])],
  [20261121, new Set(["387_SO"])],
  [20261122, new Set(["387_NS"])],
  [20261201, new Set(["388_RS"])],
  [20261206, new Set(["388_NH"])], // trading Sunday is a distinct pattern
  [20261207, new Set(["service-without-pattern"])],
  [20261208, new Set(["388_RS", "exception_SO"])], // keep all active services together
  [20270101, new Set(["389_RS"])],
]);
const choices = timetableDayChoices(dates, 20261107, 20261231);
assert.deepEqual(choices.weekday.map((x) => x.dateId), ["20261109", "20261120", "20261201", "20261207", "20261208"]);
assert.deepEqual(choices.saturday.map((x) => x.dateId), ["20261121", "20261208"]);
assert.deepEqual(choices.sunday.map((x) => x.dateId), ["20261111", "20261122"]);
assert.deepEqual(choices.tradingSunday.map((x) => x.dateId), ["20261206"]);
assert.deepEqual(choices.saturday[1].serviceIds, ["388_RS", "exception_SO"], "mixed services remain together on their actual date");
assert.equal(closestTimetableDate(choices.weekday, "20261121"), "20261120");
assert.equal(closestTimetableDate(choices.sunday, "20261121"), "20261122");
assert.equal(closestTimetableDate(choices.tradingSunday, "20261121"), "20261206");
assert.equal(closestTimetableDate([{ dateId: "20261120", serviceIds: [] }, { dateId: "20261122", serviceIds: [] }], "20261121"), "20261122");
assert.equal(closestTimetableDate([], "20261121"), "");
const duty = { blockId: "20261120_8-01", number: "8-01", unassigned: false };
assert.equal(timetableBlockForDate(duty, "20261120", "20261120"), duty.blockId);
assert.equal(timetableBlockForDate(duty, "20261120", "20261121"), "20261121_8-01");
assert.equal(timetableBlockForDate({ blockId: "20261120_unassigned", number: "", unassigned: true }, "20261120", "20261122"), "20261122_unassigned");
console.log("PDF day choices use actual calendar dates, holidays and variants");
