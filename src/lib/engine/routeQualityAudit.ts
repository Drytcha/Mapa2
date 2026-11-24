/**
 * Automatyczny audyt jakości przebiegów tras GTFS („Mapa błędów”).
 *
 * Skanuje wszystkie linie i warianty w katalogu i wykrywa typowe błędy geometrii:
 *  1. `missing-shape`   — brak shapes.txt (trasa rysowana po prostych między przystankami)
 *  2. `stop-off-route`  — przystanki oddalone > 60 m od kształtu trasy
 *  3. `straight-jump`   — długie skoki w linii prostej > 120 m (np. dziury przez zabudowę)
 *  4. `sharp-zigzag`    — ostre cofki / zygzaki / „igły” >= 155° poza pętlami i przystankami
 *  5. `length-mismatch` — duża rozbieżność długości trasy względem łańcucha przystanków
 */

import {
  distanceCoords,
  pointToSegmentMeters,
  polylineLengthMeters,
} from "../core/spatial";
import { compareLineCodes } from "../core/text";
import {
  getLineCatalogue,
  type LineEntry,
  type LineVariant,
} from "./lineRoutes";

export type RouteAuditIssueKind =
  | "missing-shape"
  | "stop-off-route"
  | "straight-jump"
  | "sharp-zigzag"
  | "length-mismatch";

export type RouteAuditSeverity = "error" | "warning" | "ok";

export interface RouteAuditLocation {
  lat: number;
  lon: number;
  label: string;
}

export interface RouteQualityIssue {
  kind: RouteAuditIssueKind;
  severity: Exclude<RouteAuditSeverity, "ok">;
  title: string;
  detail: string;
  /** Główny wskaźnik liczbowy (np. maks. odległość w m lub stosunek długości). */
  metricValue: number;
  /** Punkty na mapie wskazujące problematyczne miejsca (przystanki / skoki / igły). */
  locations: RouteAuditLocation[];
}

export interface VariantQualityAudit {
  lineShort: string;
  lineColor: string;
  lineTextColor: string;
  variantKey: string;
  directionId: number;
  headsign: string;
  firstStop: string;
  lastStop: string;
  stopCount: number;
  refCount: number;
  tripCount: number;
  main: boolean;
  approximate: boolean;
  customized: boolean;
  customScope?: "variant" | "direction";
  shapeLengthMeters: number;
  stopChainLengthMeters: number;
  lengthRatio: number | null;
  maxStopOffsetMeters: number;
  offRouteStopCount: number;
  maxJumpMeters: number;
  jumpCount: number;
  zigzagCount: number;
  severity: RouteAuditSeverity;
  priorityScore: number;
  issues: RouteQualityIssue[];
  path: [number, number][];
}

export interface LineQualitySummary {
  lineShort: string;
  color: string;
  textColor: string;
  totalVariants: number;
  errorVariants: number;
  warningVariants: number;
  okVariants: number;
  customizedVariants: number;
  worstSeverity: RouteAuditSeverity;
  topPriorityScore: number;
}

export interface RouteAuditThresholds {
  stopOffsetWarnMeters: number;
  stopOffsetErrorMeters: number;
  jumpWarnMeters: number;
  jumpErrorMeters: number;
  zigzagMinAngleDeg: number;
  zigzagMinArmMeters: number;
  lengthRatioHighWarn: number;
  lengthRatioHighError: number;
  lengthRatioLowError: number;
}

export const DEFAULT_ROUTE_AUDIT_THRESHOLDS: Readonly<RouteAuditThresholds> = {
  stopOffsetWarnMeters: 60,
  stopOffsetErrorMeters: 120,
  jumpWarnMeters: 120,
  jumpErrorMeters: 250,
  zigzagMinAngleDeg: 155,
  zigzagMinArmMeters: 30,
  lengthRatioHighWarn: 1.75,
  lengthRatioHighError: 2.1,
  lengthRatioLowError: 0.78,
};

