/** What is drawn on the map. Persisted per browser. */
export type StopDisplayMode = "all" | "route" | "off";

export interface VisibilitySettings {
  /** Bus stops are shown by default and can be hidden by the user. */
  stops: StopDisplayMode;
  liveBuses: boolean;
  /** Optional identifiers; direction, line, speed and delay are always shown. */
  busKursowka: boolean;
  busVehicleNumber: boolean;
  trafficSignals: boolean;
  turnarounds: boolean;
}

export type VisibilityToggleKey = Exclude<keyof VisibilitySettings, "stops">;

export const VISIBILITY_STORAGE_KEY = "mapplaner.visibility.v3";
const PREV_VISIBILITY_STORAGE_KEY = "mapplaner.visibility.v2";
const LEGACY_VISIBILITY_STORAGE_KEY = "mapplaner.visibility.v1";

export const DEFAULT_VISIBILITY: VisibilitySettings = {
  stops: "all",
  liveBuses: true,
  busKursowka: false,
  busVehicleNumber: true,
  trafficSignals: true,
  turnarounds: true,
};

/** Accepts anything read from storage and always returns a complete, valid object. */
export function restoreVisibility(value: unknown): VisibilitySettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_VISIBILITY };
  const raw = value as Record<string, unknown>;
  const flag = (key: VisibilityToggleKey): boolean =>
    typeof raw[key] === "boolean" ? (raw[key] as boolean) : DEFAULT_VISIBILITY[key];
  return {
    stops:
      raw.stops === "all" || raw.stops === "route" || raw.stops === "off"
        ? raw.stops
        : DEFAULT_VISIBILITY.stops,
    liveBuses: flag("liveBuses"),
    busKursowka: flag("busKursowka"),
    busVehicleNumber: flag("busVehicleNumber"),
    trafficSignals: flag("trafficSignals"),
    turnarounds: flag("turnarounds"),
  };
}

import { readStorageJson, writeStorageJson } from "./core/time";

export function loadVisibility(): VisibilitySettings {
  const current = readStorageJson(VISIBILITY_STORAGE_KEY);
  if (current) return restoreVisibility(current);
  const previousV2 = readStorageJson(PREV_VISIBILITY_STORAGE_KEY);
  if (previousV2) {
    const migrated = restoreVisibility(previousV2);
    migrated.busVehicleNumber = true;
    return migrated;
  }
  const previous = readStorageJson(LEGACY_VISIBILITY_STORAGE_KEY);
  if (!previous) return { ...DEFAULT_VISIBILITY };
  // Upgrade legacy defaults once; subsequent choices persist under v3.
  const migrated = restoreVisibility(previous);
  if (migrated.stops === "off") migrated.stops = "all";
  migrated.busVehicleNumber = true;
  return migrated;
}

export function saveVisibility(settings: VisibilitySettings): void {
  writeStorageJson(VISIBILITY_STORAGE_KEY, settings);
}
