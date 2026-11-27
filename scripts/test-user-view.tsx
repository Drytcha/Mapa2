import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TopBar from "../src/components/TopBar";
import CoursePreviewCard from "../src/components/CoursePreviewCard";
import { EMPTY_ROUTE } from "../src/lib/data";
import type { CoursePreview } from "../src/lib/engine/gtfsStore";

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

console.log("user view tests passed");
