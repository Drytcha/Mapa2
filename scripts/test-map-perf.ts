import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const css = read("src/app/globals.css");
const mapView = read("src/components/MapView.tsx");
const app = read("src/components/MapPlanerApp.tsx");
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
assert.match(mapView, /classList\.contains\("map-busy"\)/, "ruch mapy pauzuje aktualizacje pozycji floty");
assert.match(mapView, /TARGET_FRAME_INTERVAL_MS = 1000 \/ 30/, "animacja floty ma limit 30 kl./s");
assert.match(mapView, /activeVehicleIds\(nowMs\)/, "w animacji pomijane są nieruchome autobusy");
assert.match(mapView, /arrowElement: HTMLElement \| null/, "strzałka markera jest cache'owana zamiast wyszukiwana w DOM co klatkę");
assert.match(css, /map-busy\[data-zoom-tier="far"\][\s\S]*?\.live-bus-wrap:not\(\.live-bus-wrap--selected\) \.live-bus \{[\s\S]*?width: 9px/, "podczas przesuwania przy dalekim zoomie autobusowe pigułki redukują się do lekkich kropek");
assert.match(css, /map-busy\[data-zoom-tier="far"\][\s\S]*?\.live-bus-wrap > \* \{\s*pointer-events: none !important;/, "podczas przesuwania markery nie biorą udziału w hit-testach");
assert.match(css, /map-busy \.nav-vehicle/, "animacje są pauzowane przez klasę map-busy");
assert.match(mapView, /L\.canvas\(\{ pane: "vehicleCanvas"/, "flota daleko od mapy ma wspólny renderer Canvas");
assert.match(mapView, /zoomTier === "far" && !selected/, "Canvas używany jest przy dalekim zoomie poza zaznaczonym autobusem");
assert.match(mapView, /L\.circleMarker\(\[renderLat, renderLon\]/, "autobusy z daleka są rysowane jako ścieżki Canvas");
assert.match(mapView, /liveBusClickRef\.current\?\.\(currentBus\)/, "Canvas zachowuje klikalność autobusów");
assert.match(css, /live-bus-tooltip::before \{\s*border-top-color: var\(--color-line\)/, "ogon dymka autobusu ma obrys zgodny z borderem karty");
assert.match(css, /live-bus-tooltip::after \{[\s\S]*?border-top-color: var\(--color-surface\)/, "ogon dymka autobusu ma osobne wypełnienie wnętrza");

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

// 8. Flota: identyczny odcisk danych nie powoduje re-rendera.
const fleetHook = read("src/lib/hooks/useLiveFleetState.ts");
assert.match(app, /useLiveFleetState/, "MapPlanerApp korzysta z wydzielonego hooka floty");
assert.match(fleetHook, /fleetSignature/, "aktualizacje floty są deduplikowane");

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

console.log("map performance guards passed (canvas dark tiles, no blur, labels, GPS, fleet)");
