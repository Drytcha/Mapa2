import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CoursePreviewCard from "../src/components/CoursePreviewCard";
import CourseNavigationHud from "../src/components/CourseNavigationHud";
import BusSearch from "../src/components/BusSearch";
import KursowkiDialog from "../src/components/KursowkiDialog";
import MapInfoSidebar from "../src/components/MapInfoSidebar";
import {
  BusStopCard,
  LiveBusCard,
  LiveFleetControl,
  MapControls,
  MapQuickBar,
} from "../src/components/MapOverlays";
import { buildBusMarker } from "../src/lib/busMarker";
import {
  buildCourseNavRoute,
  evaluateCourseNavigation,
} from "../src/lib/courseNavigation";
import { EMPTY_ROUTE } from "../src/lib/data";
import { DEFAULT_VISIBILITY } from "../src/lib/visibility";
import type { CoursePreview } from "../src/lib/engine/gtfsStore";
import type { BusStop, LiveBusVehicle } from "../src/lib/types";

const noop = () => {};
const baseSidebarProps = {
  open: true,
  onClose: noop,
  theme: "light" as const,
  onToggleTheme: noop,
  kursowkiOpen: false,
  linesOpen: false,
  onOpenKursowki: noop,
  onOpenLines: noop,
  onOpenPlanner: noop,
  onOpenSteps: noop,
  onOpenFleet: noop,
  onOpenReport: noop,
  onOpenSettings: noop,
  onOpenPdf: noop,
  pdfDisabled: true,
  onRoleChange: noop,
  showLiveBuses: true,
  onToggleLiveBuses: noop,
  operatorFilter: "all" as const,
  onOperatorFilter: noop,
  liveVehicles: [],
  liveTraffic: null,
  liveLoading: false,
  onRefreshLive: noop,
  mapStopCount: 0,
  busLoading: false,
  onRefreshBusStops: noop,
  visibility: DEFAULT_VISIBILITY,
  onVisibilityChange: noop,
  signalCount: 0,
  turnaroundCount: 0,
  mapStyle: "dark" as const,
  onMapStyle: noop,
  onHome: noop,
  onFit: noop,
  locationStatus: "idle" as const,
  userLocation: null,
  followingUser: false,
  onLocate: noop,
  onRetryLocation: noop,
  onOpenTripPlanner: noop,
  route: EMPTY_ROUTE,
};
const user = renderToStaticMarkup(
  <MapInfoSidebar {...baseSidebarProps} role="traveler" isPlanner={false} />,
);
assert.doesNotMatch(user, /Planista|Planer|Podróżny|Logowanie/i);
assert.match(user, /Kursówki/);
assert.match(user, /Linie/);
const planner = renderToStaticMarkup(
  <MapInfoSidebar {...baseSidebarProps} role="planner" isPlanner={true} />,
);
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
  />,
);
assert.match(quickBarHtml, /data-testid="map-sidebar-toggle"/, "ikonka do rozwijania sidebaru");
assert.match(quickBarHtml, /Otwórz panel boczny mapy/);
assert.match(quickBarHtml, /Szukaj przystanku lub autobusu/, "kompaktowa wyszukiwarka obok ikonki");

const sampleUserLocation = {
  lat: 50.77,
  lon: 16.28,
  accuracy: 10,
  altitude: 582,
  heading: null,
  speedKmh: 0,
  maxSpeedKmh: 0,
  distanceM: 12,
  timestamp: Date.now(),
};

const closedSidebarHtml = renderToStaticMarkup(
  <MapInfoSidebar
    {...baseSidebarProps}
    open={false}
    isPlanner={false}
    liveVehicles={sampleVehicles}
    mapStopCount={sampleStops.length}
    locationStatus="active"
    userLocation={sampleUserLocation}
  />,
);
assert.match(closedSidebarHtml, /data-open="false"/, "sidebar startuje zwinięty, odsłaniając 100% mapy");
assert.match(closedSidebarHtml, /inert=""/, "zwinięty sidebar jest nieaktywny dla tabulacji");

