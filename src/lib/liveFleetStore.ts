import { useMemo, useSyncExternalStore } from "react";
import {
  getLatestFleetSnapshot,
  onRuntimeEvent,
  type LiveFleetSnapshot,
} from "./core/runtimeHub";
import { isPlannerOnlyLine } from "./core/text";
import type {
  LiveBusVehicle,
  LiveTrafficSummary,
  WalbrzychOperatorKey,
} from "./types";

const EMPTY_VEHICLES: LiveBusVehicle[] = [];

function singleVehicleSignature(vehicle: LiveBusVehicle): string {
  return (
    `${vehicle.vehicleId}:${vehicle.lat.toFixed(5)}:${vehicle.lon.toFixed(5)}:` +
    `${vehicle.delaySeconds}:${vehicle.speedKmh?.toFixed(1) ?? ""}:` +
    `${vehicle.routeName}:${vehicle.kursowka ?? ""}:${vehicle.bearing?.toFixed(0) ?? ""}:` +
    `${vehicle.tripId ?? ""}:${vehicle.upcomingStops[0]?.sequence ?? ""}:${vehicle.upcomingStops[0]?.scheduledDeparture ?? ""}`
  );
}

/**
 * Zwarty odcisk pozycji i stanu floty — identyczne ticki z API GPS
 * nie wywołują żadnego re-rendera ani drgania markerów.
 */
export function fleetSignature(vehicles: readonly LiveBusVehicle[]): string {
  return vehicles.map(singleVehicleSignature).join("|");
}

function trafficSignature(traffic: LiveTrafficSummary | null): string {
  if (!traffic) return "";
  return `${traffic.congestionLevel}:${traffic.recommendedPeakPercent}:${traffic.avgDelaySeconds}:${traffic.delayedCount}:${traffic.totalVehicles}`;
}

type Listener = () => void;

const vehicleListeners = new Set<Listener>();
const countListeners = new Set<Listener>();
const trafficListeners = new Set<Listener>();
const loadingListeners = new Set<Listener>();

let currentVehicles: LiveBusVehicle[] = EMPTY_VEHICLES;
let currentVehicleById = new Map<string, { sig: string; vehicle: LiveBusVehicle }>();
let currentVehicleSig = "";
let currentTraffic: LiveTrafficSummary | null = null;
let currentTrafficSig = "";
let currentLoading = false;
let initialized = false;

function notify(set: Set<Listener>): void {
  for (const listener of set) listener();
}

export function applyFleetSnapshotToStore(snapshot: LiveFleetSnapshot): void {
  const nextTrafficSig = trafficSignature(snapshot.traffic);
  if (nextTrafficSig !== currentTrafficSig) {
    currentTrafficSig = nextTrafficSig;
    currentTraffic = snapshot.traffic;
    notify(trafficListeners);
  }

  const nextVehicleSig = fleetSignature(snapshot.vehicles);
  if (nextVehicleSig === currentVehicleSig) return;
  const prevCount = currentVehicles.length;
  const nextById = new Map<string, { sig: string; vehicle: LiveBusVehicle }>();
  const stabilized = snapshot.vehicles.map((vehicle) => {
    const sig = singleVehicleSignature(vehicle);
    const prev = currentVehicleById.get(vehicle.vehicleId);
    if (prev && prev.sig === sig) {
      nextById.set(vehicle.vehicleId, prev);
      return prev.vehicle;
    }
    nextById.set(vehicle.vehicleId, { sig, vehicle });
    return vehicle;
  });
  currentVehicleById = nextById;
  currentVehicleSig = nextVehicleSig;
  currentVehicles = stabilized;
  notify(vehicleListeners);
  if (prevCount !== currentVehicles.length) {
    notify(countListeners);
  }
}

export function ensureLiveFleetStoreConnected(): void {
  if (initialized) return;
  initialized = true;
  const initial = getLatestFleetSnapshot();
  if (initial) {
    applyFleetSnapshotToStore(initial);
  }
  onRuntimeEvent("fleet:updated", ({ snapshot }) => {
    applyFleetSnapshotToStore(snapshot);
  });
  onRuntimeEvent("fleet:loading", (loading) => {
    if (loading === currentLoading) return;
    currentLoading = loading;
    notify(loadingListeners);
  });
}

