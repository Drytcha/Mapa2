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

const SNAPSHOT_STOPS: OfficialStop[] = (officialStopsData as Array<{
  id: number;
  name: string;
  symbol: string;
  lat: number;
  lon: number;
  lines?: string[];
  zone?: string;
}>).map((row) => ({
  id: Number(row.id),
  name: String(row.name).trim(),
  symbol: String(row.symbol),
  lat: Number(row.lat),
  lon: Number(row.lon),
  lines: Array.isArray(row.lines) ? row.lines : [],
  zone: row.zone,
}));

export function loadOfficialStops(): {
  stops: OfficialStop[];
  source: string;
  fetchedAt: string | null;
} {
  return {
    stops: SNAPSHOT_STOPS,
    source: "rozklad.walbrzych.eu (migawka lokalna)",
    fetchedAt: null,
  };
}
