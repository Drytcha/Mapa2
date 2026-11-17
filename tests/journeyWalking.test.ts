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
import {
  planJourneys,
  journeyToMapGeometry,
  type JourneyBusLeg,
} from "../src/lib/journeyPlanner";

const day = DateTime.fromISO("2026-06-16", { zone: "Europe/Warsaw" }).startOf(
  "day",
);
const at = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return day.plus({ hours: h, minutes: m }).toMillis();
};
const points = {
  A: { id: "A", name: "Andersa Ludowa", lat: 50.77, lon: 16.28 },
  B: { id: "B", name: "Barbusse'a końcowy", lat: 50.79, lon: 16.3 },
  B2: { id: "B2", name: "Barbusse'a drugi słupek", lat: 50.7905, lon: 16.3 },
  C: { id: "C", name: "Boguszów-Gorce Traugutta", lat: 50.81, lon: 16.33 },
  K: { id: "K", name: "Kuźnice", lat: 50.76, lon: 16.35 },
};
type StopId = keyof typeof points;
const trip = (id: string, line: string, stops: Array<[StopId, string]>) => {
  const min = (time: string) => (at(time) - day.toMillis()) / 60000;
  return {
    raw: {
      rawTripId: id,
      routeId: line,
      routeShort: line,
      serviceId: "S",
      headsign: points[stops.at(-1)![0]].name,
      startMinutes: min(stops[0][1]),
      endMinutes: min(stops.at(-1)![1]),
      lastStopName: points[stops.at(-1)![0]].name,
      shapeId: null,
    },
    times: stops.map(([id, time], i) => ({
      stopId: id,
      arrivalMinutes: min(time),
      departureMinutes: min(time),
      stopSequence: i + 1,
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
      rawTrips: runs.map((r) => r.raw),
      rawStopTimesByTrip: new Map(runs.map((r) => [r.raw.rawTripId, r.times])),
      serviceIdsByDate: new Map([[20260616, new Set(["S"])]]),
      routesById: new Map(),
      shapesById: new Map(),
    },
  } as unknown as GtfsMemoryStore;
}
const point = (id: StopId) => ({
  ...points[id],
  stopId: id,
  label: points[id].name,
});
const path = (a: WalkingPoint, b: WalkingPoint) => [
  [a.lat, a.lon],
  [a.lat + 0.0001, a.lon + 0.001],
  [b.lat, b.lon],
];
const request = () => ({
  origin: point("A"),
  destination: point("C"),
  departMs: at("07:44"),
  liveBuses: [],
});

beforeEach(() => {
  mocks.seeded.mockReset();
  mocks.walk
    .mockReset()
    .mockImplementation(async (a: WalkingPoint, b: WalkingPoint) => ({
      meters: 280,
      seconds: 240,
      path: path(a, b),
    }));
});

describe("walking-aware timetable search", () => {
  it("misses the 08:41 transfer when the road crossing takes four minutes, selects 08:45", async () => {
    mocks.seeded.mockResolvedValue(
      store([
        trip("first", "2", [
          ["A", "08:18"],
          ["B", "08:37"],
        ]),
        trip("too-soon", "5", [
          ["B2", "08:41"],
          ["C", "08:58"],
        ]),
        trip("reachable", "5", [
          ["B2", "08:45"],
          ["C", "09:02"],
        ]),
        trip("wrong-destination", "9", [
          ["B", "08:40"],
          ["K", "08:55"],
        ]),
      ]),
    );
    const result = await planJourneys(request());
    expect(result.journeys.length).toBeGreaterThan(0);
    const first = result.journeys[0];
    const buses = first.legs.filter(
      (l): l is JourneyBusLeg => l.kind === "bus",
    );
    expect(buses.map((l) => l.tripId)).toEqual(["first", "reachable"]);
    const walk = first.legs.find(
      (l) => l.kind === "walk" && l.role === "transfer",
    )!;
    expect(walk).toMatchObject({
      seconds: 240,
      meters: 280,
      arriveMs: at("08:41"),
    });
    expect(
      journeyToMapGeometry(first).legs.find((l) => l.kind === "walk")?.path,
    ).toHaveLength(3);
  });

  it("re-searches for a later first bus when the road approach takes longer", async () => {
    mocks.seeded.mockResolvedValue(
      store([
        trip("missed", "2", [
          ["A", "08:00"],
          ["C", "08:30"],
        ]),
        trip("later", "2", [
          ["A", "08:20"],
          ["C", "08:50"],
        ]),
      ]),
    );
    mocks.walk.mockImplementation(async (a: WalkingPoint, b: WalkingPoint) => ({
      meters: 850,
      seconds: 720,
      path: path(a, b),
    }));
    const result = await planJourneys({
      ...request(),
      origin: { ...point("A"), lat: 50.7701 },
      departMs: at("07:50"),
    });
    const firstBus = result.journeys[0]?.legs.find((l) => l.kind === "bus");
    expect(firstBus).toMatchObject({ tripId: "later" });
    expect(result.journeys[0].departMs).toBe(at("08:07") + 30000);
    expect(result.journeys[0].legs[0]).toMatchObject({
      meters: 850,
      seconds: 720,
    });
  });

  it("does not display an unreachable crossing or a straight-line substitute", async () => {
    mocks.seeded.mockResolvedValue(
      store([
        trip("first", "2", [
          ["A", "08:18"],
          ["B", "08:37"],
        ]),
        trip("connection", "5", [
          ["B2", "08:45"],
          ["C", "09:02"],
        ]),
      ]),
    );
    mocks.walk.mockResolvedValue(null);
    expect((await planJourneys(request())).journeys).toEqual([]);
  });

  it("reports router errors instead of inventing pedestrian distances", async () => {
    mocks.seeded.mockResolvedValue(
      store([
        trip("first", "2", [
          ["A", "08:18"],
          ["C", "08:37"],
        ]),
      ]),
    );
    mocks.walk.mockRejectedValue(new Error("Walking service unavailable"));
    await expect(
      planJourneys({ ...request(), origin: { ...point("A"), lat: 50.7701 } }),
    ).rejects.toThrow("Walking service unavailable");
  });

  it("honors cancellation before accessing the timetable or routing service", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      planJourneys({ ...request(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.seeded).not.toHaveBeenCalled();
    expect(mocks.walk).not.toHaveBeenCalled();
  });

  it("never treats nearby Kuznice as an explicitly selected Traugutta stop", async () => {
    mocks.seeded.mockResolvedValue(
      store([
        trip("wrong", "9", [
          ["A", "08:18"],
          ["K", "08:37"],
        ]),
      ]),
    );
    expect((await planJourneys(request())).journeys).toEqual([]);
  });
});
