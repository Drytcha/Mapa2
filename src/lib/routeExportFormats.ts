/**
 * Eksport przebiegów tras do standardowych formatów GIS / GTFS:
 *  - GTFS `shapes.txt` (CSV zgodny ze specyfikacją GTFS z `shape_dist_traveled` w metrach)
 *  - GeoJSON (RFC 7946 FeatureCollection z poliliniami `[lon, lat]` — gotowy do QGIS)
 *  - GPX 1.1 (standardowy plik śladów GPS z `<trk>` i `<trkpt>`)
 */

import { cumulativeRouteMeters, polylineLengthMeters } from "./core/spatial";
import type { LineRouteOverride } from "./engine/lineRouteOverrides";
import type { LatLng } from "./routeEditorGeometry";

export interface RouteExportEntry {
  shapeId: string;
  lineShort: string;
  name: string;
  directionId?: number;
  scope?: "variant" | "direction";
  firstStopName?: string;
  lastStopName?: string;
  note?: string;
  updatedAt?: string;
  path: readonly LatLng[];
}

function escapeCsvField(value: string | number): string {
  const s = String(value);
  if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function sanitizeGtfsId(raw: string, fallback = "SHAPE"): string {
  const cleaned = raw
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_.-]/g, "_");
  return cleaned || fallback;
}

/** Konwertuje zapisaną poprawkę Planisty na wpis eksportu geometrii. */
export function overrideToExportEntry(
  override: LineRouteOverride,
): RouteExportEntry {
  const isDir =
    override.scope === "direction" || override.variantKey.startsWith("__DIR_");
  const shapeId = isDir
    ? sanitizeGtfsId(`LINE_${override.lineShort}_DIR_${override.directionId}`)
    : sanitizeGtfsId(override.variantKey, `LINE_${override.lineShort}`);
  const rel =
    override.firstStopName && override.lastStopName
      ? `${override.firstStopName} → ${override.lastStopName}`
      : `Kierunek ${override.directionId}`;
  return {
    shapeId,
    lineShort: override.lineShort,
    name: `Linia ${override.lineShort} · ${rel}`,
    directionId: override.directionId,
    scope: isDir ? "direction" : "variant",
    firstStopName: override.firstStopName,
    lastStopName: override.lastStopName,
    note: override.note,
    updatedAt: override.updatedAt,
    path: override.path,
  };
}

/**
 * Generuje plik GTFS `shapes.txt` ze wszystkimi przekazanymi trasami.
 * Zawiera kolumnę `shape_dist_traveled` w metrach (1 miejsce po przecinku).
 */
export function exportRoutesToGtfsShapesTxt(
  entries: readonly RouteExportEntry[],
): string {
  const lines: string[] = [
    "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled",
  ];
  const seenShapeIds = new Set<string>();

  for (const entry of entries) {
    if (entry.path.length < 2) continue;
    let shapeId = sanitizeGtfsId(entry.shapeId, `SHAPE_${entry.lineShort}`);
    if (seenShapeIds.has(shapeId)) {
      let suffix = 2;
      while (seenShapeIds.has(`${shapeId}_${suffix}`)) suffix += 1;
      shapeId = `${shapeId}_${suffix}`;
    }
    seenShapeIds.add(shapeId);

    const cumDist = cumulativeRouteMeters(entry.path);
    for (let i = 0; i < entry.path.length; i += 1) {
      const [lat, lon] = entry.path[i];
      const dist = cumDist[i] ?? 0;
      lines.push(
        [
          escapeCsvField(shapeId),
          lat.toFixed(6),
          lon.toFixed(6),
          i + 1,
          dist.toFixed(1),
        ].join(","),
      );
    }
  }

  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Generuje standardowy plik GeoJSON (RFC 7946, współrzędne `[lon, lat]`) gotowy do QGIS.
 */
export function exportRoutesToGeoJson(
  entries: readonly RouteExportEntry[],
): string {
  const features = entries
    .filter((entry) => entry.path.length >= 2)
    .map((entry) => ({
      type: "Feature" as const,
      properties: {
        shape_id: entry.shapeId,
        line_short: entry.lineShort,
        name: entry.name,
        ...(entry.directionId !== undefined
          ? { direction_id: entry.directionId }
          : {}),
        ...(entry.scope ? { scope: entry.scope } : {}),
        ...(entry.firstStopName ? { first_stop: entry.firstStopName } : {}),
        ...(entry.lastStopName ? { last_stop: entry.lastStopName } : {}),
        length_meters: Math.round(polylineLengthMeters(entry.path)),
        point_count: entry.path.length,
        ...(entry.note ? { note: entry.note } : {}),
        ...(entry.updatedAt ? { updated_at: entry.updatedAt } : {}),
      },
      geometry: {
        type: "LineString" as const,
        coordinates: entry.path.map(([lat, lon]) => [
          Number(lon.toFixed(6)),
          Number(lat.toFixed(6)),
        ]),
      },
    }));

  return JSON.stringify(
    {
      type: "FeatureCollection",
      name: "walbrzych_bus_routes",
      features,
    },
    null,
    2,
  );
}

/**
 * Generuje standardowy plik GPX 1.1 ze śladami (`<trk>`) dla wszystkich przekazanych tras.
 */
export function exportRoutesToGpx(
  entries: readonly RouteExportEntry[],
  creator = "Mapa2 Planer GTFS",
): string {
  const valid = entries.filter((entry) => entry.path.length >= 2);
  const nowIso = new Date().toISOString();
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${escapeXml(creator)}" xmlns="http://www.topografix.com/GPX/1/1">`,
    "  <metadata>",
    `    <name>${escapeXml(valid.length === 1 ? valid[0].name : `Trasy autobusowe (${valid.length})`)}</name>`,
    `    <time>${nowIso}</time>`,
    "  </metadata>",
  ];

  for (const entry of valid) {
    const descParts: string[] = [];
    if (entry.shapeId) descParts.push(`shape_id: ${entry.shapeId}`);
    if (entry.firstStopName && entry.lastStopName) {
      descParts.push(`${entry.firstStopName} -> ${entry.lastStopName}`);
    }
    if (entry.note) descParts.push(entry.note);

    out.push("  <trk>");
    out.push(`    <name>${escapeXml(entry.name)}</name>`);
    if (descParts.length) {
      out.push(`    <desc>${escapeXml(descParts.join(" | "))}</desc>`);
    }
    out.push("    <trkseg>");
    for (const [lat, lon] of entry.path) {
      out.push(`      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`);
    }
    out.push("    </trkseg>");
    out.push("  </trk>");
  }

  out.push("</gpx>");
  return `${out.join("\n")}\n`;
}

export function triggerTextDownload(
  content: string,
  filename: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function triggerBinaryDownload(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