export interface RouteQualityAuditReport {
  auditedAt: number;
  thresholds: RouteAuditThresholds;
  totalLines: number;
  totalVariants: number;
  errorVariants: number;
  warningVariants: number;
  okVariants: number;
  customizedVariants: number;
  byKindCount: Record<RouteAuditIssueKind, number>;
  lines: LineQualitySummary[];
  variants: VariantQualityAudit[];
}

export function issueKindLabel(kind: RouteAuditIssueKind): string {
  switch (kind) {
    case "missing-shape":
      return "Brak shapes.txt";
    case "stop-off-route":
      return "Przystanki > 60 m";
    case "straight-jump":
      return "Skoki > 120 m";
    case "sharp-zigzag":
      return "Ostre zygzaki";
    case "length-mismatch":
      return "Rozbieżność długości";
  }
}

function minDistanceStopToPath(
  stop: { lat: number; lon: number },
  path: readonly [number, number][],
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    const { distance } = pointToSegmentMeters(
      stop.lat,
      stop.lon,
      a[0],
      a[1],
      b[0],
      b[1],
    );
    if (distance < best) best = distance;
  }
  return Number.isFinite(best) ? best : 0;
}

function nearAnyStop(
  point: readonly [number, number],
  stops: ReadonlyArray<{ lat: number; lon: number }>,
  radiusM: number,
): boolean {
  for (const s of stops) {
    if (distanceCoords(point[0], point[1], s.lat, s.lon) <= radiusM) return true;
  }
  return false;
}

/**
 * Audyt pojedynczego wariantu linii względem jego przystanków i kształtu.
 */
