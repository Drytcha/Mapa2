import assert from "node:assert/strict";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  exportRoutesToGeoJson,
  exportRoutesToGpx,
  exportRoutesToGtfsShapesTxt,
  overrideToExportEntry,
  sanitizeGtfsId,
} from "../src/lib/routeExportFormats";
import {
  buildMergedGtfsZip,
  createEmptyCustomLine,
  createOppositeVariant,
  estimateVariantStopTimes,
  exportCustomGtfsLinesJson,
  formatGtfsClockHms,
  generateHeadwayTrips,
  inspectGtfsSourceZip,
  parseCustomGtfsLinesJson,
  parseDepartureTimesText,
  validateCustomGtfsLines,
  type CustomGtfsLine,
} from "../src/lib/engine/customGtfsLines";
import {
  ensureGtfsSeeded,
  getGtfsLines,
  getGtfsPreviewStatus,
  loadCustomGtfsArchivePreview,
  restoreOriginalGtfsArchive,
} from "../src/lib/engine/gtfsStore";
import type { LineRouteOverride } from "../src/lib/engine/lineRouteOverrides";

// ── 1. Eksport GIS / GTFS (shapes.txt, GeoJSON, GPX) ───────────────────────

const sampleEntry = {
  shapeId: "SHAPE_A_0",
  lineShort: "A",
  name: "Podzamcze → Sobięcin & <Centrum>",
  directionId: 0,
  firstStopName: "Podzamcze Pętla",
  lastStopName: "Sobięcin & Pętla",
  path: [
    [50.805, 16.25],
    [50.79, 16.27],
    [50.771, 16.284],
  ] as [number, number][],
};

const shapesTxt = exportRoutesToGtfsShapesTxt([sampleEntry]);
const shapeLines = shapesTxt.trim().split(/\r?\n/);
assert.equal(
  shapeLines[0],
  "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled",
);
assert.equal(shapeLines.length, 4, "Header + 3 vertices");
const lastCols = shapeLines[3].split(",");
assert.equal(lastCols[0], "SHAPE_A_0");
assert.equal(lastCols[3], "3");
assert.ok(Number(lastCols[4]) > 4000, "Cumulative distance should exceed 4 km");

const geoJsonStr = exportRoutesToGeoJson([sampleEntry]);
const geoJson = JSON.parse(geoJsonStr);
assert.equal(geoJson.type, "FeatureCollection");
assert.equal(geoJson.features.length, 1, "1 LineString feature");
assert.equal(geoJson.features[0].geometry.type, "LineString");
// GeoJSON uses [lon, lat]!
assert.deepEqual(geoJson.features[0].geometry.coordinates[0], [16.25, 50.805]);
assert.equal(geoJson.features[0].properties.line_short, "A");
assert.equal(geoJson.features[0].properties.shape_id, "SHAPE_A_0");
assert.ok(geoJson.features[0].properties.length_meters > 4000);

const gpx = exportRoutesToGpx([sampleEntry]);
assert.ok(gpx.includes('version="1.1"'));
assert.ok(gpx.includes('<trkpt lat="50.805000" lon="16.250000"/>'));
assert.ok(
  gpx.includes("Podzamcze → Sobięcin &amp; &lt;Centrum&gt;"),
  "XML special chars must be escaped",
);

const sampleOverride: LineRouteOverride = {
  lineShort: "2",
  variantKey: "SHP_2_0",
  scope: "variant",
  directionId: 0,
  firstStopName: "Piaskowa Góra",
  lastStopName: "Sobięcin",
  path: [
    [50.8, 16.26],
    [50.77, 16.28],
  ],
  updatedAt: "2026-11-24T10:00:00Z",
};
const fromOverride = overrideToExportEntry(sampleOverride);
assert.equal(fromOverride.shapeId, "SHP_2_0");
assert.equal(fromOverride.lineShort, "2");
assert.equal(sanitizeGtfsId("A/B 12"), "A_B_12");

// ── 2. Pomocniki własnych linii (wariant powrotny, takt, wklejanie) ────────

assert.equal(formatGtfsClockHms(5 * 60 + 7), "05:07:00");
assert.equal(formatGtfsClockHms(25 * 60 + 15), "25:15:00");

const parsedTimes = parseDepartureTimesText(
  "05:15, 05:45; 06:15\n24:30  05:15  invalid",
);
assert.deepEqual(parsedTimes, [315, 345, 375, 1470]);

const headwayTrips = generateHeadwayTrips({
  variantId: "v1",
  serviceId: "388_RS",
  startMinutes: 6 * 60,
  endMinutes: 7 * 60,
  intervalMinutes: 20,
  blockId: "S5/01",
});
assert.equal(headwayTrips.length, 4, "06:00, 06:20, 06:40, 07:00");
assert.equal(headwayTrips[0].blockId, "S5/01");

