import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ROUTE_ARROW_PATH,
  bearingBetween,
  isTurnManeuver,
  maneuverArrowLabel,
  routeArrowIconHtml,
  routeArrowIconSize,
  routeArrowPoints,
  twoWaySegments,
} from "../src/lib/routeArrows";
import type { RouteStep } from "../src/lib/types";

// ── 1. Prosta trasa bez skrętów: kierunek musi być widoczny ────────────────
const straight: [number, number][] = [
  [50.78, 16.28],
  [50.78, 16.29],
  [50.78, 16.3],
];
const straightArrows = routeArrowPoints(straight, []);
assert.ok(straightArrows.length >= 1, "prosta trasa dostaje strzałkę kierunku");
assert.equal(straightArrows[0].kind, "straight");
assert.ok(Math.abs(straightArrows[0].bearing - 90) < 6, "strzałka na wschód");
assert.ok(straightArrows.every((arrow) => arrow.bearing >= 0 && arrow.bearing < 360));

// ── 2. Skrzyżowanie/skręt z OSRM ───────────────────────────────────────────
const corner: [number, number][] = [
  [50.78, 16.28],
  [50.78, 16.29], // jedziemy na wschód
  [50.792, 16.29], // skręt w lewo (na północ)
  [50.8, 16.29],
];
const turnStep: RouteStep = {
  instruction: "Skręć w lewo w ul. Ogrodową",
  distance: 1200,
  duration: 100,
  maneuver: "turn",
  modifier: "left",
  leg: 0,
  location: [50.78, 16.29],
};
const cornerArrows = routeArrowPoints(corner, [turnStep]);
const turnArrow = cornerArrows.find((arrow) => arrow.kind === "turn");
assert.ok(turnArrow, "skręt dostaje własną strzałkę");
assert.ok(Math.abs(turnArrow!.bearing) < 12, "strzałka po skręcie pokazuje północ");
assert.equal(turnArrow!.label, "skręt w lewo");
assert.ok(turnArrow!.distance > 100, "strzałka stoi za skrzyżowaniem, nie na nim");

// Zmiana nazwy ulicy i „prosto” to nie skręt — nie generują strzałek.
assert.equal(isTurnManeuver({ maneuver: "new name" }), false);
assert.equal(isTurnManeuver({ maneuver: "continue", modifier: "straight" }), false);
assert.equal(isTurnManeuver({ maneuver: "turn", modifier: "straight" }), false);
assert.equal(isTurnManeuver({ maneuver: "turn", modifier: "right" }), true);
assert.equal(isTurnManeuver({ maneuver: "roundabout", modifier: "left" }), true);
assert.equal(maneuverArrowLabel({ maneuver: "turn", modifier: "slight right" }), "lekko w prawo");
assert.equal(maneuverArrowLabel({ maneuver: "roundabout" }), "rondo");

// ── 3. Ta sama ulica w obie strony ─────────────────────────────────────────
const out: [number, number][] = Array.from({ length: 14 }, (_, index) => [
  50.78,
  16.28 + index * 0.0004,
]);
const back = [...out].reverse().map(([lat, lon]) => [lat, lon] as [number, number]);
const there: [number, number][] = [...out, ...back];
const segments = twoWaySegments(there);
assert.ok(segments.some(Boolean), "powrót tą samą ulicą jest wykryty");
const thereArrows = routeArrowPoints(there, []);
const reverseArrows = thereArrows.filter((arrow) => arrow.kind === "reverse");
assert.ok(reverseArrows.length >= 2, "odcinek w obie strony ma strzałki w obu kierunkach");
assert.ok(
  reverseArrows.some((arrow) => arrow.bearing > 45 && arrow.bearing < 135),
  "jedna strzałka pokazuje jazdę w jedną stronę",
);
assert.ok(
  reverseArrows.some((arrow) => arrow.bearing > 225 && arrow.bearing < 315),
  "druga strzałka pokazuje jazdę z powrotem",
);

// Zwykły objazd kwartału nie jest „tą samą ulicą w obie strony”.
const loop: [number, number][] = [
  [50.78, 16.28],
  [50.78, 16.29],
  [50.782, 16.29],
  [50.782, 16.28],
  [50.78, 16.28],
];
assert.equal(twoWaySegments(loop).some(Boolean), false);

