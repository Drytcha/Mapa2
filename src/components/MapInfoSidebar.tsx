import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Bus,
  BusFront,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  FileDown,
  FileSpreadsheet,
  ListOrdered,
  Loader2,
  LocateFixed,
  LocateOff,
  LogOut,
  Maximize2,
  Menu,
  Moon,
  Navigation,
  Route as RouteIcon,
  Ruler,
  Settings2,
  SlidersHorizontal,
  Sun,
  Truck,
  Waypoints,
} from "lucide-react";
import { useSharedClock } from "@/lib/core/runtimeHub";
import {
  formatDistance,
  formatDistanceCompact,
  formatDurationShort,
  readableEngine,
} from "@/lib/geo";
import type {
  AppRole,
  BrigadeInfo,
  BusStop,
  LiveBusVehicle,
  LiveTrafficSummary,
  MapStyle,
  ProfileMetrics,
  RouteData,
  ThemeMode,
  VehicleId,
  WalbrzychOperatorKey,
  Waypoint,
} from "@/lib/types";
import {
  compassLabel,
  type LocationStatus,
  type UserLocation,
} from "@/lib/useUserLocation";
import {
  DEFAULT_VISIBILITY,
  type StopDisplayMode,
  type VisibilitySettings,
} from "@/lib/visibility";
import { cn } from "@/utils/cn";
import BusSearch from "./BusSearch";
import { MapRouteCard } from "./MapOverlays";
import { Logo } from "./UI";

export type SidebarView =
  | "home"
  | "trip"
  | "lines"
  | "kursowki"
  | "stop"
  | "bus"
  | "course"
  | "visibility"
  | "location"
  | "route";

const STALE_AFTER_S = 15;
const WEAK_ACCURACY_M = 100;

const formatUserSpeed = (kmh: number) =>
  (kmh < 10 ? kmh.toFixed(1) : String(Math.round(kmh))).replace(".", ",");

const VIEW_TITLES: Record<Exclude<SidebarView, "home">, string> = {
  trip: "Wyznacz dojazd",
  lines: "Linie autobusowe",
  kursowki: "Kursówki i brygady",
  stop: "Przystanek",
  bus: "Autobus na żywo",
  course: "Przebieg kursu",
  visibility: "Widoczność na mapie",
  location: "Moja lokalizacja GPS",
  route: "Parametry trasy",
};

function SidebarSwitch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-soft/75"
    >
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold text-ink">
          {label}
        </span>
        {hint && (
          <span className="mt-0.5 block text-[11px] leading-snug text-mute">
            {hint}
          </span>
        )}
      </span>
      <span
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-brand" : "bg-line-strong",
        )}
      >
        <span
          className={cn(
            "absolute left-0 top-0.5 h-4 w-4 rounded-full bg-surface shadow-sm transition-transform",
            checked ? "translate-x-[18px]" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}

function SidebarSummaryRow({
  icon,
  title,
  summary,
  badge,
  onClick,
  testId,
  ariaLabel,
}: {
  icon: ReactNode;
  title: string;
  summary: ReactNode;
  badge?: ReactNode;
  onClick: () => void;
  testId?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={ariaLabel}
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-soft/80"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-soft text-brand-ink transition-colors group-hover:bg-brand-soft">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-bold text-ink">
            {title}
          </span>
          {badge}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-mute">
          {summary}
        </span>
      </span>
      <ChevronRight
        className="h-4 w-4 shrink-0 text-mute/70 transition-transform group-hover:translate-x-0.5 group-hover:text-ink"
        strokeWidth={2}
      />
    </button>
  );
}

function RailButton({
  icon,
  label,
  active,
  dotColor,
  onClick,
  testId,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  dotColor?: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        "relative grid h-9 w-9 place-items-center rounded-xl transition-colors",
        active
          ? "bg-brand-soft text-brand-ink"
          : "text-ink-soft hover:bg-soft hover:text-ink",
      )}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute -left-1.5 top-2 h-5 w-1 rounded-r-full bg-brand"
        />
      )}
      {icon}
      {dotColor && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-surface",
            dotColor,
          )}
        />
      )}
    </button>
  );
}

