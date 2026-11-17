import { describe, expect, it } from "vitest";
import {
  buildBridgeRestrictions,
  parseClearanceMeters,
  parseWeightTonnes,
  type OverpassRestrictionElement,
} from "../src/lib/engine/bridgeRestrictions";
import type { LineRouteGeometry } from "../src/lib/engine/gtfsStore";

const geometry: LineRouteGeometry = {
  routeId: "R5",
  routeShort: "5",
  routeName: "Bystrzycka — Głuszyca",
  signature: "R5-test",
  points: [
    [50.77, 16.28],
    [50.773, 16.28],
    [50.776, 16.28],
    [50.779, 16.28],
    [50.782, 16.28],
  ],
  stops: [
    { id: "S1", name: "Dworzec", lat: 50.771, lon: 16.28 },
    { id: "S2", name: "Rynek", lat: 50.778, lon: 16.28 },
    { id: "S3", name: "Głuszyca", lat: 50.785, lon: 16.28 },
  ],
};

const way = (
  id: number,
  tags: Record<string, string>,
  points: Array<[number, number]>,
): OverpassRestrictionElement => ({
  type: "way",
  id,
  tags,
  geometry: points.map(([lat, lon]) => ({ lat, lon })),
});

describe("height and weight limit parsing", () => {
  it("parses metric, decimal comma and feet/inches", () => {
    expect(parseClearanceMeters("3.5")).toBe(3.5);
    expect(parseClearanceMeters("3,5 m")).toBe(3.5);
    expect(parseClearanceMeters("350 cm")).toBe(3.5);
    expect(parseClearanceMeters("12'6\"")).toBe(3.81);
    expect(parseClearanceMeters("default")).toBeNull();
    expect(parseClearanceMeters("unsigned")).toBeNull();
    expect(parseClearanceMeters(null)).toBeNull();
  });

  it("parses tonnes and kilograms, ignoring nonsense", () => {
    expect(parseWeightTonnes("7.5")).toBe(7.5);
    expect(parseWeightTonnes("7500 kg")).toBe(7.5);
    expect(parseWeightTonnes("7,5 t")).toBe(7.5);
    expect(parseWeightTonnes("no")).toBeNull();
  });
});

describe("bridge and underpass classification for a line", () => {
  const elements: OverpassRestrictionElement[] = [
    way(
      1,
      {
        bridge: "yes",
        railway: "rail",
        maxheight: "3.2",
        name: "Wiadukt kolejowy Piaskowa",
      },
      [
        [50.776, 16.2795],
        [50.776, 16.2805],
      ],
    ),
    way(
      2,
      {
        bridge: "yes",
        highway: "secondary",
        maxheight: "4.0 m",
        lanes: "2",
        name: "Most drogowy",
      },
      [
        [50.77, 16.28],
        [50.773, 16.28],
        [50.776, 16.28],
        [50.779, 16.28],
      ],
    ),
    way(3, { bridge: "yes", highway: "footway", name: "Kładka na Rynek" }, [
      [50.778, 16.2795],
      [50.778, 16.2805],
    ]),
    way(4, { tunnel: "yes", highway: "primary", name: "Tunel" }, [
      [50.774, 16.2795],
      [50.774, 16.2805],
    ]),
    way(5, { bridge: "yes", highway: "secondary", maxweight: "7.5" }, [
      [50.79, 16.279],
      [50.79, 16.281],
    ]),
    way(6, { bridge: "yes", highway: "residential", name: "Daleki wiadukt" }, [
      [50.84, 16.279],
      [50.84, 16.281],
    ]),
    {
      type: "node",
      id: 7,
      lat: 50.777,
      lon: 16.28,
      tags: { barrier: "height_restriction", maxheight: "3.4" },
    },
  ];

  const items = buildBridgeRestrictions(elements, geometry);

  it("keeps only objects next to the actual route geometry", () => {
    expect(items.some((item) => item.name === "Daleki wiadukt")).toBe(false);
    expect(
      items.some((item) => item.name === "Wiadukt kolejowy Piaskowa"),
    ).toBe(true);
  });

  it("marks a low railway bridge as a critical crossing with a nearest stop", () => {
    const bridge = items.find((item) => item.id === "way-1")!;
    expect(bridge).toMatchObject({
      kind: "bridge-rail",
      relation: "over-route",
      clearanceM: 3.2,
      severity: "critical",
      nearestStop: "Rynek",
    });
  });

  it("detects a bridge that the bus itself drives over", () => {
    const onRoute = items.find((item) => item.id === "way-2")!;
    expect(onRoute).toMatchObject({ relation: "on-route", clearanceM: 4 });
    expect(onRoute.relationLabel).toContain("po obiekcie");
  });

  it("classifies footbridges and does not raise a false height warning", () => {
    const footbridge = items.find((item) => item.id === "way-3")!;
    expect(footbridge.kind).toBe("footbridge");
    expect(footbridge.clearanceM).toBeNull();
    expect(footbridge.severity).toBe("none");
  });

  it("treats a tunnel under the line as having no impact on the bus", () => {
    const tunnel = items.find((item) => item.id === "way-4")!;
    expect(tunnel).toMatchObject({
      kind: "tunnel",
      relation: "under-route",
      severity: "none",
    });
  });

  it("includes signed height restrictions and weight limits", () => {
    const sign = items.find((item) => item.id === "node-7")!;
    expect(sign.severity).toBe("critical");
    expect(sign.clearanceM).toBe(3.4);
    const weight = items.find((item) => item.id === "way-5");
    expect(weight).toBeUndefined(); // 800 m od trasy — nie dotyczy linii
  });

  it("sorts critical restrictions before informational structures", () => {
    const severities = items.map((item) => item.severity);
    const rank = { critical: 0, warning: 1, info: 2, none: 3 };
    expect(severities).toEqual(
      [...severities].sort((a, b) => rank[a] - rank[b]),
    );
  });
});

