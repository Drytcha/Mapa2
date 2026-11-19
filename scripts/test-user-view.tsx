import assert from "node:assert/strict";
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
console.log("user view tests passed");
