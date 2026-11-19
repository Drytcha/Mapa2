import assert from "node:assert/strict";
import { repairShapeGaps, splitShapeAtGaps } from "../src/lib/engine/shapeRepair";

type Point = [number, number];
const path: Point[] = [[50, 16], [50.0001, 16], [50.003, 16], [50.0031, 16]];
assert.equal(splitShapeAtGaps(path).gaps.length, 1);
assert.equal(splitShapeAtGaps(path, 0).gaps.length, 3);

let fail = true;
globalThis.fetch = async () => {
  if (fail) return new Response("unavailable", { status: 503 });
  return Response.json({ code: "Ok", routes: [{ distance: 350, geometry: { coordinates: [[16, 50.0001], [16.0002, 50.0015], [16, 50.003]] } }] });
};
const missing = await repairShapeGaps(path, undefined, false, 5000);
assert.equal(missing.gapsRepaired, 0);
assert.deepEqual(missing.polylines, [path.slice(0, 2), path.slice(2)]);
fail = false;
const repaired = await repairShapeGaps(path, undefined, false, 5000);
assert.equal(repaired.gapsRepaired, 1);
assert.equal(repaired.polylines.length, 1);
assert(repaired.polylines[0].some(([lat, lon]) => lat === 50.0015 && lon === 16.0002));
const aborted = new AbortController();
aborted.abort();
await assert.rejects(repairShapeGaps(path, aborted.signal), { name: "AbortError" });
console.log("shape repair tests passed");
