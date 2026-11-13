import { beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import type { GtfsMemoryStore } from "../src/lib/engine/gtfsStore";
import type { WalkingPoint } from "../src/lib/walkingRouter";

const mocks = vi.hoisted(() => ({ seeded: vi.fn(), walk: vi.fn() }));
vi.mock("../src/lib/engine/gtfsStore", () => ({
  ensureGtfsSeeded: mocks.seeded,
}));
vi.mock("../src/lib/walkingRouter", () => ({
  getWalkingRoute: mocks.walk,
  walkingKey: (a: WalkingPoint, b: WalkingPoint) =>
    `${a.lat},${a.lon}>${b.lat},${b.lon}`,
}));
import { planJourneys, type JourneyBusLeg } from "../src/lib/journeyPlanner";

const day = DateTime.fromISO("2026-06-16", { zone: "Europe/Warsaw" }).startOf(
  "day",
);
const at = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return day.plus({ hours: h, minutes: m }).toMillis();
};
const points = {
  NEAR: { id: "NEAR", name: "Przystanek bliski", lat: 50.7707, lon: 16.2807 },
  NEAR2: { id: "NEAR2", name: "Przystanek obok", lat: 50.7709, lon: 16.2809 },
  FAR: { id: "FAR", name: "Przystanek dalszy", lat: 50.7715, lon: 16.2815 },
  C: { id: "C", name: "Boguszów-Gorce Traugutta", lat: 50.81, lon: 16.33 },
};
type StopId = keyof typeof points;

const trip = (id: string, line: string, stops: Array<[StopId, string]>) => {
  const mins = (time: string) => (at(time) - day.toMillis()) / 60_000;
  return {
    raw: {
      rawTripId: id,
      routeId: line,
      routeShort: line,
      serviceId: "S",
      headsign: points[stops.at(-1)![0]].name,
      startMinutes: mins(stops[0][1]),
      endMinutes: mins(stops.at(-1)![1]),
      lastStopName: points[stops.at(-1)![0]].name,
      shapeId: null,
    },
    times: stops.map(([stopId, time], index) => ({
      stopId,
      arrivalMinutes: mins(time),
      departureMinutes: mins(time),
      stopSequence: index + 1,
      pickupType: 0,
      dropOffType: 0,
    })),
  };
};

function store(runs: ReturnType<typeof trip>[]) {
  return {
    base: {
      stops: Object.values(points),
      activeStopIds: new Set(Object.keys(points)),
      rawTrips: runs.map((run) => run.raw),
      rawStopTimesByTrip: new Map(
        runs.map((run) => [run.raw.rawTripId, run.times]),
      ),
      serviceIdsByDate: new Map([[20260616, new Set(["S"])]]),
      routesById: new Map(),
      shapesById: new Map(),
    },
  } as unknown as GtfsMemoryStore;
}

const path = (a: WalkingPoint, b: WalkingPoint) => [
  [a.lat, a.lon],
  [(a.lat + b.lat) / 2, (a.lon + b.lon) / 2],
  [b.lat, b.lon],
];

beforeEach(() => {
  mocks.seeded.mockReset();
  mocks.walk
    .mockReset()
    .mockImplementation(async (a: WalkingPoint, b: WalkingPoint) => {
      const toNear = Math.abs(b.lat - points.NEAR.lat) < 0.0002;
      const toFar = Math.abs(b.lat - points.FAR.lat) < 0.0002;
      const meters = toNear ? 100 : toFar ? 200 : 150;
      return { meters, seconds: Math.ceil(meters / 1.3), path: path(a, b) };
    });
});

const request = (destination = points.C) => ({
  origin: { lat: 50.77, lon: 16.28, label: "Moja lokalizacja" },
  destination: {
    ...destination,
    stopId: destination.id,
    label: destination.name,
  },
  departMs: at("07:44"),
  liveBuses: [],
});

