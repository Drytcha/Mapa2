import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPinned,
  RefreshCw,
  X,
} from "lucide-react";
import { DateTime } from "luxon";
import { subscribeSharedClock } from "@/lib/core/runtimeHub";
import { filterLinesForRole, isPlannerOnlyLine } from "@/lib/core/text";
import { formatWarsawClock, WARSAW_ZONE } from "@/lib/core/time";
import type { BusStop, StopDepartureItem } from "@/lib/types";
import { cn } from "@/utils/cn";
import { describeDelay, formatDelay, formatVehicleNumber } from "@/lib/delay";
import { getStopDepartures } from "@/lib/engine/gtfsStore";
import { getFallbackStopDepartures } from "@/lib/engine/stopScheduleFallback";
import {
  groupDeparturesByLine,
  type DepartureLineGroup,
} from "@/lib/departureGroups";

export type { StopDepartureItem };
const ZONE = WARSAW_ZONE;
const today = () => DateTime.now().setZone(ZONE).toISODate()!;
const clock = formatWarsawClock;
const EMPTY_DEPARTURES: StopDepartureItem[] = [];

interface Props {
  stop: BusStop;
  onAddDeparture?: (stop: {
    id: string;
    name: string;
    lat: number;
    lon: number;
  }) => void;
  onOpenKursowka?: (id: string, code: string) => void;
  onPreviewCourse?: (tripId: string, dateId: string) => Promise<boolean>;
  /** Travellers never see planner-only special "S" lines. */
  hidePlannerOnlyLines?: boolean;
  className?: string;
  lineFilter?: string | null;
  onLineFilterChange?: (line: string | null) => void;
}

type MatchedStop = NonNullable<
  Awaited<ReturnType<typeof getStopDepartures>>["matched"]
>;