export function auditLineVariant(
  line: Pick<LineEntry, "shortName" | "color" | "textColor">,
  variant: LineVariant,
  thresholds: RouteAuditThresholds = DEFAULT_ROUTE_AUDIT_THRESHOLDS,
): VariantQualityAudit {
  const issues: RouteQualityIssue[] = [];
  const path = variant.path;
  const stops = variant.orderedStopCoords ?? [];

  const shapeLengthMeters = Math.round(polylineLengthMeters(path));
  const stopCoordsOnly: [number, number][] = stops.map((s) => [s.lat, s.lon]);
  const stopChainLengthMeters = Math.round(polylineLengthMeters(stopCoordsOnly));
  const lengthRatio =
    stopChainLengthMeters >= 200 ? shapeLengthMeters / stopChainLengthMeters : null;

  // 1. Brak shapes.txt (orientacyjna łamana po przystankach)
  if (variant.approximate) {
    const mid = path[Math.floor(path.length / 2)] ?? path[0];
    issues.push({
      kind: "missing-shape",
      severity: "error",
      title: "Brak kształtu w shapes.txt",
      detail:
        "Wariant nie ma oficjalnego przebiegu po ulicach — rysowany jest łamaną prosto między przystankami.",
      metricValue: path.length,
      locations: mid
        ? [{ lat: mid[0], lon: mid[1], label: `Linia ${line.shortName}: brak shapes.txt` }]
        : [],
    });
  }

  // 2. Przystanki oddalone > 60 m od trasy
  let maxStopOffsetMeters = 0;
  const offRouteStops: Array<{
    name: string;
    meters: number;
    lat: number;
    lon: number;
  }> = [];

  if (path.length >= 2 && stops.length >= 2) {
    for (let i = 0; i < stops.length; i += 1) {
      const stop = stops[i];
      const dist = minDistanceStopToPath(stop, path);
      if (dist > maxStopOffsetMeters) maxStopOffsetMeters = dist;
      if (dist > thresholds.stopOffsetWarnMeters) {
        offRouteStops.push({
          name: stop.name || `Przystanek #${i + 1}`,
          meters: Math.round(dist),
          lat: stop.lat,
          lon: stop.lon,
        });
      }
    }
  }

  if (offRouteStops.length > 0) {
    offRouteStops.sort((a, b) => b.meters - a.meters);
    const worst = offRouteStops[0];
    const severity =
      worst.meters >= thresholds.stopOffsetErrorMeters || offRouteStops.length >= 3
        ? "error"
        : "warning";
    const sampleNames = offRouteStops
      .slice(0, 3)
      .map((s) => `„${s.name}” (${s.meters} m)`)
      .join(", ");
    const extra =
      offRouteStops.length > 3 ? ` i ${offRouteStops.length - 3} kolejne` : "";
    issues.push({
      kind: "stop-off-route",
      severity,
      title:
        offRouteStops.length === 1
          ? `1 przystanek leży ${worst.meters} m od trasy`
          : `${offRouteStops.length} przystanki > ${thresholds.stopOffsetWarnMeters} m od trasy (maks. ${worst.meters} m)`,
      detail: `${sampleNames}${extra}`,
      metricValue: worst.meters,
      locations: offRouteStops.slice(0, 8).map((s) => ({
        lat: s.lat,
        lon: s.lon,
        label: `⚠ Linia ${line.shortName}: przystanek „${s.name}” (${s.meters} m od trasy)`,
      })),
    });
  }

  // 3. Ostre skoki / długie odcinki w linii prostej > 120 m (pomijamy przy braku shapes.txt)
  let maxJumpMeters = 0;
  const jumps: Array<{ meters: number; lat: number; lon: number }> = [];
  if (!variant.approximate && path.length >= 2) {
    for (let i = 0; i < path.length - 1; i += 1) {
      const a = path[i];
      const b = path[i + 1];
      const segM = distanceCoords(a[0], a[1], b[0], b[1]);
      if (segM > maxJumpMeters) maxJumpMeters = segM;
      if (segM > thresholds.jumpWarnMeters) {
        jumps.push({
          meters: Math.round(segM),
          lat: (a[0] + b[0]) / 2,
          lon: (a[1] + b[1]) / 2,
        });
      }
    }
  }

  if (jumps.length > 0) {
    jumps.sort((a, b) => b.meters - a.meters);
    const worstJump = jumps[0];
    const severity =
      worstJump.meters >= thresholds.jumpErrorMeters || jumps.length >= 3
        ? "error"
        : "warning";
    issues.push({
      kind: "straight-jump",
      severity,
      title:
        jumps.length === 1
          ? `Skok w linii prostej (${worstJump.meters} m)`
          : `${jumps.length} odcinki w linii prostej > ${thresholds.jumpWarnMeters} m (maks. ${worstJump.meters} m)`,
      detail:
        worstJump.meters >= thresholds.jumpErrorMeters
          ? "Prawdopodobna dziura w kształcie trasy przecinająca zabudowę."
          : "Długi prosty odcinek bez wierzchołków pośrednich — warto zweryfikować na mapie.",
      metricValue: worstJump.meters,
      locations: jumps.slice(0, 6).map((j) => ({
        lat: j.lat,
        lon: j.lon,
        label: `⚠ Linia ${line.shortName}: skok w linii prostej ${j.meters} m`,
      })),
    });
  }

  // 4. Ostre cofki / zygzaki / „igły” >= 155° (poza pętlami krańcowymi i przystankami)
  const zigzags: Array<{ angleDeg: number; armM: number; lat: number; lon: number }> = [];
  if (!variant.approximate && path.length >= 3) {
    const firstStop = stops[0];
    const lastStop = stops[stops.length - 1];
    for (let i = 1; i < path.length - 1; i += 1) {
      const p0 = path[i - 1];
      const p1 = path[i];
      const p2 = path[i + 1];
      const cosLat = Math.cos((p1[0] * Math.PI) / 180);
      const ux = (p1[1] - p0[1]) * 111_320 * cosLat;
      const uy = (p1[0] - p0[0]) * 111_320;
      const vx = (p2[1] - p1[1]) * 111_320 * cosLat;
      const vy = (p2[0] - p1[0]) * 111_320;
      const lu = Math.hypot(ux, uy);
      const lv = Math.hypot(vx, vy);
      if (lu < thresholds.zigzagMinArmMeters || lv < thresholds.zigzagMinArmMeters) {
        continue;
      }
      const cosTheta = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
      const turnDeg = (Math.acos(cosTheta) * 180) / Math.PI;
      if (turnDeg < thresholds.zigzagMinAngleDeg) continue;

      // Wykluczamy naturalne zawrotki przy pętlach początkowej/końcowej oraz przy przystankach kieszeniowych.
      if (
        firstStop &&
        distanceCoords(p1[0], p1[1], firstStop.lat, firstStop.lon) <= 120
      ) {
        continue;
      }
      if (
        lastStop &&
        distanceCoords(p1[0], p1[1], lastStop.lat, lastStop.lon) <= 120
      ) {
        continue;
      }
      if (nearAnyStop(p1, stops, 45)) continue;

      zigzags.push({
        angleDeg: Math.round(turnDeg),
        armM: Math.round(Math.min(lu, lv)),
        lat: p1[0],
        lon: p1[1],
      });
    }
  }

  if (zigzags.length > 0) {
    zigzags.sort((a, b) => b.armM - a.armM || b.angleDeg - a.angleDeg);
    const worst = zigzags[0];
    const severity =
      worst.armM >= 100 || zigzags.length >= 2 ? "error" : "warning";
    issues.push({
      kind: "sharp-zigzag",
      severity,
      title:
        zigzags.length === 1
          ? `Ostra cofka / zygzak (${worst.angleDeg}°, ramię ${worst.armM} m)`
          : `${zigzags.length} ostre cofki / zygzaki w trasie (maks. ${worst.armM} m)`,
      detail:
        "Trasa gwałtownie zawraca poza pętlą i przystankami — typowy błąd kolejności punktów w shapes.txt.",
      metricValue: worst.armM,
      locations: zigzags.slice(0, 6).map((z) => ({
        lat: z.lat,
        lon: z.lon,
        label: `⚠ Linia ${line.shortName}: zygzak ${z.angleDeg}° (${z.armM} m)`,
      })),
    });
  }

  // 5. Duża rozbieżność długości kształtu względem łańcucha przystanków
  if (
    !variant.approximate &&
    stops.length >= 3 &&
    stopChainLengthMeters >= 400 &&
    lengthRatio !== null
  ) {
    const diffM = shapeLengthMeters - stopChainLengthMeters;
    if (lengthRatio >= thresholds.lengthRatioHighWarn && diffM >= 1_200) {
      const severity =
        lengthRatio >= thresholds.lengthRatioHighError ? "error" : "warning";
      const mid = path[Math.floor(path.length / 2)] ?? path[0];
      issues.push({
        kind: "length-mismatch",
        severity,
        title: `Trasa ${lengthRatio.toFixed(2).replace(".", ",")}× dłuższa od ciągu przystanków`,
        detail: `Kształt: ${(shapeLengthMeters / 1000).toFixed(2).replace(".", ",")} km vs przystanki: ${(stopChainLengthMeters / 1000).toFixed(2).replace(".", ",")} km (+${(diffM / 1000).toFixed(2).replace(".", ",")} km — możliwy błędny objazd lub nieprzycięta pętla).`,
        metricValue: Math.round(lengthRatio * 100),
        locations: mid
          ? [
              {
                lat: mid[0],
                lon: mid[1],
                label: `⚠ Linia ${line.shortName}: trasa ${lengthRatio.toFixed(2)}× dłuższa niż przystanki`,
              },
            ]
          : [],
      });
    } else if (lengthRatio <= thresholds.lengthRatioLowError && -diffM >= 600) {
      const tail = path[path.length - 1] ?? path[0];
      issues.push({
        kind: "length-mismatch",
        severity: "error",
        title: `Trasa znacznie krótsza od przystanków (${Math.round(lengthRatio * 100)}%)`,
        detail: `Kształt: ${(shapeLengthMeters / 1000).toFixed(2).replace(".", ",")} km vs przystanki: ${(stopChainLengthMeters / 1000).toFixed(2).replace(".", ",")} km — prawdopodobnie ucięty przebieg.`,
        metricValue: Math.round(lengthRatio * 100),
        locations: tail
          ? [
              {
                lat: tail[0],
                lon: tail[1],
                label: `⚠ Linia ${line.shortName}: ucięty przebieg (${Math.round(lengthRatio * 100)}%)`,
              },
            ]
          : [],
      });
    }
  }

  const hasError = issues.some((i) => i.severity === "error");
  const hasWarning = issues.some((i) => i.severity === "warning");
  const severity: RouteAuditSeverity = hasError
    ? "error"
    : hasWarning
      ? "warning"
      : "ok";

  // Priorytet: błędy krytyczne na głównych, częstych wariantach idą na samą górę listy.
  let priorityScore = 0;
  for (const issue of issues) {
    priorityScore += issue.severity === "error" ? 40 : 15;
  }
  if (priorityScore > 0) {
    if (variant.main) priorityScore += 12;
    priorityScore += Math.min(20, Math.round(variant.refCount / 2));
    priorityScore += Math.min(25, Math.round(maxStopOffsetMeters / 15));
    priorityScore += Math.min(20, Math.round(maxJumpMeters / 40));
  }

  return {
    lineShort: line.shortName,
    lineColor: line.color,
    lineTextColor: line.textColor,
    variantKey: variant.key,
    directionId: variant.directionId,
    headsign: variant.headsign,
    firstStop: variant.firstStop,
    lastStop: variant.lastStop,
    stopCount: variant.stopCount,
    refCount: variant.refCount,
    tripCount: variant.tripCount,
    main: variant.main,
    approximate: variant.approximate,
    customized: variant.customized,
    customScope: variant.customScope,
    shapeLengthMeters,
    stopChainLengthMeters,
    lengthRatio,
    maxStopOffsetMeters: Math.round(maxStopOffsetMeters),
    offRouteStopCount: offRouteStops.length,
    maxJumpMeters: Math.round(maxJumpMeters),
    jumpCount: jumps.length,
    zigzagCount: zigzags.length,
    severity,
    priorityScore,
    issues,
    path,
  };
}