// Główny widok sidebara ("home") pokazuje zwięzłe skróty zamiast wszystkich przełączników naraz
const homeSidebarHtml = renderToStaticMarkup(
  <MapInfoSidebar
    {...baseSidebarProps}
    open={true}
    initialView="home"
    isPlanner={false}
    liveVehicles={sampleVehicles}
    mapStopCount={sampleStops.length}
    locationStatus="active"
    userLocation={sampleUserLocation}
  />,
);
assert.match(homeSidebarHtml, /data-open="true"/);
assert.match(homeSidebarHtml, /data-view="home"/);
assert.match(homeSidebarHtml, /Widoczność na mapie/);
assert.match(homeSidebarHtml, /Wszystkie przystanki \(2\)/);
assert.match(homeSidebarHtml, /Moja lokalizacja GPS/);
assert.doesNotMatch(
  homeSidebarHtml,
  /Autobusy GPS na żywo|Styl mapy i motyw|Legenda punktualności GPS|Przywróć domyślne ustawienia/,
  "GPS i styl mapy są bezpośrednio na mapie, nie w podwidokach sidebara",
);

// Pasek Autobusy GPS na mapie (LiveFleetControl) jest widoczny cały czas, ma wyłącznik i nie zawiera kategorii „Inni”
const liveFleetHtml = renderToStaticMarkup(
  <LiveFleetControl
    hideSearch
    showLiveBuses={true}
    onToggleLiveBuses={noop}
    operatorFilter="all"
    onOperatorFilter={noop}
    liveVehicles={sampleVehicles}
    busStops={sampleStops}
    liveTraffic={null}
    liveLoading={false}
    onRefreshLive={noop}
    signalCount={0}
    showTrafficSignals={false}
    onToggleTrafficSignals={noop}
    turnaroundCount={0}
    showTurnarounds={false}
    onToggleTurnarounds={noop}
    onSelectBus={noop}
    onSelectStop={noop}
  />,
);
assert.match(liveFleetHtml, /data-testid="live-fleet-bar"/);
assert.match(liveFleetHtml, /data-testid="live-gps-toggle"/);
assert.match(liveFleetHtml, /GPS \(1\)/);
assert.match(liveFleetHtml, /Wszystkie \(1\)/);
assert.match(liveFleetHtml, /MZUK/);
assert.match(liveFleetHtml, /ŚKA/);
assert.match(liveFleetHtml, /Odśwież pozycje GPS autobusów/);
assert.doesNotMatch(liveFleetHtml, /Inni|Inny|Pozostali operatorzy/, "brak kategorii 'inne' w filtrach przewoźnika");
assert.doesNotMatch(liveFleetHtml, /type="search"/, "hideSearch zapobiega duplikacji pola wyszukiwania pod MapQuickBar");

const liveFleetOffHtml = renderToStaticMarkup(
  <LiveFleetControl
    hideSearch
    showLiveBuses={false}
    onToggleLiveBuses={noop}
    operatorFilter="all"
    onOperatorFilter={noop}
    liveVehicles={sampleVehicles}
    busStops={sampleStops}
    liveTraffic={null}
    liveLoading={false}
    onRefreshLive={noop}
    signalCount={0}
    showTrafficSignals={false}
    onToggleTrafficSignals={noop}
    turnaroundCount={0}
    showTurnarounds={false}
    onToggleTurnarounds={noop}
    onSelectBus={noop}
    onSelectStop={noop}
  />,
);
assert.match(liveFleetOffHtml, /aria-pressed="false"/);
assert.doesNotMatch(liveFleetOffHtml, /Wszystkie \(1\)/, "po wyłączeniu GPS filtry chowają się, a sam przycisk GPS pozostaje na mapie");

// Styl mapy znajduje się w prawym pionowym pasku MapControls
const mapControlsWithStyleHtml = renderToStaticMarkup(
  <MapControls
    mapStyle="light"
    onMapStyle={noop}
    onZoomIn={noop}
    onZoomOut={noop}
    onFit={noop}
    onLocate={noop}
    locateState="idle"
  />,
);
assert.match(mapControlsWithStyleHtml, /data-testid="map-controls-bar"/);
assert.match(mapControlsWithStyleHtml, /data-testid="map-style-toggle"/);
assert.match(mapControlsWithStyleHtml, /aria-label="Styl mapy"/);

