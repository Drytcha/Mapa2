// npm run test:route-audit
// Testy automatycznego audytu jakości tras GTFS („Mapa błędów”):
// brak shapes.txt, przystanki > 60 m od trasy, skoki > 120 m, zygzaki i rozbieżność długości.
import assert from "node:assert/strict";
import type { LineEntry, LineVariant } from "../src/lib/engine/lineRoutes";
import {
  auditLineCatalogue,
  auditLineVariant,
  buildAuditMapOverlay,
  exportRouteAuditCsv,
} from "../src/lib/engine/routeQualityAudit";

const sampleLine = {
  shortName: "8",
  color: "#1565c0",
  textColor: "#ffffff",
};

function makeDenseStraightPath(
  startLat: number,
  endLat: number,
  lon: number,
  steps: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    out.push([startLat + (endLat - startLat) * t, lon]);
  }
  return out;
}

function makeVariant(overrides: Partial<LineVariant>): LineVariant {
  const path = makeDenseStraightPath(50.77, 50.785, 16.28, 40); // ~1668 m, krok ~41 m
  return {
    key: "v1",
    directionId: 0,
    headsign: "Sobięcin",
    firstStopId: "s1",
    lastStopId: "s4",
    firstStop: "Szczawienko",
    lastStop: "Sobięcin",
    stopCount: 4,
    tripCount: 40,
    refCount: 25,
    activeOnRef: true,
    lengthMeters: 1668,
    representativeTripId: "t1",
    main: true,
    approximate: false,
    path,
    originalPath: path,
    customized: false,
    customStatus: "none",
    orderedStopCoords: [
      { lat: 50.77, lon: 16.2801, name: "Szczawienko" },
      { lat: 50.775, lon: 16.2801, name: "Piaskowa Góra" },
      { lat: 50.78, lon: 16.2801, name: "Centrum" },
      { lat: 50.785, lon: 16.2801, name: "Sobięcin" },
    ],
    ...overrides,
  };
}

// 1. Poprawna trasa bez błędów
{
  const okAudit = auditLineVariant(sampleLine, makeVariant({}));
  assert.equal(okAudit.severity, "ok", "poprawna trasa ma status OK");
  assert.equal(okAudit.issues.length, 0);
  assert.ok(okAudit.maxStopOffsetMeters < 20);
}

// 2. Brak shapes.txt (trasa orientacyjna)
{
  const missing = auditLineVariant(
    sampleLine,
    makeVariant({
      key: "v_no_shape",
      approximate: true,
      path: [
        [50.77, 16.28],
        [50.775, 16.28],
        [50.78, 16.28],
        [50.785, 16.28],
      ],
    }),
  );
  assert.equal(missing.severity, "error");
  assert.ok(missing.issues.some((i) => i.kind === "missing-shape"));
  assert.equal(
    missing.issues.some((i) => i.kind === "straight-jump"),
    false,
    "nie dubluje ostrzeżeń o skokach gdy brakuje całego shapes.txt",
  );
}

// 3. Przystanek leżący > 60 m od kształtu trasy (ok. 150 m na wschód)
{
  const offRoute = auditLineVariant(
    sampleLine,
    makeVariant({
      key: "v_off_stop",
      orderedStopCoords: [
        { lat: 50.77, lon: 16.28, name: "Szczawienko" },
        { lat: 50.775, lon: 16.2822, name: "Pl. Grunwaldzki" }, // ~155 m od lon=16.28
        { lat: 50.78, lon: 16.28, name: "Centrum" },
        { lat: 50.785, lon: 16.28, name: "Sobięcin" },
      ],
    }),
  );
  assert.equal(offRoute.severity, "error");
  const issue = offRoute.issues.find((i) => i.kind === "stop-off-route");
  assert.ok(issue, "wykryto przystanek > 60 m od trasy");
  assert.ok(offRoute.maxStopOffsetMeters >= 130);
  assert.ok(issue.detail.includes("Pl. Grunwaldzki"), "raport podaje nazwę odstającego przystanku");
  assert.equal(issue.locations.length, 1);
}

// 4. Skok w linii prostej > 120 m (dziura ~330 m przez zabudowę)
{
  const pathWithJump: [number, number][] = [
    ...makeDenseStraightPath(50.77, 50.776, 16.28, 18),
    ...makeDenseStraightPath(50.779, 50.785, 16.28, 18), // luka 0.003 deg ≈ 333 m!
  ];
  const jumpAudit = auditLineVariant(
    sampleLine,
    makeVariant({ key: "v_jump", path: pathWithJump }),
  );
  assert.equal(jumpAudit.severity, "error");
  const jumpIssue = jumpAudit.issues.find((i) => i.kind === "straight-jump");
  assert.ok(jumpIssue, "wykryto skok w linii prostej > 120 m");
  assert.ok(jumpAudit.maxJumpMeters >= 300);
}

