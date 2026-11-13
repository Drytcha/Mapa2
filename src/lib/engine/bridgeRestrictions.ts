/**
 * Wiadukty, kładki, tunele i ograniczenia wysokości/masy na trasie linii.
 *
 * Źródłem jest OpenStreetMap przez Overpass API. Zbieramy wyłącznie obiekty
 * inżynieryjne w pasie 55 m od polilinii linii i liczymy, czy leżą NA trasie
 * (bus po nich jedzie), NAD trasą (przejazd pod obiektem) czy tylko obok.
 * Dla wiaduktów z `maxheight`/`maxweight` wyliczamy stopień ryzyka.
 *
 * Dane infrastruktury zmieniają się rzadko: wynik trzymamy 30 dni w IndexedDB.
 * Gdy OSM nie odpowiada, pokazujemy ostatnią zapamiętaną kopię jako „nieaktualne”.
 */

import { OVERPASS_URL } from "@/lib/services";
import { withOverpassSlot } from "@/lib/requests";
import { idbGetKv, idbSetKv } from "./storage";
import { getLineRouteGeometry, type LineRouteGeometry } from "./gtfsStore";

export type StructureRelation =
  "on-route" | "over-route" | "under-route" | "near";
export type StructureSeverity = "critical" | "warning" | "info" | "none";
export type StructureKind =
  | "bridge-road"
  | "bridge-rail"
  | "footbridge"
  | "tunnel"
  | "height-restriction"
  | "unknown";

export interface BridgeRestriction {
  id: string;
  kind: StructureKind;
  kindLabel: string;
  name: string;
  /** Ulica/kolej, którą niesie obiekt — do opisu w legendzie. */
  carries: string | null;
  lat: number;
  lon: number;
  relation: StructureRelation;
  relationLabel: string;
  clearanceM: number | null;
  clearanceRaw: string | null;
  weightT: number | null;
  weightRaw: string | null;
  widthM: number | null;
  lanes: number | null;
  nearestStop: string | null;
  nearestStopMeters: number | null;
  routeDistanceMeters: number;
  severity: StructureSeverity;
  severityLabel: string;
}

export interface LineRestrictions {
  routeShort: string;
  routeName: string;
  signature: string;
  items: BridgeRestriction[];
  restrictionsCount: number;
  criticalCount: number;
  fetchedAt: number;
  source: "live" | "cache" | "stale-cache";
  /** Wyjaśnienie np. gdy OSM nie ma żadnych obiektów przy trasie. */
  note: string | null;
}

interface OverpassGeometryPoint {
  lat: number;
  lon: number;
}

export interface OverpassRestrictionElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: OverpassGeometryPoint[];
  tags?: Record<string, string>;
}

const OVERPASS_ENDPOINTS = [
  OVERPASS_URL,
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
].filter((url, index, list) => list.indexOf(url) === index);

const CACHE_PREFIX = "mapplaner.bridgeRestrictions.v1.";
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
const MEMORY_TTL_MS = 10 * 60 * 1000;
const ROUTE_DETECTION_METERS = 14;
const OVER_ROUTE_DISTANCE_METERS = 55;
/** Wysokość typowego autobusu 12 m; poniżej tego przejazd jest krytyczny. */
const BUS_HEIGHT_M = 3.5;
const BUS_WEIGHT_T = 18;
const BBOX_PAD_DEGREES = 0.004;

const memoryCache = new Map<string, { at: number; data: LineRestrictions }>();

/* -------------------------------------------------------------------------- */
/*  Parsowanie limitów                                                        */
/* -------------------------------------------------------------------------- */