/**
 * Skanuje cały katalog linii i buduje pełny raport audytu jakości tras.
 */
export function auditLineCatalogue(
  entries: readonly LineEntry[],
  thresholds: RouteAuditThresholds = DEFAULT_ROUTE_AUDIT_THRESHOLDS,
): RouteQualityAuditReport {
  const byKindCount: Record<RouteAuditIssueKind, number> = {
    "missing-shape": 0,
    "stop-off-route": 0,
    "straight-jump": 0,
    "sharp-zigzag": 0,
    "length-mismatch": 0,
  };

  const allVariants: VariantQualityAudit[] = [];
  const lineSummaries: LineQualitySummary[] = [];

  for (const entry of entries) {
    let errorVariants = 0;
    let warningVariants = 0;
    let okVariants = 0;
    let customizedVariants = 0;
    let topPriorityScore = 0;

    for (const variant of entry.variants) {
      const audited = auditLineVariant(entry, variant, thresholds);
      allVariants.push(audited);
      if (audited.customized) customizedVariants += 1;
      if (audited.severity === "error") errorVariants += 1;
      else if (audited.severity === "warning") warningVariants += 1;
      else okVariants += 1;
      if (audited.priorityScore > topPriorityScore) {
        topPriorityScore = audited.priorityScore;
      }
      for (const issue of audited.issues) {
        byKindCount[issue.kind] += 1;
      }
    }

    lineSummaries.push({
      lineShort: entry.shortName,
      color: entry.color,
      textColor: entry.textColor,
      totalVariants: entry.variants.length,
      errorVariants,
      warningVariants,
      okVariants,
      customizedVariants,
      worstSeverity:
        errorVariants > 0 ? "error" : warningVariants > 0 ? "warning" : "ok",
      topPriorityScore,
    });
  }

  const severityRank = (s: RouteAuditSeverity) =>
    s === "error" ? 0 : s === "warning" ? 1 : 2;

  allVariants.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.priorityScore - a.priorityScore ||
      compareLineCodes(a.lineShort, b.lineShort) ||
      a.directionId - b.directionId,
  );

  lineSummaries.sort(
    (a, b) =>
      severityRank(a.worstSeverity) - severityRank(b.worstSeverity) ||
      b.errorVariants - a.errorVariants ||
      b.warningVariants - a.warningVariants ||
      compareLineCodes(a.lineShort, b.lineShort),
  );

  return {
    auditedAt: Date.now(),
    thresholds: { ...thresholds },
    totalLines: entries.length,
    totalVariants: allVariants.length,
    errorVariants: allVariants.filter((v) => v.severity === "error").length,
    warningVariants: allVariants.filter((v) => v.severity === "warning").length,
    okVariants: allVariants.filter((v) => v.severity === "ok").length,
    customizedVariants: allVariants.filter((v) => v.customized).length,
    byKindCount,
    lines: lineSummaries,
    variants: allVariants,
  };
}

