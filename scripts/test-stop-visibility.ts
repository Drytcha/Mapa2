import assert from "node:assert/strict";
import { loadVisibility, saveVisibility, DEFAULT_VISIBILITY } from "../src/lib/visibility";

const data = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { value: {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => data.set(key, value),
}, configurable: true });
assert.equal(loadVisibility().stops, "all");
data.set("mapplaner.visibility.v1", JSON.stringify({ stops: "off", liveBuses: false }));
assert.equal(loadVisibility().stops, "all");
assert.equal(loadVisibility().liveBuses, false);
saveVisibility({ ...DEFAULT_VISIBILITY, stops: "off" });
assert.equal(loadVisibility().stops, "off");
console.log("stop visibility tests passed");
