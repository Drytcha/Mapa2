import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TopBar from "../src/components/TopBar";
import CoursePreviewCard from "../src/components/CoursePreviewCard";
import BusSearch from "../src/components/BusSearch";
import MapInfoSidebar from "../src/components/MapInfoSidebar";
import { MapControls, MapQuickBar } from "../src/components/MapOverlays";
import { EMPTY_ROUTE } from "../src/lib/data";
import { DEFAULT_VISIBILITY } from "../src/lib/visibility";
import type { CoursePreview } from "../src/lib/engine/gtfsStore";
import type { BusStop, LiveBusVehicle } from "../src/lib/types";

const noop = () => {};
const props = {
  route: EMPTY_ROUTE, isRouting: false, routeReady: false, theme: "light" as const,
  liveBusCount: 0, showLiveBuses: true, kursowkiOpen: false, linesOpen: false,
  onRoleChange: noop, onToggleLiveBuses: noop, onToggleTheme: noop, onOpenSettings: noop,
  onOpenSteps: noop, onOpenFleet: noop, onOpenReport: noop, onOpenKursowki: noop,
  onOpenLines: noop, onOpenPlanner: noop, onOpenPdf: noop, pdfDisabled: true,
};
const user = renderToStaticMarkup(<TopBar {...props} role="traveler" />);
assert.doesNotMatch(user, /Planista|Planer|Podróżny|Logowanie/i);
assert.match(user, /Kursówki/);
const planner = renderToStaticMarkup(<TopBar {...props} role="planner" />);
assert.match(planner, /Planista/);
assert.match(planner, /Planer/);

const course = {
  tripId: "t", dateId: "20261119", routeShort: "7", routeLong: "7", headsign: "Centrum",
  dutyCode: "7/01", operatorKey: "other", operatorName: "Inny", color: "#000000",
  textColor: "#ffffff", startMs: 0, endMs: 3600000, distanceMeters: 12500,
  path: [], polylines: [], approximate: false, unresolvedGaps: 0, stops: [{ id: "a", name: "Start", lat: 50, lon: 16, sequence: 1, arrivalMs: 0, departureMs: 0, afterMidnight: false }, { id: "b", name: "Koniec", lat: 50, lon: 16, sequence: 2, arrivalMs: 3600000, departureMs: 3600000, afterMidnight: false }],
} satisfies CoursePreview;
const card = renderToStaticMarkup(<CoursePreviewCard course={course} onClose={noop} onFit={noop} onBack={noop} onSelectStop={noop} />);
assert.doesNotMatch(card, /12,5 km/);
assert.match(card, /przystanków/);
assert.match(card, /course-preview-sidebar-root/);
assert.match(card, /course-drawer-collapse/);
// Panel kursu jest delikatnie węższy, żeby widzieć więcej mapy — bez zmiany
// wszystkich informacji (czas, kierunek, przystanki).
assert.match(card, /md:w-\[300px\]/, "panel kursu ma 300 px zamiast 336 px");
assert.doesNotMatch(card, /md:w-\[336px\]/, "stara, szersza wersja panelu nie wróciła");

// Symulacja telefonu (< 768px): prawy sidebar startuje zwinięty z uchwytem po prawej krawędzi,
// dzięki czemu cała mapa trasy jest od razu widoczna.
(globalThis as unknown as { window?: unknown }).window = {
  matchMedia: () => ({ matches: false }),
};
const mobileCard = renderToStaticMarkup(<CoursePreviewCard course={course} onClose={noop} onFit={noop} onBack={noop} onSelectStop={noop} />);
assert.match(mobileCard, /course-drawer-toggle/, "na telefonie renderuje uchwyt do wysuwania prawego sidebara");
assert.match(mobileCard, /data-open="false"/, "na telefonie prawy sidebar startuje zwinięty, nie zasłaniając mapy");

// Na telefonie po wysunięciu panelu przyciemniamy tylko wąski pas mapy obok
// panelu (mapa z trasą zostaje widoczna), a nie cały ekran.
(globalThis as unknown as { window?: unknown }).window = {
  matchMedia: () => ({ matches: true }),
};
const openMobile = renderToStaticMarkup(
  <CoursePreviewCard course={course} onClose={noop} onFit={noop} onBack={noop} onSelectStop={noop} />,
);
assert.match(openMobile, /data-open="true"/);
assert.match(openMobile, /w-\[calc\(100%-min\(300px,84vw\)\)\]/, "przyciemnienie tylko obok panelu");
assert.doesNotMatch(openMobile, /absolute inset-0 bg-black\/25/, "nie przyciemniamy całej mapy na telefonie");
delete (globalThis as unknown as { window?: unknown }).window;
delete (globalThis as unknown as { window?: unknown }).window;