export interface MapInfoSidebarProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  onClose: () => void;
  view?: SidebarView;
  onViewChange?: (view: SidebarView) => void;
  initialView?: SidebarView;
  /** Czy wyświetlać stały wąski pasek ikon po lewej (desktop md+). */
  showRail?: boolean;
  role?: AppRole;
  onRoleChange?: (role: AppRole) => void;
  isPlanner: boolean;
  theme?: ThemeMode;
  onToggleTheme?: () => void;
  // Navigation actions
  kursowkiOpen?: boolean;
  linesOpen?: boolean;
  onOpenKursowki?: () => void;
  onOpenLines?: () => void;
  onOpenPlanner?: () => void;
  onOpenSteps?: () => void;
  onOpenFleet?: () => void;
  onOpenReport?: () => void;
  onOpenSettings?: () => void;
  onOpenPdf?: () => void;
  pdfDisabled?: boolean;
  isRouting?: boolean;
  // Search inside open sidebar
  busStops?: BusStop[];
  onSelectBus?: (bus: LiveBusVehicle) => void;
  onSelectStop?: (stop: BusStop) => void;
  // Live fleet & operator filters (optional — GPS bar lives on the map)
  showLiveBuses?: boolean;
  onToggleLiveBuses?: () => void;
  operatorFilter?: "all" | WalbrzychOperatorKey;
  onOperatorFilter?: (value: "all" | WalbrzychOperatorKey) => void;
  liveVehicles?: LiveBusVehicle[];
  liveTraffic?: LiveTrafficSummary | null;
  liveLoading?: boolean;
  onRefreshLive?: () => void;
  // Stops & visibility
  mapStopCount: number;
  busLoading: boolean;
  onRefreshBusStops: () => void;
  visibility: VisibilitySettings;
  onVisibilityChange: (patch: Partial<VisibilitySettings>) => void;
  signalCount: number;
  turnaroundCount: number;
  // Map style & viewport (mapStyle switcher lives in MapControls)
  mapStyle?: MapStyle;
  onMapStyle?: (style: MapStyle) => void;
  onHome: () => void;
  onFit: () => void;
  // User GPS HUD
  locationStatus: LocationStatus;
  userLocation: UserLocation | null;
  followingUser: boolean;
  onLocate: () => void;
  onRetryLocation: () => void;
  // Trip planner shortcut (traveler)
  tripOpen?: boolean;
  hasTripOrigin?: boolean;
  hasTripDest?: boolean;
  onOpenTripPlanner?: () => void;
  // Planner route card
  route?: RouteData;
  waypoints?: Waypoint[];
  metrics?: ProfileMetrics;
  vehicle?: VehicleId;
  brigade?: BrigadeInfo;
  routeReady?: boolean;
  // Embedded views rendered inside the same left sidebar
  tripContent?: ReactNode;
  linesContent?: ReactNode;
  kursowkiContent?: ReactNode;
  stopContent?: ReactNode;
  busContent?: ReactNode;
  courseContent?: ReactNode;
}

function UserLocationFreshnessWarning({
  userLocation,
  weak,
}: {
  userLocation: UserLocation;
  weak: boolean;
}) {
  const now = useSharedClock(1_000, true);
  const ageS = Math.max(0, Math.round((now - userLocation.timestamp) / 1000));
  const stale = ageS > STALE_AFTER_S;
  if (!stale && !weak) return null;
  return (
    <p className="rounded-xl bg-warning-soft/75 px-3 py-2.5 text-[11px] font-semibold text-warning">
      {stale
        ? `Ostatni odczyt GPS ${ageS} s temu.`
        : "Słaby sygnał GPS — pozycja przybliżona."}
    </p>
  );
}