export function parseClearanceMeters(
  raw: string | undefined | null,
): number | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase().replace(",", ".");
  if (!value || /^(default|none|unsigned|sign|no|unknown|-)$/.test(value))
    return null;
  if (value.includes("'") || value.includes('"')) {
    const feet = value.match(/(\d+(?:\.\d+)?)\s*'/);
    const inches = value.match(/(\d+(?:\.\d+)?)\s*"/);
    const total =
      (feet ? Number(feet[1]) : 0) * 0.3048 +
      (inches ? Number(inches[1]) : 0) * 0.0254;
    return total > 0 ? Math.round(total * 100) / 100 : null;
  }
  const number = Number.parseFloat(value.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return null;
  if (/\bcm\b/.test(value)) return Math.round((number / 100) * 100) / 100;
  if (/\bkm\b/.test(value)) return Math.round(number * 1000 * 100) / 100;
  return Math.round(number * 100) / 100;
}

export function parseWeightTonnes(
  raw: string | undefined | null,
): number | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase().replace(",", ".");
  if (!value || /^(default|none|unsigned|no|unknown|-)$/.test(value))
    return null;
  const number = Number.parseFloat(value.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return null;
  if (/\bkg\b/.test(value)) return Math.round((number / 1000) * 10) / 10;
  if (/\blbs?\b/.test(value)) return Math.round(number * 0.000453592 * 10) / 10;
  return Math.round(number * 10) / 10;
}

export function parseWidthMeters(
  raw: string | undefined | null,
): number | null {
  if (!raw) return null;
  const number = Number.parseFloat(
    raw.replace(",", ".").replace(/[^0-9.]/g, ""),
  );
  return Number.isFinite(number) && number > 0
    ? Math.round(number * 100) / 100
    : null;
}

function classify(
  tags: Record<string, string>,
  onRoute: boolean,
): {
  kind: StructureKind;
  kindLabel: string;
  relation: StructureRelation;
  relationLabel: string;
} {
  const isBridge =
    (Boolean(tags.bridge) && tags.bridge !== "no") ||
    tags.man_made === "bridge";
  const isTunnel =
    (Boolean(tags.tunnel) && tags.tunnel !== "no") || tags.covered === "yes";
  const isRail =
    Boolean(tags.railway) ||
    /^(rail|light_rail|tram|subway)$/.test(tags.railway ?? "");
  const isFoot = /^(footway|path|pedestrian|cycleway|steps)$/.test(
    tags.highway ?? "",
  );
  const hasLimit = Boolean(
    tags.maxheight ||
    tags["maxheight:physical"] ||
    tags.maxweight ||
    tags.maxheight_legal,
  );

  let kind: StructureKind = "unknown";
  let kindLabel = "Obiekt inżynieryjny";
  if (isTunnel) {
    kind = "tunnel";
    kindLabel = isRail
      ? "Tunel kolejowy"
      : tags.highway
        ? "Tunel drogowy"
        : "Tunel";
  } else if (isBridge && isRail) {
    kind = "bridge-rail";
    kindLabel = "Wiadukt kolejowy";
  } else if (isBridge && isFoot) {
    kind = "footbridge";
    kindLabel = "Kładka dla pieszych";
  } else if (isBridge) {
    kind = "bridge-road";
    kindLabel = tags.highway ? "Wiadukt drogowy" : "Wiadukt";
  } else if (hasLimit) {
    kind = "height-restriction";
    kindLabel = tags.maxheight ? "Ograniczenie wysokości" : "Ograniczenie masy";
  }

  const relation: StructureRelation = onRoute
    ? "on-route"
    : isTunnel
      ? "under-route"
      : isBridge
        ? "over-route"
        : "near";
  const relationLabel =
    relation === "on-route"
      ? isTunnel
        ? "Bus przejeżdża tunelem"
        : "Bus przejeżdża po obiekcie"
      : relation === "over-route"
        ? "Obiekt nad trasą — przejazd pod nim"
        : relation === "under-route"
          ? "Tunel pod trasą"
          : "Obiekt przy trasie";
  return { kind, kindLabel, relation, relationLabel };
}

function severityFor(
  clearanceM: number | null,
  weightT: number | null,
  relation: StructureRelation,
): { severity: StructureSeverity; severityLabel: string } {
  if (relation === "under-route") {
    return { severity: "none", severityLabel: "Bez wpływu na przejazd" };
  }
  if (clearanceM !== null) {
    if (clearanceM < BUS_HEIGHT_M) {
      return {
        severity: "critical",
        severityLabel: "Poniżej wysokości autobusu",
      };
    }
    if (clearanceM < BUS_HEIGHT_M + 0.8) {
      return {
        severity: "warning",
        severityLabel: "Niski przejazd — sprawdź wysokość",
      };
    }
    return { severity: "info", severityLabel: "Przejazd możliwy" };
  }
  if (weightT !== null) {
    if (weightT < 10)
      return { severity: "critical", severityLabel: "Bardzo niski limit masy" };
    if (weightT < BUS_WEIGHT_T)
      return { severity: "warning", severityLabel: "Limit masy poniżej 18 t" };
    return { severity: "info", severityLabel: "Limit masy spełniony" };
  }
  return { severity: "none", severityLabel: "Brak danych o limicie" };
}

/* -------------------------------------------------------------------------- */
/*  Indeks przestrzenny trasy                                                 */
/* -------------------------------------------------------------------------- */

const CELL = 0.002;
const cellKey = (lat: number, lon: number) =>
  `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;

function metres(lat1: number, lon1: number, lat2: number, lon2: number) {
  const dy = (lat2 - lat1) * 110540;
  const dx =
    (lon2 - lon1) * 111320 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

function pointSegmentMeters(
  pLat: number,
  pLon: number,
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const lonScale = 111320 * Math.cos((pLat * Math.PI) / 180);
  const px = (pLon - aLon) * lonScale;
  const py = (pLat - aLat) * 110540;
  const bx = (bLon - aLon) * lonScale;
  const by = (bLat - aLat) * 110540;
  const length2 = bx * bx + by * by;
  if (length2 <= 1e-6) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / length2));
  return Math.hypot(px - bx * t, py - by * t);
}

interface RouteIndex {
  points: Array<[number, number]>;
  cells: Map<string, number[]>;
  stops: LineRouteGeometry["stops"];
}

function buildRouteIndex(geometry: LineRouteGeometry): RouteIndex {
  const points: Array<[number, number]> = [];
  for (const point of geometry.points) {
    const last = points[points.length - 1];
    if (last && metres(last[0], last[1], point[0], point[1]) < 3) continue;
    points.push(point);
  }
  const cells = new Map<string, number[]>();
  points.forEach((point, index) => {
    const key = cellKey(point[0], point[1]);
    const bucket = cells.get(key);
    if (bucket) bucket.push(index);
    else cells.set(key, [index]);
  });
  return { points, cells, stops: geometry.stops };
}

function nearestRouteDistance(
  index: RouteIndex,
  lat: number,
  lon: number,
): number {
  const latCell = Math.floor(lat / CELL);
  const lonCell = Math.floor(lon / CELL);
  let best = Infinity;
  for (let la = latCell - 2; la <= latCell + 2; la += 1) {
    for (let lo = lonCell - 2; lo <= lonCell + 2; lo += 1) {
      const bucket = index.cells.get(`${la}:${lo}`);
      if (!bucket) continue;
      for (const pointIndex of bucket) {
        const point = index.points[pointIndex];
        const distance = metres(lat, lon, point[0], point[1]);
        if (distance < best) best = distance;
        const next = index.points[pointIndex + 1];
        if (next) {
          const segment = pointSegmentMeters(
            lat,
            lon,
            point[0],
            point[1],
            next[0],
            next[1],
          );
          if (segment < best) best = segment;
        }
      }
    }
  }
  return best;
}

function nearestStop(index: RouteIndex, lat: number, lon: number) {
  let name: string | null = null;
  let distance = Infinity;
  for (const stop of index.stops) {
    const value = metres(lat, lon, stop.lat, stop.lon);
    if (value < distance) {
      distance = value;
      name = stop.name;
    }
  }
  return {
    name,
    meters: Number.isFinite(distance) ? Math.round(distance) : null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Konwersja elementów Overpass                                              */
/* -------------------------------------------------------------------------- */

function elementPoints(
  element: OverpassRestrictionElement,
): Array<[number, number]> {
  if (element.geometry?.length) {
    return element.geometry
      .filter(
        (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon),
      )
      .map((point) => [point.lat, point.lon]);
  }
  if (Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
    return [[element.lat!, element.lon!]];
  }
  if (element.center) return [[element.center.lat, element.center.lon]];
  return [];
}

/** Czysta funkcja klasyfikacji — używana też w testach regresyjnych. */
export function buildBridgeRestrictions(
  elements: OverpassRestrictionElement[],
  geometry: LineRouteGeometry,
): BridgeRestriction[] {
  const index = buildRouteIndex(geometry);
  const items: BridgeRestriction[] = [];
  const seen = new Set<string>();

  for (const element of elements) {
    const tags = element.tags ?? {};
    const isStructure =
      (Boolean(tags.bridge) && tags.bridge !== "no") ||
      (Boolean(tags.tunnel) && tags.tunnel !== "no") ||
      tags.man_made === "bridge" ||
      tags.barrier === "height_restriction" ||
      Boolean(tags.maxheight || tags["maxheight:physical"] || tags.maxweight);
    if (!isStructure) continue;

    const points = elementPoints(element);
    if (!points.length) continue;
    const centerPoint = points[Math.floor(points.length / 2)];
    const distances = points.map(([lat, lon]) =>
      nearestRouteDistance(index, lat, lon),
    );
    const routeDistance = Math.min(...distances);
    if (routeDistance > OVER_ROUTE_DISTANCE_METERS) continue;

    const onRoute =
      distances.filter((value) => value <= ROUTE_DETECTION_METERS).length /
        points.length >=
      0.5;
    const key = `${element.type}-${element.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const clearanceRaw = tags.maxheight || tags["maxheight:physical"] || null;
    const clearance = parseClearanceMeters(clearanceRaw);
    const weightRaw = tags.maxweight || null;
    const weight = parseWeightTonnes(weightRaw);
    const width = parseWidthMeters(tags.maxwidth);
    const { kind, kindLabel, relation, relationLabel } = classify(
      tags,
      onRoute,
    );
    const nearest = nearestStop(index, centerPoint[0], centerPoint[1]);
    const { severity, severityLabel } = severityFor(
      clearance,
      weight,
      relation,
    );
    const name =
      tags.name?.trim() ||
      tags.ref?.trim() ||
      (kind === "bridge-rail"
        ? "Wiadukt kolejowy"
        : kind === "footbridge"
          ? "Kładka dla pieszych"
          : kind === "tunnel"
            ? "Tunel"
            : kind === "height-restriction"
              ? "Ograniczenie wysokości"
              : "Wiadukt bez nazwy");
    const carries =
      tags["bridge:name"] ||
      tags.description ||
      tags.operator ||
      (tags.highway
        ? `droga ${tags.highway}`
        : tags.railway
          ? "linia kolejowa"
          : null);

    items.push({
      id: key,
      kind,
      kindLabel,
      name,
      carries,
      lat: centerPoint[0],
      lon: centerPoint[1],
      relation,
      relationLabel,
      clearanceM: clearance,
      clearanceRaw,
      weightT: weight,
      weightRaw,
      widthM: width,
      lanes: tags.lanes ? Number(tags.lanes) || null : null,
      nearestStop: nearest.name,
      nearestStopMeters: nearest.meters,
      routeDistanceMeters: Math.round(routeDistance),
      severity,
      severityLabel,
    });
  }

  const severityRank: Record<StructureSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
    none: 3,
  };
  return items.sort((a, b) => {
    const rank = severityRank[a.severity] - severityRank[b.severity];
    if (rank !== 0) return rank;
    if (
      a.clearanceM !== null &&
      b.clearanceM !== null &&
      a.clearanceM !== b.clearanceM
    ) {
      return a.clearanceM - b.clearanceM;
    }
    return (
      a.routeDistanceMeters - b.routeDistanceMeters ||
      a.name.localeCompare(b.name, "pl")
    );
  });
}