// ── Trasa do wybranego przystanku (podróżny wysiada wcześniej niż na pętli) ──
const coursePath: [number, number][] = [
  [50.7700, 16.2800],
  [50.7700, 16.2900],
  [50.7700, 16.3000],
];
const timedCourse = {
  ...course,
  polylines: [coursePath],
  path: coursePath,
  stops: [
    { id: "a", name: "Start", lat: 50.77, lon: 16.28, sequence: 1, arrivalMs: 0, departureMs: 0, afterMidnight: false },
    { id: "b", name: "Pośredni", lat: 50.77, lon: 16.295, sequence: 2, arrivalMs: 600_000, departureMs: 600_000, afterMidnight: false },
    { id: "c", name: "Koniec", lat: 50.77, lon: 16.3, sequence: 3, arrivalMs: 1_200_000, departureMs: 1_200_000, afterMidnight: false },
  ],
} satisfies CoursePreview;

const targets: Array<number | null> = [];
const withTarget = renderToStaticMarkup(
  <CoursePreviewCard
    course={timedCourse}
    onClose={noop}
    onFit={noop}
    onBack={noop}
    onSelectStop={noop}
    targetStopIndex={1}
    onSelectRouteTarget={(index) => targets.push(index)}
  />,
);
assert.match(withTarget, /Trasa do przystanku/, "panel pokazuje podsumowanie dojazdu do wybranego przystanku");
assert.match(withTarget, /Pośredni/, "wybrany przystanek jest nazwany");
assert.match(withTarget, /Tu wysiadasz/, "wybrany przystanek jest wyróżniony na osi kursu");
assert.match(withTarget, /course-target-clear/, "jest powrót do całej trasy kursu");
// Węższy panel musi pomieścić podsumowanie dojazdu bez skracania treści.
assert.match(withTarget, /Na mapie widać dojazd do tego przystanku/);
assert.match(withTarget, /Dopasuj/);
assert.match(withTarget, /10 min jazdy/, "czas jazdy do przystanku liczony od startu kursu");
assert.match(withTarget, /course-preview-stop-center/, "obok wyboru trasy jest nadal podgląd przystanku na mapie");

const wholeCourse = renderToStaticMarkup(
  <CoursePreviewCard
    course={timedCourse}
    onClose={noop}
    onFit={noop}
    onBack={noop}
    onSelectStop={noop}
    onSelectRouteTarget={noop}
  />,
);
assert.doesNotMatch(wholeCourse, /Trasa do przystanku/, "bez wyboru nie ma podsumowania wycinka");
assert.match(wholeCourse, /Kliknij przystanek, aby zobaczyć trasę do niego/, "lista podpowiada, że klik pokazuje trasę do przystanku");

// Geometria: trasa do przystanku kończy się pod tym przystankiem, nie na pętli.
const { courseStopTarget, courseRoutePath } = await import("../src/lib/courseRoute");
assert.deepEqual(courseRoutePath(timedCourse), coursePath, "liczymy po tej samej geometrii, którą rysuje mapa");
const slice = courseStopTarget(timedCourse, 1);
assert.ok(slice, "wycinek do przystanku pośredniego istnieje");
assert.ok(Math.abs(slice!.path.at(-1)![1] - 16.295) < 0.0002, "linia kończy się pod przystankiem");
assert.ok(slice!.rideMs === 600_000, "jazda od startu do przystanku to 10 minut");
const toEnd = courseStopTarget(timedCourse, 2);
assert.ok(toEnd && Math.abs(toEnd.meters - 1_408) < 60, "do końca kursu jest ok. 1,4 km po tej szerokości geograficznej");