const lineS5: CustomGtfsLine = createEmptyCustomLine("S5", "388_RS");
lineS5.longName = "Szczawienko – Park Nauki";
lineS5.variants[0].name = "Szczawienko → Park Nauki";
lineS5.variants[0].headsign = "Park Nauki";
lineS5.variants[0].stops = [
  {
    id: "st_a",
    stopId: "S_EXISTING_1",
    name: "Szczawienko",
    lat: 50.815,
    lon: 16.292,
    isCustomStop: false,
    offsetMinutes: 0,
  },
  {
    id: "st_b",
    stopId: "S_EXISTING_2",
    name: "Plac Grunwaldzki",
    lat: 50.771,
    lon: 16.284,
    isCustomStop: false,
    offsetMinutes: 9,
  },
  {
    id: "st_c",
    stopId: "CUSTOM_STOP_PARK",
    name: "Park Nauki",
    lat: 50.765,
    lon: 16.278,
    code: "99",
    isCustomStop: true,
    offsetMinutes: 14,
  },
];
lineS5.variants[0].path = [
  [50.815, 16.292],
  [50.79, 16.288],
  [50.771, 16.284],
  [50.765, 16.278],
];

const oppositeVar = createOppositeVariant(lineS5.variants[0], "S5");
assert.equal(oppositeVar.directionId, 1);
assert.equal(oppositeVar.stops[0].name, "Park Nauki");
assert.equal(oppositeVar.stops[0].offsetMinutes, 0);
assert.equal(oppositeVar.stops[1].offsetMinutes, 5, "14 - 9 = 5 min");
assert.equal(oppositeVar.stops[2].offsetMinutes, 14, "14 - 0 = 14 min");
lineS5.variants.push(oppositeVar);

lineS5.customServices = [
  {
    serviceId: "CUSTOM_S5_WEEKEND",
    label: "Weekend specjalny",
    startDate: "20260101",
    endDate: "20261231",
    days: [false, false, false, false, false, true, true],
  },
];

lineS5.trips = [
  {
    id: "t1",
    variantId: lineS5.variants[0].id,
    serviceId: "388_RS",
    departureMinutes: 6 * 60,
    blockId: "S5/01",
  },
  {
    id: "t2",
    variantId: oppositeVar.id,
    serviceId: "CUSTOM_S5_WEEKEND",
    departureMinutes: 6 * 60 + 20,
    blockId: "S5/01",
  },
];

// Druga linia (NIE wybrana do eksportu — sprawdzamy selektywność!)
const lineN9: CustomGtfsLine = createEmptyCustomLine("N9", "388_RS");
lineN9.longName = "Nocna N9";
lineN9.variants[0].stops = [
  {
    id: "n1",
    stopId: "S_EXISTING_1",
    name: "Szczawienko",
    lat: 50.815,
    lon: 16.292,
    isCustomStop: false,
    offsetMinutes: 0,
  },
  {
    id: "n2",
    stopId: "S_EXISTING_2",
    name: "Plac Grunwaldzki",
    lat: 50.771,
    lon: 16.284,
    isCustomStop: false,
    offsetMinutes: 10,
  },
];
lineN9.trips = [
  {
    id: "tn1",
    variantId: lineN9.variants[0].id,
    serviceId: "388_RS",
    departureMinutes: 23 * 60 + 30,
  },
];

// JSON backup/restore roundtrip
const jsonBackup = exportCustomGtfsLinesJson([lineS5, lineN9]);
const restoredLines = parseCustomGtfsLinesJson(jsonBackup);
assert.equal(restoredLines.length, 2);
assert.equal(restoredLines[0].shortName, "S5");

// ── 3. Łączenie ze źródłowym archiwum GTFS (.zip) z wyborem linii ──────────

const sourceZipBytes = zipSync({
  "agency.txt": strToU8(
    "agency_id,agency_name,agency_url,agency_timezone\nMZUK,MZUK Wałbrzych,https://example.pl,Europe/Warsaw\n",
  ),
  "routes.txt": strToU8(
    "route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color\nR_2,MZUK,2,Piaskowa Góra - Sobięcin,3,1D4ED8,FFFFFF\n",
  ),
  "stops.txt": strToU8(
    "stop_id,stop_code,stop_name,stop_lat,stop_lon\nS_EXISTING_1,101,Szczawienko,50.815000,16.292000\nS_EXISTING_2,102,Plac Grunwaldzki,50.771000,16.284000\n",
  ),
  "calendar.txt": strToU8(
    "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n388_RS,1,1,1,1,1,0,0,20260101,20261231\n",
  ),
  "shapes.txt": strToU8(
    "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\nSHP_2_0,50.800000,16.260000,1,0\nSHP_2_0,50.780000,16.270000,2,2500\n",
  ),
  "trips.txt": strToU8(
    "route_id,service_id,trip_id,trip_headsign,direction_id,block_id,shape_id\nR_2,388_RS,T_2_1,Sobięcin,0,2/01,SHP_2_0\n",
  ),
  "stop_times.txt": strToU8(
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT_2_1,05:00:00,05:00:00,S_EXISTING_1,1\nT_2_1,05:10:00,05:10:00,S_EXISTING_2,2\n",
  ),
  "feed_info.txt": strToU8("feed_publisher_name,feed_lang\nMZUK,pl\n"),
});

