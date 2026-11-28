"use client";

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
import type {
  CourseRouteTarget,
  KursowkaShapeOverlay,
  LineRouteEditorMapState,
  LiveRouteProgressStatus,
  MapHandle,
} from "./MapView";
import type { LineEditorMapHandlers } from "./LineRouteEditorPanel";
import type { CustomGtfsResumeTarget } from "./CustomGtfsBuilderDialog";
import type { CustomGtfsMapSession } from "./CustomGtfsMapDrawToolbar";
import MapInfoSidebar, { type SidebarView } from "./MapInfoSidebar";
import { useUserLocation } from "@/lib/useUserLocation";
import {
  BusStopCard,
  LiveBusCard,
  LiveFleetControl,
  MapContextMenu,
  MapControls,
  MapDrawingBanner,
  MapQuickBar,
  MobilePlannerSheet,
  NavigationHud,
  PickBanner,
  QuickComparison,
  ShapeOverlayControl,
} from "./MapOverlays";
import { Toast } from "./Toast";
import {
  loadVisibility,
  saveVisibility,
  type VisibilitySettings,
  type VisibilityToggleKey,
} from "@/lib/visibility";

const PlanningPanel = lazy(() => import("./PlanningPanel"));
const LineRouteEditorPanel = lazy(() => import("./LineRouteEditorPanel"));
const KursowkiDialog = lazy(() => import("./KursowkiDialog"));
const LinesDialog = lazy(() => import("./LinesDialog"));
const CustomGtfsMapDrawToolbar = lazy(() => import("./CustomGtfsMapDrawToolbar"));
const TripPlannerPanel = lazy(() => import("./TripPlannerPanel"));
const CoursePreviewCard = lazy(() => import("./CoursePreviewCard"));
const WorkspaceDialogs = lazy(() => import("./WorkspaceDialogs"));
import CourseNavigationHud from "./CourseNavigationHud";
import { useLiveFleetState } from "@/lib/hooks/useLiveFleetState";
import { useCourseNavigation } from "@/lib/hooks/useCourseNavigation";
import { usePlannerRouting } from "@/lib/hooks/usePlannerRouting";
import { useTravelerJourneyState } from "@/lib/hooks/useTravelerJourneyState";
import type { JourneyPoint as TripPoint } from "@/lib/journeyPlanner";
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
  isWaypointSet,
} from "@/lib/data";
import {
  fetchBusStops,
  filterStops,
  findRefreshedBusStop,
  getSnapshotBusStops,
  mergeRefreshedBusStops,
  stopDisplayName,
  WALBRZYCH_BOUNDS,
  WALBRZYCH_CENTER,
  WALBRZYCH_ZOOM,
  type Bounds,
} from "@/lib/busStops";
import { onRuntimeEvent } from "@/lib/core/runtimeHub";
import { coordKey, polylineLengthMeters } from "@/lib/core/spatial";
import PerfHud from "@/components/PerfHud";
import { formatWarsawClock, readStorageText, writeStorageJson, writeStorageText } from "@/lib/core/time";
import { setOperatorOverride } from "@/lib/engine/fleetOperators";
import { courseStopTarget } from "@/lib/courseRoute";
import { liveBusTap } from "@/lib/liveBusProgress";
import "@/lib/engine/gtfsRt";
import {
  ensureGtfsSeeded,
  getCoursePreview,
  getGtfsPreviewStatus,
  getVehicleRouteOverlay,
  restoreOriginalGtfsArchive,
  type CoursePreviewStop,
  type GtfsPreviewStatus,
} from "@/lib/engine/gtfsStore";
import { getOverridesSummary, initLineRouteOverrides } from "@/lib/engine/lineRouteOverrides";
import {
  currentStepForProgress,
  estimateAverageSpeed,
  formatDistance,
  formatDuration,
  haversine,
  insertionSlot,
  isValidSpeed,
  pointAtProgress,
  reverseGeocode,
  stopsAlongRoute,
} from "@/lib/geo";
import {
  defaultSchedule,
  scheduleSummaryLines,
  SCHEDULE_STORAGE_KEY,
} from "@/lib/schedule";
import {
  cleanSpeeds,
  clearLastRoute,
  defaultSpeedMap,
  loadLastRoute,
  SPEEDS_KEY,
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
  type MapStyle,
  type Place,
  type RouteStep,
  type ScheduleSettings,
  type SpeedOverrides,
  type ThemeMode,
  type VehicleId,
  type VehicleProfile,
  type WalbrzychOperatorKey,
  type Waypoint,
} from "@/lib/types";

const MapView = lazy(() => import("./MapView"));

const THEME_STORAGE_KEY = "mapplaner.theme";
const ROLE_STORAGE_KEY = "mapplaner.role";
const EMPTY_STRING_SET = new Set<string>();
const EMPTY_NEAR_MAP = new Map<string, number>();
const EMPTY_LIVE_VEHICLES: LiveBusVehicle[] = [];

function loadRole(): AppRole {
  return readStorageText(ROLE_STORAGE_KEY) === "planner" ? "planner" : "traveler";
}

interface MapContextMenuState {
  lat: number;
  lon: number;
  left: number;
  top: number;
  stop?: BusStop;
  addressLabel?: string | null;
}

