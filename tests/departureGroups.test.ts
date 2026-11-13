import { describe, expect, it } from "vitest";
import { groupDeparturesByLine } from "../src/lib/departureGroups";
import type { StopDepartureItem } from "../src/lib/types";

function departure(
  id: string,
  line: string,
  name: string,
  atMs = 1000,
): StopDepartureItem {
  return {
    tripId: id,
    routeShort: line,
    finalStop: name,
    headsign: name,
    atMs,
    routeColor: "#123456",
    routeTextColor: "#ffffff",
    clock: "11:25",
    dateLabel: "today",
    kursowka: "",
    kursowkaId: "",
    brigadeSource: "none",
    routeLong: "",
    direction: 0,
    minutes: 685,
    isRealtime: false,
    delaySeconds: 0,
    vehicleId: null,
    operatorName: null,
    operatorKey: null,
  };
}

describe("compact departures", () => {
  it("uses g for Gluszyca and keeps other destinations distinct", () => {
    const [group] = groupDeparturesByLine([
      departure("a", "5", "Głuszyca", 3000),
      departure("b", "5", "Kuźnice", 1000),
    ]);
    expect(group.departures.map((d) => d.departure.tripId)).toEqual(["b", "a"]);
    expect(group.directions.find((d) => d.label === "Głuszyca")?.suffix).toBe(
      "g",
    );
    expect(group.directions.find((d) => d.label === "Kuźnice")?.suffix).toBe(
      "k",
    );
  });

  it("assigns stable, non-colliding codes for destinations sharing initials", () => {
    const items = [
      departure("a", "5", "Głuszyca"),
      departure("b", "5", "Głuszyca Górna"),
      departure("c", "5", "Łomnica"),
    ];
    const first = groupDeparturesByLine(items)[0].directions;
    expect(first).toEqual(
      groupDeparturesByLine([...items].reverse())[0].directions,
    );
    expect(new Set(first.map((d) => d.suffix)).size).toBe(3);
    expect(first.find((d) => d.label === "Łomnica")?.suffix).toBe("l");
  });

  it("keeps the whole day's departures and sorts lines numerically", () => {
    const many = Array.from({ length: 620 }, (_, i) =>
      departure(`trip-${i}`, "5", "Głuszyca", i * 1000),
    );
    const groups = groupDeparturesByLine([
      ...many,
      many[0],
      departure("x", "10", "X"),
      departure("y", "2", "Y"),
    ]);
    expect(groups.map((g) => g.line)).toEqual(["2", "5", "10"]);
    expect(groups[1].departures).toHaveLength(620);
    expect(groups[1].directions[0].suffix).toBe("");
  });

  it("does not merge the same trip on different dates", () => {
    expect(
      groupDeparturesByLine([
        departure("a", "5", "A", 1),
        departure("a", "5", "A", 86400001),
      ])[0].departures,
    ).toHaveLength(2);
  });
});
