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
import { Route as RouteIcon } from "lucide-react";
import type {
  KursowkaShapeOverlay,
  LineRouteEditorMapState,
  LiveRouteProgressStatus,
  MapHandle,
} from "./MapView";
import type { LineEditorMapHandlers } from "./LineRouteEditorPanel";
import type { CustomGtfsResumeTarget } from "./CustomGtfsBuilderDialog";
import type { CustomGtfsMapSession } from "./CustomGtfsMapDrawToolbar";
import TopBar from "./TopBar";
import UserLocationHud from "./UserLocationHud";
import StopFinder from "./StopFinder";
import { useUserLocation } from "@/lib/useUserLocation";
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
  ShapeOverlayControl,
} from "./MapOverlays";
import {
  FleetDialog,
  ReportDialog,
  SettingsDialog,
  StepsDrawer,
  Toast,
} from "./Modals";
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
const ScheduleDiffDialog = lazy(() => import("./ScheduleDiffDialog"));
const RouteAuditDialog = lazy(() => import("./RouteAuditDialog"));
const CustomGtfsBuilderDialog = lazy(() => import("./CustomGtfsBuilderDialog"));
const CustomGtfsMapDrawToolbar = lazy(() => import("./CustomGtfsMapDrawToolbar"));
const PdfExportDialog = lazy(() => import("./PdfExportDialog"));
const TripPlannerPanel = lazy(() => import("./TripPlannerPanel"));
const CoursePreviewCard = lazy(() => import("./CoursePreviewCard"));
import {
  journeyToMapGeometry,
  journeyToRepairedMapGeometry,
  type Journey,
  type JourneyPoint as TripPoint,
} from "@/lib/journeyPlanner";
import {
  deleteTravelerPlace,
  fetchLastTravelerTrip,
  fetchSavedTravelerPlaces,
  saveLastTravelerTrip,
  saveTravelerPlace,
  type SavedTravelerPlace,
} from "@/lib/travelerPlaces";
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
  findRefreshedBusStop,
  getSnapshotBusStops,
  mergeRefreshedBusStops,
  stopDisplayName,
  WALBRZYCH_BOUNDS,
  WALBRZYCH_CENTER,
  WALBRZYCH_ZOOM,
  type Bounds,
} from "@/lib/busStops";
import {
  getLatestFleetSnapshot,
  onRuntimeEvent,
  setFleetDemand,
  subscribeSharedClock,
  triggerFleetRefresh,
  type LiveFleetSnapshot,
} from "@/lib/core/runtimeHub";
import { coordKey } from "@/lib/core/spatial";
import PerfHud from "@/components/PerfHud";
import { isPlannerOnlyLine } from "@/lib/core/text";
import { formatWarsawClock, readStorageText, writeStorageJson, writeStorageText } from "@/lib/core/time";
import { setOperatorOverride } from "@/lib/engine/fleetOperators";
import { liveBusTap } from "@/lib/liveBusProgress";
import "@/lib/engine/gtfsRt";
import { ensureGtfsSeeded, getCoursePreview, getVehicleRouteOverlay } from "@/lib/engine/gtfsStore";
import { getOverridesSummary, initLineRouteOverrides } from "@/lib/engine/lineRouteOverrides";
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
const EMPTY_STRING_SET = new Set<string>();
const EMPTY_NEAR_MAP = new Map<string, number>();

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

  // Planer podróży dla pasażera (kolorowy doradca "do jakiego wozu wejść")
  const [tripOpen, setTripOpen] = useState(false);
  const [tripPick, setTripPick] = useState<"origin" | "destination" | null>(null);
  const [tripOrigin, setTripOrigin] = useState<TripPoint | null>(null);
  const [tripDest, setTripDest] = useState<TripPoint | null>(null);
  const [tripPreview, setTripPreview] = useState<Journey | null>(null);
  const [tripNonce, setTripNonce] = useState(0);
  const [savedPlaces, setSavedPlaces] = useState<SavedTravelerPlace[]>([]);
  const [lastSavedTrip, setLastSavedTrip] = useState<{
    origin: TripPoint | null;
    destination: TripPoint | null;
  } | null>(null);
  const hasModifiedTripRef = useRef(false);

  useEffect(() => {
    if (!tripPick) return;
    const cancelPick = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTripPick(null);
    };
    window.addEventListener("keydown", cancelPick);
    return () => window.removeEventListener("keydown", cancelPick);
  }, [tripPick]);

  // Wczytaj zapisane miejsca i ostatnie punkty pasażera z bazy danych
  useEffect(() => {
    let cancelled = false;
    fetchSavedTravelerPlaces()
      .then((places) => {
        if (!cancelled) setSavedPlaces(places);
      })
      .catch(() => undefined);
    fetchLastTravelerTrip()
      .then((last) => {
        if (!cancelled && (last.origin || last.destination)) {
          setLastSavedTrip(last);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Zapisuj wybrane przez użytkownika punkty startu/celu w bazie danych
  useEffect(() => {
    if (!hasModifiedTripRef.current) return;
    if (!tripOrigin && !tripDest) return;
    const snapshot = { origin: tripOrigin, destination: tripDest };
    setLastSavedTrip(snapshot);
    const timer = window.setTimeout(() => {
      void saveLastTravelerTrip(snapshot.origin, snapshot.destination).catch(() => undefined);
    }, 650);
    return () => window.clearTimeout(timer);
  }, [tripOrigin, tripDest]);

  const resolveTripPointAddress = useCallback(
    (kind: "origin" | "destination", lat: number, lon: number) => {
      reverseGeocode(lat, lon)
        .then((place) => {
          if (!place?.short) return;
          const nextLabel = place.short.slice(0, 56);
          const setter = kind === "origin" ? setTripOrigin : setTripDest;
          setter((current) =>
            current &&
            !current.stopId &&
            Math.abs(current.lat - lat) < 0.00001 &&
            Math.abs(current.lon - lon) < 0.00001
              ? { ...current, label: nextLabel }
              : current
          );
        })
        .catch(() => undefined);
    },
    []
  );

  const updateTripOrigin = useCallback((point: TripPoint | null) => {
    hasModifiedTripRef.current = true;
    setTripOrigin(point);
    setTripPreview(null);
  }, []);
  const updateTripDest = useCallback((point: TripPoint | null) => {
    hasModifiedTripRef.current = true;
    setTripDest(point);
    setTripPreview(null);
  }, []);

  /** Geometria planu dla mapy: start, cel, odcinki piesze i autobusowe, przesiadki. */
  // Bus legs with GTFS shape gaps bridged by road geometry (async, per selected journey).
  const [repairedTripLegs, setRepairedTripLegs] = useState<{
    journeyId: string;
    legs: ReturnType<typeof journeyToMapGeometry>["legs"];
  } | null>(null);
  useEffect(() => {
    if (!tripPreview || isPlanner) return;
    const controller = new AbortController();
    const journey = tripPreview;
    journeyToRepairedMapGeometry(journey, controller.signal)
      .then((geometry) => {
        if (!controller.signal.aborted) {
          setRepairedTripLegs({ journeyId: journey.id, legs: geometry.legs });
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [tripPreview, isPlanner]);

  const tripMapPlan = useMemo<TripMapPlan | null>(() => {
    if (isPlanner) return null;
    if (!tripOrigin && !tripDest) return null;
    const geometry = tripPreview ? journeyToMapGeometry(tripPreview) : { legs: [], markers: [] };
    const legs =
      tripPreview && repairedTripLegs?.journeyId === tripPreview.id
        ? repairedTripLegs.legs
        : geometry.legs;
    return {
      origin: tripOrigin,
      destination: tripDest,
      legs,
      markers: geometry.markers,
      key: tripPreview?.id ?? "points",
    };
  }, [isPlanner, tripOrigin, tripDest, tripPreview, repairedTripLegs]);

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
  const [linesOpen, setLinesOpen] = useState(false);
  const [scheduleDiffOpen, setScheduleDiffOpen] = useState(false);
  const [routeAuditOpen, setRouteAuditOpen] = useState(false);
  const [customGtfsBuilderOpen, setCustomGtfsBuilderOpen] = useState(false);
  const [customGtfsMapSession, setCustomGtfsMapSession] =
    useState<CustomGtfsMapSession | null>(null);
  const [customGtfsMapState, setCustomGtfsMapState] =
    useState<LineRouteEditorMapState | null>(null);
  const customGtfsMapHandlersRef = useRef<LineEditorMapHandlers | null>(null);
  const [customGtfsResumeTarget, setCustomGtfsResumeTarget] =
    useState<CustomGtfsResumeTarget | null>(null);
  const [kursowkaDeepLink, setKursowkaDeepLink] = useState<{
    id?: string | null;
    code?: string | null;
  }>({});
  const [kursowkaReturnDateId, setKursowkaReturnDateId] = useState<string | null>(null);
  const [kursowkaOverlay, setKursowkaOverlay] = useState<KursowkaShapeOverlay | null>(null);
  const [courseDrawerOpen, setCourseDrawerOpen] = useState(false);
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

  const fetchLiveBuses = useCallback(async (force = false) => {
    await triggerFleetRefresh(force);
  }, []);

  // Subscribe once to the central deduplicated live-fleet stream (re-renders only when fleet changes)
  useEffect(() => {
    // Każdy tick floty to pełny re-render planisty, a pozycje często się nie
    // zmieniają (te same wozy, ten sam przystanek). Porównujemy więc odcisk
    // danych i pomijamy identyczne aktualizacje — inaczej mapa „drga” co 2,5 s.
    const fleetSignature = (vehicles: LiveBusVehicle[]) =>
      vehicles
        .map(
          (vehicle) =>
            `${vehicle.vehicleId}:${vehicle.lat.toFixed(5)}:${vehicle.lon.toFixed(5)}:` +
            `${vehicle.delaySeconds}:${vehicle.speedKmh?.toFixed(1) ?? ""}:` +
            `${vehicle.routeName}:${vehicle.kursowka ?? ""}:${vehicle.bearing?.toFixed(0) ?? ""}:` +
            `${vehicle.tripId ?? ""}:${vehicle.upcomingStops[0]?.sequence ?? ""}:${vehicle.upcomingStops[0]?.scheduledDeparture ?? ""}`
        )
        .join("|");
    let lastVehicleSignature = "";
    const applySnapshot = (snapshot: LiveFleetSnapshot) => {
      const signature = fleetSignature(snapshot.vehicles);
      setLiveTraffic(snapshot.traffic);
      if (signature === lastVehicleSignature) return;
      lastVehicleSignature = signature;
      setLiveVehicles(snapshot.vehicles);
      setSelectedLiveBus((prev) =>
        prev ? snapshot.vehicles.find((v) => v.vehicleId === prev.vehicleId) ?? prev : null
      );
    };

    const initial = getLatestFleetSnapshot();
    if (initial) {
      applySnapshot(initial);
    }
    const offUpdate = onRuntimeEvent("fleet:updated", ({ snapshot }) => {
      applySnapshot(snapshot);
    });
    const offLoading = onRuntimeEvent("fleet:loading", setLiveLoading);
    return () => {
      offUpdate();
      offLoading();
    };
  }, []);

  // Adaptive single-timer demand: fast (2.5s) when tracking a bus, standard (4s) when visible,
  // eco (20s) when hidden on map & panels closed, and 0Hz when browser tab is hidden.
  const hasSelectedLiveBus = Boolean(selectedLiveBus);
  const liveDemandActive =
    showLiveBuses || tripOpen || kursowkiOpen || Boolean(selectedStop);
  useEffect(() => {
    return setFleetDemand("workspace", {
      active: liveDemandActive,
      fast: hasSelectedLiveBus,
    });
  }, [liveDemandActive, hasSelectedLiveBus]);

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
  // A saved "near route" preference must not blank a fresh map with no route.
  const stopDisplay =
    visibility.stops === "route" && activeRoute.coords.length < 2 ? "all" : visibility.stops;

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
  const visibleLiveBuses = useMemo(() => {
    // Special "S" lines stay planner-only on the live map as well.
    const base = isPlanner
      ? liveVehicles
      : liveVehicles.filter((v) => !isPlannerOnlyLine(v.routeName));
    return operatorFilter === "all"
      ? base
      : base.filter((v) => v.operatorKey === operatorFilter);
  }, [liveVehicles, operatorFilter, isPlanner]);

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
    if (!isPlanner) return;
    return subscribeSharedClock(30_000, setClockNow);
  }, [isPlanner]);

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
    overlayEpochRef.current += 1;
    stopNavigation();
    setAddMode(false);
    setPickTarget(null);
    setContextMenu(null);
    setSelectedStop(null);
    setSelectedLiveBus(null);
    setKursowkiOpen(false);
    setLinesOpen(false);
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
    setSelectedStop((current) => (current?.id === stop.id ? null : stop));
    if (center) mapRef.current?.centerOn(stop.lat, stop.lon, 16);
  }, []);

  const selectStopFromFinder = useCallback((stop: BusStop) => {
    userPannedRef.current = true;
    setFollowUser(false);
    setSelectedLiveBus(null);
    setSelectedStop(stop);
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
    pendingFitRef.current = true;
    setMobileExpanded(false);
    showToast(
      added === 1
        ? "Dodano 1 przystanek przy trasie."
        : `Dodano ${added} przystanków w kolejności przejazdu.`
    );
  }, [busStops, route, routeReady, showToast, stopNavigation]);

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

  const setTravelerStopEndpoint = useCallback(
    (stop: BusStop, target: "origin" | "destination") => {
      const point: TripPoint = {
        lat: stop.lat,
        lon: stop.lon,
        label: stopDisplayName(stop),
        stopId: stop.gtfsId,
        stopIds: stop.gtfsIds,
      };
      setSelectedStop(null);
      setTripPick(null);
      setTripOpen(true);
      if (target === "origin") {
        updateTripOrigin(point);
        showToast(
          tripDest
            ? `Start: ${point.label} — wyznaczam połączenia.`
            : `Start ustawiony na przystanku ${point.label}.`
        );
      } else {
        updateTripDest(point);
        showToast(
          tripOrigin
            ? `Cel: ${point.label} — wyznaczam połączenia.`
            : `Cel ustawiony na przystanku ${point.label}.`
        );
      }
    },
    [showToast, tripDest, tripOrigin, updateTripDest, updateTripOrigin]
  );

  const handleSwapTripPoints = useCallback(() => {
    if (!tripOrigin && !tripDest) return;
    setContextMenu(null);
    setTripPick(null);
    hasModifiedTripRef.current = true;
    const prevOrigin = tripOrigin;
    const prevDest = tripDest;
    setTripOrigin(prevDest);
    setTripDest(prevOrigin);
    setTripPreview(null);
    setTripOpen(true);
    showToast("Zamieniono miejsce startowe z docelowym.");
  }, [showToast, tripDest, tripOrigin]);

  const handleClearTripPoints = useCallback(() => {
    setContextMenu(null);
    setTripPick(null);
    setTripOrigin(null);
    setTripDest(null);
    setTripPreview(null);
    showToast("Wyczyszczono miejsce startowe i docelowe.");
  }, [showToast]);

  const handleSaveContextPlace = useCallback(async () => {
    if (!contextMenu) return;
    const { lat, lon, stop, addressLabel } = contextMenu;
    setContextMenu(null);
    let label = stop
      ? stopDisplayName(stop)
      : addressLabel || `Punkt (${lat.toFixed(5)}, ${lon.toFixed(5)})`;
    if (!stop && !addressLabel) {
      try {
        const resolved = await reverseGeocode(lat, lon);
        if (resolved?.short) label = resolved.short.slice(0, 56);
      } catch {
        /* Fallback to coordinate label */
      }
    }
    try {
      const saved = await saveTravelerPlace({
        lat,
        lon,
        label,
        stopId: stop?.gtfsId,
        stopIds: stop?.gtfsIds,
      });
      if (saved) {
        setSavedPlaces((current) => [
          saved,
          ...current.filter((item) => item.id !== saved.id),
        ]);
        showToast(`Zapisano miejsce: ${saved.label}.`);
      } else {
        showToast("Nie udało się zapisać miejsca.");
      }
    } catch {
      showToast("Nie udało się zapisać miejsca.");
    }
  }, [contextMenu, showToast]);

  const handleDeleteSavedPlace = useCallback(
    async (id: number) => {
      try {
        const removed = await deleteTravelerPlace(id);
        if (removed) {
          setSavedPlaces((current) => current.filter((item) => item.id !== id));
          showToast("Usunięto zapisane miejsce.");
        }
      } catch {
        showToast("Nie udało się usunąć miejsca.");
      }
    },
    [showToast]
  );

  const handleRestoreLastTrip = useCallback(() => {
    if (!lastSavedTrip) return;
    hasModifiedTripRef.current = true;
    setTripOrigin(lastSavedTrip.origin);
    setTripDest(lastSavedTrip.destination);
    setTripPreview(null);
    setTripOpen(true);
    showToast("Przywrócono ostatnie punkty podróży.");
  }, [lastSavedTrip, showToast]);

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
    setKursowkaReturnDateId(null);
    setKursowkiOpen(true);
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

  // Karta pojazdu zamknięta (dowolną drogą) → jej trasa też znika z mapy,
  // żeby nie zostawała „sierota” po wybraniu innego obiektu.
  useEffect(() => {
    if (selectedLiveBus) return;
    busOverlayRequestRef.current = null;
    if (!busOverlay) return;
    setBusOverlay(false);
    setKursowkaOverlay(null);
  }, [selectedLiveBus, busOverlay]);

  const closeLiveBus = useCallback(() => {
    busOverlayRequestRef.current = null;
    setSelectedLiveBus(null);
  }, []);

  const handleSelectBus = useCallback((bus: LiveBusVehicle) => {
    setOperatorFilter("all");
    updateVisibility({ liveBuses: true });
    setSelectedStop(null);
    setSelectedLiveBus(bus);
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
    onOpenLineEditor: () => openLineRouteEditor(null, null),
    editedRoutesCount,
    onOpenScheduleDiff: () => setScheduleDiffOpen(true),
    onOpenRouteAudit: () => setRouteAuditOpen(true),
    onOpenCustomGtfsBuilder: () => setCustomGtfsBuilderOpen(true),
  };

  // Na telefonie ukrywamy dolne guziki („Przystanki” / „Planer podróży”), gdy otwarta
  // jest karta przystanku, autobusu, planer podróży, rozsuwany panel kursu lub rysowanie
  // na mapie — dzięki temu nic nigdy na siebie nie nachodzi.
  const hideMobileBottomActions = Boolean(
    selectedStop ||
      selectedLiveBus ||
      tripOpen ||
      courseDrawerOpen ||
      customGtfsMapSession ||
      addMode ||
      pickTarget ||
      (isPlanner && (mobileExpanded || lineEditorOpen)),
  );
  const lowerBottomActionsZ = Boolean(
    hideMobileBottomActions || (kursowkaOverlay?.course && !busOverlay),
  );

  return (
    <div className="flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-canvas text-ink">
      <PerfHud />
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
        linesOpen={linesOpen}
        onOpenLines={() => {
          setKursowkiOpen(false);
          setLinesOpen(true);
        }}
        onToggleLiveBuses={() => toggleVisibility("liveBuses")}
        onToggleTheme={toggleTheme}
        onOpenPdf={openPdf}
        pdfDisabled={!exportReady}
        onOpenSettings={openInformation}
        onOpenSteps={() => setStepsOpen(true)}
        onOpenFleet={() => setFleetOpen(true)}
        onOpenReport={() => setReportOpen(true)}
        onOpenKursowki={() => {
          setLinesOpen(false);
          setKursowkaDeepLink({});
          setKursowkaReturnDateId(null);
          setKursowkiOpen(true);
        }}
        onOpenPlanner={() => {
          setKursowkiOpen(false);
          setLinesOpen(false);
          if (window.innerWidth < 1024) setMobileExpanded(true);
        }}
      />

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
              kursowkaOverlay={kursowkaOverlay}
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
              followNav={navActive && navPlaying}
              focus={focus}
              userLocation={userLocation}
              followUser={followUser}
              centerUserNonce={centerUserNonce}
              onUserPan={() => {
                userPannedRef.current = true;
                setFollowUser(false);
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
            <div className="pointer-events-none absolute left-3 top-5 flex max-h-[calc(100%-100px)] max-w-[calc(100%-72px)] flex-col items-start gap-2 lg:top-3">
              {isPlanner && customGtfsMapSession ? (
                <Suspense fallback={null}>
                  <CustomGtfsMapDrawToolbar
                    session={customGtfsMapSession}
                    onMapStateChange={setCustomGtfsMapState}
                    handlersRef={customGtfsMapHandlersRef}
                    onApplyRoute={(lineId, variantId, drawnPath) => {
                      void (async () => {
                        const [{ loadCustomGtfsLines, upsertCustomGtfsLine }, { polylineLengthMeters }] =
                          await Promise.all([
                            import("@/lib/engine/customGtfsLines"),
                            import("@/lib/core/spatial"),
                          ]);
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
                <div className="pointer-events-none flex min-h-0 flex-col items-start gap-2">
                  <div className={selectedStop || selectedLiveBus ? "hidden sm:contents" : "contents"}>
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
                      onSelectBus={handleSelectBus}
                    />
                    {!isPlanner && tripOpen && (
                      <Suspense fallback={null}>
                        <TripPlannerPanel
                          buses={liveVehicles}
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
                          }}
                          refreshNonce={tripNonce}
                        />
                      </Suspense>
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
                  </div>
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
                      onSetTripStart={() => setTravelerStopEndpoint(selectedStop, "origin")}
                      onSetTripEnd={() => setTravelerStopEndpoint(selectedStop, "destination")}
                      onCenter={() =>
                        mapRef.current?.centerOn(selectedStop.lat, selectedStop.lon, 16)
                      }
                      onOpenKursowka={handleOpenKursowkaFromItem}
                      onPreviewCourse={!isPlanner ? handlePreviewCourse : undefined}
                    />
                  )}
                  {selectedLiveBus && (
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
              {kursowkaOverlay && (!kursowkaOverlay.course || isPlanner) && (
                <ShapeOverlayControl
                  title={kursowkaOverlay.title}
                  progress={Boolean(kursowkaOverlay.liveVehicleId)}
                  progressStatus={routeProgressStatus}
                  dark={theme === "dark"}
                  onClear={() => {
                    busOverlayRequestRef.current = null;
                    setBusOverlay(false);
                    setKursowkaOverlay(null);
                  }}
                />
              )}
              {stopDisplay === "off" && (
                <div
                  role="status"
                  className="pointer-events-auto max-w-[300px] rounded-xl border border-line bg-surface/95 px-3 py-2 text-[11px] font-semibold text-ink shadow-lg"
                >
                  Przystanki są ukryte. {" "}
                  <button
                    type="button"
                    onClick={() => {
                      updateVisibility({ stops: "all" });
                      setBusQuery("");
                      centerWalbrzych();
                    }}
                    className="font-extrabold text-brand-ink underline underline-offset-2"
                  >
                    Pokaż przystanki
                  </button>
                </div>
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

            <div
              className={`pointer-events-none absolute right-3 sm:bottom-3 lg:bottom-auto lg:right-[52px] lg:top-3 ${
                hideMobileBottomActions
                  ? "bottom-3"
                  : isPlanner
                    ? "bottom-[114px]"
                    : "bottom-[56px]"
              }`}
            >
              <UserLocationHud
                status={locationStatus}
                location={userLocation}
                following={followUser}
                onCenter={centerOnMe}
                onRetry={startLocation}
              />
            </div>

            <div className="pointer-events-none absolute right-3 top-3">
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
                busCount={mapStops.length}
                isPlanner={isPlanner}
                visibility={{ ...visibility, stops: stopDisplay }}
                onVisibilityChange={(patch) => {
                  if (patch.stops === "route" && activeRoute.coords.length < 2) {
                    showToast("Wyznacz trasę, aby pokazać przystanki przy niej.");
                    return;
                  }
                  updateVisibility(patch);
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

            <div className="pointer-events-none absolute bottom-2.5 left-3 hidden select-none items-center gap-2 rounded-full border border-line/70 bg-surface/92 px-2 py-1 sm:flex">
              {isPlanner ? (
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
              ) : (tripOrigin || tripDest) ? (
                <>
                  {tripOrigin && (
                    <span className="flex items-center gap-1 text-[7.5px] font-bold text-mute">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#0891b2]" /> start
                    </span>
                  )}
                  {tripOrigin && tripDest && <span className="h-2 w-px bg-line" />}
                  {tripDest && (
                    <span className="flex items-center gap-1 text-[7.5px] font-bold text-mute">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#e11d48]" /> cel
                    </span>
                  )}
                  <span className="h-2 w-px bg-line" />
                </>
              ) : null}
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
                GPS autobusów ({visibleLiveBuses.length})
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

          <div
            data-testid="map-bottom-actions"
            className={`pointer-events-none absolute left-3 items-end gap-1.5 pb-[env(safe-area-inset-bottom)] sm:bottom-10 sm:flex sm:pb-0 ${
              hideMobileBottomActions ? "hidden" : "flex"
            } ${isPlanner ? "bottom-[68px]" : "bottom-3"} ${
              lowerBottomActionsZ ? "z-[490]" : "z-[540]"
            }`}
          >
            <StopFinder stops={busStops} isPlanner={isPlanner} onSelect={selectStopFromFinder} />
            {!isPlanner && (
              <button
                type="button"
                onClick={() => {
                  setTripOpen((open) => !open);
                  if (tripOpen) setTripPick(null);
                }}
                aria-expanded={tripOpen}
                title="Planer podróży — możesz też kliknąć prawym przyciskiem na mapie, aby ustawić start lub cel"
                className={`pointer-events-auto flex min-h-8 items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[9.5px] font-extrabold shadow-[0_10px_28px_rgba(13,42,28,0.35)] transition-all hover:opacity-90 active:scale-[0.98] sm:min-h-9 sm:px-3 sm:py-2 sm:text-[9px] ${
                  tripOpen
                    ? "border-line-strong bg-surface text-ink"
                    : "border-brand-deep/20 bg-brand text-on-brand"
                }`}
              >
                <RouteIcon className="h-3.5 w-3.5" strokeWidth={2.4} />
                {tripOpen ? "Zamknij planer" : "Planer podróży"}
                {!tripOpen && (tripOrigin || tripDest) && (
                  <span className="ml-0.5 inline-flex items-center gap-0.5" aria-hidden="true">
                    {tripOrigin && (
                      <span className="h-2 w-2 rounded-full border border-white bg-[#0891b2]" />
                    )}
                    {tripDest && (
                      <span className="h-2 w-2 rounded-full border border-white bg-[#e11d48]" />
                    )}
                  </span>
                )}
              </button>
            )}
          </div>

          {!isPlanner && kursowkaOverlay?.course && !busOverlay && (
            <Suspense fallback={null}>
              <CoursePreviewCard
                key={`${kursowkaOverlay.course.tripId}|${kursowkaOverlay.course.dateId}`}
                course={kursowkaOverlay.course}
                onClose={() => {
                  setCourseDrawerOpen(false);
                  setKursowkaOverlay(null);
                }}
                onFit={() => mapRef.current?.fitOverlay()}
                onBack={() => {
                  setKursowkaDeepLink({ code: kursowkaOverlay.course?.dutyCode || null });
                  setKursowkaReturnDateId(kursowkaOverlay.course?.dateId ?? null);
                  setKursowkiOpen(true);
                }}
                onSelectStop={(lat, lon) => mapRef.current?.centerOn(lat, lon, 16)}
                onDrawerOpenChange={setCourseDrawerOpen}
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
                onSavePlace={!isPlanner ? handleSaveContextPlace : undefined}
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

      {kursowkiOpen && (
        <Suspense fallback={null}>
          <KursowkiDialog
            open={kursowkiOpen}
            initialKursowkaId={kursowkaDeepLink.id}
            initialKursowkaCode={kursowkaDeepLink.code}
            initialDateId={kursowkaReturnDateId}
            onClose={() => setKursowkiOpen(false)}
            liveVehicles={liveVehicles}
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
            onPreviewCourse={!isPlanner ? handlePreviewCourse : undefined}
            onLoadTripToPlanner={handleLoadTripToPlanner}
            canLoadToPlanner={isPlanner}
            isPlanner={isPlanner}
          />
        </Suspense>
      )}

      {linesOpen && (
        <Suspense fallback={null}>
          <LinesDialog
            open={linesOpen}
            isPlanner={isPlanner}
            onClose={() => setLinesOpen(false)}
            onEditLineRoute={
              isPlanner
                ? (lineShort, variantKey) => openLineRouteEditor(lineShort, variantKey ?? null)
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
          />
        </Suspense>
      )}

      {isPlanner && scheduleDiffOpen && (
        <Suspense fallback={null}>
          <ScheduleDiffDialog
            open={scheduleDiffOpen}
            onClose={() => setScheduleDiffOpen(false)}
            onToast={showToast}
          />
        </Suspense>
      )}

      {isPlanner && routeAuditOpen && (
        <Suspense fallback={null}>
          <RouteAuditDialog
            open={routeAuditOpen}
            onClose={() => setRouteAuditOpen(false)}
            onFixInEditor={(lineShort, variantKey) => {
              openLineRouteEditor(lineShort, variantKey);
            }}
            onShowOnMap={(overlay) => {
              setKursowkaOverlay(overlay);
              showToast(`Wyświetlono na mapie: ${overlay.title}.`);
            }}
            onToast={showToast}
          />
        </Suspense>
      )}

      {isPlanner && customGtfsBuilderOpen && (
        <Suspense fallback={null}>
          <CustomGtfsBuilderDialog
            open={customGtfsBuilderOpen}
            onClose={() => setCustomGtfsBuilderOpen(false)}
            onShowOnMap={(overlay) => {
              setKursowkaOverlay(overlay);
              showToast(`Wyświetlono na mapie: ${overlay.title}.`);
            }}
            onStartMapSession={(session) => {
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
            resumeTarget={customGtfsResumeTarget}
            onToast={showToast}
          />
        </Suspense>
      )}

      {stepsOpen && (
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
      )}
      {fleetOpen && (
        <FleetDialog
          open={fleetOpen}
          onClose={() => setFleetOpen(false)}
          fleet={fleet}
          activeId={vehicle}
          onSelect={handleVehicleChange}
          onChange={handleFleetChange}
        />
      )}
      {isPlanner && settingsOpen && (
        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          engine={activeRoute.engine === "osrm" ? "OSRM (bez klucza)" : "Schemat demonstracyjny"}
        />
      )}
      {reportOpen && (
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
      )}
      {pdfOpen && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}
      {toastMessage && <Toast message={toastMessage} onClose={closeToast} />}
    </div>
  );
}
