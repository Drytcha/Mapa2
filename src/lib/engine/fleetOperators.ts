import type { WalbrzychOperatorKey } from "@/lib/types";

export const OPERATOR_NAMES: Record<WalbrzychOperatorKey, string> = {
  mzuk: "MZUK Sp. z o.o.",
  ska: "Śląskie Konsorcjum Autobusowe (ŚKA)",
  other: "Inny / nieprzypisany",
};

export type OperatorOverrides = Map<string, WalbrzychOperatorKey>;

const OVERRIDES_STORAGE_KEY = "mapplaner.operator-overrides.v1";

/**
 * Automatic assignment by fleet (side) number, based on the published fleet lists:
 *  - MZUK:  01–20 Solaris Urbino 12 hydrogen (to 45 with the purchase option),
 *           201–204 Solaris Urbino 12 / Mercedes Conecto LF (2025)
 *  - ŚKA:   3xx (Solaris Urbino 12/18, eCitaro) and 4xx (Mercedes O530G CNG),
 *           5xx (additional / leased vehicles)
 *  - ZDKiUM no longer runs vehicles (liquidated 1 Jan 2025).
 */
export function classifyVehicleNumber(
  vehicleId: string,
  model?: string | null
): WalbrzychOperatorKey {
  if (model?.toLowerCase().includes("hydrogen")) return "mzuk";
  const num = Number.parseInt(vehicleId, 10);
  if (!Number.isFinite(num)) return "other";
  if (num >= 1 && num <= 45) return "mzuk";
  if (num >= 200 && num <= 299) return "mzuk";
  if (num >= 300 && num <= 599) return "ska";
  return "other";
}

export function resolveWalbrzychOperator(
  vehicleId: string,
  model?: string | null,
  overrides?: OperatorOverrides
): { key: WalbrzychOperatorKey; name: string; source: "auto" | "manual" } {
  const manual = overrides?.get(vehicleId);
  if (manual) return { key: manual, name: OPERATOR_NAMES[manual], source: "manual" };
  const key = classifyVehicleNumber(vehicleId, model);
  const hydrogen = key === "mzuk" && model?.toLowerCase().includes("hydrogen");
  return {
    key,
    name: hydrogen ? `${OPERATOR_NAMES.mzuk} (wodorowy)` : OPERATOR_NAMES[key],
    source: "auto",
  };
}

export function isOperatorKey(value: unknown): value is WalbrzychOperatorKey {
  return value === "mzuk" || value === "ska" || value === "other";
}

let overridesCache: OperatorOverrides | null = null;

export function loadOperatorOverrides(): OperatorOverrides {
  if (overridesCache) return overridesCache;
  const map: OperatorOverrides = new Map();
  try {
    const raw = localStorage.getItem(OVERRIDES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        for (const [vehicleId, opKey] of Object.entries(parsed)) {
          if (isOperatorKey(opKey)) map.set(vehicleId, opKey);
        }
      }
    }
  } catch {
    /* Storage optional */
  }
  overridesCache = map;
  return map;
}

export function setOperatorOverride(
  vehicleId: string,
  operatorKey: WalbrzychOperatorKey | null
): void {
  const cleanId = vehicleId.trim();
  if (!cleanId || cleanId.length > 32) {
    throw new Error("Nieprawidłowy numer pojazdu.");
  }
  if (operatorKey !== null && !isOperatorKey(operatorKey)) {
    throw new Error("Nieprawidłowy przewoźnik.");
  }
  const map = new Map(loadOperatorOverrides());
  if (operatorKey === null) {
    map.delete(cleanId);
  } else {
    map.set(cleanId, operatorKey);
  }
  overridesCache = map;
  try {
    localStorage.setItem(OVERRIDES_STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    /* Storage optional */
  }
}
