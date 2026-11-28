import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapHandle } from "@/components/MapView";
import { subscribeSharedClock } from "@/lib/core/runtimeHub";
import { detectTrafficSignalsAlongRoute } from "@/lib/engine/trafficSignals";
import {
  detectTurnaroundSpotsAlongRoute,
  type TurnaroundSpot,
} from "@/lib/engine/turnarounds";
import { EMPTY_ROUTE, isWaypointSet } from "@/lib/data";
import {
  buildComparisons,
  fetchRoute,
  scaleRouteTimes,
} from "@/lib/geo";
import {
  buildPlanKey,
  buildSnapshot,
  snapshotSignature,
  writeSnapshot,
} from "@/lib/lastRoute";
import { calculateJourney, withJourney } from "@/lib/schedule";
import type {
  AvoidOptions,
  BrigadeInfo,
  LiveTrafficSummary,
  RouteData,
  ScheduleSettings,
  SpeedOverrides,
  TrafficSignalIntersection,
  VehicleId,
  VehicleProfile,
  Waypoint,
} from "@/lib/types";

export function usePlannerRouting({
  isPlanner,
  addMode,
  waypoints,
  avoid,
  vehicle,
  fleet,
  speeds,
  schedule,
  brigade,
  liveTraffic,
  mapRef,
  showToast,
  onCollapseMobileSheet,
}: {
  isPlanner: boolean;
  addMode: boolean;
  waypoints: Waypoint[];
  avoid: AvoidOptions;
  vehicle: VehicleId;
  fleet: VehicleProfile[];
  speeds: SpeedOverrides;
  schedule: ScheduleSettings;
  brigade: BrigadeInfo;
  liveTraffic: LiveTrafficSummary | null;
  mapRef: React.RefObject<MapHandle | null>;
  showToast: (message: string) => void;
  onCollapseMobileSheet: () => void;
}) {
  const [route, setRoute] = useState<RouteData>(() => EMPTY_ROUTE);
  const [resolvedKey, setResolvedKey] = useState("");
  const [routingError, setRoutingError] = useState("");
  const [isRouting, setIsRouting] = useState(false);
  const [fitNonce, setFitNonce] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const [clockNow, setClockNow] = useState(() => Date.now());

  const [trafficSignals, setTrafficSignals] = useState<
    TrafficSignalIntersection[]
  >([]);
  const [signalsLoading, setSignalsLoading] = useState(false);
  const [turnaroundSpots, setTurnaroundSpots] = useState<TurnaroundSpot[]>([]);

  const [navActive, setNavActive] = useState(false);
  const [navPlaying, setNavPlaying] = useState(false);
  const [navProgress, setNavProgress] = useState(0);

  const requestIdRef = useRef(0);
  const pendingFitRef = useRef(false);
  const arrivalToastRef = useRef(false);
  const lastSavedSignatureRef = useRef("");
  const skipNextRouteKeyRef = useRef<string | null>(null);
  const bootPlanKeyRef = useRef<string | null>(null);

  const waypointsRef = useRef(waypoints);
  waypointsRef.current = waypoints;
  const avoidRef = useRef(avoid);
  avoidRef.current = avoid;

  const readyForRouting =
    waypoints.length >= 2 && waypoints.every(isWaypointSet);
  const assignedCount = useMemo(
    () => waypoints.filter(isWaypointSet).length,
    [waypoints],
  );

  const planKey = buildPlanKey(waypoints, avoid);
  const routeReady =
    isPlanner &&
    readyForRouting &&
    resolvedKey === planKey &&
    route.engine === "osrm" &&
    !isRouting &&
    !addMode &&
    !routingError;

  const activeRoute =
    isPlanner && route.engine === "osrm" && route.coords.length >= 2
      ? route
      : EMPTY_ROUTE;

  useEffect(() => {
    if (!isPlanner) return;
    return subscribeSharedClock(30_000, setClockNow);
  }, [isPlanner]);

  useEffect(() => {
    if (activeRoute.coords.length < 2) {
      setTrafficSignals([]);
      return;
    }
    const controller = new AbortController();
    setSignalsLoading(true);
    detectTrafficSignalsAlongRoute(activeRoute.coords, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) {
          setTrafficSignals(res.intersections);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setTrafficSignals([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSignalsLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [activeRoute.coords]);

  const activeVehicle = fleet.find((item) => item.id === vehicle) ?? fleet[0];
  const turnaroundsActive =
    isPlanner &&
    (activeVehicle?.lengthM ?? 0) >= 12 &&
    activeRoute.coords.length >= 2;

  useEffect(() => {
    if (!turnaroundsActive) {
      setTurnaroundSpots([]);
      return;
    }
    const controller = new AbortController();
    detectTurnaroundSpotsAlongRoute(activeRoute.coords, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) setTurnaroundSpots(res.spots);
      })
      .catch(() => {
        if (!controller.signal.aborted) setTurnaroundSpots([]);
      });
    return () => controller.abort();
  }, [turnaroundsActive, activeRoute.coords]);

  const baseComparisons = useMemo(
    () => buildComparisons(activeRoute, undefined, avoid, speeds),
    [activeRoute, avoid, speeds, fleet],
  );

  const scheduleContext = useMemo(
    () => ({
      signalCount: trafficSignals.length,
      liveDelayPercent: liveTraffic?.recommendedPeakPercent,
    }),
    [trafficSignals.length, liveTraffic?.recommendedPeakPercent],
  );

  const scheduledProfiles = useMemo(
    () =>
      baseComparisons.map((metric) => {
        const evaluation = calculateJourney(
          metric.duration,
          schedule,
          clockNow,
          scheduleContext,
        );
        return { metric: withJourney(metric, evaluation), evaluation };
      }),
    [baseComparisons, schedule, clockNow, scheduleContext],
  );

  const comparisons = useMemo(
    () => scheduledProfiles.map((item) => item.metric),
    [scheduledProfiles],
  );
  const activePlan =
    scheduledProfiles.find((item) => item.metric.id === vehicle) ??
    scheduledProfiles[0];
  const metrics = activePlan.metric;
  const scheduleEvaluation = activePlan.evaluation;

  const exportReady = routeReady && !!metrics.journey;
  const navigationRoute = useMemo(
    () => scaleRouteTimes(activeRoute, metrics.duration),
    [activeRoute, metrics.duration],
  );

  useEffect(() => {
    if (!routeReady || addMode) return;
    const snapshot = buildSnapshot({
      waypoints,
      vehicle,
      fleet,
      speeds,
      schedule,
      avoid,
      brigade,
      route,
    });
    const signature = snapshotSignature(snapshot);
    if (signature === lastSavedSignatureRef.current) return;
    lastSavedSignatureRef.current = signature;
    writeSnapshot(snapshot);
  }, [
    routeReady,
    addMode,
    planKey,
    route,
    waypoints,
    vehicle,
    fleet,
    speeds,
    schedule,
    avoid,
    brigade,
  ]);

  useEffect(() => {
    if (!isPlanner) return;
    if (skipNextRouteKeyRef.current === planKey) {
      skipNextRouteKeyRef.current = null;
      return;
    }
    if (bootPlanKeyRef.current === planKey && refreshTick === 0) {
      return;
    }
    bootPlanKeyRef.current = null;

    if (addMode || !readyForRouting) {
      requestIdRef.current += 1;
      setIsRouting(false);
      setRoutingError("");
      setRoute(EMPTY_ROUTE);
      setResolvedKey("");
      setTrafficSignals([]);
      return;
    }

    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    setIsRouting(true);
    setRoutingError("");
    const timer = window.setTimeout(() => {
      fetchRoute({
        waypoints: waypointsRef.current,
        avoid: avoidRef.current,
        signal: controller.signal,
      })
        .then((data) => {
          if (controller.signal.aborted || requestId !== requestIdRef.current) {
            return;
          }
          setRoute(data);
          setResolvedKey(planKey);
          if (pendingFitRef.current) {
            pendingFitRef.current = false;
            setFitNonce((current) => current + 1);
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || requestId !== requestIdRef.current) {
            return;
          }
          setRoute(EMPTY_ROUTE);
          setResolvedKey("");
          setTrafficSignals([]);
          setRoutingError(
            error instanceof Error
              ? error.message
              : "Nie udało się pobrać trasy. Spróbuj ponownie.",
          );
        })
        .finally(() => {
          if (
            !controller.signal.aborted &&
            requestId === requestIdRef.current
          ) {
            setIsRouting(false);
          }
        });
    }, 650);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [isPlanner, planKey, refreshTick, addMode, readyForRouting]);

  useEffect(() => {
    if (!navActive || !navPlaying) return;
    const interval = window.setInterval(() => {
      setNavProgress((current) => Math.min(1, current + 0.0055));
    }, 170);
    return () => window.clearInterval(interval);
  }, [navActive, navPlaying]);

  useEffect(() => {
    if (navActive && navProgress >= 1 && !arrivalToastRef.current) {
      arrivalToastRef.current = true;
      setNavPlaying(false);
      showToast("Dojechałeś do celu. Dziękujemy za podróż!");
    }
    if (!navActive) arrivalToastRef.current = false;
  }, [navActive, navProgress, showToast]);

  const stopNavigation = useCallback(() => {
    setNavActive(false);
    setNavPlaying(false);
    setNavProgress(0);
    arrivalToastRef.current = false;
  }, []);

  const startNavigation = useCallback(() => {
    if (!exportReady) {
      showToast("Najpierw wyznacz aktualną trasę i podaj poprawny termin.");
      return;
    }
    arrivalToastRef.current = false;
    setNavProgress(0);
    setNavActive(true);
    setNavPlaying(true);
    onCollapseMobileSheet();
    const start = waypointsRef.current[0];
    if (isWaypointSet(start)) mapRef.current?.centerOn(start.lat, start.lon, 13);
    showToast("Podgląd nawigacji uruchomiony.");
  }, [exportReady, showToast, onCollapseMobileSheet, mapRef]);

  const toggleNavigation = useCallback(() => {
    if (!navActive) {
      startNavigation();
      return;
    }
    setNavPlaying((current) => !current);
  }, [navActive, startNavigation]);

  const queueFitOnNextRoute = useCallback(() => {
    pendingFitRef.current = true;
  }, []);

  const resetRoutingState = useCallback(
    (opts?: { clearSavedSignature?: boolean; cancelPendingFit?: boolean }) => {
      requestIdRef.current += 1;
      bootPlanKeyRef.current = null;
      if (opts?.cancelPendingFit) pendingFitRef.current = false;
      if (opts?.clearSavedSignature) lastSavedSignatureRef.current = "";
      setRoutingError("");
      setRoute(EMPTY_ROUTE);
      setResolvedKey("");
      setTrafficSignals([]);
    },
    [],
  );

  const requestRouteRecalculate = useCallback(() => {
    if (!readyForRouting) {
      showToast("Wybierz najpierw punkt startowy A i metę B.");
      return;
    }
    pendingFitRef.current = true;
    setIsRouting(true);
    setRefreshTick((current) => current + 1);
  }, [readyForRouting, showToast]);

  const saveCurrentRouteSnapshot = useCallback(() => {
    if (!routeReady) {
      showToast("Najpierw wyznacz poprawną trasę, aby zapisać ostatni plan.");
      return;
    }
    const snapshot = buildSnapshot({
      waypoints,
      vehicle,
      fleet,
      speeds,
      schedule,
      avoid,
      brigade,
      route,
    });
    if (writeSnapshot(snapshot)) {
      lastSavedSignatureRef.current = snapshotSignature(snapshot);
      showToast("Ostatnia wyznaczona trasa zapisana w tej przeglądarce.");
    } else {
      showToast("Nie udało się zapisać trasy.");
    }
  }, [
    routeReady,
    waypoints,
    vehicle,
    fleet,
    speeds,
    schedule,
    avoid,
    brigade,
    route,
    showToast,
  ]);

  const applySavedBrigadeRoute = useCallback(
    (nextWaypoints: Waypoint[], nextAvoid: AvoidOptions, savedRoute?: RouteData) => {
      setRoutingError("");
      bootPlanKeyRef.current = null;
      const currentPlanKey = buildPlanKey(waypointsRef.current, avoidRef.current);
      const nextPlanKey = buildPlanKey(nextWaypoints, nextAvoid);
      if (
        savedRoute &&
        savedRoute.engine === "osrm" &&
        savedRoute.coords.length >= 2
      ) {
        if (nextPlanKey !== currentPlanKey) {
          skipNextRouteKeyRef.current = nextPlanKey;
        }
        setRoute(savedRoute);
        setResolvedKey(nextPlanKey);
        setFitNonce((current) => current + 1);
      } else {
        setRoute(EMPTY_ROUTE);
        setResolvedKey("");
        setTrafficSignals([]);
        pendingFitRef.current = true;
      }
    },
    [],
  );

  const refreshClockNow = useCallback(() => {
    setClockNow(Date.now());
  }, []);

  return {
    route,
    routingError,
    isRouting,
    fitNonce,
    clockNow,
    refreshClockNow,
    trafficSignals,
    signalsLoading,
    turnaroundSpots,
    activeVehicle,
    readyForRouting,
    assignedCount,
    routeReady,
    activeRoute,
    comparisons,
    metrics,
    scheduleEvaluation,
    exportReady,
    navigationRoute,
    navActive,
    navPlaying,
    navProgress,
    stopNavigation,
    startNavigation,
    toggleNavigation,
    queueFitOnNextRoute,
    resetRoutingState,
    requestRouteRecalculate,
    saveCurrentRouteSnapshot,
    applySavedBrigadeRoute,
  };
}