import { detectTransitExemption } from "../src/lib/engine/transitExemption";

describe("signs with 'nie dotyczy komunikacji miejskiej / ZDKiUM'", () => {
  it("detects the plate in Polish notes and descriptions", () => {
    for (const note of [
      "Nie dotyczy komunikacji miejskiej",
      "tabliczka: nie dotyczy ZDKiUM",
      "Nie dotyczy autobusów komunikacji miejskiej",
      "z wyjątkiem komunikacji miejskiej",
      "Nie dotyczy pojazdów ZDKiUM i MZUK",
    ]) {
      expect(detectTransitExemption({ maxweight: "7.5", note }).exempt, note).toBe(true);
    }
    expect(
      detectTransitExemption({ maxweight: "7.5", description: "nie dotyczy komunikacji miejskiej" })
        .source,
    ).toBe("osm-note");
  });

  it("detects bus exceptions written as OSM tags", () => {
    expect(detectTransitExemption({ "maxweight:conditional": "none @ (bus)" }).exempt).toBe(true);
    expect(detectTransitExemption({ "maxweight:conditional": "yes @ psv" }).exempt).toBe(true);
    expect(detectTransitExemption({ "maxweight:bus": "none" }).exempt).toBe(true);
    expect(detectTransitExemption({ except: "bus" }).exempt).toBe(true);
  });

  it("does not treat unrelated text or bus bans as an exemption", () => {
    expect(detectTransitExemption({ maxweight: "7.5" }).exempt).toBe(false);
    expect(detectTransitExemption({ note: "Nie dotyczy pojazdów służb" }).exempt).toBe(false);
    expect(detectTransitExemption({ note: "Dotyczy autobusów" }).exempt).toBe(false);
    expect(detectTransitExemption({ "maxweight:conditional": "no @ bus" }).exempt).toBe(false);
    expect(detectTransitExemption({ "maxweight:conditional": "3.5 @ (Mo-Fr)" }).exempt).toBe(false);
  });

  it("lists exempt weight limits as informational, not as a bus restriction", () => {
    const [item] = buildBridgeRestrictions(
      [
        way(
          20,
          {
            bridge: "yes",
            highway: "residential",
            maxweight: "7.5",
            note: "Nie dotyczy komunikacji miejskiej / ZDKiUM",
          },
          [
            [50.774, 16.28],
            [50.775, 16.28],
          ],
        ),
      ],
      geometry,
    );
    expect(item).toMatchObject({
      transitExempt: true,
      transitExemptSource: "osm-note",
      severity: "info",
    });
    expect(item.severityLabel).toContain("Nie dotyczy komunikacji miejskiej");

    const [limited] = buildBridgeRestrictions(
      [way(21, { bridge: "yes", highway: "residential", maxweight: "7.5" }, [[50.774, 16.28], [50.775, 16.28]])],
      geometry,
    );
    expect(limited).toMatchObject({ transitExempt: false, severity: "critical" });
  });

  it("keeps the physical clearance critical even with the plate", () => {
    const [item] = buildBridgeRestrictions(
      [
        way(
          22,
          {
            bridge: "yes",
            railway: "rail",
            "maxheight:physical": "3.1",
            note: "nie dotyczy komunikacji miejskiej",
          },
          [
            [50.776, 16.2795],
            [50.776, 16.2805],
          ],
        ),
      ],
      geometry,
    );
    expect(item.transitExempt).toBe(true);
    expect(item.severity).toBe("critical");
  });

  it("includes conditional-only limits that were previously skipped", () => {
    const items = buildBridgeRestrictions(
      [
        way(23, { highway: "residential", "maxweight:conditional": "none @ (bus)" }, [
          [50.774, 16.28],
          [50.775, 16.28],
        ]),
      ],
      geometry,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ transitExempt: true, severity: "info" });
  });
});