const inspected = inspectGtfsSourceZip(sourceZipBytes, "test-source.zip");
assert.equal(inspected.routeCount, 1);
assert.equal(inspected.stopCount, 2);
assert.deepEqual(inspected.serviceIds, ["388_RS"]);
assert.deepEqual(inspected.agencyIds, ["MZUK"]);

// Wybieramy WYŁĄCZNIE lineS5 (pomijamy lineN9) + wbudowujemy poprawkę SHP_2_0 z Edytora
const merged = buildMergedGtfsZip({
  sourceZipBytes,
  selectedLines: [lineS5],
  routeOverrides: [sampleOverride],
});

assert.equal(merged.summary.addedRoutes, 1);
assert.deepEqual(merged.summary.includedLines, ["S5"]);
assert.equal(merged.summary.addedStops, 1, "Only CUSTOM_STOP_PARK should be added");
assert.equal(merged.summary.addedShapes, 2, "2 variants of S5");
assert.equal(merged.summary.addedTrips, 2);
assert.equal(merged.summary.addedStopTimes, 6, "2 trips × 3 stops");
assert.equal(merged.summary.updatedOverrideShapes, 1, "SHP_2_0 updated from override");

const unzipped = unzipSync(merged.zipBytes);
assert.ok(unzipped["feed_info.txt"], "Untouched extra files must be preserved");
const mergedRoutes = strFromU8(unzipped["routes.txt"]);
assert.ok(mergedRoutes.includes("R_2,MZUK,2"), "Original route 2 preserved");
assert.ok(mergedRoutes.includes("CUSTOM_S5,MZUK,S5"), "Selected line S5 added");
assert.ok(!mergedRoutes.includes("N9"), "Unselected line N9 must NOT be included");

const mergedStops = strFromU8(unzipped["stops.txt"]);
assert.ok(mergedStops.includes("CUSTOM_STOP_PARK"), "Custom GPS stop added");
assert.equal(
  mergedStops.split("S_EXISTING_1").length - 1,
  1,
  "Existing stop S_EXISTING_1 must not be duplicated",
);

const mergedCal = strFromU8(unzipped["calendar.txt"]);
assert.ok(mergedCal.includes("388_RS"), "Source service_id preserved");
assert.ok(
  mergedCal.includes("CUSTOM_S5_WEEKEND,0,0,0,0,0,1,1,20260101,20261231"),
  "Custom service_id appended",
);

const mergedShapes = strFromU8(unzipped["shapes.txt"]);
assert.ok(
  mergedShapes.includes("SHP_2_0,50.770000,16.280000"),
  "Override shape point baked into SHP_2_0",
);
assert.ok(
  !mergedShapes.includes("SHP_2_0,50.780000,16.270000"),
  "Old SHP_2_0 vertices replaced cleanly",
);

const mergedStopTimes = strFromU8(unzipped["stop_times.txt"]);
assert.ok(mergedStopTimes.includes("06:00:00,06:00:00,S_EXISTING_1,1"));
assert.ok(mergedStopTimes.includes("06:14:00,06:14:00,CUSTOM_STOP_PARK,3"));

// Idempotentność: ponowne połączenie tej samej linii S5 nie duplikuje wierszy!
const reMerged = buildMergedGtfsZip({
  sourceZipBytes: merged.zipBytes,
  selectedLines: [lineS5],
});
const reMergedRoutes = strFromU8(unzipSync(reMerged.zipBytes)["routes.txt"]);
assert.equal(
  reMergedRoutes.split("CUSTOM_S5").length - 1,
  1,
  "Re-merging S5 must replace rather than duplicate route row",
);

// ── 4. Samodzielny eksport GTFS bez pliku źródłowego ───────────────────────

