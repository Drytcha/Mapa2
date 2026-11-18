import type {
  AvoidOptions,
  BrigadeInfo,
  RouteData,
  ScheduleSettings,
  SpeedOverrides,
  VehicleId,
  VehicleProfile,
  Waypoint,
} from "./types";

export const BRIGADE_STORAGE_KEY = "mapplaner.brigade.v1";
export const SAVED_BRIGADES_KEY = "mapplaner.brigades.v1";

export const EMPTY_BRIGADE: BrigadeInfo = { line: "", duty: "" };

export interface SavedBrigadePlan {
  id: string;
  title: string;
  brigade: BrigadeInfo;
  waypoints: Waypoint[];
  vehicle: VehicleId;
  fleet?: VehicleProfile[];
  speeds?: SpeedOverrides;
  schedule?: ScheduleSettings;
  avoid: AvoidOptions;
  route?: RouteData;
  savedAt: string;
}

export function normalizeBrigade(value: unknown): BrigadeInfo {
  if (!value || typeof value !== "object") return { ...EMPTY_BRIGADE };
  const raw = value as Record<string, unknown>;
  return {
    line: typeof raw.line === "string" ? raw.line.trimStart().slice(0, 20) : "",
    duty: typeof raw.duty === "string" ? raw.duty.trimStart().slice(0, 32) : "",
  };
}

export function cleanBrigade(brigade?: BrigadeInfo): BrigadeInfo {
  return {
    line: brigade?.line.trim().slice(0, 20) ?? "",
    duty: brigade?.duty.trim().slice(0, 32) ?? "",
  };
}

export function hasBrigade(brigade?: BrigadeInfo): boolean {
  const { line, duty } = cleanBrigade(brigade);
  return Boolean(line || duty);
}

import { formatDutyCode, isSameDutyLine, parseDutyPair } from "./core/text";

export function formatBrigadeTitle(brigade?: BrigadeInfo): string {
  const { line, duty } = cleanBrigade(brigade);
  if (line && duty) {
    if (line.toUpperCase() === duty.toUpperCase()) return `Linia ${line}`;
    const canonicalDuty = parseDutyPair(duty) ? formatDutyCode(duty, "/") : duty;
    if (isSameDutyLine(line, canonicalDuty)) return `Brygada ${canonicalDuty}`;
    return `Linia ${line} · Brygada ${canonicalDuty}`;
  }
  if (line) return `Linia ${line}`;
  if (duty) return `Brygada ${parseDutyPair(duty) ? formatDutyCode(duty, "/") : duty}`;
  return "";
}

export function formatBrigadeCompact(brigade?: BrigadeInfo): string {
  const { line, duty } = cleanBrigade(brigade);
  if (line && duty) {
    if (line.toUpperCase() === duty.toUpperCase()) return `Linia ${line}`;
    const canonicalDuty = parseDutyPair(duty) ? formatDutyCode(duty, "/") : duty;
    if (isSameDutyLine(line, canonicalDuty)) return canonicalDuty;
    return `${line} · ${canonicalDuty}`;
  }
  if (line) return `Linia ${line}`;
  if (duty) return parseDutyPair(duty) ? formatDutyCode(duty, "/") : duty;
  return "";
}

import { readStorageJson, writeStorageJson } from "./core/time";

export function loadBrigade(): BrigadeInfo {
  const parsed = readStorageJson(BRIGADE_STORAGE_KEY);
  return parsed ? cleanBrigade(normalizeBrigade(parsed)) : { ...EMPTY_BRIGADE };
}

export function saveBrigade(brigade: BrigadeInfo): void {
  writeStorageJson(BRIGADE_STORAGE_KEY, cleanBrigade(brigade));
}

export function loadSavedBrigades(): SavedBrigadePlan[] {
  const parsed = readStorageJson<unknown[]>(SAVED_BRIGADES_KEY);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is SavedBrigadePlan =>
      Boolean(
        item &&
          typeof item === "object" &&
          typeof (item as SavedBrigadePlan).id === "string" &&
          typeof (item as SavedBrigadePlan).title === "string" &&
          Array.isArray((item as SavedBrigadePlan).waypoints)
      )
  );
}

export function persistSavedBrigades(list: SavedBrigadePlan[]): void {
  writeStorageJson(SAVED_BRIGADES_KEY, list);
}
