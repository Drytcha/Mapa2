import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BusFront,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Info,
  Loader2,
  Navigation,
  Radio,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { DateTime } from "luxon";
import {
  brigadeMatchesVehicle,
  BRIGADE_ZONE,
  formatBrigadeClock,
  formatBrigadeDate,
  getActiveDates,
  loadBrigadeTrips,
  loadBrigades,
  shiftDateId,
  resolveBrigadeReference,
  type BrigadeItem,
  type BrigadesResult,
  type BrigadeTripView,
} from "@/lib/engine/brigades";
import type { GtfsLineItem } from "@/lib/engine/gtfsStore";
import type { LiveBusVehicle, Waypoint } from "@/lib/types";
import { cn } from "@/utils/cn";
import LineRestrictions from "./LineRestrictions";
import {
  formatKilometres,
  formatServiceHours,
  isTechnicalLine,
  summariseBrigade,
  summariseTimeSpans,
  type BrigadeMetrics,
} from "@/lib/brigadeMetrics";

interface Props {
  routes: GtfsLineItem[];
  liveVehicles: LiveBusVehicle[];
  onSelectBus: (bus: LiveBusVehicle) => void;
  onLoadTripToPlanner: (payload: {
    line: string;
    duty: string;
    waypoints: Waypoint[];
    departureTime?: string;
    headsign?: string;
  }) => void;
  initialKursowkaId?: string | null;
  initialKursowkaCode?: string | null;
  canLoadToPlanner?: boolean;
  /** Wyjaśnienia techniczne (np. 19 → 9/01) tylko dla planisty. */
  showTechnicalNotes?: boolean;
}

const DEFAULT_LINE = "2";

function parseHash(): { lineId: string; dateId: string } | null {
  if (typeof window === "undefined") return null;
  const match = window.location.hash.match(
    /#\/walbrzych\/brigades\/([^?]+)(?:\?date=(\d{8}))?/,
  );
  if (!match) return null;
  return {
    lineId: decodeURIComponent(match[1]),
    dateId: match[2] || getActiveDates()[1].id,
  };
}

