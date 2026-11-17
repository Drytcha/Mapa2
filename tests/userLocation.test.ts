import { describe, expect, it } from "vitest";
import {
  bearingDegrees,
  compassLabel,
  deriveMotion,
  distanceMeters,
  type MotionState,
  type RawFix,
} from "../src/lib/useUserLocation";

const base: RawFix = {
  lat: 50.77,
  lon: 16.28,
  accuracy: 8,
  altitude: null,
  speedMs: null,
  heading: null,
  timestamp: 1_000_000,
};

function state(fix: RawFix, extra: Partial<MotionState> = {}): MotionState {
  return {
    lat: fix.lat,
    lon: fix.lon,
    accuracy: fix.accuracy,
    timestamp: fix.timestamp,
    speedKmh: null,
    heading: null,
    maxSpeedKmh: 0,
    distanceM: 0,
    ...extra,
  };
}

describe("user location motion", () => {
  it("measures distance and bearing", () => {
    const north = { lat: base.lat + 0.001, lon: base.lon };
    expect(Math.round(distanceMeters(base, north))).toBe(111);
    expect(Math.round(bearingDegrees(base, north))).toBe(0);
    expect(Math.round(bearingDegrees(base, { lat: base.lat, lon: base.lon + 0.001 }))).toBe(90);
    expect(compassLabel(0)).toBe("N");
    expect(compassLabel(46)).toBe("NE");
    expect(compassLabel(359)).toBe("N");
    expect(compassLabel(200)).toBe("S");
  });

  it("uses the sensor speed and heading when the device provides them", () => {
    const result = deriveMotion(state(base), {
      ...base,
      lat: base.lat + 0.0002,
      timestamp: base.timestamp + 2000,
      speedMs: 10,
      heading: 90,
    });
    expect(result.speedKmh).toBeCloseTo(36);
    expect(result.speedSource).toBe("gps");
    expect(result.heading).toBe(90);
  });

  it("derives speed and heading from movement when the sensor has none", () => {
    const next: RawFix = { ...base, lat: base.lat + 0.0003, timestamp: base.timestamp + 3000 };
    const result = deriveMotion(state(base), next);
    expect(result.speedSource).toBe("derived");
    expect(result.speedKmh).toBeGreaterThan(38);
    expect(result.speedKmh).toBeLessThan(42);
    expect(Math.round(result.heading ?? -1)).toBe(0);
    expect(result.distanceM).toBeGreaterThan(30);
    expect(result.maxSpeedKmh).toBe(result.speedKmh);
  });

  it("treats GPS jitter as standing still and does not add distance", () => {
    const jitter: RawFix = { ...base, lat: base.lat + 0.00003, timestamp: base.timestamp + 2000 };
    const result = deriveMotion(state(base, { speedKmh: 5, heading: 40 }), jitter);
    expect(result.speedKmh).toBe(0);
    expect(result.heading).toBeNull();
    expect(result.distanceM).toBe(0);
  });

  it("does not guess speed from the first fix or after a long signal gap", () => {
    expect(deriveMotion(null, base).speedKmh).toBeNull();
    const late: RawFix = { ...base, lat: base.lat + 0.01, timestamp: base.timestamp + 300_000 };
    const result = deriveMotion(state(base), late);
    expect(result.speedKmh).toBeNull();
    expect(result.distanceM).toBe(0);
  });

  it("rejects implausible jumps and keeps the maximum speed", () => {
    const jump: RawFix = { ...base, lat: base.lat + 0.05, timestamp: base.timestamp + 2000 };
    const result = deriveMotion(state(base, { maxSpeedKmh: 42 }), jump);
    expect(result.speedKmh).toBeNull();
    expect(result.maxSpeedKmh).toBe(42);
    expect(result.distanceM).toBe(0);
  });
});
