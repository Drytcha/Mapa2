import assert from "node:assert/strict";
import { loadVisibility, saveVisibility, DEFAULT_VISIBILITY } from "../src/lib/visibility";

const data = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { value: {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => data.set(key, value),
}, configurable: true });
assert.equal(loadVisibility().stops, "all");
assert.equal(loadVisibility().busVehicleNumber, true);
data.set("mapplaner.visibility.v1", JSON.stringify({ stops: "off", liveBuses: false, busVehicleNumber: false }));
assert.equal(loadVisibility().stops, "all");
assert.equal(loadVisibility().liveBuses, false);
assert.equal(loadVisibility().busVehicleNumber, true, "migracja v1 włącza widoczność numeru pojazdu");
data.clear();
data.set("mapplaner.visibility.v2", JSON.stringify({ stops: "all", liveBuses: true, busVehicleNumber: false }));
assert.equal(loadVisibility().busVehicleNumber, true, "migracja v2 włącza domyślnie numer pojazdu na mapie");
saveVisibility({ ...DEFAULT_VISIBILITY, stops: "off", busVehicleNumber: false });
assert.equal(loadVisibility().stops, "off");
assert.equal(loadVisibility().busVehicleNumber, false, "świadomy wybór użytkownika w v3 jest zachowany");
console.log("stop visibility tests passed");