// ── 1. Ultra-kompaktowy prawy pasek narzędzi mapy (MapControls) ──
const controlsHtml = renderToStaticMarkup(
  <MapControls
    onZoomIn={noop}
    onZoomOut={noop}
    onFit={noop}
    onLocate={noop}
    locateState="idle"
  />,
);
assert.equal(
  (controlsHtml.match(/data-testid="map-controls-bar"/g) ?? []).length,
  1,
  "narzędzia po prawej stronie mapy są w jednym kompaktowym kontenerze",
);
for (const label of [
  "Wycentruj na mojej lokalizacji",
  "Przybliż mapę",
  "Oddal mapę",
]) {
  assert.match(controlsHtml, new RegExp(`aria-label="${label}"`), `zachowany przycisk: ${label}`);
}
assert.doesNotMatch(
  controlsHtml,
  /Dopasuj trasę do widoku/,
  "bez aktywnej trasy nie zajmujemy miejsca guzikiem dopasowania",
);
const controlsWithFitHtml = renderToStaticMarkup(
  <MapControls
    onZoomIn={noop}
    onZoomOut={noop}
    onFit={noop}
    onLocate={noop}
    locateState="idle"
    showFit
  />,
);
assert.match(controlsWithFitHtml, /Dopasuj trasę do widoku/);

// ── 2. Kompaktowy pasek na mapie (MapQuickBar) + wysuwany sidebar (MapInfoSidebar) ──
const sampleStops: BusStop[] = [
  {
    id: "tt-a",
    name: "Piłsudskiego - Plac Tuwima",
    lat: 50.76697,
    lon: 16.28661,
    lines: ["7", "9", "S1"],
    shelter: false,
    source: "timetable",
  },
  {
    id: "tt-b",
    name: "Sikorskiego - Teatr",
    lat: 50.769,
    lon: 16.283,
    lines: ["2", "11"],
    shelter: true,
    source: "timetable",
  },
];

const sampleVehicles: LiveBusVehicle[] = [
  {
    vehicleId: "404",
    model: "Solaris",
    operatorKey: "ska",
    operatorName: "ŚKA",
    operatorSource: "auto",
    routeName: "7",
    routeColor: "#1e6fbf",
    brigade: "01",
    dutyCode: "7/01",
    dutyStatus: "confirmed",
    dutyLine: "7",
    dutySource: "trip",
    kursowka: "7/01",
    tripId: "t7",
    lat: 50.77,
    lon: 16.28,
    bearing: 90,
    delaySeconds: 30,
    speedKmh: 24,
    headsign: "Koniec",
    timestamp: 0,
    upcomingStops: [],
  },
];

const quickBarHtml = renderToStaticMarkup(
  <MapQuickBar
    sidebarOpen={false}
    onToggleSidebar={noop}
    showLiveBuses={true}
    liveVehicles={sampleVehicles}
    busStops={sampleStops}
    onSelectBus={noop}
    onSelectStop={noop}
    onToggleTripPlanner={noop}
  />,
);
assert.match(quickBarHtml, /data-testid="map-sidebar-toggle"/, "ikonka do rozwijania sidebaru z informacjami");
assert.match(quickBarHtml, /Otwórz panel boczny mapy/);
assert.match(quickBarHtml, /Szukaj przystanku lub autobusu/, "wspólna wyszukiwarka przystanków i autobusów");
assert.match(quickBarHtml, /data-testid="quick-trip-planner"/, "kompaktowy przycisk planera podróży");

const closedSidebarHtml = renderToStaticMarkup(
  <MapInfoSidebar
    open={false}
    onClose={noop}
    isPlanner={false}
    showLiveBuses={true}
    onToggleLiveBuses={noop}
    operatorFilter="all"
    onOperatorFilter={noop}
    liveVehicles={sampleVehicles}
    liveTraffic={null}
    liveLoading={false}
    onRefreshLive={noop}
    mapStopCount={sampleStops.length}
    busLoading={false}
    onRefreshBusStops={noop}
    visibility={DEFAULT_VISIBILITY}
    onVisibilityChange={noop}
    signalCount={0}
    turnaroundCount={0}
    mapStyle="dark"
    onMapStyle={noop}
    onHome={noop}
    onFit={noop}
    locationStatus="active"
    userLocation={{
      lat: 50.77,
      lon: 16.28,
      accuracy: 10,
      altitude: 582,
      heading: null,
      speedKmh: 0,
      maxSpeedKmh: 0,
      distanceM: 12,
      timestamp: Date.now(),
    }}
    followingUser={false}
    onLocate={noop}
    onRetryLocation={noop}
    onOpenTripPlanner={noop}
  />,
);
assert.match(closedSidebarHtml, /data-open="false"/, "sidebar startuje zwinięty, odsłaniając mapę");
assert.match(closedSidebarHtml, /inert=""/, "zwinięty sidebar jest nieaktywny dla tabulacji");

