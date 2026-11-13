import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Route as RouteIcon } from "lucide-react";
import type { KursowkaShapeOverlay, MapHandle } from "./MapView";
import PlanningPanel from "./PlanningPanel";
import TopBar from "./TopBar";
import KursowkiDialog from "./KursowkiDialog";
import {
  BusStopCard,
  LiveBusCard,
  LiveFleetControl,
  MapContextMenu,
  MapControls,
  MapDrawingBanner,
  MapRouteCard,
  MobilePlannerSheet,
  NavigationHud,
  PickBanner,
  QuickComparison,
} from "./MapOverlays";
import {
  FleetDialog,
  ReportDialog,
  SettingsDialog,
  StepsDrawer,
  Toast,
} from "./Modals";
import PdfExportDialog from "./PdfExportDialog";
import {
  loadVisibility,
  saveVisibility,
  type VisibilitySettings,
  type VisibilityToggleKey,
} from "@/lib/visibility";
import TripPlannerPanel from "./TripPlannerPanel";
import {
  journeyToMapGeometry,
  type Journey,
  type JourneyPoint as TripPoint,
} from "@/lib/journeyPlanner";
import type { TripMapPlan } from "./MapView";
import { APP_NAME, APP_TITLE, TRAVELER_TITLE } from "@/config/branding";
import {
  cleanBrigade,
  formatBrigadeTitle,
  hasBrigade,
  loadBrigade,
  loadSavedBrigades,
  persistSavedBrigades,
  saveBrigade,
  type SavedBrigadePlan,
} from "@/lib/brigade";
import {
  createEmptyWaypoint,
  createInitialWaypoints,
  DEFAULT_BUS_SPEED,
  EMPTY_ROUTE,
  isWaypointSet,
} from "@/lib/data";
import {
  fetchBusStops,
  filterStops,
  stopDisplayName,
  WALBRZYCH_BOUNDS,
  WALBRZYCH_CENTER,
  WALBRZYCH_ZOOM,
  type Bounds,
} from "@/lib/busStops";
import { setOperatorOverride } from "@/lib/engine/fleetOperators";
import { getLiveWalbrzychBuses } from "@/lib/engine/gtfsRt";
import { ensureGtfsSeeded } from "@/lib/engine/gtfsStore";
import { detectTrafficSignalsAlongRoute } from "@/lib/engine/trafficSignals";
import { detectTurnaroundSpotsAlongRoute, type TurnaroundSpot } from "@/lib/engine/turnarounds";
import {
  buildComparisons,
  currentStepForProgress,
  estimateAverageSpeed,
  fetchRoute,
  formatDistance,
  formatDuration,
  haversine,
  insertionSlot,
  isValidSpeed,
  pointAtProgress,
  reverseGeocode,
  scaleRouteTimes,
  stopsAlongRoute,
} from "@/lib/geo";
import {
  calculateJourney,
  defaultSchedule,
  scheduleSummaryLines,
  SCHEDULE_STORAGE_KEY,
  withJourney,
} from "@/lib/schedule";
import {
  buildPlanKey,
  buildSnapshot,
  cleanSpeeds,
  clearLastRoute,
  defaultSpeedMap,
  loadLastRoute,
  snapshotSignature,
  SPEEDS_KEY,
  writeSnapshot,
  type LastRouteSnapshot,
} from "@/lib/lastRoute";
import { FLEET_STORAGE_KEY, replaceFleet } from "@/lib/fleet";
import {
  MAX_WAYPOINTS,
  type AppRole,
  type AvoidOptions,
  type BrigadeInfo,
  type BusStop,
  type LiveBusVehicle,
  type LiveTrafficSummary,
  type MapStyle,
  type Place,
  type RouteData,
  type RouteStep,
  type ScheduleSettings,
  type SpeedOverrides,
  type ThemeMode,
  type TrafficSignalIntersection,
  type VehicleId,
  type VehicleProfile,
  type WalbrzychOperatorKey,
  type Waypoint,
} from "@/lib/types";

const MapView = lazy(() => import("./MapView"));

const THEME_STORAGE_KEY = "mapplaner.theme";
const ROLE_STORAGE_KEY = "mapplaner.role";

function loadRole(): AppRole {
  // The app boots as a regular traveler; only a stored (logged-in) planner
  // session starts the full planner version.
  try {
    return typeof window !== "undefined" && localStorage.getItem(ROLE_STORAGE_KEY) === "planner"
      ? "planner"
      : "traveler";
  } catch {
    return "traveler";
  }
}

interface MapContextMenuState {
  lat: number;
  lon: number;
  left: number;
  top: number;
}

