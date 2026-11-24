// npm run test:route-editor
// Testy modułu Planisty: edycja całego przebiegu trasy linii, zapis, publikacja
// dla wszystkich oraz widoczność poprawionej geometrii we wszystkich widokach.
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";

const FIXED_NOW = Date.parse("2026-11-20T09:00:00+01:00");
const realNow = Date.now;
Date.now = () => FIXED_NOW;

// 1. Testy czystej geometrii edytora
import {
  insertVertexOnPath,
  moveVertexInPath,
  removeVertexFromPath,
  replacePathSegment,
  sanitizePath,
  simplifyPath,
  snapEndsToStops,
  type LatLng,
} from "../src/lib/routeEditorGeometry";

{
  const dirty: LatLng[] = [
    [50.770000123, 16.280000456],
    [50.770000124, 16.280000457], // duplikat < 0.5 m
    [50.775, 16.285],
    [50.78, 16.29],
  ];
  const clean = sanitizePath(dirty);
  assert.equal(clean.length, 3, "sanitizePath usuwa duplikaty sąsiednich punktów");
  assert.deepEqual(clean[0], [50.77, 16.28], "współrzędne zaokrąglone do 6 miejsc");

  // Uproszczenie (Douglas-Peucker): 20 punktów w linii prostej redukuje do 2
  const straight: LatLng[] = Array.from({ length: 20 }, (_, i) => [
    50.77 + i * 0.0005,
    16.28 + i * 0.0005,
  ]);
  const simplifiedStraight = simplifyPath(straight, 8);
  assert.equal(simplifiedStraight.length, 2, "prosta linia upraszcza się do 2 punktów");

  // Wstawienie punktu w środek drugiego odcinka
  const base: LatLng[] = [
    [50.77, 16.28],
    [50.775, 16.28],
    [50.775, 16.29],
  ];
  const inserted = insertVertexOnPath(base, [50.775, 16.285]);
  assert.equal(inserted.insertedIndex, 2, "punkt wstawiony między indeksy 1 i 2");
  assert.equal(inserted.nextPoints.length, 4);

  // Przesunięcie i usunięcie wierzchołka
  const moved = moveVertexInPath(inserted.nextPoints, 2, [50.776, 16.286]);
  assert.deepEqual(moved[2], [50.776, 16.286]);
  const removed = removeVertexFromPath(moved, 2);
  assert.equal(removed.length, 3);
  assert.equal(
    removeVertexFromPath([[50.77, 16.28], [50.78, 16.29]], 0).length,
    2,
    "nie pozwala zmniejszyć poniżej 2 punktów",
  );

  // Zastąpienie fragmentu A->B (w przód i w tył)
  const route5: LatLng[] = [
    [50.77, 16.28],
    [50.771, 16.281],
    [50.772, 16.282],
    [50.773, 16.283],
    [50.774, 16.284],
  ];
  const repFwd = replacePathSegment(route5, 1, 3, [
    [50.771, 16.281],
    [50.772, 16.29],
    [50.773, 16.283],
  ]);
  assert.deepEqual(repFwd[2], [50.772, 16.29], "fragment A->B w przód zastąpiony");
  const repRev = replacePathSegment(route5, 3, 1, [
    [50.773, 16.283],
    [50.772, 16.275],
    [50.771, 16.281],
  ]);
  assert.deepEqual(
    repRev[2],
    [50.772, 16.275],
    "fragment B->A automatycznie odwraca orientację zastępczego odcinka",
  );
  assert.deepEqual(repRev[0], route5[0], "początek trasy nienaruszony");
  assert.deepEqual(repRev[repRev.length - 1], route5[4], "koniec trasy nienaruszony");

  // Dociągnięcie końców do przystanków
  const snapped = snapEndsToStops(
    [
      [50.771, 16.281],
      [50.773, 16.283],
    ],
    { lat: 50.77, lon: 16.28 },
    { lat: 50.775, lon: 16.285 },
  );
  assert.deepEqual(snapped[0], [50.77, 16.28]);
  assert.deepEqual(snapped[snapped.length - 1], [50.775, 16.285]);
}

// 2. Syntetyczny GTFS do sprawdzenia integracji z całym silnikiem
const files: Record<string, string> = {
  "feed_info.txt":
    "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.com,pl,20260101,20261231\n",
  "routes.txt":
    "route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n" +
    "r7,7,Podzamcze - Centrum,3,006e28,FFFFFF\n",
  "stops.txt":
    "stop_id,stop_name,stop_lat,stop_lon,location_type\n" +
    "s1,Podzamcze - Jana Pawła II,50.81000,16.26000,0\n" +
    "s2,Żeromskiego - Oczki,50.79000,16.27500,0\n" +
    "s3,Pl. Grunwaldzki,50.77000,16.28500,0\n",
  "calendar_dates.txt":
    "service_id,date,exception_type\n2026_RS,20261120,1\n",
  "trips.txt":
    "route_id,service_id,trip_id,trip_headsign,block_id,shape_id,direction_id\n" +
    "r7,2026_RS,t7_1,Pl. Grunwaldzki,7/01,sh7_old,0\n",
  "stop_times.txt":
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n" +
    "t7_1,10:00:00,10:00:00,s1,1,0,0\n" +
    "t7_1,10:08:00,10:08:00,s2,2,0,0\n" +
    "t7_1,10:15:00,10:15:00,s3,3,0,0\n",
  "shapes.txt":
    "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n" +
    "sh7_old,50.81000,16.26000,1\n" +
    "sh7_old,50.79500,16.25000,2\n" + // błędny objazd na zachód
    "sh7_old,50.77000,16.28500,3\n",
};

