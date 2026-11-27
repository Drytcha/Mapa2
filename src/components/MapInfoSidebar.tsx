import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Bus,
  BusFront,
  Check,
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
  Moon,
  Navigation,
  Palette,
  PanelLeftClose,
  Radio,
  RefreshCw,
  Route as RouteIcon,
  Ruler,
  Satellite,
  Settings2,
  Sun,
  Truck,
  Waypoints,
} from "lucide-react";
import { useSharedClock } from "@/lib/core/runtimeHub";
import { DELAY_STYLES, type DelayTone } from "@/lib/delay";
import { dutyAssignmentStats } from "@/lib/engine/brigadeVerification";
import { formatDistance, formatDistanceCompact, formatDurationShort, readableEngine } from "@/lib/geo";
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
  | "gps"
  | "visibility"
  | "appearance"
  | "location"
  | "route";

const STALE_AFTER_S = 15;
const WEAK_ACCURACY_M = 100;

const formatUserSpeed = (kmh: number) =>
  (kmh < 10 ? kmh.toFixed(1) : String(Math.round(kmh))).replace(".", ",");

const MAP_STYLES: Array<{
  id: MapStyle;
  label: string;
  hint: string;
  icon: typeof Sun;
  swatch: string;
}> = [
  {
    id: "light",
    label: "Mapa jasna",
    hint: "Czytelne ulice, chodniki i przystanki",
    icon: Sun,
    swatch: "linear-gradient(135deg, #f6f1e2 0%, #e6ecd9 55%, #cfe0e6 100%)",
  },
  {
    id: "dark",
    label: "Mapa ciemna",
    hint: "Stonowany podkład OSM nocą",
    icon: Moon,
    swatch: "linear-gradient(135deg, #3a434f 0%, #2a313b 55%, #1e242c 100%)",
  },
  {
    id: "satellite",
    label: "Satelita",
    hint: "Zdjęcia lotnicze Esri World Imagery",
    icon: Satellite,
    swatch: "linear-gradient(135deg, #62705a 0%, #394f3e 50%, #263e44 100%)",
  },
];

const LEGEND_ITEMS: Array<[DelayTone, string]> = [
  ["late-high", "Opóźnienie powyżej 3 min"],
  ["late", "Opóźnienie do 3 min"],
  ["early-small", "Planowo (od −1 min do +1 min)"],
  ["early-big", "Przyspieszenie powyżej 1 min"],
];

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
      className="flex w-full items-center justify-between gap-3 rounded-xl border border-line/75 bg-surface px-3 py-2.5 text-left transition-colors hover:bg-raised"
    >
      <span className="min-w-0">
        <span className="block text-[11px] font-bold text-ink">{label}</span>
        {hint && (
          <span className="mt-0.5 block text-[9px] leading-snug text-mute">
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
      className="group flex w-full items-center gap-2.5 rounded-xl border border-line/75 bg-surface px-2.5 py-2 text-left transition-all hover:border-brand/35 hover:bg-raised/70"
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand-ink transition-colors group-hover:bg-brand group-hover:text-on-brand">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[11px] font-extrabold text-ink">
            {title}
          </span>
          {badge}
        </span>
        <span className="mt-0.5 block truncate text-[9px] font-semibold text-mute">
          {summary}
        </span>
      </span>
      <ChevronRight
        className="h-4 w-4 shrink-0 text-mute transition-transform group-hover:translate-x-0.5 group-hover:text-ink"
        strokeWidth={2}
      />
    </button>
  );
}

export interface MapInfoSidebarProps {
  open: boolean;
  onClose: () => void;
  initialView?: SidebarView;
  role?: AppRole;
  onRoleChange?: (role: AppRole) => void;
  isPlanner: boolean;
  theme?: ThemeMode;
  onToggleTheme?: () => void;
  // Navigation actions (replacing TopBar)
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
  // Live fleet & operator filters
  showLiveBuses: boolean;
  onToggleLiveBuses: () => void;
  operatorFilter: "all" | WalbrzychOperatorKey;
  onOperatorFilter: (value: "all" | WalbrzychOperatorKey) => void;
  liveVehicles: LiveBusVehicle[];
  liveTraffic: LiveTrafficSummary | null;
  liveLoading: boolean;
  onRefreshLive: () => void;
  // Stops & visibility
  mapStopCount: number;
  busLoading: boolean;
  onRefreshBusStops: () => void;
  visibility: VisibilitySettings;
  onVisibilityChange: (patch: Partial<VisibilitySettings>) => void;
  signalCount: number;
  turnaroundCount: number;
  // Map style & viewport
  mapStyle: MapStyle;
  onMapStyle: (style: MapStyle) => void;
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
}

