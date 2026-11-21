import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  MapPinned,
  RefreshCw,
} from "lucide-react";
import { DateTime } from "luxon";
import { subscribeSharedClock } from "@/lib/core/runtimeHub";
import { filterLinesForRole, isPlannerOnlyLine } from "@/lib/core/text";
import { formatWarsawClock, WARSAW_ZONE } from "@/lib/core/time";
import type { BusStop, StopDepartureItem } from "@/lib/types";
import { cn } from "@/utils/cn";
import { describeDelay } from "@/lib/delay";
import { getStopDepartures } from "@/lib/engine/gtfsStore";
import { getFallbackStopDepartures } from "@/lib/engine/stopScheduleFallback";
import {
  groupDeparturesByLine,
  type DepartureLineGroup,
} from "@/lib/departureGroups";
import StopDepartureDetail from "@/components/StopDepartureDetail";
import {
  boardLegend,
  formatEta,
  nextDepartures,
  PUNCTUALITY_LEGEND,
} from "@/lib/stopBoard";

export type { StopDepartureItem };
const ZONE = WARSAW_ZONE;
const today = () => DateTime.now().setZone(ZONE).toISODate()!;
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
                const variant = direction.legendText
                  ? ` (${direction.legendText})`
                  : "";
                const label = `Linia ${group.line}, ${d.clock}${suffix}, kierunek ${direction.label}${variant}${direction.main ? " (główny)" : ""}${d.isRealtime ? `, GPS ${describeDelay(d.delaySeconds)}` : ""}`;
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
                    : direction.suffix
                      ? `${direction.suffix} → ${direction.legendText ?? direction.label}`
                      : `Kierunek: ${direction.label}`
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
                    {direction.suffix ? (
                      <b className="shrink-0 font-mono font-bold text-brand-ink">
                        {direction.suffix}
                      </b>
                    ) : (
                      <span className="shrink-0 text-mute" aria-hidden="true">
                        •
                      </span>
                    )}
                    <span className="shrink-0 text-mute" aria-hidden="true">
                      →
                    </span>
                    <span
                      className="max-w-[176px] truncate"
                      title={direction.label}
                    >
                      {direction.legendText ?? direction.label}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {detail && (
        <StopDepartureDetail
          line={group.line}
          entry={detail}
          directionCount={group.directions.length}
          onClose={() => setSelected(null)}
          onOpenKursowka={onOpenKursowka}
          onPreviewCourse={onPreviewCourse}
        />
      )}
    </section>
  );
}

/**
 * Tablica „Najbliższe odjazdy” (myBus 3.0): jedna lista ~10 najbliższych
 * kursów wszystkich linii z odliczaniem i kolorem punktualności.
 */
