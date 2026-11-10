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
  Timer,
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
import { formatDurationShort } from "@/lib/geo";
import type { LiveBusVehicle, Waypoint } from "@/lib/types";
import { cn } from "@/utils/cn";

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
}

const DEFAULT_LINE = "2";

function parseHash(): { lineId: string; dateId: string } | null {
  if (typeof window === "undefined") return null;
  const match = window.location.hash.match(/#\/walbrzych\/brigades\/([^?]+)(?:\?date=(\d{8}))?/);
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
}: Props) {
  const initial = useMemo(() => parseHash(), []);
  const requested = useMemo(
    () => resolveBrigadeReference(initialKursowkaId, initialKursowkaCode),
    [initialKursowkaId, initialKursowkaCode]
  );
  const [lineId, setLineId] = useState(
    initial?.lineId ?? requested.lineId ?? DEFAULT_LINE
  );
  const [dateId, setDateId] = useState(initial?.dateId ?? getActiveDates()[1].id);
  const [pendingBrigade, setPendingBrigade] = useState<string | null>(
    requested.brigadeNumber ?? null
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
  const originalHash = useRef<string | null>(null);

  useEffect(() => {
    originalHash.current = window.location.hash || "";
    return () => {
      const restore = originalHash.current;
      if (restore === null) return;
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${restore}`
      );
    };
  }, []);

  useEffect(() => {
    // Keep the current line/date shareable: #/walbrzych/brigades/2?date=YYYYMMDD
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}#/walbrzych/brigades/${encodeURIComponent(lineId)}?date=${dateId}`
    );
  }, [lineId, dateId, initial]);

  useEffect(() => {
    if (!routes.length || lineId === "all") return;
    if (!routes.some((route) => route.shortName.toUpperCase() === lineId.toUpperCase())) {
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
    setMobileView("list");
    setListLimit(80);
    loadBrigades(routes, lineId, dateId)
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Nie udało się wczytać katalogu brygad.");
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
    const item = result?.items.find((entry) => entry.blockId === selectedBlockId);
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
          setDetailError(cause instanceof Error ? cause.message : "Nie udało się wczytać kursów brygady.");
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [result, selectedBlockId]);

  const routeByShort = useMemo(
    () => new Map(routes.map((route) => [route.shortName.toUpperCase(), route] as const)),
    [routes]
  );
  const dates = useMemo(() => getActiveDates(), [reload]);

  const vehicleFor = (item: BrigadeItem) =>
    liveVehicles.find((bus) => brigadeMatchesVehicle(item.number, bus.kursowka));

  // A kursówka link opens its brigade straight away; if it belongs to another line
  // we first switch lines and preselect again when the new catalogue arrives.
  useEffect(() => {
    if (!pendingBrigade || !result) return;
    const wanted = pendingBrigade.toUpperCase();
    const direct = result.items.find((item) => item.number.toUpperCase() === wanted);
    if (direct) {
      setSelectedBlockId(direct.blockId);
      setMobileView("detail");
      setPendingBrigade(null);
      return;
    }
    const [linePart, numberPart] = wanted.split("-");
    if (linePart && numberPart && lineId.toUpperCase() !== linePart) {
      const hasLine = routes.some(
        (route) => route.shortName.toUpperCase() === linePart
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
    const term = query.trim().toUpperCase();
    if (!term) return items;
    return items.filter(
      (item) =>
        item.number.toUpperCase().includes(term) ||
        item.lineIds.some((line) => line.includes(term))
    );
  }, [result, query]);

  const shown = useMemo(() => filtered.slice(0, listLimit), [filtered, listLimit]);
  const selected = result?.items.find((entry) => entry.blockId === selectedBlockId) ?? null;
  const totalTrips = useMemo(
    () => (result?.items ?? []).reduce((sum, item) => sum + item.tripCount, 0),
    [result]
  );
  const gpsCount = useMemo(
    () => (result?.items ?? []).filter((item) => Boolean(vehicleFor(item))).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, liveVehicles]
  );

  // Unconfirmed group can contain hundreds of trips — keep the detail pane light.
  const shownDetail = detail ? detail.slice(0, 120) : [];

  const badgeStyle = (item: BrigadeItem) => {
    const route = routeByShort.get(item.primaryLine ?? item.lineIds[0] ?? lineId.toUpperCase());
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
          small ? "h-5 min-w-[22px] px-1 text-[9px]" : "h-6 min-w-[26px] px-1 text-[10px]"
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
    const firstClock = DateTime.fromMillis(detail[0].startMs, { zone: BRIGADE_ZONE }).toFormat("HH:mm");
    onLoadTripToPlanner({
      line: item.primaryLine || item.lineIds[0] || lineId,
      duty: item.unassigned ? "" : item.number,
      waypoints: points,
      departureTime: firstClock,
      headsign: detail[0].destination,
    });
  };

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <BusFront className="h-4 w-4 shrink-0 text-brand-ink" />
          <h2 className="text-[15px] font-extrabold tracking-[-0.02em] text-ink">Brygady</h2>
          {lineId !== "all" && lineBadge(lineId.toUpperCase())}
          <span className="text-[10px] text-mute">{formatBrigadeDate(dateId)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {result && (
            <span className="rounded-full border border-line bg-raised px-2 py-0.5 text-[9px] font-bold text-mute">
              {result.source === "live"
                ? "Brygady: rozkład operatora"
                : "Brygady: rekonstrukcja GTFS"}
            </span>
          )}
          <button
            type="button"
            onClick={() => setReload((value) => value + 1)}
            disabled={loading}
            aria-label="Odśwież brygady"
            title="Odśwież brygady"
            className="grid h-7 w-7 place-items-center rounded-md border border-line bg-surface text-mute transition-colors hover:bg-soft hover:text-brand-ink disabled:opacity-40"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setDateId(shiftDateId(dateId, -1))}
          aria-label="Poprzedni dzień"
          className="grid h-9 w-8 shrink-0 place-items-center rounded-lg border border-line bg-raised text-mute hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-lg bg-soft p-1">
          {dates.map((date) => (
            <button
              key={date.id}
              type="button"
              onClick={() => setDateId(date.id)}
              aria-pressed={date.id === dateId}
              className={cn(
                "flex h-9 min-w-0 flex-1 flex-col items-center justify-center rounded-md text-[11px] font-bold transition-colors",
                date.id === dateId
                  ? "bg-brand text-on-brand shadow-sm"
                  : "text-mute hover:bg-surface hover:text-ink"
              )}
            >
              <span>{date.label}</span>
              <span className="text-[9px] font-semibold opacity-85">{date.shortDate}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setDateId(shiftDateId(dateId, 1))}
          aria-label="Następny dzień"
          className="grid h-9 w-8 shrink-0 place-items-center rounded-lg border border-line bg-raised text-mute hover:text-ink"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <label className="relative flex h-9 shrink-0 items-center gap-1 rounded-lg border border-line bg-raised px-2 text-[10px] font-bold text-ink-soft">
          <CalendarDays className="h-3.5 w-3.5 text-mute" />
          <input
            type="date"
            aria-label="Wybierz datę rozkładu"
            min={result?.feedFrom ? DateTime.fromFormat(String(result.feedFrom), "yyyyLLdd").toFormat("yyyy-MM-dd") : undefined}
            max={result?.feedTo ? DateTime.fromFormat(String(result.feedTo), "yyyyLLdd").toFormat("yyyy-MM-dd") : undefined}
            title={
              result?.feedFrom && result?.feedTo
                ? `Rozkład obowiązuje od ${result.feedFrom} do ${result.feedTo}`
                : "Wybierz datę z obowiązującego rozkładu"
            }
            value={DateTime.fromFormat(dateId, "yyyyLLdd").setZone(BRIGADE_ZONE).toFormat("yyyy-MM-dd")}
            onChange={(event) => {
              const parsed = DateTime.fromISO(event.target.value, { zone: BRIGADE_ZONE });
              if (parsed.isValid) setDateId(parsed.toFormat("yyyyLLdd"));
            }}
            className="w-[112px] bg-transparent text-[10px] font-bold text-ink outline-none"
          />
        </label>
      </div>

      <div className="mt-3 flex min-w-0 gap-1.5 overflow-x-auto pb-2" aria-label="Wybierz linię">
        <button
          type="button"
          aria-pressed={lineId === "all"}
          onClick={() => setLineId("all")}
          className={cn(
            "shrink-0 rounded-lg border px-3 py-2 text-xs font-bold",
            lineId === "all" ? "border-brand bg-brand-soft text-brand-ink" : "border-line bg-raised text-ink-soft"
          )}
        >
          Wszystkie linie
        </button>
        {routes.map((route) => {
          const key = route.shortName.toUpperCase();
          return (
            <button
              key={route.id}
              type="button"
              aria-label={`Linia ${route.shortName}`}
              aria-pressed={lineId.toUpperCase() === key}
              onClick={() => setLineId(key)}
              className={cn(
                "flex shrink-0 items-center rounded-lg border px-1.5 py-1",
                lineId.toUpperCase() === key ? "border-brand bg-brand-soft" : "border-line bg-raised hover:border-line-strong"
              )}
            >
              <span
                className="metric grid h-6 min-w-6 place-items-center rounded px-1 text-xs font-bold"
                style={{ background: route.color, color: route.textColor }}
              >
                {route.shortName}
              </span>
            </button>
          );
        })}
      </div>

      {result && !loading && (
        <div className="mt-1 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {[
            {
              label: "Potwierdzone brygady",
              value: result.items.filter((item) => !item.unassigned).length,
            },
            { label: "Kursy w rozkładzie", value: totalTrips },
            { label: "Teraz na GPS", value: gpsCount },
            {
              label: "Linie w widoku",
              value: new Set(result.items.flatMap((item) => item.lineIds)).size,
            },
          ].map((stat) => (
            <div key={stat.label} className="rounded-lg border border-line bg-surface px-2.5 py-2">
              <span className="metric block text-[16px] font-extrabold leading-none tracking-[-0.04em] text-ink">
                {stat.value}
              </span>
              <span className="mt-1 block text-[8px] font-extrabold uppercase tracking-[0.1em] text-mute">
                {stat.label}
              </span>
            </div>
          ))}
        </div>
      )}

      {missingBrigade && (
        <p role="status" className="mt-2 flex items-start gap-1.5 rounded-lg bg-warning-soft p-2.5 text-[10px] leading-relaxed text-warning">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          Brygada {missingBrigade} nie występuje w rozkładzie na {formatBrigadeDate(dateId)}.
          Wybierz inną brygadę albo zmień datę.
          <button
            type="button"
            onClick={() => setMissingBrigade(null)}
            aria-label="Ukryj komunikat o brygadzie"
            className="ml-auto shrink-0 font-bold underline"
          >
            Ukryj
          </button>
        </p>
      )}
      {result?.error && (
        <p role="status" className="mt-2 flex items-start gap-1.5 rounded-lg bg-warning-soft p-2.5 text-[10px] leading-relaxed text-warning">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          {result.error}
        </p>
      )}
      {result?.notice && !result.error && (
        <p role="status" className="mt-2 flex items-start gap-1.5 rounded-lg bg-warning-soft p-2.5 text-[10px] leading-relaxed text-warning">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          {result.notice}
        </p>
      )}
      {result && !loading && !result.error && (
        <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-mute">
          <Info className="mt-0.5 h-3 w-3 shrink-0 text-brand-ink" />
          Tylko rozkład obowiązujący {formatBrigadeDate(dateId)} ({result.feedFrom}–
          {result.feedTo}). Numery brygad pochodzą z rozkładu pracy kierowców operatora
          (te same otwarte dane, na których opiera się livetransport.eu) — aplikacja ich nie
          wymyśla.{" "}
          {lineId !== "all" &&
            `Wybrana linia ${lineId}: widoczne są wszystkie brygady wykonujące kursy na tej linii, także te o numerach innych linii.`}
        </p>
      )}
      {error && (
        <div role="alert" className="mt-2 rounded-lg border border-warning/30 bg-warning-soft p-3 text-xs text-warning">
          {error}
          <button type="button" onClick={() => setReload((value) => value + 1)} className="mt-2 block font-bold underline">
            Spróbuj ponownie
          </button>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-raised px-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-mute" />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setListLimit(80);
          }}
          placeholder="Filtruj: numer brygady lub linia (np. 2-03)…"
          aria-label="Filtruj brygady"
          className="h-9 min-w-0 flex-1 bg-transparent text-[11px] font-semibold text-ink outline-none placeholder:font-medium placeholder:text-mute"
          autoComplete="off"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Wyczyść filtr brygad"
            className="grid h-6 w-6 place-items-center rounded text-mute hover:text-ink"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="duty-browser-grid mt-3 gap-3" data-mobile-view={mobileView}>
        <section className="duty-list-pane min-w-0 rounded-xl border border-line bg-raised p-3" aria-label="Lista brygad">
          <div className="flex items-center justify-between gap-2 border-b border-line pb-2">
            <h3 className="text-xs font-bold text-ink">
              {lineId === "all" ? "Wszystkie linie" : `Brygady z linią ${lineId}`}{" "}
              <span className="ml-1 font-normal text-mute">({filtered.length})</span>
            </h3>
            <span className="text-[9px] font-semibold text-mute">{dateId}</span>
          </div>

          {loading ? (
            <div className="space-y-2 py-3" role="status" aria-label="Wczytywanie brygad">
              {[0, 1, 2, 3, 4].map((value) => (
                <div key={value} className="stop-skeleton h-14 rounded-lg" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-2 py-8 text-center">
              <BusFront className="mx-auto mb-2 h-6 w-6 text-mute" />
              <p className="text-xs leading-relaxed text-mute">
                {query
                  ? `Brak brygady pasującej do „${query}”.`
                  : result?.error
                    ? `Brak obowiązującego rozkładu: ${result.error}`
                    : "Brak potwierdzonych brygad dla tej linii i daty. Wybierz inny dzień lub linię."}
              </p>
              {query && (
                <button type="button" onClick={() => setQuery("")} className="mt-3 text-xs font-bold text-brand-ink underline">
                  Pokaż wszystkie
                </button>
              )}
            </div>
          ) : (
            <div className="duty-list-scroll mt-2 space-y-1.5 pr-1">
              {shown.map((item) => {
                const active = selectedBlockId === item.blockId;
                const gps = vehicleFor(item);
                return (
                  <button
                    key={item.blockId}
                    type="button"
                    data-testid="brigade-card"
                    aria-pressed={active}
                    onClick={() => {
                      setSelectedBlockId(item.blockId);
                      setMobileView("detail");
                    }}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2.5 rounded-lg border bg-surface px-2.5 py-2 text-left transition-colors hover:border-line-strong",
                      active ? "border-brand ring-1 ring-brand/30" : "border-line"
                    )}
                  >
                    <span
                      className="metric grid h-8 min-w-[54px] shrink-0 place-items-center rounded-md px-1.5 text-[13px] font-extrabold"
                      style={badgeStyle(item)}
                    >
                      {item.unassigned ? "?" : item.number}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-bold text-ink">
                        {item.tripCount} {item.tripCount === 1 ? "kurs" : "kursów"} · {item.workSpans.join(", ")}
                      </span>
                      <span className="mt-0.5 block truncate text-[9px] text-mute">
                        {item.lineIds.length > 1 ? `Linie: ${item.lineIds.join(", ")}` : `Linia ${item.lineIds[0] ?? lineId}`}
                      </span>
                    </span>
                    {gps && (
                      <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[8px] font-extrabold text-emerald-700 dark:text-emerald-300">
                        <Radio className="h-2.5 w-2.5" /> GPS #{gps.vehicleId}
                      </span>
                    )}
                  </button>
                );
              })}
              {filtered.length > shown.length && (
                <button
                  type="button"
                  onClick={() => setListLimit((current) => current + 80)}
                  className="sticky bottom-0 mt-1 h-9 w-full rounded-lg border border-line bg-surface text-[11px] font-bold text-brand-ink shadow-[0_-6px_14px_rgba(13,42,28,0.06)] hover:border-brand/50 hover:bg-brand-soft"
                >
                  Pokaż kolejne brygady ({filtered.length - shown.length})
                </button>
              )}
            </div>
          )}
        </section>

        <section
          className="duty-detail-pane min-w-0 rounded-xl border border-line bg-surface p-3 sm:p-4"
          aria-label="Kursy wybranej brygady"
          data-testid="brigade-detail-pane"
        >
          <button
            type="button"
            onClick={() => setMobileView("list")}
            className="mb-3 flex items-center gap-1.5 text-xs font-bold text-brand-ink min-[900px]:hidden"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Wróć do listy
          </button>

          {detailLoading ? (
            <div role="status" className="flex items-center gap-2 py-12 text-xs text-mute">
              <Loader2 className="h-4 w-4 animate-spin" /> Wczytywanie wszystkich kursów…
            </div>
          ) : detailError ? (
            <div role="alert" className="py-8 text-center">
              <p className="text-xs leading-relaxed text-warning">{detailError}</p>
              <button type="button" onClick={() => setSelectedBlockId(null)} className="mt-3 rounded-lg border border-line px-3 py-2 text-xs font-bold">
                Zamknij podgląd
              </button>
            </div>
          ) : !selected || !detail ? (
            <div className="grid min-h-48 place-items-center px-4 text-center text-xs leading-relaxed text-mute">
              Wybierz brygadę z listy, aby zobaczyć wszystkie jej kursy w tym dniu.
            </div>
          ) : (
            <>
              <div className="border-b border-line pb-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="metric grid min-w-[58px] place-items-center rounded-md px-2 py-1 text-[15px] font-extrabold"
                    style={badgeStyle(selected)}
                  >
                    {selected.unassigned ? "?" : selected.number}
                  </span>
                  <h3 className="min-w-0 text-[15px] font-extrabold text-ink">
                    {selected.unassigned
                      ? "Kursy bez potwierdzonej kursówki"
                      : `Brygada ${selected.number}`}
                  </h3>
                  {selected.lineIds.length > 1 && (
                    <span className="flex items-center gap-1">
                      {selected.lineIds.map((line) => (
                        <span key={line}>{lineBadge(line, true)}</span>
                      ))}
                    </span>
                  )}
                </div>
                <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-mute">
                  <span>{detail.length} kursów</span>
                  <span>·</span>
                  <span className="metric">{selected.workSpans.join(", ")}</span>
                  <span>·</span>
                  <span>{formatBrigadeDate(dateId)}</span>
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {canLoadToPlanner && (
                    <button
                      type="button"
                      onClick={() => loadToPlanner(selected)}
                      disabled={detail.length < 2}
                      className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-[11px] font-bold text-on-brand disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Navigation className="h-3.5 w-3.5" /> Wczytaj do Planera
                    </button>
                  )}
                  {vehicleFor(selected) && (
                    <button
                      type="button"
                      onClick={() => {
                        const bus = vehicleFor(selected);
                        if (bus) onSelectBus(bus);
                      }}
                      className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[11px] font-bold text-ink-soft hover:bg-raised"
                    >
                      <Crosshair className="h-3.5 w-3.5" /> Znajdź autobus na mapie
                    </button>
                  )}
                </div>
              </div>

              <div className="duty-trips-scroll mt-3 space-y-2 pr-1">
                {shownDetail.map((trip, index) => {
                  const duration = Math.max(0, Math.round((trip.endMs - trip.startMs) / 1000));
                  const breakSeconds =
                    index < shownDetail.length - 1
                      ? Math.max(0, Math.round((shownDetail[index + 1].startMs - trip.endMs) / 1000))
                      : null;
                  return (
                    <article key={`${trip.id}-${index}`} className="duty-trip-card overflow-hidden rounded-lg border border-line bg-raised p-3">
                      <div className="flex items-center gap-2">
                        {lineBadge(trip.lineId, true)}
                        <span className="metric text-[13px] font-bold text-brand-ink">{formatBrigadeClock(trip.startMs)}</span>
                        <span className="text-[11px] text-mute">→</span>
                        <span className="metric text-[13px] font-bold text-ink">{formatBrigadeClock(trip.endMs)}</span>
                        <span className="ml-auto flex items-center gap-1 text-[9px] font-semibold text-mute">
                          <Timer className="h-3 w-3" /> {formatDurationShort(duration)}
                          {trip.length > 0 && ` · ${(trip.length / 1000).toFixed(1)} km`}
                        </span>
                      </div>
                      <p className="mt-1.5 break-words text-[11px] font-semibold leading-snug text-ink">
                        {trip.firstStop.name} → <span className="text-brand-ink">{trip.lastStop.name}</span>
                      </p>
                      <p className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[9.5px] text-mute">
                        <span>Końcowy: {trip.destination}</span>
                        {breakSeconds !== null && <span>Postój: {formatDurationShort(breakSeconds)}</span>}
                      </p>
                    </article>
                  );
                })}
                {detail.length > shownDetail.length && (
                  <p className="py-3 text-center text-[10px] leading-relaxed text-mute">
                    Pokazano pierwsze {shownDetail.length} z {detail.length} kursów. Wybierz
                    potwierdzoną brygadę, aby zobaczyć jej pełny, krótki wykaz.
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
