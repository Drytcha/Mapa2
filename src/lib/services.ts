export const ROUTING_URL = (
  process.env.NEXT_PUBLIC_OSRM_URL || "https://router.project-osrm.org"
).replace(/\/$/, "");
export const ROUTING_PROFILE =
  (process.env.NEXT_PUBLIC_OSRM_PROFILE || "driving").replace(/[^a-z0-9_-]/gi, "") ||
  "driving";
export const BUS_ROUTING_URL = (
  process.env.NEXT_PUBLIC_OSRM_BUS_URL || ROUTING_URL
).replace(/\/$/, "");
// This must point to an OSRM instance built with a pedestrian profile.
export const WALKING_ROUTING_URL = (
  process.env.NEXT_PUBLIC_WALKING_OSRM_URL || "https://routing.openstreetmap.de/routed-foot"
).replace(/\/$/, "");
export const GEOCODING_URL = (
  process.env.NEXT_PUBLIC_NOMINATIM_URL || "https://nominatim.openstreetmap.org"
).replace(/\/$/, "");
export const OVERPASS_URL = (
  process.env.NEXT_PUBLIC_OVERPASS_URL || "https://overpass-api.de/api/interpreter"
).replace(/\/$/, "");

export function assetUrl(relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, "");
  if (typeof document !== "undefined" && document.baseURI) {
    return new URL(clean, document.baseURI).toString();
  }
  const base = process.env.NEXT_PUBLIC_BASE_URL || "/";
  return `${base.endsWith("/") ? base : `${base}/`}${clean}`;
}

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";

export interface TileSource {
  base: string;
  labels?: string;
  attribution: string;
  printAttribution: string;
  maxZoom: number;
}

const OSM_LIGHT: TileSource = {
  base: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  printAttribution: "Mapa i dane: © OpenStreetMap contributors. openstreetmap.org/copyright",
  maxZoom: 19,
};

export const TILES: Record<"osm" | "light" | "dark" | "satellite", TileSource> = {
  /** Legacy id kept for stored preferences; renders the same tiles as "light". */
  osm: OSM_LIGHT,
  light: OSM_LIGHT,
  dark: {
    base: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    printAttribution: "Mapa i dane: © OpenStreetMap contributors. openstreetmap.org/copyright",
    maxZoom: 19,
  },
  satellite: {
    base: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
    attribution: "Tiles &copy; Esri, Maxar, Earthstar Geographics, GIS User Community",
    printAttribution: "Mapa: Esri, Maxar, Earthstar Geographics, GIS User Community.",
    maxZoom: 18,
  },
};
