import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getLatestFleetSnapshot,
  onRuntimeEvent,
  setFleetDemand,
  triggerFleetRefresh,
  type LiveFleetSnapshot,
} from "@/lib/core/runtimeHub";
import { isPlannerOnlyLine } from "@/lib/core/text";
import type {
  LiveBusVehicle,
  LiveTrafficSummary,
  WalbrzychOperatorKey,
} from "@/lib/types";

function fleetSignature(vehicles: LiveBusVehicle[]): string {
  return vehicles
    .map(
      (vehicle) =>
        `${vehicle.vehicleId}:${vehicle.lat.toFixed(5)}:${vehicle.lon.toFixed(5)}:` +
        `${vehicle.delaySeconds}:${vehicle.speedKmh?.toFixed(1) ?? ""}:` +
        `${vehicle.routeName}:${vehicle.kursowka ?? ""}:${vehicle.bearing?.toFixed(0) ?? ""}:` +
        `${vehicle.tripId ?? ""}:${vehicle.upcomingStops[0]?.sequence ?? ""}:${vehicle.upcomingStops[0]?.scheduledDeparture ?? ""}`,
    )
    .join("|");
}

function computeTrafficSignature(traffic: LiveTrafficSummary | null): string {
  if (!traffic) return "null";
  return [
    traffic.totalVehicles,
    traffic.trackedOnTripCount,
    traffic.avgDelaySeconds,
    traffic.maxDelaySeconds,
    traffic.delayedCount,
    traffic.onTimeCount,
    traffic.congestionLevel,
    traffic.recommendedPeakPercent,
    traffic.operatorBreakdown.mzuk,
    traffic.operatorBreakdown.ska,
  ].join("|");
}

export function useLiveFleetState({
  isPlanner,
  showLiveBuses,
  tripOpen,
  kursowkiOpen,
  hasSelectedStop,
}: {
  isPlanner: boolean;
  showLiveBuses: boolean;
  tripOpen: boolean;
  kursowkiOpen: boolean;
  hasSelectedStop: boolean;
}) {
  const [liveVehicles, setLiveVehicles] = useState<LiveBusVehicle[]>([]);
  const [liveTraffic, setLiveTraffic] = useState<LiveTrafficSummary | null>(
    null,
  );
  const [operatorFilter, setOperatorFilter] = useState<
    "all" | WalbrzychOperatorKey
  >("all");
  const [selectedLiveBus, setSelectedLiveBus] =
    useState<LiveBusVehicle | null>(null);

  const fetchLiveBuses = useCallback(async (force = false) => {
    await triggerFleetRefresh(force);
  }, []);

  useEffect(() => {
    let lastVehicleSig = "";
    let lastTrafficSig = "";

    const applySnapshot = (snapshot: LiveFleetSnapshot) => {
      const nextTrafficSig = computeTrafficSignature(snapshot.traffic);
      if (nextTrafficSig !== lastTrafficSig) {
        lastTrafficSig = nextTrafficSig;
        setLiveTraffic(snapshot.traffic);
      }

      const nextVehicleSig = fleetSignature(snapshot.vehicles);
      if (nextVehicleSig === lastVehicleSig) return;
      lastVehicleSig = nextVehicleSig;

      setLiveVehicles(snapshot.vehicles);
      setSelectedLiveBus((prev) =>
        prev
          ? snapshot.vehicles.find((v) => v.vehicleId === prev.vehicleId) ??
            prev
          : null,
      );
    };

    const initial = getLatestFleetSnapshot();
    if (initial) {
      applySnapshot(initial);
    }
    return onRuntimeEvent("fleet:updated", ({ snapshot }) => {
      applySnapshot(snapshot);
    });
  }, []);

  const hasSelectedLiveBus = Boolean(selectedLiveBus);
  const liveDemandActive =
    showLiveBuses || tripOpen || kursowkiOpen || hasSelectedStop;

  useEffect(() => {
    return setFleetDemand("workspace", {
      active: liveDemandActive,
      fast: hasSelectedLiveBus,
    });
  }, [liveDemandActive, hasSelectedLiveBus]);

  const visibleLiveBuses = useMemo(() => {
    const base = isPlanner
      ? liveVehicles
      : liveVehicles.filter((v) => !isPlannerOnlyLine(v.routeName));
    return operatorFilter === "all" || operatorFilter === "other"
      ? base
      : base.filter((v) => v.operatorKey === operatorFilter);
  }, [liveVehicles, operatorFilter, isPlanner]);

  return {
    liveVehicles,
    liveTraffic,
    operatorFilter,
    setOperatorFilter,
    selectedLiveBus,
    setSelectedLiveBus,
    fetchLiveBuses,
    visibleLiveBuses,
    hasLiveBuses: liveVehicles.length > 0,
  };
}
