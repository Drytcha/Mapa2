import type { NextRequest } from "next/server";

const CLIENT_ID_RE = /^[a-zA-Z0-9_-]{8,80}$/;

export interface ValidatedPoint {
  lat: number;
  lon: number;
  label: string;
  stopId: string | null;
}

export function parseTravelerClientId(request: NextRequest): string | null {
  const value =
    request.headers.get("x-client-id")?.trim() ||
    request.nextUrl.searchParams.get("clientId")?.trim() ||
    "";
  return CLIENT_ID_RE.test(value) ? value : null;
}

export function isValidLatitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

export function parseValidatedPoint(raw: unknown): ValidatedPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  if (!isValidLatitude(candidate.lat) || !isValidLongitude(candidate.lon)) {
    return null;
  }
  const rawLabel = typeof candidate.label === "string" ? candidate.label.trim() : "";
  const label = (rawLabel || `${candidate.lat.toFixed(5)}, ${candidate.lon.toFixed(5)}`).slice(
    0,
    120
  );
  const stopId =
    typeof candidate.stopId === "string" && candidate.stopId.trim()
      ? candidate.stopId.trim().slice(0, 80)
      : null;
  return {
    lat: candidate.lat,
    lon: candidate.lon,
    label,
    stopId,
  };
}