const openSidebarHtml = renderToStaticMarkup(
  <MapInfoSidebar
    open={true}
    onClose={noop}
    isPlanner={false}
    showLiveBuses={true}
    onToggleLiveBuses={noop}
    operatorFilter="all"
    onOperatorFilter={noop}
    liveVehicles={sampleVehicles}
    liveTraffic={null}
    liveLoading={false}
    onRefreshLive={noop}
    mapStopCount={sampleStops.length}
    busLoading={false}
    onRefreshBusStops={noop}
    visibility={DEFAULT_VISIBILITY}
    onVisibilityChange={noop}
    signalCount={0}
    turnaroundCount={0}
    mapStyle="dark"
    onMapStyle={noop}
    onHome={noop}
    onFit={noop}
    locationStatus="active"
    userLocation={{
      lat: 50.77,
      lon: 16.28,
      accuracy: 10,
      altitude: 582,
      heading: null,
      speedKmh: 0,
      maxSpeedKmh: 0,
      distanceM: 12,
      timestamp: Date.now(),
    }}
    followingUser={false}
    onLocate={noop}
    onRetryLocation={noop}
    onOpenTripPlanner={noop}
  />,
);
assert.match(openSidebarHtml, /data-open="true"/);
assert.match(openSidebarHtml, /Panel mapy i informacje/);
assert.match(openSidebarHtml, /GPS na żywo \(1\)/);
assert.match(openSidebarHtml, /ŚKA \(1\)/);
assert.match(openSidebarHtml, /Legenda punktualności GPS/);
assert.match(openSidebarHtml, /Twoja lokalizacja i prędkość/);
assert.match(openSidebarHtml, /582 m n\.p\.m\./);
assert.match(openSidebarHtml, /Ustawienia widoczności/);
assert.match(openSidebarHtml, /Styl mapy/);

// Wyszukiwanie linii „7” pokazuje jednocześnie autobus GPS i przystanek tej linii; podróżny nie widzi S1.
const combinedTravelerSearch = renderToStaticMarkup(
  <BusSearch
    vehicles={sampleVehicles}
    stops={sampleStops}
    onSelectVehicle={noop}
    onSelectStop={noop}
    query="7"
    defaultOpen
    isPlanner={false}
  />,
);
assert.match(combinedTravelerSearch, /Brygada 7\/01/, "pokazuje pasujący autobus GPS");
assert.match(combinedTravelerSearch, /Piłsudskiego - Plac Tuwima/, "pokazuje pasujący przystanek");
assert.doesNotMatch(combinedTravelerSearch, /\bS1\b/, "podróżny nie widzi linii planistycznej S1 na przystanku");

const travelerS1Search = renderToStaticMarkup(
  <BusSearch
    vehicles={sampleVehicles}
    stops={sampleStops}
    onSelectVehicle={noop}
    onSelectStop={noop}
    query="S1"
    defaultOpen
    isPlanner={false}
  />,
);
assert.match(travelerS1Search, /Brak przystanków pasujących do wyszukiwania/, "S1 nie zwraca przystanków dla podróżnego");

const plannerS1Search = renderToStaticMarkup(
  <BusSearch
    vehicles={sampleVehicles}
    stops={sampleStops}
    onSelectVehicle={noop}
    onSelectStop={noop}
    query="S1"
    defaultOpen
    isPlanner={true}
  />,
);
assert.match(plannerS1Search, /Piłsudskiego - Plac Tuwima/, "planista znajduje przystanek po linii S1");
assert.match(plannerS1Search, /\bS1\b/, "planista widzi S1 na liście linii przystanku");

// ── 3. Usunięty komunikat „Przystanki są ukryte. Pokaż przystanki” i dolny guzik „Przystanki” ──
const appSource = await readFile(new URL("../src/components/MapPlanerApp.tsx", import.meta.url), "utf8");
assert.doesNotMatch(appSource, /Przystanki są ukryte\./, "usunięto komunikat o ukrytych przystankach");
assert.doesNotMatch(appSource, /StopFinder/, "usunięto osobny dolny przycisk Przystanki");

console.log("user view tests passed");
