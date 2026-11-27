import { useEffect, useRef } from "react";
import {
  Bus,
  Check,
  Crosshair,
  EyeOff,
  Loader2,
  LocateFixed,
  LocateOff,
  Maximize2,
  Moon,
  Navigation,
  PanelLeftClose,
  Radio,
  RefreshCw,
  Route,
  Satellite,
  Sun,
} from "lucide-react";
import { useSharedClock } from "@/lib/core/runtimeHub";
import { DELAY_STYLES, type DelayTone } from "@/lib/delay";
import { dutyAssignmentStats } from "@/lib/engine/brigadeVerification";
import { formatDistanceCompact } from "@/lib/geo";
import type {
  BrigadeInfo,
  LiveBusVehicle,
  LiveTrafficSummary,
  MapStyle,
  ProfileMetrics,
  RouteData,
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
import { MapRouteCard } from "./MapOverlays";

const STALE_AFTER_S = 15;
const WEAK_ACCURACY_M = 100;

const formatUserSpeed = (kmh: number) =>
  (kmh < 10 ? kmh.toFixed(1) : String(Math.round(kmh))).replace(".", ",");

const MAP_STYLES: Array<{
  id: MapStyle;
  label: string;
  short: string;
  icon: typeof Sun;
  swatch: string;
}> = [
  {
    id: "light",
    label: "Mapa jasna",
    short: "Jasna",
    icon: Sun,
    swatch: "linear-gradient(135deg, #f6f1e2 0%, #e6ecd9 55%, #cfe0e6 100%)",
  },
  {
    id: "dark",
    label: "Mapa ciemna",
    short: "Ciemna",
    icon: Moon,
    swatch: "linear-gradient(135deg, #3a434f 0%, #2a313b 55%, #1e242c 100%)",
  },
  {
    id: "satellite",
    label: "Satelita",
    short: "Satelita",
    icon: Satellite,
    swatch: "linear-gradient(135deg, #62705a 0%, #394f3e 50%, #263e44 100%)",
  },
];

const LEGEND_ITEMS: Array<[DelayTone, string]> = [
  ["late-high", "Opóźnienie > 3 min"],
  ["late", "Opóźnienie do 3 min"],
  ["early-small", "Planowo / do +1 min"],
  ["early-big", "Przyspieszenie > 1 min"],
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
      className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-raised"
    >
      <span className="min-w-0">
        <span className="block text-[10px] font-bold text-ink">{label}</span>
        {hint && (
          <span className="block text-[8px] leading-snug text-mute">{hint}</span>
        )}
      </span>
      <span
        className={cn(
          "relative h-4 w-7 shrink-0 rounded-full transition-colors",
          checked ? "bg-brand" : "bg-line-strong",
        )}
      >
        <span
          className={cn(
            "absolute left-0 top-0.5 h-3 w-3 rounded-full bg-surface shadow-sm transition-transform",
            checked ? "translate-x-[14px]" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}

export interface MapInfoSidebarProps {
  open: boolean;
  onClose: () => void;
  isPlanner: boolean;
  // Live GPS & operators
  showLiveBuses: boolean;
  onToggleLiveBuses: () => void;
  operatorFilter: "all" | WalbrzychOperatorKey;
  onOperatorFilter: (op: "all" | WalbrzychOperatorKey) => void;
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
  // Map navigation & style
  mapStyle: MapStyle;
  onMapStyle: (style: MapStyle) => void;
  onHome: () => void;
  onFit: () => void;
  // User GPS telemetry
  locationStatus: LocationStatus;
  userLocation: UserLocation | null;
  followingUser: boolean;
  onLocate: () => void;
  onRetryLocation: () => void;
  // Traveler trip planner shortcut
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

export default function MapInfoSidebar({
  open,
  onClose,
  isPlanner,
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
  const asideRef = useRef<HTMLElement | null>(null);
  const now = useSharedClock(1_000, open && locationStatus === "active");

  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (asideRef.current?.contains(target)) return;
      if (target.closest('[data-testid="map-sidebar-toggle"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onEscape);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onEscape);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, onClose]);

  const dutyStats = dutyAssignmentStats(liveVehicles);
  const counts = liveTraffic?.operatorBreakdown ?? {
    mzuk: liveVehicles.filter((v) => v.operatorKey === "mzuk").length,
    ska: liveVehicles.filter((v) => v.operatorKey === "ska").length,
    other: liveVehicles.filter((v) => v.operatorKey === "other").length,
  };

  const stopOptions: Array<{
    id: StopDisplayMode;
    icon: typeof Bus;
    label: string;
  }> = [
    { id: "off", icon: EyeOff, label: "Ukryte" },
    { id: "all", icon: Bus, label: "Wszystkie" },
  ];
  if (isPlanner) {
    stopOptions.push({ id: "route", icon: Route, label: "Przy trasie" });
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

  return (
    <div
      data-testid="map-info-sidebar-root"
      className="pointer-events-none absolute inset-0 z-[580] overflow-hidden"
    >
      {open && (
        <button
          type="button"
          aria-label="Zwiń panel boczny i pokaż mapę"
          onClick={onClose}
          className="pointer-events-auto absolute inset-y-0 right-0 w-[calc(100%-min(306px,86vw))] bg-black/15 transition-opacity md:hidden"
        />
      )}

      <aside
        ref={asideRef}
        id="map-info-sidebar"
        aria-label="Panel boczny mapy: informacje, GPS i ustawienia"
        data-testid="map-info-sidebar"
        data-open={open ? "true" : "false"}
        inert={!open}
        className={cn(
          "pointer-events-auto absolute inset-y-0 left-0 flex w-[min(306px,86vw)] flex-col overflow-hidden border-r border-line bg-surface/98 shadow-[12px_0_36px_rgba(13,42,28,0.24)] transition-transform duration-200 ease-out md:bottom-2.5 md:left-2.5 md:top-12 md:w-[300px] md:rounded-2xl md:border md:shadow-[0_18px_46px_rgba(13,42,28,0.24)] dark:bg-surface/96",
          open
            ? "translate-x-0"
            : "pointer-events-none -translate-x-[calc(100%+24px)]",
        )}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line/75 bg-brand-soft/75 px-3 py-2">
          <div className="min-w-0">
            <h2 className="truncate text-[11.5px] font-extrabold tracking-[-0.015em] text-ink">
              Panel mapy i informacje
            </h2>
            <p className="truncate text-[8px] font-bold uppercase tracking-[0.12em] text-brand-ink/80">
              GPS ({liveVehicles.length}) · Przystanki ({mapStopCount})
            </p>
          </div>
          <button
            type="button"
            data-testid="map-sidebar-close"
            onClick={onClose}
            aria-label="Zwiń panel boczny mapy"
            title="Zwiń panel i odsłoń mapę"
            className="flex h-7 shrink-0 items-center gap-1 rounded-lg border border-line bg-surface px-2 text-[9px] font-extrabold text-brand-ink transition-colors hover:bg-raised"
          >
            <PanelLeftClose className="h-3.5 w-3.5" strokeWidth={2.2} />
            Mapa
          </button>
        </div>

        {/* Scrollable body */}
        <div className="scroll-area flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2.5">
          {/* Quick actions */}
          <div className="flex flex-col gap-1.5">
            {!isPlanner && onOpenTripPlanner && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenTripPlanner();
                }}
                className={cn(
                  "flex h-8 w-full items-center justify-center gap-1.5 rounded-xl border px-3 text-[10px] font-extrabold transition-opacity hover:opacity-90",
                  tripOpen
                    ? "border-line-strong bg-raised text-ink"
                    : "border-brand-deep/20 bg-brand text-on-brand",
                )}
              >
                <Route className="h-3.5 w-3.5" strokeWidth={2.3} />
                {tripOpen ? "Planer podróży (otwarty)" : "Planer podróży (A → B)"}
                {(hasTripOrigin || hasTripDest) && (
                  <span className="ml-0.5 inline-flex items-center gap-0.5" aria-hidden="true">
                    {hasTripOrigin && (
                      <span className="h-2 w-2 rounded-full border border-white bg-[#0891b2]" />
                    )}
                    {hasTripDest && (
                      <span className="h-2 w-2 rounded-full border border-white bg-[#e11d48]" />
                    )}
                  </span>
                )}
              </button>
            )}
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={onHome}
                aria-label="Wróć do widoku Wałbrzycha"
                className="flex h-7 items-center justify-center gap-1 rounded-lg border border-line bg-raised/70 px-2 text-[9px] font-bold text-ink-soft transition-colors hover:bg-raised hover:text-ink"
              >
                <Crosshair className="h-3 w-3 shrink-0 text-brand-ink" />
                Wałbrzych
              </button>
              <button
                type="button"
                onClick={onFit}
                aria-label="Dopasuj trasę do widoku"
                className="flex h-7 items-center justify-center gap-1 rounded-lg border border-line bg-raised/70 px-2 text-[9px] font-bold text-ink-soft transition-colors hover:bg-raised hover:text-ink"
              >
                <Maximize2 className="h-3 w-3 shrink-0 text-brand-ink" />
                Dopasuj widok
              </button>
            </div>
          </div>

          {/* Section 1: Autobusy GPS i przewoźnicy */}
          <section className="rounded-xl border border-line/80 bg-raised/35 p-2">
            <div className="flex items-center justify-between gap-1.5">
              <button
                type="button"
                onClick={onToggleLiveBuses}
                className={cn(
                  "flex h-6 items-center gap-1.5 rounded-lg px-2 text-[9px] font-extrabold transition-colors",
                  showLiveBuses
                    ? "bg-brand text-on-brand"
                    : "bg-soft text-mute hover:text-ink",
                )}
              >
                <Radio
                  className={cn(
                    "h-2.5 w-2.5",
                    showLiveBuses && liveVehicles.length > 0 && "animate-pulse",
                  )}
                />
                GPS na żywo ({liveVehicles.length})
              </button>
              <button
                type="button"
                onClick={onRefreshLive}
                disabled={liveLoading}
                title="Odśwież pozycje GPS autobusów"
                aria-label="Odśwież pozycje GPS autobusów"
                className="flex h-6 items-center gap-1 rounded-md border border-line bg-surface px-2 text-[8.5px] font-bold text-ink-soft transition-colors hover:text-brand-ink disabled:opacity-40"
              >
                <RefreshCw
                  className={cn("h-3 w-3", liveLoading && "animate-spin")}
                />
                Odśwież
              </button>
            </div>

            {showLiveBuses && (
              <>
                <div className="mt-2 grid grid-cols-2 gap-1">
                  {(
                    [
                      { id: "all", label: `Wszystkie (${liveVehicles.length})` },
                      { id: "mzuk", label: `MZUK (${counts.mzuk})` },
                      { id: "ska", label: `ŚKA (${counts.ska})` },
                      { id: "other", label: `Inni (${counts.other})` },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onOperatorFilter(item.id)}
                      className={cn(
                        "h-6 rounded-md px-2 text-[8.5px] font-bold transition-colors",
                        operatorFilter === item.id
                          ? "border border-brand/40 bg-brand-soft text-brand-ink"
                          : "border border-line/70 bg-surface text-mute hover:text-ink",
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                <div className="mt-2 border-t border-line/60 pt-2">
                  <span className="block text-[7.5px] font-extrabold uppercase tracking-[0.14em] text-mute">
                    Legenda punktualności GPS
                  </span>
                  <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1">
                    {LEGEND_ITEMS.map(([tone, text]) => (
                      <span
                        key={tone}
                        className="flex items-center gap-1.5 text-[8px] font-semibold text-ink-soft"
                      >
                        <span
                          className="h-2 w-2 shrink-0 rounded-full ring-1 ring-black/10"
                          style={{ backgroundColor: DELAY_STYLES[tone].bg }}
                        />
                        <span className="truncate">{text}</span>
                      </span>
                    ))}
                  </div>
                </div>
              </>
            )}

            {isPlanner && showLiveBuses && dutyStats.eligible > 0 && (
              <div
                className="mt-2 flex items-start gap-1.5 rounded-lg border border-brand/25 bg-surface px-2 py-1.5 text-[8px] leading-snug text-ink-soft"
                data-testid="duty-stats"
              >
                <Check className="mt-px h-2.5 w-2.5 shrink-0 text-brand-ink" />
                <span>
                  <strong className="font-extrabold text-ink">
                    Brygady: {dutyStats.assigned}/{dutyStats.eligible} wozów
                  </strong>{" "}
                  dopasowanych po kursie do rozkładu brygad.
                </span>
              </div>
            )}
          </section>

          {/* Planner route summary card (moved off the map into sidebar) */}
          {isPlanner && route && waypoints && metrics && vehicle && (
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

          {/* Section 2: Twoja lokalizacja i prędkość GPS */}
          <section
            aria-label="Twoja lokalizacja i prędkość"
            data-testid="user-location-hud"
            className="rounded-xl border border-line/80 bg-raised/35 p-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[7.5px] font-extrabold uppercase tracking-[0.14em] text-mute">
                Twoja lokalizacja i prędkość
              </span>
              <button
                type="button"
                onClick={onLocate}
                aria-label="Wycentruj na mojej lokalizacji w panelu"
                className={cn(
                  "flex h-6 items-center gap-1 rounded-md px-2 text-[8px] font-bold transition-colors",
                  followingUser
                    ? "bg-brand text-on-brand"
                    : "border border-line bg-surface text-ink-soft hover:text-ink",
                )}
              >
                <LocateFixed className="h-3 w-3" strokeWidth={2.2} />
                {followingUser ? "Śledzę" : "Lokalizuj"}
              </button>
            </div>

            {locationStatus === "requesting" && !userLocation ? (
              <p className="mt-1.5 flex items-center gap-1.5 text-[9px] font-semibold text-ink-soft">
                <Loader2 className="h-3 w-3 animate-spin text-brand-ink" />
                Szukam sygnału GPS…
              </p>
            ) : locationStatus === "denied" ||
              locationStatus === "unavailable" ? (
              <div className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-warning-soft/80 p-1.5 text-[8.5px] leading-snug text-warning">
                <LocateOff className="mt-0.5 h-3 w-3 shrink-0" />
                <div>
                  {locationStatus === "denied"
                    ? "Lokalizacja zablokowana w przeglądarce."
                    : "Brak obsługi GPS w tej przeglądarce."}
                  {locationStatus === "denied" && (
                    <button
                      type="button"
                      onClick={onRetryLocation}
                      className="ml-1 font-extrabold underline"
                    >
                      Spróbuj ponownie
                    </button>
                  )}
                </div>
              </div>
            ) : userLocation ? (
              <div className="mt-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="flex items-baseline gap-1 leading-none">
                    <span
                      className="metric text-[19px] font-extrabold text-ink"
                      data-testid="user-speed"
                    >
                      {userLocation.speedKmh === null
                        ? "—"
                        : formatUserSpeed(userLocation.speedKmh)}
                    </span>
                    <span className="text-[9px] font-bold text-mute">km/h</span>
                  </p>
                  <div className="flex items-center gap-2 text-[8.5px]">
                    <span
                      className="metric flex items-center gap-1 font-bold text-ink"
                      data-testid="user-heading"
                    >
                      {userLocation.heading !== null ? (
                        <>
                          <Navigation
                            className="h-2.5 w-2.5 shrink-0 text-brand-ink"
                            style={{
                              transform: `rotate(${userLocation.heading - 45}deg)`,
                            }}
                          />
                          {compassLabel(userLocation.heading)}{" "}
                          {Math.round(userLocation.heading)}°
                        </>
                      ) : (
                        <span className="font-semibold text-mute">
                          {moving ? "—" : "stoisz"}
                        </span>
                      )}
                    </span>
                    <span className="text-line-strong">·</span>
                    <span
                      className={cn(
                        "metric font-bold",
                        weak ? "text-warning" : "text-ink-soft",
                      )}
                      data-testid="user-accuracy"
                    >
                      ±{Math.round(userLocation.accuracy)} m
                    </span>
                  </div>
                </div>
                <p className="metric mt-1 flex flex-wrap gap-x-1.5 border-t border-line/60 pt-1 text-[7.5px] font-semibold text-mute">
                  <span>maks. {formatUserSpeed(userLocation.maxSpeedKmh)} km/h</span>
                  <span>· trasa {formatDistanceCompact(userLocation.distanceM)}</span>
                  {userLocation.altitude !== null && (
                    <span>· {Math.round(userLocation.altitude)} m n.p.m.</span>
                  )}
                </p>
                {(stale || weak) && (
                  <p className="mt-0.5 text-[7.5px] font-semibold text-warning">
                    {stale
                      ? `Ostatni odczyt GPS ${ageS} s temu.`
                      : "Słaby sygnał GPS — pozycja przybliżona."}
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-1.5 text-[8.5px] text-mute">
                Kliknij „Lokalizuj”, aby zobaczyć swoją pozycję i prędkość GPS.
              </p>
            )}
          </section>

          {/* Section 3: Ustawienia widoczności */}
          <section
            role="region"
            aria-label="Ustawienia widoczności"
            className="rounded-xl border border-line/80 bg-raised/35 p-2"
          >
            <div className="flex items-center justify-between gap-2 pb-1">
              <span className="text-[7.5px] font-extrabold uppercase tracking-[0.14em] text-mute">
                Ustawienia widoczności
              </span>
              <button
                type="button"
                onClick={onRefreshBusStops}
                disabled={busLoading}
                title="Pobierz przystanki dla bieżącego widoku"
                aria-label="Pobierz przystanki dla bieżącego widoku mapy"
                className="flex h-6 items-center gap-1 rounded-md border border-line bg-surface px-2 text-[8px] font-bold text-ink-soft transition-colors hover:text-brand-ink disabled:opacity-45"
              >
                {busLoading ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Bus className="h-2.5 w-2.5 text-brand-ink" />
                )}
                <span>Odśwież ({mapStopCount})</span>
              </button>
            </div>

            <div className="pt-0.5 text-[9px] font-extrabold text-ink">
              Przystanki na mapie
            </div>
            <div className="mt-1 flex gap-0.5 rounded-lg bg-soft p-0.5">
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
                      "flex h-6.5 flex-1 items-center justify-center gap-1 rounded-md text-[8.5px] font-bold transition-colors",
                      active
                        ? "bg-surface text-brand-ink shadow-[0_1px_3px_rgba(13,42,28,0.12)]"
                        : "text-mute hover:text-ink",
                    )}
                  >
                    <Icon className="h-3 w-3" strokeWidth={2} />
                    {option.label}
                  </button>
                );
              })}
            </div>

            <div className="mt-2 border-t border-line/60 pt-1.5 text-[9px] font-extrabold text-ink">
              Etykiety autobusów GPS
            </div>
            <SidebarSwitch
              label="Pokaż autobusy na mapie"
              checked={visibility.liveBuses}
              onChange={(next) => onVisibilityChange({ liveBuses: next })}
            />
            <SidebarSwitch
              label="Kursówka"
              hint="np. 15/01, 2/08"
              checked={visibility.busKursowka}
              onChange={(next) => onVisibilityChange({ busKursowka: next })}
            />
            <SidebarSwitch
              label="Numer taborowy"
              hint="np. #340, #3"
              checked={visibility.busVehicleNumber}
              onChange={(next) => onVisibilityChange({ busVehicleNumber: next })}
            />

            {isPlanner && (
              <>
                <div className="mt-1.5 border-t border-line/60 pt-1.5 text-[9px] font-extrabold text-ink">
                  Wyznaczona trasa
                </div>
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
              </>
            )}

            <button
              type="button"
              onClick={() => onVisibilityChange({ ...DEFAULT_VISIBILITY })}
              className="mt-1.5 w-full rounded-lg border border-line bg-surface py-1 text-[8.5px] font-bold text-ink-soft transition-colors hover:bg-raised hover:text-ink"
            >
              Przywróć domyślne
            </button>
          </section>

          {/* Section 4: Styl mapy */}
          <section className="rounded-xl border border-line/80 bg-raised/35 p-2">
            <span className="block text-[7.5px] font-extrabold uppercase tracking-[0.14em] text-mute">
              Styl mapy
            </span>
            <div className="mt-1.5 grid grid-cols-3 gap-1">
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
                      "flex flex-col items-center gap-1 rounded-lg border p-1.5 text-center transition-colors",
                      active
                        ? "border-brand bg-brand-soft text-brand-ink"
                        : "border-line/70 bg-surface text-ink-soft hover:bg-raised",
                    )}
                  >
                    <span
                      className="grid h-6 w-full place-items-center rounded-md border border-line/60"
                      style={{ background: style.swatch }}
                    >
                      <Icon
                        className={cn(
                          "h-3 w-3",
                          style.id === "dark" || style.id === "satellite"
                            ? "text-white"
                            : "text-ink",
                        )}
                      />
                    </span>
                    <span className="text-[8.5px] font-bold">{style.short}</span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