function subscribeVehicles(listener: Listener): () => void {
  ensureLiveFleetStoreConnected();
  vehicleListeners.add(listener);
  return () => {
    vehicleListeners.delete(listener);
  };
}

function subscribeCount(listener: Listener): () => void {
  ensureLiveFleetStoreConnected();
  countListeners.add(listener);
  return () => {
    countListeners.delete(listener);
  };
}

function subscribeTraffic(listener: Listener): () => void {
  ensureLiveFleetStoreConnected();
  trafficListeners.add(listener);
  return () => {
    trafficListeners.delete(listener);
  };
}

function subscribeLoading(listener: Listener): () => void {
  ensureLiveFleetStoreConnected();
  loadingListeners.add(listener);
  return () => {
    loadingListeners.delete(listener);
  };
}

export function getLiveVehiclesSnapshot(): LiveBusVehicle[] {
  return currentVehicles;
}

export function getLiveBusCountSnapshot(): number {
  return currentVehicles.length;
}

export function getLiveTrafficSnapshot(): LiveTrafficSummary | null {
  return currentTraffic;
}

export function getLiveLoadingSnapshot(): boolean {
  return currentLoading;
}

export function filterVisibleLiveBuses(
  vehicles: LiveBusVehicle[],
  isPlanner: boolean,
  operatorFilter: "all" | WalbrzychOperatorKey,
): LiveBusVehicle[] {
  const base = isPlanner
    ? vehicles
    : vehicles.filter((v) => !isPlannerOnlyLine(v.routeName));
  return operatorFilter === "all"
    ? base
    : base.filter((v) => v.operatorKey === operatorFilter);
}

/** Subskrypcja pełnej listy pojazdów live (tylko dla komponentów, które faktycznie rysują autobusy). */
export function useLiveVehicles(): LiveBusVehicle[] {
  return useSyncExternalStore(
    subscribeVehicles,
    getLiveVehiclesSnapshot,
    () => EMPTY_VEHICLES,
  );
}

/** Subskrypcja przefiltrowanej listy widocznych autobusów (rola + operator). */
export function useVisibleLiveBuses(
  isPlanner: boolean,
  operatorFilter: "all" | WalbrzychOperatorKey,
): LiveBusVehicle[] {
  const vehicles = useLiveVehicles();
  return useMemo(
    () => filterVisibleLiveBuses(vehicles, isPlanner, operatorFilter),
    [vehicles, isPlanner, operatorFilter],
  );
}

/** Subskrypcja wyłącznie liczby autobusów — nie re-renderuje przy zwykłym ruchu GPS. */
export function useLiveBusCount(): number {
  return useSyncExternalStore(
    subscribeCount,
    getLiveBusCountSnapshot,
    () => 0,
  );
}

/** Subskrypcja zagregowanego stanu ruchu/opóźnień w sieci. */
export function useLiveTraffic(): LiveTrafficSummary | null {
  return useSyncExternalStore(
    subscribeTraffic,
    getLiveTrafficSnapshot,
    () => null,
  );
}

/** Subskrypcja wyłącznie zalecanego narzutu korkowego (%) dla wyliczeń rozkładu. */
export function useLiveTrafficPeakPercent(): number | undefined {
  return useSyncExternalStore(
    subscribeTraffic,
    () => currentTraffic?.recommendedPeakPercent,
    () => undefined,
  );
}

/** Subskrypcja stanu ładowania odświeżania GPS. */
export function useLiveLoading(): boolean {
  return useSyncExternalStore(
    subscribeLoading,
    getLiveLoadingSnapshot,
    () => false,
  );
}

/**
 * Subskrypcja jednego konkretnego pojazdu (np. karta wybranego autobusu).
 * Re-renderuje tylko, gdy ten jeden wóz pojawi się w nowym ticku.
 */
export function useLiveBusById(
  vehicleId: string | null,
  fallback: LiveBusVehicle | null = null,
): LiveBusVehicle | null {
  return useSyncExternalStore(
    subscribeVehicles,
    () => {
      if (!vehicleId) return null;
      return currentVehicleById.get(vehicleId)?.vehicle ?? fallback;
    },
    () => fallback,
  );
}