function LineDepartures({
  group,
  now,
  upcomingOnly,
  onOpenKursowka,
  onPreviewCourse,
}: {
  group: DepartureLineGroup;
  now: number;
  upcomingOnly: boolean;
  onOpenKursowka?: Props["onOpenKursowka"];
  onPreviewCourse?: Props["onPreviewCourse"];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const entries = group.departures.filter(
    ({ departure: d }) =>
      !upcomingOnly ||
      d.atMs + (d.isRealtime ? d.delaySeconds * 1000 : 0) >= now,
  );
  const detail = entries.find(
    ({ departure: d }) => `${d.tripId}|${d.atMs}` === selected,
  );
  return (
    <section
      className="border-b border-line/60 py-1 last:border-b-0"
      aria-label={`Odjazdy linii ${group.line}`}
    >
      <div className="flex items-start gap-1">
        <span
          className="metric mt-[3px] grid h-5 min-w-5 shrink-0 place-items-center rounded px-1 text-[9px] font-extrabold leading-none"
          style={{ background: group.color, color: group.textColor }}
          title={`Linia ${group.line} · ${entries.length} odjazdów`}
        >
          {group.line}
        </span>
        <div className="min-w-0 flex-1">
          {entries.length ? (
            <div
              className="grid grid-cols-[repeat(auto-fill,minmax(38px,1fr))] gap-x-0 gap-y-0"
              aria-label={`Godziny odjazdów linii ${group.line}`}
            >
              {entries.map(({ departure: d, direction }) => {
                const key = `${d.tripId}|${d.atMs}`;
                const past =
                  d.atMs + (d.isRealtime ? d.delaySeconds * 1000 : 0) < now;
                const suffix = direction.suffix ? direction.suffix : "";
                const label = `Linia ${group.line}, ${d.clock}${suffix}, kierunek ${direction.label}${direction.main ? " (główny)" : ""}${d.isRealtime ? `, GPS ${describeDelay(d.delaySeconds)}` : ""}`;
                return (
                  <button
                    key={key}
                    type="button"
                    title={label}
                    aria-label={label}
                    aria-expanded={key === selected}
                    onClick={() => setSelected(key === selected ? null : key)}
                    data-testid="compact-departure"
                    className={cn(
                      "relative min-h-[26px] rounded px-0.5 text-center font-mono text-[11px] font-semibold tabular-nums leading-[26px] transition-colors focus-visible:outline-2 focus-visible:outline-brand",
                      key === selected
                        ? "bg-brand text-on-brand"
                        : "hover:bg-brand-soft hover:text-brand-ink",
                      key !== selected && (past ? "text-mute" : "text-ink"),
                    )}
                  >
                    {d.clock}
                    {direction.suffix && (
                      <span className="text-[7.5px]">{direction.suffix}</span>
                    )}
                    {d.isRealtime && !past && (
                      <span
                        aria-hidden="true"
                        className="absolute right-0 top-0.5 h-1 w-1 rounded-full bg-emerald-500"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="py-0.5 text-[9px] text-mute">
              Brak kolejnych odjazdów tego dnia.
            </p>
          )}
          <ul
            className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0 text-[7.5px] leading-tight text-ink-soft"
            aria-label={`Oznaczenia kierunków linii ${group.line}`}
          >
            {group.directions.map((direction) => (
              <li
                key={direction.key}
                className="flex min-w-0 items-baseline gap-0.5"
                aria-label={
                  direction.main
                    ? `Kierunek główny: ${direction.label}`
                    : `${direction.suffix} → ${direction.label}`
                }
              >
                {direction.main ? (
                  <>
                    <span className="shrink-0 font-semibold text-mute">
                      {group.directions.length > 1 ? "główny:" : "kierunek:"}
                    </span>
                    <b
                      className="max-w-[124px] truncate font-bold text-ink"
                      title={direction.label}
                    >
                      {direction.label}
                    </b>
                    {group.directions.length > 1 && (
                      <span className="shrink-0 text-mute">(bez litery)</span>
                    )}
                  </>
                ) : (
                  <>
                    <b className="shrink-0 font-mono font-bold text-brand-ink">
                      {direction.suffix}
                    </b>
                    <span className="shrink-0 text-mute" aria-hidden="true">
                      →
                    </span>
                    <span
                      className="max-w-[112px] truncate"
                      title={direction.label}
                    >
                      {direction.label}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {detail && (
        <div
          className="mt-2 border-l-2 border-brand bg-brand-soft/50 py-1.5 pl-2 pr-1 text-[10px] leading-relaxed"
          role="region"
          aria-label="Szczegóły odjazdu"
        >
          <div className="flex items-start justify-between gap-1">
            <p className="font-bold text-ink">
              {detail.departure.clock}
              {detail.direction.suffix}
              {" → "}
              {detail.direction.label}
              {detail.direction.main && group.directions.length > 1 && (
                <span className="ml-1 rounded bg-surface px-1 py-0.5 text-[8px] font-bold text-mute ring-1 ring-line">
                  kierunek główny
                </span>
              )}
            </p>
            <button
              type="button"
              onClick={() => setSelected(null)}
              aria-label="Zamknij szczegóły odjazdu"
              className="grid h-6 w-6 shrink-0 place-items-center rounded hover:bg-surface"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          {detail.departure.isRealtime ? (
            <p className="text-brand-ink">
              GPS: {formatDelay(detail.departure.delaySeconds)} · przewidywany{" "}
              {clock(
                detail.departure.atMs + detail.departure.delaySeconds * 1000,
              )}
            </p>
          ) : (
            <p className="text-mute">Według rozkładu; brak prognozy GPS.</p>
          )}
          {detail.departure.vehicleId ? (
            <p className="text-ink-soft">
              Wóz {formatVehicleNumber(detail.departure.vehicleId)}{" "}
              {detail.departure.operatorName}
            </p>
          ) : detail.departure.operatorName ? (
            <p className="text-ink-soft">
              Przewoźnik: {detail.departure.operatorName}
            </p>
          ) : null}
          {onPreviewCourse && detail.departure.canPreviewCourse !== false && (
            <button
              type="button"
              data-testid="preview-departure-course"
              aria-label={`Pokaż przebieg kursu linii ${group.line} z ${detail.departure.clock}`}
              onClick={async () => {
                if (previewing) return;
                setPreviewing(true);
                try {
                  await onPreviewCourse(
                    detail.departure.tripId,
                    detail.departure.serviceDateId
                  );
                } finally {
                  setPreviewing(false);
                }
              }}
              disabled={previewing}
              className="mt-1.5 flex h-7 w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-2 text-[9px] font-extrabold text-on-brand transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {previewing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <MapPinned className="h-3 w-3" />
              )}
              Pokaż przebieg kursu na mapie
            </button>
          )}
          {detail.departure.kursowka && onOpenKursowka && (
            <button
              type="button"
              className="mt-1 font-bold text-brand-ink underline underline-offset-2"
              onClick={() =>
                onOpenKursowka(
                  detail.departure.kursowkaId,
                  detail.departure.kursowka,
                )
              }
            >
              Kursówka {detail.departure.kursowka}
              {detail.departure.operatorKey === "mzuk"
                ? " (MZUK)"
                : detail.departure.operatorKey === "ska"
                  ? " (ŚKA)"
                  : ""}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export default function GtfsSchedule({
  stop,
  onAddDeparture,
  onOpenKursowka,
  onPreviewCourse,
  hidePlannerOnlyLines = false,
  className,
  lineFilter,
  onLineFilterChange,
}: Props) {
  const [matched, setMatched] = useState<MatchedStop | null>(null);
  const [departures, setDepartures] = useState<StopDepartureItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [source, setSource] = useState<"gtfs" | "gtfs-partial" | "fallback">("gtfs");
  const [date, setDate] = useState(today);
  const [upcomingOnly, setUpcomingOnly] = useState(false);
  const [retry, setRetry] = useState(0);
  const [internalFilter, setInternalFilter] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const loadedKey = useRef("");
  const activeFilter = onLineFilterChange
    ? (lineFilter ?? null)
    : internalFilter;
  const setFilter = onLineFilterChange ?? setInternalFilter;

  useEffect(() => {
    setInternalFilter(null);
    setUpcomingOnly(false);
  }, [stop.id]);

  useEffect(() => {
    let cancelled = false;
    let primaryWins = false;
    const fallbackController = new AbortController();
    const start = DateTime.fromISO(date, { zone: ZONE }).startOf("day");
    if (!start.isValid) return;
    const key = `${stop.id}|${date}`;
    const options = {
      lat: stop.lat,
      lon: stop.lon,
      name: stop.name,
      stopId: stop.gtfsId,
      stopIds: stop.gtfsIds,
      fromMs: start.toMillis(),
      toMs: start.plus({ days: 1 }).toMillis(),
    };
    if (loadedKey.current !== key) {
      setDepartures([]);
      setMatched(null);
      setSource("gtfs");
    }
    setLoading(true);
    setError("");

    type Result = Awaited<ReturnType<typeof getStopDepartures>>;
    const show = (result: Result, nextSource: "gtfs" | "gtfs-partial" | "fallback") => {
      if (cancelled) return;
      loadedKey.current = key;
      setMatched(result.matched);
      setDepartures(result.departures);
      setSource(nextSource);
      setError("");
      setNow(Date.now());
      setLoading(false);
    };
    const fail = (message: string) => {
      if (cancelled) return;
      loadedKey.current = key;
      setMatched(null);
      setDepartures([]);
      setSource("gtfs");
      setError(message);
      setLoading(false);
    };

    let fallback: Promise<Result | null> | null = null;
    const startFallback = () => {
      if (!fallback) {
        fallback = getFallbackStopDepartures(stop, options.fromMs, options.toMs, fallbackController.signal)
          .then((result) => {
            if (!primaryWins) show(result, "fallback");
            return result;
          })
          .catch(() => null);
      }
      return fallback;
    };
    // If the archive is slow, the independent stop API can show real departures
    // while GTFS loads. A successful GTFS result always takes precedence.
    const fallbackTimer = window.setTimeout(() => void startFallback(), 1_000);
    void (async () => {
      try {
        const result = await getStopDepartures({ ...options, includeLive: false });
        if (cancelled) return;
        window.clearTimeout(fallbackTimer);
        if (!result.matched || result.outsideFeedValidity) {
          if (!(await startFallback()) && !cancelled) {
            if (result.outsideFeedValidity) {
              // A valid previous service day can still have trips after midnight.
              // Preserve them, but never present them as a complete day's timetable.
              if (result.matched && result.departures.length) show(result, "gtfs-partial");
              else fail("Rozkład GTFS nie obejmuje wybranego dnia. Rozkład awaryjny też jest niedostępny.");
            } else {
              show(result, "gtfs");
            }
          }
          return;
        }
        primaryWins = true;
        fallbackController.abort();
        show(result, "gtfs");

        // Enrich already-visible scheduled times in the background; a slow or
        // unavailable GPS endpoint must never hold the timetable hostage.
        if (date === today()) {
          void getStopDepartures({ ...options, includeLive: true })
            .then((live) => {
              if (!cancelled && primaryWins) show(live, "gtfs");
            })
            .catch(() => undefined);
        }
      } catch (cause: unknown) {
        if (cancelled) return;
        window.clearTimeout(fallbackTimer);
        if (!(await startFallback()) && !cancelled) {
          const message = cause instanceof Error ? cause.message : "Nie udało się odczytać rozkładu.";
          fail(`${message} Rozkład awaryjny też jest niedostępny.`);
        }
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimer);
      fallbackController.abort();
    };
  }, [stop.id, stop.lat, stop.lon, stop.name, stop.gtfsId, stop.gtfsIds, stop.snapshotIds, date, retry]);

  useEffect(() => {
    return subscribeSharedClock(60_000, (tickNow) => {
      setNow(tickNow);
      if (date === today()) setRetry((value) => value + 1);
    });
  }, [date]);

  // Effects run after render: never paint the previous stop/day's departures
  // beneath a newly selected heading while the next request is starting.
  const isCurrent = loadedKey.current === `${stop.id}|${date}`;
  const shownDepartures = isCurrent ? departures : EMPTY_DEPARTURES;
  const shownMatched = isCurrent ? matched : null;
  const shownError = isCurrent ? error : "";
  const shownLoading = loading || !isCurrent;
  const groups = useMemo(() => {
    const source = hidePlannerOnlyLines
      ? shownDepartures.filter((d) => !isPlannerOnlyLine(d.routeShort))
      : shownDepartures;
    return groupDeparturesByLine(source);
  }, [shownDepartures, hidePlannerOnlyLines]);
  const shown = activeFilter
    ? groups.filter((g) => g.line === activeFilter)
    : groups;
  const filterLines = useMemo(
    () =>
      filterLinesForRole(
        new Set([...stop.lines, ...groups.map((g) => g.line)]),
        !hidePlannerOnlyLines
      ).sort((a, b) => a.localeCompare(b, "pl", { numeric: true })),
    [stop.lines, groups, hidePlannerOnlyLines]
  );
  const changeDay = (days: number) => {
    setDate(DateTime.fromISO(date, { zone: ZONE }).plus({ days }).toISODate()!);
    setUpcomingOnly(false);
  };

  return (
    <section
      className={cn("mt-2 border-t border-line pt-2", className)}
      data-testid="gtfs-schedule"
      aria-busy={shownLoading}
    >
      <div className="flex items-center justify-between gap-1">
        <h4 className="flex items-center gap-1 text-[10px] font-extrabold text-ink">
          <CalendarClock className="h-3 w-3 text-brand-ink" />
          Rozkład
        </h4>
        <button
          type="button"
          onClick={() => setRetry((v) => v + 1)}
          aria-label="Odśwież rozkład"
          className="grid h-6 w-6 place-items-center rounded text-mute hover:bg-raised hover:text-ink"
        >
          <RefreshCw className={cn("h-2.5 w-2.5", shownLoading && "animate-spin")} />
        </button>
      </div>
      {source === "fallback" && shownMatched && (
        <p role="status" className="mt-1 text-[9px] leading-snug text-mute">
          Rozkład awaryjny: zbiorkom.live. Podgląd przebiegu kursu jest niedostępny.
        </p>
      )}
      {source === "gtfs-partial" && shownMatched && (
        <p role="status" className="mt-1 text-[9px] leading-snug text-warning">
          Rozkład GTFS nie obejmuje całego dnia. Pokazano tylko znane kursy z poprzedniego dnia obsługi; rozkład awaryjny jest niedostępny.
        </p>
      )}
      <div className="mt-1 flex items-center justify-between gap-1">
        <div className="flex min-w-0 items-center">
          <button
            type="button"
            onClick={() => changeDay(-1)}
            aria-label="Poprzedni dzień"
            className="grid h-6 w-5 place-items-center rounded hover:bg-raised"
          >
            <ChevronLeft className="h-3 w-3" />
          </button>
          <input
            type="date"
            aria-label="Dzień rozkładu"
            value={date}
            onChange={(e) => {
              if (e.target.value) {
                setDate(e.target.value);
                setUpcomingOnly(false);
              }
            }}
            className="h-6 min-w-0 rounded border border-line bg-surface px-0.5 text-[9px] text-ink"
          />
          <button
            type="button"
            onClick={() => changeDay(1)}
            aria-label="Następny dzień"
            className="grid h-6 w-5 place-items-center rounded hover:bg-raised"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
        <select
          aria-label="Filtr linii"
          value={activeFilter ?? ""}
          onChange={(e) => setFilter(e.target.value || null)}
          className="h-6 min-w-0 max-w-[92px] rounded border border-line bg-surface px-0.5 text-[8.5px] text-ink"
        >
          <option value="">Wszystkie linie</option>
          {filterLines.map((line) => (
            <option key={line} value={line}>
              Linia {line}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-1.5 flex items-center gap-2.5 border-b border-line text-[8px] font-bold">
        <button
          type="button"
          aria-pressed={!upcomingOnly}
          onClick={() => setUpcomingOnly(false)}
          className={cn(
            "border-b-2 pb-1",
            !upcomingOnly
              ? "border-brand text-brand-ink"
              : "border-transparent text-mute",
          )}
        >
          Cały dzień
        </button>
        <button
          type="button"
          aria-pressed={upcomingOnly}
          onClick={() => {
            setDate(today());
            setUpcomingOnly(true);
          }}
          className={cn(
            "border-b-2 pb-1",
            upcomingOnly
              ? "border-brand text-brand-ink"
              : "border-transparent text-mute",
          )}
        >
          Od teraz
        </button>
        {onAddDeparture && shownMatched && (
          <button
            type="button"
            onClick={() => onAddDeparture(shownMatched)}
            aria-label="Ustaw przystanek jako metę"
            className="ml-auto pb-1 text-brand-ink"
          >
            <MapPinned className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {shownLoading && !shownDepartures.length && (
        <p
          role="status"
          className="flex items-center gap-2 py-4 text-[11px] text-mute"
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          Wczytywanie rozkładu...
        </p>
      )}
      {shownError && (
        <div role="alert" className="py-3 text-[10px] text-warning">
          {shownError}
          <button
            type="button"
            className="ml-1 font-bold underline"
            onClick={() => setRetry((v) => v + 1)}
          >
            Spróbuj ponownie
          </button>
        </div>
      )}
      {!shownLoading && !shownError && !shownMatched && (
        <p className="py-3 text-[10px] text-mute">
          Nie udało się jednoznacznie dopasować tego przystanku do rozkładu.
        </p>
      )}
      {!shownLoading && !shownError && shownMatched && !shown.length && (
        <p className="py-3 text-[10px] text-mute">
          Brak odjazdów{activeFilter ? ` linii ${activeFilter}` : ""} tego dnia.
        </p>
      )}
      {!shownError && (
        <div className="scroll-area mt-1 max-h-[400px] overflow-y-auto pr-1">
          {shown.map((group) => (
            <LineDepartures
              key={`${stop.id}|${date}|${group.line}`}
              group={group}
              now={now}
              upcomingOnly={upcomingOnly}
              onOpenKursowka={onOpenKursowka}
              onPreviewCourse={onPreviewCourse}
            />
          ))}
        </div>
      )}
      {shownMatched && (
        <p className="mt-1.5 text-[7px] leading-snug text-mute">
          Litery = kierunki odchyleń; kierunek główny bez litery. Kliknij
          godzinę po szczegóły{onPreviewCourse && source !== "fallback" ? " i przebieg kursu na mapie" : ""}. Czas polski.
        </p>
      )}
    </section>
  );
}