const visibilityViewHtml = renderToStaticMarkup(
  <MapInfoSidebar
    {...baseSidebarProps}
    open={true}
    initialView="visibility"
    isPlanner={false}
    mapStopCount={sampleStops.length}
  />,
);
assert.match(visibilityViewHtml, /data-view="visibility"/);
assert.match(visibilityViewHtml, /aria-label="Ustawienia widoczności"/);
assert.match(visibilityViewHtml, /Kursówka nad pojazdem/);
assert.match(visibilityViewHtml, /Przywróć domyślne ustawienia/);

const locationViewHtml = renderToStaticMarkup(
  <MapInfoSidebar
    {...baseSidebarProps}
    open={true}
    initialView="location"
    isPlanner={false}
    locationStatus="active"
    userLocation={sampleUserLocation}
  />,
);
assert.match(locationViewHtml, /data-view="location"/);
assert.match(locationViewHtml, /582 m n\.p\.m\./);

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

// ── 4. Pasek ikon przy lewej krawędzi (Icon Rail) + zintegrowane widoki w jednym sidebarze ──
const desktopClosedWithRailHtml = renderToStaticMarkup(
  <>
    <MapQuickBar
      sidebarOpen={false}
      onToggleSidebar={noop}
      showLiveBuses={true}
      liveVehicles={sampleVehicles}
      busStops={sampleStops}
      onSelectBus={noop}
      onSelectStop={noop}
      hideToggle={true}
    />
    <MapInfoSidebar
      {...baseSidebarProps}
      open={false}
      showRail={true}
      isPlanner={false}
      liveVehicles={sampleVehicles}
      mapStopCount={sampleStops.length}
      userLocation={sampleUserLocation}
      locationStatus="active"
    />
  </>,
);
assert.match(desktopClosedWithRailHtml, /data-testid="map-icon-rail"/, "na desktopie stały wąski pasek ikon przy lewej krawędzi");
for (const railId of [
  "map-sidebar-toggle",
  "rail-trip",
  "rail-lines",
  "rail-kursowki",
  "rail-visibility",
  "rail-theme",
  "rail-home",
]) {
  assert.match(desktopClosedWithRailHtml, new RegExp(`data-testid="${railId}"`), `ikona na pasku bocznym: ${railId}`);
}
assert.doesNotMatch(desktopClosedWithRailHtml, /rail-gps|rail-appearance/);
assert.equal(
  (desktopClosedWithRailHtml.match(/data-testid="map-sidebar-toggle"/g) ?? []).length,
  1,
  "dokładnie jeden przycisk map-sidebar-toggle (brak duplikatu między MapQuickBar a paskiem ikon)",
);
assert.equal(
  (desktopClosedWithRailHtml.match(/type="search"/g) ?? []).length,
  1,
  "dokładnie jedno pole wyszukiwania gdy sidebar jest zwinięty",
);
assert.equal(
  (desktopClosedWithRailHtml.match(/data-testid="user-speed"/g) ?? []).length,
  1,
  "dokładnie jeden wskaźnik prędkości GPS na pasku ikon gdy sidebar jest zwinięty",
);
assert.doesNotMatch(desktopClosedWithRailHtml, /Planista|Planer|Podróżny|Logowanie/i);

// Otwarty widok przystanku, autobusu i kursu wewnątrz tego samego lewego sidebara
const embeddedStopHtml = renderToStaticMarkup(
  <MapInfoSidebar
    {...baseSidebarProps}
    open={true}
    showRail={true}
    view="stop"
    isPlanner={false}
    userLocation={sampleUserLocation}
    locationStatus="active"
    stopContent={
      <BusStopCard
        embedded
        stop={sampleStops[0]}
        isPlanner={false}
        alreadyInRoute={false}
        canAdd={true}
        onClose={noop}
        onAddVia={noop}
        onSetStart={noop}
        onSetEnd={noop}
        onCenter={noop}
      />
    }
  />,
);
assert.match(embeddedStopHtml, /data-view="stop"/);
assert.match(embeddedStopHtml, /data-testid="map-sidebar-back"/, "widok przystanku pozwala jednym kliknięciem wrócić do menu");
assert.match(embeddedStopHtml, /Piłsudskiego - Plac Tuwima/);
assert.equal(
  (embeddedStopHtml.match(/data-testid="user-speed"/g) ?? []).length,
  1,
  "wskaźnik prędkości GPS pozostaje widoczny na pasku ikon podczas przeglądania przystanku",
);

