import { describe, expect, it } from "vitest";
import {
  formatKilometres,
  formatServiceHours,
  isDepotLine,
  isTechnicalLine,
  summariseBrigade,
} from "../src/lib/brigadeMetrics";

const at = (hour: number, minute = 0) =>
  new Date(2026, 5, 16, hour, minute).getTime();

const trip = (
  lineId: string,
  start: [number, number],
  end: [number, number],
  km: number,
) => ({
  lineId,
  startMs: at(start[0], start[1]),
  endMs: at(end[0], end[1]),
  length: km * 1000,
});

describe("brigade metrics", () => {
  it("computes duty duration, driving time and layovers", () => {
    const metrics = summariseBrigade([
      trip("5", [4, 30], [5, 15], 12.5),
      trip("5", [5, 30], [6, 20], 14.2),
      trip("18", [7, 0], [8, 10], 22),
    ]);
    expect(metrics.trips).toBe(3);
    expect(metrics.durationMinutes).toBe(220); // 04:30 → 08:10
    expect(metrics.drivingMinutes).toBe(45 + 50 + 70);
    expect(metrics.layoverMinutes).toBe(55);
  });

  it("splits vehicle-kilometres into revenue and technical kilometres", () => {
    const metrics = summariseBrigade([
      trip("WY", [4, 0], [4, 15], 4.2),
      trip("5", [4, 30], [5, 15], 12.5),
      trip("PRZ", [5, 20], [5, 30], 2.1),
      trip("5", [5, 30], [6, 20], 14.2),
      trip("ZJ", [6, 30], [6, 50], 5.5),
    ]);
    expect(metrics.totalMeters).toBe(38_500);
    expect(metrics.revenueMeters).toBe(26_700);
    expect(metrics.technicalMeters).toBe(11_800);
    expect(metrics.depotMeters).toBe(9_700);
    expect(metrics.transferMeters).toBe(2_100);
    expect(metrics.revenueTrips).toBe(2);
    expect(metrics.technicalTrips).toBe(3);
    expect(metrics.hasTechnicalData).toBe(true);
    expect(metrics.revenueMeters + metrics.technicalMeters).toBe(
      metrics.totalMeters,
    );
  });

  it("is honest when the feed only contains passenger trips", () => {
    const metrics = summariseBrigade([
      trip("5", [4, 30], [5, 15], 12.5),
      trip("18", [5, 30], [6, 20], 14.2),
    ]);
    expect(metrics.hasTechnicalData).toBe(false);
    expect(metrics.technicalMeters).toBe(0);
    expect(metrics.depotMeters).toBe(0);
    expect(metrics.revenueMeters).toBe(metrics.totalMeters);
  });

  it("counts missing lengths instead of pretending they are zero kilometres", () => {
    const metrics = summariseBrigade([
      trip("5", [4, 30], [5, 15], 0),
      trip("5", [5, 30], [6, 0], 10),
    ]);
    expect(metrics.missingLengthTrips).toBe(1);
    expect(metrics.totalMeters).toBe(10_000);
  });

  it("handles an empty duty without NaN", () => {
    expect(summariseBrigade([])).toMatchObject({
      trips: 0,
      durationMinutes: 0,
      totalMeters: 0,
      hasTechnicalData: false,
    });
  });
});

describe("technical line classification", () => {
  it("recognises technical and depot runs case-insensitively", () => {
    for (const line of ["PRZ", "prz", "WY", "ZJ", "TECH", "SERWIS", "DOJAZD"]) {
      expect(isTechnicalLine(line)).toBe(true);
    }
    for (const line of ["5", "18", "A", "EX", "52"]) {
      expect(isTechnicalLine(line)).toBe(false);
    }
    expect(isDepotLine("WY")).toBe(true);
    expect(isDepotLine("ZJ")).toBe(true);
    expect(isDepotLine("PRZ")).toBe(false);
  });
});

describe("formatters", () => {
  it("formats service hours", () => {
    expect(formatServiceHours(0)).toBe("—");
    expect(formatServiceHours(48)).toBe("48 min");
    expect(formatServiceHours(60)).toBe("1 h");
    expect(formatServiceHours(582)).toBe("9 h 42 min");
  });

  it("formats kilometres without fake precision", () => {
    expect(formatKilometres(0)).toBe("0 km");
    expect(formatKilometres(8_450)).toBe("8,5 km");
    expect(formatKilometres(45_250)).toBe("45,3 km");
    expect(formatKilometres(104_600)).toBe("105 km");
    expect(formatKilometres(125_000)).toBe("125 km");
  });
});
