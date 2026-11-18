import officialStopsData from "@/data/walbrzych-official-stops.json";

export interface OfficialStop {
  id: number;
  name: string;
  symbol: string;
  lat: number;
  lon: number;
  lines: string[];
  zone?: string;
}

const SNAPSHOT_STOPS: OfficialStop[] = (
  officialStopsData as Array<{
    id: number;
    name: string;
    symbol: string;
    lat: number;
    lon: number;
    lines?: string[];
    zone?: string;
  }>
).map((row) => ({
  id: Number(row.id),
  name: String(row.name).trim(),
  symbol: String(row.symbol),
  lat: Number(row.lat),
  lon: Number(row.lon),
  lines: Array.isArray(row.lines) ? row.lines : [],
  zone: row.zone,
}));

export const OFFICIAL_STOPS_BY_ID: ReadonlyMap<string, OfficialStop> = new Map(
  SNAPSHOT_STOPS.map((stop) => [String(stop.id), stop])
);

const OFFICIAL_RESULT = {
  stops: SNAPSHOT_STOPS,
  source: "rozklad.walbrzych.eu (migawka lokalna)",
  fetchedAt: null as string | null,
};

export function loadOfficialStops(): {
  stops: OfficialStop[];
  source: string;
  fetchedAt: string | null;
} {
  return OFFICIAL_RESULT;
}