/**
 * Pobiera aktualny katalog linii (wraz z aktywnymi poprawkami Planisty) i uruchamia audyt.
 */
export async function runRouteQualityAudit(
  thresholds: RouteAuditThresholds = DEFAULT_ROUTE_AUDIT_THRESHOLDS,
): Promise<RouteQualityAuditReport> {
  const entries = await getLineCatalogue();
  return auditLineCatalogue(entries, thresholds);
}

/**
 * Buduje nakładkę mapową (`KursowkaShapeOverlay`) dla jednego wariantu albo zbiorczej „Mapy błędów”.
 */
export function buildAuditMapOverlay(
  variants: readonly VariantQualityAudit[],
  title: string,
  accentColor?: string,
): {
  title: string;
  color: string;
  polylines: [number, number][][];
  stops: Array<{ name: string; lat: number; lon: number; sequence?: number }>;
} {
  const polylines: [number, number][][] = [];
  const stops: Array<{ name: string; lat: number; lon: number; sequence?: number }> = [];
  const seenLoc = new Set<string>();

  for (const v of variants.slice(0, 25)) {
    if (v.path.length >= 2) polylines.push(v.path);
    for (const issue of v.issues) {
      for (const loc of issue.locations) {
        const key = `${loc.lat.toFixed(4)},${loc.lon.toFixed(4)},${loc.label}`;
        if (seenLoc.has(key)) continue;
        seenLoc.add(key);
        stops.push({
          name: loc.label,
          lat: loc.lat,
          lon: loc.lon,
          sequence: stops.length + 1,
        });
        if (stops.length >= 60) break;
      }
      if (stops.length >= 60) break;
    }
  }

  return {
    title,
    color: accentColor ?? (variants.length === 1 ? variants[0].lineColor : "#dc2626"),
    polylines,
    stops,
  };
}

