import { afterEach, describe, expect, it } from "vitest";
import { buildBrigadesFromTrips, type BuilderTrip } from "../src/lib/engine/brigadeBuilder";
import { mergeDutyTimes } from "../src/lib/engine/brigades";
import { assignDuties, type ScheduleTrip } from "../src/lib/engine/dutyAssignment";
import {
  registerLineSevenRosters,
  resolveFleetDuties,
  rosterDutiesForTrips,
} from "../src/lib/engine/brigadeVerification";
import { reconstructLineSevenDuty } from "../src/lib/engine/lineSevenDuty";
import type { LiveBusVehicle } from "../src/lib/types";

const stops = new Map([
  ["R", { lat: 50.7833, lon: 16.25163 }],
  ["S", { lat: 50.80153, lon: 16.27925 }],
  ["H", { lat: 50.80186, lon: 16.27947 }],
]);

function trip(
  id: string,
  startMinutes: number,
  endMinutes: number,
  firstStopId: string,
  lastStopId: string,
  observedBrigade?: string,
): BuilderTrip {
  return {
    id,
    line: "7",
    headsign: "Terminus",
    startMinutes,
    endMinutes,
    firstStopId,
    lastStopId,
    firstStopName: firstStopId,
    lastStopName: lastStopId,
    lengthMeters: 5000,
    observedBrigade,
  };
}

function bus(id: string, tripId: string, startMs: number): LiveBusVehicle {
  return {
    vehicleId: id,
    model: null,
    operatorKey: "mzuk",
    operatorName: "MZUK",
    operatorSource: "auto",
    routeName: "7",
    routeColor: "#006d29",
    brigade: "01",
    rawBrigade: "01",
    kursowka: "",
    tripId,
    tripStartMs: startMs,
    tripServiceDate: "20261113",
    tripRouteShort: "7",
    lat: 50.79,
    lon: 16.27,
    bearing: null,
    delaySeconds: 0,
    speedKmh: null,
    headsign: null,
    timestamp: startMs + 60_000,
    upcomingStops: [],
  };
}

function scheduled(
  id: string,
  line: string,
  startMinutes: number,
  endMinutes: number,
  firstStopId: string,
  lastStopId: string,
  explicitBrigade?: string,
): ScheduleTrip {
  return {
    rawTripId: id,
    routeId: line,
    routeShort: line,
    startMinutes,
    endMinutes,
    firstStopId,
    lastStopId,
    explicitBrigade,
  };
}

afterEach(() => registerLineSevenRosters(new Map()));