const waypointId = () =>
  `wp-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;

function loadTheme(): ThemeMode {
  try {
    return typeof window !== "undefined" && localStorage.getItem(THEME_STORAGE_KEY) === "light"
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}

const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    } catch {
      return false;
    }
  }
};

const subscribeToHydration = () => () => {};

export default function MapPlanerApp() {
  const mounted = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  if (!mounted) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-canvas text-ink" role="status">
        <div className="text-center">
          {loadRole() === "planner" && (
            <p className="mb-2 text-xl font-extrabold tracking-tight">{APP_NAME}</p>
          )}
          <p className="text-xs text-mute">Ładowanie mapy i kursówek Wałbrzych…</p>
        </div>
      </div>
    );
  }
  return <MapPlanerWorkspace />;
}

function MapPlanerWorkspace() {
  // Every visit starts with an empty route. The saved snapshot still fills fleet,
  // speeds, schedule and brigade, but route points and geometry are never restored.
  const [boot] = useState<LastRouteSnapshot | null>(() => loadLastRoute());
  const initialWaypoints = createInitialWaypoints();
  const [fleet, setFleet] = useState<VehicleProfile[]>(() => replaceFleet(boot?.fleet));
  const initialVehicle =
    boot?.vehicle && fleet.some((item) => item.id === boot.vehicle)
      ? boot.vehicle
      : fleet[0]?.id ?? "";

  const [isDesktop, setIsDesktop] = useState(() => true);
  const [role, setRole] = useState<AppRole>(() => loadRole());
  const isPlanner = role === "planner";
  const [theme, setTheme] = useState<ThemeMode>(() => loadTheme());
  const [mapStyle, setMapStyle] = useState<MapStyle>(() =>
    loadTheme() === "dark" ? "dark" : "light"
  );
  const [brigade, setBrigade] = useState<BrigadeInfo>(() => boot?.brigade ?? loadBrigade());
  const [savedBrigades, setSavedBrigades] = useState<SavedBrigadePlan[]>(() =>
    loadSavedBrigades()
  );
  const [waypoints, setWaypoints] = useState<Waypoint[]>(initialWaypoints);
  const [vehicle, setVehicle] = useState<VehicleId>(initialVehicle);
  const [avoid, setAvoid] = useState<AvoidOptions>(
    boot?.avoid ?? { tolls: false, ferries: false, unpaved: false }
  );
  const [speeds, setSpeeds] = useState<SpeedOverrides>(
    () => boot?.speeds ?? defaultSpeedMap(fleet)
  );
  const [schedule, setSchedule] = useState<ScheduleSettings>(
    () => boot?.schedule ?? defaultSchedule()
  );
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [route, setRoute] = useState<RouteData>(() => EMPTY_ROUTE);
  const [resolvedKey, setResolvedKey] = useState("");

  // Bus stops
  const [busStops, setBusStops] = useState<BusStop[]>([]);
  const [busLoading, setBusLoading] = useState(false);
  const [busError, setBusError] = useState("");
  const [busQuery, setBusQuery] = useState("");
  const [stopScope, setStopScope] = useState<"all" | "near" | "used">("all");
  const [busScope, setBusScope] = useState("Wałbrzych i okolice");
  const [busSeconds, setBusSeconds] = useState(0);
  // Visibility preferences never hide the mandatory line, direction, speed or delay.
  const [visibility, setVisibility] = useState<VisibilitySettings>(() => loadVisibility());
  const updateVisibility = useCallback(
    (patch: Partial<VisibilitySettings>) =>
      setVisibility((current) => ({ ...current, ...patch })),
    []
  );
  const toggleVisibility = useCallback(
    (key: VisibilityToggleKey) =>
      setVisibility((current) => ({ ...current, [key]: !current[key] })),
    []
  );
  const stopDisplay = visibility.stops;
  const showLiveBuses = visibility.liveBuses;
  const showTrafficSignals = visibility.trafficSignals;
  const showTurnarounds = visibility.turnarounds;
  const [selectedStop, setSelectedStop] = useState<BusStop | null>(null);
  const [contextMenu, setContextMenu] = useState<MapContextMenuState | null>(null);

  // Planer podróży dla pasażera (kolorowy doradca "do jakiego wozu wejść")
  const [tripOpen, setTripOpen] = useState(false);
  const [tripPick, setTripPick] = useState<"origin" | "destination" | null>(null);
  const [tripOrigin, setTripOrigin] = useState<TripPoint | null>(null);
  const [tripDest, setTripDest] = useState<TripPoint | null>(null);
  const [tripPreview, setTripPreview] = useState<Journey | null>(null);
  const [tripNonce, setTripNonce] = useState(0);

  useEffect(() => {
    if (!tripPick) return;
    const cancelPick = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTripPick(null);
    };
    window.addEventListener("keydown", cancelPick);
    return () => window.removeEventListener("keydown", cancelPick);
  }, [tripPick]);

  const updateTripOrigin = useCallback((point: TripPoint | null) => {
    setTripOrigin(point);
    setTripPreview(null);
  }, []);
  const updateTripDest = useCallback((point: TripPoint | null) => {
    setTripDest(point);
    setTripPreview(null);
  }, []);

  /** Geometria planu dla mapy: start, cel, odcinki piesze i autobusowe, przesiadki. */
  const tripMapPlan = useMemo<TripMapPlan | null>(() => {
    if (!tripOpen || isPlanner) return null;
    if (!tripOrigin && !tripDest) return null;
    const geometry = tripPreview ? journeyToMapGeometry(tripPreview) : { legs: [], markers: [] };
    return {
      origin: tripOrigin,
      destination: tripDest,
      legs: geometry.legs,
      markers: geometry.markers,
      key: tripPreview?.id ?? "points",
    };
  }, [tripOpen, isPlanner, tripOrigin, tripDest, tripPreview]);

  // Traffic signals along route
  const [trafficSignals, setTrafficSignals] = useState<TrafficSignalIntersection[]>([]);
  const [signalsLoading, setSignalsLoading] = useState(false);

  // Turn-around spots for long vehicles (12 m+): roundabouts and large crossings only
  const [turnaroundSpots, setTurnaroundSpots] = useState<TurnaroundSpot[]>([]);

  // Live GPS Wałbrzych buses (MZUK, ŚKA)
  const [liveVehicles, setLiveVehicles] = useState<LiveBusVehicle[]>([]);
  const [liveTraffic, setLiveTraffic] = useState<LiveTrafficSummary | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [operatorFilter, setOperatorFilter] = useState<"all" | WalbrzychOperatorKey>("all");
  const [selectedLiveBus, setSelectedLiveBus] = useState<LiveBusVehicle | null>(null);

  // Kursówki dialog & shape overlay
  const [kursowkiOpen, setKursowkiOpen] = useState(false);
  const [kursowkaDeepLink, setKursowkaDeepLink] = useState<{
    id?: string | null;
    code?: string | null;
  }>({});
  const [kursowkaOverlay, setKursowkaOverlay] = useState<KursowkaShapeOverlay | null>(null);

  // Route editing & dialogs
  const [addMode, setAddMode] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [routingError, setRoutingError] = useState("");
  const [isRouting, setIsRouting] = useState(false);
  const [fitNonce, setFitNonce] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const [clearNonce, setClearNonce] = useState(0);
  const [mobileExpanded, setMobileExpanded] = useState(false);

  const [stepsOpen, setStepsOpen] = useState(false);
  const [fleetOpen, setFleetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const openInformation = useCallback(() => {
    if (isPlanner) setSettingsOpen(true);
  }, [isPlanner]);

  const [navActive, setNavActive] = useState(false);
  const [navPlaying, setNavPlaying] = useState(false);
  const [navProgress, setNavProgress] = useState(0);
  const [pickTarget, setPickTarget] = useState<string | null>(null);
  const [focus, setFocus] = useState<{
    lat: number;
    lon: number;
    zoom?: number;
    nonce: number;
  } | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const mapRef = useRef<MapHandle | null>(null);
  const mapAreaRef = useRef<HTMLElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);
  const pendingFitRef = useRef(false);
  const busAbortRef = useRef<AbortController | null>(null);
  const arrivalToastRef = useRef(false);
  const lastSavedSignatureRef = useRef("");
  const skipNextRouteKeyRef = useRef<string | null>(null);
  const bootPlanKeyRef = useRef<string | null>(null);
  const resolvedKeyRef = useRef("");

  const waypointsRef = useRef(waypoints);
  waypointsRef.current = waypoints;
  const avoidRef = useRef(avoid);
  avoidRef.current = avoid;

  const showToast = useCallback((message: string) => setToastMessage(message), []);
  const closeToast = useCallback(() => setToastMessage(null), []);

  // Poll live GPS Wałbrzych buses every 5s (jedno zapytanie zwraca całą flotę)
  const fetchLiveBuses = useCallback(async (force = false) => {
    setLiveLoading(true);
    try {
      const data = await getLiveWalbrzychBuses(force);
      setLiveVehicles(data.vehicles);
      setLiveTraffic(data.traffic);
      setSelectedLiveBus((prev) =>
        prev ? data.vehicles.find((v) => v.vehicleId === prev.vehicleId) ?? prev : null
      );
    } catch {
      // Keep last known positions
    } finally {
      setLiveLoading(false);
    }
  }, []);

  const hasSelectedLiveBus = Boolean(selectedLiveBus);
  useEffect(() => {
    // Pozycje flotowe: 3 s (jedno zapytanie zwraca całą flotę).
    // Ukryta karta przeglądarki wstrzymuje odświeżanie — oszczędza łącze i baterię.
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      void fetchLiveBuses();
    }, 3_000);
    // Otwarta karta wozu: dodatkowe wymuszone odświeżenie co 2 s, by pozycja
    // i punktualność były płynne (cache 3 s + dedup zapytań nie dopuszczą dubli).
    const fast = hasSelectedLiveBus
      ? window.setInterval(() => {
          if (document.hidden) return;
          void fetchLiveBuses(true);
        }, 2_000)
      : null;

    const onResume = () => {
      if (!document.hidden) void fetchLiveBuses(true);
    };
    document.addEventListener("visibilitychange", onResume);

    return () => {
      window.clearInterval(interval);
      if (fast !== null) window.clearInterval(fast);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [fetchLiveBuses, hasSelectedLiveBus]);

  // Trigger initial client-side GTFS seed check once
  useEffect(() => {
    void ensureGtfsSeeded().catch(() => undefined);
  }, []);

  // Deep links: #/walbrzych/brigades/2?date=YYYYMMDD
  useEffect(() => {
    if (window.location.hash.includes("/walbrzych/brigades/")) {
      setKursowkiOpen(true);
    }
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const dismissOutside = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null);
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    const dismissViewportChange = () => setContextMenu(null);
    document.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("keydown", dismissEscape);
    window.addEventListener("resize", dismissViewportChange);
    window.addEventListener("wheel", dismissViewportChange, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("keydown", dismissEscape);
      window.removeEventListener("resize", dismissViewportChange);
      window.removeEventListener("wheel", dismissViewportChange);
    };
  }, [contextMenu]);

  const readyForRouting = waypoints.length >= 2 && waypoints.every(isWaypointSet);
  const assignedCount = useMemo(() => waypoints.filter(isWaypointSet).length, [waypoints]);

  const planKey = buildPlanKey(waypoints, avoid);
  const routeReady =
    isPlanner &&
    readyForRouting &&
    resolvedKey === planKey &&
    route.engine === "osrm" &&
    !isRouting &&
    !addMode &&
    !routingError;
  // The drawn route stays visible while a recalculation is in flight (as a preview) so the
  // line can keep being dragged / clicked to add points; it is only removed on an explicit
  // clear or a routing failure. Travelers never see a planned route.
  const activeRoute =
    isPlanner && route.engine === "osrm" && route.coords.length >= 2 ? route : EMPTY_ROUTE;

  // Detect traffic signals whenever route geometry updates
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
    isPlanner && (activeVehicle?.lengthM ?? 0) >= 12 && activeRoute.coords.length >= 2;
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
    [activeRoute, avoid, speeds, fleet]
  );

  const scheduleContext = useMemo(
    () => ({
      signalCount: trafficSignals.length,
      liveDelayPercent: liveTraffic?.recommendedPeakPercent,
    }),
    [trafficSignals.length, liveTraffic?.recommendedPeakPercent]
  );

  const scheduledProfiles = useMemo(
    () =>
      baseComparisons.map((metric) => {
        const evaluation = calculateJourney(metric.duration, schedule, clockNow, scheduleContext);
        return { metric: withJourney(metric, evaluation), evaluation };
      }),
    [baseComparisons, schedule, clockNow, scheduleContext]
  );

  const comparisons = useMemo(
    () => scheduledProfiles.map((item) => item.metric),
    [scheduledProfiles]
  );
  const activePlan =
    scheduledProfiles.find((item) => item.metric.id === vehicle) ?? scheduledProfiles[0];
  const metrics = activePlan.metric;
  const scheduleEvaluation = activePlan.evaluation;

  const exportReady = routeReady && !!metrics.journey;
  const navigationRoute = useMemo(
    () => scaleRouteTimes(activeRoute, metrics.duration),
    [activeRoute, metrics.duration]
  );
  const visibleStops = useMemo(() => filterStops(busStops, busQuery), [busStops, busQuery]);
  const visibleLiveBuses = useMemo(
    () =>
      operatorFilter === "all"
        ? liveVehicles
        : liveVehicles.filter((v) => v.operatorKey === operatorFilter),
    [liveVehicles, operatorFilter]
  );

  const usedStopKeys = useMemo(
    () =>
      new Set(
        waypoints
          .filter(isWaypointSet)
          .map((point) => `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`)
      ),
    [waypoints]
  );
  const nearRoute = useMemo(() => {
    if (activeRoute.coords.length < 2) return new Map<string, number>();
    return new Map(
      stopsAlongRoute(busStops, activeRoute.coords, 70).map((item) => [item.stop.id, item.distance])
    );
  }, [busStops, activeRoute.coords]);
  const nearRouteIds = useMemo(() => new Set(nearRoute.keys()), [nearRoute]);
  const mapStops = useMemo(() => {
    if (stopDisplay === "off") return [];
    if (stopDisplay === "route") return visibleStops.filter((stop) => nearRouteIds.has(stop.id));
    return visibleStops;
  }, [stopDisplay, visibleStops, nearRouteIds]);
  const selectedStopInRoute = Boolean(
    selectedStop &&
      usedStopKeys.has(`${selectedStop.lat.toFixed(5)},${selectedStop.lon.toFixed(5)}`)
  );

  useEffect(() => {
    replaceFleet(fleet);
    try {
      localStorage.setItem(FLEET_STORAGE_KEY, JSON.stringify(fleet));
    } catch {
      /* Storage optional */
    }
  }, [fleet]);

  useEffect(() => {
    try {
      localStorage.setItem(SPEEDS_KEY, JSON.stringify(cleanSpeeds(speeds, fleet)));
    } catch {
      /* Storage optional */
    }
  }, [speeds, fleet]);

  useEffect(() => {
    try {
      localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(schedule));
    } catch {
      /* Storage optional */
    }
  }, [schedule]);

  useEffect(() => {
    saveBrigade(brigade);
  }, [brigade]);

  useEffect(() => {
    persistSavedBrigades(savedBrigades);
  }, [savedBrigades]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

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
  }, [routeReady, addMode, planKey, route, waypoints, vehicle, fleet, speeds, schedule, avoid, brigade]);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDesktop(event.matches);
      if (event.matches) setMobileExpanded(false);
    };
    setIsDesktop(query.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* Storage optional */
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(ROLE_STORAGE_KEY, role);
    } catch {
      /* Storage optional */
    }
    // Planer podróży jest widżetem pasażera — planista ma własne narzędzia.
    if (role === "planner") {
      setTripOpen(false);
      setTripPick(null);
    }
  }, [role]);

  // The browser tab names the planner only for a logged-in planner.
  useEffect(() => {
    document.title = isPlanner ? APP_TITLE : TRAVELER_TITLE;
  }, [isPlanner]);

  useEffect(() => {
    saveVisibility(visibility);
  }, [visibility]);

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
      resolvedKeyRef.current = "";
      setIsRouting(false);
      setRoutingError("");
      setRoute(EMPTY_ROUTE);
      setResolvedKey("");
      setTrafficSignals([]);
      return;
    }

    // Keep the previously drawn route visible as a preview until OSRM responds
    // (or fails) — clearing it here would flash the map blank and block adding
    // further points by dragging the line.

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
          if (controller.signal.aborted || requestId !== requestIdRef.current) return;
          resolvedKeyRef.current = planKey;
          setRoute(data);
          setResolvedKey(planKey);
          if (pendingFitRef.current) {
            pendingFitRef.current = false;
            setFitNonce((current) => current + 1);
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || requestId !== requestIdRef.current) return;
          resolvedKeyRef.current = "";
          setRoute(EMPTY_ROUTE);
          setResolvedKey("");
          setTrafficSignals([]);
          setRoutingError(
            error instanceof Error
              ? error.message
              : "Nie udało się pobrać trasy. Spróbuj ponownie."
          );
        })
        .finally(() => {
          if (!controller.signal.aborted && requestId === requestIdRef.current) {
            setIsRouting(false);
          }
        });
    }, 650);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [planKey, refreshTick, addMode, readyForRouting]);

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

  const handleRoleChange = (next: AppRole) => {
    if (next === role) return;
    stopNavigation();
    setAddMode(false);
    setPickTarget(null);
    setContextMenu(null);
    setSelectedStop(null);
    setSelectedLiveBus(null);
    setKursowkiOpen(false);
    // The information window is available only to a logged-in planner.
    setSettingsOpen(false);
    setRole(next);
    showToast(
      next === "planner"
        ? "Zalogowano jako Planista: pełny planer tras, PDF, raporty i flota."
        : "Wylogowano. Profil Podróżnego: mapa, przystanki, GPS i rozkład."
    );
  };

  const startNavigation = useCallback(() => {
    if (!exportReady) {
      showToast("Najpierw wyznacz aktualną trasę i podaj poprawny termin.");
      return;
    }
    arrivalToastRef.current = false;
    setNavProgress(0);
    setNavActive(true);
    setNavPlaying(true);
    setMobileExpanded(false);
    const start = waypointsRef.current[0];
    if (isWaypointSet(start)) mapRef.current?.centerOn(start.lat, start.lon, 13);
    showToast("Podgląd nawigacji uruchomiony.");
  }, [showToast, exportReady]);

  const toggleNavigation = useCallback(() => {
    if (!navActive) {
      startNavigation();
      return;
    }
    setNavPlaying((current) => !current);
  }, [navActive, startNavigation]);

  const loadBusStops = useCallback(async (bounds: Bounds, scope: string, force = false) => {
    busAbortRef.current?.abort();
    const controller = new AbortController();
    busAbortRef.current = controller;
    setBusLoading(true);
    setBusError("");
    setBusSeconds(0);
    try {
      const stops = await fetchBusStops(bounds, {
        signal: controller.signal,
        force,
        onProgress: setBusSeconds,
      });
      if (controller.signal.aborted) return;
      setBusStops(stops);
      setBusScope(scope);
      if (!stops.length) {
        setBusError("Brak przystanków obsługiwanych przez autobusy i kursówki w tym obszarze.");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setBusError(
        error instanceof Error ? error.message : "Nie udało się pobrać przystanków."
      );
    } finally {
      if (!controller.signal.aborted) setBusLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBusStops(WALBRZYCH_BOUNDS, "Wałbrzych i okolice");
    return () => busAbortRef.current?.abort();
  }, [loadBusStops]);

  const refreshBusStops = useCallback(() => {
    const bounds = mapRef.current?.getBounds();
    if (!bounds) return;
    setSelectedStop(null);
    void loadBusStops(bounds, "Bieżący widok mapy", true);
  }, [loadBusStops]);

  const selectBusStop = useCallback((stop: BusStop, center: boolean) => {
    setSelectedLiveBus(null);
    setSelectedStop((current) => (current?.id === stop.id ? null : stop));
    if (center) mapRef.current?.centerOn(stop.lat, stop.lon, 16);
  }, []);

  const addBusStop = useCallback(
    (stop: BusStop, role: "via" | "start" | "end" = "via") => {
      const current = waypointsRef.current;
      const startEmpty = !isWaypointSet(current[0]);
      const endEmpty = !isWaypointSet(current[current.length - 1]);
      const effectiveRole: "via" | "start" | "end" =
        role === "via" ? (startEmpty ? "start" : endEmpty ? "end" : "via") : role;

      if (effectiveRole === "via" && current.length >= MAX_WAYPOINTS) {
        showToast(`Osiągnięto limit ${MAX_WAYPOINTS} punktów trasy.`);
        return;
      }
      stopNavigation();
      setPickTarget(null);
      const point: Waypoint = {
        id: waypointId(),
        label: `Przystanek autobusowy ${stopDisplayName(stop)}, Polska`,
        short: stopDisplayName(stop).slice(0, 46),
        lat: stop.lat,
        lon: stop.lon,
      };
      setWaypoints((list) => {
        if (effectiveRole === "start") return [{ ...point, id: list[0].id }, ...list.slice(1)];
        if (effectiveRole === "end") {
          return [...list.slice(0, -1), { ...point, id: list[list.length - 1].id }];
        }
        const next = [...list];
        const slot =
          routeReady && route.coords.length > 1
            ? insertionSlot(route, list, [stop.lat, stop.lon])
            : next.length - 2;
        next.splice(Math.min(Math.max(slot + 1, 1), next.length - 1), 0, point);
        return next;
      });
      pendingFitRef.current = true;
      setMobileExpanded(false);
      showToast(
        effectiveRole === "via"
          ? `Przystanek ${stopDisplayName(stop)} dodany do trasy.`
          : effectiveRole === "start"
            ? `Start ustawiony na przystanku ${stopDisplayName(stop)}.`
            : `Meta ustawiona na przystanku ${stopDisplayName(stop)}.`
      );
    },
    [showToast, stopNavigation, route, routeReady]
  );

  const addStopsAlongRoute = useCallback(() => {
    const current = waypointsRef.current;
    if (!routeReady || route.coords.length < 2) {
      showToast("Najpierw wyznacz trasę, aby dopasować do niej przystanki.");
      return;
    }
    const near = stopsAlongRoute(busStops, route.coords, 70);
    if (!near.length) {
      showToast("Nie znaleziono przystanków przy wyznaczonej trasie.");
      return;
    }
    const used = new Set(
      current
        .filter(isWaypointSet)
        .map((point) => `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`)
    );
    const working = [...current];
    let offset = 0;
    let added = 0;
    for (const item of near) {
      if (working.length >= MAX_WAYPOINTS) break;
      const key = `${item.stop.lat.toFixed(5)},${item.stop.lon.toFixed(5)}`;
      if (used.has(key)) continue;
      used.add(key);
      const slot = insertionSlot(route, current, [item.stop.lat, item.stop.lon]);
      working.splice(Math.min(slot + 1 + offset, working.length - 1), 0, {
        id: waypointId(),
        label: `Przystanek autobusowy ${stopDisplayName(item.stop)}, Polska`,
        short: stopDisplayName(item.stop).slice(0, 46),
        lat: item.stop.lat,
        lon: item.stop.lon,
      });
      offset += 1;
      added += 1;
    }
    if (!added) {
      showToast("Wszystkie przystanki przy trasie są już punktami trasy.");
      return;
    }
    stopNavigation();
    setAddMode(false);
    setPickTarget(null);
    setWaypoints(working);
    pendingFitRef.current = true;
    setMobileExpanded(false);
    showToast(
      added === 1
        ? "Dodano 1 przystanek przy trasie."
        : `Dodano ${added} przystanków w kolejności przejazdu.`
    );
  }, [busStops, route, routeReady, showToast, stopNavigation]);

  const centerWalbrzych = useCallback(() => {
    mapRef.current?.centerOn(WALBRZYCH_CENTER[0], WALBRZYCH_CENTER[1], WALBRZYCH_ZOOM);
    void loadBusStops(WALBRZYCH_BOUNDS, "Wałbrzych i okolice");
  }, [loadBusStops]);

  const updateCoordinate = (
    id: string,
    lat: number,
    lon: number,
    options: { fit?: boolean; resolveAddress?: boolean } = {}
  ) => {
    stopNavigation();
    if (options.fit) pendingFitRef.current = true;
    setWaypoints((current) =>
      current.map((point) => {
        if (point.id !== id) return point;
        const coordinate = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
        return {
          ...point,
          lat,
          lon,
          label: coordinate,
          short: coordinate,
          empty: false,
        };
      })
    );
    if (options.resolveAddress !== false) {
      reverseGeocode(lat, lon)
        .then((place) => {
          if (!place) return;
          setWaypoints((current) =>
            current.map((point) =>
              point.id === id &&
              !point.empty &&
              Math.abs(point.lat - lat) < 0.000001 &&
              Math.abs(point.lon - lon) < 0.000001
                ? { ...point, label: place.label, short: place.short.slice(0, 46), empty: false }
                : point
            )
          );
        })
        .catch(() => undefined);
    }
  };

  const handleMapContextMenu = (lat: number, lon: number, clientX: number, clientY: number) => {
    if (!isPlanner) return;
    const bounds = mapAreaRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const menuWidth = 224;
    const menuHeight = 148;
    const rawLeft = clientX - bounds.left;
    const rawTop = clientY - bounds.top;
    const maxLeft = Math.max(8, bounds.width - menuWidth - 8);
    const maxTop = Math.max(8, bounds.height - menuHeight - 8);
    const left =
      rawLeft + menuWidth <= bounds.width - 8
        ? Math.max(8, rawLeft)
        : Math.max(8, Math.min(rawLeft - menuWidth, maxLeft));
    const top =
      rawTop + menuHeight <= bounds.height - 8
        ? Math.max(8, rawTop)
        : Math.max(8, Math.min(rawTop - menuHeight, maxTop));
    setSelectedStop(null);
    setSelectedLiveBus(null);
    setPickTarget(null);
    setAddMode(false);
    setContextMenu({ lat, lon, left, top });
  };

  const setContextCoordinate = (role: "start" | "end") => {
    if (!contextMenu) return;
    const current = waypointsRef.current;
    const endpoint = role === "start" ? current[0] : current[current.length - 1];
    if (!endpoint) return;
    const { lat, lon } = contextMenu;
    setContextMenu(null);
    setSelectedStop(null);
    setPickTarget(null);
    setAddMode(false);
    setMobileExpanded(false);
    updateCoordinate(endpoint.id, lat, lon, { fit: true, resolveAddress: false });
    showToast(`${role === "start" ? "Miejsce startowe" : "Miejsce końcowe"} ustawione.`);
  };

  const appendMapPoint = (lat: number, lon: number, slot?: number) => {
    const current = waypointsRef.current;
    const firstId = current[0]?.id;
    const lastId = current[current.length - 1]?.id;
    if (firstId && !isWaypointSet(current[0])) {
      updateCoordinate(firstId, lat, lon, { fit: false, resolveAddress: false });
      return;
    }
    if (lastId && !isWaypointSet(current[current.length - 1])) {
      updateCoordinate(lastId, lat, lon, { fit: true, resolveAddress: false });
      return;
    }
    if (current.length >= MAX_WAYPOINTS) {
      setAddMode(false);
      showToast(`Osiągnięto limit ${MAX_WAYPOINTS} punktów.`);
      return;
    }
    stopNavigation();
    const newPoint: Waypoint = {
      id: waypointId(),
      lat,
      lon,
      label: `Punkt na mapie (${lat.toFixed(5)}, ${lon.toFixed(5)})`,
      short: `Punkt ${current.length - 1}`,
    };
    const next = [...current];
    next.splice(slot === undefined ? next.length - 1 : slot + 1, 0, newPoint);
    waypointsRef.current = next;
    setWaypoints(next);
    if (next.length >= MAX_WAYPOINTS) setAddMode(false);
    pendingFitRef.current = true;
  };

  const handleToggleAddMode = () => {
    stopNavigation();
    setPickTarget(null);
    if (!addMode && waypoints.length >= MAX_WAYPOINTS) {
      showToast(`Limit to ${MAX_WAYPOINTS} punktów.`);
      return;
    }
    setAddMode((current) => !current);
    setMobileExpanded(false);
  };

  const nearestStop = (lat: number, lon: number, maxMetres: number) => {
    let best: BusStop | null = null;
    let bestDistance = maxMetres;
    for (const stop of busStops) {
      const distance = haversine([lat, lon], [stop.lat, stop.lon]);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = stop;
      }
    }
    return best;
  };

  const handleMapClick = (lat: number, lon: number) => {
    setContextMenu(null);
    if (tripPick) {
      const point: TripPoint = { lat, lon, label: "Punkt z mapy" };
      if (tripPick === "origin") {
        updateTripOrigin(point);
        showToast("Punkt startowy ustawiony.");
      } else {
        updateTripDest(point);
        showToast("Cel ustawiony na mapie.");
      }
      setTripPick(null);
      return;
    }
    if (addMode) {
      appendMapPoint(lat, lon);
      return;
    }
    if (!pickTarget) return;
    const stop = nearestStop(lat, lon, 40);
    if (stop) {
      assignStopToPoint(pickTarget, stop);
      return;
    }
    const target = pickTarget;
    setPickTarget(null);
    updateCoordinate(target, lat, lon, { fit: true });
    showToast("Punkt został ustawiony na mapie.");
  };

  const handleMarkerDrag = (id: string, lat: number, lon: number) => {
    setPickTarget(null);
    updateCoordinate(id, lat, lon);
    showToast("Punkt przesunięty — trasa jest przeliczana.");
  };

  const handleLineClick = (point: [number, number]) => {
    if (addMode || pickTarget) {
      handleMapClick(point[0], point[1]);
      return;
    }
    // The line is only rendered for a drawable route; while it is visible (including as a
    // preview during a recalculation) it can always be dragged / clicked to add a point.
    if (route.coords.length < 2) {
      showToast("Wyznacz najpierw trasę, aby dodawać punkty przeciągając linię.");
      return;
    }
    const slot = insertionSlot(route, waypoints, point);
    appendMapPoint(point[0], point[1], slot);
    showToast("Dodano punkt pośredni. Przeciągnij pinezkę, aby go przesunąć.");
  };

  const handleAddVia = () => {
    if (waypoints.length >= MAX_WAYPOINTS) {
      showToast(`Limit to ${MAX_WAYPOINTS} punktów.`);
      return;
    }
    setAddMode(false);
    stopNavigation();
    const previous = waypoints[waypoints.length - 2] ?? waypoints[0];
    const destination = waypoints[waypoints.length - 1];
    const prevSet = isWaypointSet(previous) ? previous : null;
    const destSet = isWaypointSet(destination) ? destination : null;
    const via: Waypoint = {
      id: waypointId(),
      label: "Nowy punkt pośredni — kliknij mapę",
      short: "Nowy punkt",
      lat:
        prevSet && destSet
          ? (prevSet.lat + destSet.lat) / 2
          : prevSet?.lat ?? destSet?.lat ?? WALBRZYCH_CENTER[0],
      lon:
        prevSet && destSet
          ? (prevSet.lon + destSet.lon) / 2
          : prevSet?.lon ?? destSet?.lon ?? WALBRZYCH_CENTER[1],
    };
    setWaypoints((current) => {
      const next = [...current];
      next.splice(next.length - 1, 0, via);
      return next;
    });
    setPickTarget(via.id);
    setMobileExpanded(false);
    showToast("Dodano punkt pośredni. Wskaż jego lokalizację na mapie.");
  };

  const handleRemovePoint = (id: string) => {
    if (waypoints.length <= 2) return;
    if (id === waypoints[0]?.id || id === waypoints[waypoints.length - 1]?.id) return;
    stopNavigation();
    setWaypoints((current) => current.filter((point) => point.id !== id));
    showToast("Punkt pośredni usunięty.");
  };

  const handleClearEndpoint = (id: string) => {
    stopNavigation();
    requestIdRef.current += 1;
    bootPlanKeyRef.current = null;
    resolvedKeyRef.current = "";
    lastSavedSignatureRef.current = "";
    clearLastRoute();
    setPickTarget((current) => (current === id ? null : current));
    setRoutingError("");
    setRoute(EMPTY_ROUTE);
    setResolvedKey("");
    setTrafficSignals([]);
    setClearNonce((current) => current + 1);
    setWaypoints((current) =>
      current.map((point) => (point.id === id ? createEmptyWaypoint(point.id) : point))
    );
  };

  const handleClearRoute = () => {
    stopNavigation();
    requestIdRef.current += 1;
    pendingFitRef.current = false;
    bootPlanKeyRef.current = null;
    resolvedKeyRef.current = "";
    lastSavedSignatureRef.current = "";
    clearLastRoute();
    setAddMode(false);
    setPickTarget(null);
    setRoutingError("");
    setRoute(EMPTY_ROUTE);
    setResolvedKey("");
    setTrafficSignals([]);
    setKursowkaOverlay(null);
    setSelectedStop(null);
    setContextMenu(null);
    setClearNonce((current) => current + 1);
    setWaypoints(createInitialWaypoints());
    showToast("Trasa wyczyszczona.");
  };

  const handleSwap = () => {
    stopNavigation();
    setWaypoints((current) => [...current].reverse());
    setPickTarget(null);
    pendingFitRef.current = true;
    showToast("Zamieniono punkt startowy z metą.");
  };

  const handleSelectPlace = (index: number, place: Place) => {
    stopNavigation();
    setWaypoints((current) =>
      current.map((point, pointIndex) =>
        pointIndex === index
          ? {
              ...point,
              label: place.label,
              short: place.short.slice(0, 46),
              lat: place.lat,
              lon: place.lon,
              empty: false,
            }
          : point
      )
    );
    setPickTarget(null);
    setMobileExpanded(false);
    pendingFitRef.current = true;
    showToast(`Ustawiono: ${place.short}`);
  };

  const handlePick = (id: string) => {
    setAddMode(false);
    const next = pickTarget === id ? null : id;
    setPickTarget(next);
    setSelectedStop(null);
    setMobileExpanded(false);
  };

  const assignStopToPoint = (id: string, stop: BusStop) => {
    stopNavigation();
    setAddMode(false);
    setPickTarget(null);
    setSelectedStop(stop);
    setWaypoints((current) =>
      current.map((point) =>
        point.id === id
          ? {
              ...point,
              lat: stop.lat,
              lon: stop.lon,
              label: `Przystanek autobusowy ${stopDisplayName(stop)}, Polska`,
              short: stopDisplayName(stop).slice(0, 46),
              empty: false,
            }
          : point
      )
    );
    pendingFitRef.current = true;
    const role =
      id === waypointsRef.current[0]?.id
        ? "Start"
        : id === waypointsRef.current[waypointsRef.current.length - 1]?.id
          ? "Meta"
          : "Punkt";
    showToast(`${role}: ${stopDisplayName(stop)}. Trasa zostanie przeliczona.`);
  };

  const handleVehicleChange = (next: VehicleId) => {
    if (!fleet.some((item) => item.id === next)) return;
    stopNavigation();
    setVehicle(next);
  };

  const handleFleetChange = (nextFleet: VehicleProfile[]) => {
    const previousMap = new Map(fleet.map((item) => [item.id, item]));
    const cleaned = replaceFleet(nextFleet);
    stopNavigation();
    setFleet(cleaned);
    if (!cleaned.some((item) => item.id === vehicle)) setVehicle(cleaned[0].id);
    setSpeeds((current) => {
      const next = cleanSpeeds(current, cleaned);
      for (const item of cleaned) {
        const prev = previousMap.get(item.id);
        if (
          !prev ||
          Math.abs(prev.averageSpeed - item.averageSpeed) >= 0.05 ||
          next[item.id] === undefined
        ) {
          next[item.id] = item.averageSpeed ?? DEFAULT_BUS_SPEED;
        }
      }
      return next;
    });
  };

  const handleSaveVehicleAverageSpeed = (targetVehicleId: VehicleId, nextSpeed: number) => {
    if (!isValidSpeed(nextSpeed)) return;
    const rounded = Math.round(nextSpeed * 10) / 10;
    const updatedFleet = replaceFleet(
      fleet.map((item) =>
        item.id === targetVehicleId ? { ...item, averageSpeed: rounded } : item
      )
    );
    setFleet(updatedFleet);
    setSpeeds((current) => ({ ...current, [targetVehicleId]: rounded }));
    const found = updatedFleet.find((item) => item.id === targetVehicleId);
    showToast(
      `Przypisano ${rounded.toLocaleString("pl-PL")} km/h na stałe do wozu ${found?.short ?? ""}.`
    );
  };

  const handleAvoidChange = (next: AvoidOptions) => {
    stopNavigation();
    setAvoid(next);
  };

  const handleRecalculate = () => {
    if (!readyForRouting) {
      showToast("Wybierz najpierw punkt startowy A i metę B.");
      return;
    }
    pendingFitRef.current = true;
    setIsRouting(true);
    setRefreshTick((current) => current + 1);
  };

  const handleSaveRoute = () => {
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
  };

  const handleSaveBrigadePlan = () => {
    const cleaned = cleanBrigade(brigade);
    const title = formatBrigadeTitle(cleaned);
    if (!hasBrigade(cleaned) || !title) {
      showToast("Wpisz numer linii lub służby, aby zapisać brygadę.");
      return;
    }
    if (!routeReady) {
      showToast("Najpierw wyznacz aktualną trasę dla tej brygady.");
      return;
    }
    const plan: SavedBrigadePlan = {
      id: `brigade-${title.toLowerCase().replace(/[^a-z0-9]+/gi, "-")}`,
      title,
      brigade: cleaned,
      waypoints,
      vehicle,
      fleet,
      speeds,
      schedule,
      avoid,
      route,
      savedAt: new Date().toISOString(),
    };
    setSavedBrigades((current) =>
      [plan, ...current.filter((item) => item.id !== plan.id)].slice(0, 30)
    );
    showToast(`Zapisano brygadę: ${title}.`);
  };

  const handleLoadBrigadePlan = (plan: SavedBrigadePlan) => {
    stopNavigation();
    setAddMode(false);
    setPickTarget(null);
    setRoutingError("");
    setBrigade(plan.brigade);
    if (plan.fleet?.length) {
      const restored = replaceFleet(plan.fleet);
      setFleet(restored);
      setVehicle(
        restored.some((item) => item.id === plan.vehicle) ? plan.vehicle : restored[0].id
      );
    } else if (fleet.some((item) => item.id === plan.vehicle)) {
      setVehicle(plan.vehicle);
    }
    if (plan.speeds) setSpeeds(plan.speeds);
    if (plan.schedule) setSchedule(plan.schedule);
    bootPlanKeyRef.current = null;
    const currentPlanKey = buildPlanKey(waypointsRef.current, avoidRef.current);
    setAvoid(plan.avoid);
    setWaypoints(plan.waypoints);
    const nextPlanKey = buildPlanKey(plan.waypoints, plan.avoid);
    if (plan.route && plan.route.engine === "osrm" && plan.route.coords.length >= 2) {
      if (nextPlanKey !== currentPlanKey) skipNextRouteKeyRef.current = nextPlanKey;
      resolvedKeyRef.current = nextPlanKey;
      setRoute(plan.route);
      setResolvedKey(nextPlanKey);
      setFitNonce((current) => current + 1);
    } else {
      resolvedKeyRef.current = "";
      setRoute(EMPTY_ROUTE);
      setResolvedKey("");
      setTrafficSignals([]);
      pendingFitRef.current = true;
    }
    showToast(`Wczytano brygadę: ${plan.title}.`);
  };

  const handleDeleteBrigadePlan = (id: string) => {
    setSavedBrigades((current) => current.filter((item) => item.id !== id));
    showToast("Usunięto zapisaną brygadę.");
  };

  const handleOpenKursowkaFromItem = useCallback((kursowkaId: string, kursowkaCode: string) => {
    setKursowkaDeepLink({ id: kursowkaId || null, code: kursowkaCode || null });
    setKursowkiOpen(true);
  }, []);

  const handleSelectBus = useCallback((bus: LiveBusVehicle) => {
    setOperatorFilter("all");
    updateVisibility({ liveBuses: true });
    setSelectedStop(null);
    setSelectedLiveBus(bus);
    setKursowkiOpen(false);
    setMobileExpanded(false);
    mapRef.current?.centerOn(bus.lat, bus.lon, 16);
  }, []);

  const handleSetOperator = useCallback(
    async (vehicleId: string, key: WalbrzychOperatorKey | null) => {
      // Przewoźnika może zmieniać wyłącznie planista.
      if (!isPlanner) {
        showToast("Zmiana przewoźnika jest dostępna tylko dla Planisty.");
        return;
      }
      try {
        setOperatorOverride(vehicleId, key);
        await fetchLiveBuses(true);
        const names = { mzuk: "MZUK", ska: "ŚKA", other: "Inny" } as const;
        showToast(
          key
            ? `Wóz #${vehicleId} przypisano do: ${names[key]}.`
            : `Wóz #${vehicleId}: przywrócono automatyczne przypisanie.`
        );
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Nie udało się zapisać przypisania.");
      }
    },
    [fetchLiveBuses, showToast, isPlanner]
  );

  const handleLoadTripToPlanner = useCallback(
    (payload: {
      line: string;
      duty: string;
      waypoints: Waypoint[];
      departureTime?: string;
      headsign?: string;
    }) => {
      stopNavigation();
      requestIdRef.current += 1;
      bootPlanKeyRef.current = null;
      resolvedKeyRef.current = "";
      setAddMode(false);
      setPickTarget(null);
      setRoutingError("");
      setRoute(EMPTY_ROUTE);
      setResolvedKey("");
      setTrafficSignals([]);
      setKursowkaOverlay(null);
      setBrigade({ line: payload.line, duty: payload.duty });
      setWaypoints(payload.waypoints);
      if (payload.departureTime) {
        setSchedule((prev) => ({
          ...prev,
          mode: "departure",
          time: payload.departureTime!,
        }));
      }
      pendingFitRef.current = true;
      setKursowkiOpen(false);
      setMobileExpanded(false);
      showToast(
        `Wczytano kurs kursówki ${payload.duty} (${payload.headsign || `${payload.waypoints.length} przyst.`}) do Planera.`
      );
    },
    [stopNavigation, showToast]
  );

  const handleShare = async () => {
    if (!exportReady || !metrics.journey) {
      showToast("Wyznacz trasę i sprawdź datę przed kopiowaniem planu.");
      return;
    }
    const profile = metrics.profile?.name ?? metrics.name ?? vehicle;
    const brigadeTitle = formatBrigadeTitle(brigade);
    const text = [
      `${APP_NAME}${brigadeTitle ? ` · ${brigadeTitle}` : ""} · plan podróży`,
      ...(brigadeTitle ? [`Brygada: ${brigadeTitle}`] : []),
      waypoints.map((point) => point.short).join(" → "),
      `Profil: ${profile}`,
      `Dystans: ${formatDistance(metrics.distance)}`,
      `Czas: ${formatDuration(metrics.duration)}`,
      ...scheduleSummaryLines(metrics.journey),
      window.location.href,
    ].join("\n");
    const copied = await copyToClipboard(text);
    showToast(copied ? "Podsumowanie trasy skopiowane do schowka." : "Nie udało się skopiować.");
  };

  const handleSpeedChange = (speed: number | undefined) => {
    if (speed !== undefined && !isValidSpeed(speed)) return;
    setSpeeds((current) => {
      const next = { ...current };
      if (speed === undefined) delete next[vehicle];
      else next[vehicle] = speed;
      return next;
    });
  };

  const handleScheduleChange = (next: ScheduleSettings) => {
    stopNavigation();
    setClockNow(Date.now());
    setSchedule(next);
  };

  const openPdf = () => {
    if (!routeReady) {
      showToast("Zakończ zaznaczanie i poczekaj na aktualną trasę przed eksportem.");
      return;
    }
    if (!metrics.journey) {
      showToast("Popraw datę i godzinę w planie przejazdu przed eksportem.");
      return;
    }
    setPdfOpen(true);
  };

  const handleFocusStep = (step: RouteStep) => {
    if (!step.location) {
      showToast("Dla tego manewru nie ma zapisanej lokalizacji.");
      return;
    }
    setFocus({
      lat: step.location[0],
      lon: step.location[1],
      zoom: 14,
      nonce: Date.now(),
    });
    setStepsOpen(false);
    setMobileExpanded(false);
  };

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    if (mapStyle !== "satellite") {
      setMapStyle(next === "dark" ? "dark" : "light");
    }
  };

  const currentStepInfo = useMemo(
    () => currentStepForProgress(navigationRoute, navProgress),
    [navigationRoute, navProgress]
  );
  const suggestedStepIndex = useMemo(() => {
    const index = activeRoute.steps.findIndex((step) => step.maneuver !== "depart");
    return index >= 0 ? index : 0;
  }, [activeRoute]);
  const hudStepIndex = navActive ? currentStepInfo.index : suggestedStepIndex;
  const hudStep = navigationRoute.steps[hudStepIndex];
  const hudRemainingDistance = navActive
    ? metrics.distance * (1 - navProgress)
    : hudStep?.distance ?? 0;
  const hudRemainingTime = navActive
    ? metrics.duration * (1 - navProgress)
    : hudStep?.duration ?? 0;
  const navCoord = useMemo<[number, number] | null>(
    () => (navActive ? pointAtProgress(activeRoute, navProgress) : null),
    [navActive, activeRoute, navProgress]
  );

  const panelProps = {
    brigade,
    onBrigadeChange: setBrigade,
    savedBrigades,
    onSaveBrigade: handleSaveBrigadePlan,
    onLoadBrigade: handleLoadBrigadePlan,
    onDeleteBrigade: handleDeleteBrigadePlan,
    waypoints,
    vehicle,
    avoid,
    route: activeRoute,
    metrics,
    comparisons,
    isRouting,
    routingError,
    routeReady,
    exportReady,
    schedule,
    scheduleEvaluation,
    clockNow,
    signalCount: trafficSignals.length,
    signalsLoading,
    turnaroundCount: turnaroundSpots.length,
    turnaroundLengthM: activeVehicle?.lengthM ?? 0,
    liveTraffic,
    onScheduleChange: handleScheduleChange,
    speeds,
    addMode,
    automaticSpeed: estimateAverageSpeed(activeRoute.distance, metrics.automaticDuration),
    onSpeedChange: handleSpeedChange,
    onSaveVehicleAverageSpeed: handleSaveVehicleAverageSpeed,
    onToggleAddMode: handleToggleAddMode,
    onOpenPdf: openPdf,
    navPlaying,
    pickTarget,
    clearNonce,
    onSelectPlace: handleSelectPlace,
    onRemovePoint: handleRemovePoint,
    onClearEndpoint: handleClearEndpoint,
    onClearRoute: handleClearRoute,
    onAddVia: handleAddVia,
    onSwap: handleSwap,
    onPick: handlePick,
    onVehicleChange: handleVehicleChange,
    onAvoidChange: handleAvoidChange,
    onRecalculate: handleRecalculate,
    onOpenFleet: () => setFleetOpen(true),
    onOpenSettings: openInformation,
    onOpenSteps: () => setStepsOpen(true),
    onToggleNavigation: toggleNavigation,
    onSave: handleSaveRoute,
    onShare: handleShare,
    onSelectVehicle: handleVehicleChange,
    onOpenReport: () => setReportOpen(true),
    busStops,
    busLoading,
    busError,
    busQuery,
    stopScope,
    nearRoute,
    selectedStopId: selectedStop?.id ?? null,
    selectedStop,
    usedStopKeys,
    busScopeLabel: busScope,
    busSeconds,
    onBusQuery: setBusQuery,
    onBusScope: setStopScope,
    onRefreshBusStops: refreshBusStops,
    onSelectBusStop: (stop: BusStop) => selectBusStop(stop, true),
    onAddBusStop: (stop: BusStop) => addBusStop(stop, "via"),
    onAddStopsAlongRoute: addStopsAlongRoute,
    onCenterWalbrzych: centerWalbrzych,
    onOpenKursowka: handleOpenKursowkaFromItem,
  };

  return (
    <div className="flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-canvas text-ink">
      <TopBar
        route={activeRoute}
        isRouting={isRouting}
        routeReady={routeReady}
        role={role}
        onRoleChange={handleRoleChange}
        theme={theme}
        liveBusCount={liveVehicles.length}
        showLiveBuses={showLiveBuses}
        kursowkiOpen={kursowkiOpen}
        onToggleLiveBuses={() => toggleVisibility("liveBuses")}
        onToggleTheme={toggleTheme}
        onOpenPdf={openPdf}
        pdfDisabled={!exportReady}
        onOpenSettings={openInformation}
        onOpenSteps={() => setStepsOpen(true)}
        onOpenFleet={() => setFleetOpen(true)}
        onOpenReport={() => setReportOpen(true)}
        onOpenKursowki={() => {
          setKursowkaDeepLink({});
          setKursowkiOpen(true);
        }}
        onOpenPlanner={() => {
          setKursowkiOpen(false);
          if (window.innerWidth < 1024) setMobileExpanded(true);
        }}
      />

      <div className="flex min-h-0 flex-1">
        {isDesktop && isPlanner && (
          <aside className="flex min-h-0 w-[404px] shrink-0 flex-col border-r border-line bg-canvas 2xl:w-[416px]">
            <PlanningPanel {...panelProps} />
          </aside>
        )}

        <main
          ref={mapAreaRef}
          className="relative min-h-0 min-w-0 flex-1 select-none overflow-hidden bg-[#dfe6d9] dark:bg-[#232932]"
        >
          <Suspense
            fallback={
              <div className="flex h-full w-full items-center justify-center text-xs text-mute">
                Ładowanie mapy…
              </div>
            }
          >
            <MapView
              ref={mapRef}
              route={activeRoute}
              waypoints={waypoints}
              mapStyle={mapStyle}
              theme={theme}
              fitNonce={fitNonce}
              pickMode={Boolean(pickTarget) || addMode || tripPick !== null}
              draftMode={addMode}
              busStops={mapStops}
              selectedStopId={selectedStop?.id ?? null}
              nearRouteIds={nearRouteIds}
              usedStopKeys={usedStopKeys}
              onBusStopClick={(stop) => {
                if (tripPick) {
                  const point: TripPoint = { lat: stop.lat, lon: stop.lon, label: stop.name, stopId: stop.gtfsId };
                  if (tripPick === "origin") {
                    updateTripOrigin(point);
                    showToast("Punkt startowy ustawiony na przystanku.");
                  } else {
                    updateTripDest(point);
                    showToast("Cel ustawiony na przystanku.");
                  }
                  setTripPick(null);
                  return;
                }
                if (pickTarget) {
                  assignStopToPoint(pickTarget, stop);
                  return;
                }
                if (addMode) {
                  addBusStop(stop, "via");
                  return;
                }
                selectBusStop(stop, false);
              }}
              liveBuses={visibleLiveBuses}
              showLiveBuses={showLiveBuses}
              busLabelKursowka={visibility.busKursowka}
              busLabelVehicleNumber={visibility.busVehicleNumber}
              selectedLiveBusId={selectedLiveBus?.vehicleId ?? null}
              onLiveBusClick={(bus) => {
                setSelectedStop(null);
                setSelectedLiveBus((prev) => (prev?.vehicleId === bus.vehicleId ? null : bus));
              }}
              trafficSignals={trafficSignals}
              showTrafficSignals={showTrafficSignals}
              turnaroundSpots={turnaroundSpots}
              showTurnarounds={showTurnarounds}
              kursowkaOverlay={kursowkaOverlay}
              tripPlan={tripMapPlan}
              tripDestinationEditing={tripPick === "destination"}
              onTripDestinationPick={() => {
                setTripPick("destination");
                setSelectedStop(null);
                showToast("Przeciągnij cel lub kliknij nowe miejsce na mapie. Esc anuluje wybór.");
              }}
              onTripDestinationMove={(lat, lon) => {
                updateTripDest({ lat, lon, label: "Cel z mapy" });
                setTripPick(null);
                showToast("Cel przesunięty. Przeliczam połączenia i dojścia piesze.");
              }}
              navCoord={navCoord}
              followNav={navActive && navPlaying}
              focus={focus}
              onLineClick={handleLineClick}
              onMarkerDrag={handleMarkerDrag}
              onMapClick={handleMapClick}
              onMapContextMenu={handleMapContextMenu}
            />
          </Suspense>

          <div className="pointer-events-none absolute inset-0 z-[500] select-none">
            <div className="pointer-events-none absolute left-3 top-5 flex max-w-[calc(100%-72px)] flex-col items-start gap-2 lg:top-3">
              {addMode ? (
                <MapDrawingBanner
                  count={assignedCount}
                  onDone={() => setAddMode(false)}
                  onUndo={() => {
                    if (waypoints.length > 2) {
                      handleRemovePoint(waypoints[waypoints.length - 2].id);
                    }
                  }}
                />
              ) : pickTarget ? (
                <PickBanner
                  target={
                    pickTarget === waypoints[0]?.id
                      ? "start"
                      : pickTarget === waypoints[waypoints.length - 1]?.id
                        ? "meta"
                        : "punkt"
                  }
                  onCancel={() => setPickTarget(null)}
                />
              ) : (
                <div className="pointer-events-none flex flex-col items-start gap-2">
                  <LiveFleetControl
                    isPlanner={isPlanner}
                    showLiveBuses={showLiveBuses}
                    onToggleLiveBuses={() => toggleVisibility("liveBuses")}
                    operatorFilter={operatorFilter}
                    onOperatorFilter={setOperatorFilter}
                    liveVehicles={liveVehicles}
                    liveTraffic={liveTraffic}
                    liveLoading={liveLoading}
                    onRefreshLive={() => void fetchLiveBuses(true)}
                      signalCount={trafficSignals.length}
                      showTrafficSignals={showTrafficSignals}
                      onToggleTrafficSignals={() => toggleVisibility("trafficSignals")}
                      turnaroundCount={turnaroundSpots.length}
                      showTurnarounds={showTurnarounds}
                      onToggleTurnarounds={() => toggleVisibility("turnarounds")}
                      kursowkaOverlayTitle={kursowkaOverlay?.title ?? null}
                    onClearKursowkaOverlay={() => setKursowkaOverlay(null)}
                    onSelectBus={handleSelectBus}
                  />
                  {!isPlanner && tripOpen && (
                    <TripPlannerPanel
                      buses={liveVehicles}
                      origin={tripOrigin}
                      destination={tripDest}
                      onOriginChange={updateTripOrigin}
                      onDestinationChange={updateTripDest}
                      pickTarget={tripPick}
                      onPickTargetChange={setTripPick}
                      onSelectBus={handleSelectBus}
                      onCenter={(lat, lon, zoom = 15) => mapRef.current?.centerOn(lat, lon, zoom)}
                      onPreview={setTripPreview}
                      onRefresh={() => setTripNonce((value) => value + 1)}
                      onClose={() => {
                        setTripOpen(false);
                        setTripPick(null);
                        setTripPreview(null);
                      }}
                      refreshNonce={tripNonce}
                    />
                  )}
                  {isPlanner && (
                    <MapRouteCard
                      route={activeRoute}
                      waypoints={waypoints}
                      metrics={metrics}
                      vehicle={vehicle}
                      brigade={brigade}
                      mapStyle={mapStyle}
                      routeReady={routeReady}
                      turnaroundCount={turnaroundSpots.length}
                    />
                  )}
                  {selectedStop && (
                    <BusStopCard
                      stop={selectedStop}
                      isPlanner={isPlanner}
                      alreadyInRoute={selectedStopInRoute}
                      canAdd={waypoints.length < MAX_WAYPOINTS}
                      onClose={() => setSelectedStop(null)}
                      onAddVia={() => addBusStop(selectedStop, "via")}
                      onSetStart={() => addBusStop(selectedStop, "start")}
                      onSetEnd={() => addBusStop(selectedStop, "end")}
                      onCenter={() =>
                        mapRef.current?.centerOn(selectedStop.lat, selectedStop.lon, 16)
                      }
                      onOpenKursowka={handleOpenKursowkaFromItem}
                    />
                  )}
                  {selectedLiveBus && (
                    <LiveBusCard
                      isPlanner={isPlanner}
                      bus={selectedLiveBus}
                      onClose={() => setSelectedLiveBus(null)}
                      onOpenKursowka={(code) => handleOpenKursowkaFromItem("", code)}
                      onSetOperator={handleSetOperator}
                      onCenter={() =>
                        mapRef.current?.centerOn(selectedLiveBus.lat, selectedLiveBus.lon, 16)
                      }
                    />
                  )}
                </div>
              )}
            </div>

            <div className="pointer-events-none absolute right-3 top-3">
              <MapControls
                mapStyle={mapStyle}
                onMapStyle={setMapStyle}
                onZoomIn={() => mapRef.current?.zoomIn()}
                onZoomOut={() => mapRef.current?.zoomOut()}
                onFit={() => mapRef.current?.fitRoute()}
                busCount={mapStops.length}
                isPlanner={isPlanner}
                visibility={visibility}
                onVisibilityChange={(patch) => {
                  updateVisibility(patch);
                  if (patch.stops === "route" && !routeReady) {
                    showToast("Wyznacz trasę, aby pokazać przystanki przy niej.");
                  }
                }}
                busLoading={busLoading}
                onRefreshBusStops={refreshBusStops}
                onHome={centerWalbrzych}
              />
            </div>

            {routeReady && (
              <div className="pointer-events-none absolute bottom-10 left-3 hidden lg:block">
                <NavigationHud
                  active={navActive}
                  playing={navPlaying}
                  progress={navProgress}
                  step={hudStep}
                  stepIndex={hudStepIndex}
                  totalSteps={activeRoute.steps.length}
                  remainingDistance={hudRemainingDistance}
                  remainingTime={hudRemainingTime}
                  vehicle={vehicle}
                  vehicleShort={metrics.short}
                  onStart={startNavigation}
                  onToggle={toggleNavigation}
                  onStop={stopNavigation}
                  onOpenSteps={() => setStepsOpen(true)}
                />
              </div>
            )}

            {routeReady && (
              <div className="pointer-events-none absolute bottom-8 right-3 hidden xl:block">
                <QuickComparison
                  metrics={comparisons}
                  activeVehicle={vehicle}
                  onSelectVehicle={handleVehicleChange}
                  onOpenReport={() => setReportOpen(true)}
                />
              </div>
            )}

            <div className="pointer-events-none absolute bottom-2.5 left-3 hidden select-none items-center gap-2 rounded-full border border-line/70 bg-surface/80 px-2 py-1 backdrop-blur sm:flex">
              {isPlanner && (
                <>
                  <span className="flex items-center gap-1 text-[7.5px] font-bold text-mute">
                    <span className="h-1.5 w-1.5 rounded-full bg-brand" /> A start
                  </span>
                  <span className="h-2 w-px bg-line" />
                  <span className="flex items-center gap-1 text-[7.5px] font-bold text-mute">
                    <span className="h-1.5 w-1.5 rounded-full bg-ink ring-1 ring-highlight" /> B
                    meta
                  </span>
                  <span className="h-2 w-px bg-line" />
                </>
              )}
              {stopDisplay !== "off" && (
                <>
                  <span className="flex items-center gap-1 text-[7.5px] font-bold text-mute">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#1a73e8]" /> przystanek (
                    {mapStops.length})
                  </span>
                  <span className="h-2 w-px bg-line" />
                </>
              )}
              <span className="flex items-center gap-1 text-[7.5px] font-bold text-mute">
                <span className="h-1.5 w-1.5 rounded-full bg-[#86efac]" /> MZUK
                <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-[#c084fc]" /> ŚKA (
                {visibleLiveBuses.length})
              </span>
              {trafficSignals.length > 0 && (
                <>
                  <span className="h-2 w-px bg-line" />
                  <span className="flex items-center gap-1 text-[7.5px] font-bold text-mute">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> światła (
                    {trafficSignals.length})
                  </span>
                </>
              )}
              {turnaroundSpots.length > 0 && (
                <>
                  <span className="h-2 w-px bg-line" />
                  <span className="flex items-center gap-1 text-[7.5px] font-bold text-mute">
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-500" /> zawrotki (
                    {turnaroundSpots.length})
                  </span>
                </>
              )}
            </div>
          </div>

          {!isPlanner && (
            <button
              type="button"
              onClick={() => {
                setTripOpen((open) => !open);
                if (tripOpen) setTripPick(null);
              }}
              aria-expanded={tripOpen}
              title="Doradca: pokaże, do jakiego autobusu na żywo wejść, żeby dojechać do celu"
              className={`pointer-events-auto absolute bottom-10 left-3 z-[600] flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[9px] font-extrabold shadow-[0_10px_28px_rgba(13,42,28,0.35)] backdrop-blur transition-all hover:opacity-90 active:scale-[0.98] ${
                tripOpen
                  ? "border-line-strong bg-surface text-ink"
                  : "border-brand-deep/20 bg-brand text-on-brand"
              }`}
            >
              <RouteIcon className="h-3.5 w-3.5" strokeWidth={2.4} />
              {tripOpen ? "Zamknij planer" : "Planer podróży"}
            </button>
          )}

          {contextMenu && (
            <div className="pointer-events-none absolute inset-0 z-[1200]">
              <MapContextMenu
                ref={contextMenuRef}
                lat={contextMenu.lat}
                lon={contextMenu.lon}
                left={contextMenu.left}
                top={contextMenu.top}
                onSetStart={() => setContextCoordinate("start")}
                onSetEnd={() => setContextCoordinate("end")}
              />
            </div>
          )}

          {!isDesktop && isPlanner && (
            <MobilePlannerSheet
              expanded={mobileExpanded}
              onToggle={() => setMobileExpanded((current) => !current)}
              waypoints={waypoints}
              metrics={metrics}
              vehicleShort={metrics.short}
              brigade={brigade}
              routeReady={exportReady}
            >
              <PlanningPanel {...panelProps} />
            </MobilePlannerSheet>
          )}

          {isRouting && (
            <div className="pointer-events-none absolute left-0 top-0 z-[800] h-[3px] w-full overflow-hidden bg-brand/15">
              <div className="route-progress h-full w-1/3 rounded-full bg-highlight" />
            </div>
          )}
        </main>
      </div>

      <KursowkiDialog
        open={kursowkiOpen}
        initialKursowkaId={kursowkaDeepLink.id}
        initialKursowkaCode={kursowkaDeepLink.code}
        onClose={() => setKursowkiOpen(false)}
        liveVehicles={liveVehicles}
        onSelectBus={handleSelectBus}
        onLoadTripToPlanner={handleLoadTripToPlanner}
        canLoadToPlanner={isPlanner}
        isPlanner={isPlanner}
      />

      <StepsDrawer
        open={stepsOpen}
        onClose={() => setStepsOpen(false)}
        route={navigationRoute}
        waypoints={waypoints}
        metrics={metrics}
        vehicle={vehicle}
        onFocusStep={handleFocusStep}
        onStartNavigation={startNavigation}
      />
      <FleetDialog
        open={fleetOpen}
        onClose={() => setFleetOpen(false)}
        fleet={fleet}
        activeId={vehicle}
        onSelect={handleVehicleChange}
        onChange={handleFleetChange}
      />
      <SettingsDialog
        open={isPlanner && settingsOpen}
        onClose={() => setSettingsOpen(false)}
        engine={activeRoute.engine === "osrm" ? "OSRM (bez klucza)" : "Schemat demonstracyjny"}
      />
      <ReportDialog
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        waypoints={waypoints}
        route={activeRoute}
        metrics={comparisons}
        activeVehicle={vehicle}
        brigade={brigade}
        onOpenPdf={openPdf}
        pdfDisabled={!exportReady}
      />
      <PdfExportDialog
        open={pdfOpen}
        onClose={() => setPdfOpen(false)}
        route={navigationRoute}
        waypoints={waypoints}
        metrics={metrics}
        vehicle={vehicle}
        brigade={brigade}
        routeReady={exportReady}
      />
      {toastMessage && <Toast message={toastMessage} onClose={closeToast} />}
    </div>
  );
}