// 5. Ostra cofka / zygzak (igła 180° z dala od przystanków)
{
  const basePath = makeDenseStraightPath(50.77, 50.785, 16.28, 40);
  // Wstawiamy nienaturalną igłę w środku trasy (ok. 50.7775, z dala od przystanków 50.775 i 50.780)
  const midIdx = 20;
  const spikePath: [number, number][] = [
    ...basePath.slice(0, midIdx),
    [50.7775, 16.2816], // 110 m w bok
    basePath[midIdx], // natychmiastowy powrót ~180°!
    ...basePath.slice(midIdx + 1),
  ];
  const zigzagAudit = auditLineVariant(
    sampleLine,
    makeVariant({ key: "v_zigzag", path: spikePath }),
  );
  const zigIssue = zigzagAudit.issues.find((i) => i.kind === "sharp-zigzag");
  assert.ok(zigIssue, "wykryto ostrą cofkę / zygzak poza przystankami");
  assert.ok(zigzagAudit.zigzagCount >= 1);
}

// 6. Duża rozbieżność długości kształtu względem ciągu przystanków (np. nieprzycięta pętla 2.5x)
{
  const bloatedPath: [number, number][] = [
    ...makeDenseStraightPath(50.77, 50.785, 16.28, 35),
    ...makeDenseStraightPath(50.785, 50.799, 16.28, 35),
    ...makeDenseStraightPath(50.799, 50.785, 16.2804, 35),
  ];
  const lengthAudit = auditLineVariant(
    sampleLine,
    makeVariant({ key: "v_long", path: bloatedPath }),
  );
  const lenIssue = lengthAudit.issues.find((i) => i.kind === "length-mismatch");
  assert.ok(lenIssue && lenIssue.severity === "error", "wykryto nieproporcjonalnie długi kształt (> 2.1×)");
}

// 7. Zbiorczy audyt katalogu, ranking, nakładka „Mapa błędów” i eksport CSV
{
  const entries: LineEntry[] = [
    {
      shortName: "2",
      longName: "Piaskowa Góra - Sobięcin",
      color: "#0d4f3b",
      textColor: "#ffffff",
      from: 20261101,
      to: 20261231,
      refDate: 20261120,
      refTrips: 50,
      variants: [makeVariant({ key: "ok_2" })],
    },
    {
      shortName: "8",
      longName: "Szczawienko - Sobięcin",
      color: "#1565c0",
      textColor: "#ffffff",
      from: 20261101,
      to: 20261231,
      refDate: 20261120,
      refTrips: 35,
      variants: [
        makeVariant({
          key: "err_8",
          orderedStopCoords: [
            { lat: 50.77, lon: 16.28, name: "Szczawienko" },
            { lat: 50.775, lon: 16.2825, name: "Przystanek Odstający" },
            { lat: 50.78, lon: 16.28, name: "Centrum" },
            { lat: 50.785, lon: 16.28, name: "Sobięcin" },
          ],
        }),
      ],
    },
  ];

  const report = auditLineCatalogue(entries);
  assert.equal(report.totalLines, 2);
  assert.equal(report.totalVariants, 2);
  assert.equal(report.errorVariants, 1);
  assert.equal(report.okVariants, 1);
  assert.equal(report.variants[0].lineShort, "8", "wariant z błędem trafia na pierwsze miejsce rankingu");

  const overlay = buildAuditMapOverlay([report.variants[0]], "Mapa błędów test");
  assert.equal(overlay.polylines.length, 1);
  assert.equal(overlay.stops.length, 1);
  assert.ok(overlay.stops[0].name.includes("Przystanek Odstający"));

  const csv = exportRouteAuditCsv(report);
  assert.ok(csv.startsWith("\uFEFF"), "CSV zawiera UTF-8 BOM");
  assert.ok(csv.includes("Przystanek Odstający"));
  assert.equal(csv.includes("ok_2"), false, "CSV eksportuje tylko podejrzane warianty");
}

console.log(
  "OK: automatyczny audyt jakości tras GTFS (przystanki > 60 m, skoki > 120 m, zygzaki, brak shapes.txt, długość, Mapa błędów, CSV)",
);