const zipBytes = zipSync(
  Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
);
const realFetch = globalThis.fetch;

// Zapasowy mock fetch dla osadzonego GTFS
let mockFetchHandler: ((url: string, init?: RequestInit) => Promise<Response> | null) | null = null;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (mockFetchHandler) {
    const custom = mockFetchHandler(url, init);
    if (custom) return custom;
  }
  if (url.includes("kind=operators")) {
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes(".zip") || url.includes("/api/transit/gtfs")) {
    return new Response(Buffer.from(zipBytes), {
      status: 200,
      headers: { "content-type": "application/zip" },
    });
  }
  return new Response("", { status: 404 });
}) as typeof fetch;

const {
  getBrigadeShapeOverlay,
  getCoursePreview,
  getLineRouteGeometry,
  getTripLengthMap,
  getTripOrderedStops,
  getVehicleRouteOverlay,
} = await import("../src/lib/engine/gtfsStore");
const { getLineCatalogue } = await import("../src/lib/engine/lineRoutes");
const {
  deleteLineRouteOverride,
  exportLineRouteOverridesJson,
  findLineRouteOverride,
  importLineRouteOverridesJson,
  publishLineRouteOverridesToGitHub,
  refreshRemoteLineRouteOverrides,
  resetLineRouteOverridesForTests,
  saveLineRouteOverride,
} = await import("../src/lib/engine/lineRouteOverrides");

resetLineRouteOverridesForTests();

// Sprawdź punkt wyjściowy (oryginał GTFS z błędnym objazdem na lon=16.25)
const beforeCatalogue = await getLineCatalogue();
const line7Before = beforeCatalogue.find((e) => e.shortName === "7");
assert.ok(line7Before && line7Before.variants.length === 1);
assert.equal(line7Before.variants[0].customized, false);
assert.equal(line7Before.variants[0].path[1][1], 16.25);

const orderedStops = await getTripOrderedStops(line7Before.variants[0].representativeTripId);
assert.equal(orderedStops.length, 3, "pobiera uporządkowane przystanki wariantu");
assert.equal(orderedStops[0].name, "Podzamcze - Jana Pawła II");
assert.equal(orderedStops[2].name, "Pl. Grunwaldzki");

// 3. Planista poprawia przebieg linii 7 na realną ulicę (lon=16.275 zamiast 16.25)
const realisticPath: LatLng[] = [
  [50.81, 16.26],
  [50.799, 16.27],
  [50.79, 16.275],
  [50.78, 16.28],
  [50.77, 16.285],
];

await saveLineRouteOverride({
  lineShort: "7",
  variantKey: "sh7_old",
  directionId: 0,
  firstStopId: "s1",
  firstStopName: "Podzamcze - Jana Pawła II",
  lastStopId: "s3",
  lastStopName: "Pl. Grunwaldzki",
  path: realisticPath,
  note: "Poprawiony przebieg prosto ul. Żeromskiego",
});

// 4. Widoczność poprawionej trasy we WSZYSTKICH widokach aplikacji!
const afterCatalogue = await getLineCatalogue();
const v7After = afterCatalogue.find((e) => e.shortName === "7")!.variants[0];
assert.equal(v7After.customized, true, "katalog linii oznacza wariant jako poprawiony");
assert.equal(v7After.customNote, "Poprawiony przebieg prosto ul. Żeromskiego");
assert.deepEqual(v7After.path, realisticPath, "katalog linii zwraca poprawiony przebieg");
assert.equal(
  v7After.originalPath[1][1],
  16.25,
  "oryginalny przebieg GTFS zachowany do porównania i cofnięcia",
);

const brigadeOverlay = await getBrigadeShapeOverlay("Linia 7", "#006e28", ["t7_1"]);
assert.ok(brigadeOverlay);
assert.deepEqual(
  brigadeOverlay.polylines[0],
  realisticPath,
  "podgląd linii/brygady na mapie rysuje poprawiony przebieg",
);

const coursePreview = await getCoursePreview("t7_1", "20261120");
assert.ok(coursePreview);
assert.deepEqual(
  coursePreview.polylines[0],
  realisticPath,
  "podgląd pojedynczego kursu rysuje poprawiony przebieg",
);

