import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeVirtualWindow } from "../src/components/VirtualList";
import {
  packShapesForTransfer,
  unpackShapesFromTransfer,
} from "../src/lib/engine/gtfsShapesParser";
import {
  applyFleetSnapshotToStore,
  fleetSignature,
  getLiveVehiclesSnapshot,
} from "../src/lib/liveFleetStore";
import type { LiveBusVehicle } from "../src/lib/types";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const css = read("src/app/globals.css");
const mapView = read("src/components/MapView.tsx");
const app = read("src/components/MapPlanerApp.tsx");
const fleetStore = read("src/lib/liveFleetStore.ts");
const gtfsStore = read("src/lib/engine/gtfsStore.ts");
const scheduleDiffUi = read("src/components/ScheduleDiffDialog.tsx");
const brigadesPanel = read("src/components/BrigadesPanel.tsx");
const viteConfig = read("vite.config.ts");
const location = read("src/lib/useUserLocation.ts");
const hud = read("src/components/PerfHud.tsx");

// 1. Ciemna mapa: kafle przyciemniane raz, w kanwie — bez filtra CSS i bez
//    `mix-blend-mode` z Leafleta. Filtr na każdym z ~40 kafli to kilkadziesiąt
//    dodatkowych powierzchni do złożenia w każdej klatce ruchu mapy.
const mapTiles = read("src/lib/mapTiles.ts");
assert.match(mapTiles, /context\.filter = DARK_TILE_FILTER/, "kafel jest przyciemniany w kanwie");
assert.match(mapTiles, /createDarkTileLayer/, "eksportowany jest warstwowy konstruktor kafli");
assert.match(
  mapView,
  /mapStyle === "dark"\s*\?\s*createDarkTileLayer\(config\.base, baseOptions\)/,
  "ciemny motyw korzysta z kafli w kanwie",
);
assert.doesNotMatch(css, /\.leaflet-tile \{[^}]*filter:/, "brak filtra CSS na kaflach");
assert.doesNotMatch(css, /\.basemap-layer--dark/, "brak klasy filtra warstwy kafli");

