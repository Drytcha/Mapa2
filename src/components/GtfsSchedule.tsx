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
import type { BusStop, StopDepartureItem } from "@/lib/types";
import { cn } from "@/utils/cn";
import { describeDelay, formatDelay, formatVehicleNumber } from "@/lib/delay";
import { getStopDepartures } from "@/lib/engine/gtfsStore";
import {
  groupDeparturesByLine,
  type DepartureLineGroup,
} from "@/lib/departureGroups";

export type { StopDepartureItem };
const ZONE = "Europe/Warsaw";
const today = () => DateTime.now().setZone(ZONE).toISODate()!;
const clock = (ms: number) =>
  DateTime.fromMillis(ms, { zone: ZONE }).toFormat("HH:mm");

interface Props {
  stop: BusStop;
  onAddDeparture?: (stop: {
    id: string;
    name: string;
    lat: number;
    lon: number;
  }) => void;
  onOpenKursowka?: (id: string, code: string) => void;
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
}: {
  group: DepartureLineGroup;
  now: number;
  upcomingOnly: boolean;
  onOpenKursowka?: Props["onOpenKursowka"];
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
      className="border-b border-line/70 py-2.5 last:border-b-0"
      aria-label={`Odjazdy linii ${group.line}`}
    >
      <h5 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-extrabold text-ink">
        Linia{" "}
        <span
          className="metric min-w-5 rounded px-1 py-0.5 text-center"
          style={{ background: group.color, color: group.textColor }}
        >
          {group.line}
        </span>
        <span className="ml-auto text-[8px] font-medium text-mute">
          {entries.length} odjazdów
        </span>
      </h5>
      {entries.length ? (
        <div
          className="grid grid-cols-[repeat(auto-fill,minmax(51px,1fr))] gap-x-1 gap-y-0.5"
          aria-label={`Godziny odjazdów linii ${group.line}`}
        >
          {entries.map(({ departure: d, direction }) => {
            const key = `${d.tripId}|${d.atMs}`;
            const past =
              d.atMs + (d.isRealtime ? d.delaySeconds * 1000 : 0) < now;
            const label = `Linia ${group.line}, ${d.clock}${direction.suffix}, kierunek ${direction.label}${d.isRealtime ? `, GPS ${describeDelay(d.delaySeconds)}` : ""}`;
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
                  "relative min-h-7 rounded px-1 py-1 text-center font-mono text-[11px] font-semibold tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-brand",
                  key === selected
                    ? "bg-brand text-on-brand"
                    : "hover:bg-brand-soft hover:text-brand-ink",
                  key !== selected && (past ? "text-mute" : "text-ink"),
                )}
              >
                {d.clock}
                <span className="text-[9px]">{direction.suffix}</span>
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
        <p className="py-1 text-[10px] text-mute">
          Brak kolejnych odjazdów tego dnia.
        </p>
      )}
      <ul
        className="mt-1.5 space-y-0.5 text-[9px] leading-snug text-ink-soft"
        aria-label={`Oznaczenia kierunków linii ${group.line}`}
      >
        {group.directions.map((direction) => (
          <li key={direction.key}>
            {direction.main ? (
              <>
                <span className="text-mute">
                  {group.directions.length > 1 ? "Bez oznaczenia → " : "Kierunek: "}
                </span>
                <span className="font-semibold text-ink">{direction.label}</span>
              </>
            ) : (
              <>
                <b className="font-mono text-brand-ink">{direction.suffix}</b>
                {" → "}
                {direction.label}
              </>
            )}
          </li>
        ))}
      </ul>
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
          {detail.departure.vehicleId && (
            <p className="text-ink-soft">
              Wóz {formatVehicleNumber(detail.departure.vehicleId)}{" "}
              {detail.departure.operatorName}
            </p>
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
  className,
  lineFilter,
  onLineFilterChange,
}: Props) {
  const [matched, setMatched] = useState<MatchedStop | null>(null);
  const [departures, setDepartures] = useState<StopDepartureItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
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
    const start = DateTime.fromISO(date, { zone: ZONE }).startOf("day");
    if (!start.isValid) return;
    const key = `${stop.id}|${date}`;
    if (loadedKey.current !== key) {
      setDepartures([]);
      setMatched(null);
    }
    setLoading(true);
    setError("");
    void getStopDepartures({
      lat: stop.lat,
      lon: stop.lon,
      name: stop.name,
      stopId: stop.gtfsId,
      fromMs: start.toMillis(),
      toMs: start.plus({ days: 1 }).toMillis(),
    })
      .then((result) => {
        if (cancelled) return;
        loadedKey.current = key;
        setMatched(result.matched);
        setDepartures(result.departures);
        setNow(Date.now());
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(
            cause instanceof Error
              ? cause.message
              : "Nie udało się odczytać rozkładu.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stop.id, stop.lat, stop.lon, stop.name, stop.gtfsId, date, retry]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        setNow(Date.now());
        if (date === today()) setRetry((value) => value + 1);
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [date]);

  const groups = useMemo(() => groupDeparturesByLine(departures), [departures]);
  const shown = activeFilter
    ? groups.filter((g) => g.line === activeFilter)
    : groups;
  const changeDay = (days: number) => {
    setDate(DateTime.fromISO(date, { zone: ZONE }).plus({ days }).toISODate()!);
    setUpcomingOnly(false);
  };

  return (
    <section
      className={cn("mt-2 border-t border-line pt-2", className)}
      data-testid="gtfs-schedule"
      aria-busy={loading}
    >
      <div className="flex items-center justify-between gap-1">
        <h4 className="flex items-center gap-1.5 text-[11px] font-extrabold text-ink">
          <CalendarClock className="h-3.5 w-3.5 text-brand-ink" />
          Odjazdy według linii
        </h4>
        <button
          type="button"
          onClick={() => setRetry((v) => v + 1)}
          aria-label="Odśwież rozkład"
          className="grid h-7 w-7 place-items-center rounded text-mute hover:bg-raised hover:text-ink"
        >
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between gap-1">
        <div className="flex min-w-0 items-center">
          <button
            type="button"
            onClick={() => changeDay(-1)}
            aria-label="Poprzedni dzień"
            className="grid h-7 w-6 place-items-center rounded hover:bg-raised"
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
            className="h-7 min-w-0 rounded border border-line bg-surface px-1 text-[10px] text-ink"
          />
          <button
            type="button"
            onClick={() => changeDay(1)}
            aria-label="Następny dzień"
            className="grid h-7 w-6 place-items-center rounded hover:bg-raised"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
        <select
          aria-label="Filtr linii"
          value={activeFilter ?? ""}
          onChange={(e) => setFilter(e.target.value || null)}
          className="h-7 min-w-0 max-w-[95px] rounded border border-line bg-surface px-1 text-[9px] text-ink"
        >
          <option value="">Wszystkie linie</option>
          {[...new Set([...stop.lines, ...groups.map((g) => g.line)])]
            .sort((a, b) => a.localeCompare(b, "pl", { numeric: true }))
            .map((line) => (
              <option key={line} value={line}>
                Linia {line}
              </option>
            ))}
        </select>
      </div>
      <div className="mt-2 flex items-center gap-3 border-b border-line text-[9px] font-bold">
        <button
          type="button"
          aria-pressed={!upcomingOnly}
          onClick={() => setUpcomingOnly(false)}
          className={cn(
            "border-b-2 pb-1.5",
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
            "border-b-2 pb-1.5",
            upcomingOnly
              ? "border-brand text-brand-ink"
              : "border-transparent text-mute",
          )}
        >
          Od teraz
        </button>
        {onAddDeparture && matched && (
          <button
            type="button"
            onClick={() => onAddDeparture(matched)}
            aria-label="Ustaw przystanek jako metę"
            className="ml-auto pb-1.5 text-brand-ink"
          >
            <MapPinned className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {loading && !departures.length && (
        <p
          role="status"
          className="flex items-center gap-2 py-4 text-[11px] text-mute"
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          Wczytywanie rozkładu...
        </p>
      )}
      {error && (
        <div role="alert" className="py-3 text-[10px] text-warning">
          {error}
          <button
            type="button"
            className="ml-1 font-bold underline"
            onClick={() => setRetry((v) => v + 1)}
          >
            Spróbuj ponownie
          </button>
        </div>
      )}
      {!loading && !error && !matched && (
        <p className="py-3 text-[10px] text-mute">
          Brak tego przystanku w rozkładzie GTFS.
        </p>
      )}
      {!loading && !error && matched && !shown.length && (
        <p className="py-3 text-[10px] text-mute">
          Brak odjazdów{activeFilter ? ` linii ${activeFilter}` : ""} tego dnia.
        </p>
      )}
      {!error && (
        <div className="scroll-area max-h-[340px] overflow-y-auto pr-1">
          {shown.map((group) => (
            <LineDepartures
              key={`${stop.id}|${date}|${group.line}`}
              group={group}
              now={now}
              upcomingOnly={upcomingOnly}
              onOpenKursowka={onOpenKursowka}
            />
          ))}
        </div>
      )}
      {matched && (
        <p className="mt-2 text-[8px] leading-relaxed text-mute">
          Godziny bez litery jadą w głównym kierunku linii. Litera oznacza
          inny kierunek (legenda pod linią); to oznaczenia aplikacji, nie
          oficjalne symbole kursów. Kliknij godzinę po szczegóły i prognozę
          GPS. Godziny rozkładowe, czas polski.
        </p>
      )}
    </section>
  );
}