const liveOverlay = await getVehicleRouteOverlay({
  vehicleId: "v701",
  routeName: "7",
  tripId: "t7_1",
  headsign: "Pl. Grunwaldzki",
  lat: 50.79,
  lon: 16.275,
  speedKmh: 30,
  delaySeconds: 0,
  bearing: 160,
  operatorKey: "mzuk",
  operatorName: "MZUK",
  routeColor: "#006e28",
  vehicleNumber: "701",
  observedAt: FIXED_NOW,
} as never);
assert.ok(liveOverlay);
assert.deepEqual(
  liveOverlay.polylines[0],
  realisticPath,
  "trasa na żywo po kliknięciu autobusu GPS używa poprawionego przebiegu",
);

const lineGeom = await getLineRouteGeometry("7");
assert.ok(lineGeom);
assert.ok(
  lineGeom.points.some(([lat, lon]) => Math.abs(lat - 50.79) < 1e-4 && Math.abs(lon - 16.275) < 1e-4),
  "getLineRouteGeometry zawiera punkty z poprawionej trasy",
);

const lengths = await getTripLengthMap();
assert.ok((lengths.get("t7_1") ?? 0) > 4000 && (lengths.get("t7_1") ?? 0) < 5500);

// 5. Dopasowanie po aktualizacji GTFS (zmienione shape_id, te same przystanki skrajne)
const fallbackMatch = findLineRouteOverride({
  lineShort: "7",
  shapeId: "sh7_brand_new_feed_390",
  directionId: 0,
  firstStopId: "s1",
  lastStopId: "s3",
  firstStopName: "Podzamcze - Jana Pawła II",
  lastStopName: "Pl. Grunwaldzki",
});
assert.ok(
  fallbackMatch && fallbackMatch.override.path.length === realisticPath.length,
  "poprawiona trasa działa również po odświeżeniu GTFS z nowym shape_id",
);

// 6. Eksport + Import JSON
const exportedJson = exportLineRouteOverridesJson();
await deleteLineRouteOverride("7", "sh7_old");
assert.equal((await getLineCatalogue()).find((e) => e.shortName === "7")!.variants[0].customized, false);

const imported = await importLineRouteOverridesJson(exportedJson);
assert.equal(imported.importedCount, 1);
assert.equal((await getLineCatalogue()).find((e) => e.shortName === "7")!.variants[0].customized, true);

// 7. Publikacja na GitHub (mock API) i wczytanie u innego użytkownika (pasażera)
let committedJsonOnGitHub = "";
mockFetchHandler = (url, init) => {
  if (url.includes("api.github.com/repos/Drytcha/Mapa2/contents/src/data/line-route-overrides.json")) {
    if (!init?.method || init.method === "GET") {
      if (!committedJsonOnGitHub) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              sha: "abc123sha",
              content: Buffer.from(
                JSON.stringify({ version: 1, updatedAt: "2026-11-20T00:00:00.000Z", overrides: {} }),
                "utf8",
              ).toString("base64"),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            sha: "def456sha",
            content: Buffer.from(committedJsonOnGitHub, "utf8").toString("base64"),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (init.method === "PUT") {
      const payload = JSON.parse(String(init.body)) as { content: string; sha: string };
      assert.equal(payload.sha, "abc123sha", "PUT wysyła aktualne SHA pliku z GitHub");
      committedJsonOnGitHub = Buffer.from(payload.content, "base64").toString("utf8");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            commit: { html_url: "https://github.com/Drytcha/Mapa2/commit/1234567" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
  }
  if (url.includes("raw.githubusercontent.com/Drytcha/Mapa2/main/src/data/line-route-overrides.json")) {
    return Promise.resolve(
      new Response(committedJsonOnGitHub, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  return null;
};

const pub = await publishLineRouteOverridesToGitHub({
  owner: "Drytcha",
  repo: "Mapa2",
  branch: "main",
  path: "src/data/line-route-overrides.json",
  token: "test_token_123",
});
assert.equal(pub.mode, "github");
assert.equal(pub.publishedCount, 1);
assert.ok(pub.commitUrl?.includes("commit/1234567"));
assert.ok(committedJsonOnGitHub.includes("Poprawiony przebieg prosto ul. Żeromskiego"));

// Symulacja świeżego użytkownika (pasażera bez lokalnych danych) ładującego stronę:
resetLineRouteOverridesForTests();
// Symulujemy środowisko przeglądarki dla refreshRemoteLineRouteOverrides
(globalThis as unknown as { window?: unknown }).window = {};
const refreshed = await refreshRemoteLineRouteOverrides(false);
assert.equal(refreshed.ok, true);
assert.equal(refreshed.count, 1, "każdy użytkownik automatycznie pobiera opublikowaną trasę");
const travelerCatalogue = await getLineCatalogue();
assert.deepEqual(
  travelerCatalogue.find((e) => e.shortName === "7")!.variants[0].path,
  realisticPath,
  "pasażer widzi dokładnie ten sam poprawiony przebieg linii zapisany przez Planistę",
);

delete (globalThis as unknown as { window?: unknown }).window;
globalThis.fetch = realFetch;
Date.now = realNow;

console.log(
  "OK: edytor tras linii (geometria, zapis, publikacja dla wszystkich, widoczność w katalogu/kursach/GPS)",
);
