import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/services", () => ({
  WALKING_ROUTING_URL: "https://walking.example/routed-foot",
}));
const from = { lat: 50.77, lon: 16.28 };
const to = { lat: 50.775, lon: 16.285 };
const payload = () => ({
  code: "Ok",
  routes: [
    {
      distance: 500,
      duration: 400,
      geometry: {
        type: "LineString",
        coordinates: [
          [16.28, 50.77],
          [16.282, 50.773],
          [16.285, 50.775],
        ],
      },
    },
  ],
  waypoints: [
    { distance: 3, location: [16.28, 50.77] },
    { distance: 4, location: [16.285, 50.775] },
  ],
});
const fetchMock = vi.fn();
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-16T07:00:00Z"));
  vi.stubGlobal(
    "fetch",
    fetchMock
      .mockReset()
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => payload(),
      }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pedestrian route provider", () => {
  it("uses foot routing, returns the road geometry and caches identical requests", async () => {
    const { getWalkingRoute } = await import("../src/lib/walkingRouter");
    const promise = getWalkingRoute(from, to);
    await vi.runAllTimersAsync();
    const route = await promise;
    expect(fetchMock.mock.calls[0][0]).toContain(
      "/routed-foot/route/v1/foot/16.280000,50.770000;16.285000,50.775000",
    );
    expect(route).toMatchObject({
      meters: 507,
      seconds: 406,
      path: [
        [50.77, 16.28],
        [50.773, 16.282],
        [50.775, 16.285],
      ],
    });
    expect(await getWalkingRoute(from, to)).toEqual(route);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rejects snapping a location in a field onto a distant road", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ...payload(),
        waypoints: [{ distance: 260 }, { distance: 0 }],
      }),
    });
    const { getWalkingRoute } = await import("../src/lib/walkingRouter");
    const promise = getWalkingRoute(from, to);
    await vi.runAllTimersAsync();
    expect(await promise).toBeNull();
  });
  it("returns no route, not a straight line, when the foot graph is disconnected", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: "NoRoute" }),
    });
    const { getWalkingRoute } = await import("../src/lib/walkingRouter");
    const promise = getWalkingRoute(from, to);
    await vi.runAllTimersAsync();
    expect(await promise).toBeNull();
  });
  it("spaces different network requests at least 1.1 seconds apart", async () => {
    const started: number[] = [];
    fetchMock.mockImplementation(async () => {
      started.push(Date.now());
      return { ok: true, status: 200, json: async () => payload() };
    });
    const { getWalkingRoute } = await import("../src/lib/walkingRouter");
    const a = getWalkingRoute(from, to);
    const b = getWalkingRoute(to, from);
    await vi.runAllTimersAsync();
    await Promise.all([a, b]);
    expect(started[1] - started[0]).toBeGreaterThanOrEqual(1100);
  });
});
