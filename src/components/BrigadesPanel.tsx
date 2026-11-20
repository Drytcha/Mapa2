import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Building2,
  BusFront,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  FileDown,
  Info,
  Loader2,
  Map as MapIcon,
  Navigation,
  Radio,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { DateTime } from "luxon";
import {
  formatKilometres,
  formatKilometresExact,
  formatServiceHours,
  isTechnicalLine,
  summariseBrigade,
  summariseFleetByOperator,
} from "@/lib/brigadeMetrics";
import { onRuntimeEvent } from "@/lib/core/runtimeHub";
import { dedupeLines, isPlannerOnlyLine } from "@/lib/core/text";
import {
  brigadeMatchesVehicle,
  BRIGADE_ZONE,
  buildBrigadesCsv,
  computeWorkSpans,
  describeServiceIds,
  formatBrigadeClock,
  formatBrigadeDate,
  getActiveDates,
  loadBrigades,
  loadBrigadeTrips,
  resolveBrigadeReference,
  shiftDateId,
  type BrigadeItem,
  type BrigadesResult,
  type BrigadeTripView,
} from "@/lib/engine/brigades";
import {
  ensureGtfsSeeded,
  getBrigadeShapeOverlay,
  getTripStopWaypoints,
  type GtfsLineItem,
} from "@/lib/engine/gtfsStore";
import { closestTimetableDate, timetableBlockForDate, timetableDayChoices, type TimetableDayChoices, type TimetableDayKind } from "@/lib/engine/dutyPdfDays";
import { OPERATOR_STYLES } from "@/lib/transit";
import {
  MAX_WAYPOINTS,
  type LiveBusVehicle,
  type WalbrzychOperatorKey,
  type Waypoint,
} from "@/lib/types";
import { cn } from "@/utils/cn";
import LineRestrictions from "./LineRestrictions";
import type { KursowkaShapeOverlay } from "./MapView";

interface Props {
  routes: GtfsLineItem[];
  liveVehicles: LiveBusVehicle[];
  onSelectBus: (bus: LiveBusVehicle) => void;
  onShowShapeOverlay?: (overlay: KursowkaShapeOverlay) => void;
  onPreviewCourse?: (tripId: string, dateId: string) => Promise<boolean>;
  onLoadTripToPlanner: (payload: {
    line: string;
    duty: string;
    waypoints: Waypoint[];
    departureTime?: string;
    headsign?: string;
  }) => void;
  initialKursowkaId?: string | null;
  initialKursowkaCode?: string | null;
  initialDateId?: string | null;
  canLoadToPlanner?: boolean;
  /** Pełne metryki planisty (km, godziny, zmiany, rozliczenie firm i linii). */
  showTechnicalNotes?: boolean;
}

const DEFAULT_LINE = "all";

function parseHash(): { lineId: string; dateId: string } | null {
  if (typeof window === "undefined") return null;
  const match = window.location.hash.match(
    /#\/walbrzych\/brigades\/([^?]+)(?:\?date=(\d{8}))?/
  );
  if (!match) return null;
  return {
    lineId: decodeURIComponent(match[1]),
    dateId: match[2] || getActiveDates()[1].id,
  };
}

function OperatorBadge({
  operatorKey,
  compact = false,
}: {
  operatorKey: WalbrzychOperatorKey;
  compact?: boolean;
}) {
  const style = OPERATOR_STYLES[operatorKey];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded font-extrabold tracking-[0.03em]",
        compact ? "h-4 px-1 text-[7.5px]" : "h-5 px-1.5 text-[8.5px]"
      )}
      style={{ backgroundColor: style.bg, color: style.fg }}
    >
      {style.label}
    </span>
  );
}

