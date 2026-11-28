import { memo, useState } from "react";
import {
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  LocateFixed,
  Navigation,
  Pause,
  Play,
  Radio,
  RotateCcw,
  TriangleAlert,
  X,
} from "lucide-react";
import { useSharedClock } from "@/lib/core/runtimeHub";
import { formatWarsawClock } from "@/lib/core/time";
import {
  computeCoursePunctuality,
  formatNavDistance,
  type CourseManeuverKind,
  type CourseNavRoute,
  type CourseNavState,
} from "@/lib/courseNavigation";
import { DELAY_STYLES, delayTone, formatDelay } from "@/lib/delay";
import { cn } from "@/utils/cn";

export interface CourseNavigationHudProps {
  route: CourseNavRoute;
  state: CourseNavState;
  startedAtMs?: number;
  mode: "gps" | "sim";
  onModeChange: (mode: "gps" | "sim") => void;
  simPlaying: boolean;
  onToggleSimPlay: () => void;
  simSpeedMultiplier: 1 | 3 | 8;
  onCycleSimSpeed: () => void;
  gpsAvailable: boolean;
  gpsSpeedKmh: number | null;
  followingCamera: boolean;
  onRecenterCamera: () => void;
  punctualityMode: "schedule" | "relative";
  onTogglePunctualityMode: () => void;
  onStepStop: (delta: -1 | 1) => void;
  onJumpToStop: (stopIndex: number) => void;
  onStopNavigation: () => void;
}

function ManeuverIcon({ kind }: { kind: CourseManeuverKind }) {
  switch (kind) {
    case "left":
    case "sharp-left":
      return <CornerUpLeft className="h-5 w-5" strokeWidth={2.5} />;
    case "slight-left":
      return <ArrowUpLeft className="h-5 w-5" strokeWidth={2.5} />;
    case "right":
    case "sharp-right":
      return <CornerUpRight className="h-5 w-5" strokeWidth={2.5} />;
    case "slight-right":
      return <ArrowUpRight className="h-5 w-5" strokeWidth={2.5} />;
    case "uturn":
      return <RotateCcw className="h-5 w-5" strokeWidth={2.5} />;
    case "arrive":
      return <Flag className="h-5 w-5" strokeWidth={2.4} />;
    case "depart":
    case "straight":
    default:
      return <ArrowUp className="h-5 w-5" strokeWidth={2.5} />;
  }
}