const embeddedBusHtml = renderToStaticMarkup(
  <MapInfoSidebar
    {...baseSidebarProps}
    open={true}
    showRail={true}
    view="bus"
    isPlanner={false}
    busContent={
      <LiveBusCard
        embedded
        isPlanner={false}
        bus={sampleVehicles[0]}
        onClose={noop}
        onOpenKursowka={noop}
        onSetOperator={noop}
        onCenter={noop}
      />
    }
  />,
);
assert.match(embeddedBusHtml, /data-view="bus"/);
assert.doesNotMatch(embeddedBusHtml, /data-mobile-sheet="bus"/, "w trybie embedded karta autobusu nie tworzy osobnej dolnej szuflady");

const embeddedCourseHtml = renderToStaticMarkup(
  <MapInfoSidebar
    {...baseSidebarProps}
    open={true}
    showRail={true}
    view="course"
    isPlanner={false}
    courseContent={
      <CoursePreviewCard
        embedded
        course={timedCourse}
        onClose={noop}
        onFit={noop}
        onBack={noop}
        onSelectStop={noop}
      />
    }
  />,
);
assert.match(embeddedCourseHtml, /data-view="course"/);
assert.match(embeddedCourseHtml, /course-preview-card/);
assert.doesNotMatch(embeddedCourseHtml, /course-drawer-tab/, "osadzony w lewym sidebarze podgląd kursu nie dubluje prawego uchwytu");