describe("brigade course assignment", () => {
  it("keeps an overlapping extra line 7 trip out of 7/01", () => {
    const trips = [
      trip("first", 324, 350, "R", "S"),
      trip("extra", 374, 400, "R", "S"),
      trip("return-1", 375, 399, "H", "R"),
      trip("out-2", 410, 436, "R", "S"),
      trip("return-2", 440, 464, "H", "R"),
      trip("out-3", 465, 491, "R", "S"),
    ];
    expect(reconstructLineSevenDuty(trips, stops).map((item) => item.id)).toEqual([
      "first",
      "return-1",
      "out-2",
      "return-2",
      "out-3",
    ]);
  });

  it("does not label similarly sized, ambiguous runs", () => {
    const trips = [
      trip("one", 300, 320, "R", "S"),
      trip("two", 301, 321, "R", "S"),
      trip("three", 330, 350, "H", "R"),
      trip("four", 331, 351, "H", "R"),
    ];
    expect(reconstructLineSevenDuty(trips, stops)).toEqual([]);
  });

  it("inserts a connecting trip between anchors without allowing overlaps", () => {
    const trips = [
      trip("early", 300, 326, "R", "S", "7/01"),
      trip("middle", 335, 359, "H", "R"),
      trip("late", 370, 396, "R", "S", "7/01"),
      trip("overlap", 380, 400, "R", "S"),
    ];
    const result = buildBrigadesFromTrips({ trips, stops });
    expect(result.find((duty) => duty.number === "7-01")?.trips.map((item) => item.id)).toEqual([
      "early",
      "middle",
      "late",
    ]);
    expect(result.flatMap((duty) => duty.trips.map((item) => item.id)).sort()).toEqual(
      trips.map((item) => item.id).sort(),
    );
    const strict = buildBrigadesFromTrips({
      trips,
      stops,
      attachUnconfirmedToConfirmed: false,
    });
    expect(strict.find((duty) => duty.number === "7-01")?.trips).toHaveLength(2);
  });

  it("leaves conflicting observed trips unnumbered instead of double-booking a bus", () => {
    const result = buildBrigadesFromTrips({
      trips: [
        trip("first", 300, 326, "R", "S", "7/01"),
        trip("simultaneous", 310, 336, "R", "S", "7/01"),
      ],
      stops,
    });
    expect(result.find((duty) => duty.number === "7-01")?.trips.map((item) => item.id)).toEqual([
      "first",
    ]);
    expect(result.find((duty) => duty.unassigned)?.trips.map((item) => item.id)).toEqual([
      "simultaneous",
    ]);
  });

  it("combines cross-line duty times without duplicating a run", () => {
    expect(
      mergeDutyTimes(
        [
          [400, 420],
          [600, 620],
        ],
        [
          [600, 620],
          [500, 525],
        ],
      ),
    ).toEqual([
      [400, 420],
      [500, 525],
      [600, 620],
    ]);
  });

  it("respects an explicit cross-line block instead of inventing a route prefix", () => {
    const result = assignDuties(
      [scheduled("cross", "19", 300, 330, "R", "S", "9-01")],
      stops,
      [],
    );
    expect(result[0].kursowkaCode).toBe("9/01");
    expect(result[0].trips[0].trip.rawTripId).toBe("cross");
    expect(
      assignDuties(
        [scheduled("invalid", "19", 300, 330, "R", "S", "WY-04")],
        stops,
        [],
      )[0].source,
    ).toBe("unassigned");
  });

  it("checks both neighbours before estimating a trip's brigade", () => {
    const result = assignDuties(
      [
        scheduled("first", "7", 300, 320, "R", "S", "7-01"),
        scheduled("impossible", "7", 330, 360, "H", "H"),
        scheduled("last", "7", 370, 395, "R", "S", "7-01"),
      ],
      stops,
      [],
    );
    expect(result.find((duty) => duty.kursowkaCode === "7/01")?.trips).toHaveLength(2);
    expect(result.find((duty) => duty.source === "unassigned")?.trips[0].trip.rawTripId).toBe(
      "impossible",
    );
  });

  it("uses exact GTFS trip IDs and never infers 7/01 for the extra trip", () => {
    const start = 1_794_564_900_000;
    registerLineSevenRosters(
      new Map([
        ["20261113", [{ id: "known", startMs: start, endMs: start + 24 * 60_000 }]],
      ]),
    );

    const extra = { id: "extra", line: "7", startMs: start - 60_000 };
    expect(rosterDutiesForTrips("20261113", [extra]).size).toBe(0);
    expect(
      rosterDutiesForTrips("20261113", [
        { id: "known", line: "7", startMs: start },
      ]).get("known"),
    ).toBe("7/01");

    const fleet = resolveFleetDuties(
      [bus("701", "known", start), bus("702", "extra", start - 60_000)],
      start + 60_000,
    ).vehicles;
    expect(fleet[0].dutyCode).toBe("7/01");
    expect(fleet[0].dutyStatus).toBe("confirmed");
    expect(fleet[1].dutyCode).toBeNull();
    expect(fleet[1].dutyStatus).toBe("unresolved");
  });

  it("does not guess between simultaneous trips and respects cross-line duties", () => {
    const fiveOClock = Date.parse("2026-11-13T04:00:00Z");
    const ambiguous = rosterDutiesForTrips("20261113", [
      { id: "outbound", line: "2", startMs: fiveOClock },
      { id: "inbound", line: "2", startMs: fiveOClock },
    ]);
    expect(ambiguous.size).toBe(0);

    const exact = rosterDutiesForTrips("20261113", [
      { id: "only", line: "2", startMs: fiveOClock },
      { id: "cross-line", line: "2", startMs: Date.parse("2026-11-13T21:42:00Z") },
    ]);
    expect(exact.get("only")).toBe("2/01");
    expect(exact.get("cross-line")).toBe("15/01");
  });
});