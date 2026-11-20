import { distanceCoords } from "@/lib/core/spatial";
import { dedupeLines, foldStopKey } from "@/lib/core/text";
import type { BusStop } from "@/lib/types";

/** A bearing from the preceding stop towards this stop (or towards the next
 * stop for a trip starting here). GTFS direction_id is route-specific, not a
 * compass direction, so it cannot be compared across routes. */
export type StopVector = [number, number];

export function mergeTimetableStops(
  stops: BusStop[],
  evidence: ReadonlyMap<string, { symbol?: string; code?: string; vectors?: StopVector[] }>,
): BusStop[] {
  const byName = new Map<string, BusStop[][]>();
  const sorted = [...stops].sort((a, b) => a.id.localeCompare(b.id));
  const compatible = (a: BusStop, b: BusStop) => {
    if (distanceCoords(a.lat, a.lon, b.lat, b.lon) > 25) return false;
    const ea = evidence.get(a.id), eb = evidence.get(b.id);
    const sameSymbol = !!ea?.symbol && ea.symbol === eb?.symbol;
    const sameCode = !!ea?.code && ea.code === eb?.code;
    // Distinct official symbols represent distinct physical platforms. Never
    // collapse them just because the coordinates happen to be identical.
    if (ea?.symbol && eb?.symbol && !sameSymbol) return false;
    const va = ea?.vectors ?? [], vb = eb?.vectors ?? [];
    const dots = va.flatMap((x) => vb.map((y) => x[0] * y[0] + x[1] * y[1]));
    const aligned = dots.some((dot) => dot >= 0.5);
    const oppositeOnly = dots.length > 0 && dots.every((dot) => dot < -0.5);
    if (oppositeOnly) return false;
    // Without an official platform identity, require both close proximity and
    // actual travel-direction evidence. Unknown direction is not proof.
    return sameSymbol || sameCode || (aligned && distanceCoords(a.lat, a.lon, b.lat, b.lon) <= 12);
  };
  for (const stop of sorted) {
    const key = foldStopKey(stop.name);
    const groups = byName.get(key) ?? [];
    // Complete-linkage: avoid accidentally bridging two opposite platforms via
    // a third, ambiguous stop.
    const group = key && groups.find((g) => g.every((member) => compatible(member, stop)));
    if (group) group.push(stop);
    else groups.push([stop]);
    byName.set(key, groups);
  }
  return [...byName.values()].flatMap((groups) => groups.map((group) => {
    if (group.length === 1) return group[0];
    const first = group[0];
    return {
      ...first,
      lines: dedupeLines(group.flatMap((s) => s.lines)),
      gtfsIds: first.source === "timetable" ? group.flatMap((s) => s.gtfsIds ?? (s.gtfsId ? [s.gtfsId] : [])) : undefined,
      snapshotIds: first.source === "snapshot" ? group.flatMap((s) => s.snapshotIds ?? []) : undefined,
      merged: group.length,
    };
  }));
}