const SUBVIEW_TITLES: Record<Exclude<SidebarView, "home">, string> = {
  gps: "Autobusy GPS na żywo",
  visibility: "Widoczność na mapie",
  appearance: "Styl mapy i motyw",
  location: "Moja lokalizacja GPS",
  route: "Parametry trasy",
};

export default function MapInfoSidebar({
  open,
  onClose,
  initialView = "home",
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
  showLiveBuses,
  onToggleLiveBuses,
  operatorFilter,
  onOperatorFilter,
  liveVehicles,
  liveTraffic,
  liveLoading,
  onRefreshLive,
  mapStopCount,
  busLoading,
  onRefreshBusStops,
  visibility,
  onVisibilityChange,
  signalCount,
  turnaroundCount,
  mapStyle,
  onMapStyle,
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
}: MapInfoSidebarProps) {
  const [view, setView] = useState<SidebarView>(initialView);
  const asideRef = useRef<HTMLElement | null>(null);
  const now = useSharedClock(1_000, Boolean(userLocation && open));

  useEffect(() => {
    if (!open) setView(initialView);
  }, [open, initialView]);

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
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !target.isConnected) return;
      if (asideRef.current?.contains(target)) return;
      if (target.closest('[data-testid="map-sidebar-toggle"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, view, onClose]);

  const counts = liveVehicles.reduce(
    (acc, item) => {
      acc[item.operatorKey] += 1;
      return acc;
    },
    { mzuk: 0, ska: 0, other: 0 } as Record<WalbrzychOperatorKey, number>,
  );

  const dutyStats = isPlanner
    ? dutyAssignmentStats(liveVehicles)
    : { assigned: 0, eligible: 0 };

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

  const ageS = userLocation
    ? Math.max(0, Math.round((now - userLocation.timestamp) / 1000))
    : 0;
  const stale = Boolean(userLocation && ageS > STALE_AFTER_S);
  const weak = Boolean(userLocation && userLocation.accuracy > WEAK_ACCURACY_M);
  const moving = Boolean(
    userLocation && userLocation.speedKmh !== null && userLocation.speedKmh >= 1,
  );

  // Concise 1-line summaries for the home screen
  const operatorSummary =
    operatorFilter === "mzuk"
      ? "tylko MZUK"
      : operatorFilter === "ska"
        ? "tylko ŚKA"
        : operatorFilter === "other"
          ? "tylko inni"
          : "wszyscy przewoźnicy";

  const gpsSummary = showLiveBuses
    ? `Włączone · ${liveVehicles.length} w ruchu · ${operatorSummary}`
    : "Wyłączone na mapie";

  const stopsSummary =
    stopsValue === "off"
      ? "Przystanki ukryte"
      : stopsValue === "route"
        ? `Przy trasie (${mapStopCount})`
        : `Wszystkie przystanki (${mapStopCount})`;

  const activeStyleMeta =
    MAP_STYLES.find((s) => s.id === mapStyle) ?? MAP_STYLES[0];
  const appearanceSummary = `${activeStyleMeta.label} · motyw ${theme === "dark" ? "ciemny" : "jasny"}`;

  const locationSummary: ReactNode = userLocation ? (
    <>
      <span data-testid={view === "home" ? "user-speed" : undefined}>
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

  return (
    <div
      data-testid="map-info-sidebar-root"
      className="pointer-events-none absolute inset-0 z-[650] overflow-hidden"
    >
      {open && (
        <button
          type="button"
          aria-label="Zwiń panel boczny i pokaż mapę"
          onClick={onClose}
          className="pointer-events-auto absolute inset-y-0 right-0 w-[calc(100%-min(320px,88vw))] bg-black/20 transition-opacity md:hidden"
        />
      )}

      <aside
        ref={asideRef}
        id="map-info-sidebar"
        aria-label="Panel boczny mapy"
        data-testid="map-info-sidebar"
        data-open={open ? "true" : "false"}
        data-view={view}
        inert={!open}
        className={cn(
          "pointer-events-auto absolute inset-y-0 left-0 flex h-full w-[min(320px,88vw)] flex-col overflow-hidden border-r border-line bg-surface shadow-[14px_0_40px_rgba(13,42,28,0.22)] transition-transform duration-200 ease-out sm:w-[324px]",
          open
            ? "translate-x-0"
            : "pointer-events-none -translate-x-[calc(100%+24px)]",
        )}
      >
        {/* Top bar of the sidebar: either Brand header ("home") or Back header (sub-view) */}
        {view === "home" ? (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-surface px-3 py-2.5">
            <Logo showName={isPlanner} />
            <button
              type="button"
              data-testid="map-sidebar-close"
              onClick={onClose}
              aria-label="Zwiń panel boczny mapy"
              title="Zwiń panel boczny"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-raised/70 text-ink-soft transition-colors hover:bg-raised hover:text-ink"
            >
              <PanelLeftClose className="h-4 w-4" strokeWidth={2.1} />
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-surface px-2.5 py-2">
            <button
              type="button"
              data-testid="map-sidebar-back"
              onClick={() => setView("home")}
              aria-label="Wróć do głównego panelu"
              className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[10.5px] font-extrabold text-brand-ink transition-colors hover:bg-brand-soft"
            >
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.3} />
              Wróć
            </button>
            <h2 className="min-w-0 flex-1 truncate text-center text-[11.5px] font-extrabold text-ink">
              {SUBVIEW_TITLES[view]}
            </h2>
            <button
              type="button"
              data-testid="map-sidebar-close"
              onClick={onClose}
              aria-label="Zwiń panel boczny mapy"
              title="Zamknij panel boczny"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-soft transition-colors hover:bg-raised hover:text-ink"
            >
              <PanelLeftClose className="h-4 w-4" strokeWidth={2.1} />
            </button>
          </div>
        )}

        {/* ================================================================ */}
        {/*  VIEW 0: HOME — concise overview + navigation to focused views   */}
        {/* ================================================================ */}
        {view === "home" && (
          <>
            {open && onSelectBus && onSelectStop && (
              <div className="shrink-0 border-b border-line/70 bg-raised/30 px-3 py-2">
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

            <div className="scroll-area flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
              {/* Rozkłady / Nawigacja */}
              {!isPlanner ? (
                <section className="flex flex-col gap-1.5">
                  <span className="px-0.5 text-[8.5px] font-extrabold uppercase tracking-[0.14em] text-mute">
                    Podróż i rozkłady
                  </span>

                  {onOpenTripPlanner && (
                    <SidebarSummaryRow
                      testId="sidebar-open-trip-planner"
                      icon={<RouteIcon className="h-4 w-4" strokeWidth={2.2} />}
                      title="Wyznacz dojazd (A → B)"
                      summary={
                        tripOpen
                          ? "Otwarty na mapie"
                          : hasTripOrigin || hasTripDest
                            ? "Wybrano punkty trasy — kontynuuj"
                            : "Wyszukaj połączenie i dojście piesze"
                      }
                      badge={
                        (hasTripOrigin || hasTripDest) && (
                          <span className="inline-flex items-center gap-0.5" aria-hidden="true">
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
                        onClose();
                        onOpenTripPlanner();
                      }}
                    />
                  )}

                  {onOpenKursowki && (
                    <SidebarSummaryRow
                      ariaLabel="Kursówki"
                      icon={<BusFront className="h-4 w-4" strokeWidth={2.1} />}
                      title="Kursówki"
                      summary="Brygady i pełne kursy dzienne GTFS"
                      onClick={() => {
                        onClose();
                        onOpenKursowki();
                      }}
                    />
                  )}

                  {onOpenLines && (
                    <SidebarSummaryRow
                      ariaLabel="Linie"
                      icon={<Waypoints className="h-4 w-4" strokeWidth={2.1} />}
                      title="Linie"
                      summary="Lista linii autobusowych i wariantów tras"
                      onClick={() => {
                        onClose();
                        onOpenLines();
                      }}
                    />
                  )}
                </section>
              ) : (
                <section className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between px-0.5">
                    <span className="text-[8.5px] font-extrabold uppercase tracking-[0.14em] text-mute">
                      Narzędzia planisty
                    </span>
                    {route && (
                      <span className="text-[8px] font-bold text-mute">
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
                        onClick: onOpenPlanner,
                      },
                      {
                        id: "kursowki",
                        label: "Kursówki",
                        icon: BusFront,
                        active: kursowkiOpen,
                        onClick: onOpenKursowki,
                      },
                      {
                        id: "lines",
                        label: "Linie",
                        icon: Waypoints,
                        active: linesOpen,
                        onClick: onOpenLines,
                      },
                      {
                        id: "nav",
                        label: "Nawigacja",
                        icon: ListOrdered,
                        active: false,
                        onClick: onOpenSteps,
                      },
                      {
                        id: "fleet",
                        label: "Flota",
                        icon: Truck,
                        active: false,
                        onClick: onOpenFleet,
                      },
                      {
                        id: "report",
                        label: "Raporty",
                        icon: FileSpreadsheet,
                        active: false,
                        onClick: onOpenReport,
                      },
                    ].map((item) => {
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          aria-label={item.label}
                          onClick={() => {
                            onClose();
                            item.onClick?.();
                          }}
                          className={cn(
                            "flex h-9 items-center gap-2 rounded-xl border px-2.5 text-[10px] font-extrabold transition-colors",
                            item.active
                              ? "border-brand/40 bg-brand-soft text-brand-ink"
                              : "border-line/75 bg-surface text-ink-soft hover:bg-raised hover:text-ink",
                          )}
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0 text-brand-ink" strokeWidth={2.1} />
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
                        className="flex h-8 items-center justify-center gap-1.5 rounded-xl bg-brand px-2.5 text-[9.5px] font-extrabold text-on-brand transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <FileDown className="h-3.5 w-3.5" />
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
                        className="flex h-8 items-center justify-center gap-1.5 rounded-xl border border-line bg-surface px-2.5 text-[9.5px] font-bold text-ink-soft transition-colors hover:bg-raised hover:text-ink"
                      >
                        <Settings2 className="h-3.5 w-3.5 text-brand-ink" />
                        Źródła danych
                      </button>
                    )}
                  </div>
                </section>
              )}

              {/* Ustawienia mapy — skrótowe wiersze otwierające osobny widok */}
              <section className="flex flex-col gap-1.5">
                <span className="px-0.5 text-[8.5px] font-extrabold uppercase tracking-[0.14em] text-mute">
                  Ustawienia i informacje
                </span>

                <SidebarSummaryRow
                  testId="sidebar-nav-gps"
                  icon={
                    <Radio
                      className={cn(
                        "h-4 w-4",
                        showLiveBuses && liveVehicles.length > 0 && "animate-pulse",
                      )}
                      strokeWidth={2.2}
                    />
                  }
                  title="Autobusy GPS na żywo"
                  summary={gpsSummary}
                  badge={
                    showLiveBuses && liveVehicles.length > 0 ? (
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    ) : undefined
                  }
                  onClick={() => setView("gps")}
                />

                <SidebarSummaryRow
                  testId="sidebar-nav-visibility"
                  icon={<Eye className="h-4 w-4" strokeWidth={2.1} />}
                  title="Widoczność na mapie"
                  summary={stopsSummary}
                  onClick={() => setView("visibility")}
                />

                <SidebarSummaryRow
                  testId="sidebar-nav-appearance"
                  icon={<Palette className="h-4 w-4" strokeWidth={2.1} />}
                  title="Styl mapy i motyw"
                  summary={appearanceSummary}
                  onClick={() => setView("appearance")}
                />

                <SidebarSummaryRow
                  testId="sidebar-nav-location"
                  icon={<LocateFixed className="h-4 w-4" strokeWidth={2.1} />}
                  title="Moja lokalizacja GPS"
                  summary={locationSummary}
                  onClick={() => setView("location")}
                />

                {isPlanner && (
                  <SidebarSummaryRow
                    testId="sidebar-nav-route"
                    icon={<Ruler className="h-4 w-4" strokeWidth={2.1} />}
                    title="Parametry trasy"
                    summary={routeSummary}
                    onClick={() => setView("route")}
                  />
                )}
              </section>
            </div>

            {/* Footer */}
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line bg-raised/30 px-3 py-2">
              <button
                type="button"
                onClick={onHome}
                aria-label="Wróć do widoku Wałbrzycha"
                className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[9.5px] font-bold text-ink-soft transition-colors hover:bg-raised hover:text-ink"
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
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[9.5px] font-bold text-ink-soft transition-colors hover:bg-raised hover:text-ink"
                >
                  <LogOut className="h-3.5 w-3.5 text-brand-ink" />
                  Planista · Wyloguj
                </button>
              )}
            </div>
          </>
        )}

        {/* ================================================================ */}
        {/*  VIEW 1: AUTOBUSY GPS NA ŻYWO                                    */}
        {/* ================================================================ */}
        {view === "gps" && (
          <div className="scroll-area flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
            <SidebarSwitch
              label={`Autobusy GPS na mapie (${liveVehicles.length})`}
              hint="Pozycje pojazdów MZUK i ŚKA odświeżane na żywo"
              checked={showLiveBuses}
              onChange={() => onToggleLiveBuses()}
            />

            <button
              type="button"
              onClick={onRefreshLive}
              disabled={liveLoading}
              aria-label="Odśwież pozycje GPS autobusów"
              className="flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface text-[10.5px] font-extrabold text-ink-soft transition-colors hover:bg-raised hover:text-brand-ink disabled:opacity-45"
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", liveLoading && "animate-spin")}
              />
              Odśwież pozycje GPS teraz
            </button>

            <div className="rounded-xl border border-line/75 bg-raised/35 p-3">
              <span className="block text-[9px] font-extrabold uppercase tracking-[0.12em] text-mute">
                Filtr przewoźnika
              </span>
              <div className="mt-2 flex flex-col gap-1.5">
                {(
                  [
                    {
                      id: "all",
                      label: "Wszyscy przewoźnicy",
                      count: liveVehicles.length,
                    },
                    { id: "mzuk", label: "MZUK", count: counts.mzuk },
                    { id: "ska", label: "ŚKA", count: counts.ska },
                    {
                      id: "other",
                      label: "Pozostali operatorzy",
                      count: counts.other,
                    },
                  ] as const
                ).map((item) => {
                  const active = operatorFilter === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => onOperatorFilter(item.id)}
                      className={cn(
                        "flex h-9 items-center justify-between rounded-lg border px-3 text-[10.5px] font-bold transition-colors",
                        active
                          ? "border-brand bg-brand-soft text-brand-ink"
                          : "border-line/75 bg-surface text-ink-soft hover:bg-raised hover:text-ink",
                      )}
                    >
                      <span>{item.label}</span>
                      <span className="metric rounded-full bg-surface px-2 py-0.5 text-[9.5px] font-extrabold text-ink ring-1 ring-line">
                        {item.count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {liveTraffic && liveTraffic.totalVehicles > 0 && (
              <div className="grid grid-cols-3 gap-1.5 text-center">
                <div className="rounded-xl border border-line/75 bg-surface p-2">
                  <span className="metric block text-[14px] font-extrabold text-emerald-600 dark:text-emerald-400">
                    {liveTraffic.onTimeCount}
                  </span>
                  <span className="text-[8.5px] font-bold text-mute">
                    Planowo
                  </span>
                </div>
                <div className="rounded-xl border border-line/75 bg-surface p-2">
                  <span className="metric block text-[14px] font-extrabold text-rose-600 dark:text-rose-400">
                    {liveTraffic.delayedCount}
                  </span>
                  <span className="text-[8.5px] font-bold text-mute">
                    Opóźnione
                  </span>
                </div>
                <div className="rounded-xl border border-line/75 bg-surface p-2">
                  <span className="metric block text-[14px] font-extrabold text-ink">
                    {liveTraffic.trackedOnTripCount}
                  </span>
                  <span className="text-[8.5px] font-bold text-mute">
                    Na kursie
                  </span>
                </div>
              </div>
            )}

            <div className="rounded-xl border border-line/75 bg-raised/35 p-3">
              <span className="block text-[9px] font-extrabold uppercase tracking-[0.12em] text-mute">
                Legenda punktualności GPS
              </span>
              <div className="mt-2 flex flex-col gap-2">
                {LEGEND_ITEMS.map(([tone, text]) => (
                  <div
                    key={tone}
                    className="flex items-center gap-2.5 text-[10px] font-semibold text-ink-soft"
                  >
                    <span
                      className="h-3 w-3 shrink-0 rounded-full ring-1 ring-black/10"
                      style={{ backgroundColor: DELAY_STYLES[tone].bg }}
                    />
                    <span>{text}</span>
                  </div>
                ))}
              </div>
            </div>

            {isPlanner && dutyStats.eligible > 0 && (
              <div
                className="flex items-start gap-2 rounded-xl border border-brand/25 bg-brand-soft/45 p-3 text-[9.5px] leading-snug text-ink-soft"
                data-testid="duty-stats"
              >
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-ink" />
                <span>
                  <strong className="font-extrabold text-ink">
                    Brygady: {dutyStats.assigned}/{dutyStats.eligible} wozów
                  </strong>{" "}
                  dopasowanych po aktywnym kursie do rozkładu brygad.
                </span>
              </div>
            )}
          </div>
        )}

        {/* ================================================================ */}
        {/*  VIEW 2: WIDOCZNOŚĆ NA MAPIE                                     */}
        {/* ================================================================ */}
        {view === "visibility" && (
          <div
            role="region"
            aria-label="Ustawienia widoczności"
            className="scroll-area flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
          >
            <div className="rounded-xl border border-line/75 bg-raised/35 p-3">
              <span className="block text-[9px] font-extrabold uppercase tracking-[0.12em] text-mute">
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
                        "flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-[10px] font-extrabold transition-colors",
                        active
                          ? "bg-surface text-brand-ink shadow-xs"
                          : "text-mute hover:text-ink",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" strokeWidth={2} />
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
                className="mt-2.5 flex h-8.5 w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[10px] font-bold text-ink-soft transition-colors hover:bg-raised hover:text-brand-ink disabled:opacity-45"
              >
                {busLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Bus className="h-3.5 w-3.5 text-brand-ink" />
                )}
                <span>Odśwież przystanki w kadrze ({mapStopCount})</span>
              </button>
            </div>

            <div className="flex flex-col gap-2">
              <span className="px-0.5 text-[9px] font-extrabold uppercase tracking-[0.12em] text-mute">
                Oznaczenia autobusów GPS
              </span>
              <SidebarSwitch
                label="Pokaż autobusy na mapie"
                checked={visibility.liveBuses}
                onChange={(next) => onVisibilityChange({ liveBuses: next })}
              />
              <SidebarSwitch
                label="Kursówka nad pojazdem"
                hint="np. 15/01, 2/08"
                checked={visibility.busKursowka}
                onChange={(next) => onVisibilityChange({ busKursowka: next })}
              />
              <SidebarSwitch
                label="Numer taborowy wozu"
                hint="np. #340, #3"
                checked={visibility.busVehicleNumber}
                onChange={(next) =>
                  onVisibilityChange({ busVehicleNumber: next })
                }
              />
            </div>

            {isPlanner && (
              <div className="flex flex-col gap-2">
                <span className="px-0.5 text-[9px] font-extrabold uppercase tracking-[0.12em] text-mute">
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
                  hint="dla wozów od 12 m"
                  checked={visibility.turnarounds}
                  onChange={(next) => onVisibilityChange({ turnarounds: next })}
                />
              </div>
            )}

            <button
              type="button"
              onClick={() => onVisibilityChange({ ...DEFAULT_VISIBILITY })}
              className="mt-auto rounded-xl border border-line bg-surface py-2 text-[10px] font-bold text-ink-soft transition-colors hover:bg-raised hover:text-ink"
            >
              Przywróć domyślne ustawienia
            </button>
          </div>
        )}

        {/* ================================================================ */}
        {/*  VIEW 3: STYL MAPY I MOTYW                                       */}
        {/* ================================================================ */}
        {view === "appearance" && (
          <div className="scroll-area flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-3">
            <div className="flex flex-col gap-2">
              <span className="px-0.5 text-[9px] font-extrabold uppercase tracking-[0.12em] text-mute">
                Podkład mapy
              </span>
              {MAP_STYLES.map((style) => {
                const Icon = style.icon;
                const active = mapStyle === style.id;
                return (
                  <button
                    key={style.id}
                    type="button"
                    aria-label={style.label}
                    aria-pressed={active}
                    onClick={() => onMapStyle(style.id)}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border p-2.5 text-left transition-colors",
                      active
                        ? "border-brand bg-brand-soft"
                        : "border-line/75 bg-surface hover:bg-raised",
                    )}
                  >
                    <span
                      className="grid h-10 w-12 shrink-0 place-items-center rounded-lg border border-line/70 shadow-xs"
                      style={{ background: style.swatch }}
                    >
                      <Icon
                        className={cn(
                          "h-4 w-4",
                          style.id === "dark" || style.id === "satellite"
                            ? "text-white"
                            : "text-ink",
                        )}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11px] font-extrabold text-ink">
                        {style.label}
                      </span>
                      <span className="mt-0.5 block text-[9px] text-mute">
                        {style.hint}
                      </span>
                    </span>
                    {active && (
                      <Check
                        className="h-4 w-4 shrink-0 text-brand-ink"
                        strokeWidth={2.5}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {onToggleTheme && (
              <div className="flex flex-col gap-2">
                <span className="px-0.5 text-[9px] font-extrabold uppercase tracking-[0.12em] text-mute">
                  Motyw interfejsu
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    aria-pressed={theme === "light"}
                    onClick={() => {
                      if (theme !== "light") onToggleTheme();
                    }}
                    className={cn(
                      "flex h-10 items-center justify-center gap-2 rounded-xl border text-[10.5px] font-extrabold transition-colors",
                      theme === "light"
                        ? "border-brand bg-brand-soft text-brand-ink"
                        : "border-line/75 bg-surface text-ink-soft hover:bg-raised",
                    )}
                  >
                    <Sun className="h-4 w-4" strokeWidth={2.1} />
                    Jasny
                  </button>
                  <button
                    type="button"
                    aria-pressed={theme === "dark"}
                    onClick={() => {
                      if (theme !== "dark") onToggleTheme();
                    }}
                    className={cn(
                      "flex h-10 items-center justify-center gap-2 rounded-xl border text-[10.5px] font-extrabold transition-colors",
                      theme === "dark"
                        ? "border-brand bg-brand-soft text-brand-ink"
                        : "border-line/75 bg-surface text-ink-soft hover:bg-raised",
                    )}
                  >
                    <Moon className="h-4 w-4" strokeWidth={2.1} />
                    Ciemny
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ================================================================ */}
        {/*  VIEW 4: MOJA LOKALIZACJA GPS                                    */}
        {/* ================================================================ */}
        {view === "location" && (
          <div
            aria-label="Twoja lokalizacja i prędkość"
            data-testid="user-location-hud"
            className="scroll-area flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
          >
            <button
              type="button"
              onClick={onLocate}
              aria-label="Wycentruj na mojej lokalizacji w panelu"
              className={cn(
                "flex h-10 w-full items-center justify-center gap-2 rounded-xl text-[10.5px] font-extrabold transition-colors",
                followingUser
                  ? "bg-brand text-on-brand"
                  : "border border-line bg-surface text-ink hover:bg-raised",
              )}
            >
              <LocateFixed className="h-4 w-4" strokeWidth={2.2} />
              {followingUser
                ? "Śledzenie Twojej pozycji włączone"
                : "Wycentruj i śledź moją pozycję"}
            </button>

            {locationStatus === "requesting" && !userLocation ? (
              <div className="flex items-center gap-2.5 rounded-xl border border-line/75 bg-raised/35 p-3.5 text-[10.5px] font-semibold text-ink-soft">
                <Loader2 className="h-4 w-4 animate-spin text-brand-ink" />
                Szukam sygnału GPS Twojego urządzenia…
              </div>
            ) : locationStatus === "denied" ||
              locationStatus === "unavailable" ? (
              <div className="flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning-soft/80 p-3.5 text-[10px] leading-relaxed text-warning">
                <LocateOff className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  {locationStatus === "denied"
                    ? "Dostęp do lokalizacji został zablokowany w przeglądarce."
                    : "Ta przeglądarka nie udostępnia odbiornika GPS."}
                  {locationStatus === "denied" && (
                    <button
                      type="button"
                      onClick={onRetryLocation}
                      className="mt-1.5 block font-extrabold underline"
                    >
                      Spróbuj ponownie włączyć GPS
                    </button>
                  )}
                </div>
              </div>
            ) : userLocation ? (
              <div className="flex flex-col gap-2.5">
                <div className="rounded-xl border border-line/75 bg-raised/35 p-3.5">
                  <span className="block text-[9px] font-extrabold uppercase tracking-[0.12em] text-mute">
                    Aktualna prędkość
                  </span>
                  <p className="mt-1 flex items-baseline gap-1.5 leading-none">
                    <span
                      className="metric text-[30px] font-extrabold text-ink"
                      data-testid="user-speed"
                    >
                      {userLocation.speedKmh === null
                        ? "—"
                        : formatUserSpeed(userLocation.speedKmh)}
                    </span>
                    <span className="text-[11px] font-bold text-mute">
                      km/h
                    </span>
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-line/75 bg-surface p-3">
                    <span className="block text-[8.5px] font-extrabold uppercase tracking-[0.12em] text-mute">
                      Kierunek ruchu
                    </span>
                    <span
                      className="metric mt-1 flex items-center gap-1.5 text-[13px] font-extrabold text-ink"
                      data-testid="user-heading"
                    >
                      {userLocation.heading !== null ? (
                        <>
                          <Navigation
                            className="h-3.5 w-3.5 shrink-0 text-brand-ink"
                            style={{
                              transform: `rotate(${userLocation.heading - 45}deg)`,
                            }}
                          />
                          {compassLabel(userLocation.heading)}{" "}
                          {Math.round(userLocation.heading)}°
                        </>
                      ) : (
                        <span className="text-[11px] font-semibold text-mute">
                          {moving ? "—" : "stoisz"}
                        </span>
                      )}
                    </span>
                  </div>

                  <div className="rounded-xl border border-line/75 bg-surface p-3">
                    <span className="block text-[8.5px] font-extrabold uppercase tracking-[0.12em] text-mute">
                      Dokładność GPS
                    </span>
                    <span
                      className={cn(
                        "metric mt-1 block text-[13px] font-extrabold",
                        weak ? "text-warning" : "text-ink",
                      )}
                      data-testid="user-accuracy"
                    >
                      ±{Math.round(userLocation.accuracy)} m
                    </span>
                  </div>
                </div>

                <div className="rounded-xl border border-line/75 bg-surface p-3">
                  <dl className="grid grid-cols-2 gap-y-2 text-[10px]">
                    <dt className="font-semibold text-mute">Prędkość maks.</dt>
                    <dd className="metric text-right font-extrabold text-ink">
                      {formatUserSpeed(userLocation.maxSpeedKmh)} km/h
                    </dd>
                    <dt className="font-semibold text-mute">Przebyty dystans</dt>
                    <dd className="metric text-right font-extrabold text-ink">
                      {formatDistanceCompact(userLocation.distanceM)}
                    </dd>
                    {userLocation.altitude !== null && (
                      <>
                        <dt className="font-semibold text-mute">Wysokość</dt>
                        <dd className="metric text-right font-extrabold text-ink">
                          {Math.round(userLocation.altitude)} m n.p.m.
                        </dd>
                      </>
                    )}
                  </dl>
                </div>

                {(stale || weak) && (
                  <p className="rounded-xl border border-warning/30 bg-warning-soft/70 px-3 py-2 text-[9.5px] font-semibold text-warning">
                    {stale
                      ? `Ostatni odczyt GPS ${ageS} s temu.`
                      : "Słaby sygnał GPS — pozycja przybliżona."}
                  </p>
                )}
              </div>
            ) : (
              <p className="rounded-xl border border-line/75 bg-raised/35 p-3.5 text-[10px] leading-relaxed text-mute">
                Kliknij przycisk powyżej, aby włączyć odczyt pozycji, prędkości
                i kierunku GPS z urządzenia.
              </p>
            )}
          </div>
        )}

        {/* ================================================================ */}
        {/*  VIEW 5: PARAMETRY TRASY (PLANISTA)                              */}
        {/* ================================================================ */}
        {view === "route" && isPlanner && (
          <div className="scroll-area flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
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
              className="flex h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[10px] font-extrabold text-ink-soft transition-colors hover:bg-raised hover:text-ink"
            >
              <Maximize2 className="h-3.5 w-3.5 text-brand-ink" />
              Dopasuj trasę do widoku mapy
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