export function NextDeparturesBoard({
  groups,
  now,
  onOpenKursowka,
  onPreviewCourse,
}: {
  groups: readonly DepartureLineGroup[];
  now: number;
  onOpenKursowka?: Props["onOpenKursowka"];
  onPreviewCourse?: Props["onPreviewCourse"];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const rows = nextDepartures(groups, { nowMs: now });
  if (!rows.length) {
    return (
      <p className="py-3 text-[10px] text-mute">
        Brak najbliższych odjazdów — sprawdź pełny rozkład dnia.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line/50" aria-label="Najbliższe odjazdy">
      {rows.map((row) => {
        const open = selected === row.key;
        const predicted = row.isRealtime ? formatWarsawClock(row.etaMs) : null;
        const directionCount =
          groups.find((group) => group.line === row.line)?.directions.length ?? 1;
        return (
          <li key={row.key} data-testid="board-departure">
            <button
              type="button"
              aria-expanded={open}
              aria-label={`Linia ${row.line}, ${row.clock}${row.suffix}, ${row.label}${predicted ? `, przewidywany ${predicted}` : ""}, ${formatEta(row.minutes)}`}
              onClick={() => setSelected(open ? null : row.key)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded px-1 py-[3px] text-left transition-colors focus-visible:outline-2 focus-visible:outline-brand",
                open ? "bg-brand-soft" : "hover:bg-raised",
              )}
            >
              <span
                className="metric grid h-5 min-w-5 shrink-0 place-items-center rounded px-1 text-[9px] font-extrabold leading-none"
                style={{ background: row.color, color: row.textColor }}
              >
                {row.line}
              </span>
              <span
                className={cn(
                  "shrink-0 font-mono text-[12px] font-bold tabular-nums",
                  predicted ? "text-ink" : "text-ink-soft",
                )}
              >
                {predicted ?? row.clock}
                {row.suffix && (
                  <span className="align-super text-[7.5px]">{row.suffix}</span>
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-[9.5px] leading-tight text-ink-soft">
                {row.label}
              </span>
              <span className="shrink-0 font-mono text-[8.5px] tabular-nums text-mute">
                {formatEta(row.minutes)}
              </span>
              <span
                aria-label={row.isRealtime ? row.toneStyle.label : "Brak GPS"}
                title={row.isRealtime ? row.toneStyle.label : "Brak prognozy GPS"}
                className="h-2 w-2 shrink-0 rounded-full"
                style={{
                  background: row.isRealtime ? row.toneStyle.bg : "transparent",
                  boxShadow: row.isRealtime ? undefined : "inset 0 0 0 1px #94a3b8",
                }}
              />
            </button>
            {open && (
              <StopDepartureDetail
                line={row.line}
                entry={row.departure}
                directionCount={directionCount}
                onClose={() => setSelected(null)}
                onOpenKursowka={onOpenKursowka}
                onPreviewCourse={onPreviewCourse}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Legenda oznaczeń pod listą — litery wariantów i kolory punktualności. */
export function StopBoardLegend({ groups }: { groups: readonly DepartureLineGroup[] }) {
  const letters = boardLegend(groups);
  return (
    <div
      className="mt-1 space-y-1 rounded border border-line bg-raised/50 px-1.5 py-1 text-[8px] leading-snug text-ink-soft"
      data-testid="board-legend"
    >
      {letters.length > 0 && (
        <div>
          <p className="font-bold text-ink">Litery wariantów</p>
          <ul className="space-y-0.5">
            {letters.map((row) => (
              <li key={`${row.line}|${row.code}`}>
                <b className="font-mono font-bold text-brand-ink">{row.code}</b>
                {" – "}
                {row.text}
                <span className="text-mute"> (linia {row.line})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <p className="font-bold text-ink">Kolory punktualności</p>
        <ul className="space-y-0.5">
          {PUNCTUALITY_LEGEND.map(({ tone, style }) => (
            <li key={tone} className="flex items-center gap-1">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: style.bg }}
              />
              {style.label}
            </li>
          ))}
          <li className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ boxShadow: "inset 0 0 0 1px #94a3b8" }}
            />
            Brak prognozy GPS (czas z rozkładu)
          </li>
        </ul>
      </div>
      <p className="text-mute">
        Kurs bez litery = kurs podstawowy. Litery wg oficjalnej legendy linii.
        Czas polski.
      </p>
    </div>
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
  const [tab, setTab] = useState<"next" | "day" | "upcoming">("day");
  const [legendOpen, setLegendOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [internalFilter, setInternalFilter] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const upcomingOnly = tab === "upcoming";
  const loadedKey = useRef("");
  const activeFilter = onLineFilterChange
    ? (lineFilter ?? null)
    : internalFilter;
  const setFilter = onLineFilterChange ?? setInternalFilter;

  useEffect(() => {
    setInternalFilter(null);
    setTab("day");
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
    setTab("day");
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
                setTab("day");
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
          aria-pressed={tab === "next"}
          data-testid="tab-next"
          onClick={() => {
            setDate(today());
            setTab("next");
          }}
          className={cn(
            "border-b-2 pb-1",
            tab === "next"
              ? "border-brand text-brand-ink"
              : "border-transparent text-mute",
          )}
        >
          Najbliższe
        </button>
        <button
          type="button"
          aria-pressed={tab === "day"}
          onClick={() => setTab("day")}
          className={cn(
            "border-b-2 pb-1",
            tab === "day"
              ? "border-brand text-brand-ink"
              : "border-transparent text-mute",
          )}
        >
          Cały dzień
        </button>
        <button
          type="button"
          aria-pressed={tab === "upcoming"}
          onClick={() => {
            setDate(today());
            setTab("upcoming");
          }}
          className={cn(
            "border-b-2 pb-1",
            tab === "upcoming"
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
      {!shownError && shown.length > 0 && (
        <div className="scroll-area mt-1 max-h-[400px] overflow-y-auto pr-1">
          {tab === "next" ? (
            <NextDeparturesBoard
              groups={shown}
              now={now}
              onOpenKursowka={onOpenKursowka}
              onPreviewCourse={onPreviewCourse}
            />
          ) : (
            shown.map((group) => (
              <LineDepartures
                key={`${stop.id}|${date}|${group.line}`}
                group={group}
                now={now}
                upcomingOnly={upcomingOnly}
                onOpenKursowka={onOpenKursowka}
                onPreviewCourse={onPreviewCourse}
              />
            ))
          )}
        </div>
      )}
      {shownMatched && (
        <div className="mt-1.5">
          <button
            type="button"
            aria-expanded={legendOpen}
            data-testid="toggle-legend"
            onClick={() => setLegendOpen((open) => !open)}
            className="flex items-center gap-1 text-[8px] font-bold text-brand-ink"
          >
            <Info className="h-2.5 w-2.5" />
            Legenda oznaczeń
            <ChevronDown
              className={cn(
                "h-2.5 w-2.5 transition-transform",
                legendOpen && "rotate-180",
              )}
            />
          </button>
          {legendOpen && <StopBoardLegend groups={shown} />}
          <p className="mt-0.5 text-[7px] leading-snug text-mute">
            Kliknij godzinę po szczegóły
            {onPreviewCourse && source !== "fallback"
              ? " i przebieg kursu na mapie"
              : ""}
            . Czas polski.
          </p>
        </div>
      )}
    </section>
  );
}