const standalone = buildMergedGtfsZip({
  sourceZipBytes: null,
  selectedLines: [lineS5],
});
const standaloneFiles = unzipSync(standalone.zipBytes);
for (const required of [
  "agency.txt",
  "routes.txt",
  "stops.txt",
  "calendar.txt",
  "shapes.txt",
  "trips.txt",
  "stop_times.txt",
]) {
  assert.ok(standaloneFiles[required], `Standalone ZIP must contain ${required}`);
}
assert.ok(strFromU8(standaloneFiles["routes.txt"]).includes("S5"));

// ── 5. Automatyczne szacowanie czasów przejazdu między przystankami ────────

const estWithPath = estimateVariantStopTimes(lineS5.variants[0], {
  averageSpeedKmh: 22,
  stopPenaltySeconds: 25,
});
assert.equal(estWithPath.usedRoutePath, true, "Should use drawn route polyline distance");
assert.equal(estWithPath.stops[0].offsetMinutes, 0);
assert.ok(
  estWithPath.stops[1].offsetMinutes > 0 &&
    estWithPath.stops[2].offsetMinutes > estWithPath.stops[1].offsetMinutes,
  "Estimated stop offsets should increase monotonically",
);
assert.ok(estWithPath.totalMeters > 5000, "Total route distance > 5 km");
assert.ok(estWithPath.totalMinutes >= 12 && estWithPath.totalMinutes <= 25);

const estSlower = estimateVariantStopTimes(lineS5.variants[0], {
  averageSpeedKmh: 16,
  stopPenaltySeconds: 30,
});
assert.ok(
  estSlower.totalMinutes > estWithPath.totalMinutes,
  "Lower commercial speed should produce longer travel time",
);

const estNoPath = estimateVariantStopTimes(
  { stops: lineS5.variants[0].stops, path: [] },
  { averageSpeedKmh: 22, stopPenaltySeconds: 25 },
);
assert.equal(estNoPath.usedRoutePath, false, "Should fall back to stop coordinates when path empty");
assert.ok(estNoPath.totalMeters > 5000, "Detour-adjusted straight distance > 5 km");
assert.equal(estNoPath.stops[0].offsetMinutes, 0);
assert.ok(estNoPath.stops[2].offsetMinutes > estNoPath.stops[1].offsetMinutes);

// ── 6. Walidacja własnych linii przed eksportem / podglądem ────────────────

const validCheck = validateCustomGtfsLines([lineS5], ["388_RS"]);
assert.equal(validCheck.errors.length, 0, "Valid line S5 should have zero errors");

const brokenLine = createEmptyCustomLine("X1", "388_RS");
brokenLine.variants[0].stops = [
  { ...lineS5.variants[0].stops[0], offsetMinutes: 10 },
  { ...lineS5.variants[0].stops[1], offsetMinutes: 5 }, // błąd: czas się cofa!
];
const invalidCheck = validateCustomGtfsLines([brokenLine], ["388_RS"]);
assert.ok(invalidCheck.errors.length >= 1, "Backwards stop times must trigger error");
assert.ok(invalidCheck.warnings.length >= 1, "Zero trips & missing path should warn");

// ── 7. Podgląd połączonego GTFS na żywo w silniku aplikacji + powrót ───────

// Najpierw załadujmy bazowy źródłowy ZIP jako symulację bazy, a potem połączony z linią S5
const origLoaded = await loadCustomGtfsArchivePreview(sourceZipBytes, "Oryginał testowy");
assert.equal(origLoaded.routeCount, 1);

const previewLoaded = await loadCustomGtfsArchivePreview(
  merged.zipBytes,
  "Połączony GTFS (linie S5)",
);
assert.equal(previewLoaded.routeCount, 2, "Preview must contain original route 2 + custom S5");
assert.equal(previewLoaded.stopCount, 3, "Preview must contain 2 source stops + custom Park Nauki");
assert.equal(previewLoaded.tripCount, 3, "Preview must contain 1 source trip + 2 custom trips");

const status = getGtfsPreviewStatus();
assert.equal(status.active, true);
assert.equal(status.label, "Połączony GTFS (linie S5)");

const liveLines = await getGtfsLines();
const shortNames = liveLines.routes.map((r) => r.shortName);
assert.ok(shortNames.includes("2"), "Original line 2 present in live preview");
assert.ok(shortNames.includes("S5"), "New custom line S5 present in live preview");

const liveStore = await ensureGtfsSeeded();
assert.ok(
  liveStore.base.stops.some((s) => s.name === "Park Nauki"),
  "Custom GPS stop Park Nauki present in live store",
);
assert.ok(
  liveStore.base.shapesById.has("SHP_2_0"),
  "Shapes eagerly loaded in live preview",
);

await restoreOriginalGtfsArchive().catch(() => {});
assert.equal(getGtfsPreviewStatus().active, false, "Preview status cleared after restore");

console.log(
  "✓ GTFS export, auto-time estimator, validator & live preview sandbox tests passed!",
);
