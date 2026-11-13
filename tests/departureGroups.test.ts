import { describe, expect, it } from "vitest";
import { groupDeparturesByLine } from "../src/lib/departureGroups";
import type { StopDepartureItem } from "../src/lib/types";

function departure(id: string, line: string, name: string, atMs = 1000): StopDepartureItem {
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

const suffixOf = (group: ReturnType<typeof groupDeparturesByLine>[number], label: string) =>
  group.directions.find((d) => d.label === label)?.suffix;

describe("compact departures", () => {
  it("leaves the dominant direction unmarked and letters only deviations", () => {
    const items = [
      ...Array.from({ length: 12 }, (_, i) => departure(`b${i}`, "5", "Bystrzycka końcowy", i * 1000)),
      departure("g1", "5", "Głuszyca", 500),
      departure("g2", "5", "Głuszyca", 7500),
      departure("j1", "5", "Jedlina-Zdrój", 9500),
    ];
    const [group] = groupDeparturesByLine(items);
    expect(suffixOf(group, "Bystrzycka końcowy")).toBe("");
    expect(group.directions[0]).toMatchObject({ label: "Bystrzycka końcowy", main: true });
    expect(suffixOf(group, "Głuszyca")).toBe("g");
    expect(suffixOf(group, "Jedlina-Zdrój")).toBe("j");
    const glu = group.departures.find((d) => d.departure.tripId === "g1")!;
    expect(glu.direction.suffix).toBe("g");
    const main = group.departures.find((d) => d.departure.tripId === "b3")!;
    expect(main.direction.suffix).toBe("");
  });

  it("letters every direction when none dominates (tie)", () => {
    const [group] = groupDeparturesByLine([
      departure("a", "5", "Głuszyca", 3000),
      departure("b", "5", "Kuźnice", 1000),
    ]);
    expect(group.departures.map((d) => d.departure.tripId)).toEqual(["b", "a"]);
    expect(suffixOf(group, "Głuszyca")).toBe("g");
    expect(suffixOf(group, "Kuźnice")).toBe("k");
    expect(group.directions.every((d) => !d.main)).toBe(true);
  });

  it("assigns stable, non-colliding codes for deviations sharing initials", () => {
    const items = [
      departure("m1", "5", "Bystrzycka"),
      departure("m2", "5", "Bystrzycka", 2),
      departure("m3", "5", "Bystrzycka", 3),
      departure("a", "5", "Głuszyca"),
      departure("b", "5", "Głuszyca Górna"),
      departure("c", "5", "Łomnica"),
    ];
    const first = groupDeparturesByLine(items)[0].directions;
    expect(first).toEqual(groupDeparturesByLine([...items].reverse())[0].directions);
    const deviations = first.filter((d) => !d.main);
    expect(new Set(deviations.map((d) => d.suffix)).size).toBe(3);
    expect(deviations.find((d) => d.label === "Łomnica")?.suffix).toBe("l");
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
    expect(groups[1].directions[0]).toMatchObject({ suffix: "", main: true });
  });

  it("does not merge the same trip on different dates", () => {
    expect(
      groupDeparturesByLine([departure("a", "5", "A", 1), departure("a", "5", "A", 86400001)])[0]
        .departures,
    ).toHaveLength(2);
  });
});