function csvCell(value: string | number): string {
  const str = String(value);
  if (/[;"\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/**
 * Eksportuje listę wykrytych błędów jakości tras do pliku CSV (UTF-8 BOM, separator `;`).
 */
export function exportRouteAuditCsv(report: RouteQualityAuditReport): string {
  const rows: string[] = [];
  rows.push(
    [
      "Poziom",
      "Linia",
      "Kierunek",
      "Relacja",
      "Wariant",
      "Kursów/dzień",
      "Długość kształtu [km]",
      "Długość przystanków [km]",
      "Maks. odl. przystanku [m]",
      "Maks. skok [m]",
      "Zygzaki",
      "Poprawiona ręcznie",
      "Wykryte problemy",
    ]
      .map(csvCell)
      .join(";"),
  );

  for (const v of report.variants) {
    if (v.severity === "ok") continue;
    rows.push(
      [
        v.severity === "error" ? "Błąd" : "Ostrzeżenie",
        v.lineShort,
        v.directionId,
        `${v.firstStop} → ${v.lastStop}`,
        v.variantKey,
        v.refCount,
        (v.shapeLengthMeters / 1000).toFixed(2).replace(".", ","),
        (v.stopChainLengthMeters / 1000).toFixed(2).replace(".", ","),
        v.maxStopOffsetMeters,
        v.maxJumpMeters,
        v.zigzagCount,
        v.customized ? "Tak" : "Nie",
        v.issues.map((i) => `${i.title}: ${i.detail}`).join(" | "),
      ]
        .map(csvCell)
        .join(";"),
    );
  }

  return `\uFEFF${rows.join("\r\n")}`;
}
