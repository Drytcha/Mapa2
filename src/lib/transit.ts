import { foldPolish, formatDutyCode } from "./core/text";
import type { LiveBusVehicle, WalbrzychOperatorKey } from "./types";
import { formatVehicleNumber } from "./delay";

/** Neutral company labels; vehicle colour represents punctuality, not operator. */
export const OPERATOR_STYLES: Record<
  WalbrzychOperatorKey,
  { label: string; bg: string; fg: string; soft: string }
> = {
  mzuk: { label: "MZUK", bg: "#cbd5e1", fg: "#273449", soft: "#cbd5e120" },
  ska: { label: "ŚKA", bg: "#cbd5e1", fg: "#273449", soft: "#cbd5e120" },
  other: { label: "Inny", bg: "#cbd5e1", fg: "#273449", soft: "#cbd5e120" },
};

export function normalizeDutyCode(value: string): string {
  return formatDutyCode(value, "/");
}

export const normalizeSearch = foldPolish;

/** Exact duty and fleet-number matches first; partial matches remain useful. */
export function matchesBusQuery(bus: LiveBusVehicle, query: string): boolean {
  const raw = query.trim();
  if (!raw) return true;
  const code = normalizeDutyCode(raw);
  if (code.includes("/")) {
    // Tylko pełny, potwierdzony kod brygady. Wyklucza to wyszukiwanie
    // nieistniejącej „19/01”, gdy prawdziwa brygada to np. 9/01.
    return (
      bus.dutyStatus === "confirmed" &&
      Boolean(bus.dutyCode) &&
      normalizeDutyCode(bus.dutyCode ?? "") === code
    );
  }
  const term = normalizeSearch(raw.replace(/^#/, ""));
  const number = normalizeSearch(bus.vehicleId).replace(/^0+/, "");
  const normalizedNumber = normalizeSearch(formatVehicleNumber(bus.vehicleId).slice(1)).replace(/^0+/, "");
  return (
    number === term.replace(/^0+/, "") ||
    normalizedNumber === term.replace(/^0+/, "") ||
    normalizeSearch(
      `${bus.dutyCode ?? ""} ${bus.dutyStatus === "confirmed" ? "" : bus.rawBrigade ?? ""} ${formatVehicleNumber(bus.vehicleId)} ${bus.routeName} ${bus.operatorName}`
    ).includes(term)
  );
}

export function findBuses(vehicles: LiveBusVehicle[], query: string): LiveBusVehicle[] {
  if (!query.trim()) return [];
  const code = normalizeDutyCode(query);
  return vehicles
    .filter((bus) => matchesBusQuery(bus, query))
    .sort((a, b) => {
      const exact = (bus: LiveBusVehicle) =>
        (bus.dutyStatus === "confirmed" &&
          Boolean(bus.dutyCode) &&
          normalizeDutyCode(bus.dutyCode ?? "") === code) ||
        formatVehicleNumber(bus.vehicleId).slice(1) === code ||
        bus.vehicleId === query.trim().replace(/^#/, "")
          ? 0
          : 1;
      return (
        exact(a) - exact(b) ||
        (a.dutyCode ?? "~").localeCompare(b.dutyCode ?? "~", "pl", { numeric: true })
      );
    });
}

export function serviceForDate(
  services: Array<{ serviceId: string; datesJson: number[] }>,
  dateKey: number,
  weekday: number
): string {
  return (
    services.find((service) => service.datesJson.includes(dateKey))?.serviceId ??
    (weekday === 7 ? "sunday" : weekday === 6 ? "saturday" : "weekday")
  );
}