// 2. Rozmycie tła paneli (backdrop-filter) jest wyłączone: przeliczanie rozmycia
//    nad ruchomą mapą to koszt w każdej klatce, a panele są prawie kryjące.
assert.match(css, /backdrop-filter: none !important/, "backdrop-filter wyłączony globalnie");
assert.ok(
  !/backdrop-blur/.test(read("src/components/MapOverlays.tsx") + app),
  "panele nad mapą nie używają klas backdrop-blur",
);
assert.doesNotMatch(css, /will-change: opacity/, "kafle nie wymuszają osobnej warstwy na czas fade");
assert.match(mapView, /classList\.toggle\("map-busy"/, "ruch mapy wstrzymuje animacje markerów");
assert.match(css, /map-busy \.nav-vehicle/, "animacje są pauzowane przez klasę map-busy");

// 2b. Przystanki rysowane tylko wokół widoku (mniej DOM = płynniejsze przesuwanie).
assert.match(mapView, /const STOP_SHOW_PAD = 0\.\d+/, "zasięg dodawania markerów");
assert.match(mapView, /const STOP_KEEP_PAD = 0\.\d+/, "bufor, zanim marker znika");
assert.match(mapView, /const syncStops = \(\) =>/, "warstwa przystanków synchronizuje się z widokiem");
assert.match(mapView, /map\.on\("zoomend moveend", scheduleSync\)/, "przesunięcie mapy odświeża warstwę");
assert.match(
  mapView,
  /stopMarkersRef\.current\.delete\(id\)/,
  "markery poza buforem są usuwane z DOM",
);

// 3. Żadnych selektorów :has() — na ~600 markerach kosztują przy każdej zmianie DOM.
assert.ok(!/:has\(/.test(css), "brak selektorów :has() w stylach");
assert.match(mapView, /pin-wrap--grabbable/, "kursor „grab” ustawia klasa, nie :has()");

// 4. Strzałki trasy bez filtra i animacji (statyczne oznaczenia kierunku).
const arrowBlock = css.slice(css.indexOf(".route-arrow {"), css.indexOf(".route-arrow svg"));
assert.ok(arrowBlock.length > 0);
assert.ok(!/animation:|filter:/.test(arrowBlock), "strzałki bez animacji i bez drop-shadow");

// 5. Etykiety przystanków: ograniczona liczba i tylko zmiany stanu.
const cap = mapView.match(/MAX_STOP_LABELS = (\d+)/);
assert.ok(cap, "warstwa przystanków ma limit etykiet");
assert.ok(Number(cap![1]) <= 100, `limit etykiet ≤ 100 (jest ${cap![1]})`);
assert.match(mapView, /labelled\.has\(/, "otwarte etykiety są śledzone");
assert.match(mapView, /scheduleLabels/, "odświeżanie etykiet jest scalane w jednej klatce");

// 6. Kafle nie wołają serwera w trakcie animacji zoomu.
assert.match(mapView, /updateWhenZooming: false/, "kafle aktualizują się po zoomie");

// 7. GPS: szum poniżej 1,5 m nie przerysowuje całej strony planisty.
assert.match(location, /movedMeters >= 1\.5/, "próg ruchu GPS");
assert.match(location, /lastEmittedRef/, "ostatnia wysłana pozycja jest pamiętana");

// 8. Flota: identyczny odcisk danych nie powoduje re-rendera, a stan floty żyje
//    w zewnętrznym store (useSyncExternalStore), nie w useState w MapPlanerApp.
assert.match(fleetStore, /fleetSignature/, "aktualizacje floty są deduplikowane w liveFleetStore");
assert.match(fleetStore, /useSyncExternalStore/, "flota używa useSyncExternalStore");
assert.doesNotMatch(
  app,
  /useState<LiveBusVehicle\[\]>/,
  "MapPlanerApp nie trzyma liveVehicles w lokalnym useState (brak re-renderów na każdy tick GPS)",
);

// Test jednostkowy stabilizacji referencji w liveFleetStore
{
  const mkBus = (id: string, lat: number): LiveBusVehicle => ({
    vehicleId: id,
    routeName: "8",
    lat,
    lon: 16.28,
    delaySeconds: 0,
    speedKmh: 30,
    bearing: 90,
    kursowka: "8/01",
    operatorKey: "SKA",
    operatorName: "ŚKA",
    operatorSource: "gtfs",
    upcomingStops: [],
  });
  const b1 = mkBus("101", 50.77);
  const b2 = mkBus("102", 50.78);
  applyFleetSnapshotToStore({
    vehicles: [b1, b2],
    traffic: null,
    fetchedAt: Date.now(),
  });
  const snap1 = getLiveVehiclesSnapshot();
  assert.equal(fleetSignature(snap1), fleetSignature([b1, b2]));
  // Przesuwa się tylko wóz 102 — wóz 101 musi zachować tę samą referencję obiektu!
  applyFleetSnapshotToStore({
    vehicles: [mkBus("101", 50.77), mkBus("102", 50.79)],
    traffic: null,
    fetchedAt: Date.now(),
  });
  const snap2 = getLiveVehiclesSnapshot();
  assert.equal(snap2[0], snap1[0], "niezmieniony autobus zachowuje referencję obiektu");
  assert.notEqual(snap2[1], snap1[1], "przesunięty autobus otrzymuje nowy obiekt");
}

// 9. Licznik FPS jest opt-in i nic nie robi bez ?perf=1.
assert.match(hud, /get\("perf"\) === "1"/, "HUD włącza się parametrem ?perf=1");
assert.match(hud, /if \(!enabled\) return null/, "HUD nie renderuje nic bez zgody");

// 10. Trasa na mapie jest zawsze ciągła: kreski (`dashArray`) wolno używać
//     wyłącznie w planerze podróży (odcinki piesze) i przy szkicu własnej trasy.
//     Wcześniej cała brygada rysowała się linią przerywaną `9 6` — to nie może
//     wrócić, bo trasa kursu ma być jedną, czytelną linią.
const dashPatterns = [...mapView.matchAll(/dashArray: "([^"]+)"/g)].map((match) => match[1]).sort();
assert.deepEqual(
  dashPatterns,
  ["2 7", "5 7"],
  `kreski tylko dla odcinków pieszych i szkicu trasy (są: ${dashPatterns.join(", ")})`,
);
assert.match(mapView, /pane: "kursowka"/, "trasa kursu rysowana w swoim pane");
const kursowkaBlock = mapView.slice(mapView.indexOf("const drawable = kursowkaOverlay.polylines"));
assert.ok(
  kursowkaBlock.length > 0 && !/dashArray/.test(kursowkaBlock.slice(0, 2000)),
  "trasa kursu bez wzoru kreskowego (jedna ciągła linia)",
);
assert.match(mapView, /createPane\("routeDone"\)/, "przejechany odcinek ma własną warstwę nad trasą");

// 11. Build domyślnie dzieli kod na chunki (singlefile tylko na żądanie SINGLEFILE=1).
assert.match(viteConfig, /singleFileBuild/, "vite.config.ts rozdziela domyślny build chunked od singlefile");
assert.match(viteConfig, /manualChunks/, "vite.config.ts definiuje manualChunks dla vendorów i danych");

// 12. Ciężkie operacje GTFS (unzip, shapes.txt, scheduleDiff) korzystają z Web Workera.
assert.match(gtfsStore, /unzipGtfsWithoutShapesOffThread/, "gtfsStore rozpakowuje ZIP w Web Workerze");
assert.match(gtfsStore, /parseGtfsShapesOffThread/, "gtfsStore parsuje shapes.txt w Web Workerze");
assert.match(scheduleDiffUi, /compareScheduleTripsOffThread/, "ScheduleDiffDialog porównuje rozkłady w Web Workerze");
{
  const original = new Map<string, [number, number][]>([
    ["s1", [[50.77, 16.28], [50.78, 16.29]]],
    ["s2", [[50.80, 16.30]]],
  ]);
  const unpacked = unpackShapesFromTransfer(packShapesForTransfer(original));
  assert.deepEqual(unpacked.get("s1"), original.get("s1"), "zero-copy pack/unpack shapes zachowuje współrzędne");
  assert.deepEqual(unpacked.get("s2"), original.get("s2"));
}

// 13. Długie listy kursów i brygad są wirtualizowane (VirtualList).
assert.match(scheduleDiffUi, /<VirtualList/, "ScheduleDiffDialog wirtualizuje listę kursów");
assert.match(brigadesPanel, /<VirtualList/, "BrigadesPanel wirtualizuje listę brygad");
{
  const win = computeVirtualWindow(2500, 1200, 600, 60, 5);
  assert.equal(win.startIndex, 15, "start okna uwzględnia overscan=5");
  assert.equal(win.endIndex, 35, "koniec okna obejmuje widoczne wiersze + overscan");
  assert.equal(win.paddingTop, 15 * 60);
  assert.equal(win.paddingBottom, (2500 - 35) * 60);
}

console.log(
  "map performance guards passed (chunked build, Web Worker GTFS, external fleet store, VirtualList, canvas dark tiles, no blur, labels, GPS)",
);