// ── 4. Odstępy i limit ────────────────────────────────────────────────────
const dense: [number, number][] = Array.from({ length: 220 }, (_, index) => [
  50.78 + index * 0.00025,
  16.28,
]);
const denseSteps: RouteStep[] = Array.from({ length: 12 }, (_, index) => ({
  instruction: "skręć",
  distance: 100,
  duration: 10,
  maneuver: "turn",
  modifier: index % 2 ? "left" : "right",
  leg: 0,
  location: [50.78 + (index + 1) * 0.003, 16.28],
}));
const denseArrows = routeArrowPoints(dense, denseSteps, { maxArrows: 12 });
assert.ok(denseArrows.length <= 12, "limit strzałek jest respektowany");
const sorted = [...denseArrows].sort((a, b) => a.distance - b.distance);
for (let i = 1; i < sorted.length; i++) {
  assert.ok(sorted[i].distance - sorted[i - 1].distance >= 40, "strzałki nie nakładają się na siebie");
}
assert.ok(denseArrows.every((arrow) => Number.isFinite(arrow.bearing) && Number.isFinite(arrow.lat)));

// ── 5. Odporne dane ───────────────────────────────────────────────────────
assert.deepEqual(routeArrowPoints([], []), []);
assert.deepEqual(routeArrowPoints([[50.78, 16.28]], []), []);
assert.deepEqual(
  routeArrowPoints(
    [
      [Number.NaN, 16.28],
      [50.78, 16.28],
      [50.78, 16.28],
    ],
    [],
  ),
  [],
);

// ── 5b. Ikona: grocik celuje w górę, bo rotate(0) = północ ────────────────
const northArrow = routeArrowPoints(
  [
    [50.78, 16.28],
    [50.79, 16.28],
    [50.8, 16.28],
  ],
  [],
)[0];
assert.ok(northArrow);
assert.ok(Math.abs(northArrow.bearing) < 5, "trasa na północ ma bearing ~0");
const html = routeArrowIconHtml(northArrow);
assert.ok(html.includes("rotate(0.0deg)") || /rotate\(0(\.\d+)?deg\)/.test(html), "obrót = bearing");
assert.ok(!/animation\s*:/.test(html), "ikona nie ma animacji");
// Kolejne liczby w ścieżce: x1, y1, x2 (grot), y2, x3, y3.
const pathNumbers = ROUTE_ARROW_PATH.match(/-?\d+(\.\d+)?/g)!.map(Number);
assert.equal(pathNumbers.length, 6);
const [x1, y1, tipX, tipY, x3, y3] = pathNumbers;
assert.ok(tipY < y1 && tipY < y3, "grot jest wyżej niż ramiona (północ)");
assert.ok(tipX > x1 && tipX < x3, "grot jest między ramionami");
assert.equal(routeArrowIconSize({ ...northArrow, kind: "turn" }), 22);
assert.equal(routeArrowIconSize({ ...northArrow, kind: "straight" }), 18);
assert.ok(routeArrowIconHtml({ ...northArrow, label: '<b>"x"</b>' }).includes("&lt;b&gt;&quot;x&quot;&lt;/b&gt;"), "etykieta jest escapowana");

// ── 6. Wydajność: długa trasa liczona raz, bez timerów ────────────────────
const long: [number, number][] = Array.from({ length: 4000 }, (_, index) => [
  50.78 + index * 0.00002,
  16.28 + index * 0.00001,
]);
const started = performance.now();
const longArrows = routeArrowPoints(long, []);
const elapsed = performance.now() - started;
assert.ok(longArrows.length > 0);
assert.ok(elapsed < 400, `liczenie strzałek jest szybkie (${elapsed.toFixed(0)} ms)`);

// ── 7. Brak animacji: „płynąca” linia usunięta na dobre ──────────────────
const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
assert.ok(!css.includes("route-flow"), "brak klasy animowanej linii trasy");
assert.ok(!css.includes("routeDash"), "brak animacji przesuwanej linii");
const arrowBlock = css.slice(css.indexOf(".route-arrow {"), css.indexOf(".route-arrow--straight {"));
assert.ok(arrowBlock.length > 0);
assert.ok(!/animation\s*:/.test(arrowBlock), "strzałki nie mają animacji");
const mapView = readFileSync(new URL("../src/components/MapView.tsx", import.meta.url), "utf8");
assert.ok(!mapView.includes("route-flow"), "mapa nie rysuje już ruchomej linii");
assert.ok(mapView.includes("routeArrowPoints"), "mapa rysuje statyczne strzałki");
assert.ok(/createPane\("routeArrows"\)/.test(mapView), "panel strzałek istnieje");
assert.ok(/pane: "routeArrows"/.test(mapView), "markery trafiają do panelu strzałek");
assert.ok(/routeArrowPane\.style\.pointerEvents = "none"/.test(mapView), "strzałki nie łapią kliknięć");
assert.ok(/interactive: false/.test(mapView), "strzałki są nieinteraktywne");
assert.ok(!/animation/.test(mapView), "mapa nie dodaje animacji do trasy");

console.log("static route direction arrows (no animation) passed");