function CourseNavigationHudInner({
  route,
  state,
  startedAtMs,
  mode,
  onModeChange,
  simPlaying,
  onToggleSimPlay,
  simSpeedMultiplier,
  onCycleSimSpeed,
  gpsAvailable,
  gpsSpeedKmh,
  followingCamera,
  onRecenterCamera,
  punctualityMode,
  onTogglePunctualityMode,
  onStepStop,
  onJumpToStop,
  onStopNavigation,
}: CourseNavigationHudProps) {
  const [collapsed, setCollapsed] = useState(false);
  const clockNow = useSharedClock(
    1_000,
    startedAtMs !== undefined && route.startMs !== null,
  );

  const deltaSec =
    startedAtMs !== undefined
      ? computeCoursePunctuality(
          route,
          state.alongMeters,
          clockNow,
          startedAtMs,
          punctualityMode,
        )
      : state.scheduleDeltaSeconds;
  const punctualityStyle =
    deltaSec !== null ? DELAY_STYLES[delayTone(deltaSec)] : null;
  const punctualityText =
    deltaSec !== null
      ? Math.abs(deltaSec) <= 20
        ? "0:00"
        : formatDelay(deltaSec)
      : null;

  const nextStop = state.nextStop;
  const followingStop = state.followingStop;
  const nextStopClock =
    state.plannedClockAtNextStopMs != null
      ? formatWarsawClock(state.plannedClockAtNextStopMs)
      : null;

  return (
    <section
      aria-label="Sterownik nawigacji po trasie kursu"
      data-testid="course-nav-hud"
      className="pointer-events-auto w-[min(410px,calc(100vw-20px))] overflow-hidden rounded-2xl border border-line/60 bg-surface/98 shadow-[0_14px_38px_rgba(15,23,42,0.22)]"
    >
      {/* Górny wiersz sterownika: linia, kierunek, punktualność i zamknięcie */}
      <div className="flex items-center gap-2 border-b border-line/50 bg-raised/70 px-3 py-2">
        <span
          className="metric grid h-7 min-w-[34px] shrink-0 place-items-center rounded-lg px-2 text-[13px] font-extrabold shadow-xs"
          style={{ backgroundColor: route.color, color: route.textColor }}
        >
          {route.routeShort}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-extrabold text-ink">
              {route.headsign}
            </span>
            {route.dutyCode && (
              <span className="metric shrink-0 rounded bg-soft px-1.5 py-0.5 text-[10px] font-bold text-mute">
                {route.dutyCode}
              </span>
            )}
          </div>
        </div>

        {punctualityStyle && punctualityText && (
          <button
            type="button"
            data-testid="course-nav-punctuality"
            onClick={onTogglePunctualityMode}
            title={
              punctualityMode === "schedule"
                ? "Odchyłka względem godzin rozkładowych (kliknij, aby liczyć od momentu startu jazdy)"
                : "Odchyłka liczona od momentu startu jazdy (kliknij, aby przełączyć na zegar rozkładu)"
            }
            className="metric flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11.5px] font-black shadow-xs transition-transform active:scale-95"
            style={{
              backgroundColor: punctualityStyle.bg,
              color: punctualityStyle.fg,
            }}
          >
            <span>{punctualityText}</span>
            <span className="text-[8.5px] font-bold uppercase opacity-80">
              {punctualityMode === "relative" ? "start" : "plan"}
            </span>
          </button>
        )}

        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Rozwiń sterownik nawigacji" : "Zwiń sterownik nawigacji"}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-soft transition-colors hover:bg-soft hover:text-ink"
        >
          {collapsed ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronUp className="h-4 w-4" />
          )}
        </button>

        <button
          type="button"
          data-testid="course-nav-stop-btn"
          onClick={onStopNavigation}
          aria-label="Zakończ nawigację po trasie kursu"
          title="Zakończ nawigację"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-soft transition-colors hover:bg-warning-soft hover:text-warning"
        >
          <X className="h-4 w-4" strokeWidth={2.3} />
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Sekcja manewru drogowego / ostrzeżenia o zjechaniu z trasy */}
          <div className="px-3 pt-2.5">
            {state.offRoute ? (
              <div
                role="status"
                data-testid="course-nav-offroute"
                className="flex items-center gap-2.5 rounded-xl bg-amber-500/15 px-3 py-2.5 text-amber-900 ring-1 ring-amber-500/35 dark:text-amber-200"
              >
                <TriangleAlert className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-extrabold leading-tight">
                    Poza trasą linii ({formatNavDistance(state.offRouteMeters)})
                  </div>
                  <div className="mt-0.5 text-[10.5px] opacity-90">
                    Wróć na oznaczoną trasę kursu na mapie
                  </div>
                </div>
              </div>
            ) : state.finished ? (
              <div className="flex items-center gap-2.5 rounded-xl bg-emerald-500/15 px-3 py-2.5 text-emerald-900 dark:text-emerald-200">
                <Flag className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-extrabold">
                    Koniec kursu — osiągnięto pętlę końcową
                  </div>
                  {nextStop && (
                    <div className="text-[11px] opacity-85">{nextStop.name}</div>
                  )}
                </div>
              </div>
            ) : (
              <div
                data-testid="course-nav-maneuver"
                className="flex items-center gap-2.5 rounded-xl bg-brand-soft/80 px-3 py-2 text-ink"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand text-on-brand">
                  <ManeuverIcon kind={state.nextManeuver.kind} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[12.5px] font-extrabold text-ink">
                      {state.nextManeuver.instruction}
                    </span>
                    <span className="metric shrink-0 text-[12px] font-black text-brand-ink">
                      {state.distanceToManeuverMeters <= 25
                        ? "Teraz"
                        : `za ${formatNavDistance(state.distanceToManeuverMeters)}`}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between text-[10.5px] text-mute">
                    <span>
                      Do końca kursu: {formatNavDistance(state.remainingMeters)}
                    </span>
                    {mode === "gps" && gpsSpeedKmh !== null && (
                      <span className="metric font-bold text-ink-soft">
                        {Math.round(gpsSpeedKmh)} km/h
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Sekcja następnego przystanku (jak na sterowniku kierowcy) */}
          {nextStop && (
            <div className="px-3 py-2.5">
              <div
                data-testid="course-nav-next-stop"
                className={cn(
                  "rounded-xl px-3 py-2.5 transition-colors",
                  state.atStopZone
                    ? "bg-emerald-500/14 ring-1 ring-emerald-500/35"
                    : "bg-soft/65",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-[0.06em] text-mute">
                    {state.atStopZone
                      ? "Strefa przystanku"
                      : `Następny przystanek (${nextStop.number}/${route.stops.length})`}
                  </span>
                  <div className="flex items-center gap-2">
                    {nextStopClock && nextStopClock !== "—" && (
                      <span className="metric text-[11px] font-bold text-ink-soft">
                        plan {nextStopClock}
                      </span>
                    )}
                    <span className="metric rounded-md bg-surface px-1.5 py-0.5 text-[11px] font-black text-brand-ink">
                      {state.atStopZone
                        ? "Na miejscu"
                        : formatNavDistance(state.distanceToNextStopMeters)}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onJumpToStop(nextStop.index)}
                  className="mt-1 flex w-full items-center gap-2 text-left"
                  title="Wycentruj mapę na tym przystanku"
                >
                  <span
                    className="metric grid h-6 min-w-[24px] shrink-0 place-items-center rounded-full px-1.5 text-[11px] font-black text-white shadow-xs"
                    style={{ backgroundColor: route.color }}
                  >
                    {nextStop.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-extrabold text-ink">
                    {nextStop.name}
                  </span>
                </button>

                {followingStop && (
                  <div className="mt-1.5 flex items-center gap-1.5 border-t border-line/45 pt-1.5 text-[11px] text-mute">
                    <span className="shrink-0">Następnie:</span>
                    <span className="metric font-bold text-ink-soft">
                      #{followingStop.number}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium text-ink-soft">
                      {followingStop.name}
                    </span>
                    {followingStop.departureMs ? (
                      <span className="metric shrink-0 font-semibold">
                        {formatWarsawClock(followingStop.departureMs)}
                      </span>
                    ) : null}
                  </div>
                )}
              </div>

              {/* Pasek postępu całej trasy */}
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-soft">
                <div
                  className="h-full rounded-full bg-brand transition-[width] duration-200"
                  style={{ width: `${Math.round(state.progress * 100)}%` }}
                />
              </div>
            </div>
          )}

          {/* Dolny pasek sterowania: GPS na żywo / Symulacja + przystanki + kamera */}
          <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-line/50 bg-raised/50 px-3 py-2">
            <div className="inline-flex rounded-xl bg-soft/80 p-0.5">
              <button
                type="button"
                data-testid="course-nav-mode-gps"
                onClick={() => onModeChange("gps")}
                className={cn(
                  "flex h-7 items-center gap-1 rounded-lg px-2.5 text-[11px] font-bold transition-colors",
                  mode === "gps"
                    ? "bg-surface text-brand-ink shadow-xs"
                    : "text-mute hover:text-ink",
                )}
              >
                <Radio
                  className={cn(
                    "h-3.5 w-3.5",
                    mode === "gps" && gpsAvailable && "text-emerald-500",
                  )}
                />
                GPS na żywo
              </button>
              <button
                type="button"
                data-testid="course-nav-mode-sim"
                onClick={() => onModeChange("sim")}
                className={cn(
                  "flex h-7 items-center gap-1 rounded-lg px-2.5 text-[11px] font-bold transition-colors",
                  mode === "sim"
                    ? "bg-surface text-brand-ink shadow-xs"
                    : "text-mute hover:text-ink",
                )}
              >
                <Navigation className="h-3.5 w-3.5" />
                Symulacja
              </button>
            </div>

            <div className="flex items-center gap-1">
              {mode === "sim" && (
                <>
                  <button
                    type="button"
                    data-testid="course-nav-sim-play"
                    onClick={onToggleSimPlay}
                    aria-label={simPlaying ? "Wstrzymaj symulację" : "Wznów symulację"}
                    className="flex h-7 items-center gap-1 rounded-lg bg-brand px-2.5 text-[11px] font-bold text-on-brand"
                  >
                    {simPlaying ? (
                      <Pause className="h-3 w-3" fill="currentColor" strokeWidth={0} />
                    ) : (
                      <Play className="h-3 w-3" fill="currentColor" strokeWidth={0} />
                    )}
                    {simPlaying ? "Pauza" : "Jedź"}
                  </button>
                  <button
                    type="button"
                    data-testid="course-nav-sim-speed"
                    onClick={onCycleSimSpeed}
                    title="Prędkość symulacji przejazdu"
                    className="metric h-7 rounded-lg bg-soft px-2 text-[11px] font-extrabold text-ink-soft hover:text-ink"
                  >
                    {simSpeedMultiplier}×
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => onStepStop(-1)}
                title="Poprzedni przystanek"
                aria-label="Poprzedni przystanek"
                className="grid h-7 w-7 place-items-center rounded-lg bg-soft text-ink-soft hover:text-ink"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => onStepStop(1)}
                title="Zlicz przystanek i przejdź do następnego"
                aria-label="Następny przystanek"
                className="grid h-7 w-7 place-items-center rounded-lg bg-soft text-ink-soft hover:text-ink"
              >
                <ChevronRight className="h-4 w-4" />
              </button>

              <button
                type="button"
                data-testid="course-nav-recenter"
                onClick={onRecenterCamera}
                aria-pressed={followingCamera}
                title="Podążaj kamerą za pojazdem"
                aria-label="Podążaj kamerą za pojazdem"
                className={cn(
                  "flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-bold transition-colors",
                  followingCamera
                    ? "bg-brand-soft text-brand-ink"
                    : "bg-soft text-ink-soft hover:text-ink",
                )}
              >
                <LocateFixed className="h-3.5 w-3.5" />
                Śledź
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

const CourseNavigationHud = memo(CourseNavigationHudInner);
export default CourseNavigationHud;