/* -------------------------------------------------------------------------- */
/*  Overpass + cache                                                          */
/* -------------------------------------------------------------------------- */

function bboxOf(geometry: LineRouteGeometry): string {
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const [lat, lon] of geometry.points) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lon);
    east = Math.max(east, lon);
  }
  return [
    south - BBOX_PAD_DEGREES,
    west - BBOX_PAD_DEGREES,
    north + BBOX_PAD_DEGREES,
    east + BBOX_PAD_DEGREES,
  ]
    .map((value) => value.toFixed(4))
    .join(",");
}

async function fetchOverpassElements(
  bbox: string,
  signal?: AbortSignal,
): Promise<OverpassRestrictionElement[]> {
  const query = `[out:json][timeout:40];(
way["bridge"](${bbox});
way["tunnel"](${bbox});
way["man_made"="bridge"](${bbox});
way["maxheight"](${bbox});
way["maxweight"](${bbox});
node["barrier"="height_restriction"](${bbox});
node["maxheight"](${bbox});
);out geom;`;

  for (const url of OVERPASS_ENDPOINTS) {
    signal?.throwIfAborted();
    try {
      const elements = await withOverpassSlot(async () => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({ data: query }).toString(),
          signal,
        });
        if (!response.ok) return null;
        const json = (await response.json()) as {
          elements?: OverpassRestrictionElement[];
        };
        return Array.isArray(json.elements) ? json.elements : null;
      }, signal);
      if (elements) return elements;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof DOMException && error.name === "AbortError")
        throw error;
      // Kolejne lustro Overpass.
    }
  }
  throw new Error(
    "Nie udało się pobrać danych o wiaduktach z OpenStreetMap. Spróbuj ponownie.",
  );
}

