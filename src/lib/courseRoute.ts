/**
 * Jedno źródło prawdy dla geometrii, po której rysuje się podgląd kursu.
 *
 * Panel kursu i mapa muszą ciąć dokładnie tę samą linię — inaczej trasa „do
 * przystanku” kończy się w innym miejscu niż kropka przystanku na mapie.
 * Mapa rysuje **pierwszą** naprawioną polilinię kursu (ciągłą, po drogach),
 * więc wycinek liczymy z niej, a nie z surowego kształtu GTFS.
 */
import type { CoursePreview } from "./engine/gtfsStore";
import { courseUpToStop, type CourseUpToStop } from "./routeProgress";

/** Szerokość prawego panelu kursu (px) — węższa, żeby widzieć więcej mapy. */
export const COURSE_SIDEBAR_WIDTH = 300;

/** Ścieżka, po której rysowany jest przebieg kursu na mapie. */
export function courseRoutePath(course: CoursePreview): [number, number][] {
  const drawn = course.polylines.find((line) => line.length >= 2);
  return drawn ?? course.path;
}

/** Przebieg kursu od startu do wybranego przystanku (podróżny wysiada wcześniej). */
export function courseStopTarget(
  course: CoursePreview,
  stopIndex: number,
): CourseUpToStop | null {
  return courseUpToStop(courseRoutePath(course), course.stops, stopIndex);
}
