import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BusFront, CalendarClock, Info, Loader2, MapPinned, RefreshCw, X } from "lucide-react";
import type { BusStop, StopDepartureItem } from "@/lib/types";
import { cn } from "@/utils/cn";
import {
  DELAY_STYLES,
  delayTone,
  describeDelay,
  formatDelay,
  formatVehicleNumber,
} from "@/lib/delay";
import { getStopDepartures } from "@/lib/engine/gtfsStore";
import { OPERATOR_STYLES } from "@/lib/transit";

export type { StopDepartureItem };

interface MatchedStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  distanceMeters: number;
}

interface Props {
  stop: BusStop;
  onAddDeparture?: (stop: { id: string; name: string; lat: number; lon: number }) => void;
  onOpenKursowka?: (id: string, code: string) => void;
  className?: string;
  /** Controlled line filter (optional — the card's line chips can drive it). */
  lineFilter?: string | null;
  onLineFilterChange?: (line: string | null) => void;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [from, setFrom] = useState(() => new Date());
  const [page, setPage] = useState(8);
  const [retry, setRetry] = useState(0);
  const [internalFilter, setInternalFilter] = useState<string | null>(null);
  const seqRef = useRef(0);

  const activeFilter = onLineFilterChange ? (lineFilter ?? null) : internalFilter;
  const setFilter = (line: string | null) => {
    setPage(8);
    if (onLineFilterChange) onLineFilterChange(line);
    else setInternalFilter(line);
  };

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError("");
    try {
      // Fetch the whole upcoming window (3 days) once — line filtering is client-side,
      // so selecting a line reveals all of its departures without re-fetching.
      const json = await getStopDepartures({
        lat: stop.lat,
        lon: stop.lon,
        name: stop.name,
        stopId: stop.gtfsId,
        fromMs: from.getTime(),
        limit: 500,
      });
      if (seq !== seqRef.current) return;
      setMatched(json.matched);
      setDepartures(json.departures ?? []);
    } catch (cause) {
      if (seq === seqRef.current) {
        setError(cause instanceof Error ? cause.message : "Nie udało się odczytać rozkładu.");
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [stop.lat, stop.lon, stop.name, stop.gtfsId, from]);

  useEffect(() => {
    setDepartures([]);
    setMatched(null);
    setInternalFilter(null);
    setPage(8);
    void load();
    return () => {
      seqRef.current += 1;
    };
  }, [load, retry, stop.id]);

  const availableLines = useMemo(() => {
    const set = new Set<string>(stop.lines);
    for (const d of departures) if (d.routeShort) set.add(d.routeShort);
    return [...set].sort((a, b) => a.localeCompare(b, "pl", { numeric: true }));
  }, [stop.lines, departures]);

  const colorByLine = useMemo(() => {
    const map = new Map<string, { bg: string; fg: string }>();
    for (const d of departures) {
      if (d.routeShort) map.set(d.routeShort, { bg: d.routeColor, fg: d.routeTextColor });
    }
    return map;
  }, [departures]);

  const filteredDepartures = activeFilter
    ? departures.filter((d) => d.routeShort === activeFilter)
    : departures;
  const shownDepartures = activeFilter ? filteredDepartures : filteredDepartures.slice(0, page);

  const fromClock = new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    hour: "2-digit",
    minute: "2-digit",
  }).format(from);

  return (
    <section
      className={cn("mt-2 overflow-hidden rounded-xl border border-line bg-raised", className)}
      data-testid="gtfs-schedule"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h4 className="flex items-center gap-1.5 text-xs font-bold text-ink">
          <CalendarClock className="h-3.5 w-3.5 text-brand-ink" />
          Rozkład jazdy · kursówki
        </h4>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setFrom(new Date())}
            aria-label="Pokaż najbliższe kursy"
            className="p-1.5 text-mute hover:text-ink"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={() => setFrom(new Date(from.getTime() + 30 * 60000))}
            className="rounded px-1.5 py-1 text-[10px] font-bold text-brand-ink"
          >
            +30 min
          </button>
        </div>
      </div>
      <div className="p-3">
        {loading && !departures.length && (
          <p role="status" className="flex items-center gap-2 py-4 text-xs text-mute">
            <Loader2 className="h-4 w-4 animate-spin" />
            Wczytywanie rozkładu…
          </p>
        )}
        {error && (
          <div role="alert" className="rounded-lg bg-warning-soft p-2 text-xs text-warning">
            {error}
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
              className="mt-2 block font-bold underline"
            >
              Spróbuj ponownie
            </button>
          </div>
        )}
        {!loading && !error && !matched && (
          <p className="py-3 text-xs leading-relaxed text-mute">
            Brak odpowiednika tego przystanku w rozkładzie GTFS Wałbrzych.
          </p>
        )}
        {!error && matched && (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words text-xs font-bold text-ink">{matched.name}</p>
                <p className="mt-0.5 text-[10px] text-mute">Od {fromClock} · czas polski</p>
              </div>
              {onAddDeparture && (
                <button
                  type="button"
                  onClick={() => onAddDeparture(matched)}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1.5 text-[10px] font-bold text-brand-ink"
                >
                  <MapPinned className="h-3 w-3" />
                  Ustaw jako metę
                </button>
              )}
            </div>

            {availableLines.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                <span className="text-[7.5px] font-extrabold uppercase tracking-[0.12em] text-mute">
                  Linia:
                </span>
                <button
                  type="button"
                  onClick={() => setFilter(null)}
                  className={cn(
                    "metric rounded-md border px-1.5 py-[2px] text-[9px] font-bold transition-colors",
                    !activeFilter
                      ? "border-brand bg-brand text-on-brand"
                      : "border-line bg-raised text-ink-soft hover:border-line-strong"
                  )}
                >
                  Wszystkie
                </button>
                {availableLines.map((line) => {
                  const active = activeFilter === line;
                  const color = colorByLine.get(line);
                  return (
                    <button
                      key={line}
                      type="button"
                      onClick={() => setFilter(active ? null : line)}
                      title={
                        active ? "Pokaż wszystkie linie" : `Pokaż wszystkie odjazdy linii ${line}`
                      }
                      className="metric rounded-md border px-1.5 py-[2px] text-[9px] font-bold transition-colors"
                      style={
                        active
                          ? color
                            ? { background: color.bg, color: color.fg, borderColor: color.bg }
                            : { background: "#0d4f3b", color: "#ffffff", borderColor: "#0d4f3b" }
                          : undefined
                      }
                    >
                      {line}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[8px] font-extrabold uppercase tracking-[0.12em] text-mute">
                {activeFilter
                  ? `Odjazdy linii ${activeFilter} (${filteredDepartures.length})`
                  : `Najbliższe odjazdy (${filteredDepartures.length})`}
              </span>
              {activeFilter && (
                <button
                  type="button"
                  onClick={() => setFilter(null)}
                  className="flex items-center gap-1 text-[8px] font-bold text-brand-ink hover:underline"
                >
                  <X className="h-2.5 w-2.5" /> Pokaż wszystkie linie
                </button>
              )}
            </div>

            {filteredDepartures.length === 0 ? (
              <p className="py-4 text-xs text-mute">
                {activeFilter
                  ? `Brak odjazdów linii ${activeFilter} z tego przystanku w tym oknie czasowym.`
                  : "Brak kolejnych kursów w tym oknie czasowym."}
              </p>
            ) : (
              <ul
                className="scroll-area mt-1.5 max-h-[240px] space-y-1.5 overflow-y-auto pr-1"
                aria-label="Najbliższe odjazdy"
              >
                {shownDepartures.map((departure) => {
                  const style = DELAY_STYLES[delayTone(departure.delaySeconds)];
                  const company = departure.operatorKey
                    ? OPERATOR_STYLES[departure.operatorKey]
                    : null;
                  const lineActive = activeFilter === departure.routeShort;
                  return (
                    <li
                      key={`${departure.tripId}-${departure.atMs}`}
                      className="min-w-0 rounded-lg border border-line bg-surface p-2.5"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="metric text-sm font-bold text-brand-ink">
                          {departure.clock}
                        </span>
                        <button
                          type="button"
                          onClick={() => setFilter(lineActive ? null : departure.routeShort)}
                          title={
                            lineActive
                              ? "Pokaż wszystkie linie"
                              : `Pokaż wszystkie odjazdy linii ${departure.routeShort}`
                          }
                          className="metric rounded px-1.5 py-0.5 text-[10px] font-bold transition-opacity hover:opacity-75"
                          style={{
                            background: departure.routeColor,
                            color: departure.routeTextColor,
                            outline: lineActive ? `2px solid ${departure.routeColor}` : "none",
                            outlineOffset: 1,
                          }}
                        >
                          Linia {departure.routeShort}
                        </button>
                        {new Date(departure.atMs).toDateString() !== new Date().toDateString() && (
                          <span className="text-[9px] text-mute">{departure.dateLabel}</span>
                        )}
                        {departure.isRealtime && (
                          <span
                            className="metric ml-auto rounded px-1.5 py-1 text-[10px] font-bold"
                            style={{ background: style.bg, color: style.fg }}
                            title={describeDelay(departure.delaySeconds)}
                          >
                            {formatDelay(departure.delaySeconds)}{" "}
                            <span className="font-sans text-[9px]">
                              {departure.delaySeconds > 0
                                ? "opóźn."
                                : departure.delaySeconds < 0
                                  ? "przysp."
                                  : "planowo"}
                            </span>
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {departure.kursowka && (
                          <button
                            type="button"
                            onClick={() =>
                              onOpenKursowka?.(departure.kursowkaId, departure.kursowka)
                            }
                            className="flex min-w-0 items-center gap-1 rounded border border-brand/30 bg-brand-soft px-1.5 py-1 text-[10px] font-bold text-brand-ink"
                          >
                            <BusFront className="h-3 w-3 shrink-0" />
                            <span className="metric break-all">Kursówka: {departure.kursowka}</span>
                          </button>
                        )}
                        {departure.brigadeSource === "estimated" && (
                          <span
                            className="text-[9px] text-mute"
                            title="Przypisanie kursu do kursówki jest szacowane"
                          >
                            szac.
                          </span>
                        )}
                        {company && (
                          <span
                            className="rounded px-1.5 py-0.5 text-[9px] font-extrabold"
                            style={{ background: company.bg, color: company.fg }}
                          >
                            {company.label}
                          </span>
                        )}
                        {departure.vehicleId && (
                          <span className="metric ml-auto text-[10px] font-bold text-ink">
                            {formatVehicleNumber(departure.vehicleId)}
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 break-words text-[10px] leading-relaxed text-ink-soft">
                        <span className="text-mute">Końcowy:</span> {departure.finalStop}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
            {!activeFilter && filteredDepartures.length > page && (
              <button
                type="button"
                onClick={() => setPage((value) => value + 12)}
                className="mt-2 w-full rounded-md bg-soft py-2 text-[10px] font-bold text-brand-ink"
              >
                Pokaż więcej kursów ({filteredDepartures.length - page} dalej)
              </button>
            )}
            <p className="mt-2 flex items-start gap-1 text-[9px] leading-relaxed text-mute">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              − opóźnienie · + przyspieszenie. Kliknij linię, aby zobaczyć wszystkie odjazdy tego
              kierunku; kliknij kursówkę, aby zobaczyć jej kursy lub znaleźć autobus.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
