import { DateTime } from "luxon";

export type TimetableDayKind = "weekday" | "saturday" | "sunday";
export interface TimetableDayChoice {
  dateId: string;
  serviceIds: string[];
}
export type TimetableDayChoices = Record<TimetableDayKind, TimetableDayChoice[]>;

/** loadBrigades builds internal IDs as date + duty number (or unassigned).
 * When changing PDF date, retain the duty identity, not yesterday's block ID. */
export function timetableBlockForDate(item: { blockId: string; number: string; unassigned: boolean }, viewDate: string, pdfDate: string): string {
  return pdfDate === viewDate ? item.blockId : `${pdfDate}_${item.unassigned ? "unassigned" : item.number}`;
}

/** List actual calendar dates, never combine services from different dates.
 * R&G's RS/SO/NS/NH identify the service pattern, including holiday exceptions.
 * For other feeds without such codes, use the actual calendar weekday. */
export function timetableDayChoices(
  dates: Map<number, Set<string>>,
  from: number,
  to: number,
): TimetableDayChoices {
  const result: TimetableDayChoices = { weekday: [], saturday: [], sunday: [] };
  for (const [date, services] of dates) {
    if (!services.size || (from > 0 && date < from) || (to > 0 && date > to)) continue;
    const dateId = String(date);
    const day = DateTime.fromFormat(dateId, "yyyyLLdd", { zone: "UTC" });
    if (!day.isValid || day.toFormat("yyyyLLdd") !== dateId) continue;
    const kinds = new Set<TimetableDayKind>();
    for (const service of services) {
      if (/_RS$/i.test(service)) kinds.add("weekday");
      else if (/_SO$/i.test(service)) kinds.add("saturday");
      else if (/_(NS|NH)$/i.test(service)) kinds.add("sunday");
    }
    if (!kinds.size) kinds.add(day.weekday === 6 ? "saturday" : day.weekday === 7 ? "sunday" : "weekday");
    const choice = { dateId, serviceIds: [...services].sort() };
    for (const kind of kinds) result[kind].push(choice);
  }
  for (const choices of Object.values(result)) choices.sort((a, b) => a.dateId.localeCompare(b.dateId));
  return result;
}

/** Prefer the closest actual date, resolving equal distances towards the future. */
export function closestTimetableDate(choices: TimetableDayChoice[], selectedDate: string): string {
  const selected = DateTime.fromFormat(selectedDate, "yyyyLLdd", { zone: "UTC" });
  if (!selected.isValid) return choices[0]?.dateId ?? "";
  return [...choices].sort((a, b) => {
    const aMs = DateTime.fromFormat(a.dateId, "yyyyLLdd", { zone: "UTC" }).toMillis();
    const bMs = DateTime.fromFormat(b.dateId, "yyyyLLdd", { zone: "UTC" }).toMillis();
    return Math.abs(aMs - selected.toMillis()) - Math.abs(bMs - selected.toMillis()) || bMs - aMs;
  })[0]?.dateId ?? "";
}