describe("nearest boarding stop preference", () => {
  it("puts the 100 m stop first even when the 200 m stop has an earlier bus", async () => {
    mocks.seeded.mockResolvedValue(
      store([
        trip("near", "2", [
          ["NEAR", "08:20"],
          ["C", "08:50"],
        ]),
        trip("far", "5", [
          ["FAR", "08:05"],
          ["C", "08:40"],
        ]),
      ]),
    );

    const result = await planJourneys(request());
    expect(result.nearestAccess).toMatchObject({ id: "NEAR", meters: 100 });
    expect(result.journeys[0].accessStop).toMatchObject({
      id: "NEAR",
      name: "Przystanek bliski",
    });
    expect(result.journeys[0].accessMeters).toBe(100);

    const fastest = result.journeys.reduce((best, journey) =>
      journey.arriveMs < best.arriveMs ? journey : best,
    );
    expect(fastest.accessMeters).toBe(200);
    expect(fastest.arriveMs).toBeLessThan(result.journeys[0].arriveMs);
    expect(result.note).toBeNull();
  });

  it("explains why a further stop is used when the nearest stop has no service", async () => {
    mocks.seeded.mockResolvedValue(
      store([
        trip("far", "5", [
          ["FAR", "08:05"],
          ["C", "08:40"],
        ]),
      ]),
    );

    const result = await planJourneys(request());
    expect(result.journeys[0].accessStop.id).toBe("FAR");
    expect(result.nearestAccess).toMatchObject({ id: "NEAR", meters: 100 });
    expect(result.note).toContain("Przystanek bliski");
    expect(result.note).toContain("100 m");
    expect(result.note).toContain("Przystanek dalszy");
    expect(result.note).toContain("200 m");
  });

  it("does not warn when the bus leaves from the neighbouring platform 30 m away", async () => {
    mocks.seeded.mockResolvedValue(
      store([
        trip("next-platform", "5", [
          ["NEAR2", "08:05"],
          ["C", "08:40"],
        ]),
      ]),
    );
    mocks.walk.mockImplementation(async (a: WalkingPoint, b: WalkingPoint) => {
      const meters =
        Math.abs(b.lat - points.NEAR.lat) < 0.0001
          ? 100
          : Math.abs(b.lat - points.NEAR2.lat) < 0.0001
            ? 140
            : 200;
      return { meters, seconds: Math.ceil(meters / 1.3), path: path(a, b) };
    });

    const result = await planJourneys(request());
    expect(result.journeys[0].accessStop.id).toBe("NEAR2");
    expect(result.note).toBeNull();
  });

  it("explains an unconfirmed footpath instead of waiting and inventing a shortcut", async () => {
    mocks.seeded.mockResolvedValue(
      store([
        trip("far", "5", [
          ["FAR", "08:05"],
          ["C", "08:40"],
        ]),
      ]),
    );
    mocks.walk.mockResolvedValue(null);

    const result = await planJourneys(request());
    expect(result.journeys).toEqual([]);
    expect(result.nearestAccess).toBeNull();
    expect(result.note).toContain("Nie udało się potwierdzić dojścia pieszego");
    expect(result.note).toContain("nie prowadzimy trasy przez teren");
  });

  it("uses the actually shorter road route, not the straight-line order", async () => {
    mocks.seeded.mockResolvedValue(
      store([
        trip("near", "2", [
          ["NEAR", "08:20"],
          ["C", "08:50"],
        ]),
        trip("far", "5", [
          ["FAR", "08:15"],
          ["C", "08:45"],
        ]),
      ]),
    );
    mocks.walk.mockImplementation(async (a: WalkingPoint, b: WalkingPoint) => {
      const toNear = Math.abs(b.lat - points.NEAR.lat) < 0.0002;
      const toFar = Math.abs(b.lat - points.FAR.lat) < 0.0002;
      // Crow distance would favour NEAR, but the road route is longer.
      const meters = toNear ? 340 : toFar ? 190 : 150;
      return { meters, seconds: Math.ceil(meters / 1.3), path: path(a, b) };
    });

    const result = await planJourneys(request());
    expect(result.nearestAccess).toMatchObject({ id: "FAR", meters: 190 });
    expect(result.journeys[0].accessStop.id).toBe("FAR");
    expect(
      result.journeys.some((journey) => journey.accessStop.id === "NEAR"),
    ).toBe(true);
  });

  it("guarantees a journey from the exact nearest stop when 30 m away a bus leaves sooner", async () => {
    mocks.seeded.mockResolvedValue(
      store([
        trip("nearest", "2", [
          ["NEAR", "08:20"],
          ["C", "08:50"],
        ]),
        trip("next-platform", "5", [
          ["NEAR2", "08:05"],
          ["C", "08:40"],
        ]),
      ]),
    );
    mocks.walk.mockImplementation(async (a: WalkingPoint, b: WalkingPoint) => {
      const meters =
        Math.abs(b.lat - points.NEAR.lat) < 0.0001
          ? 100
          : Math.abs(b.lat - points.NEAR2.lat) < 0.0001
            ? 140
            : 200;
      return { meters, seconds: Math.ceil(meters / 1.3), path: path(a, b) };
    });

    const result = await planJourneys(request());
    expect(result.nearestAccess).toMatchObject({ id: "NEAR", meters: 100 });
    expect(result.journeys[0].accessStop.id).toBe("NEAR");
    expect(
      result.journeys.some((journey) => journey.accessStop.id === "NEAR2"),
    ).toBe(true);
  });

  it("keeps only the closest 50 m access group ahead of farther alternatives", async () => {
    mocks.seeded.mockResolvedValue(
      store([
        trip("near", "2", [
          ["NEAR", "08:20"],
          ["C", "08:50"],
        ]),
        trip("far", "5", [
          ["FAR", "08:05"],
          ["C", "08:40"],
        ]),
      ]),
    );
    const result = await planJourneys(request());
    const nearJourneys = result.journeys.filter(
      (journey) => journey.accessMeters <= 150,
    );
    const farJourneys = result.journeys.filter(
      (journey) => journey.accessMeters > 150,
    );
    expect(nearJourneys.length).toBeGreaterThan(0);
    expect(farJourneys.length).toBeGreaterThan(0);
    expect(
      result.journeys
        .slice(0, nearJourneys.length)
        .every((journey) => journey.accessMeters <= 150),
    ).toBe(true);
  });
});