const waypointId = () =>
  `wp-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;

function loadTheme(): ThemeMode {
  return readStorageText(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
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
  const [isRailViewport, setIsRailViewport] = useState(() => true);
  const isRailViewportRef = useRef(true);
  isRailViewportRef.current = isRailViewport;
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

  // Bus stops
  const [busStops, setBusStops] = useState<BusStop[]>(() => getSnapshotBusStops());
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
  const showLiveBuses = visibility.liveBuses;
  const showTrafficSignals = visibility.trafficSignals;
  const showTurnarounds = visibility.turnarounds;
  const [selectedStop, setSelectedStop] = useState<BusStop | null>(null);
  const [contextMenu, setContextMenu] = useState<MapContextMenuState | null>(null);
  const [mapSidebarOpen, setMapSidebarOpen] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>("home");
  const [plannerLoginOpen, setPlannerLoginOpen] = useState(false);

  // Bezpośredni link ?planista=1 otwiera logowanie planisty bez eksponowania go w UI pasażera.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("planista") !== "1") return;
    url.searchParams.delete("planista");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    if (role !== "planner") setPlannerLoginOpen(true);
  }, [role]);

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const showToast = useCallback((message: string) => setToastMessage(message), []);
  const closeToast = useCallback(() => setToastMessage(null), []);
  const clearContextMenu = useCallback(() => setContextMenu(null), []);
  const clearSelectedStop = useCallback(() => setSelectedStop(null), []);

  const {
    tripOpen,
    setTripOpen,
    tripPick,
    setTripPick,
    tripOrigin,
    tripDest,
    setTripPreview,
    tripNonce,
    setTripNonce,
    savedPlaces,
    lastSavedTrip,
    resolveTripPointAddress,
    updateTripOrigin,
    updateTripDest,
    tripMapPlan,
    setTravelerStopEndpoint,
    handleSwapTripPoints,
    handleClearTripPoints,
    handleSaveContextPlace,
    handleDeleteSavedPlace,
    handleRestoreLastTrip,
  } = useTravelerJourneyState({
    isPlanner,
    showToast,
    onClearContextMenu: clearContextMenu,
    onClearSelectedStop: clearSelectedStop,
  });

  // Kursówki dialog & shape overlay
  const [kursowkiOpen, setKursowkiOpen] = useState(false);
  const [linesOpen, setLinesOpen] = useState(false);
  const [scheduleDiffOpen, setScheduleDiffOpen] = useState(false);
  const [scheduleDiffPreset, setScheduleDiffPreset] = useState<"default" | "ns-nh">("default");
  const openScheduleDiff = useCallback((preset: "default" | "ns-nh" = "default") => {
    if (!isPlanner) return;
    setScheduleDiffPreset(preset);
    setScheduleDiffOpen(true);
  }, [isPlanner]);

  const {
    liveVehicles,
    liveTraffic,
    operatorFilter,
    setOperatorFilter,
    selectedLiveBus,
    setSelectedLiveBus,
    fetchLiveBuses,
    visibleLiveBuses,
    hasLiveBuses,
  } = useLiveFleetState({
    isPlanner,
    showLiveBuses,
    tripOpen,
    kursowkiOpen,
    hasSelectedStop: Boolean(selectedStop),
  });

  const [routeAuditOpen, setRouteAuditOpen] = useState(false);
  const [customGtfsBuilderOpen, setCustomGtfsBuilderOpen] = useState(false);
  const [customGtfsMapSession, setCustomGtfsMapSession] =
    useState<CustomGtfsMapSession | null>(null);
  const [customGtfsMapState, setCustomGtfsMapState] =
    useState<LineRouteEditorMapState | null>(null);
  const customGtfsMapHandlersRef = useRef<LineEditorMapHandlers | null>(null);
  const [customGtfsResumeTarget, setCustomGtfsResumeTarget] =
    useState<CustomGtfsResumeTarget | null>(null);
  const [gtfsPreviewStatus, setGtfsPreviewStatus] = useState<GtfsPreviewStatus>(() =>
    getGtfsPreviewStatus(),
  );
  const [kursowkaDeepLink, setKursowkaDeepLink] = useState<{
    id?: string | null;
    code?: string | null;
  }>({});
  const [kursowkaReturnDateId, setKursowkaReturnDateId] = useState<string | null>(null);
  const [kursowkaOverlay, setKursowkaOverlay] = useState<KursowkaShapeOverlay | null>(null);
  const [courseDrawerOpen, setCourseDrawerOpen] = useState(false);
  /**
   * Podróżny wybrał przystanek, do którego chce dojechać. `null` = cała trasa
   * kursu. Numer przystanku jest liczony w obrębie bieżącego kursu, więc każdy
   * nowy podgląd startuje z pełną trasą.
   */
  const [courseTargetStop, setCourseTargetStop] = useState<number | null>(null);
  const [courseFocusNonce, setCourseFocusNonce] = useState(0);
  /**
   * Panel kursu zwinięty na telefonie — dopasowanie trasy musi oddać całą mapę.
   * `null` = karta jeszcze nie zgłosiła stanu; wtedy nie rezerwujemy miejsca,
   * dopóki strona nie zmierzy panelu (`CoursePreviewCard` zgłasza otwarcie).
   */
  const [courseSidebarOpen, setCourseSidebarOpen] = useState<boolean | null>(null);
  /** Bieżący overlay bez wycinka — do odczytu w callbackach mapy. */
  const kursowkaOverlayRef = useRef<KursowkaShapeOverlay | null>(null);
  /** Czy widoczna trasa pochodzi z kliknięcia autobusu (wtedy znika z kartą). */
  const [busOverlay, setBusOverlay] = useState(false);
  const [routeProgressStatus, setRouteProgressStatus] = useState<LiveRouteProgressStatus | null>(null);
  /** Który autobus poprosił o trasę — chroni przed spóźnioną odpowiedzią. */
  const busOverlayRequestRef = useRef<object | null>(null);
  // Reject previews started before a profile switch, even if they finish later.
  const overlayEpochRef = useRef(0);
  const overlayEpoch = overlayEpochRef.current;

  // Route editing & dialogs
  const [addMode, setAddMode] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [clearNonce, setClearNonce] = useState(0);
  const [mobileExpanded, setMobileExpanded] = useState(false);

  const [stepsOpen, setStepsOpen] = useState(false);
  const [fleetOpen, setFleetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  // Moduł Planisty: edytor przebiegu tras linii (zapis + widoczność u wszystkich)
  const [lineEditorOpen, setLineEditorOpen] = useState(false);
  const [lineEditorTarget, setLineEditorTarget] = useState<{
    lineShort: string | null;
    variantKey: string | null;
  }>({ lineShort: null, variantKey: null });
  const [lineEditorMapState, setLineEditorMapState] =
    useState<LineRouteEditorMapState | null>(null);
  const lineEditorHandlersRef = useRef<LineEditorMapHandlers | null>(null);
  const [editedRoutesCount, setEditedRoutesCount] = useState<number>(
    () => getOverridesSummary().totalActive,
  );

  useEffect(() => {
    void initLineRouteOverrides();
    return onRuntimeEvent("routes:overrides-updated", () => {
      setEditedRoutesCount(getOverridesSummary().totalActive);
    });
  }, []);

  useEffect(() => {
    if (!isPlanner) {
      setLineEditorOpen(false);
      setLineEditorMapState(null);
    }
  }, [isPlanner]);

  const openLineRouteEditor = useCallback(
    (lineShort: string | null = null, variantKey: string | null = null) => {
      if (!isPlanner) return;
      setKursowkiOpen(false);
      setLinesOpen(false);
      setAddMode(false);
      setPickTarget(null);
      setKursowkaOverlay(null);
      setBusOverlay(false);
      setLineEditorTarget({ lineShort, variantKey });
      setLineEditorOpen(true);
      if (typeof window !== "undefined" && window.innerWidth < 1024) {
        setMobileExpanded(true);
      }
    },
    [isPlanner],
  );

  const openInformation = useCallback(() => {
    if (isPlanner) setSettingsOpen(true);
  }, [isPlanner]);

  const [pickTarget, setPickTarget] = useState<string | null>(null);
  const [focus, setFocus] = useState<{
    lat: number;
    lon: number;
    zoom?: number;
    nonce: number;
  } | null>(null);

  // GPS użytkownika: prośba o zgodę przy otwarciu strony, potem centrowanie mapy.
  const { status: locationStatus, location: userLocation, start: startLocation } =
    useUserLocation({ autoStart: true });
  const [followUser, setFollowUser] = useState(false);
  const [centerUserNonce, setCenterUserNonce] = useState(0);
  const userPannedRef = useRef(false);
  const autoCenteredRef = useRef(false);

  const mapRef = useRef<MapHandle | null>(null);
  const mapAreaRef = useRef<HTMLElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const busAbortRef = useRef<AbortController | null>(null);

  const waypointsRef = useRef(waypoints);
  waypointsRef.current = waypoints;

  const collapseMobileSheet = useCallback(() => {
    setMobileExpanded(false);
  }, []);

  const {
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
  } = usePlannerRouting({
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
    onCollapseMobileSheet: collapseMobileSheet,
  });

  // Trigger initial client-side GTFS seed check once
  useEffect(() => {
    void ensureGtfsSeeded().catch(() => undefined);
  }, []);

  // Deep links: #/walbrzych/brigades/2?date=YYYYMMDD
  useEffect(() => {
    if (window.location.hash.includes("/walbrzych/brigades/")) {
      setKursowkiOpen(true);
      setSidebarView("kursowki");
      setMapSidebarOpen(true);
    }
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (contextMenuRef.current?.contains(target)) return;
      if (event.button === 2 && mapAreaRef.current?.contains(target)) return;
      setContextMenu(null);
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

  // A saved "near route" preference must not blank a fresh map with no route.
  const stopDisplay =
    visibility.stops === "route" && activeRoute.coords.length < 2 ? "all" : visibility.stops;

  const visibleStops = useMemo(() => filterStops(busStops, busQuery), [busStops, busQuery]);

  const usedStopKeys = useMemo(
    () =>
      isPlanner
        ? new Set(
            waypoints
              .filter(isWaypointSet)
              .map((point) => coordKey(point.lat, point.lon, 5))
          )
        : EMPTY_STRING_SET,
    [isPlanner, waypoints]
  );
  const nearRoute = useMemo(() => {
    if (!isPlanner || activeRoute.coords.length < 2) return EMPTY_NEAR_MAP;
    return new Map(
      stopsAlongRoute(busStops, activeRoute.coords, 70).map((item) => [item.stop.id, item.distance])
    );
  }, [isPlanner, busStops, activeRoute.coords]);
  const nearRouteIds = useMemo(
    () => (nearRoute.size === 0 ? EMPTY_STRING_SET : new Set(nearRoute.keys())),
    [nearRoute]
  );
  const mapStops = useMemo(() => {
    if (stopDisplay === "off") return [];
    if (stopDisplay === "route") return visibleStops.filter((stop) => nearRouteIds.has(stop.id));
    return visibleStops;
  }, [stopDisplay, visibleStops, nearRouteIds]);
  const showingSnapshotStops = busStops.some((stop) => stop.source === "snapshot");
  const selectedStopInRoute = Boolean(
    isPlanner &&
      selectedStop &&
      usedStopKeys.has(coordKey(selectedStop.lat, selectedStop.lon, 5))
  );

  useEffect(() => {
    replaceFleet(fleet);
    writeStorageJson(FLEET_STORAGE_KEY, fleet);
  }, [fleet]);

  useEffect(() => {
    writeStorageJson(SPEEDS_KEY, cleanSpeeds(speeds, fleet));
  }, [speeds, fleet]);

  useEffect(() => {
    writeStorageJson(SCHEDULE_STORAGE_KEY, schedule);
  }, [schedule]);

  useEffect(() => {
    saveBrigade(brigade);
  }, [brigade]);

  useEffect(() => {
    persistSavedBrigades(savedBrigades);
  }, [savedBrigades]);

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
    const query = window.matchMedia("(min-width: 768px)");
    const handleChange = (event: MediaQueryListEvent) => {
      setIsRailViewport(event.matches);
    };
    setIsRailViewport(query.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  // Wyznaczanie dojazdu otwiera się bezpośrednio jako widok w lewym sidebarze;
  // na wąskim ekranie telefonu podczas wskazywania punktu na mapie tymczasowo
  // chowamy szufladę, aby odsłonić mapę pod palcem.
  useEffect(() => {
    if (isPlanner || !tripOpen) return;
    if (tripPick && !isRailViewport) {
      setMapSidebarOpen(false);
      return;
    }
    setSidebarView("trip");
    setMapSidebarOpen(true);
  }, [isPlanner, tripOpen, tripPick, isRailViewport]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    writeStorageText(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    writeStorageText(ROLE_STORAGE_KEY, role);
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

  const clearBusAndCourseTargetForNav = useCallback(() => {
    setCourseTargetStop(null);
    setBusOverlay(false);
    setSelectedLiveBus(null);
  }, [setSelectedLiveBus]);

  const collapseMobileDrawersForNav = useCallback(() => {
    if (!isRailViewportRef.current) {
      setMapSidebarOpen(false);
      setCourseDrawerOpen(false);
    }
  }, []);

  const {
    courseNavRoute,
    courseNavMode,
    courseNavSimPlaying,
    courseNavSimSpeed,
    courseNavStartedAt,
    courseNavPunctualityMode,
    courseNavFollowCamera,
    setCourseNavFollowCamera,
    courseNavState,
    courseNavProgressOverlay,
    stopCourseNavigation,
    startCourseNavigation,
    handleNavModeChange,
    handleToggleSimPlay,
    handleCycleSimSpeed,
    handleRecenterNavCamera,
    handleTogglePunctualityMode,
    handleStepNavStop,
    handleJumpToNavStop,
  } = useCourseNavigation({
    userLocation,
    locationStatus,
    startLocation,
    stopNavigation,
    onClearBusAndCourseTarget: clearBusAndCourseTargetForNav,
    onCollapseMobileDrawers: collapseMobileDrawersForNav,
    mapRef,
    showToast,
  });

  const handleRoleChange = (next: AppRole) => {
    if (next === role) return;
    overlayEpochRef.current += 1;
    stopNavigation();
    setAddMode(false);
    setPickTarget(null);
    setContextMenu(null);
    setSelectedStop(null);
    setSelectedLiveBus(null);
    setKursowkiOpen(false);
    setLinesOpen(false);
    setScheduleDiffOpen(false);
    stopCourseNavigation();
    setKursowkaOverlay(null);
    // The information window is available only to a logged-in planner.
    setSettingsOpen(false);
    setRole(next);
    showToast(
      next === "planner"
        ? "Zalogowano jako Planista: pełny planer tras, PDF, raporty i flota."
        : "Wylogowano. Widok użytkownika: mapa, GPS, rozkład oraz wybór startu i celu prawym na mapie."
    );
  };

  const loadBusStops = useCallback(async (
    bounds: Bounds,
    scope: string,
    force = false,
    preserveOutside = false
  ) => {
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
      if (!stops.length) {
        setBusError("Brak przystanków obsługiwanych przez autobusy i kursówki w tym obszarze.");
        // Keep the saved snapshot if the entire timetable has no usable stops.
        if (!preserveOutside) return;
      }
      setBusStops((current) =>
        preserveOutside ? mergeRefreshedBusStops(current, stops, bounds) : stops
      );
      if (!preserveOutside) {
        setSelectedStop((current) => {
          if (!current) return null;
          const refreshed = findRefreshedBusStop(current, stops);
          // A selected snapshot may not exist in the newly loaded archive.
          // Keep its card open so the independent timetable can still answer.
          return refreshed ?? (current.source === "snapshot" ? current : null);
        });
      }
      setBusScope(scope);
    } catch (error) {
      if (controller.signal.aborted) return;
      setBusError(
        error instanceof Error && error.name !== "AbortError"
          ? error.message
          : "Nie udało się pobrać przystanków. Spróbuj ponownie."
      );
    } finally {
      if (!controller.signal.aborted) setBusLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBusStops(WALBRZYCH_BOUNDS, "Wałbrzych i okolice");
    const offGtfs = onRuntimeEvent("gtfs:updated", () => {
      // The event has already invalidated the caches. Do not block initial stops
      // on the optional Overpass request for shelter information.
      setGtfsPreviewStatus(getGtfsPreviewStatus());
      setTripNonce((value) => value + 1);
      void loadBusStops(WALBRZYCH_BOUNDS, "Wałbrzych i okolice");
    });
    return () => {
      offGtfs();
      busAbortRef.current?.abort();
    };
  }, [loadBusStops]);

  const refreshBusStops = useCallback(() => {
    const bounds = mapRef.current?.getBounds();
    if (!bounds) return;
    // The bus button should not silently refresh an invisible layer.
    if (visibility.stops === "off") updateVisibility({ stops: "all" });
    setSelectedStop(null);
    void loadBusStops(bounds, "Wałbrzych i okolice + bieżący widok", true, true);
  }, [loadBusStops, updateVisibility, visibility.stops]);

  const selectBusStop = useCallback((stop: BusStop, center: boolean) => {
    // A late first GPS fix must not move the map away from the selected stop.
    userPannedRef.current = true;
    setFollowUser(false);
    setSelectedLiveBus(null);
    setSelectedStop((current) => {
      const next = current?.id === stop.id ? null : stop;
      if (next) {
        setSidebarView("stop");
        setMapSidebarOpen(true);
      } else {
        setSidebarView("home");
        if (!isRailViewportRef.current) setMapSidebarOpen(false);
      }
      return next;
    });
    if (center) mapRef.current?.centerOn(stop.lat, stop.lon, 16);
  }, []);

  const selectStopFromFinder = useCallback((stop: BusStop) => {
    userPannedRef.current = true;
    setFollowUser(false);
    busOverlayRequestRef.current = null;
    setSelectedLiveBus(null);
    setSelectedStop(stop);
    setSidebarView("stop");
    setMapSidebarOpen(true);
    setBusQuery("");
    updateVisibility({ stops: "all" });
    mapRef.current?.centerOn(stop.lat, stop.lon, 16);
  }, [updateVisibility]);

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
      queueFitOnNextRoute();
      setMobileExpanded(false);
      showToast(
        effectiveRole === "via"
          ? `Przystanek ${stopDisplayName(stop)} dodany do trasy.`
          : effectiveRole === "start"
            ? `Start ustawiony na przystanku ${stopDisplayName(stop)}.`
            : `Meta ustawiona na przystanku ${stopDisplayName(stop)}.`
      );
    },
    [showToast, stopNavigation, route, routeReady, queueFitOnNextRoute]
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
        .map((point) => coordKey(point.lat, point.lon, 5))
    );
    const working = [...current];
    let offset = 0;
    let added = 0;
    for (const item of near) {
      if (working.length >= MAX_WAYPOINTS) break;
      const key = coordKey(item.stop.lat, item.stop.lon, 5);
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
    queueFitOnNextRoute();
    setMobileExpanded(false);
    showToast(
      added === 1
        ? "Dodano 1 przystanek przy trasie."
        : `Dodano ${added} przystanków w kolejności przejazdu.`
    );
  }, [busStops, route, routeReady, showToast, stopNavigation, queueFitOnNextRoute]);

  // Do not automatically abandon Wałbrzych when GPS is far from its stops.
  // Explicitly pressing the location button still works anywhere in the world.
  useEffect(() => {
    if (!userLocation || autoCenteredRef.current) return;
    autoCenteredRef.current = true;
    if (userPannedRef.current || followUser) return;
    const nearAStop = busStops.some((stop) =>
      haversine([userLocation.lat, userLocation.lon], [stop.lat, stop.lon]) <= 350
    );
    if (!nearAStop) return;
    setFollowUser(true);
    setCenterUserNonce((value) => value + 1);
  }, [userLocation, busStops, followUser]);

  const centerOnMe = useCallback(() => {
    if (locationStatus === "unavailable") {
      showToast("Ta przeglądarka nie udostępnia lokalizacji GPS.");
      return;
    }
    if (locationStatus === "denied") {
      startLocation();
      showToast(
        "Lokalizacja jest zablokowana. Zezwól na nią w ustawieniach strony w przeglądarce.",
      );
      return;
    }
    startLocation();
    if (!userLocation) {
      showToast("Szukam lokalizacji GPS…");
    }
    setFollowUser(true);
    setCenterUserNonce((value) => value + 1);
  }, [locationStatus, showToast, startLocation, userLocation]);

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
    if (options.fit) queueFitOnNextRoute();
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

  const handleMapContextMenu = (
    lat: number,
    lon: number,
    clientX: number,
    clientY: number,
    explicitStop?: BusStop
  ) => {
    const bounds = mapAreaRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const matchedStop = explicitStop ?? nearestStop(lat, lon, 18) ?? undefined;
    const targetLat = matchedStop ? matchedStop.lat : lat;
    const targetLon = matchedStop ? matchedStop.lon : lon;

    const menuWidth = Math.min(248, Math.max(180, bounds.width - 16));
    const extraTravelerRows = !isPlanner
      ? 1 + (tripOrigin && tripDest ? 1 : 0) + (tripOrigin || tripDest ? 1 : 0)
      : 0;
    const menuHeight = 152 + extraTravelerRows * 34;

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
    setTripPick(null);
    setAddMode(false);
    setContextMenu({
      lat: targetLat,
      lon: targetLon,
      left,
      top,
      stop: matchedStop,
      addressLabel: null,
    });

    if (!matchedStop) {
      reverseGeocode(targetLat, targetLon)
        .then((place) => {
          if (!place?.short) return;
          setContextMenu((current) =>
            current &&
            !current.stop &&
            Math.abs(current.lat - targetLat) < 0.00001 &&
            Math.abs(current.lon - targetLon) < 0.00001
              ? { ...current, addressLabel: place.short.slice(0, 56) }
              : current
          );
        })
        .catch(() => undefined);
    }
  };

  const setContextCoordinate = (target: "start" | "end") => {
    if (!contextMenu) return;
    const { lat, lon, stop, addressLabel } = contextMenu;
    setContextMenu(null);
    setSelectedStop(null);
    setSelectedLiveBus(null);
    setPickTarget(null);
    setTripPick(null);
    setAddMode(false);
    setMobileExpanded(false);

    if (!isPlanner) {
      const fallbackLabel = `Punkt (${lat.toFixed(5)}, ${lon.toFixed(5)})`;
      const point: TripPoint = stop
        ? {
            lat: stop.lat,
            lon: stop.lon,
            label: stopDisplayName(stop),
            stopId: stop.gtfsId,
            stopIds: stop.gtfsIds,
          }
        : {
            lat,
            lon,
            label: addressLabel || fallbackLabel,
          };

      setTripOpen(true);
      if (target === "start") {
        updateTripOrigin(point);
        if (!stop && !addressLabel) {
          resolveTripPointAddress("origin", lat, lon);
        }
        showToast(
          tripDest
            ? "Miejsce startowe ustawione — wyznaczam połączenia."
            : "Miejsce startowe ustawione. Kliknij prawym na mapie, aby wybrać miejsce docelowe."
        );
      } else {
        updateTripDest(point);
        if (!stop && !addressLabel) {
          resolveTripPointAddress("destination", lat, lon);
        }
        showToast(
          tripOrigin
            ? "Miejsce docelowe ustawione — wyznaczam połączenia."
            : "Miejsce docelowe ustawione. Kliknij prawym na mapie, aby wybrać miejsce startowe."
        );
      }
      return;
    }

    const current = waypointsRef.current;
    const endpoint = target === "start" ? current[0] : current[current.length - 1];
    if (!endpoint) return;
    if (stop) {
      addBusStop(stop, target);
      return;
    }
    updateCoordinate(endpoint.id, lat, lon, { fit: true, resolveAddress: false });
    showToast(`${target === "start" ? "Miejsce startowe" : "Miejsce końcowe"} ustawione.`);
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
    queueFitOnNextRoute();
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
      const point: TripPoint = { lat, lon, label: `Punkt (${lat.toFixed(5)}, ${lon.toFixed(5)})` };
      setTripOpen(true);
      if (tripPick === "origin") {
        updateTripOrigin(point);
        resolveTripPointAddress("origin", lat, lon);
        showToast("Punkt startowy ustawiony.");
      } else {
        updateTripDest(point);
        resolveTripPointAddress("destination", lat, lon);
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
    resetRoutingState({ clearSavedSignature: true });
    clearLastRoute();
    setPickTarget((current) => (current === id ? null : current));
    setClearNonce((current) => current + 1);
    setWaypoints((current) =>
      current.map((point) => (point.id === id ? createEmptyWaypoint(point.id) : point))
    );
  };

  const handleClearRoute = () => {
    stopNavigation();
    resetRoutingState({ clearSavedSignature: true, cancelPendingFit: true });
    clearLastRoute();
    setAddMode(false);
    setPickTarget(null);
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
    queueFitOnNextRoute();
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
    queueFitOnNextRoute();
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
    queueFitOnNextRoute();
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

  const handleRecalculate = requestRouteRecalculate;
  const handleSaveRoute = saveCurrentRouteSnapshot;

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
    applySavedBrigadeRoute(plan.waypoints, plan.avoid, plan.route);
    setAvoid(plan.avoid);
    setWaypoints(plan.waypoints);
    showToast(`Wczytano brygadę: ${plan.title}.`);
  };

  const handleDeleteBrigadePlan = (id: string) => {
    setSavedBrigades((current) => current.filter((item) => item.id !== id));
    showToast("Usunięto zapisaną brygadę.");
  };

  const handleOpenKursowkaFromItem = useCallback((kursowkaId: string, kursowkaCode: string) => {
    setKursowkaDeepLink({ id: kursowkaId || null, code: kursowkaCode || null });
    setKursowkaReturnDateId(null);
    setLinesOpen(false);
    setKursowkiOpen(true);
    setSidebarView("kursowki");
    setMapSidebarOpen(true);
  }, []);

  const handlePreviewCourse = useCallback(async (
    tripId: string,
    dateId: string,
    options?: { silent?: boolean },
  ): Promise<boolean> => {
    const epoch = overlayEpochRef.current;
    try {
      const course = await getCoursePreview(tripId, dateId);
      if (epoch !== overlayEpochRef.current) return false;
      if (!course) {
        if (!options?.silent) {
          showToast("Ten kurs nie jest dostępny w rozkładzie na wybrany dzień.");
        }
        return false;
      }
      setKursowkaOverlay({
        title: `Kurs ${course.routeShort} · ${formatWarsawClock(course.startMs)} → ${formatWarsawClock(course.endMs)}`,
        color: course.color,
        polylines: course.polylines,
        stops: course.stops.map(({ name, lat, lon }) => ({ name, lat, lon })),
        course,
      });
      setKursowkaReturnDateId(course.dateId);
      setBusOverlay(false);
      setSelectedStop(null);
      setSelectedLiveBus(null);
      setTripOpen(false);
      setTripPick(null);
      setContextMenu(null);
      if (isRailViewportRef.current) {
        setSidebarView("course");
        setMapSidebarOpen(true);
        setCourseSidebarOpen(true);
      } else {
        setMapSidebarOpen(false);
      }
      if (!options?.silent) {
        showToast(`Pokazuję przebieg kursu linii ${course.routeShort} i ${course.stops.length} przystanków.`);
      }
      return true;
    } catch {
      if (epoch === overlayEpochRef.current) {
        showToast("Nie udało się wyświetlić przebiegu kursu. Spróbuj ponownie.");
      }
      return false;
    }
  }, [showToast]);

  kursowkaOverlayRef.current = kursowkaOverlay;

  // Nowy kurs = znowu cała trasa (wybór przystanku dotyczy jednego kursu).
  const courseTripKey = kursowkaOverlay?.course
    ? `${kursowkaOverlay.course.tripId}|${kursowkaOverlay.course.dateId}`
    : null;
  useEffect(() => {
    setCourseTargetStop(null);
    // Nowy podgląd kursu startuje z otwartym panelem (na telefonie karta sama
    // startuje zwinięta i zgłosi to przez `onDrawerOpenChange`).
    setCourseSidebarOpen(null);
  }, [courseTripKey]);

  // Karta pojazdu zamknięta (dowolną drogą) → jej trasa też znika z mapy,
  // żeby nie zostawała „sierota” po wybraniu innego obiektu.
  useEffect(() => {
    if (selectedLiveBus) return;
    busOverlayRequestRef.current = null;
    if (!busOverlay) return;
    setBusOverlay(false);
    setKursowkaOverlay(null);
  }, [selectedLiveBus, busOverlay]);

  /**
   * Trasa do wybranego przystanku. Liczymy ją z tej samej geometrii, którą
   * rysuje mapa (ciągła linia kursu), i wkładamy do overlayu, więc mapa,
   * przycisk „dopasuj” i panel korzystają z jednego źródła prawdy.
   */
  const courseRouteTarget = useMemo<CourseRouteTarget | null>(() => {
    const course = kursowkaOverlay?.course;
    if (isPlanner || !course || courseTargetStop == null) return null;
    if (courseTargetStop < 0 || courseTargetStop >= course.stops.length) return null;
    const slice = courseStopTarget(course, courseTargetStop);
    if (!slice) return null;
    return {
      stopIndex: slice.stopIndex,
      stopName: course.stops[slice.stopIndex].name,
      path: slice.path,
      meters: slice.meters,
      rideMs: slice.rideMs,
      departMs: slice.departMs,
      arriveMs: slice.arriveMs,
    };
  }, [isPlanner, kursowkaOverlay, courseTargetStop]);

  const overlayWithTarget = useMemo<KursowkaShapeOverlay | null>(
    () => (kursowkaOverlay ? { ...kursowkaOverlay, courseTarget: courseRouteTarget } : null),
    [kursowkaOverlay, courseRouteTarget],
  );

  /**
   * Klik w przystanek kursu na mapie: pokaż trasę do niego i podświetl jego
   * wiersz w panelu (albo całą trasę, gdy kliknięto ten sam przystanek).
   */
  const toggleCourseTarget = useCallback(
    (index: number | null) => {
      const course = kursowkaOverlayRef.current?.course;
      if (index != null && course && index >= 0) {
        setCourseTargetStop((previous) => (previous === index ? null : index));
        setCourseFocusNonce((value) => value + 1);
        showToast(
          `Trasa kursu ${course.routeShort} do przystanku: ${
            course.stops[index]?.name ?? ""
          } — ${formatWarsawClock(course.stops[index]?.departureMs ?? course.startMs)} → ${
            formatWarsawClock(course.stops[index]?.arrivalMs ?? course.endMs)
          }.`,
        );
        return;
      }
      setCourseTargetStop(null);
      showToast("Cała trasa kursu na mapie.");
    },
    [showToast],
  );

  // Klik w kropkę przystanku na mapie działa tak samo jak klik w liście panelu.
  const handleCourseStopClick = useCallback(
    (routeStop: CoursePreviewStop) => {
      const course = kursowkaOverlayRef.current?.course;
      if (!course) return;
      const index = course.stops.findIndex(
        (stop) => stop.sequence === routeStop.sequence && stop.name === routeStop.name,
      );
      if (index < 0) return;
      if (index === 0) {
        toggleCourseTarget(null);
        showToast("To pierwszy przystanek kursu — pokazuję całą trasę.");
        return;
      }
      toggleCourseTarget(index);
    },
    [toggleCourseTarget],
  );

  const closeLiveBus = useCallback(() => {
    busOverlayRequestRef.current = null;
    setSelectedLiveBus(null);
    setSidebarView((current) => (current === "bus" ? "home" : current));
  }, []);

  const handleSelectBus = useCallback((bus: LiveBusVehicle) => {
    setOperatorFilter("all");
    updateVisibility({ liveBuses: true });
    setSelectedStop(null);
    setSelectedLiveBus(bus);
    if (isRailViewportRef.current) {
      setSidebarView("bus");
      setMapSidebarOpen(true);
    } else {
      setMapSidebarOpen(false);
    }
    // Nigdy nie zostawiaj poprzedniej trasy pod nowo wybranym pojazdem.
    setKursowkaOverlay(null);
    setBusOverlay(false);
    setRouteProgressStatus(null);
    setKursowkiOpen(false);
    setMobileExpanded(false);
    mapRef.current?.centerOn(bus.lat, bus.lon, 16);
    // myBus 3.0: klik w autobus od razu pokazuje, jak jedzie — trasa kursu na
    // mapie, a w karcie pełna lista przystanków. Kurs bierzemy z tego samego
    // dopasowania co lista przystanków i nie wymagamy przy tym aktywnej obsługi
    // w wybranym dniu — autobus jedzie tym kursem właśnie teraz.
    const request = {};
    busOverlayRequestRef.current = request;
    void getVehicleRouteOverlay(bus)
      .then((overlay) => {
        if (busOverlayRequestRef.current !== request) return;
        if (!overlay) {
          showToast(
            "Nie udało się narysować trasy tego kursu — nie ma go w rozkładzie. Przystanki w karcie pochodzą z GPS.",
          );
          return;
        }
        // Trasa tego autobusu: część za pojazdem rysujemy na szaro (patrz MapView).
        setKursowkaOverlay({ ...overlay, liveVehicleId: bus.vehicleId });
        setBusOverlay(true);
      })
      .catch(() => {
        if (busOverlayRequestRef.current === request) {
          showToast("Nie udało się narysować trasy tego kursu.");
        }
      });
  }, [showToast]);

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
      resetRoutingState();
      setAddMode(false);
      setPickTarget(null);
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
      queueFitOnNextRoute();
      setKursowkiOpen(false);
      setMobileExpanded(false);
      showToast(
        `Wczytano kurs kursówki ${payload.duty} (${payload.headsign || `${payload.waypoints.length} przyst.`}) do Planera.`
      );
    },
    [stopNavigation, resetRoutingState, queueFitOnNextRoute, showToast]
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
    refreshClockNow();
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
  const navCoord = useMemo<[number, number] | null>(() => {
    if (courseNavState) return courseNavState.position;
    return navActive ? pointAtProgress(activeRoute, navProgress) : null;
  }, [courseNavState, navActive, activeRoute, navProgress]);

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
    onOpenLineEditor: () => openLineRouteEditor(null, null),
    editedRoutesCount,
    onOpenScheduleDiff: () => openScheduleDiff("default"),
    onOpenNsNhDiff: () => openScheduleDiff("ns-nh"),
    onOpenRouteAudit: () => setRouteAuditOpen(true),
    onOpenCustomGtfsBuilder: () => setCustomGtfsBuilderOpen(true),
  };

  const anyDialogOpen =
    plannerLoginOpen ||
    scheduleDiffOpen ||
    routeAuditOpen ||
    customGtfsBuilderOpen ||
    stepsOpen ||
    fleetOpen ||
    settingsOpen ||
    reportOpen ||
    pdfOpen;

  return (
    <div className="flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-canvas text-ink">
      <PerfHud />

      <div className="flex min-h-0 flex-1">
        {isDesktop && isPlanner && (
          <aside className="flex min-h-0 w-[404px] shrink-0 flex-col border-r border-line bg-canvas 2xl:w-[416px]">
            <Suspense
              fallback={
                <div className="flex flex-1 items-center justify-center p-4 text-xs text-mute">
                  Ładowanie planera…
                </div>
              }
            >
              {lineEditorOpen ? (
                <LineRouteEditorPanel
                  initialLineShort={lineEditorTarget.lineShort}
                  initialVariantKey={lineEditorTarget.variantKey}
                  onClose={() => {
                    setLineEditorOpen(false);
                    setLineEditorMapState(null);
                  }}
                  onMapStateChange={setLineEditorMapState}
                  handlersRef={lineEditorHandlersRef}
                  onToast={showToast}
                />
              ) : (
                <PlanningPanel {...panelProps} />
              )}
            </Suspense>
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
              waypoints={isPlanner ? waypoints : []}
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
                if (isPlanner && lineEditorOpen && lineEditorMapState) {
                  if (
                    lineEditorMapState.mode === "draw" ||
                    (lineEditorMapState.mode === "segment" &&
                      lineEditorMapState.segmentStartIndex !== null &&
                      lineEditorMapState.segmentEndIndex !== null)
                  ) {
                    lineEditorHandlersRef.current?.onMapClick(stop.lat, stop.lon);
                    return;
                  }
                }
                if (tripPick) {
                  const point: TripPoint = { lat: stop.lat, lon: stop.lon, label: stop.name, stopId: stop.gtfsId, stopIds: stop.gtfsIds };
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
                // Klik w ten sam autobus zamyka kartę i chowa jego trasę;
                // klik w inny otwiera kartę i rysuje trasę jego kursu.
                if (liveBusTap(selectedLiveBus?.vehicleId ?? null, bus.vehicleId) === "close") {
                  closeLiveBus();
                  return;
                }
                handleSelectBus(bus);
              }}
              trafficSignals={trafficSignals}
              showTrafficSignals={showTrafficSignals}
              turnaroundSpots={turnaroundSpots}
              showTurnarounds={showTurnarounds}
              kursowkaOverlay={overlayWithTarget}
              onCourseStopClick={!isPlanner ? handleCourseStopClick : undefined}
              courseSidebarOpen={courseSidebarOpen}
              onRouteProgressStatusChange={setRouteProgressStatus}
              bottomSheetOpen={Boolean(selectedLiveBus) && busOverlay}
              tripPlan={kursowkaOverlay ? null : tripMapPlan}
              tripOriginEditing={tripPick === "origin"}
              onTripOriginPick={() => {
                setTripPick("origin");
                setSelectedStop(null);
                showToast("Przeciągnij start lub kliknij nowe miejsce na mapie. Esc anuluje wybór.");
              }}
              onTripOriginMove={(lat, lon) => {
                setTripOpen(true);
                updateTripOrigin({ lat, lon, label: `Start (${lat.toFixed(5)}, ${lon.toFixed(5)})` });
                resolveTripPointAddress("origin", lat, lon);
                setTripPick(null);
                showToast("Start przesunięty. Przeliczam połączenia i dojścia piesze.");
              }}
              tripDestinationEditing={tripPick === "destination"}
              onTripDestinationPick={() => {
                setTripPick("destination");
                setSelectedStop(null);
                showToast("Przeciągnij cel lub kliknij nowe miejsce na mapie. Esc anuluje wybór.");
              }}
              onTripDestinationMove={(lat, lon) => {
                setTripOpen(true);
                updateTripDest({ lat, lon, label: `Cel (${lat.toFixed(5)}, ${lon.toFixed(5)})` });
                resolveTripPointAddress("destination", lat, lon);
                setTripPick(null);
                showToast("Cel przesunięty. Przeliczam połączenia i dojścia piesze.");
              }}
              navCoord={navCoord}
              followNav={courseNavState ? courseNavFollowCamera : navActive && navPlaying}
              courseNavProgress={courseNavProgressOverlay}
              focus={focus}
              userLocation={userLocation}
              followUser={followUser}
              centerUserNonce={centerUserNonce}
              onUserPan={() => {
                userPannedRef.current = true;
                setFollowUser(false);
                if (courseNavRoute) setCourseNavFollowCamera(false);
              }}
              onLineClick={handleLineClick}
              onMarkerDrag={handleMarkerDrag}
              onMapClick={handleMapClick}
              onMapContextMenu={handleMapContextMenu}
              lineRouteEditor={
                isPlanner && customGtfsMapSession
                  ? customGtfsMapState
                  : isPlanner && lineEditorOpen
                    ? lineEditorMapState
                    : null
              }
              onLineEditorVertexMove={(index, lat, lon) =>
                (customGtfsMapSession
                  ? customGtfsMapHandlersRef.current
                  : lineEditorHandlersRef.current
                )?.onVertexMove(index, lat, lon)
              }
              onLineEditorVertexInsert={(lat, lon) =>
                (customGtfsMapSession
                  ? customGtfsMapHandlersRef.current
                  : lineEditorHandlersRef.current
                )?.onVertexInsert(lat, lon)
              }
              onLineEditorVertexRemove={(index) =>
                (customGtfsMapSession
                  ? customGtfsMapHandlersRef.current
                  : lineEditorHandlersRef.current
                )?.onVertexRemove(index)
              }
              onLineEditorMapClick={(lat, lon) =>
                (customGtfsMapSession
                  ? customGtfsMapHandlersRef.current
                  : lineEditorHandlersRef.current
                )?.onMapClick(lat, lon)
              }
              onLineEditorSegmentPickVertex={(index) =>
                (customGtfsMapSession
                  ? customGtfsMapHandlersRef.current
                  : lineEditorHandlersRef.current
                )?.onSegmentPickVertex(index)
              }
              onLineEditorBoxSelect={(indices, additive) =>
                (customGtfsMapSession
                  ? customGtfsMapHandlersRef.current
                  : lineEditorHandlersRef.current
                )?.onBoxSelect(indices, additive)
              }
              onLineEditorToggleSelectVertex={(index) =>
                (customGtfsMapSession
                  ? customGtfsMapHandlersRef.current
                  : lineEditorHandlersRef.current
                )?.onToggleSelectVertex(index)
              }
              onLineEditorDeleteSelected={() =>
                (customGtfsMapSession
                  ? customGtfsMapHandlersRef.current
                  : lineEditorHandlersRef.current
                )?.onDeleteSelected()
              }
              onLineEditorClearSelection={() =>
                (customGtfsMapSession
                  ? customGtfsMapHandlersRef.current
                  : lineEditorHandlersRef.current
                )?.onClearSelection()
              }
            />
          </Suspense>

          <div className="pointer-events-none absolute inset-0 z-[500] select-none">
            <div
              className={`pointer-events-none absolute top-3 flex max-h-[calc(100%-24px)] max-w-[calc(100%-64px)] flex-col items-start gap-2 ${
                isRailViewport
                  ? mapSidebarOpen
                    ? "left-[420px]"
                    : "left-[60px]"
                  : "left-2.5 top-2.5"
              }`}
            >
              {gtfsPreviewStatus.active && (
                <div
                  role="status"
                  data-testid="gtfs-preview-banner"
                  className="pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-xl border border-emerald-500/45 bg-surface/96 px-2.5 py-1.5 text-[9px] font-bold text-ink shadow-[0_10px_28px_rgba(13,42,28,0.22)]"
                >
                  <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                  <span className="max-w-[240px] truncate font-extrabold text-emerald-700 dark:text-emerald-300">
                    Podgląd GTFS: {gtfsPreviewStatus.label}
                  </span>
                  {isPlanner && (
                    <button
                      type="button"
                      onClick={() => setCustomGtfsBuilderOpen(true)}
                      className="rounded-md border border-line bg-raised px-2 py-0.5 text-[8px] font-extrabold text-ink hover:border-brand/50"
                    >
                      Kreator
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="gtfs-preview-restore"
                    onClick={() => {
                      void restoreOriginalGtfsArchive().then(() => {
                        setKursowkaOverlay(null);
                        setSelectedStop(null);
                        showToast("Przywrócono oryginalny rozkład GTFS Wałbrzych.");
                      });
                    }}
                    className="rounded-md border border-amber-500/45 bg-amber-500/15 px-2 py-0.5 text-[8px] font-extrabold text-amber-800 hover:bg-amber-500/25 dark:text-amber-200"
                  >
                    Wróć do oryginału
                  </button>
                </div>
              )}
              {isPlanner && customGtfsMapSession ? (
                <Suspense fallback={null}>
                  <CustomGtfsMapDrawToolbar
                    session={customGtfsMapSession}
                    onMapStateChange={setCustomGtfsMapState}
                    handlersRef={customGtfsMapHandlersRef}
                    onApplyRoute={(lineId, variantId, drawnPath) => {
                      void (async () => {
                        const { loadCustomGtfsLines, upsertCustomGtfsLine } =
                          await import("@/lib/engine/customGtfsLines");
                        const all = await loadCustomGtfsLines();
                        const target = all.find((l) => l.id === lineId);
                        if (target) {
                          const updated = {
                            ...target,
                            updatedAt: new Date().toISOString(),
                            variants: target.variants.map((v) =>
                              v.id === variantId ? { ...v, path: drawnPath } : v,
                            ),
                          };
                          await upsertCustomGtfsLine(updated);
                        }
                        const km = (polylineLengthMeters(drawnPath) / 1000).toFixed(2);
                        setCustomGtfsMapSession(null);
                        setCustomGtfsMapState(null);
                        setCustomGtfsResumeTarget({
                          lineId,
                          variantId,
                          tab: "stops",
                          nonce: Date.now(),
                        });
                        setCustomGtfsBuilderOpen(true);
                        showToast(
                          `Zapisano trasę na mapie (${drawnPath.length} pkt · ${km} km).`,
                        );
                      })();
                    }}
                    onPickStopCoords={(lineId, variantId, lat, lon) => {
                      setCustomGtfsMapSession(null);
                      setCustomGtfsMapState(null);
                      setCustomGtfsResumeTarget({
                        lineId,
                        variantId,
                        tab: "stops",
                        pickedCoords: { lat, lon },
                        nonce: Date.now(),
                      });
                      setCustomGtfsBuilderOpen(true);
                      showToast(
                        `Wskazano lokalizację przystanku: ${lat.toFixed(5)}, ${lon.toFixed(5)}.`,
                      );
                    }}
                    onCancel={() => {
                      const prev = customGtfsMapSession;
                      setCustomGtfsMapSession(null);
                      setCustomGtfsMapState(null);
                      setCustomGtfsResumeTarget({
                        lineId: prev.lineId,
                        variantId: prev.variantId,
                        tab: "stops",
                        nonce: Date.now(),
                      });
                      setCustomGtfsBuilderOpen(true);
                    }}
                    onToast={showToast}
                  />
                </Suspense>
              ) : addMode ? (
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
                <div className="pointer-events-none flex min-h-0 flex-col items-start gap-1.5">
                  <div className={selectedLiveBus || courseDrawerOpen ? "hidden sm:contents" : "contents"}>
                    {!mapSidebarOpen && (
                      <MapQuickBar
                        sidebarOpen={mapSidebarOpen}
                        onToggleSidebar={() => setMapSidebarOpen((open) => !open)}
                        showLiveBuses={showLiveBuses}
                        hasLiveBuses={hasLiveBuses}
                        busStops={busStops}
                        onSelectBus={handleSelectBus}
                        onSelectStop={selectStopFromFinder}
                        isPlanner={isPlanner}
                        hideToggle={isRailViewport}
                      />
                    )}
                    {(isRailViewport || !mapSidebarOpen) && !courseNavRoute && (
                      <LiveFleetControl
                        isPlanner={isPlanner}
                        hideSearch
                        showLiveBuses={showLiveBuses}
                        onToggleLiveBuses={() => toggleVisibility("liveBuses")}
                        operatorFilter={operatorFilter}
                        onOperatorFilter={setOperatorFilter}
                        liveVehicles={liveVehicles}
                        busStops={busStops}
                        liveTraffic={liveTraffic}
                        onRefreshLive={() => void fetchLiveBuses(true)}
                        signalCount={isPlanner ? trafficSignals.length : 0}
                        showTrafficSignals={visibility.trafficSignals}
                        onToggleTrafficSignals={() => toggleVisibility("trafficSignals")}
                        turnaroundCount={isPlanner ? turnaroundSpots.length : 0}
                        showTurnarounds={visibility.turnarounds}
                        onToggleTurnarounds={() => toggleVisibility("turnarounds")}
                        onSelectBus={handleSelectBus}
                        onSelectStop={selectStopFromFinder}
                      />
                    )}
                  </div>
                  {/* Na telefonie (<768px) karta autobusu zostaje jako wygodna dolna szuflada nad mapą */}
                  {!isRailViewport && selectedLiveBus && (
                    <LiveBusCard
                      isPlanner={isPlanner}
                      bus={selectedLiveBus}
                      onClose={closeLiveBus}
                      onOpenKursowka={(code) => handleOpenKursowkaFromItem("", code)}
                      onSetOperator={handleSetOperator}
                      onCenter={() =>
                        mapRef.current?.centerOn(selectedLiveBus.lat, selectedLiveBus.lon, 16)
                      }
                    />
                  )}
                </div>
              )}
              {courseNavRoute && courseNavState && (
                <CourseNavigationHud
                  route={courseNavRoute}
                  state={courseNavState}
                  startedAtMs={courseNavStartedAt}
                  mode={courseNavMode}
                  onModeChange={handleNavModeChange}
                  simPlaying={courseNavSimPlaying}
                  onToggleSimPlay={handleToggleSimPlay}
                  simSpeedMultiplier={courseNavSimSpeed}
                  onCycleSimSpeed={handleCycleSimSpeed}
                  gpsAvailable={Boolean(userLocation)}
                  gpsSpeedKmh={userLocation?.speedKmh ?? null}
                  followingCamera={courseNavFollowCamera}
                  onRecenterCamera={handleRecenterNavCamera}
                  punctualityMode={courseNavPunctualityMode}
                  onTogglePunctualityMode={handleTogglePunctualityMode}
                  onStepStop={handleStepNavStop}
                  onJumpToStop={handleJumpToNavStop}
                  onStopNavigation={stopCourseNavigation}
                />
              )}
              {kursowkaOverlay && !kursowkaOverlay.course && !courseNavRoute && (
                <ShapeOverlayControl
                  title={kursowkaOverlay.title}
                  progress={Boolean(kursowkaOverlay.liveVehicleId)}
                  progressStatus={routeProgressStatus}
                  dark={theme === "dark"}
                  onClear={() => {
                    busOverlayRequestRef.current = null;
                    setBusOverlay(false);
                    stopCourseNavigation();
                    setKursowkaOverlay(null);
                  }}
                />
              )}
              {stopDisplay !== "off" && (showingSnapshotStops || busError) && (
                <div
                  role="status"
                  data-testid="stop-data-status"
                  className="pointer-events-auto max-w-[300px] rounded-xl border border-line bg-surface/95 px-3 py-2 text-[11px] font-semibold leading-snug text-ink shadow-[0_8px_24px_rgba(13,42,28,0.14)] "
                >
                  {busError || (busLoading
                    ? "Pokazuję zapisaną migawkę przystanków. Wczytuję aktualny rozkład…"
                    : "Przystanki pochodzą z zapisanej migawki i mogą być nieaktualne.")}
                  {busError && showingSnapshotStops && " Przystanki z migawki mogą być nieaktualne."}
                  {busError && (
                    <button
                      type="button"
                      onClick={() => void loadBusStops(WALBRZYCH_BOUNDS, "Wałbrzych i okolice")}
                      className="ml-1.5 font-extrabold text-brand-ink underline underline-offset-2"
                    >
                      Ponów
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="pointer-events-none absolute right-2.5 top-2.5">
              <MapControls
                mapStyle={mapStyle}
                onMapStyle={setMapStyle}
                onZoomIn={() => mapRef.current?.zoomIn()}
                onZoomOut={() => mapRef.current?.zoomOut()}
                onFit={() =>
                  lineEditorOpen && lineEditorMapState
                    ? mapRef.current?.fitLineEditor()
                    : kursowkaOverlay
                      ? mapRef.current?.fitOverlay()
                      : mapRef.current?.fitRoute()
                }
                showFit={Boolean(
                  routeReady || kursowkaOverlay || (lineEditorOpen && lineEditorMapState),
                )}
                onLocate={centerOnMe}
                locateState={
                  locationStatus === "denied" || locationStatus === "unavailable"
                    ? "denied"
                    : userLocation
                      ? followUser
                        ? "following"
                        : "active"
                      : locationStatus === "requesting"
                        ? "requesting"
                        : "idle"
                }
              />
            </div>

            {routeReady && (
              <div className="pointer-events-none absolute bottom-3 left-2.5 hidden lg:block">
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
              <div className="pointer-events-none absolute bottom-5 right-2.5 hidden xl:block">
                <QuickComparison
                  metrics={comparisons}
                  activeVehicle={vehicle}
                  onSelectVehicle={handleVehicleChange}
                  onOpenReport={() => setReportOpen(true)}
                />
              </div>
            )}
          </div>

          <MapInfoSidebar
            open={mapSidebarOpen}
            onOpenChange={(nextOpen) => {
              setMapSidebarOpen(nextOpen);
              if (!nextOpen) {
                setKursowkiOpen(false);
                setLinesOpen(false);
                if (sidebarView === "course") {
                  setCourseSidebarOpen(false);
                }
              }
            }}
            onClose={() => {
              setMapSidebarOpen(false);
              setKursowkiOpen(false);
              setLinesOpen(false);
              if (sidebarView === "course") {
                setCourseSidebarOpen(false);
              }
            }}
            view={sidebarView}
            onViewChange={(nextView) => {
              setSidebarView(nextView);
              setLinesOpen(nextView === "lines");
              setKursowkiOpen(nextView === "kursowki");
              if (nextView === "trip") {
                setTripOpen(true);
              }
              if (sidebarView === "course" && nextView !== "course") {
                setCourseSidebarOpen(false);
              }
            }}
            showRail={isRailViewport}
            role={role}
            onRoleChange={handleRoleChange}
            isPlanner={isPlanner}
            theme={theme}
            onToggleTheme={toggleTheme}
            kursowkiOpen={kursowkiOpen}
            linesOpen={linesOpen}
            onOpenKursowki={() => {
              setLinesOpen(false);
              setKursowkaDeepLink({});
              setKursowkaReturnDateId(null);
              setKursowkiOpen(true);
              setSidebarView("kursowki");
              setMapSidebarOpen(true);
            }}
            onOpenLines={() => {
              setKursowkiOpen(false);
              setLinesOpen(true);
              setSidebarView("lines");
              setMapSidebarOpen(true);
            }}
            onOpenPlanner={() => {
              setKursowkiOpen(false);
              setLinesOpen(false);
              if (window.innerWidth < 1024) setMobileExpanded(true);
            }}
            onOpenSteps={() => setStepsOpen(true)}
            onOpenFleet={() => setFleetOpen(true)}
            onOpenReport={() => setReportOpen(true)}
            onOpenSettings={openInformation}
            onOpenPdf={openPdf}
            pdfDisabled={!exportReady}
            isRouting={isRouting}
            busStops={busStops}
            onSelectBus={handleSelectBus}
            onSelectStop={selectStopFromFinder}
            showLiveBuses={showLiveBuses}
            onToggleLiveBuses={() => toggleVisibility("liveBuses")}
            operatorFilter={operatorFilter}
            onOperatorFilter={setOperatorFilter}
            onRefreshLive={() => void fetchLiveBuses(true)}
            mapStopCount={mapStops.length}
            busLoading={busLoading}
            onRefreshBusStops={refreshBusStops}
            visibility={{ ...visibility, stops: stopDisplay }}
            onVisibilityChange={(patch) => {
              if (patch.stops === "route" && activeRoute.coords.length < 2) {
                showToast("Wyznacz trasę, aby pokazać przystanki przy niej.");
                return;
              }
              updateVisibility(patch);
            }}
            signalCount={trafficSignals.length}
            turnaroundCount={turnaroundSpots.length}
            mapStyle={mapStyle}
            onMapStyle={setMapStyle}
            onHome={centerWalbrzych}
            onFit={() =>
              lineEditorOpen && lineEditorMapState
                ? mapRef.current?.fitLineEditor()
                : kursowkaOverlay
                  ? mapRef.current?.fitOverlay()
                  : mapRef.current?.fitRoute()
            }
            locationStatus={locationStatus}
            userLocation={userLocation}
            followingUser={followUser}
            onLocate={centerOnMe}
            onRetryLocation={startLocation}
            tripOpen={tripOpen}
            hasTripOrigin={Boolean(tripOrigin)}
            hasTripDest={Boolean(tripDest)}
            onOpenTripPlanner={() => {
              setTripOpen(true);
              setTripPick(null);
              setSidebarView("trip");
              setMapSidebarOpen(true);
            }}
            route={isPlanner ? activeRoute : undefined}
            waypoints={isPlanner ? waypoints : undefined}
            metrics={isPlanner ? metrics : undefined}
            vehicle={isPlanner ? vehicle : undefined}
            brigade={isPlanner ? brigade : undefined}
            routeReady={routeReady}
            tripContent={
              !isPlanner ? (
                <Suspense fallback={null}>
                  <TripPlannerPanel
                    embedded
                    buses={sidebarView === "trip" ? liveVehicles : EMPTY_LIVE_VEHICLES}
                    origin={tripOrigin}
                    destination={tripDest}
                    onOriginChange={updateTripOrigin}
                    onDestinationChange={updateTripDest}
                    onSwap={handleSwapTripPoints}
                    onClearAll={handleClearTripPoints}
                    savedPlaces={savedPlaces}
                    onDeleteSavedPlace={handleDeleteSavedPlace}
                    lastSavedTrip={lastSavedTrip}
                    onRestoreLastTrip={handleRestoreLastTrip}
                    pickTarget={tripPick}
                    onPickTargetChange={setTripPick}
                    onSelectBus={handleSelectBus}
                    onCenter={(lat, lon, zoom = 15) => mapRef.current?.centerOn(lat, lon, zoom)}
                    onPreview={setTripPreview}
                    onRefresh={() => setTripNonce((value) => value + 1)}
                    onClose={() => {
                      setTripOpen(false);
                      setTripPick(null);
                      setSidebarView("home");
                    }}
                    refreshNonce={tripNonce}
                  />
                </Suspense>
              ) : null
            }
            linesContent={
              <Suspense fallback={null}>
                <LinesDialog
                  open={sidebarView === "lines"}
                  embedded
                  isPlanner={isPlanner}
                  onClose={() => {
                    setLinesOpen(false);
                    setSidebarView("home");
                  }}
                  onEditLineRoute={
                    isPlanner
                      ? (lineShort, variantKey) => {
                          openLineRouteEditor(lineShort, variantKey ?? null);
                          setMapSidebarOpen(false);
                        }
                      : undefined
                  }
                  onShowShapeOverlay={(overlay) => {
                    if (overlayEpoch !== overlayEpochRef.current) return;
                    setKursowkaOverlay(overlay);
                    showToast(
                      overlay.unresolvedGaps
                        ? `${overlay.unresolvedGaps} odcinków poprowadzono w linii prostej (brak geometrii dróg). Wyświetlono przebieg: ${overlay.title}.`
                        : `Wyświetlono przebieg: ${overlay.title}.`,
                    );
                  }}
                  onStartLineNavigation={(overlay) => {
                    if (overlayEpoch !== overlayEpochRef.current) return;
                    setKursowkaOverlay(overlay);
                    startCourseNavigation(overlay);
                  }}
                />
              </Suspense>
            }
            kursowkiContent={
              <Suspense fallback={null}>
                <KursowkiDialog
                  open={sidebarView === "kursowki"}
                  embedded
                  initialKursowkaId={kursowkaDeepLink.id}
                  initialKursowkaCode={kursowkaDeepLink.code}
                  initialDateId={kursowkaReturnDateId}
                  onClose={() => {
                    setKursowkiOpen(false);
                    setSidebarView("home");
                  }}
                  onOpenNsNhDiff={
                    isPlanner
                      ? () => {
                          openScheduleDiff("ns-nh");
                        }
                      : undefined
                  }
                  liveVehicles={sidebarView === "kursowki" ? liveVehicles : EMPTY_LIVE_VEHICLES}
                  onSelectBus={handleSelectBus}
                  onShowShapeOverlay={(overlay) => {
                    if (overlayEpoch !== overlayEpochRef.current) return;
                    setKursowkaOverlay(overlay);
                    showToast(
                      overlay.unresolvedGaps
                        ? `${overlay.unresolvedGaps} odcinków poprowadzono w linii prostej (brak geometrii dróg). Wyświetlono przebieg: ${overlay.title}.`
                        : `Wyświetlono przebieg: ${overlay.title}.`,
                    );
                  }}
                  onPreviewCourse={handlePreviewCourse}
                  onLoadTripToPlanner={(payload) => {
                    handleLoadTripToPlanner(payload);
                    setMapSidebarOpen(false);
                  }}
                  canLoadToPlanner={isPlanner}
                  isPlanner={isPlanner}
                />
              </Suspense>
            }
            stopContent={
              selectedStop ? (
                <BusStopCard
                  embedded
                  stop={selectedStop}
                  isPlanner={isPlanner}
                  alreadyInRoute={selectedStopInRoute}
                  canAdd={waypoints.length < MAX_WAYPOINTS}
                  onClose={() => {
                    setSelectedStop(null);
                    setSidebarView("home");
                    if (!isRailViewport) setMapSidebarOpen(false);
                  }}
                  onAddVia={() => addBusStop(selectedStop, "via")}
                  onSetStart={() => addBusStop(selectedStop, "start")}
                  onSetEnd={() => addBusStop(selectedStop, "end")}
                  onSetTripStart={() => setTravelerStopEndpoint(selectedStop, "origin")}
                  onSetTripEnd={() => setTravelerStopEndpoint(selectedStop, "destination")}
                  onCenter={() =>
                    mapRef.current?.centerOn(selectedStop.lat, selectedStop.lon, 16)
                  }
                  onOpenKursowka={handleOpenKursowkaFromItem}
                  onPreviewCourse={handlePreviewCourse}
                />
              ) : null
            }
            busContent={
              isRailViewport && selectedLiveBus ? (
                <LiveBusCard
                  embedded
                  isPlanner={isPlanner}
                  bus={selectedLiveBus}
                  onClose={closeLiveBus}
                  onOpenKursowka={(code) => handleOpenKursowkaFromItem("", code)}
                  onSetOperator={handleSetOperator}
                  onCenter={() =>
                    mapRef.current?.centerOn(selectedLiveBus.lat, selectedLiveBus.lon, 16)
                  }
                />
              ) : null
            }
            courseContent={
              isRailViewport && kursowkaOverlay?.course && !busOverlay ? (
                <Suspense fallback={null}>
                  <CoursePreviewCard
                    key={`${kursowkaOverlay.course.tripId}|${kursowkaOverlay.course.dateId}`}
                    embedded
                    course={kursowkaOverlay.course}
                    onClose={() => {
                      setCourseDrawerOpen(false);
                      setCourseSidebarOpen(false);
                      stopCourseNavigation();
                      setKursowkaOverlay(null);
                      setSidebarView("home");
                    }}
                    onFit={() => mapRef.current?.fitOverlay()}
                    onBack={() => {
                      setKursowkaDeepLink({ code: kursowkaOverlay.course?.dutyCode || null });
                      setKursowkaReturnDateId(kursowkaOverlay.course?.dateId ?? null);
                      setKursowkiOpen(true);
                      setSidebarView("kursowki");
                    }}
                    onStartNavigation={() => {
                      if (kursowkaOverlay?.course) {
                        startCourseNavigation(kursowkaOverlay.course);
                      }
                    }}
                    targetStopIndex={courseTargetStop}
                    focusStopIndex={courseTargetStop}
                    focusNonce={courseFocusNonce}
                    onSelectRouteTarget={toggleCourseTarget}
                    onSelectStop={(lat, lon) => mapRef.current?.centerOn(lat, lon, 16)}
                  />
                </Suspense>
              ) : null
            }
          />

          {/* Na telefonie (<768px) podgląd kursu startuje zwinięty z uchwytem po prawej, aby od razu odsłonić całą trasę */}
          {!isRailViewport && kursowkaOverlay?.course && !busOverlay && (
            <Suspense fallback={null}>
              <CoursePreviewCard
                key={`${kursowkaOverlay.course.tripId}|${kursowkaOverlay.course.dateId}`}
                course={kursowkaOverlay.course}
                onClose={() => {
                  setCourseDrawerOpen(false);
                  setCourseSidebarOpen(false);
                  stopCourseNavigation();
                  setKursowkaOverlay(null);
                }}
                onFit={() => mapRef.current?.fitOverlay()}
                onBack={() => {
                  setKursowkaDeepLink({ code: kursowkaOverlay.course?.dutyCode || null });
                  setKursowkaReturnDateId(kursowkaOverlay.course?.dateId ?? null);
                  setKursowkiOpen(true);
                  setSidebarView("kursowki");
                  setMapSidebarOpen(true);
                }}
                onStartNavigation={() => {
                  if (kursowkaOverlay?.course) {
                    startCourseNavigation(kursowkaOverlay.course);
                  }
                }}
                targetStopIndex={courseTargetStop}
                focusStopIndex={courseTargetStop}
                focusNonce={courseFocusNonce}
                onSelectRouteTarget={toggleCourseTarget}
                onSelectStop={(lat, lon) => mapRef.current?.centerOn(lat, lon, 16)}
                onDrawerOpenChange={(open) => {
                  setCourseDrawerOpen(open);
                  setCourseSidebarOpen(open);
                  if (open) setMapSidebarOpen(false);
                }}
              />
            </Suspense>
          )}

          {contextMenu && (
            <div className="pointer-events-none absolute inset-0 z-[1200]">
              <MapContextMenu
                ref={contextMenuRef}
                lat={contextMenu.lat}
                lon={contextMenu.lon}
                left={contextMenu.left}
                top={contextMenu.top}
                isPlanner={isPlanner}
                stopName={contextMenu.stop ? stopDisplayName(contextMenu.stop) : null}
                addressLabel={contextMenu.addressLabel}
                hasOrigin={Boolean(tripOrigin)}
                hasDestination={Boolean(tripDest)}
                onSetStart={() => setContextCoordinate("start")}
                onSetEnd={() => setContextCoordinate("end")}
                onSavePlace={!isPlanner ? () => void handleSaveContextPlace(contextMenu) : undefined}
                onSwap={!isPlanner ? handleSwapTripPoints : undefined}
                onClear={!isPlanner ? handleClearTripPoints : undefined}
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
              <Suspense fallback={null}>
                {lineEditorOpen ? (
                  <LineRouteEditorPanel
                    initialLineShort={lineEditorTarget.lineShort}
                    initialVariantKey={lineEditorTarget.variantKey}
                    onClose={() => {
                      setLineEditorOpen(false);
                      setLineEditorMapState(null);
                    }}
                    onMapStateChange={setLineEditorMapState}
                    handlersRef={lineEditorHandlersRef}
                    onToast={showToast}
                  />
                ) : (
                  <PlanningPanel {...panelProps} />
                )}
              </Suspense>
            </MobilePlannerSheet>
          )}

          {isRouting && (
            <div className="pointer-events-none absolute left-0 top-0 z-[800] h-[3px] w-full overflow-hidden bg-brand/15">
              <div className="route-progress h-full w-1/3 rounded-full bg-highlight" />
            </div>
          )}
        </main>
      </div>

      {anyDialogOpen && (
        <Suspense fallback={null}>
          <WorkspaceDialogs
            isPlanner={isPlanner}
            plannerLoginOpen={plannerLoginOpen}
            onClosePlannerLogin={() => setPlannerLoginOpen(false)}
            onSuccessPlannerLogin={() => {
              setPlannerLoginOpen(false);
              handleRoleChange("planner");
            }}
            scheduleDiffOpen={scheduleDiffOpen}
            scheduleDiffPreset={scheduleDiffPreset}
            onCloseScheduleDiff={() => setScheduleDiffOpen(false)}
            routeAuditOpen={routeAuditOpen}
            onCloseRouteAudit={() => setRouteAuditOpen(false)}
            onFixInEditor={(lineShort, variantKey) => {
              openLineRouteEditor(lineShort, variantKey);
            }}
            onShowOverlayOnMap={(overlay) => {
              setKursowkaOverlay(overlay);
              showToast(`Wyświetlono na mapie: ${overlay.title}.`);
            }}
            customGtfsBuilderOpen={customGtfsBuilderOpen}
            onCloseCustomGtfsBuilder={() => setCustomGtfsBuilderOpen(false)}
            onStartCustomGtfsMapSession={(session) => {
              setLineEditorOpen(false);
              setCustomGtfsBuilderOpen(false);
              setCustomGtfsMapSession(session);
              setMobileExpanded(false);
              showToast(
                session.kind === "pick-stop"
                  ? `Kliknij na mapie miejsce nowego przystanku dla linii ${session.lineShort}.`
                  : `Klikaj na mapie punkty trasy linii ${session.lineShort} (Po drogach OSRM włączone).`,
              );
            }}
            customGtfsResumeTarget={customGtfsResumeTarget}
            stepsOpen={stepsOpen}
            onCloseSteps={() => setStepsOpen(false)}
            navigationRoute={navigationRoute}
            activeRoute={activeRoute}
            waypoints={waypoints}
            metrics={metrics}
            comparisons={comparisons}
            vehicle={vehicle}
            brigade={brigade}
            fleet={fleet}
            onFocusStep={handleFocusStep}
            onStartNavigation={startNavigation}
            fleetOpen={fleetOpen}
            onCloseFleet={() => setFleetOpen(false)}
            onVehicleChange={handleVehicleChange}
            onFleetChange={handleFleetChange}
            settingsOpen={settingsOpen}
            onCloseSettings={() => setSettingsOpen(false)}
            reportOpen={reportOpen}
            onCloseReport={() => setReportOpen(false)}
            onOpenPdf={openPdf}
            exportReady={exportReady}
            pdfOpen={pdfOpen}
            onClosePdf={() => setPdfOpen(false)}
            showToast={showToast}
          />
        </Suspense>
      )}
      {toastMessage && <Toast message={toastMessage} onClose={closeToast} />}
    </div>
  );
}
