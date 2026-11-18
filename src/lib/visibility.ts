/** What is drawn on the map. Persisted per browser. */
export type StopDisplayMode = "all" | "route" | "off";

export interface VisibilitySettings {
  /** Bus stops on the map are hidden by default. */
  stops: StopDisplayMode;
  liveBuses: boolean;
  /** Optional identifiers; direction, line, speed and delay are always shown. */
  busKursowka: boolean;
  busVehicleNumber: boolean;
  trafficSignals: boolean;
  turnarounds: boolean;
}

export type VisibilityToggleKey = Exclude<keyof VisibilitySettings, "stops">;

export const VISIBILITY_STORAGE_KEY = "mapplaner.visibility.v1";

export const DEFAULT_VISIBILITY: VisibilitySettings = {
  stops: "off",
  liveBuses: true,
  busKursowka: false,
  busVehicleNumber: false,
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
  return restoreVisibility(readStorageJson(VISIBILITY_STORAGE_KEY));
}

export function saveVisibility(settings: VisibilitySettings): void {
  writeStorageJson(VISIBILITY_STORAGE_KEY, settings);
}