export default function BrigadesPanel({
  routes,
  liveVehicles,
  onSelectBus,
  onLoadTripToPlanner,
  initialKursowkaId,
  initialKursowkaCode,
  canLoadToPlanner = true,
  showTechnicalNotes = false,
}: Props) {
  const initial = useMemo(() => parseHash(), []);
  const requested = useMemo(
    () => resolveBrigadeReference(initialKursowkaId, initialKursowkaCode),
    [initialKursowkaId, initialKursowkaCode],
  );
  const [lineId, setLineId] = useState(
    initial?.lineId ?? requested.lineId ?? DEFAULT_LINE,
  );
  const [dateId, setDateId] = useState(
    initial?.dateId ?? getActiveDates()[1].id,
  );
  const [pendingBrigade, setPendingBrigade] = useState<string | null>(
    requested.brigadeNumber ?? null,
  );
  const [missingBrigade, setMissingBrigade] = useState<string | null>(null);
  const [result, setResult] = useState<BrigadesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BrigadeTripView[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [listLimit, setListLimit] = useState(80);
  const [reload, setReload] = useState(0);
  const [tripSummaries, setTripSummaries] = useState<
    Record<string, BrigadeMetrics>
  >({});
  const originalHash = useRef<string | null>(null);

  useEffect(() => {
    originalHash.current = window.location.hash || "";
    return () => {
      const restore = originalHash.current;
      if (restore === null) return;
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${restore}`,
      );
    };
  }, []);

  useEffect(() => {
    // Keep the current line/date shareable: #/walbrzych/brigades/2?date=YYYYMMDD
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}#/walbrzych/brigades/${encodeURIComponent(lineId)}?date=${dateId}`,
    );
  }, [lineId, dateId, initial]);

  useEffect(() => {
    if (!routes.length || lineId === "all") return;
    if (
      !routes.some(
        (route) => route.shortName.toUpperCase() === lineId.toUpperCase(),
      )
    ) {
      setLineId(routes[0].shortName.toUpperCase());
    }
  }, [routes, lineId]);

  useEffect(() => {
    if (!routes.length) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setSelectedBlockId(null);
    setDetail(null);
    setTripSummaries({});
    setMobileView("list");
    setListLimit(80);
    loadBrigades(routes, lineId, dateId)
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Nie udało się wczytać katalogu brygad.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [routes, lineId, dateId, reload]);

  useEffect(() => {
    const item = result?.items.find(
      (entry) => entry.blockId === selectedBlockId,
    );
    if (!item) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError("");
    setDetail(null);
    loadBrigadeTrips(item)
      .then((trips) => {
        if (!cancelled) setDetail(trips);
      })
      .catch((cause) => {
        if (!cancelled) {
          setDetailError(
            cause instanceof Error
              ? cause.message
              : "Nie udało się wczytać kursów brygady.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [result, selectedBlockId]);

  useEffect(() => {
    if (!selectedBlockId || !detail?.length) return;
    const summary = summariseBrigade(detail);
    setTripSummaries((current) =>
      current[selectedBlockId] &&
      current[selectedBlockId].totalMeters === summary.totalMeters &&
      current[selectedBlockId].durationMinutes === summary.durationMinutes
        ? current
        : { ...current, [selectedBlockId]: summary },
    );
  }, [selectedBlockId, detail]);

  const routeByShort = useMemo(
    () =>
      new Map(
        routes.map((route) => [route.shortName.toUpperCase(), route] as const),
      ),
    [routes],
  );
  const dates = useMemo(() => getActiveDates(), [reload]);

  // Tylko brygada potwierdzona w rozkładzie może zostać przypisana do wozu.
  // Surowy sygnał GPS nie wystarcza — inaczej linia 8 dostawała „WY/04”.
  const vehicleFor = (item: BrigadeItem) =>
    liveVehicles.find(
      (bus) =>
        bus.dutyStatus === "confirmed" &&
        Boolean(bus.dutyCode) &&
        brigadeMatchesVehicle(item.number, bus.dutyCode ?? ""),
    );

  // A kursówka link opens its brigade straight away; if it belongs to another line
  // we first switch lines and preselect again when the new catalogue arrives.
  useEffect(() => {
    if (!pendingBrigade || !result) return;
    const wanted = pendingBrigade.toUpperCase();
    const direct = result.items.find(
      (item) => item.number.toUpperCase() === wanted,
    );
    if (direct) {
      setSelectedBlockId(direct.blockId);
      setMobileView("detail");
      setPendingBrigade(null);
      return;
    }
    const [linePart, numberPart] = wanted.split("-");
    if (linePart && numberPart && lineId.toUpperCase() !== linePart) {
      const hasLine = routes.some(
        (route) => route.shortName.toUpperCase() === linePart,
      );
      if (hasLine) {
        setLineId(linePart);
        return;
      }
    }
    setMissingBrigade(pendingBrigade);
    setPendingBrigade(null);
  }, [pendingBrigade, result, routes, lineId]);

  const filtered = useMemo(() => {
    const items = result?.items ?? [];
    const term = query.trim().toUpperCase().replace(/\//g, "-");
    if (!term) return items;
    return items.filter(
      (item) =>
        item.number.toUpperCase().includes(term) ||
        item.lineIds.some((line) => line.includes(term)),
    );
  }, [result, query]);

  const shown = useMemo(
    () => filtered.slice(0, listLimit),
    [filtered, listLimit],
  );
  const selected =
    result?.items.find((entry) => entry.blockId === selectedBlockId) ?? null;
  const totalTrips = useMemo(
    () => (result?.items ?? []).reduce((sum, item) => sum + item.tripCount, 0),
    [result],
  );
  const gpsCount = useMemo(
    () =>
      (result?.items ?? []).filter((item) => Boolean(vehicleFor(item))).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, liveVehicles],
  );

  // Unconfirmed group can contain hundreds of trips — keep the detail pane light.
  const shownDetail = detail ? detail.slice(0, 120) : [];
  const selectedMetrics = useMemo(
    () => summariseBrigade(detail?.length ? detail : (selected?.trips ?? [])),
    [selected, detail],
  );

  /** Rozkładowy kod brygady w formie z ukośnikiem, np. 9-01 → 9/01. */
  const displayDuty = (value: string) => value.replace(/-([0-9]+)$/, "/$1");

  const badgeStyle = (item: BrigadeItem) => {
    const route = routeByShort.get(
      item.primaryLine ?? item.lineIds[0] ?? lineId.toUpperCase(),
    );
    return {
      backgroundColor: route?.color ?? "#0d4f3b",
      color: route?.textColor ?? "#ffffff",
    };
  };

  const lineBadge = (line: string, small = false) => {
    const route = routeByShort.get(line.toUpperCase());
    return (
      <span
        className={cn(
          "metric inline-flex shrink-0 items-center justify-center rounded font-extrabold",
          small
            ? "h-5 min-w-[22px] px-1 text-[9px]"
            : "h-6 min-w-[26px] px-1 text-[10px]",
        )}
        style={{
          backgroundColor: route?.color ?? "#0d4f3b",
          color: route?.textColor ?? "#ffffff",
        }}
      >
        {line}
      </span>
    );
  };

  const loadToPlanner = (item: BrigadeItem) => {
    if (!detail?.length) return;
    const points: Waypoint[] = [];
    const seen = new Set<string>();
    for (const trip of detail) {
      for (const stop of [trip.firstStop, trip.lastStop]) {
        if (stop.lat === undefined || stop.lon === undefined) continue;
        const key = `${stop.lat.toFixed(6)},${stop.lon.toFixed(6)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        points.push({
          id: `brigade-${item.blockId}-${points.length}`,
          label: `${stop.name}, Polska`,
          short: stop.name,
          lat: stop.lat,
          lon: stop.lon,
        });
        if (points.length >= 50) break;
      }
      if (points.length >= 50) break;
    }
    if (points.length < 2) {
      setDetailError("Brak współrzędnych przystanków dla tej brygady.");
      return;
    }
    const firstClock = DateTime.fromMillis(detail[0].startMs, {
      zone: BRIGADE_ZONE,
    }).toFormat("HH:mm");
    onLoadTripToPlanner({
      line: item.primaryLine || item.lineIds[0] || lineId,
      duty: item.unassigned ? "" : displayDuty(item.number),
      waypoints: points,
      departureTime: firstClock,
      headsign: detail[0].destination,
    });
  };

  const minutesLabel = (minutes: number) =>
    minutes <= 0 ? "0 min" : formatServiceHours(minutes);
  const shortHours = (minutes: number) => {
    if (minutes <= 0) return "0m";
    const hours = Math.floor(minutes / 60);
    const rest = Math.round(minutes % 60);
    return hours ? `${hours}h ${String(rest).padStart(2, "0")}m` : `${rest}m`;
  };
  const listColumns = showTechnicalNotes
    ? "grid-cols-[50px_30px_minmax(0,1fr)_58px_46px]"
    : "grid-cols-[50px_30px_minmax(0,1fr)_58px]";
  // Telefon: trasa w drugiej linii wiersza; od sm — pełna tabela.
  const tripColumns = showTechnicalNotes
    ? "grid-cols-[30px_76px_1fr_1fr_1fr] sm:grid-cols-[30px_76px_minmax(0,1fr)_48px_48px_42px]"
    : "grid-cols-[30px_76px_1fr_1fr] sm:grid-cols-[30px_76px_minmax(0,1fr)_48px_42px]";
  const confirmedCount =
    result?.items.filter((item) => !item.unassigned).length ?? 0;
  const feedRange = (value: number) =>
    String(value).replace(/^(\d{4})(\d{2})(\d{2})$/, "$3.$2.$1");

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-1.5">
      {/* ── Pasek narzędzi: data, wyszukiwarka, źródło ───────────────── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex h-7 items-center rounded-md border border-line bg-raised p-0.5">
          <button
            type="button"
            onClick={() => setDateId(shiftDateId(dateId, -1))}
            aria-label="Poprzedni dzień"
            className="grid h-6 w-5 place-items-center rounded text-mute hover:bg-surface hover:text-ink"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          {dates.map((date) => (
            <button
              key={date.id}
              type="button"
              onClick={() => setDateId(date.id)}
              aria-pressed={date.id === dateId}
              title={date.shortDate}
              className={cn(
                "h-6 rounded px-2 text-[10px] font-bold transition-colors",
                date.id === dateId
                  ? "bg-brand text-on-brand shadow-sm"
                  : "text-mute hover:bg-surface hover:text-ink",
              )}
            >
              {date.label}
              <span className="ml-1 hidden text-[8.5px] font-semibold opacity-80 sm:inline">
                {date.shortDate}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setDateId(shiftDateId(dateId, 1))}
            aria-label="Następny dzień"
            className="grid h-6 w-5 place-items-center rounded text-mute hover:bg-surface hover:text-ink"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
        <label className="flex h-7 items-center gap-1 rounded-md border border-line bg-raised px-1.5">
          <CalendarDays className="h-3 w-3 shrink-0 text-mute" />
          <input
            type="date"
            aria-label="Wybierz datę rozkładu"
            min={
              result?.feedFrom
                ? DateTime.fromFormat(
                    String(result.feedFrom),
                    "yyyyLLdd",
                  ).toFormat("yyyy-MM-dd")
                : undefined
            }
            max={
              result?.feedTo
                ? DateTime.fromFormat(
                    String(result.feedTo),
                    "yyyyLLdd",
                  ).toFormat("yyyy-MM-dd")
                : undefined
            }
            value={DateTime.fromFormat(dateId, "yyyyLLdd")
              .setZone(BRIGADE_ZONE)
              .toFormat("yyyy-MM-dd")}
            onChange={(event) => {
              const parsed = DateTime.fromISO(event.target.value, {
                zone: BRIGADE_ZONE,
              });
              if (parsed.isValid) setDateId(parsed.toFormat("yyyyLLdd"));
            }}
            className="w-[104px] bg-transparent text-[10px] font-bold text-ink outline-none"
          />
        </label>
        <div className="flex h-7 min-w-[150px] flex-1 items-center gap-1.5 rounded-md border border-line bg-raised px-2 focus-within:border-brand/60">
          <Search className="h-3 w-3 shrink-0 text-mute" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setListLimit(80);
            }}
            placeholder="Brygada lub linia, np. 9/01"
            aria-label="Filtruj brygady"
            className="min-w-0 flex-1 bg-transparent text-[10px] font-semibold text-ink outline-none placeholder:font-medium placeholder:text-mute"
            autoComplete="off"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Wyczyść filtr brygad"
              className="grid h-5 w-5 place-items-center rounded text-mute hover:text-ink"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {result && (
          <span
            className="hidden h-7 items-center rounded-md border border-line bg-raised px-2 text-[8.5px] font-bold text-mute md:inline-flex"
            title={
              result.source === "live"
                ? "Numery brygad z rozkładu pracy operatora"
                : "Brygady odtworzone z rozkładu GTFS"
            }
          >
            {result.source === "live"
              ? "Rozkład operatora"
              : "Rekonstrukcja GTFS"}
          </span>
        )}
        <button
          type="button"
          onClick={() => setReload((value) => value + 1)}
          disabled={loading}
          aria-label="Odśwież brygady"
          title="Odśwież brygady"
          className="grid h-7 w-7 place-items-center rounded-md border border-line bg-raised text-mute transition-colors hover:text-brand-ink disabled:opacity-40"
        >
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
        </button>
      </div>

      {/* ── Linie ──────────────────────────────────────────────────── */}
      <div
        className="flex min-w-0 items-center gap-1 overflow-x-auto pb-0.5"
        aria-label="Wybierz linię"
      >
        <button
          type="button"
          aria-pressed={lineId === "all"}
          onClick={() => setLineId("all")}
          className={cn(
            "h-6 shrink-0 rounded-md border px-2 text-[9.5px] font-bold",
            lineId === "all"
              ? "border-brand bg-brand-soft text-brand-ink"
              : "border-line bg-raised text-ink-soft hover:text-ink",
          )}
        >
          Wszystkie
        </button>
        {routes.map((route) => {
          const key = route.shortName.toUpperCase();
          const active = lineId.toUpperCase() === key;
          return (
            <button
              key={route.id}
              type="button"
              aria-label={`Linia ${route.shortName}`}
              aria-pressed={active}
              onClick={() => setLineId(key)}
              className={cn(
                "metric grid h-6 min-w-7 shrink-0 place-items-center rounded-md px-1 text-[10px] font-extrabold transition",
                active
                  ? "ring-2 ring-brand ring-offset-1 ring-offset-surface"
                  : "opacity-75 hover:opacity-100",
              )}
              style={{ background: route.color, color: route.textColor }}
            >
              {route.shortName}
            </button>
          );
        })}
      </div>

      {/* ── Komunikaty (jednolinijkowe) ─────────────────────────────── */}
      {(missingBrigade ||
        result?.error ||
        (result?.notice && !result.error) ||
        error) && (
        <div className="space-y-1">
          {missingBrigade && (
            <p
              role="status"
              className="flex items-center gap-1.5 rounded-md bg-warning-soft px-2 py-1 text-[9px] leading-snug text-warning"
            >
              <Info className="h-3 w-3 shrink-0" />
              <span className="min-w-0 flex-1">
                Brygada {missingBrigade} nie występuje w rozkładzie na{" "}
                {formatBrigadeDate(dateId)}. Wybierz brygadę z listy albo zmień
                datę.
              </span>
              <button
                type="button"
                onClick={() => setMissingBrigade(null)}
                aria-label="Ukryj komunikat o brygadzie"
                className="shrink-0 font-bold underline"
              >
                Ukryj
              </button>
            </p>
          )}
          {result?.error && (
            <p
              role="status"
              className="flex items-center gap-1.5 rounded-md bg-warning-soft px-2 py-1 text-[9px] leading-snug text-warning"
            >
              <Info className="h-3 w-3 shrink-0" />
              {result.error}
            </p>
          )}
          {result?.notice && !result.error && (
            <p
              role="status"
              className="flex items-center gap-1.5 rounded-md bg-warning-soft px-2 py-1 text-[9px] leading-snug text-warning"
            >
              <Info className="h-3 w-3 shrink-0" />
              {result.notice}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="flex items-center gap-1.5 rounded-md bg-warning-soft px-2 py-1 text-[9px] text-warning"
            >
              <Info className="h-3 w-3 shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
              <button
                type="button"
                onClick={() => setReload((value) => value + 1)}
                className="shrink-0 font-bold underline"
              >
                Spróbuj ponownie
              </button>
            </p>
          )}
        </div>
      )}

      {/* ── Lista + szczegóły ──────────────────────────────────────── */}
      <div
        className="duty-browser-grid min-h-0 flex-1 gap-1.5"
        data-mobile-view={mobileView}
      >
        <section
          className="duty-list-pane flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface"
          aria-label="Lista brygad"
        >
          <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1">
            <h3 className="text-[10px] font-extrabold text-ink">
              {lineId === "all" ? "Wszystkie linie" : `Linia ${lineId}`}
            </h3>
            {result && !loading && (
              <span className="min-w-0 truncate text-[8.5px] font-semibold text-mute">
                {filtered.length} bryg. · {totalTrips} kursów
                {confirmedCount !== result.items.length &&
                  ` · ${confirmedCount} potw.`}
                {gpsCount > 0 && ` · ${gpsCount} GPS`}
              </span>
            )}
            {result && !result.error && (
              <details className="relative ml-auto">
                <summary
                  className="grid h-5 w-5 cursor-pointer list-none place-items-center rounded text-mute hover:bg-raised hover:text-brand-ink [&::-webkit-details-marker]:hidden"
                  aria-label="Skąd pochodzą numery brygad"
                  title="Skąd pochodzą numery brygad"
                >
                  <Info className="h-3 w-3" />
                </summary>
                <div className="absolute right-0 top-6 z-20 w-[280px] rounded-lg border border-line bg-surface p-2 text-[8.5px] leading-snug text-ink-soft shadow-[0_12px_32px_rgba(9,35,23,0.22)]">
                  <p>
                    Rozkład obowiązujący {formatBrigadeDate(dateId)} (
                    {feedRange(result.feedFrom)}–{feedRange(result.feedTo)}).
                    Numery brygad pochodzą z rozkładu pracy kierowców operatora
                    — aplikacja ich nie wymyśla.
                  </p>
                  {lineId !== "all" && (
                    <p className="mt-1">
                      Linia {lineId}: widoczne są wszystkie brygady z kursami na
                      tej linii, także o numerach innych linii.
                    </p>
                  )}
                  {showTechnicalNotes && (
                    <p className="mt-1 border-t border-line pt-1">
                      <b className="text-ink">
                        Brygada nie wynika z aktualnej linii.
                      </b>{" "}
                      Autobus na linii 19 może obsługiwać brygadę{" "}
                      <span className="metric font-bold">9/01</span>, a nie{" "}
                      <span className="metric line-through opacity-70">
                        19/01
                      </span>
                      . Prefiks <span className="metric">WY</span> nie jest
                      linią.
                    </p>
                  )}
                </div>
              </details>
            )}
          </div>

          <div
            className={cn(
              "grid shrink-0 items-center gap-1.5 border-b border-line bg-raised/60 px-2 py-0.5 text-[7px] font-extrabold uppercase tracking-[0.08em] text-mute",
              listColumns,
            )}
            aria-hidden="true"
          >
            <span>Bryg.</span>
            <span className="text-right">Kurs.</span>
            <span>Godziny</span>
            <span className="text-right">Czas</span>
            {showTechnicalNotes && <span className="text-right">Km</span>}
          </div>

          <div className="duty-list-scroll min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div
                className="space-y-1 p-2"
                role="status"
                aria-label="Wczytywanie brygad"
              >
                {[0, 1, 2, 3, 4, 5, 6].map((value) => (
                  <div key={value} className="stop-skeleton h-6 rounded" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <BusFront className="mx-auto mb-1.5 h-5 w-5 text-mute" />
                <p className="text-[10px] leading-relaxed text-mute">
                  {query
                    ? `Brak brygady pasującej do „${query}”.`
                    : result?.error
                      ? "Brak obowiązującego rozkładu dla tej daty."
                      : "Brak brygad dla tej linii w wybranym dniu."}
                </p>
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="mt-2 text-[10px] font-bold text-brand-ink underline"
                  >
                    Pokaż wszystkie
                  </button>
                )}
              </div>
            ) : (
              <>
                {shown.map((item) => {
                  const active = selectedBlockId === item.blockId;
                  const gps = vehicleFor(item);
                  const loadedMetrics =
                    tripSummaries[item.blockId] ??
                    (item.trips.length ? summariseBrigade(item.trips) : null);
                  const spanMetrics = summariseTimeSpans(item.times);
                  const duration =
                    loadedMetrics?.durationMinutes ??
                    spanMetrics.durationMinutes;
                  const lines = item.lineIds.join("/") || lineId;
                  return (
                    <button
                      key={item.blockId}
                      type="button"
                      data-testid="brigade-card"
                      aria-pressed={active}
                      title={`${item.unassigned ? "Kursy bez kursówki" : `Brygada ${displayDuty(item.number)}`} · linie ${lines}${gps ? ` · GPS wóz #${gps.vehicleId}` : ""}`}
                      onClick={() => {
                        setSelectedBlockId(item.blockId);
                        setMobileView("detail");
                      }}
                      className={cn(
                        "grid w-full min-w-0 items-center gap-1.5 border-b border-line/60 px-2 py-[3px] text-left text-[10px] transition-colors last:border-b-0",
                        listColumns,
                        active ? "bg-brand-soft/80" : "hover:bg-raised",
                      )}
                    >
                      <span className="relative inline-flex">
                        <span
                          className="metric grid h-5 w-full place-items-center rounded px-0.5 text-[10px] font-extrabold"
                          style={badgeStyle(item)}
                        >
                          {item.unassigned ? "?" : displayDuty(item.number)}
                        </span>
                        {gps && (
                          <span
                            className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-surface bg-emerald-500"
                            aria-label={`Na GPS: wóz #${gps.vehicleId}`}
                          />
                        )}
                      </span>
                      <span className="metric text-right font-bold text-ink">
                        {item.tripCount}
                      </span>
                      <span className="min-w-0">
                        <span className="metric block truncate font-semibold text-ink-soft">
                          {item.workSpans.join(", ")}
                        </span>
                        {(item.lineIds.length > 1 || lineId === "all") && (
                          <span className="block truncate text-[7.5px] text-mute">
                            linie {lines}
                          </span>
                        )}
                      </span>
                      <span className="metric text-right text-[9px] font-semibold text-ink">
                        {formatServiceHours(duration)}
                      </span>
                      {showTechnicalNotes && (
                        <span className="metric text-right text-[9px] font-semibold text-ink-soft">
                          {loadedMetrics && loadedMetrics.totalMeters > 0
                            ? formatKilometres(
                                loadedMetrics.totalMeters,
                              ).replace(" km", "")
                            : "—"}
                          {loadedMetrics && loadedMetrics.totalMeters > 0 && (
                            <span className="text-[7px] text-mute"> km</span>
                          )}
                        </span>
                      )}
                    </button>
                  );
                })}
                {filtered.length > shown.length && (
                  <button
                    type="button"
                    onClick={() => setListLimit((current) => current + 80)}
                    className="h-7 w-full border-t border-line text-[9.5px] font-bold text-brand-ink hover:bg-brand-soft"
                  >
                    Pokaż kolejne ({filtered.length - shown.length})
                  </button>
                )}
              </>
            )}
          </div>
        </section>

        <section
          className="duty-detail-pane flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface"
          aria-label="Kursy wybranej brygady"
          data-testid="brigade-detail-pane"
        >
          <button
            type="button"
            onClick={() => setMobileView("list")}
            className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1 text-[10px] font-bold text-brand-ink min-[900px]:hidden"
          >
            <ArrowLeft className="h-3 w-3" /> Lista brygad
          </button>

          {detailLoading ? (
            <div
              role="status"
              className="flex items-center gap-2 px-3 py-10 text-[10px] text-mute"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Wczytywanie
              kursów…
            </div>
          ) : detailError ? (
            <div role="alert" className="px-3 py-8 text-center">
              <p className="text-[10px] leading-relaxed text-warning">
                {detailError}
              </p>
              <button
                type="button"
                onClick={() => setSelectedBlockId(null)}
                className="mt-2 rounded-md border border-line px-2 py-1 text-[10px] font-bold"
              >
                Zamknij podgląd
              </button>
            </div>
          ) : !selected || !detail ? (
            <div className="grid flex-1 place-items-center px-4 py-10 text-center text-[10px] leading-relaxed text-mute">
              <span>
                <BusFront className="mx-auto mb-1.5 h-5 w-5" />
                Wybierz brygadę z listy, aby zobaczyć jej kursy.
              </span>
            </div>
          ) : (
            <>
              {/* Nagłówek brygady */}
              <div className="shrink-0 border-b border-line px-2.5 py-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className="metric grid h-6 min-w-[46px] place-items-center rounded px-1.5 text-[12px] font-extrabold"
                    style={badgeStyle(selected)}
                  >
                    {selected.unassigned ? "?" : displayDuty(selected.number)}
                  </span>
                  <h3 className="min-w-0 truncate text-[12px] font-extrabold text-ink">
                    {selected.unassigned
                      ? "Kursy bez potwierdzonej kursówki"
                      : `Brygada ${displayDuty(selected.number)}`}
                  </h3>
                  {selected.lineIds.length > 1 && (
                    <span className="flex items-center gap-0.5">
                      {selected.lineIds.map((line) => (
                        <span key={line}>{lineBadge(line, true)}</span>
                      ))}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    {vehicleFor(selected) && (
                      <button
                        type="button"
                        onClick={() => {
                          const bus = vehicleFor(selected);
                          if (bus) onSelectBus(bus);
                        }}
                        className="flex h-6 items-center gap-1 rounded-md border border-line px-1.5 text-[9px] font-bold text-ink-soft hover:bg-raised hover:text-ink"
                      >
                        <Crosshair className="h-3 w-3" /> Znajdź autobus
                      </button>
                    )}
                    {canLoadToPlanner && (
                      <button
                        type="button"
                        onClick={() => loadToPlanner(selected)}
                        disabled={detail.length < 2}
                        className="flex h-6 items-center gap-1 rounded-md bg-brand px-1.5 text-[9px] font-bold text-on-brand disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Navigation className="h-3 w-3" /> Wczytaj do Planera
                      </button>
                    )}
                  </div>
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[9px] text-mute">
                  <span className="font-semibold text-ink-soft">
                    {detail.length} kursów
                  </span>
                  <span>·</span>
                  <span className="metric">
                    {selected.workSpans.join(", ")}
                  </span>
                  <span>·</span>
                  <span>{formatBrigadeDate(dateId)}</span>
                  <span>·</span>
                  <span className="metric font-bold text-ink">
                    {formatServiceHours(selectedMetrics.durationMinutes)} służby
                  </span>
                </p>
              </div>

              {/* Metryki planisty */}
              {showTechnicalNotes && (
                <div className="shrink-0 border-b border-line bg-raised/50 px-2.5 py-1.5">
                  <dl className="grid grid-cols-3 gap-x-2 gap-y-1 sm:grid-cols-6">
                    {[
                      {
                        label: "Wozokilometry",
                        value: formatKilometres(selectedMetrics.totalMeters),
                        tone: "text-ink",
                      },
                      {
                        label: "Kursy liniowe",
                        value: formatKilometres(selectedMetrics.revenueMeters),
                        tone: "text-brand-ink",
                      },
                      {
                        label: "Techniczne",
                        value: formatKilometres(
                          selectedMetrics.technicalMeters,
                        ),
                        tone: "text-ink-soft",
                      },
                      {
                        label: "Czas służby",
                        value: formatServiceHours(
                          selectedMetrics.durationMinutes,
                        ),
                        tone: "text-ink",
                      },
                      {
                        label: "Jazda / przerwy",
                        value: `${shortHours(selectedMetrics.drivingMinutes)} / ${shortHours(selectedMetrics.layoverMinutes)}`,
                        tone: "text-ink",
                      },
                      {
                        label: "Dojazd. / przejazdy",
                        value: `${formatKilometres(selectedMetrics.depotMeters).replace(" km", "")} / ${formatKilometres(selectedMetrics.transferMeters)}`,
                        tone: "text-ink",
                      },
                    ].map((metric) => (
                      <div key={metric.label} className="min-w-0">
                        <dt className="truncate text-[6.5px] font-extrabold uppercase tracking-[0.08em] text-mute">
                          {metric.label}
                        </dt>
                        <dd
                          className={cn(
                            "metric truncate text-[10.5px] font-extrabold",
                            metric.tone,
                          )}
                        >
                          {metric.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-1 text-[7px] leading-snug text-mute">
                    {selectedMetrics.hasTechnicalData
                      ? "Dojazdowe = wyjazd/zjazd z bazy (WY/ZJ), przejazdy = PRZ/serwis. Wozokilometry = liniowe + techniczne."
                      : "Źródło GTFS zawiera tylko kursy pasażerskie (brak PRZ/WY/ZJ) — kilometrów dojazdowych i technicznych nie da się rozdzielić."}
                    {selectedMetrics.missingLengthTrips > 0 &&
                      ` ${selectedMetrics.missingLengthTrips} kursów bez długości w danych.`}
                  </p>
                </div>
              )}

              {showTechnicalNotes && (
                <LineRestrictions
                  className="mx-2.5 mt-1.5 shrink-0"
                  lines={
                    selected.lineIds.length
                      ? selected.lineIds
                      : [selected.primaryLine || lineId]
                  }
                />
              )}

              {/* Tabela kursów */}
              <div
                className={cn(
                  "mt-1.5 grid shrink-0 items-center gap-1.5 border-y border-line bg-raised/60 px-2.5 py-0.5 text-[7px] font-extrabold uppercase tracking-[0.08em] text-mute",
                  tripColumns,
                )}
                aria-hidden="true"
              >
                <span>Lin.</span>
                <span className="whitespace-nowrap">Godziny</span>
                <span className="hidden sm:block">Trasa</span>
                <span className="text-right">Czas</span>
                {showTechnicalNotes && <span className="text-right">Km</span>}
                <span className="text-right">Postój</span>
              </div>
              <div className="duty-trips-scroll min-h-0 flex-1 overflow-y-auto">
                {shownDetail.map((trip, index) => {
                  const durationMinutes = Math.max(
                    0,
                    Math.round((trip.endMs - trip.startMs) / 60_000),
                  );
                  const breakMinutes =
                    index < shownDetail.length - 1
                      ? Math.max(
                          0,
                          Math.round(
                            (shownDetail[index + 1].startMs - trip.endMs) /
                              60_000,
                          ),
                        )
                      : null;
                  const liveBus = vehicleFor(selected);
                  const liveStart = liveBus?.dutyTripStartMs;
                  const liveHere =
                    typeof liveStart === "number" &&
                    Math.abs(trip.startMs - liveStart) <= 90_000;
                  const technical = isTechnicalLine(trip.lineId);
                  return (
                    <article
                      key={`${trip.id}-${index}`}
                      className={cn(
                        "duty-trip-card grid items-center gap-1.5 border-b border-line/50 px-2.5 py-[3px] text-[9.5px] last:border-b-0",
                        tripColumns,
                        liveHere
                          ? "bg-emerald-500/10"
                          : technical
                            ? "bg-warning-soft/40"
                            : "",
                      )}
                      data-live-trip={liveHere ? "true" : undefined}
                      data-technical={technical ? "true" : undefined}
                      title={`${trip.firstStop.name} → ${trip.lastStop.name} · kierunek ${trip.destination}`}
                    >
                      <span className="flex items-center">
                        {lineBadge(trip.lineId, true)}
                      </span>
                      <span className="metric flex items-center gap-0.5 whitespace-nowrap font-bold">
                        <span className="text-brand-ink">
                          {formatBrigadeClock(trip.startMs)}
                        </span>
                        <span className="text-[8px] text-mute">→</span>
                        <span className="text-ink">
                          {formatBrigadeClock(trip.endMs)}
                        </span>
                      </span>
                      <span className="order-last col-span-full flex min-w-0 items-center gap-1 sm:order-none sm:col-span-1">
                        {technical && (
                          <span className="shrink-0 rounded bg-warning/15 px-1 text-[6.5px] font-extrabold uppercase text-warning">
                            {["WY", "ZJ"].includes(trip.lineId.toUpperCase())
                              ? "dojazd"
                              : "techn."}
                          </span>
                        )}
                        {liveHere && liveBus && (
                          <span className="flex shrink-0 items-center gap-0.5 rounded bg-emerald-500/15 px-1 text-[7px] font-extrabold text-emerald-700 dark:text-emerald-300">
                            <Radio className="h-2 w-2" /> #{liveBus.vehicleId}
                          </span>
                        )}
                        <span className="min-w-0 truncate text-ink">
                          {trip.firstStop.name}
                          <span className="text-mute"> → </span>
                          <span className="font-semibold text-brand-ink">
                            {trip.lastStop.name}
                          </span>
                        </span>
                      </span>
                      <span className="metric text-right text-[9px] text-ink-soft">
                        {minutesLabel(durationMinutes)}
                      </span>
                      {showTechnicalNotes && (
                        <span className="metric text-right text-[9px] text-ink-soft">
                          {trip.length > 0
                            ? formatKilometres(trip.length).replace(" km", "")
                            : "—"}
                        </span>
                      )}
                      <span className="metric text-right text-[9px] text-mute">
                        {breakMinutes === null
                          ? ""
                          : minutesLabel(breakMinutes)}
                      </span>
                    </article>
                  );
                })}
                {detail.length > shownDetail.length && (
                  <p className="px-3 py-2 text-center text-[9px] leading-relaxed text-mute">
                    Pokazano {shownDetail.length} z {detail.length} kursów.
                  </p>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
