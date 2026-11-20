import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const css = read("src/app/globals.css");
const mapView = read("src/components/MapView.tsx");
const app = read("src/components/MapPlanerApp.tsx");
const location = read("src/lib/useUserLocation.ts");
const hud = read("src/components/PerfHud.tsx");

// 1. Ciemna mapa: filtr na pojedynczych kaflach, nie na całej warstwie kafli.
//    Filtr na kontenerze przerasterowuje cały widok przy każdym ruchu mapy.
assert.match(
  css,
  /\.basemap-layer--dark \.leaflet-tile \{[^}]*filter:\s*invert/,
  "filtr ciemnych kafli działa per kafel",
);
assert.doesNotMatch(
  css,
  /\.basemap-layer--dark \{[^}]*filter:/,
  "warstwa kafli nie ma już filtra na całości",
);

// 2. Rozmycie paneli nad mapą musi być tanie (24 px → 8 px).
const blur = css.match(/--blur-xl:\s*(\d+(?:\.\d+)?)px/);
assert.ok(blur, "motyw definiuje --blur-xl");
assert.ok(Number(blur![1]) <= 10, `promień rozmycia paneli ≤ 10 px (jest ${blur![1]} px)`);

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
assert.match(app, /fleetSignature/, "aktualizacje floty są deduplikowane");

// 9. Licznik FPS jest opt-in i nic nie robi bez ?perf=1.
assert.match(hud, /get\("perf"\) === "1"/, "HUD włącza się parametrem ?perf=1");
assert.match(hud, /if \(!enabled\) return null/, "HUD nie renderuje nic bez zgody");

console.log("map performance guards passed (dark tiles, blur, labels, GPS, fleet)");