interface CachedRestrictions {
  fetchedAt: number;
  items: BridgeRestriction[];
  routeShort: string;
  routeName: string;
  signature: string;
}

/** Ograniczenia wiaduktowe dla linii — z pamięcią i uczciwym stanem błędu. */
export async function getLineBridgeRestrictions(
  routeShort: string,
  options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<LineRestrictions> {
  const geometry = await getLineRouteGeometry(routeShort);
  if (!geometry) {
    throw new Error(`Brak geometrii trasy dla linii ${routeShort}.`);
  }
  const cacheKey = `${CACHE_PREFIX}${geometry.signature}`;
  const memory = memoryCache.get(cacheKey);
  if (!options.force && memory && Date.now() - memory.at < MEMORY_TTL_MS) {
    return memory.data;
  }
  const cached = await idbGetKv<CachedRestrictions>(cacheKey);
  const fresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
  if (!options.force && fresh) {
    const data = decorate(geometry, cached.items, cached.fetchedAt, "cache");
    memoryCache.set(cacheKey, { at: Date.now(), data });
    return data;
  }

  try {
    const elements = await fetchOverpassElements(
      bboxOf(geometry),
      options.signal,
    );
    const items = buildBridgeRestrictions(elements, geometry);
    const fetchedAt = Date.now();
    await idbSetKv<CachedRestrictions>(cacheKey, {
      fetchedAt,
      items,
      routeShort: geometry.routeShort,
      routeName: geometry.routeName,
      signature: geometry.signature,
    });
    const data = decorate(geometry, items, fetchedAt, "live");
    memoryCache.set(cacheKey, { at: Date.now(), data });
    return data;
  } catch (error) {
    if (cached) {
      const data = decorate(
        geometry,
        cached.items,
        cached.fetchedAt,
        "stale-cache",
      );
      data.note =
        "OpenStreetMap jest chwilowo niedostępny. Pokazujemy ostatnio zapisany wykaz wiaduktów.";
      return data;
    }
    throw error;
  }
}

function decorate(
  geometry: LineRouteGeometry,
  items: BridgeRestriction[],
  fetchedAt: number,
  source: LineRestrictions["source"],
): LineRestrictions {
  const restrictions = items.filter(
    (item) => item.severity === "critical" || item.severity === "warning",
  );
  return {
    routeShort: geometry.routeShort,
    routeName: geometry.routeName,
    signature: geometry.signature,
    items,
    restrictionsCount: restrictions.length,
    criticalCount: restrictions.filter((item) => item.severity === "critical")
      .length,
    fetchedAt,
    source,
    note: items.length
      ? null
      : "Brak wiaduktów i ograniczeń w pasie 55 m od trasy w OpenStreetMap. To nie zastępuje oznakowania w terenie.",
  };
}
