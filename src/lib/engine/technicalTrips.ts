/** Only explicit GTFS labels identify a technical run; a terminal, a depot
 * stop or a gap between two trips is not sufficient evidence to invent one. */
export type TechnicalTripCode = "WY" | "PRZ" | "ZJ";

export function technicalTripCode(routeShort: string, tripShort: string, headsign: string, routeLong = ""): TechnicalTripCode | undefined {
  // A route's long name can itself be an explicit technical designation. Give
  // existing labels priority, and never match partial descriptions or stops.
  const labels = [routeShort, tripShort, headsign, routeLong];
  for (const label of labels) {
    const value = label.trim().toLocaleUpperCase("pl").replace(/\s+/g, " ");
    if (value === "WY" || value === "WYJAZD" || value === "WYJAZD Z ZAJEZDNI") return "WY";
    if (value === "PRZ" || value === "PRZEJAZD TECHNICZNY") return "PRZ";
    if (value === "ZJ" || value === "ZJAZD" || value === "ZJAZD DO ZAJEZDNI") return "ZJ";
  }
  return undefined;
}
