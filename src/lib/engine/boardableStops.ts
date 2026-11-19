/** A stop is useful for departures only when at least one trip permits boarding.
 * Terminal and drop-off-only calls must not add lines or destinations to it. */
export interface BoardableStopRow {
  canBoard: boolean;
  rawServiceId: string;
  routeId: string;
  lastStopName: string;
}

export function boardableStopInfo(
  rows: readonly BoardableStopRow[],
  activeServices: ReadonlySet<string> | null,
  routeNames: ReadonlyMap<string, string>
): { lines: Set<string>; destination: string | undefined } {
  const lines = new Set<string>();
  const destinations = new Map<string, number>();
  for (const row of rows) {
    if (!row.canBoard || (activeServices && !activeServices.has(row.rawServiceId))) continue;
    const line = routeNames.get(row.routeId) || row.routeId;
    if (line) lines.add(line);
    if (row.lastStopName) {
      destinations.set(row.lastStopName, (destinations.get(row.lastStopName) ?? 0) + 1);
    }
  }
  let destination: string | undefined;
  let max = 0;
  for (const [name, count] of destinations) {
    if (count > max) {
      destination = name;
      max = count;
    }
  }
  return { lines, destination };
}