export default function BrigadesPanel({
  routes,
  liveVehicles,
  onSelectBus,
  onShowShapeOverlay,
  onPreviewCourse,
  onLoadTripToPlanner,
  initialKursowkaId,
  initialKursowkaCode,
  initialDateId,
  canLoadToPlanner = true,
  showTechnicalNotes = false,
}: Props) {
  const initial = useMemo(() => parseHash(), []);
  const requested = useMemo(
    () => resolveBrigadeReference(initialKursowkaId, initialKursowkaCode),
    [initialKursowkaId, initialKursowkaCode]
  );
  const [lineId, setLineId] = useState(
    requested.lineId ?? initial?.lineId ?? DEFAULT_LINE
  );
  const [operatorFilter, setOperatorFilter] = useState<
    "all" | "mzuk" | "ska"
  >("all");
  const [dateId, setDateId] = useState(
    initialDateId && /^\d{8}$/.test(initialDateId)
      ? initialDateId
      : initial?.dateId ?? getActiveDates()[1].id
  );
  const [pendingBrigade, setPendingBrigade] = useState<string | null>(
    requested.brigadeNumber ?? null
  );
  const [missingBrigade, setMissingBrigade] = useState<string | null>(null);
  const [result, setResult] = useState<BrigadesResult | null>(null);
  const [resultKey, setResultKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BrigadeTripView[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [shapeLoading, setShapeLoading] = useState(false);
  const [loadingTripId, setLoadingTripId] = useState<string | null>(null);
  const [previewingTripId, setPreviewingTripId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [listLimit, setListLimit] = useState(100);
  const [reload, setReload] = useState(0);
  const [pdfScope, setPdfScope] = useState<"duty" | "line" | "mzuk" | "ska" | "other">("duty");
  const [pdfDayKind, setPdfDayKind] = useState<"current" | TimetableDayKind>("current");
  const [pdfPickedDate, setPdfPickedDate] = useState("");
  const [pdfDates, setPdfDates] = useState<TimetableDayChoices | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const originalHash = useRef<string | null>(null);
  const pdfDateChoices = pdfDayKind === "current" ? [] : pdfDates?.[pdfDayKind] ?? [];
  const pdfExportDate = pdfDayKind === "current" ? dateId :
    pdfDateChoices.some((choice) => choice.dateId === pdfPickedDate) ? pdfPickedDate : closestTimetableDate(pdfDateChoices, dateId);

  useEffect(() => {
    if (!showTechnicalNotes) return;
    let cancelled = false;
    setPdfDates(null);
    void ensureGtfsSeeded().then(({ base }) => {
      if (!cancelled) setPdfDates(timetableDayChoices(base.serviceIdsByDate, base.feedStartDate, base.feedEndDate));
    }).catch(() => {
      if (!cancelled) setPdfDates({ weekday: [], saturday: [], sunday: [] });
    });
    return () => { cancelled = true; };
  }, [showTechnicalNotes, reload]);

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
    return onRuntimeEvent("gtfs:updated", () => {
      setReload((v) => v + 1);
    });
  }, []);

  useEffect(() => {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}#/walbrzych/brigades/${encodeURIComponent(lineId)}?date=${dateId}`
    );
  }, [lineId, dateId]);

  useEffect(() => {
    if (!routes.length || lineId === "all") return;
    if (
      !routes.some(
        (route) => route.shortName.toUpperCase() === lineId.toUpperCase()
      )
    ) {
      setLineId("all");
    }
  }, [routes, lineId]);

  // Travellers never see planner-only "S" lines: hide their brigades and strip them from mixed ones.
  const visibleItems = useMemo(() => {
    const items = result?.items ?? [];
    if (showTechnicalNotes) return items;
    return items.flatMap((item) => {
      const trips = item.trips.filter((trip) => !isPlannerOnlyLine(trip.lineId));
      const lineIds = item.lineIds.filter((line) => !isPlannerOnlyLine(line));
      if (!trips.length && !lineIds.length) return [];
      if (isPlannerOnlyLine(item.primaryLine) && !lineIds.length) return [];
      return [{ ...item, trips, lineIds, tripCount: trips.length || item.tripCount }];
    });
  }, [result, showTechnicalNotes]);

  useEffect(() => {
    if (!routes.length) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setMissingBrigade(null);
    setResult(null);
    setResultKey("");
    setSelectedBlockId(null);
    setDetail(null);
    setMobileView("list");
    setListLimit(100);
    loadBrigades(routes, lineId, dateId)
      .then((data) => {
        if (!cancelled) {
          setResult(data);
          setResultKey(`${lineId}|${dateId}`);
          const firstVisible = showTechnicalNotes
            ? data.items[0]
            : data.items.find(
                (item) =>
                  !isPlannerOnlyLine(item.primaryLine) ||
                  item.lineIds.some((line) => !isPlannerOnlyLine(line))
              );
          if (firstVisible && !pendingBrigade) {
            setSelectedBlockId(firstVisible.blockId);
          }
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Nie udało się wczytać katalogu brygad."
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
    const item = visibleItems.find(
      (entry) => entry.blockId === selectedBlockId
    );
    if (!item) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    if (item.trips.length > 0) {
      setDetail(item.trips);
      setDetailLoading(false);
      setDetailError("");
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
              : "Nie udało się wczytać kursów brygady."
          );
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visibleItems, selectedBlockId]);

  const uniqueRoutes = useMemo(() => {
    const map = new Map<string, GtfsLineItem>();
    for (const route of routes) {
      const key = route.shortName.trim().toUpperCase();
      if (!key) continue;
      if (!showTechnicalNotes && isPlannerOnlyLine(key)) continue;
      if (!map.has(key)) map.set(key, route);
    }
    return [...map.values()];
  }, [routes, showTechnicalNotes]);

  const routeByShort = useMemo(
    () =>
      new Map(
        uniqueRoutes.map(
          (route) => [route.shortName.trim().toUpperCase(), route] as const
        )
      ),
    [uniqueRoutes]
  );
  const dates = useMemo(() => getActiveDates(), [reload]);

  const vehicleFor = (item: BrigadeItem) =>
    liveVehicles.find(
      (bus) =>
        bus.dutyStatus === "confirmed" &&
        Boolean(bus.dutyCode) &&
        brigadeMatchesVehicle(item.number, bus.dutyCode ?? "")
    );

  useEffect(() => {
    if (
      !pendingBrigade ||
      !result ||
      loading ||
      resultKey !== `${lineId}|${dateId}`
    ) {
      return;
    }
    const wanted = pendingBrigade.toUpperCase();
    const direct = result.items.find(
      (item) => item.number.toUpperCase() === wanted
    );
    if (direct) {
      setSelectedBlockId(direct.blockId);
      setMobileView("detail");
      setPendingBrigade(null);
      return;
    }
    const [linePart, numberPart] = wanted.split("-");
    if (linePart && numberPart && lineId !== "all" && lineId.toUpperCase() !== linePart) {
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
  }, [pendingBrigade, result, resultKey, loading, routes, lineId, dateId]);

  // Fleet summary across ALL brigades of current line/date (before operator & text search)
  const operatorCounts = useMemo(() => {
    const all = visibleItems;
    let mzuk = 0;
    let ska = 0;
    for (const item of all) {
      if (item.unassigned) continue;
      if (item.operatorKey === "mzuk") mzuk += 1;
      else if (item.operatorKey === "ska") ska += 1;
    }
    return { mzuk, ska, total: mzuk + ska };
  }, [visibleItems]);

  const filtered = useMemo(() => {
    const items = visibleItems;
    const byOp =
      operatorFilter === "all"
        ? items
        : items.filter((item) => item.operatorKey === operatorFilter);
    const rawTerm = query.trim();
    if (!rawTerm) return byOp;
    const upper = rawTerm.toUpperCase().replace(/\//g, "-");
    const lowerFold = rawTerm
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    return byOp.filter(
      (item) =>
        item.number.toUpperCase().includes(upper) ||
        item.lineIds.some((line) => line.toUpperCase() === upper || line.includes(upper)) ||
        item.operatorLabel.toLowerCase().includes(lowerFold) ||
        (lowerFold === "ska" && item.operatorKey === "ska") ||
        item.trips.some(
          (t) =>
            t.destination.toUpperCase().includes(upper) ||
            t.firstStop.name.toUpperCase().includes(upper) ||
            t.lastStop.name.toUpperCase().includes(upper)
        )
    );
  }, [visibleItems, operatorFilter, query]);

  const fleetSummary = useMemo(
    () => summariseFleetByOperator(filtered),
    [filtered]
  );

  const shown = useMemo(
    () => filtered.slice(0, listLimit),
    [filtered, listLimit]
  );
  const selected =
    visibleItems.find((entry) => entry.blockId === selectedBlockId) ?? null;

  const totalTrips = useMemo(
    () => filtered.reduce((sum, item) => sum + item.tripCount, 0),
    [filtered]
  );
  const gpsCount = useMemo(
    () => filtered.filter((item) => Boolean(vehicleFor(item))).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, liveVehicles]
  );

  const shownDetail = detail ? detail.slice(0, 140) : [];
  const selectedMetrics = useMemo(
    () =>
      selected?.metrics && detail === selected.trips
        ? selected.metrics
        : summariseBrigade(detail?.length ? detail : (selected?.trips ?? [])),
    [selected, detail]
  );
  const selectedLines = useMemo(
    () =>
      dedupeLines([
        ...(selected?.lineIds ?? []),
        ...(detail ?? [])
          .map((trip) => trip.lineId)
          .filter((line) => !isTechnicalLine(line)),
      ]),
    [selected, detail]
  );
  const selectedWorkSpans = useMemo(
    () =>
      detail?.length
        ? computeWorkSpans(detail.map((trip) => [trip.startMs, trip.endMs]))
        : (selected?.workSpans ?? []),
    [selected, detail]
  );

  const displayDuty = (value: string) => value.replace(/-([0-9]+)$/, "/$1");

  const badgeStyle = (item: BrigadeItem) => {
    const route = routeByShort.get(
      (item.primaryLine || item.lineIds[0] || lineId).toUpperCase()
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
            : "h-6 min-w-[26px] px-1 text-[10px]"
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

  const loadBrigadeTerminalsToPlanner = (item: BrigadeItem) => {
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
          short: stop.name.slice(0, 46),
          lat: stop.lat,
          lon: stop.lon,
        });
        if (points.length >= MAX_WAYPOINTS) break;
      }
      if (points.length >= MAX_WAYPOINTS) break;
    }
    if (points.length < 2) {
      setDetailError("Brak współrzędnych przystanków dla tej brygady.");
      return;
    }
    const firstClock = DateTime.fromMillis(detail[0].startMs, {
      zone: BRIGADE_ZONE,
    }).toFormat("HH:mm");
    onLoadTripToPlanner({
      line: item.primaryLine || item.lineIds[0] || "2",
      duty: item.unassigned ? "" : displayDuty(item.number),
      waypoints: points,
      departureTime: firstClock,
      headsign: `${item.operatorLabel} · ${detail.length} kursów`,
    });
  };

  const loadSingleTripToPlanner = async (
    item: BrigadeItem,
    trip: BrigadeTripView
  ) => {
    setLoadingTripId(trip.id);
    try {
      const stops = await getTripStopWaypoints(trip.id);
      let sampled = stops;
      if (sampled.length > MAX_WAYPOINTS) {
        // Always preserve first & last stop and evenly sample intermediate stops
        const innerCount = MAX_WAYPOINTS - 2;
        const step = (sampled.length - 2) / innerCount;
        const middle = Array.from({ length: innerCount }, (_, idx) => {
          return sampled[1 + Math.floor(idx * step)];
        });
        sampled = [sampled[0], ...middle, sampled[sampled.length - 1]];
      }
      const waypoints: Waypoint[] =
        sampled.length >= 2
          ? sampled.map((s, idx) => ({
              id: `trip-${trip.id}-${idx}`,
              label: `Przystanek autobusowy ${s.name}, Polska`,
              short: s.name.slice(0, 46),
              lat: s.lat,
              lon: s.lon,
            }))
          : [trip.firstStop, trip.lastStop]
              .filter((s) => s.lat !== undefined && s.lon !== undefined)
              .map((s, idx) => ({
                id: `trip-${trip.id}-${idx}`,
                label: `${s.name}, Polska`,
                short: s.name.slice(0, 46),
                lat: s.lat!,
                lon: s.lon!,
              }));

      if (waypoints.length < 2) {
        setDetailError("Brak współrzędnych przystanków tego kursu.");
        return;
      }

      onLoadTripToPlanner({
        line: trip.lineId,
        duty: item.unassigned ? "" : displayDuty(item.number),
        waypoints,
        departureTime: formatBrigadeClock(trip.startMs),
        headsign: `${trip.firstStop.name} → ${trip.lastStop.name}`,
      });
    } finally {
      setLoadingTripId(null);
    }
  };

  const handlePreviewShapeOnMap = async (item: BrigadeItem) => {
    if (!onShowShapeOverlay || !detail?.length) return;
    setShapeLoading(true);
    try {
      const route = routeByShort.get(
        (item.primaryLine || item.lineIds[0] || "").toUpperCase()
      );
      const overlay = await getBrigadeShapeOverlay(
        `Brygada ${displayDuty(item.number)} (${item.operatorLabel})`,
        route?.color ?? "#0d4f3b",
        detail.map((t) => t.id)
      );
      if (overlay) {
        onShowShapeOverlay(overlay);
      } else {
        setDetailError("Brak geometrii shapes.txt dla tej brygady.");
      }
    } finally {
      setShapeLoading(false);
    }
  };

  const handlePreviewCourse = async (tripId: string) => {
    if (!onPreviewCourse || previewingTripId) return;
    setPreviewingTripId(tripId);
    try {
      await onPreviewCourse(tripId, dateId);
    } finally {
      setPreviewingTripId(null);
    }
  };

  const handleExportCsv = () => {
    if (!filtered.length) return;
    const csv = buildBrigadesCsv(filtered, dateId);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const opSuffix = operatorFilter === "all" ? "wszystkie" : operatorFilter;
    const lineSuffix = lineId === "all" ? "linie" : `linia-${lineId}`;
    a.download = `brygady-walbrzych-${dateId}-${opSuffix}-${lineSuffix}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleExportTimetablePdf = async () => {
    if (pdfBusy || loading || resultKey !== `${lineId}|${dateId}`) return;
    setPdfError("");
    if (pdfScope === "duty" && !selected) { setPdfError("Wybierz kursówkę z listy."); return; }
    if (pdfScope === "line" && lineId === "all") { setPdfError("Wybierz konkretną linię w pasku linii."); return; }
    if (!pdfExportDate) { setPdfError("Brak dat tego rodzaju dnia w aktualnym GTFS."); return; }
    setPdfBusy(true);
    try {
      const { collectTimetablePdfData, createTimetablePdf, timetablePdfFilename } = await import("@/lib/engine/dutyTimetablePdf");
      const targetBlockId = selected ? timetableBlockForDate(selected, dateId, pdfExportDate) : undefined;
      const scope = pdfScope === "duty"
        ? { kind: "duty" as const, blockId: targetBlockId! }
        : pdfScope === "line"
          ? { kind: "line" as const, line: lineId }
          : { kind: "company" as const, company: pdfScope };
      const data = await collectTimetablePdfData(routes, pdfExportDate, scope);
      const doc = await createTimetablePdf(data);
      doc.save(timetablePdfFilename(pdfExportDate, scope));
    } catch (cause) {
      setPdfError(cause instanceof Error ? cause.message : "Nie udało się przygotować PDF.");
    } finally {
      setPdfBusy(false);
    }
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
    ? "grid-cols-[48px_36px_26px_minmax(0,1fr)_52px_46px]"
    : "grid-cols-[48px_36px_26px_minmax(0,1fr)]";

  const tripColumns = showTechnicalNotes
    ? canLoadToPlanner
      ? "grid-cols-[28px_74px_1fr_1fr] sm:grid-cols-[28px_74px_minmax(0,1fr)_44px_44px_42px_54px]"
      : "grid-cols-[28px_74px_1fr_1fr] sm:grid-cols-[28px_74px_minmax(0,1fr)_46px_46px_42px]"
    : onPreviewCourse
      ? "grid-cols-[28px_74px_1fr_68px] sm:grid-cols-[28px_74px_minmax(0,1fr)_48px_68px]"
      : "grid-cols-[28px_74px_1fr] sm:grid-cols-[28px_74px_minmax(0,1fr)_48px]";

  const feedRange = (value: number) =>
    String(value).replace(/^(\d{4})(\d{2})(\d{2})$/, "$3.$2.$1");

  return (
    <div className="duty-panel flex h-full min-h-0 min-w-0 flex-col gap-1.5">
      {/* ── Pasek narzędzi: data, filtr firm MZUK/ŚKA, wyszukiwarka ─────── */}
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
                  : "text-mute hover:bg-surface hover:text-ink"
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
                    "yyyyLLdd"
                  ).toFormat("yyyy-MM-dd")
                : undefined
            }
            max={
              result?.feedTo
                ? DateTime.fromFormat(
                    String(result.feedTo),
                    "yyyyLLdd"
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

        {/* Filtr przewoźnika / firmy: Wszystkie | MZUK | ŚKA */}
        <div
          role="group"
          aria-label="Filtr przewoźnika (firmy)"
          className="flex h-7 items-center gap-0.5 rounded-md border border-line bg-raised p-0.5"
        >
          <button
            type="button"
            aria-pressed={operatorFilter === "all"}
            onClick={() => setOperatorFilter("all")}
            className={cn(
              "flex h-6 items-center gap-1 rounded px-2 text-[9.5px] font-extrabold transition-colors",
              operatorFilter === "all"
                ? "bg-surface text-ink shadow-xs"
                : "text-mute hover:text-ink"
            )}
          >
            <Building2 className="h-2.5 w-2.5" />
            Wszystkie
            <span className="metric text-[8.5px] opacity-75">
              ({operatorCounts.total})
            </span>
          </button>
          <button
            type="button"
            aria-pressed={operatorFilter === "mzuk"}
            onClick={() =>
              setOperatorFilter((cur) => (cur === "mzuk" ? "all" : "mzuk"))
            }
            className={cn(
              "flex h-6 items-center gap-1 rounded px-2 text-[9.5px] font-extrabold transition-colors",
              operatorFilter === "mzuk"
                ? "bg-[#86efac] text-[#10351e] shadow-xs"
                : "text-mute hover:text-ink"
            )}
          >
            <span className="h-2 w-2 rounded-full bg-[#22c55e]" />
            MZUK
            <span className="metric text-[8.5px] opacity-80">
              ({operatorCounts.mzuk})
            </span>
          </button>
          <button
            type="button"
            aria-pressed={operatorFilter === "ska"}
            onClick={() =>
              setOperatorFilter((cur) => (cur === "ska" ? "all" : "ska"))
            }
            className={cn(
              "flex h-6 items-center gap-1 rounded px-2 text-[9.5px] font-extrabold transition-colors",
              operatorFilter === "ska"
                ? "bg-[#c084fc] text-[#1b0734] shadow-xs"
                : "text-mute hover:text-ink"
            )}
          >
            <span className="h-2 w-2 rounded-full bg-[#a855f7]" />
            ŚKA
            <span className="metric text-[8.5px] opacity-80">
              ({operatorCounts.ska})
            </span>
          </button>
        </div>

        <div className="flex h-7 min-w-[140px] flex-1 items-center gap-1.5 rounded-md border border-line bg-raised px-2 focus-within:border-brand/60">
          <Search className="h-3 w-3 shrink-0 text-mute" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setListLimit(100);
            }}
            placeholder="Brygada, linia, kraniec lub firma (np. 5/02, 30, MZUK)"
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

        {result?.serviceLabel && (
          <span
            className="hidden h-7 items-center rounded-md border border-line bg-raised px-2 text-[8.5px] font-bold text-ink-soft lg:inline-flex"
            title={`Aktywne rozkłady GTFS: ${(result.serviceIds ?? []).join(", ")}`}
          >
            {result.serviceLabel}
          </span>
        )}

        {showTechnicalNotes && filtered.length > 0 && (
          <button
            type="button"
            onClick={handleExportCsv}
            title="Pobierz rozliczenie CSV brygad (firmy, km, godziny, podział linii)"
            className="flex h-7 items-center gap-1 rounded-md border border-line bg-raised px-2 text-[9px] font-extrabold text-ink-soft transition-colors hover:border-brand/50 hover:text-brand-ink"
          >
            <FileDown className="h-3 w-3" />
            <span className="hidden sm:inline">CSV</span>
          </button>
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

      {/* ── Pasek wyboru linii (wszystkie 22 linie z gtfs.walbrzych.eu) ──── */}
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
              : "border-line bg-raised text-ink-soft hover:text-ink"
          )}
        >
          Wszystkie linie
        </button>
        {uniqueRoutes.map((route) => {
          const key = route.shortName.trim().toUpperCase();
          const active = lineId.toUpperCase() === key;
          return (
            <button
              key={key}
              type="button"
              aria-label={`Linia ${route.shortName}`}
              aria-pressed={active}
              onClick={() => setLineId(key)}
              title={`${route.shortName}: ${route.longName}`}
              className={cn(
                "metric grid h-6 min-w-7 shrink-0 place-items-center rounded-md px-1 text-[10px] font-extrabold transition",
                active
                  ? "ring-2 ring-brand ring-offset-1 ring-offset-surface"
                  : "opacity-80 hover:opacity-100"
              )}
              style={{ background: route.color, color: route.textColor }}
            >
              {route.shortName}
            </button>
          );
        })}
      </div>

      {showTechnicalNotes && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-line bg-raised/60 px-2 py-1.5" aria-label="Pobieranie rozkładów PDF">
          <label htmlFor="duty-pdf-scope" className="text-[10px] font-extrabold text-ink">Rozkład PDF</label>
          <select id="duty-pdf-scope" value={pdfScope} onChange={(event) => { setPdfScope(event.target.value as typeof pdfScope); setPdfError(""); }} className="h-7 max-w-full rounded-md border border-line bg-surface px-2 text-[10px] font-semibold text-ink">
            <option value="duty">Wybrana kursówka{selected ? `: ${selected.unassigned ? "bez przypisania" : displayDuty(selected.number)}` : ""}</option>
            <option value="line">Wybrana linia{lineId === "all" ? " (wybierz linię)" : `: ${lineId}`}</option>
            <option value="mzuk">Firma: MZUK · wszystkie linie</option>
            <option value="ska">Firma: ŚKA · wszystkie linie</option>
            <option value="other">Firma: inna / nieprzypisana</option>
          </select>
          <label htmlFor="duty-pdf-day" className="text-[10px] font-extrabold text-ink">Rodzaj dnia</label>
          <select id="duty-pdf-day" value={pdfDayKind} onChange={(event) => { setPdfDayKind(event.target.value as "current" | TimetableDayKind); setPdfPickedDate(""); setPdfError(""); }} className="h-7 max-w-full rounded-md border border-line bg-surface px-2 text-[10px] font-semibold text-ink">
            <option value="current">Dzień wybrany w widoku</option>
            <option value="weekday">Roboczy</option>
            <option value="saturday">Sobota</option>
            <option value="sunday">Niedziela / święto</option>
          </select>
          {pdfDayKind !== "current" && <>
            <label htmlFor="duty-pdf-date" className="text-[10px] font-extrabold text-ink">Data PDF</label>
            <select id="duty-pdf-date" value={pdfExportDate} onChange={(event) => { setPdfPickedDate(event.target.value); setPdfError(""); }} disabled={!pdfDateChoices.length} className="h-7 max-w-full rounded-md border border-line bg-surface px-2 text-[10px] font-semibold text-ink">
              {!pdfDateChoices.length && <option value="">{pdfDates ? "Brak dat w GTFS" : "Ładowanie dat…"}</option>}
              {pdfDateChoices.map((choice) => <option key={choice.dateId} value={choice.dateId}>{formatBrigadeDate(choice.dateId)} · {describeServiceIds(choice.serviceIds)}</option>)}
            </select>
          </>}
          <button type="button" onClick={() => void handleExportTimetablePdf()} disabled={pdfBusy || loading || !result || resultKey !== `${lineId}|${dateId}` || !pdfExportDate || (pdfScope === "duty" && !selected) || (pdfScope === "line" && lineId === "all")} className="flex h-7 items-center gap-1 rounded-md bg-brand px-2.5 text-[10px] font-extrabold text-on-brand hover:opacity-90 disabled:opacity-40">
            {pdfBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileDown className="h-3 w-3" />}
            {pdfBusy ? "Przygotowuję PDF…" : "Pobierz PDF"}
          </button>
          <span className="text-[9px] text-mute">PDF obejmuje wybraną datę i obowiązujące dla niej warianty GTFS. 1 kursówka na stronę; do 4 przystanków pośrednich. WY/PRZ/ZJ oznaczone ~ wynikają z reguł i nie mają potwierdzonych godzin ani zajezdni. Firma wg katalogu; wyszukiwarka i filtr firmy nie ograniczają PDF.</span>
          {pdfError && <span role="alert" className="w-full text-[10px] font-semibold text-warning">{pdfError}</span>}
        </div>
      )}

      {/* ── Podsumowanie pracy przewozowej wg firm dla Planisty ─────────── */}
      {showTechnicalNotes && result && !loading && filtered.length > 0 && (
        <div
          data-testid="planner-fleet-summary"
          className="grid shrink-0 grid-cols-1 gap-1.5 rounded-lg border border-line bg-raised/60 px-2.5 py-1.5 sm:grid-cols-3"
        >
          {(
            [
              {
                bucket: fleetSummary.mzuk,
                dot: "bg-[#22c55e]",
                badgeBg: "#86efac",
                badgeFg: "#10351e",
                title: "MZUK Sp. z o.o.",
              },
              {
                bucket: fleetSummary.ska,
                dot: "bg-[#a855f7]",
                badgeBg: "#c084fc",
                badgeFg: "#1b0734",
                title: "ŚKA (Konsorcjum)",
              },
              {
                bucket: fleetSummary.total,
                dot: "bg-brand",
                badgeBg: "var(--color-brand)",
                badgeFg: "var(--color-on-brand)",
                title: "Razem w widoku",
              },
            ] as const
          ).map(({ bucket, badgeBg, badgeFg, title }) => (
            <div
              key={bucket.label}
              className="flex items-center justify-between gap-2 rounded-md border border-line/70 bg-surface px-2 py-1 text-[8.5px]"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span
                    className="rounded px-1.5 py-0.5 text-[7.5px] font-extrabold"
                    style={{ backgroundColor: badgeBg, color: badgeFg }}
                  >
                    {bucket.label}
                  </span>
                  <span className="truncate font-extrabold text-ink">
                    {bucket.brigades} bryg.
                    {bucket.splitBrigades > 0 && (
                      <span className="font-semibold text-mute">
                        {" "}
                        ({bucket.splitBrigades} przeryw.)
                      </span>
                    )}{" "}
                    · {bucket.trips} kurs.
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[8px] text-mute" title={title}>
                  Praca:{" "}
                  <strong className="metric text-ink-soft">
                    {shortHours(bucket.workBlockMinutes)}
                  </strong>{" "}
                  (jazda{" "}
                  <span className="metric">{shortHours(bucket.drivingMinutes)}</span>,
                  postoje{" "}
                  <span className="metric">{shortHours(bucket.layoverMinutes)}</span>)
                  {bucket.commercialSpeedKmh > 0 && (
                    <> · śr. {bucket.commercialSpeedKmh.toLocaleString("pl-PL")} km/h</>
                  )}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="metric text-[10.5px] font-extrabold text-brand-ink">
                  {formatKilometresExact(bucket.revenueMeters)}
                </div>
                <div className="metric text-[7.5px] font-semibold text-mute">
                  {bucket.deadheadMeters > 0
                    ? `+${formatKilometresExact(bucket.deadheadMeters)} przej.`
                    : "liniowe GTFS"}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Komunikaty ─────────────────────────────────────────────────── */}
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
                Brygada {missingBrigade} nie kursuje w dniu{" "}
                {formatBrigadeDate(dateId)}. Wybierz inną datę (np. 1 XII dla
                linii 30) lub inną brygadę z listy.
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

      {/* ── Lista brygad + szczegóły wybranej brygady ──────────────────── */}
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
                {gpsCount > 0 && ` · ${gpsCount} GPS`}
              </span>
            )}
            {result && !result.error && (
              <details className="relative ml-auto">
                <summary
                  className="grid h-5 w-5 cursor-pointer list-none place-items-center rounded text-mute hover:bg-raised hover:text-brand-ink [&::-webkit-details-marker]:hidden"
                  aria-label="Informacje o źródle brygad i firm"
                  title="Informacje o źródle brygad i firm"
                >
                  <Info className="h-3 w-3" />
                </summary>
                <div className="absolute right-0 top-6 z-20 w-[300px] rounded-lg border border-line bg-surface p-2.5 text-[8.5px] leading-snug text-ink-soft shadow-[0_12px_32px_rgba(9,35,23,0.22)]">
                  <p>
                    <b className="text-ink">Oficjalny rozkład gtfs.walbrzych.eu</b>{" "}
                    na {formatBrigadeDate(dateId)} ({feedRange(result.feedFrom)}–
                    {feedRange(result.feedTo)}
                    {result.feedVersion ? `, wyd. ${result.feedVersion}` : ""}).
                  </p>
                  <p className="mt-1">
                    Przypisanie brygad do firm <b>MZUK</b> i <b>ŚKA</b> pochodzi
                    bezpośrednio z paczek operatorów{" "}
                    <span className="metric">1 - SKA/GTFS (full).zip</span> oraz{" "}
                    <span className="metric">2 - MZUK/GTFS (full).zip</span>{" "}
                    (ta sama brygada może być obsługiwana przez inną firmę w dni
                    robocze niż w weekendy).
                  </p>
                </div>
              </details>
            )}
          </div>

          <div
            className={cn(
              "grid shrink-0 items-center gap-1 border-b border-line bg-raised/60 px-2 py-0.5 text-[7px] font-extrabold uppercase tracking-[0.08em] text-mute",
              listColumns
            )}
            aria-hidden="true"
          >
            <span>Bryg.</span>
            <span>Firma</span>
            <span className="text-right">Kurs</span>
            <span>{showTechnicalNotes ? "Godziny / Linie" : "Linie"}</span>
            {showTechnicalNotes && <span className="text-right">Praca</span>}
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
                  {query || operatorFilter !== "all"
                    ? "Brak brygad spełniających wybrane filtry."
                    : lineId === "30" && Number(dateId) < 20261201
                      ? "Linia 30 (Wałbrzych – Świebodzice) kursuje od 1 grudnia 2026 r. Przełącz datę na grudzień."
                      : result?.error
                        ? "Brak obowiązującego rozkładu dla tej daty."
                        : "Brak brygad dla tej linii w wybranym dniu."}
                </p>
                {(query || operatorFilter !== "all") && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setOperatorFilter("all");
                    }}
                    className="mt-2 text-[10px] font-bold text-brand-ink underline"
                  >
                    Wyczyść filtry
                  </button>
                )}
              </div>
            ) : (
              <>
                {shown.map((item) => {
                  const active = selectedBlockId === item.blockId;
                  const gps = vehicleFor(item);
                  const m = item.metrics;
                  const uniqueItemLines = dedupeLines(item.lineIds);
                  const lines = uniqueItemLines.join(", ");
                  const showSecondaryLines =
                    uniqueItemLines.length > 1 ||
                    (uniqueItemLines.length === 1 &&
                      uniqueItemLines[0] !== item.primaryLine.toUpperCase());
                  const isSplit = m.shiftCount >= 2;
                  return (
                    <button
                      key={item.blockId}
                      type="button"
                      data-testid="brigade-card"
                      aria-pressed={active}
                      title={`${
                        item.unassigned
                          ? "Kursy bez kursówki"
                          : `Brygada ${displayDuty(item.number)} (${item.operatorName})`
                      } · ${
                        uniqueItemLines.length > 1 ? `linie ${lines}` : `linia ${lines}`
                      }${showTechnicalNotes ? ` · ${formatKilometresExact(m.revenueMeters)}` : ""}${
                        gps ? ` · GPS wóz #${gps.vehicleId}` : ""
                      }`}
                      onClick={() => {
                        setSelectedBlockId(item.blockId);
                        setMobileView("detail");
                      }}
                      className={cn(
                        "grid w-full min-w-0 items-center gap-1 border-b border-line/60 px-2 py-1 text-left text-[10px] transition-colors last:border-b-0",
                        listColumns,
                        active ? "bg-brand-soft/80" : "hover:bg-raised"
                      )}
                    >
                      <span className="relative inline-flex">
                        <span
                          className="metric grid h-5 w-full place-items-center rounded px-0.5 text-[9.5px] font-extrabold"
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

                      <OperatorBadge operatorKey={item.operatorKey} compact />

                      <span className="metric text-right text-[9.5px] font-bold text-ink">
                        {item.tripCount}
                      </span>

                      <span className="min-w-0">
                        {showTechnicalNotes && (
                          <span className="metric flex items-center gap-1 truncate text-[9px] font-semibold text-ink-soft">
                            <span className="truncate">{item.workSpans.join(", ")}</span>
                            {isSplit && (
                              <span
                                title="Brygada przerywana (szczytowa)"
                                className="shrink-0 rounded bg-warning/18 px-1 text-[6.5px] font-extrabold text-warning"
                              >
                                B
                              </span>
                            )}
                          </span>
                        )}
                        {(!showTechnicalNotes || showSecondaryLines) && (
                          <span className="block truncate text-[7.5px] text-mute">
                            {uniqueItemLines.length > 1
                              ? `linie: ${lines}`
                              : `linia ${lines}`}
                          </span>
                        )}
                      </span>

                      {showTechnicalNotes && (
                        <span className="metric text-right text-[8.5px] font-semibold text-ink">
                          {shortHours(m.workBlockMinutes)}
                        </span>
                      )}

                      {showTechnicalNotes && (
                        <span className="metric text-right text-[8.5px] font-bold text-brand-ink">
                          {m.revenueMeters > 0
                            ? (m.revenueMeters / 1000).toLocaleString("pl-PL", {
                                minimumFractionDigits: 1,
                                maximumFractionDigits: 1,
                              })
                            : "—"}
                        </span>
                      )}
                    </button>
                  );
                })}
                {filtered.length > shown.length && (
                  <button
                    type="button"
                    onClick={() => setListLimit((current) => current + 100)}
                    className="h-7 w-full border-t border-line text-[9.5px] font-bold text-brand-ink hover:bg-brand-soft"
                  >
                    Pokaż kolejne ({filtered.length - shown.length})
                  </button>
                )}
              </>
            )}
          </div>
        </section>

        {/* ── Prawa kolumna: szczegóły brygady, metryki planisty i kursy ── */}
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
                onClick={() => setDetailError("")}
                className="mt-2 rounded-md border border-line px-2 py-1 text-[10px] font-bold"
              >
                Ukryj komunikat
              </button>
            </div>
          ) : !selected || !detail ? (
            <div className="grid flex-1 place-items-center px-4 py-10 text-center text-[10px] leading-relaxed text-mute">
              <span>
                <BusFront className="mx-auto mb-1.5 h-5 w-5" />
                Wybierz brygadę z listy, aby zobaczyć jej kursy i firmę.
                {showTechnicalNotes && " Dostępne jest też rozliczenie kilometrów i godzin."}
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
                  <OperatorBadge operatorKey={selected.operatorKey} />
                  <h3 className="min-w-0 truncate text-[12px] font-extrabold text-ink">
                    {selected.unassigned
                      ? "Kursy bez potwierdzonej kursówki"
                      : `Brygada ${displayDuty(selected.number)}`}
                  </h3>
                  {(selectedLines.length > 1 ||
                    (selectedLines.length === 1 &&
                      (selected.unassigned ||
                        selectedLines[0] !==
                          selected.primaryLine.toUpperCase()))) && (
                    <span className="flex max-w-full flex-wrap items-center gap-0.5">
                      {selectedLines.map((line) => (
                        <span key={line}>{lineBadge(line, true)}</span>
                      ))}
                    </span>
                  )}
                  <div className="ml-auto flex min-w-0 flex-wrap items-center gap-1 max-[420px]:ml-0 max-[420px]:w-full">
                    {vehicleFor(selected) && (
                      <button
                        type="button"
                        onClick={() => {
                          const bus = vehicleFor(selected);
                          if (bus) onSelectBus(bus);
                        }}
                        className="flex h-6 items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/12 px-1.5 text-[9px] font-extrabold text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
                      >
                        <Crosshair className="h-3 w-3" /> Wóz #
                        {vehicleFor(selected)?.vehicleId}
                      </button>
                    )}
                    {onShowShapeOverlay && (
                      <button
                        type="button"
                        onClick={() => void handlePreviewShapeOnMap(selected)}
                        disabled={shapeLoading || !detail.length}
                        title="Narysuj wszystkie warianty trasy (shapes.txt) tej brygady na mapie"
                        className="flex h-6 items-center gap-1 rounded-md border border-line bg-raised px-1.5 text-[9px] font-bold text-ink-soft hover:border-brand/50 hover:text-brand-ink disabled:opacity-45"
                      >
                        {shapeLoading ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <MapIcon className="h-3 w-3" />
                        )}
                        Na mapie
                      </button>
                    )}
                    {canLoadToPlanner && (
                      <button
                        type="button"
                        onClick={() => loadBrigadeTerminalsToPlanner(selected)}
                        disabled={detail.length < 1}
                        className="flex h-6 items-center gap-1 rounded-md bg-brand px-1.5 text-[9px] font-bold text-on-brand disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Navigation className="h-3 w-3" /> Wczytaj do Planera
                      </button>
                    )}
                  </div>
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[9px] leading-snug text-mute">
                  <span className="font-bold text-ink">
                    {selected.operatorName}
                  </span>
                  <span>·</span>
                  <span className="font-semibold text-ink-soft">
                    {detail.length} kursów
                  </span>
                  {showTechnicalNotes && (
                    <>
                      <span>·</span>
                      <span className="metric font-semibold text-ink-soft">
                        {selectedWorkSpans.join(", ")}
                      </span>
                    </>
                  )}
                  <span>·</span>
                  <span>{formatBrigadeDate(dateId)}</span>
                  {showTechnicalNotes && (
                    <>
                      <span>·</span>
                      <span className="metric font-bold text-brand-ink">
                        {formatKilometresExact(selectedMetrics.revenueMeters)}
                      </span>
                      <span>·</span>
                      <span className="metric font-bold text-ink">
                        {formatServiceHours(selectedMetrics.workBlockMinutes)} pracy
                      </span>
                    </>
                  )}
                </p>
              </div>

              {/* Rozbudowany panel metryk dla Planisty */}
              {showTechnicalNotes && (
                <div className="shrink-0 border-b border-line bg-raised/50 px-2.5 py-1.5">
                  <dl className="grid grid-cols-2 gap-x-2.5 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-6">
                    <div className="min-w-0">
                      <dt className="text-[6.5px] font-extrabold uppercase tracking-[0.06em] text-mute">
                        Km liniowe (GTFS)
                      </dt>
                      <dd className="metric text-[10.5px] font-extrabold text-brand-ink">
                        {formatKilometresExact(selectedMetrics.revenueMeters)}
                      </dd>
                      <span className="block text-[7.5px] text-mute">
                        {selectedMetrics.revenueTrips} kursów pasaż.
                      </span>
                    </div>

                    <div className="min-w-0">
                      <dt className="text-[6.5px] font-extrabold uppercase tracking-[0.06em] text-mute">
                        Przejazdy krańcowe
                      </dt>
                      <dd className="metric text-[10.5px] font-extrabold text-ink">
                        {selectedMetrics.deadheadMeters > 0
                          ? `~${formatKilometresExact(selectedMetrics.deadheadMeters)}`
                          : "0,0 km"}
                      </dd>
                      <span className="block text-[7.5px] text-mute">
                        {selectedMetrics.deadheadCount > 0
                          ? `${selectedMetrics.deadheadCount} zmian krańca`
                          : "stałe krańce"}
                      </span>
                    </div>

                    <div className="min-w-0">
                      <dt className="text-[6.5px] font-extrabold uppercase tracking-[0.06em] text-mute">
                        Przebieg operacyjny
                      </dt>
                      <dd className="metric text-[10.5px] font-extrabold text-ink">
                        {formatKilometresExact(
                          selectedMetrics.totalWithDeadheadMeters
                        )}
                      </dd>
                      <span className="block text-[7.5px] text-mute">
                        liniowe + przejazdy
                      </span>
                    </div>

                    <div className="min-w-0">
                      <dt className="text-[6.5px] font-extrabold uppercase tracking-[0.06em] text-mute">
                        Czas pracy / służby
                      </dt>
                      <dd className="metric text-[10.5px] font-extrabold text-ink">
                        {formatServiceHours(selectedMetrics.workBlockMinutes)}
                      </dd>
                      <span className="block text-[7.5px] text-mute">
                        {selectedMetrics.shiftCount >= 2
                          ? `przerywana (${selectedMetrics.shiftCount} bl., rozp. ${shortHours(selectedMetrics.durationMinutes)})`
                          : `ciągła · ~${selectedMetrics.estimatedDriverShifts} zm.`}
                      </span>
                    </div>

                    <div className="min-w-0">
                      <dt className="text-[6.5px] font-extrabold uppercase tracking-[0.06em] text-mute">
                        Jazda / postoje
                      </dt>
                      <dd className="metric text-[10.5px] font-extrabold text-ink">
                        {shortHours(selectedMetrics.drivingMinutes)} /{" "}
                        {shortHours(selectedMetrics.layoverMinutes)}
                      </dd>
                      <span className="block text-[7.5px] text-mute">
                        ruch {selectedMetrics.utilizationPercent}%
                        {selectedMetrics.splitBreakMinutes > 0
                          ? ` · przerwa B ${shortHours(selectedMetrics.splitBreakMinutes)}`
                          : ""}
                      </span>
                    </div>

                    <div className="min-w-0">
                      <dt className="text-[6.5px] font-extrabold uppercase tracking-[0.06em] text-mute">
                        Prędkość kom. / jazdy
                      </dt>
                      <dd className="metric text-[10.5px] font-extrabold text-ink">
                        {selectedMetrics.commercialSpeedKmh.toLocaleString(
                          "pl-PL"
                        )}{" "}
                        /{" "}
                        {selectedMetrics.runningSpeedKmh.toLocaleString("pl-PL")}{" "}
                        <span className="text-[8px] font-bold text-mute">
                          km/h
                        </span>
                      </dd>
                      <span className="block text-[7.5px] text-mute">
                        z postojami / sama jazda
                      </span>
                    </div>
                  </dl>

                  {/* Rozliczenie km i godzin wg linii dla brygady wieloliniowej */}
                  {selectedMetrics.lineBreakdown.length > 1 && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-line/70 pt-1.5">
                      <span className="text-[7.5px] font-extrabold uppercase tracking-[0.06em] text-mute">
                        Podział na linie:
                      </span>
                      {selectedMetrics.lineBreakdown.map((share) => {
                        const pct =
                          selectedMetrics.revenueMeters > 0
                            ? Math.round(
                                (share.meters / selectedMetrics.revenueMeters) *
                                  100
                              )
                            : 0;
                        return (
                          <span
                            key={share.lineId}
                            className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-[8px]"
                          >
                            {lineBadge(share.lineId, true)}
                            <span className="metric font-extrabold text-ink">
                              {formatKilometresExact(share.meters)}
                            </span>
                            <span className="text-mute">
                              ({share.trips} k. · {shortHours(share.drivingMinutes)}{" "}
                              · {pct}%)
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {showTechnicalNotes && (
                <LineRestrictions
                  className="mx-2.5 mt-1.5 shrink-0"
                  lines={
                    selectedLines.length
                      ? selectedLines
                      : [selected.primaryLine || "2"]
                  }
                />
              )}

              {/* Tabela kursów */}
              <div
                className={cn(
                  "mt-1.5 grid shrink-0 items-center gap-1.5 border-y border-line bg-raised/60 px-2.5 py-0.5 text-[7px] font-extrabold uppercase tracking-[0.08em] text-mute",
                  tripColumns
                )}
                aria-hidden="true"
              >
                <span>Lin.</span>
                <span className="whitespace-nowrap">Godziny</span>
                <span className="hidden sm:block">Trasa (od → do)</span>
                <span className="text-right">Czas</span>
                {showTechnicalNotes && <span className="text-right">Km</span>}
                {showTechnicalNotes && <span className="text-right">Postój</span>}
                {showTechnicalNotes && canLoadToPlanner && (
                  <span className="hidden text-right sm:block">Planer</span>
                )}
                {!showTechnicalNotes && onPreviewCourse && (
                  <span className="text-right">Mapa</span>
                )}
              </div>

              <div className="duty-trips-scroll min-h-0 flex-1 overflow-y-auto">
                {shownDetail.map((trip, index) => {
                  const durationMinutes = Math.max(
                    0,
                    Math.round((trip.endMs - trip.startMs) / 60_000)
                  );
                  const nextTrip =
                    index < shownDetail.length - 1
                      ? shownDetail[index + 1]
                      : null;
                  const breakMinutes = nextTrip
                    ? Math.max(
                        0,
                        Math.round((nextTrip.startMs - trip.endMs) / 60_000)
                      )
                    : null;
                  const isRelocation =
                    Boolean(
                      nextTrip &&
                        trip.lastStop.id &&
                        nextTrip.firstStop.id &&
                        trip.lastStop.id !== nextTrip.firstStop.id &&
                        trip.lastStop.name.split("-")[0].trim().toLowerCase() !==
                          nextTrip.firstStop.name
                            .split("-")[0]
                            .trim()
                            .toLowerCase()
                    );
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
                        "duty-trip-card grid items-center gap-x-1.5 gap-y-1 border-b border-line/50 px-2.5 py-1 text-[9.5px] last:border-b-0",
                        tripColumns,
                        liveHere
                          ? "bg-emerald-500/10"
                          : technical
                            ? "bg-warning-soft/40"
                            : ""
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
                        <span className="duty-trip-route min-w-0 truncate text-ink">
                          {trip.firstStop.name}
                          <span className="text-mute"> → </span>
                          <span className="font-semibold text-brand-ink">
                            {trip.lastStop.name}
                          </span>
                        </span>
                        {isRelocation && showTechnicalNotes && (
                          <span
                            title={`Zmiana krańca przed kolejnym kursem (${nextTrip?.firstStop.name})`}
                            className="shrink-0 rounded border border-warning/35 bg-warning-soft px-1 text-[6.5px] font-bold text-warning"
                          >
                            zm. pętli
                          </span>
                        )}
                      </span>
                      <span className="metric text-right text-[9px] text-ink-soft">
                        {minutesLabel(durationMinutes)}
                      </span>
                      {showTechnicalNotes && (
                        <span className="metric text-right text-[9px] font-semibold text-ink">
                          {trip.length > 0
                            ? formatKilometres(trip.length).replace(" km", "")
                            : "—"}
                        </span>
                      )}
                      {showTechnicalNotes && (
                        <span
                          className={cn(
                            "metric text-right text-[9px]",
                            breakMinutes !== null && breakMinutes > 90
                              ? "font-bold text-warning"
                              : "text-mute"
                          )}
                        >
                          {breakMinutes === null ? "" : minutesLabel(breakMinutes)}
                        </span>
                      )}
                      {showTechnicalNotes && canLoadToPlanner && (
                        <span className="hidden justify-end sm:flex">
                          <button
                            type="button"
                            onClick={() =>
                              void loadSingleTripToPlanner(selected, trip)
                            }
                            disabled={loadingTripId === trip.id}
                            title="Wczytaj wszystkie przystanki i godzinę tego kursu do Planera tras"
                            className="rounded border border-line bg-raised px-1.5 py-0.5 text-[7.5px] font-extrabold text-ink-soft transition-colors hover:border-brand/50 hover:bg-brand-soft hover:text-brand-ink disabled:opacity-50"
                          >
                            {loadingTripId === trip.id ? "…" : "Kurs →"}
                          </button>
                        </span>
                      )}
                      {!showTechnicalNotes && onPreviewCourse && (
                        <span className="flex justify-end">
                          <button
                            type="button"
                            data-testid="preview-course-button"
                            aria-label={`Pokaż przebieg kursu linii ${trip.lineId} od ${formatBrigadeClock(trip.startMs)}`}
                            onClick={() => void handlePreviewCourse(trip.id)}
                            disabled={previewingTripId !== null}
                            title="Pokaż przebieg tego kursu i wszystkie przystanki na mapie"
                            className="inline-flex h-6 items-center gap-1 rounded-md border border-brand/30 bg-brand-soft px-1.5 text-[8px] font-extrabold text-brand-ink transition-colors hover:bg-brand hover:text-on-brand disabled:opacity-50"
                          >
                            {previewingTripId === trip.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <MapIcon className="h-3 w-3" />
                            )}
                            Przebieg
                          </button>
                        </span>
                      )}
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