// ── 5. Znaczniki zależne od przybliżenia + kompaktowe pigułki autobusów bez pustych boksów ──
const cssSource = await readFile(new URL("../src/app/globals.css", import.meta.url), "utf8");
assert.match(cssSource, /data-zoom-tier="far"/, "styl kropek przystanków dla dalekiego widoku mapy");
assert.match(cssSource, /data-zoom-tier="city"/, "styl dyskretnych kropek przystanków dla skali miasta");
assert.doesNotMatch(
  cssSource,
  /\.live-bus-label\s*\{\s*opacity:\s*0/,
  "nie ukrywamy numeru linii przez opacity:0 (co zostawiało szerokie puste boksy)",
);
assert.match(
  cssSource,
  /\.live-bus-chip[\s\S]*?display:\s*none/,
  "dymek km/h i rozszerzenia są chowane przez display:none przy oddaleniu mapy",
);

assert.equal(
  DEFAULT_VISIBILITY.busVehicleNumber,
  true,
  "numer taborowy pojazdu jest domyślnie włączony na mapie",
);

const busMarkerSample = buildBusMarker(
  sampleVehicles[0],
  { kursowka: true, vehicleNumber: true },
  false,
);
assert.match(busMarkerSample.html, /class="live-bus-line">7</, "numer linii jest zawsze oznaczony jako główny element pigułki");
assert.match(busMarkerSample.html, /class="live-bus-extra">\/01</, "końcówka brygady ma klasę live-bus-extra chowaną przy oddaleniu");
assert.match(
  busMarkerSample.html,
  /class="live-bus-veh-group"><span class="live-bus-sep">\|<\/span><span class="live-bus-veh">#404<\/span><\/span>/,
  "numer pojazdu (#404) jest poza klasą live-bus-extra, więc pozostaje widoczny również z daleka",
);
assert.doesNotMatch(
  cssSource,
  /\.live-bus-veh[^{]*\{[^}]*display:\s*none/,
  "CSS nie ukrywa numeru pojazdu przy oddaleniu mapy",
);

// Autobus bez wybranej linii pokazuje wyłącznie sam numer autobusu (bez '?' i bez linii)
for (const emptyRoute of ["", "   ", "?", "-"]) {
  const noLineMarker = buildBusMarker(
    { ...sampleVehicles[0], routeName: emptyRoute, kursowka: "", vehicleId: "340" },
    { kursowka: false, vehicleNumber: false },
    false,
  );
  assert.match(
    noLineMarker.html,
    /<span class="live-bus-label"><span class="live-bus-veh live-bus-veh--solo">#340<\/span><\/span>/,
    `gdy routeName="${emptyRoute}", pigułka pokazuje wyłącznie sam numer autobusu`,
  );
  assert.doesNotMatch(noLineMarker.html, /live-bus-line|>\?<|live-bus-veh-group/);
}

const mapViewSource = await readFile(new URL("../src/components/MapView.tsx", import.meta.url), "utf8");
assert.match(mapViewSource, /dataset\.zoomTier/, "MapView aktualizuje data-zoom-tier przy zmianie przybliżenia");
assert.match(mapViewSource, /"close"/, "MapView ustawia pełny tryb close przy dużym przybliżeniu");
assert.match(mapViewSource, /courseStopLabels/, "MapView tworzy warstwę numerów przystanków 1, 2, 3…");
assert.equal(
  (mapViewSource.match(/data-course-stop-num=/g) ?? []).length >= 2,
  true,
  "numery przystanków są renderowane na trasach kursów, linii i autobusów GPS",
);

// ── 6. Porównywarka NS vs NH wyłącznie w widoku Planisty ──
const passengerKursowkiHtml = renderToStaticMarkup(
  <KursowkiDialog
    open={true}
    embedded={true}
    isPlanner={false}
    liveVehicles={sampleVehicles}
    onSelectBus={noop}
    onClose={noop}
    onOpenNsNhDiff={noop}
    onLoadTripToPlanner={noop}
  />,
);
assert.doesNotMatch(
  passengerKursowkiHtml,
  /NS vs NH|kursowki-open-ns-nh-diff/,
  "pasażer nie widzi porównywarki NS vs NH",
);

const plannerKursowkiHtml = renderToStaticMarkup(
  <KursowkiDialog
    open={true}
    embedded={true}
    isPlanner={true}
    liveVehicles={sampleVehicles}
    onSelectBus={noop}
    onClose={noop}
    onOpenNsNhDiff={noop}
    onLoadTripToPlanner={noop}
  />,
);
assert.match(
  plannerKursowkiHtml,
  /kursowki-open-ns-nh-diff/,
  "planista widzi porównywarkę NS vs NH w Kursówkach",
);

// ── 7. Numery przystanków 1, 2, 3… oraz nawigacja po całym przebiegu kursu (sterownik autobusu) ──
const courseCardWithNavHtml = renderToStaticMarkup(
  <CoursePreviewCard
    embedded
    course={timedCourse}
    onClose={noop}
    onFit={noop}
    onBack={noop}
    onSelectStop={noop}
    onStartNavigation={noop}
  />,
);
assert.match(courseCardWithNavHtml, /course-start-navigation/, "w podglądzie kursu jest przycisk uruchomienia nawigacji po trasie");
assert.match(courseCardWithNavHtml, /Nawiguj po trasie kursu/);

// Trasa ze skrętem w prawo o 90° (północ -> wschód) i 3 przystankami
const turnCourse: CoursePreview = {
  ...timedCourse,
  startMs: 1_700_000_000_000,
  endMs: 1_700_000_600_000,
  polylines: [
    [
      [50.7700, 16.2800],
      [50.7720, 16.2800],
      [50.7740, 16.2800], // skręt w prawo na wschód
      [50.7740, 16.2840],
      [50.7740, 16.2880],
    ],
  ],
  stops: [
    {
      id: "s1",
      name: "Piłsudskiego - Start",
      lat: 50.7700,
      lon: 16.2800,
      sequence: 1,
      arrivalMs: 1_700_000_000_000,
      departureMs: 1_700_000_000_000,
      afterMidnight: false,
    },
    {
      id: "s2",
      name: "Sikorskiego - Skrzyżowanie",
      lat: 50.7740,
      lon: 16.2800,
      sequence: 2,
      arrivalMs: 1_700_000_300_000,
      departureMs: 1_700_000_300_000,
      afterMidnight: false,
    },
    {
      id: "s3",
      name: "Piaskowa Góra - Pętla",
      lat: 50.7740,
      lon: 16.2880,
      sequence: 3,
      arrivalMs: 1_700_000_600_000,
      departureMs: 1_700_000_600_000,
      afterMidnight: false,
    },
  ],
};

const navRoute = buildCourseNavRoute(turnCourse);
assert.ok(navRoute, "buduje strukturę nawigacji z przebiegu kursu");
assert.equal(navRoute.stops.length, 3);
assert.deepEqual(
  navRoute.stops.map((s) => s.number),
  [1, 2, 3],
  "przystanki w nawigacji mają kolejną numerację 1, 2, 3",
);
assert.ok(
  navRoute.maneuvers.some((m) => m.kind === "right"),
  "wykrywa skręt w prawo na trasie kursu",
);

// Pozycja GPS na pierwszym odcinku (w połowie drogi między przystankiem #1 a zakrętem #2), spóźniony o 90 s
const onRouteState = evaluateCourseNavigation({
  route: navRoute,
  mode: "gps",
  gps: { lat: 50.7720, lon: 16.2800, accuracy: 10, speedKmh: 32, heading: 0 },
  simMeters: 0,
  prevAlongMeters: 0,
  nowMs: 1_700_000_150_000 + 90_000,
  startedAtMs: 1_700_000_000_000,
  punctualityMode: "schedule",
});
assert.equal(onRouteState.offRoute, false, "pojazd na trasie nie zgłasza zjechania z linii");
assert.equal(onRouteState.nextStop?.number, 2, "następny przystanek to #2");
assert.equal(onRouteState.nextManeuver.kind, "right", "sterownik zapowiada zbliżający się skręt w prawo");
assert.ok(
  onRouteState.scheduleDeltaSeconds !== null &&
    Math.abs(onRouteState.scheduleDeltaSeconds - 90) <= 5,
  `odchyłka rozkładowa wylicza ~90 s opóźnienia (jest ${onRouteState.scheduleDeltaSeconds})`,
);
assert.ok(onRouteState.splitPath.passed.length >= 2 && onRouteState.splitPath.remaining.length >= 2);

const hudOnRouteHtml = renderToStaticMarkup(
  <CourseNavigationHud
    route={navRoute}
    state={onRouteState}
    mode="gps"
    onModeChange={noop}
    simPlaying={false}
    onToggleSimPlay={noop}
    simSpeedMultiplier={1}
    onCycleSimSpeed={noop}
    gpsAvailable={true}
    gpsSpeedKmh={32}
    followingCamera={true}
    onRecenterCamera={noop}
    punctualityMode="schedule"
    onTogglePunctualityMode={noop}
    onStepStop={noop}
    onJumpToStop={noop}
    onStopNavigation={noop}
  />,
);
assert.match(hudOnRouteHtml, /course-nav-hud/);
assert.match(hudOnRouteHtml, /Skręć w prawo/);
assert.match(hudOnRouteHtml, /Sikorskiego - Skrzyżowanie/);
assert.match(hudOnRouteHtml, /-1:30/, "sterownik pokazuje opóźnienie w formacie -1:30");

// Zjechanie z trasy (> 200 m na zachód) uruchamia ostrzeżenie na sterowniku
const offRouteState = evaluateCourseNavigation({
  route: navRoute,
  mode: "gps",
  gps: { lat: 50.7720, lon: 16.2750, accuracy: 10, speedKmh: 25 },
  simMeters: 0,
  prevAlongMeters: onRouteState.alongMeters,
  nowMs: 1_700_000_200_000,
  startedAtMs: 1_700_000_000_000,
  punctualityMode: "schedule",
});
assert.equal(offRouteState.offRoute, true, "wykrywa zjechanie z trasy linii");
const hudOffRouteHtml = renderToStaticMarkup(
  <CourseNavigationHud
    route={navRoute}
    state={offRouteState}
    mode="gps"
    onModeChange={noop}
    simPlaying={false}
    onToggleSimPlay={noop}
    simSpeedMultiplier={1}
    onCycleSimSpeed={noop}
    gpsAvailable={true}
    gpsSpeedKmh={25}
    followingCamera={true}
    onRecenterCamera={noop}
    punctualityMode="schedule"
    onTogglePunctualityMode={noop}
    onStepStop={noop}
    onJumpToStop={noop}
    onStopNavigation={noop}
  />,
);
assert.match(hudOffRouteHtml, /course-nav-offroute/, "sterownik ostrzega o zjechaniu z trasy linii");

console.log("user view tests passed");