function MapInfoSidebarInner({
  open,
  onOpenChange,
  onClose,
  view: controlledView,
  onViewChange,
  initialView = "home",
  showRail = false,
  onRoleChange,
  isPlanner,
  theme = "light",
  onToggleTheme,
  kursowkiOpen = false,
  linesOpen = false,
  onOpenKursowki,
  onOpenLines,
  onOpenPlanner,
  onOpenSteps,
  onOpenFleet,
  onOpenReport,
  onOpenSettings,
  onOpenPdf,
  pdfDisabled = true,
  isRouting = false,
  busStops = [],
  onSelectBus,
  onSelectStop,
  liveVehicles,
  mapStopCount,
  busLoading,
  onRefreshBusStops,
  visibility,
  onVisibilityChange,
  signalCount,
  turnaroundCount,
  mapStyle = "light",
  onHome,
  onFit,
  locationStatus,
  userLocation,
  followingUser,
  onLocate,
  onRetryLocation,
  tripOpen = false,
  hasTripOrigin = false,
  hasTripDest = false,
  onOpenTripPlanner,
  route,
  waypoints,
  metrics,
  vehicle,
  brigade,
  routeReady = false,
  tripContent,
  linesContent,
  kursowkiContent,
  stopContent,
  busContent,
  courseContent,
}: MapInfoSidebarProps) {
  const [internalView, setInternalView] = useState<SidebarView>(initialView);
  const view = controlledView ?? internalView;

  const setView = (next: SidebarView) => {
    setInternalView(next);
    onViewChange?.(next);
  };

  const setOpen = (next: boolean) => {
    if (next) {
      onOpenChange?.(true);
    } else {
      onClose();
    }
  };

  const handleRailSelect = (targetView: SidebarView) => {
    if (open && view === targetView) {
      onClose();
      return;
    }
    if (targetView === "trip" && onOpenTripPlanner) {
      onOpenTripPlanner();
    } else if (targetView === "lines" && onOpenLines) {
      onOpenLines();
    } else if (targetView === "kursowki" && onOpenKursowki) {
      onOpenKursowki();
    }
    setView(targetView);
    setOpen(true);
  };

  const asideRef = useRef<HTMLElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (view !== "home") {
        setView("home");
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open, view, onClose]);

  const stopOptions: Array<{
    id: StopDisplayMode;
    icon: typeof Bus;
    label: string;
  }> = [
    { id: "off", icon: EyeOff, label: "Ukryte" },
    { id: "all", icon: Bus, label: "Wszystkie" },
  ];
  if (isPlanner) {
    stopOptions.push({ id: "route", icon: RouteIcon, label: "Przy trasie" });
  }
  const stopsValue: StopDisplayMode =
    !isPlanner && visibility.stops === "route" ? "all" : visibility.stops;

  const weak = Boolean(userLocation && userLocation.accuracy > WEAK_ACCURACY_M);
  const moving = Boolean(
    userLocation && userLocation.speedKmh !== null && userLocation.speedKmh >= 1,
  );

  const stopsSummary =
    stopsValue === "off"
      ? "Przystanki ukryte"
      : stopsValue === "route"
        ? `Przy trasie (${mapStopCount})`
        : `Wszystkie przystanki (${mapStopCount})`;

  const locationSummary: ReactNode = userLocation ? (
    <>
      <span
        data-testid={
          (open || !showRail) && view === "home" ? "user-speed" : undefined
        }
      >
        {userLocation.speedKmh === null
          ? "0,0"
          : formatUserSpeed(userLocation.speedKmh)}
      </span>{" "}
      km/h · ±{Math.round(userLocation.accuracy)} m
      {followingUser ? " · śledzenie" : ""}
    </>
  ) : locationStatus === "requesting" ? (
    "Szukam sygnału GPS…"
  ) : locationStatus === "denied" ? (
    "Dostęp zablokowany w przeglądarce"
  ) : locationStatus === "unavailable" ? (
    "Brak obsługi GPS"
  ) : (
    "Prędkość, kompas i dokładność"
  );

  const routeSummary =
    routeReady && route
      ? `${formatDistance(route.distance)} · ${formatDurationShort(route.duration)}`
      : isRouting
        ? "Przeliczanie trasy…"
        : "Brak wyznaczonej trasy";

  // Dedicated embedded views (stop, bus, course) manage their own rich headers,
  // so we give them a clean slim navigation strip at top ("← Menu" + "Zwiń").
  const isCustomCardView =
    view === "stop" || view === "bus" || view === "course";

  return (
    <div
      data-testid="map-info-sidebar-root"
      className="pointer-events-none absolute inset-0 z-[650] overflow-hidden"
    >
      {/* Stały wąski pasek ikon przy lewej krawędzi (desktop md+) */}
      {showRail && (
        <nav
          ref={railRef}
          aria-label="Pasek nawigacji mapy"
          data-testid="map-icon-rail"
          className="pointer-events-auto absolute inset-y-0 left-0 z-[660] flex w-12 flex-col items-center gap-1.5 border-r border-line/55 bg-surface py-2.5"
        >
          <RailButton
            testId="map-sidebar-toggle"
            label={
              open && view === "home"
                ? "Zwiń panel boczny mapy"
                : "Otwórz panel boczny mapy"
            }
            active={open && view === "home"}
            onClick={() => handleRailSelect("home")}
            icon={<Menu className="h-4.5 w-4.5" strokeWidth={2.1} />}
          />

          <span className="my-0.5 h-px w-6 bg-line/55" aria-hidden="true" />

          {!isPlanner && (
            <RailButton
              testId="rail-trip"
              label="Panel: Wyznacz dojazd (A → B)"
              active={open && view === "trip"}
              dotColor={
                hasTripDest
                  ? "bg-[#e11d48]"
                  : hasTripOrigin
                    ? "bg-[#0891b2]"
                    : undefined
              }
              onClick={() => handleRailSelect("trip")}
              icon={<RouteIcon className="h-4.5 w-4.5" strokeWidth={2} />}
            />
          )}

          <RailButton
            testId="rail-lines"
            label="Panel: Linie autobusowe"
            active={open && view === "lines"}
            onClick={() => handleRailSelect("lines")}
            icon={<Waypoints className="h-4.5 w-4.5" strokeWidth={2} />}
          />

          <RailButton
            testId="rail-kursowki"
            label="Panel: Kursówki i brygady"
            active={open && (view === "kursowki" || view === "course")}
            onClick={() => handleRailSelect("kursowki")}
            icon={<BusFront className="h-4.5 w-4.5" strokeWidth={2} />}
          />

          <RailButton
            testId="rail-visibility"
            label="Panel: Widoczność na mapie"
            active={open && view === "visibility"}
            onClick={() => handleRailSelect("visibility")}
            icon={<SlidersHorizontal className="h-4.5 w-4.5" strokeWidth={2} />}
          />

          <div className="mt-auto flex flex-col items-center gap-1.5">
            {userLocation && (
              <button
                type="button"
                onClick={() => handleRailSelect("location")}
                aria-label="Panel: Moja lokalizacja GPS"
                title={`Moja prędkość GPS: ${userLocation.speedKmh === null ? "0,0" : formatUserSpeed(userLocation.speedKmh)} km/h`}
                className={cn(
                  "flex w-10 flex-col items-center rounded-xl py-1 text-center transition-colors hover:bg-soft",
                  open && view === "location"
                    ? "bg-brand-soft text-brand-ink"
                    : "text-ink-soft",
                )}
              >
                <span
                  data-testid={
                    !(open && (view === "home" || view === "location"))
                      ? "user-speed"
                      : undefined
                  }
                  className="metric text-[10px] font-extrabold leading-tight"
                >
                  {userLocation.speedKmh === null
                    ? "0,0"
                    : formatUserSpeed(userLocation.speedKmh)}
                </span>
                <span className="text-[7.5px] font-semibold uppercase leading-none text-mute">
                  km/h
                </span>
              </button>
            )}
            {onToggleTheme && (
              <RailButton
                testId="rail-theme"
                label={
                  theme === "light"
                    ? "Włącz ciemny motyw"
                    : "Włącz jasny motyw"
                }
                onClick={onToggleTheme}
                icon={
                  theme === "light" ? (
                    <Moon className="h-4 w-4" strokeWidth={2} />
                  ) : (
                    <Sun className="h-4 w-4" strokeWidth={2} />
                  )
                }
              />
            )}
            <RailButton
              testId="rail-home"
              label="Wróć do widoku Wałbrzycha"
              onClick={onHome}
              icon={<Crosshair className="h-4 w-4" strokeWidth={2} />}
            />
          </div>
        </nav>
      )}

      {/* Tło zamykające szufladę wyłącznie na telefonie (<md) */}
      {open && !showRail && (
        <button
          type="button"
          aria-label="Zwiń panel boczny i pokaż mapę"
          onClick={onClose}
          className="pointer-events-auto absolute inset-y-0 right-0 w-[calc(100%-min(344px,92vw))] bg-black/15 transition-opacity md:hidden"
        />
      )}

      {/* Główny rozwijany panel boczny */}
      <aside
        ref={asideRef}
        id="map-info-sidebar"
        aria-label="Panel boczny mapy"
        data-testid="map-info-sidebar"
        data-open={open ? "true" : "false"}
        data-view={view}
        inert={!open}
        className={cn(
          "pointer-events-auto absolute inset-y-0 flex h-full w-[min(344px,92vw)] flex-col overflow-hidden border-r border-line/55 bg-surface shadow-[8px_0_30px_rgba(15,23,42,0.10)] transition-transform duration-200 ease-out sm:w-[360px]",
          showRail ? "left-12" : "left-0",
          open
            ? "translate-x-0"
            : "pointer-events-none -translate-x-[calc(100%+56px)]",
        )}
      >
        {/* Górny pasek sidebara */}
        {view === "home" ? (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line/45 px-4 py-3">
            <Logo showName={isPlanner} />
            <div className="flex items-center gap-1">
              {!showRail && onToggleTheme && (
                <button
                  type="button"
                  onClick={onToggleTheme}
                  aria-label={
                    theme === "light"
                      ? "Włącz ciemny motyw"
                      : "Włącz jasny motyw"
                  }
                  title={
                    theme === "light"
                      ? "Włącz ciemny motyw"
                      : "Włącz jasny motyw"
                  }
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-ink-soft transition-colors hover:bg-soft hover:text-ink"
                >
                  {theme === "light" ? (
                    <Moon className="h-4 w-4" strokeWidth={2} />
                  ) : (
                    <Sun className="h-4 w-4" strokeWidth={2} />
                  )}
                </button>
              )}
              <button
                type="button"
                data-testid="map-sidebar-close"
                onClick={onClose}
                aria-label="Zwiń panel boczny mapy"
                title="Zwiń panel boczny"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-ink-soft transition-colors hover:bg-soft hover:text-ink"
              >
                <ChevronLeft className="h-4.5 w-4.5" strokeWidth={2.2} />
              </button>
            </div>
          </div>
        ) : isCustomCardView ? (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line/45 px-3 py-2">
            <button
              type="button"
              data-testid="map-sidebar-back"
              onClick={() => setView("home")}
              aria-label="Wróć do głównego panelu"
              className="flex h-8 shrink-0 items-center gap-1 rounded-xl px-2.5 text-[12px] font-bold text-brand-ink transition-colors hover:bg-soft"
            >
              <ArrowLeft className="h-4 w-4" strokeWidth={2.2} />
              Menu
            </button>
            <span className="truncate text-[12px] font-semibold text-mute">
              {VIEW_TITLES[view]}
            </span>
            <button
              type="button"
              data-testid="map-sidebar-close"
              onClick={onClose}
              aria-label="Zwiń panel boczny mapy"
              title="Zwiń panel boczny"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-ink-soft transition-colors hover:bg-soft hover:text-ink"
            >
              <ChevronLeft className="h-4.5 w-4.5" strokeWidth={2.2} />
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line/45 px-3 py-2.5">
            <button
              type="button"
              data-testid="map-sidebar-back"
              onClick={() => setView("home")}
              aria-label="Wróć do głównego panelu"
              className="flex h-8 shrink-0 items-center gap-1 rounded-xl px-2.5 text-[12px] font-bold text-brand-ink transition-colors hover:bg-soft"
            >
              <ArrowLeft className="h-4 w-4" strokeWidth={2.2} />
              Wróć
            </button>
            <h2 className="min-w-0 flex-1 truncate text-center text-[13.5px] font-bold text-ink">
              {VIEW_TITLES[view]}
            </h2>
            <button
              type="button"
              data-testid="map-sidebar-close"
              onClick={onClose}
              aria-label="Zwiń panel boczny mapy"
              title="Zwiń panel boczny"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-ink-soft transition-colors hover:bg-soft hover:text-ink"
            >
              <ChevronLeft className="h-4.5 w-4.5" strokeWidth={2.2} />
            </button>
          </div>
        )}

        {/* ================================================================ */}
        {/*  VIEW: HOME — gładki, czytelny przegląd z podwidokami            */}
        {/* ================================================================ */}
        {view === "home" && (
          <>
            {open && onSelectBus && onSelectStop && (
              <div className="shrink-0 px-3.5 pb-1 pt-3">
                <BusSearch
                  vehicles={liveVehicles}
                  stops={busStops}
                  onSelectVehicle={onSelectBus}
                  onSelectStop={onSelectStop}
                  compact
                  showDutyStatus={isPlanner}
                  isPlanner={isPlanner}
                />
              </div>
            )}

            <div className="scroll-area flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 py-3">
              {!isPlanner ? (
                <section className="flex flex-col gap-0.5">
                  <span className="px-2.5 pb-1 text-[11px] font-semibold text-mute">
                    Podróż i rozkłady
                  </span>

                  {onOpenTripPlanner && (
                    <SidebarSummaryRow
                      testId="sidebar-open-trip-planner"
                      icon={<RouteIcon className="h-4.5 w-4.5" strokeWidth={2} />}
                      title="Wyznacz dojazd (A → B)"
                      summary={
                        tripOpen
                          ? "Aktywne wyszukiwanie trasy"
                          : hasTripOrigin || hasTripDest
                            ? "Wybrano punkty trasy — kontynuuj"
                            : "Połączenia z przesiadkami i dojściem pieszym"
                      }
                      badge={
                        (hasTripOrigin || hasTripDest) && (
                          <span
                            className="inline-flex items-center gap-0.5"
                            aria-hidden="true"
                          >
                            {hasTripOrigin && (
                              <span className="h-2 w-2 rounded-full bg-[#0891b2]" />
                            )}
                            {hasTripDest && (
                              <span className="h-2 w-2 rounded-full bg-[#e11d48]" />
                            )}
                          </span>
                        )
                      }
                      onClick={() => {
                        onOpenTripPlanner();
                        setView("trip");
                      }}
                    />
                  )}

                  {onOpenLines && (
                    <SidebarSummaryRow
                      ariaLabel="Linie"
                      icon={<Waypoints className="h-4.5 w-4.5" strokeWidth={2} />}
                      title="Linie"
                      summary="Przebiegi tras i warianty wszystkich linii"
                      onClick={() => {
                        onOpenLines();
                        setView("lines");
                      }}
                    />
                  )}

                  {onOpenKursowki && (
                    <SidebarSummaryRow
                      ariaLabel="Kursówki"
                      icon={<BusFront className="h-4.5 w-4.5" strokeWidth={2} />}
                      title="Kursówki"
                      summary="Brygady i pełne kursy dzienne GTFS"
                      onClick={() => {
                        onOpenKursowki();
                        setView("kursowki");
                      }}
                    />
                  )}
                </section>
              ) : (
                <section className="flex flex-col gap-2 px-1">
                  <div className="flex items-center justify-between px-1.5">
                    <span className="text-[11px] font-semibold text-mute">
                      Moduły planisty
                    </span>
                    {route && (
                      <span className="text-[10.5px] font-medium text-mute">
                        {readableEngine(route.engine)}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      {
                        id: "planner",
                        label: "Planer",
                        icon: RouteIcon,
                        active: !kursowkiOpen && !linesOpen,
                        onClick: () => {
                          onClose();
                          onOpenPlanner?.();
                        },
                      },
                      {
                        id: "kursowki",
                        label: "Kursówki",
                        icon: BusFront,
                        active: kursowkiOpen,
                        onClick: () => {
                          onOpenKursowki?.();
                          setView("kursowki");
                        },
                      },
                      {
                        id: "lines",
                        label: "Linie",
                        icon: Waypoints,
                        active: linesOpen,
                        onClick: () => {
                          onOpenLines?.();
                          setView("lines");
                        },
                      },
                      {
                        id: "nav",
                        label: "Nawigacja",
                        icon: ListOrdered,
                        active: false,
                        onClick: () => {
                          onClose();
                          onOpenSteps?.();
                        },
                      },
                      {
                        id: "fleet",
                        label: "Flota",
                        icon: Truck,
                        active: false,
                        onClick: () => {
                          onClose();
                          onOpenFleet?.();
                        },
                      },
                      {
                        id: "report",
                        label: "Raporty",
                        icon: FileSpreadsheet,
                        active: false,
                        onClick: () => {
                          onClose();
                          onOpenReport?.();
                        },
                      },
                    ].map((item) => {
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          aria-label={item.label}
                          onClick={item.onClick}
                          className={cn(
                            "flex h-10 items-center gap-2 rounded-xl px-3 text-[12px] font-bold transition-colors",
                            item.active
                              ? "bg-brand-soft text-brand-ink"
                              : "bg-soft/60 text-ink-soft hover:bg-soft hover:text-ink",
                          )}
                        >
                          <Icon
                            className="h-4 w-4 shrink-0 text-brand-ink"
                            strokeWidth={2}
                          />
                          <span className="truncate">{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {onOpenPdf && (
                      <button
                        type="button"
                        disabled={pdfDisabled}
                        aria-label="Eksport trasy do PDF"
                        onClick={() => {
                          onClose();
                          onOpenPdf();
                        }}
                        className="flex h-9 items-center justify-center gap-1.5 rounded-xl bg-brand px-3 text-[11.5px] font-bold text-on-brand transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <FileDown className="h-4 w-4" />
                        Eksport PDF
                      </button>
                    )}
                    {onOpenSettings && (
                      <button
                        type="button"
                        aria-label="Darmowe źródła i informacje"
                        onClick={() => {
                          onClose();
                          onOpenSettings();
                        }}
                        className="flex h-9 items-center justify-center gap-1.5 rounded-xl bg-soft/70 px-3 text-[11.5px] font-semibold text-ink-soft transition-colors hover:bg-soft hover:text-ink"
                      >
                        <Settings2 className="h-4 w-4 text-brand-ink" />
                        Źródła danych
                      </button>
                    )}
                  </div>
                </section>
              )}

              {/* Ustawienia mapy — gładka lista skrótów do pojedynczych widoków */}
              <section className="flex flex-col gap-0.5">
                <span className="px-2.5 pb-1 text-[11px] font-semibold text-mute">
                  Ustawienia mapy
                </span>

                <SidebarSummaryRow
                  testId="sidebar-nav-visibility"
                  icon={<Eye className="h-4.5 w-4.5" strokeWidth={2} />}
                  title="Widoczność na mapie"
                  summary={stopsSummary}
                  onClick={() => setView("visibility")}
                />

                <SidebarSummaryRow
                  testId="sidebar-nav-location"
                  icon={<LocateFixed className="h-4.5 w-4.5" strokeWidth={2} />}
                  title="Moja lokalizacja GPS"
                  summary={locationSummary}
                  onClick={() => setView("location")}
                />

                {isPlanner && (
                  <SidebarSummaryRow
                    testId="sidebar-nav-route"
                    icon={<Ruler className="h-4.5 w-4.5" strokeWidth={2} />}
                    title="Parametry trasy"
                    summary={routeSummary}
                    onClick={() => setView("route")}
                  />
                )}
              </section>
            </div>

            {!showRail || isPlanner ? (
              <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line/45 px-3.5 py-2.5">
                <button
                  type="button"
                  onClick={onHome}
                  aria-label="Wróć do widoku Wałbrzycha"
                  className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-soft/75 px-3 text-[11.5px] font-semibold text-ink-soft transition-colors hover:bg-soft hover:text-ink"
                >
                  <Crosshair className="h-3.5 w-3.5 shrink-0 text-brand-ink" />
                  Widok Wałbrzycha
                </button>

                {isPlanner && onRoleChange && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onRoleChange("traveler");
                    }}
                    title="Profil Planista — przełącz na widok użytkownika"
                    className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-soft/75 px-3 text-[11.5px] font-semibold text-ink-soft transition-colors hover:bg-soft hover:text-ink"
                  >
                    <LogOut className="h-3.5 w-3.5 text-brand-ink" />
                    Planista · Wyloguj
                  </button>
                )}
              </div>
            ) : null}
          </>
        )}

        {/* ================================================================ */}
        {/*  EMBEDDED APP VIEWS (Dojazd, Linie, Kursówki, Przystanek, Wóz)   */}
        {/* ================================================================ */}
        {view === "trip" && tripContent}
        {view === "lines" && linesContent}
        {view === "kursowki" && kursowkiContent}
        {view === "stop" && stopContent}
        {busContent ? (
          <div
            className={
              view === "bus"
                ? "flex min-h-0 flex-1 flex-col overflow-hidden"
                : "hidden"
            }
          >
            {busContent}
          </div>
        ) : null}
        {view === "course" && courseContent}

        {/* ================================================================ */}
        {/*  FOCUSED SETTING 1: WIDOCZNOŚĆ NA MAPIE                          */}
        {/* ================================================================ */}
        {view === "visibility" && (
          <div
            role="region"
            aria-label="Ustawienia widoczności"
            className="scroll-area flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3.5 py-3.5"
          >
            <div>
              <span className="px-1 text-[11px] font-semibold text-mute">
                Przystanki autobusowe
              </span>
              <div className="mt-2 flex gap-1 rounded-xl bg-soft p-1">
                {stopOptions.map((option) => {
                  const Icon = option.icon;
                  const active = stopsValue === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => onVisibilityChange({ stops: option.id })}
                      className={cn(
                        "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-[12px] font-bold transition-colors",
                        active
                          ? "bg-surface text-brand-ink shadow-xs"
                          : "text-mute hover:text-ink",
                      )}
                    >
                      <Icon className="h-4 w-4" strokeWidth={2} />
                      {option.label}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={onRefreshBusStops}
                disabled={busLoading}
                aria-label="Pobierz przystanki dla bieżącego widoku mapy"
                className="mt-2.5 flex h-9.5 w-full items-center justify-center gap-2 rounded-xl bg-soft/80 px-3 text-[12px] font-semibold text-ink transition-colors hover:bg-soft disabled:opacity-45"
              >
                {busLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-brand-ink" />
                ) : (
                  <Bus className="h-4 w-4 text-brand-ink" />
                )}
                <span>Odśwież przystanki w kadrze ({mapStopCount})</span>
              </button>
            </div>

            <div className="flex flex-col gap-1 border-t border-line/45 pt-3.5">
              <span className="px-1 pb-1 text-[11px] font-semibold text-mute">
                Oznaczenia autobusów GPS
              </span>
              <SidebarSwitch
                label="Pokaż autobusy na mapie"
                checked={visibility.liveBuses}
                onChange={(next) => onVisibilityChange({ liveBuses: next })}
              />
              <SidebarSwitch
                label="Kursówka nad pojazdem"
                hint="Widoczna po przybliżeniu mapy (np. 15/01)"
                checked={visibility.busKursowka}
                onChange={(next) => onVisibilityChange({ busKursowka: next })}
              />
              <SidebarSwitch
                label="Numer taborowy wozu"
                hint="Widoczny na znaczniku pojazdu na mapie (np. #340)"
                checked={visibility.busVehicleNumber}
                onChange={(next) =>
                  onVisibilityChange({ busVehicleNumber: next })
                }
              />
            </div>

            {isPlanner && (
              <div className="flex flex-col gap-1 border-t border-line/45 pt-3.5">
                <span className="px-1 pb-1 text-[11px] font-semibold text-mute">
                  Warstwy planisty
                </span>
                <SidebarSwitch
                  label={`Sygnalizacja świetlna${signalCount > 0 ? ` (${signalCount})` : ""}`}
                  checked={visibility.trafficSignals}
                  onChange={(next) =>
                    onVisibilityChange({ trafficSignals: next })
                  }
                />
                <SidebarSwitch
                  label={`Miejsca na zawrotkę${turnaroundCount > 0 ? ` (${turnaroundCount})` : ""}`}
                  hint="Dla wozów od 12 m"
                  checked={visibility.turnarounds}
                  onChange={(next) => onVisibilityChange({ turnarounds: next })}
                />
              </div>
            )}

            <button
              type="button"
              onClick={() => onVisibilityChange({ ...DEFAULT_VISIBILITY })}
              className="mt-auto rounded-xl bg-soft/75 py-2.5 text-[12px] font-semibold text-ink-soft transition-colors hover:bg-soft hover:text-ink"
            >
              Przywróć domyślne ustawienia
            </button>
          </div>
        )}

        {/* ================================================================ */}
        {/*  FOCUSED SETTING 2: MOJA LOKALIZACJA GPS                         */}
        {/* ================================================================ */}
        {view === "location" && (
          <div
            aria-label="Twoja lokalizacja i prędkość"
            data-testid="user-location-hud"
            className="scroll-area flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3.5 py-3.5"
          >
            <button
              type="button"
              onClick={onLocate}
              aria-label="Wycentruj na mojej lokalizacji w panelu"
              className={cn(
                "flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[12px] font-bold transition-colors",
                followingUser
                  ? "bg-brand text-on-brand"
                  : "bg-soft/85 text-ink hover:bg-soft",
              )}
            >
              <LocateFixed className="h-4 w-4" strokeWidth={2.1} />
              {followingUser
                ? "Śledzenie Twojej pozycji włączone"
                : "Wycentruj i śledź moją pozycję"}
            </button>

            {locationStatus === "requesting" && !userLocation ? (
              <div className="flex items-center gap-2.5 rounded-xl bg-soft/65 p-4 text-[12px] text-ink-soft">
                <Loader2 className="h-4.5 w-4.5 animate-spin text-brand-ink" />
                Szukam sygnału GPS Twojego urządzenia…
              </div>
            ) : locationStatus === "denied" ||
              locationStatus === "unavailable" ? (
              <div className="flex items-start gap-2.5 rounded-xl bg-warning-soft/80 p-4 text-[11.5px] leading-relaxed text-warning">
                <LocateOff className="mt-0.5 h-4.5 w-4.5 shrink-0" />
                <div>
                  {locationStatus === "denied"
                    ? "Dostęp do lokalizacji został zablokowany w przeglądarce."
                    : "Ta przeglądarka nie udostępnia odbiornika GPS."}
                  {locationStatus === "denied" && (
                    <button
                      type="button"
                      onClick={onRetryLocation}
                      className="mt-1.5 block font-bold underline"
                    >
                      Spróbuj ponownie włączyć GPS
                    </button>
                  )}
                </div>
              </div>
            ) : userLocation ? (
              <div className="flex flex-col gap-3">
                <div className="rounded-2xl bg-soft/65 p-4">
                  <span className="block text-[11px] font-semibold text-mute">
                    Aktualna prędkość
                  </span>
                  <p className="mt-1 flex items-baseline gap-1.5 leading-none">
                    <span
                      className="metric text-[34px] font-extrabold text-ink"
                      data-testid="user-speed"
                    >
                      {userLocation.speedKmh === null
                        ? "—"
                        : formatUserSpeed(userLocation.speedKmh)}
                    </span>
                    <span className="text-[13px] font-semibold text-mute">
                      km/h
                    </span>
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl bg-soft/55 p-3.5">
                    <span className="block text-[10.5px] font-semibold text-mute">
                      Kierunek ruchu
                    </span>
                    <span
                      className="metric mt-1 flex items-center gap-1.5 text-[14px] font-bold text-ink"
                      data-testid="user-heading"
                    >
                      {userLocation.heading !== null ? (
                        <>
                          <Navigation
                            className="h-4 w-4 shrink-0 text-brand-ink"
                            style={{
                              transform: `rotate(${userLocation.heading - 45}deg)`,
                            }}
                          />
                          {compassLabel(userLocation.heading)}{" "}
                          {Math.round(userLocation.heading)}°
                        </>
                      ) : (
                        <span className="text-[12px] font-medium text-mute">
                          {moving ? "—" : "stoisz"}
                        </span>
                      )}
                    </span>
                  </div>

                  <div className="rounded-xl bg-soft/55 p-3.5">
                    <span className="block text-[10.5px] font-semibold text-mute">
                      Dokładność GPS
                    </span>
                    <span
                      className={cn(
                        "metric mt-1 block text-[14px] font-bold",
                        weak ? "text-warning" : "text-ink",
                      )}
                      data-testid="user-accuracy"
                    >
                      ±{Math.round(userLocation.accuracy)} m
                    </span>
                  </div>
                </div>

                <dl className="grid grid-cols-2 gap-y-2.5 border-t border-line/45 px-1 pt-3 text-[12px]">
                  <dt className="text-mute">Prędkość maks.</dt>
                  <dd className="metric text-right font-bold text-ink">
                    {formatUserSpeed(userLocation.maxSpeedKmh)} km/h
                  </dd>
                  <dt className="text-mute">Przebyty dystans</dt>
                  <dd className="metric text-right font-bold text-ink">
                    {formatDistanceCompact(userLocation.distanceM)}
                  </dd>
                  {userLocation.altitude !== null && (
                    <>
                      <dt className="text-mute">Wysokość</dt>
                      <dd className="metric text-right font-bold text-ink">
                        {Math.round(userLocation.altitude)} m n.p.m.
                      </dd>
                    </>
                  )}
                </dl>

                <UserLocationFreshnessWarning
                  userLocation={userLocation}
                  weak={weak}
                />
              </div>
            ) : (
              <p className="rounded-xl bg-soft/65 p-4 text-[12px] leading-relaxed text-mute">
                Kliknij przycisk powyżej, aby sprawdzić prędkość, kierunek i
                dokładność GPS urządzenia.
              </p>
            )}
          </div>
        )}

        {/* ================================================================ */}
        {/*  FOCUSED SETTING 5: PARAMETRY TRASY (PLANISTA)                   */}
        {/* ================================================================ */}
        {view === "route" && isPlanner && (
          <div className="scroll-area flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3.5">
            {route && waypoints && metrics && vehicle && (
              <MapRouteCard
                route={route}
                waypoints={waypoints}
                metrics={metrics}
                vehicle={vehicle}
                brigade={brigade}
                mapStyle={mapStyle}
                routeReady={routeReady}
                turnaroundCount={turnaroundCount}
              />
            )}
            <button
              type="button"
              onClick={onFit}
              aria-label="Dopasuj trasę do widoku"
              className="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-soft/80 px-3 text-[12px] font-bold text-ink transition-colors hover:bg-soft"
            >
              <Maximize2 className="h-4 w-4 text-brand-ink" />
              Dopasuj trasę do widoku mapy
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}

const MapInfoSidebar = memo(MapInfoSidebarInner);
export default MapInfoSidebar;
