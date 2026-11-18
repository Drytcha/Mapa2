import {
  buildBrigadesFromTrips,
  type BuilderStop,
  type BuilderTrip,
} from "./brigadeBuilder";

export const LINE_SEVEN_DUTY = "7-01";

/**
 * The operator's brigade endpoint omits line 7. Its GTFS trips normally form
 * one dominant, continuous vehicle run plus an overlapping extra trip. Only
 * the unambiguous run can be attributed to the known duty 7/01.
 */
export function reconstructLineSevenDuty(
  trips: BuilderTrip[],
  stops: Map<string, BuilderStop>,
): BuilderTrip[] {
  const lineTrips = trips.filter(
    (trip) => trip.line.toUpperCase() === "7" && trip.endMinutes >= trip.startMinutes,
  );
  if (!lineTrips.length) return [];

  const chains = buildBrigadesFromTrips({
    trips: lineTrips.map((trip) => ({ ...trip, observedBrigade: undefined })),
    stops,
  })
    .map((brigade) => brigade.trips)
    .sort((a, b) => b.length - a.length);

  const known = new Set(
    lineTrips
      .filter((trip) => /^(?:7[/:\-])0*1$/i.test(trip.observedBrigade ?? ""))
      .map((trip) => trip.id),
  );
  const chosen = known.size
    ? chains.find((chain) => [...known].every((id) => chain.some((trip) => trip.id === id)))
    : chains[0];
  if (!chosen) return [];

  // Without a direct observation, do not assign a number to two comparable
  // runs or to a line with only a handful of disconnected trips.
  if (
    !known.size &&
    (chosen.length < 3 ||
      chosen.length < lineTrips.length * 0.75 ||
      chosen.length <= (chains.find((chain) => chain !== chosen)?.length ?? 0) * 2)
  ) {
    return [];
  }

  const originalById = new Map(lineTrips.map((trip) => [trip.id, trip]));
  const result = chosen.map((trip) => originalById.get(trip.id)!);
  if (
    result.some(
      (trip) =>
        trip.observedBrigade &&
        !/^(?:7[/:\-])0*1$/i.test(trip.observedBrigade),
    )
  ) {
    return [];
  }
  return result;
}