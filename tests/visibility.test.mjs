import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const { outputFiles } = buildSync({
  stdin: {
    contents: `
      export * from "./src/lib/busMarker";
      export * from "./src/lib/visibility";
      export { formatVehicleNumber, formatDelay } from "./src/lib/delay";
    `,
    loader: "ts",
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
  },
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
});
const bundled = { exports: {} };
new Function("module", "exports", outputFiles[0].text)(bundled, bundled.exports);
const {
  buildBusMarker,
  busLabelParts,
  DEFAULT_VISIBILITY,
  VISIBILITY_STORAGE_KEY,
  restoreVisibility,
  loadVisibility,
  saveVisibility,
  formatVehicleNumber,
} = bundled.exports;

const bus = {
  vehicleId: "340",
  model: null,
  operatorKey: "ska",
  operatorName: "SKA",
  operatorSource: "auto",
  routeName: "15",
  routeColor: "#0059ce",
  brigade: "01",
  kursowka: "15/01",
  tripId: null,
  lat: 50.7714,
  lon: 16.2843,
  bearing: 135,
  delaySeconds: 80,
  speedKmh: 32,
  headsign: "Podzamcze",
  timestamp: 0,
  upcomingStops: [],
};
const defaultLabel = { kursowka: false, vehicleNumber: false };
const saved = new Map();

beforeEach(() => {
  saved.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
    },
  });
});

test("first launch hides stops and extra identifiers, but keeps live buses", () => {
  assert.deepEqual(loadVisibility(), DEFAULT_VISIBILITY);
  assert.equal(DEFAULT_VISIBILITY.stops, "off");
  assert.equal(DEFAULT_VISIBILITY.liveBuses, true);
  assert.equal(DEFAULT_VISIBILITY.busKursowka, false);
  assert.equal(DEFAULT_VISIBILITY.busVehicleNumber, false);
});

test("saved preferences are restored and invalid storage uses safe defaults", () => {
  const customized = { ...DEFAULT_VISIBILITY, stops: "all", busKursowka: true };
  saveVisibility(customized);
  assert.deepEqual(loadVisibility(), customized);
  saved.set(VISIBILITY_STORAGE_KEY, "not-json");
  assert.deepEqual(loadVisibility(), DEFAULT_VISIBILITY);
  assert.deepEqual(
    restoreVisibility({ stops: "invalid", busKursowka: true, liveBuses: "false" }),
    { ...DEFAULT_VISIBILITY, busKursowka: true }
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("Storage disabled"); },
  });
  assert.deepEqual(loadVisibility(), DEFAULT_VISIBILITY);
  assert.doesNotThrow(() => saveVisibility(customized));
});

test("the line is mandatory in every combination of optional identifiers", () => {
  assert.deepEqual(busLabelParts(bus, defaultLabel), ["15"]);
  assert.deepEqual(busLabelParts(bus, { kursowka: true, vehicleNumber: false }), ["15", "15/01"]);
  assert.deepEqual(busLabelParts(bus, { kursowka: false, vehicleNumber: true }), ["15", "#340"]);
  assert.deepEqual(busLabelParts(bus, { kursowka: true, vehicleNumber: true }), ["15", "15/01", "#340"]);
  assert.deepEqual(
    busLabelParts({ ...bus, routeName: "2", kursowka: "2/08", vehicleId: "3" }, { kursowka: true, vehicleNumber: true }),
    ["2", "2/08", "#3"]
  );
});

test("default marker includes the line, arrow, speed and signed delay", () => {
  const marker = buildBusMarker(bus, defaultLabel, false);
  assert.match(marker.html, /class="live-bus-line">15<\/span>/);
  assert.match(marker.html, /rotate\(135deg\)/);
  assert.match(marker.html, /32 km\/h/);
  assert.match(marker.html, />-1:20<\/span>/);
  assert.match(marker.html, /live-bus--compact/);
  assert.doesNotMatch(marker.html, /15\/01|#340|live-bus-op/);
  assert.match(marker.tooltip, /Linia 15/);
  assert.match(marker.tooltip, /Kierunek: Podzamcze/);
  assert.doesNotMatch(marker.tooltip, /15\/01|#340/);
});

test("enabling identifiers appends them instead of replacing the line", () => {
  const marker = buildBusMarker(bus, { kursowka: true, vehicleNumber: true }, true);
  assert.match(marker.html, /class="live-bus-line">15<\/span><span class="live-bus-sep">\|<\/span><span>15\/01<\/span>/);
  assert.match(marker.html, /<span>#340<\/span>/);
  assert.match(marker.html, /live-bus--selected/);
  assert.doesNotMatch(marker.html, /live-bus--compact/);
});

test("single-digit fleet numbers are not automatically zero-padded", () => {
  for (const [input, expected] of [["3", "#3"], ["340", "#340"], [" #3 ", "#3"], ["03", "#03"], ["", ""], [null, ""]]) {
    assert.equal(formatVehicleNumber(input), expected);
  }
});

test("missing identifiers and missing bearing do not remove the line or invent a direction", () => {
  assert.deepEqual(busLabelParts({ ...bus, kursowka: "15" }, { kursowka: true, vehicleNumber: false }), ["15"]);
  assert.deepEqual(busLabelParts({ ...bus, routeName: " A ", kursowka: "" }, defaultLabel), ["A"]);
  assert.deepEqual(busLabelParts({ ...bus, routeName: "" }, defaultLabel), ["?"]);
  for (const bearing of [null, NaN, Infinity]) {
    const { html } = buildBusMarker({ ...bus, bearing }, defaultLabel, false);
    assert.match(html, /live-bus-dot/);
    assert.match(html, /class="live-bus-line">15<\/span>/);
    assert.doesNotMatch(html, /transform:rotate/);
  }
  assert.match(buildBusMarker({ ...bus, bearing: -90 }, defaultLabel, false).html, /rotate\(270deg\)/);
  assert.match(buildBusMarker({ ...bus, bearing: 0 }, defaultLabel, false).html, /rotate\(0deg\)/);
});

test("early, on-time and stopped buses retain accurate metrics", () => {
  const early = buildBusMarker({ ...bus, delaySeconds: -45, speedKmh: 0 }, defaultLabel, false);
  assert.match(early.html, />\+0:45<\/span>/);
  assert.match(early.html, />0 km\/h<\/span>/);
  const onTime = buildBusMarker({ ...bus, delaySeconds: 0, speedKmh: null }, defaultLabel, false);
  assert.match(onTime.html, />0:00<\/span>/);
  assert.match(onTime.html, /km\/h/);
});

test("all labels from the feed are HTML-escaped", () => {
  const marker = buildBusMarker(
    { ...bus, routeName: '<img src=x onerror="alert(1)">', kursowka: "<script>15/01</script>", vehicleId: "<svg>", headsign: "<b>End</b>" },
    { kursowka: true, vehicleNumber: true },
    false
  );
  assert.doesNotMatch(marker.html, /<img|<script>|#<svg>/);
  assert.doesNotMatch(marker.tooltip, /<b>|<img/);
  assert.match(marker.html, /&lt;img/);
});