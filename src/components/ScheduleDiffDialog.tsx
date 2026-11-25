import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  Bus,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  GitCompareArrows,
  Loader2,
  Minus,
  Plus,
  Route as RouteIcon,
  Search,
  ShoppingBag,
  Upload,
  X,
} from "lucide-react";
import { onRuntimeEvent } from "@/lib/core/runtimeHub";
import { foldPolish } from "@/lib/core/text";
import { minutesToClock } from "@/lib/core/time";
import {
  compareScheduleTrips,
  dayTypeLabel,
  exportScheduleDiffCsv,
  formatYyyymmdd,
  listNsNhPairs,
  loadCurrentScheduleArchive,
  parseExternalGtfsZipForDiff,
  pickDefaultComparison,
  pickNsNhComparison,
  summarizeNsNhDifferences,
  type BrigadeScheduleDiff,
  type EntityDiffStatus,
  type NsNhComparisonPair,
  type ScheduleSourceArchive,
  type TripDiffItem,
  type TripDiffKind,
} from "@/lib/engine/scheduleDiff";
import { cn } from "@/utils/cn";
import { Dialog } from "./Modals";

interface ScheduleDiffDialogProps {
  open: boolean;
  onClose: () => void;
  initialPreset?: "default" | "ns-nh";
  onToast?: (message: string) => void;
}

type DiffTab = "lines" | "trips" | "brigades";
type TripFilterKind = "all-changes" | "added" | "removed" | "changed" | "time-shifted";
type BrigadeSortKey = "km-abs" | "km-desc" | "code" | "trips";

const INITIAL_TRIP_PAGE_SIZE = 150;

function formatKm(meters: number): string {
  return `${(meters / 1000).toLocaleString("pl-PL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} km`;
}

function formatDeltaKm(meters: number): string {
  const sign = meters > 0 ? "+" : "";
  return `${sign}${(meters / 1000).toLocaleString("pl-PL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} km`;
}

function formatDeltaInt(delta: number): string {
  if (delta === 0) return "0";
  return `${delta > 0 ? "+" : ""}${delta}`;
}

function formatMinutesDelta(delta: number): string {
  if (delta === 0) return "0 min";
  return `${delta > 0 ? "+" : ""}${delta} min`;
}

function formatWorkSpan(firstDep: number | null, lastArr: number | null): string {
  if (firstDep === null || lastArr === null) return "—";
  return `${minutesToClock(firstDep)}–${minutesToClock(lastArr)}`;
}

function deltaToneClass(value: number): string {
  if (value > 0) return "text-emerald-700 dark:text-emerald-300";
  if (value < 0) return "text-rose-700 dark:text-rose-300";
  return "text-mute";
}

function statusBadgeMeta(status: EntityDiffStatus): {
  label: string;
  className: string;
} {
  switch (status) {
    case "added":
      return {
        label: "Nowa",
        className:
          "border-emerald-500/40 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
      };
    case "removed":
      return {
        label: "Wycofana",
        className:
          "border-rose-500/40 bg-rose-500/12 text-rose-700 dark:text-rose-300",
      };
    case "changed":
      return {
        label: "Zmiany",
        className:
          "border-amber-500/40 bg-amber-500/12 text-amber-700 dark:text-amber-300",
      };
    default:
      return {
        label: "Bez zmian",
        className: "border-line bg-raised text-mute",
      };
  }
}

function tripKindBadge(kind: TripDiffKind): {
  label: string;
  className: string;
} {
  switch (kind) {
    case "added":
      return {
        label: "+ Dodany",
        className:
          "border-emerald-500/40 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
      };
    case "removed":
      return {
        label: "− Usunięty",
        className:
          "border-rose-500/40 bg-rose-500/12 text-rose-700 dark:text-rose-300",
      };
    case "changed":
      return {
        label: "~ Zmieniony",
        className:
          "border-amber-500/40 bg-amber-500/12 text-amber-700 dark:text-amber-300",
      };
    default:
      return {
        label: "Bez zmian",
        className: "border-line bg-raised text-mute",
      };
  }
}

export default function ScheduleDiffDialog({
  open,
  onClose,
  initialPreset = "default",
  onToast,
}: ScheduleDiffDialogProps) {
  const [archives, setArchives] = useState<ScheduleSourceArchive[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [uploadingSide, setUploadingSide] = useState<"A" | "B" | null>(null);

  const [archiveIdA, setArchiveIdA] = useState("current");
  const [archiveIdB, setArchiveIdB] = useState("current");
  const [serviceIdA, setServiceIdA] = useState("");
  const [serviceIdB, setServiceIdB] = useState("");

  const [activeTab, setActiveTab] = useState<DiffTab>("lines");
  const [lineFilter, setLineFilter] = useState<string>("ALL");
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [tripKindFilter, setTripKindFilter] =
    useState<TripFilterKind>("all-changes");
  const [brigadeSort, setBrigadeSort] = useState<BrigadeSortKey>("km-abs");
  const [query, setQuery] = useState("");
  const [tripPageLimit, setTripPageLimit] = useState(INITIAL_TRIP_PAGE_SIZE);
  const [expandedBrigadeKey, setExpandedBrigadeKey] = useState<string | null>(
    null,
  );

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingUploadTargetRef = useRef<"A" | "B">("A");

  const loadCurrent = useCallback(
    async (forcePreset?: "default" | "ns-nh") => {
      setLoading(true);
      setError("");
      try {
        const current = await loadCurrentScheduleArchive();
        setArchives((prev) => {
          const external = prev.filter((a) => a.id !== "current");
          return [current, ...external];
        });
        const now = new Date();
        const todayKey =
          now.getFullYear() * 10000 +
          (now.getMonth() + 1) * 100 +
          now.getDate();
        const presetMode = forcePreset ?? initialPreset;
        const defaults =
          presetMode === "ns-nh"
            ? pickNsNhComparison(current, undefined, todayKey) ??
              pickDefaultComparison(current)
            : pickDefaultComparison(current);
        if (defaults) {
          setArchiveIdA("current");
          setArchiveIdB("current");
          if (forcePreset) {
            setServiceIdA(defaults.serviceIdA);
            setServiceIdB(defaults.serviceIdB);
            setLineFilter("ALL");
            setActiveTab("lines");
          } else {
            setServiceIdA((prev) =>
              prev && current.tripsByService.has(prev)
                ? prev
                : defaults.serviceIdA,
            );
            setServiceIdB((prev) =>
              prev && current.tripsByService.has(prev)
                ? prev
                : defaults.serviceIdB,
            );
          }
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Nie udało się wczytać danych rozkładu GTFS.",
        );
      } finally {
        setLoading(false);
      }
    },
    [initialPreset],
  );

  useEffect(() => {
    if (!open) return;
    void loadCurrent(initialPreset);
    const unsubGtfs = onRuntimeEvent("gtfs:updated", () => {
      void loadCurrent();
    });
    const unsubRoutes = onRuntimeEvent("routes:overrides-updated", () => {
      void loadCurrent();
    });
    return () => {
      unsubGtfs();
      unsubRoutes();
    };
  }, [open, initialPreset, loadCurrent]);

  const archiveA = useMemo(
    () => archives.find((a) => a.id === archiveIdA) ?? archives[0] ?? null,
    [archives, archiveIdA],
  );
  const archiveB = useMemo(
    () => archives.find((a) => a.id === archiveIdB) ?? archives[0] ?? null,
    [archives, archiveIdB],
  );

  const serviceOptionA = useMemo(
    () =>
      archiveA?.services.find((s) => s.serviceId === serviceIdA) ??
      archiveA?.services[0] ??
      null,
    [archiveA, serviceIdA],
  );
  const serviceOptionB = useMemo(
    () =>
      archiveB?.services.find((s) => s.serviceId === serviceIdB) ??
      archiveB?.services[0] ??
      null,
    [archiveB, serviceIdB],
  );

  // Common day types between the selected periods (for 1-click RS / SO / NS / NH switching)
  const quickDayTypes = useMemo(() => {
    if (!archiveA || !archiveB || !serviceOptionA || !serviceOptionB) return [];
    const periodA = archiveA.periods.find(
      (p) => p.periodId === serviceOptionA.periodId,
    );
    const periodB = archiveB.periods.find(
      (p) => p.periodId === serviceOptionB.periodId,
    );
    if (!periodA || !periodB) return [];
    if (
      archiveA.id === archiveB.id &&
      periodA.periodId === periodB.periodId
    ) {
      return [];
    }
    return periodA.dayTypes.filter((dt) => periodB.dayTypes.includes(dt));
  }, [archiveA, archiveB, serviceOptionA, serviceOptionB]);

  const activeQuickDayType =
    serviceOptionA &&
    serviceOptionB &&
    serviceOptionA.dayType === serviceOptionB.dayType
      ? serviceOptionA.dayType
      : null;

  const handleSelectQuickDayType = (dayType: string) => {
    if (!archiveA || !archiveB || !serviceOptionA || !serviceOptionB) return;
    const nextA = archiveA.services.find(
      (s) => s.periodId === serviceOptionA.periodId && s.dayType === dayType,
    );
    const nextB = archiveB.services.find(
      (s) => s.periodId === serviceOptionB.periodId && s.dayType === dayType,
    );
    if (nextA) setServiceIdA(nextA.serviceId);
    if (nextB) setServiceIdB(nextB.serviceId);
    setTripPageLimit(INITIAL_TRIP_PAGE_SIZE);
    setExpandedBrigadeKey(null);
  };

  const handleSwapSides = () => {
    const prevArchA = archiveIdA;
    const prevSvcA = serviceIdA;
    setArchiveIdA(archiveIdB);
    setServiceIdA(serviceIdB);
    setArchiveIdB(prevArchA);
    setServiceIdB(prevSvcA);
    setExpandedBrigadeKey(null);
  };

  const handleTriggerZipUpload = (side: "A" | "B") => {
    pendingUploadTargetRef.current = side;
    fileInputRef.current?.click();
  };

  const handleZipFileSelected = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const side = pendingUploadTargetRef.current;
    setUploadingSide(side);
    setError("");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = parseExternalGtfsZipForDiff(bytes, file.name);
      if (!parsed.services.length) {
        throw new Error("Wgrany plik GTFS nie zawiera żadnych aktywnych kursów.");
      }
      setArchives((prev) => [...prev, parsed]);
      const preferredSvc =
        parsed.services.find((s) => s.dayType === "RS") ?? parsed.services[0];
      if (side === "A") {
        setArchiveIdA(parsed.id);
        setServiceIdA(preferredSvc.serviceId);
      } else {
        setArchiveIdB(parsed.id);
        setServiceIdB(preferredSvc.serviceId);
      }
      onToast?.(
        `Wczytano paczkę ${file.name} (${parsed.services.length} typów rozkładu) jako wersję ${side === "A" ? "starą (A)" : "nową (B)"}.`,
      );
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Nie udało się odczytać wybranego pliku GTFS (.zip).";
      setError(msg);
      onToast?.(msg);
    } finally {
      setUploadingSide(null);
    }
  };

  const currentArchive = useMemo(
    () => archives.find((a) => a.id === "current") ?? archives[0] ?? null,
    [archives],
  );

  const nsNhPairs = useMemo<NsNhComparisonPair[]>(
    () => (currentArchive ? listNsNhPairs(currentArchive) : []),
    [currentArchive],
  );

  const handleSelectNsNhPair = (pair: NsNhComparisonPair) => {
    if (!currentArchive) return;
    setArchiveIdA(currentArchive.id);
    setArchiveIdB(currentArchive.id);
    setServiceIdA(pair.nsService.serviceId);
    setServiceIdB(pair.nhService.serviceId);
    setLineFilter("ALL");
    setTripPageLimit(INITIAL_TRIP_PAGE_SIZE);
    setExpandedBrigadeKey(null);
  };

  const handleSelectPeriodDefault = () => {
    if (!currentArchive) return;
    const def = pickDefaultComparison(currentArchive);
    if (!def) return;
    setArchiveIdA(currentArchive.id);
    setArchiveIdB(currentArchive.id);
    setServiceIdA(def.serviceIdA);
    setServiceIdB(def.serviceIdB);
    setLineFilter("ALL");
    setTripPageLimit(INITIAL_TRIP_PAGE_SIZE);
    setExpandedBrigadeKey(null);
  };

  const isNsVsNh = Boolean(
    (serviceOptionA &&
      serviceOptionB &&
      ((serviceOptionA.dayType === "NS" && serviceOptionB.dayType === "NH") ||
        (serviceOptionA.dayType === "NH" && serviceOptionB.dayType === "NS"))) ||
      (initialPreset === "ns-nh" && !serviceOptionA && !serviceOptionB),
  );

  const diff = useMemo(() => {
    if (!archiveA || !archiveB || !serviceOptionA || !serviceOptionB) {
      return null;
    }
    const tripsA = archiveA.tripsByService.get(serviceOptionA.serviceId) ?? [];
    const tripsB = archiveB.tripsByService.get(serviceOptionB.serviceId) ?? [];
    const labelA =
      archiveA.id === "current"
        ? `${serviceOptionA.serviceId} (${serviceOptionA.label})`
        : `${archiveA.label} · ${serviceOptionA.serviceId}`;
    const labelB =
      archiveB.id === "current"
        ? `${serviceOptionB.serviceId} (${serviceOptionB.label})`
        : `${archiveB.label} · ${serviceOptionB.serviceId}`;
    return compareScheduleTrips(tripsA, tripsB, labelA, labelB);
  }, [archiveA, archiveB, serviceOptionA, serviceOptionB]);

  const nsNhSummary = useMemo(
    () => (diff && isNsVsNh ? summarizeNsNhDifferences(diff) : null),
    [diff, isNsVsNh],
  );

  const sameSelection =
    archiveA &&
    archiveB &&
    serviceOptionA &&
    serviceOptionB &&
    archiveA.id === archiveB.id &&
    serviceOptionA.serviceId === serviceOptionB.serviceId;

  const foldedQuery = useMemo(() => foldPolish(query.trim()), [query]);

  const filteredLines = useMemo(() => {
    if (!diff) return [];
    return diff.lines.filter((line) => {
      if (onlyChanged && line.status === "unchanged") return false;
      if (lineFilter !== "ALL" && line.routeShort !== lineFilter) return false;
      if (foldedQuery && !foldPolish(line.routeShort).includes(foldedQuery)) {
        return false;
      }
      return true;
    });
  }, [diff, onlyChanged, lineFilter, foldedQuery]);

  const filteredTrips = useMemo(() => {
    if (!diff) return [];
    return diff.trips.filter((item) => {
      if (lineFilter !== "ALL" && item.routeShort !== lineFilter) return false;
      if (tripKindFilter === "all-changes" && item.kind === "unchanged") {
        return false;
      }
      if (tripKindFilter === "added" && item.kind !== "added") return false;
      if (tripKindFilter === "removed" && item.kind !== "removed") return false;
      if (tripKindFilter === "changed" && item.kind !== "changed") return false;
      if (
        tripKindFilter === "time-shifted" &&
        !(item.kind === "changed" && item.timeChanged)
      ) {
        return false;
      }
      if (foldedQuery) {
        const hay = foldPolish(
          [
            item.routeShort,
            item.oldTrip?.kursowkaCode ?? "",
            item.newTrip?.kursowkaCode ?? "",
            item.oldTrip?.firstStopName ?? "",
            item.oldTrip?.lastStopName ?? "",
            item.newTrip?.firstStopName ?? "",
            item.newTrip?.lastStopName ?? "",
            item.oldTrip ? minutesToClock(item.oldTrip.startMinutes) : "",
            item.newTrip ? minutesToClock(item.newTrip.startMinutes) : "",
          ].join(" "),
        );
        if (!hay.includes(foldedQuery)) return false;
      }
      return true;
    });
  }, [diff, lineFilter, tripKindFilter, foldedQuery]);

  const filteredBrigades = useMemo(() => {
    if (!diff) return [];
    const base = diff.brigades.filter((b) => {
      if (onlyChanged && b.status === "unchanged") return false;
      if (lineFilter !== "ALL" && b.routeShort !== lineFilter) return false;
      if (foldedQuery) {
        const hay = foldPolish(
          `${b.routeShort} ${b.brigadeCode} ${b.operatorKey}`,
        );
        if (!hay.includes(foldedQuery)) return false;
      }
      return true;
    });

    const sorted = [...base];
    if (brigadeSort === "km-abs") {
      sorted.sort(
        (a, b) =>
          Math.abs(b.metersDelta) - Math.abs(a.metersDelta) ||
          Math.abs(b.tripsDelta) - Math.abs(a.tripsDelta),
      );
    } else if (brigadeSort === "km-desc") {
      sorted.sort((a, b) => b.metersDelta - a.metersDelta);
    } else if (brigadeSort === "trips") {
      sorted.sort(
        (a, b) =>
          Math.abs(b.tripsDelta) - Math.abs(a.tripsDelta) ||
          Math.abs(b.metersDelta) - Math.abs(a.metersDelta),
      );
    }
    return sorted;
  }, [diff, onlyChanged, lineFilter, foldedQuery, brigadeSort]);

  const handleExportCsv = () => {
    if (!diff) return;
    const csv = exportScheduleDiffCsv(diff);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeA = (serviceOptionA?.serviceId || "A").replace(/[^A-Za-z0-9_-]/g, "");
    const safeB = (serviceOptionB?.serviceId || "B").replace(/[^A-Za-z0-9_-]/g, "");
    a.href = url;
    a.download = `porownanie-rozkladu-${safeA}-vs-${safeB}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    onToast?.("Pobrano raport porównania rozkładów (CSV).");
  };

  const drillIntoLine = (routeShort: string, targetTab: "trips" | "brigades") => {
    setLineFilter(routeShort);
    setActiveTab(targetTab);
    setTripPageLimit(INITIAL_TRIP_PAGE_SIZE);
    setExpandedBrigadeKey(null);
  };

  const visibleTrips = filteredTrips.slice(0, tripPageLimit);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label={
        isNsVsNh
          ? "Porównywarka rozkładów NS vs NH"
          : "Porównanie wersji rozkładu GTFS"
      }
      className="duty-dialog-shell h-[94dvh] max-w-[1280px]"
    >
      {/* ── Nagłówek ───────────────────────────────────────────────── */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
        <span
          className={cn(
            "grid h-7 w-7 shrink-0 place-items-center rounded-md",
            isNsVsNh
              ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
              : "bg-brand-soft text-brand-ink",
          )}
        >
          {isNsVsNh ? (
            <ShoppingBag className="h-4 w-4" />
          ) : (
            <GitCompareArrows className="h-4 w-4" />
          )}
        </span>
        <div className="min-w-0">
          <h2 className="text-[13.5px] font-extrabold tracking-[-0.02em] text-ink">
            {isNsVsNh
              ? "Porównywarka rozkładów NS vs NH"
              : "Porównanie dwóch wersji rozkładu (GTFS)"}
          </h2>
          <p className="hidden text-[8.5px] text-mute sm:block">
            {isNsVsNh
              ? "Porównanie niedzieli niehandlowej / święta (NS) z niedzielą handlową (NH): zmienione linie, dodatkowe kursy i relacje, przesunięcia oraz wozokilometry brygad."
              : "Różnice między okresami w paczce (np. 387 vs 388), niedzielą NS vs NH lub dwoma plikami ZIP: kursy, przesunięcia odjazdów i wozokilometry brygad."}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            data-testid="schedule-diff-export-csv"
            disabled={!diff}
            onClick={handleExportCsv}
            className="flex h-7 items-center gap-1 rounded-md border border-line bg-raised px-2.5 text-[9px] font-bold text-ink-soft transition-colors hover:border-brand/50 hover:text-ink disabled:opacity-45"
          >
            <Download className="h-3 w-3" />
            Eksport CSV
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Zamknij"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-mute transition-colors hover:bg-raised hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,application/zip"
        onChange={(e) => void handleZipFileSelected(e)}
        className="hidden"
      />

      {loading && !archives.length ? (
        <div
          role="status"
          className="flex flex-1 items-center justify-center gap-2 p-8 text-[11px] text-mute"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          Analizowanie okresów i wozokilometrów w paczce GTFS…
        </div>
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          data-testid="schedule-diff-dialog-body"
        >
          {/* ── Pasek wyboru okresów / wersji A vs B ───────────────── */}
          <div className="shrink-0 space-y-2 border-b border-line bg-raised/50 px-3.5 py-2.5">
            {/* Szybkie presety NS vs NH */}
            {nsNhPairs.length > 0 && (
              <div
                className="flex flex-wrap items-center gap-1.5"
                data-testid="schedule-diff-ns-nh-presets"
              >
                <span className="inline-flex items-center gap-1 text-[8px] font-extrabold uppercase tracking-[0.1em] text-amber-700 dark:text-amber-300">
                  <ShoppingBag className="h-3 w-3" />
                  Porównywarka NS vs NH:
                </span>
                {nsNhPairs.map((pair) => {
                  const active =
                    archiveA?.id === currentArchive?.id &&
                    archiveB?.id === currentArchive?.id &&
                    serviceOptionA?.serviceId === pair.nsService.serviceId &&
                    serviceOptionB?.serviceId === pair.nhService.serviceId;
                  return (
                    <button
                      key={pair.periodId}
                      type="button"
                      data-testid={`schedule-diff-preset-ns-nh-${pair.periodId}`}
                      onClick={() => handleSelectNsNhPair(pair)}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-[8.5px] font-extrabold transition-colors",
                        active
                          ? "border-amber-600 bg-amber-600 text-white dark:border-amber-400 dark:bg-amber-400 dark:text-slate-950"
                          : "border-amber-500/40 bg-amber-500/10 text-amber-800 hover:border-amber-500 hover:bg-amber-500/20 dark:text-amber-200",
                      )}
                    >
                      NS vs NH · okres {pair.periodId} (
                      {formatYyyymmdd(
                        Math.min(pair.nsService.fromDate, pair.nhService.fromDate),
                      )}
                      –
                      {formatYyyymmdd(
                        Math.max(pair.nsService.toDate, pair.nhService.toDate),
                      )}
                      )
                    </button>
                  );
                })}
                {isNsVsNh && currentArchive && currentArchive.periods.length >= 2 && (
                  <button
                    type="button"
                    data-testid="schedule-diff-preset-periods"
                    onClick={handleSelectPeriodDefault}
                    className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-[8.5px] font-bold text-ink-soft transition-colors hover:border-brand/50 hover:text-ink"
                  >
                    Porównaj okresy (np.{" "}
                    {currentArchive.periods[currentArchive.periods.length - 2].periodId}{" "}
                    vs{" "}
                    {currentArchive.periods[currentArchive.periods.length - 1].periodId})
                  </button>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_1fr]">
              {/* Wersja A (stara / NS) */}
              <div className="rounded-lg border border-line bg-surface p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[8px] font-extrabold uppercase tracking-[0.12em] text-mute">
                    {isNsVsNh && serviceOptionA?.dayType === "NS"
                      ? "Niedziela niehandlowa / święto (NS · A)"
                      : isNsVsNh && serviceOptionA?.dayType === "NH"
                        ? "Niedziela handlowa (NH · A)"
                        : "Wersja bazowa (stara · A)"}
                  </span>
                  <button
                    type="button"
                    data-testid="schedule-diff-upload-a"
                    disabled={uploadingSide !== null}
                    onClick={() => handleTriggerZipUpload("A")}
                    className="flex items-center gap-1 text-[8px] font-bold text-brand-ink hover:underline disabled:opacity-50"
                  >
                    {uploadingSide === "A" ? (
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    ) : (
                      <Upload className="h-2.5 w-2.5" />
                    )}
                    Wgraj ZIP (A)
                  </button>
                </div>

                {archives.length > 1 && (
                  <select
                    aria-label="Źródło wersji A"
                    value={archiveA?.id ?? ""}
                    onChange={(e) => {
                      const next = archives.find((a) => a.id === e.target.value);
                      if (!next) return;
                      setArchiveIdA(next.id);
                      const firstSvc =
                        next.services.find((s) => s.dayType === "RS") ??
                        next.services[0];
                      if (firstSvc) setServiceIdA(firstSvc.serviceId);
                    }}
                    className="mt-1 h-7 w-full rounded border border-line bg-raised px-2 text-[9px] font-semibold text-ink outline-none"
                  >
                    {archives.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                )}

                <select
                  data-testid="schedule-diff-service-a"
                  aria-label="Okres i typ dnia dla wersji A"
                  value={serviceOptionA?.serviceId ?? ""}
                  onChange={(e) => {
                    setServiceIdA(e.target.value);
                    setTripPageLimit(INITIAL_TRIP_PAGE_SIZE);
                    setExpandedBrigadeKey(null);
                  }}
                  className="mt-1 h-8 w-full rounded-md border border-line bg-raised px-2 text-[10px] font-bold text-ink outline-none focus:border-brand/60"
                >
                  {(archiveA?.services ?? []).map((svc) => (
                    <option key={svc.serviceId} value={svc.serviceId}>
                      {svc.serviceId} · {svc.label} ({formatYyyymmdd(svc.fromDate)}–
                      {formatYyyymmdd(svc.toDate)}) · {svc.tripCount} kursów
                    </option>
                  ))}
                </select>
              </div>

              {/* Przycisk zamiany stron */}
              <div className="flex items-center justify-center">
                <button
                  type="button"
                  onClick={handleSwapSides}
                  title="Zamień wersję starą (A) z nową (B)"
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface text-ink-soft transition-colors hover:border-brand/50 hover:text-brand-ink"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Wersja B (nowa / NH) */}
              <div
                className={cn(
                  "rounded-lg border bg-surface p-2",
                  isNsVsNh ? "border-amber-500/40" : "border-brand/30",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "text-[8px] font-extrabold uppercase tracking-[0.12em]",
                      isNsVsNh
                        ? "text-amber-700 dark:text-amber-300"
                        : "text-brand-ink",
                    )}
                  >
                    {isNsVsNh && serviceOptionB?.dayType === "NH"
                      ? "Niedziela handlowa (NH · B)"
                      : isNsVsNh && serviceOptionB?.dayType === "NS"
                        ? "Niedziela niehandlowa / święto (NS · B)"
                        : "Wersja docelowa (nowa · B)"}
                  </span>
                  <button
                    type="button"
                    data-testid="schedule-diff-upload-b"
                    disabled={uploadingSide !== null}
                    onClick={() => handleTriggerZipUpload("B")}
                    className="flex items-center gap-1 text-[8px] font-bold text-brand-ink hover:underline disabled:opacity-50"
                  >
                    {uploadingSide === "B" ? (
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    ) : (
                      <Upload className="h-2.5 w-2.5" />
                    )}
                    Wgraj ZIP (B)
                  </button>
                </div>

                {archives.length > 1 && (
                  <select
                    aria-label="Źródło wersji B"
                    value={archiveB?.id ?? ""}
                    onChange={(e) => {
                      const next = archives.find((a) => a.id === e.target.value);
                      if (!next) return;
                      setArchiveIdB(next.id);
                      const firstSvc =
                        next.services.find((s) => s.dayType === "RS") ??
                        next.services[0];
                      if (firstSvc) setServiceIdB(firstSvc.serviceId);
                    }}
                    className="mt-1 h-7 w-full rounded border border-line bg-raised px-2 text-[9px] font-semibold text-ink outline-none"
                  >
                    {archives.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                )}

                <select
                  data-testid="schedule-diff-service-b"
                  aria-label="Okres i typ dnia dla wersji B"
                  value={serviceOptionB?.serviceId ?? ""}
                  onChange={(e) => {
                    setServiceIdB(e.target.value);
                    setTripPageLimit(INITIAL_TRIP_PAGE_SIZE);
                    setExpandedBrigadeKey(null);
                  }}
                  className="mt-1 h-8 w-full rounded-md border border-line bg-raised px-2 text-[10px] font-bold text-ink outline-none focus:border-brand/60"
                >
                  {(archiveB?.services ?? []).map((svc) => (
                    <option key={svc.serviceId} value={svc.serviceId}>
                      {svc.serviceId} · {svc.label} ({formatYyyymmdd(svc.fromDate)}–
                      {formatYyyymmdd(svc.toDate)}) · {svc.tripCount} kursów
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Szybkie przełączniki typu dnia dla pary okresów (np. 387 vs 388) */}
            {quickDayTypes.length > 0 && serviceOptionA && serviceOptionB && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[8px] font-extrabold uppercase tracking-[0.1em] text-mute">
                  Typ dnia ({serviceOptionA.periodId} vs {serviceOptionB.periodId}):
                </span>
                {quickDayTypes.map((dt) => {
                  const active = activeQuickDayType === dt;
                  return (
                    <button
                      key={dt}
                      type="button"
                      data-testid={`schedule-diff-daytype-${dt}`}
                      onClick={() => handleSelectQuickDayType(dt)}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-[8.5px] font-extrabold transition-colors",
                        active
                          ? "border-brand bg-brand text-on-brand"
                          : "border-line bg-surface text-ink-soft hover:border-brand/50 hover:text-ink",
                      )}
                    >
                      {dayTypeLabel(dt)}
                    </button>
                  );
                })}
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="rounded-md border border-warning/30 bg-warning-soft px-2.5 py-1.5 text-[9.5px] font-bold text-warning"
              >
                {error}
              </div>
            )}

            {sameSelection && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[9px] font-semibold text-amber-800 dark:text-amber-200">
                Wybrano ten sam rozkład po obu stronach. Wybierz inny okres (np.
                387 vs 388), inny typ dnia albo wgraj drugą paczkę GTFS (.zip).
              </div>
            )}
          </div>

          {diff && (
            <>
              {/* ── Dedykowane podsumowanie różnic NS → NH ─────────── */}
              {nsNhSummary && (
                <div
                  className="shrink-0 space-y-1.5 border-b border-amber-500/25 bg-amber-500/8 px-3.5 py-2"
                  data-testid="schedule-diff-ns-nh-summary"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 text-[9px] font-extrabold uppercase tracking-[0.08em] text-amber-800 dark:text-amber-200">
                      <ShoppingBag className="h-3 w-3" />
                      Podsumowanie różnic{" "}
                      {serviceOptionA?.dayType === "NS" ? "NS → NH" : "NH → NS"}
                    </span>
                    <span className="text-[9px] font-bold text-ink">
                      Zmienione linie:{" "}
                      <strong>{nsNhSummary.changedLines.length}</strong>
                    </span>
                    <span className="text-[9px] text-mute">
                      · Bez zmian (identyczne):{" "}
                      <strong>{nsNhSummary.unchangedLines.length}</strong>
                    </span>
                    {nsNhSummary.changedLines.length === 0 && (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[8.5px] font-bold text-emerald-700 dark:text-emerald-300">
                        Rozkłady NS i NH są identyczne
                      </span>
                    )}
                  </div>

                  {nsNhSummary.changedLines.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {nsNhSummary.changedLines.map((line) => {
                        const selected = lineFilter === line.routeShort;
                        return (
                          <button
                            key={line.routeShort}
                            type="button"
                            data-testid={`ns-nh-changed-line-${line.routeShort}`}
                            onClick={() => drillIntoLine(line.routeShort, "trips")}
                            title={`Pokaż szczegółowe różnice kursów linii ${line.routeShort}`}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[9px] font-bold transition-colors",
                              selected
                                ? "border-brand bg-brand-soft text-brand-ink"
                                : "border-line bg-surface text-ink hover:border-amber-500/60",
                            )}
                          >
                            <span
                              className="inline-flex h-4 min-w-[20px] items-center justify-center rounded px-1 text-[8.5px] font-black"
                              style={{
                                backgroundColor: line.color,
                                color: line.textColor,
                              }}
                            >
                              {line.routeShort}
                            </span>
                            {line.status === "added" && (
                              <span className="rounded bg-emerald-500/15 px-1 text-[7.5px] font-extrabold text-emerald-700 dark:text-emerald-300">
                                tylko w {serviceOptionB?.dayType ?? "NH"}
                              </span>
                            )}
                            <span
                              className={cn(
                                "metric font-extrabold",
                                deltaToneClass(line.tripsDelta),
                              )}
                            >
                              {formatDeltaInt(line.tripsDelta)} kurs.
                            </span>
                            <span className="metric text-[8.5px] text-mute">
                              ({formatDeltaKm(line.metersDelta)} km)
                            </span>
                            {line.changedCount > 0 && (
                              <span className="rounded bg-amber-500/15 px-1 text-[7.5px] font-extrabold text-amber-800 dark:text-amber-200">
                                ~{line.changedCount} zm.
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {nsNhSummary.distinctNewRelations.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 text-[8.5px]">
                      <span className="font-bold text-ink-soft">
                        Dodatkowe / zmienione relacje w{" "}
                        {serviceOptionB?.dayType ?? "B"}:
                      </span>
                      {nsNhSummary.distinctNewRelations.slice(0, 6).map((rel) => (
                        <button
                          key={`${rel.routeShort}-${rel.relation}`}
                          type="button"
                          onClick={() => drillIntoLine(rel.routeShort, "trips")}
                          className="inline-flex items-center gap-1 rounded border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 font-semibold text-emerald-800 hover:bg-emerald-500/20 dark:text-emerald-200"
                        >
                          <span
                            className="inline-flex h-3.5 min-w-[16px] items-center justify-center rounded px-1 text-[7.5px] font-black"
                            style={{
                              backgroundColor: rel.color,
                              color: rel.textColor,
                            }}
                          >
                            {rel.routeShort}
                          </span>
                          <span>{rel.relation}</span>
                          <span className="metric font-extrabold">
                            ({rel.count}×)
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {nsNhSummary.unchangedLines.length > 0 && (
                    <div className="text-[8px] text-mute">
                      Linie identyczne w NS i NH:{" "}
                      <span className="font-semibold text-ink-soft">
                        {nsNhSummary.unchangedLines
                          .map((l) => l.routeShort)
                          .join(", ")}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* ── Karty podsumowania KPI ──────────────────────────── */}
              <div
                className="grid shrink-0 grid-cols-2 gap-1.5 border-b border-line bg-surface px-3.5 py-2 sm:grid-cols-3 lg:grid-cols-6"
                data-testid="schedule-diff-summary"
              >
                <div className="rounded-lg border border-line bg-raised/50 px-2.5 py-1.5">
                  <div className="text-[7.5px] font-bold uppercase tracking-[0.08em] text-mute">
                    Kursy ogółem
                  </div>
                  <div className="metric mt-0.5 text-[11.5px] font-extrabold text-ink">
                    {diff.totals.tripsOld} → {diff.totals.tripsNew}
                  </div>
                  <div
                    className={cn(
                      "metric text-[9px] font-extrabold",
                      deltaToneClass(diff.totals.tripsDelta),
                    )}
                  >
                    Δ {formatDeltaInt(diff.totals.tripsDelta)}
                  </div>
                </div>

                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/8 px-2.5 py-1.5">
                  <div className="text-[7.5px] font-bold uppercase tracking-[0.08em] text-emerald-700 dark:text-emerald-300">
                    Dodane kursy
                  </div>
                  <div
                    className="metric mt-0.5 text-[14px] font-extrabold text-emerald-700 dark:text-emerald-300"
                    data-testid="schedule-diff-added-count"
                  >
                    +{diff.totals.addedCount}
                  </div>
                  <div className="text-[7.5px] text-mute">nowe w wersji B</div>
                </div>

                <div className="rounded-lg border border-rose-500/30 bg-rose-500/8 px-2.5 py-1.5">
                  <div className="text-[7.5px] font-bold uppercase tracking-[0.08em] text-rose-700 dark:text-rose-300">
                    Usunięte kursy
                  </div>
                  <div
                    className="metric mt-0.5 text-[14px] font-extrabold text-rose-700 dark:text-rose-300"
                    data-testid="schedule-diff-removed-count"
                  >
                    −{diff.totals.removedCount}
                  </div>
                  <div className="text-[7.5px] text-mute">zniknęły z A</div>
                </div>

                <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 px-2.5 py-1.5">
                  <div className="text-[7.5px] font-bold uppercase tracking-[0.08em] text-amber-700 dark:text-amber-300">
                    Zmienione kursy
                  </div>
                  <div
                    className="metric mt-0.5 text-[14px] font-extrabold text-amber-700 dark:text-amber-300"
                    data-testid="schedule-diff-changed-count"
                  >
                    ~{diff.totals.changedCount}
                  </div>
                  <div className="truncate text-[7.5px] text-mute">
                    {diff.totals.timeShiftedCount} godz. ·{" "}
                    {diff.totals.routeChangedCount} tras ·{" "}
                    {diff.totals.brigadeChangedCount} bryg.
                  </div>
                </div>

                <div className="rounded-lg border border-line bg-raised/50 px-2.5 py-1.5">
                  <div className="text-[7.5px] font-bold uppercase tracking-[0.08em] text-mute">
                    Wozokilometry
                  </div>
                  <div className="metric mt-0.5 truncate text-[10.5px] font-extrabold text-ink">
                    {formatKm(diff.totals.metersOld)} →{" "}
                    {formatKm(diff.totals.metersNew)}
                  </div>
                  <div
                    className={cn(
                      "metric text-[9px] font-extrabold",
                      deltaToneClass(diff.totals.metersDelta),
                    )}
                    data-testid="schedule-diff-km-delta"
                  >
                    {formatDeltaKm(diff.totals.metersDelta)}
                  </div>
                </div>

                <div className="rounded-lg border border-line bg-raised/50 px-2.5 py-1.5">
                  <div className="text-[7.5px] font-bold uppercase tracking-[0.08em] text-mute">
                    Brygady / Linie
                  </div>
                  <div className="metric mt-0.5 text-[11.5px] font-extrabold text-ink">
                    {diff.totals.brigadesOld} → {diff.totals.brigadesNew} bryg.
                  </div>
                  <div className="text-[8px] font-semibold text-mute">
                    {diff.totals.linesWithChanges} z {diff.lines.length} linii ze
                    zmianami
                  </div>
                </div>
              </div>

              {/* ── Zakładki i filtry ───────────────────────────────── */}
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-raised/35 px-3.5 py-2">
                <div
                  className="flex rounded-lg border border-line bg-surface p-0.5"
                  role="tablist"
                >
                  {(
                    [
                      {
                        id: "lines",
                        label: `Linie (${diff.totals.linesWithChanges})`,
                        icon: RouteIcon,
                      },
                      {
                        id: "trips",
                        label: `Kursy (${diff.totals.addedCount + diff.totals.removedCount + diff.totals.changedCount})`,
                        icon: Clock,
                      },
                      {
                        id: "brigades",
                        label: `Brygady i wzkm (${diff.brigades.filter((b) => b.status !== "unchanged").length})`,
                        icon: Bus,
                      },
                    ] as const
                  ).map((tab) => {
                    const Icon = tab.icon;
                    const active = activeTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        data-testid={`schedule-diff-tab-${tab.id}`}
                        onClick={() => setActiveTab(tab.id)}
                        className={cn(
                          "flex h-7 items-center gap-1 rounded-md px-2.5 text-[9.5px] font-extrabold transition-colors",
                          active
                            ? "bg-brand text-on-brand"
                            : "text-ink-soft hover:text-ink",
                        )}
                      >
                        <Icon className="h-3 w-3 shrink-0" />
                        {tab.label}
                      </button>
                    );
                  })}
                </div>

                {/* Filtr linii */}
                <select
                  data-testid="schedule-diff-line-filter"
                  aria-label="Filtruj po linii"
                  value={lineFilter}
                  onChange={(e) => {
                    setLineFilter(e.target.value);
                    setTripPageLimit(INITIAL_TRIP_PAGE_SIZE);
                  }}
                  className="h-7 rounded-md border border-line bg-surface px-2 text-[9.5px] font-bold text-ink outline-none focus:border-brand/60"
                >
                  <option value="ALL">Wszystkie linie ({diff.lines.length})</option>
                  {diff.lines.map((line) => (
                    <option key={line.routeShort} value={line.routeShort}>
                      Linia {line.routeShort}
                      {line.status !== "unchanged"
                        ? ` (+${line.addedCount} / −${line.removedCount} / ~${line.changedCount})`
                        : " (bez zmian)"}
                    </option>
                  ))}
                </select>

                {/* Filtr typu zmian w zakładce Kursy */}
                {activeTab === "trips" && (
                  <div className="flex flex-wrap items-center gap-1">
                    {(
                      [
                        { id: "all-changes", label: "Wszystkie zmiany" },
                        { id: "added", label: "+ Dodane" },
                        { id: "removed", label: "− Usunięte" },
                        { id: "changed", label: "~ Zmienione" },
                        { id: "time-shifted", label: "Przesunięte godz." },
                      ] as const
                    ).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        data-testid={`schedule-diff-trip-filter-${f.id}`}
                        onClick={() => {
                          setTripKindFilter(f.id);
                          setTripPageLimit(INITIAL_TRIP_PAGE_SIZE);
                        }}
                        className={cn(
                          "h-7 rounded-md border px-2 text-[8.5px] font-bold transition-colors",
                          tripKindFilter === f.id
                            ? "border-brand bg-brand/12 text-brand-ink"
                            : "border-line bg-surface text-ink-soft hover:text-ink",
                        )}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                )}

                {/* Sortowanie w zakładce Brygady */}
                {activeTab === "brigades" && (
                  <select
                    aria-label="Sortuj brygady"
                    value={brigadeSort}
                    onChange={(e) =>
                      setBrigadeSort(e.target.value as BrigadeSortKey)
                    }
                    className="h-7 rounded-md border border-line bg-surface px-2 text-[9px] font-bold text-ink outline-none"
                  >
                    <option value="km-abs">Sortuj: największa różnica wzkm</option>
                    <option value="km-desc">Sortuj: przyrost wzkm malejąco</option>
                    <option value="trips">Sortuj: zmiana liczby kursów</option>
                    <option value="code">Sortuj: numer linii / brygady</option>
                  </select>
                )}

                {/* Przełącznik „Tylko ze zmianami” (Linie i Brygady) */}
                {activeTab !== "trips" && (
                  <label className="flex cursor-pointer items-center gap-1.5 text-[9px] font-semibold text-ink-soft">
                    <input
                      type="checkbox"
                      checked={onlyChanged}
                      onChange={(e) => setOnlyChanged(e.target.checked)}
                      className="h-3.5 w-3.5 accent-brand"
                    />
                    Tylko ze zmianami
                  </label>
                )}

                {/* Wyszukiwarka */}
                <div className="ml-auto flex h-7 min-w-[170px] items-center gap-1.5 rounded-md border border-line bg-surface px-2 focus-within:border-brand/60">
                  <Search className="h-3 w-3 shrink-0 text-mute" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Szukaj linii, brygady, przystanku…"
                    aria-label="Szukaj w różnicach rozkładu"
                    className="min-w-0 flex-1 bg-transparent text-[9.5px] font-semibold text-ink outline-none placeholder:text-mute"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      aria-label="Wyczyść szukanie"
                      className="text-mute hover:text-ink"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>

              {/* ── Zawartość aktywnej zakładki ─────────────────────── */}
              <div className="scroll-area min-h-0 flex-1 overflow-y-auto px-3.5 py-2.5">
                {/* 1. TAB: LINIE */}
                {activeTab === "lines" && (
                  <div className="space-y-1.5">
                    {filteredLines.length === 0 ? (
                      <div className="rounded-xl border border-line bg-raised/40 p-8 text-center text-[10.5px] text-mute">
                        Brak różnic w liniach dla wybranych filtrów.
                        {onlyChanged && (
                          <button
                            type="button"
                            onClick={() => setOnlyChanged(false)}
                            className="ml-2 font-bold text-brand-ink hover:underline"
                          >
                            Pokaż także linie bez zmian
                          </button>
                        )}
                      </div>
                    ) : (
                      filteredLines.map((line) => {
                        const badge = statusBadgeMeta(line.status);
                        return (
                          <div
                            key={line.routeShort}
                            data-testid={`schedule-diff-line-${line.routeShort}`}
                            className="flex flex-wrap items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2 transition-colors hover:border-line-strong"
                          >
                            <span
                              className="metric grid h-8 min-w-[38px] shrink-0 place-items-center rounded-md px-2 text-[12px] font-extrabold"
                              style={{
                                backgroundColor: line.color,
                                color: line.textColor,
                              }}
                            >
                              {line.routeShort}
                            </span>

                            <span
                              className={cn(
                                "shrink-0 rounded-full border px-2 py-0.5 text-[8px] font-extrabold uppercase",
                                badge.className,
                              )}
                            >
                              {badge.label}
                            </span>

                            <div className="min-w-[140px] flex-1">
                              <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold text-ink">
                                <span className="metric">
                                  Kursy: {line.tripsOld} → {line.tripsNew} (
                                  <span className={deltaToneClass(line.tripsDelta)}>
                                    {formatDeltaInt(line.tripsDelta)}
                                  </span>
                                  )
                                </span>
                                <span className="flex items-center gap-1 text-[8.5px] font-extrabold">
                                  {line.addedCount > 0 && (
                                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">
                                      +{line.addedCount}
                                    </span>
                                  )}
                                  {line.removedCount > 0 && (
                                    <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-rose-700 dark:text-rose-300">
                                      −{line.removedCount}
                                    </span>
                                  )}
                                  {line.changedCount > 0 && (
                                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
                                      ~{line.changedCount}
                                    </span>
                                  )}
                                </span>
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-3 text-[8.5px] font-semibold text-mute">
                                <span className="metric">
                                  Brygady: {line.brigadesOld} → {line.brigadesNew} (
                                  <span
                                    className={deltaToneClass(line.brigadesDelta)}
                                  >
                                    {formatDeltaInt(line.brigadesDelta)}
                                  </span>
                                  )
                                </span>
                                <span className="metric">
                                  Wzkm: {formatKm(line.metersOld)} →{" "}
                                  {formatKm(line.metersNew)}{" "}
                                  <strong
                                    className={deltaToneClass(line.metersDelta)}
                                  >
                                    ({formatDeltaKm(line.metersDelta)})
                                  </strong>
                                </span>
                              </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={() =>
                                  drillIntoLine(line.routeShort, "trips")
                                }
                                className="flex h-7 items-center gap-1 rounded-md border border-line bg-raised px-2 text-[8.5px] font-bold text-ink-soft hover:border-brand/50 hover:text-brand-ink"
                              >
                                <Clock className="h-3 w-3" />
                                Kursy
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  drillIntoLine(line.routeShort, "brigades")
                                }
                                className="flex h-7 items-center gap-1 rounded-md border border-line bg-raised px-2 text-[8.5px] font-bold text-ink-soft hover:border-brand/50 hover:text-brand-ink"
                              >
                                <Bus className="h-3 w-3" />
                                Brygady
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}

                {/* 2. TAB: KURSY */}
                {activeTab === "trips" && (
                  <div className="space-y-1.5">
                    {filteredTrips.length === 0 ? (
                      <div className="rounded-xl border border-line bg-raised/40 p-8 text-center text-[10.5px] text-mute">
                        Brak zmienionych kursów pasujących do wybranych filtrów.
                      </div>
                    ) : (
                      <>
                        <div className="text-[8.5px] font-semibold text-mute">
                          Wyświetlono {visibleTrips.length} z{" "}
                          {filteredTrips.length} kursów
                        </div>
                        {visibleTrips.map((item) => (
                          <TripDiffRow key={item.id} item={item} />
                        ))}
                        {visibleTrips.length < filteredTrips.length && (
                          <button
                            type="button"
                            onClick={() =>
                              setTripPageLimit((prev) => prev + 200)
                            }
                            className="flex h-8 w-full items-center justify-center rounded-lg border border-line bg-raised text-[9.5px] font-bold text-brand-ink hover:border-brand/50"
                          >
                            Pokaż kolejne kursy (pozostało{" "}
                            {filteredTrips.length - visibleTrips.length})
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* 3. TAB: BRYGADY I WOZOKILOMETRY */}
                {activeTab === "brigades" && (
                  <div className="space-y-1.5">
                    {filteredBrigades.length === 0 ? (
                      <div className="rounded-xl border border-line bg-raised/40 p-8 text-center text-[10.5px] text-mute">
                        Brak brygad ze zmianami dla wybranych filtrów.
                        {onlyChanged && (
                          <button
                            type="button"
                            onClick={() => setOnlyChanged(false)}
                            className="ml-2 font-bold text-brand-ink hover:underline"
                          >
                            Pokaż także brygady bez zmian
                          </button>
                        )}
                      </div>
                    ) : (
                      filteredBrigades.map((brigade) => (
                        <BrigadeDiffCard
                          key={brigade.key}
                          brigade={brigade}
                          expanded={expandedBrigadeKey === brigade.key}
                          onToggle={() =>
                            setExpandedBrigadeKey((prev) =>
                              prev === brigade.key ? null : brigade.key,
                            )
                          }
                        />
                      ))
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

function TripDiffRow({ item }: { item: TripDiffItem }) {
  const badge = tripKindBadge(item.kind);
  const ot = item.oldTrip;
  const nt = item.newTrip;

  return (
    <div
      data-testid={`schedule-diff-trip-${item.kind}`}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[9.5px]"
    >
      <span
        className={cn(
          "shrink-0 rounded border px-1.5 py-0.5 text-[8px] font-extrabold",
          badge.className,
        )}
      >
        {badge.label}
      </span>

      <span
        className="metric grid h-6 min-w-[28px] shrink-0 place-items-center rounded px-1.5 text-[10px] font-extrabold"
        style={{
          backgroundColor: item.routeColor,
          color: item.routeTextColor,
        }}
      >
        {item.routeShort}
      </span>

      {/* Brygada */}
      <span className="metric shrink-0 rounded border border-line bg-raised px-1.5 py-0.5 text-[8.5px] font-bold text-ink-soft">
        {item.brigadeChanged && ot && nt ? (
          <span>
            {ot.kursowkaCode || "—"} →{" "}
            <strong className="text-amber-700 dark:text-amber-300">
              {nt.kursowkaCode || "—"}
            </strong>
          </span>
        ) : (
          nt?.kursowkaCode || ot?.kursowkaCode || "bez bryg."
        )}
      </span>

      {/* Godziny odjazdu / przyjazdu */}
      <div className="metric flex shrink-0 items-center gap-1 font-extrabold text-ink">
        {item.kind === "added" && nt && (
          <span className="text-emerald-700 dark:text-emerald-300">
            {minutesToClock(nt.startMinutes)}–{minutesToClock(nt.endMinutes)}
          </span>
        )}
        {item.kind === "removed" && ot && (
          <span className="text-rose-700 line-through dark:text-rose-300">
            {minutesToClock(ot.startMinutes)}–{minutesToClock(ot.endMinutes)}
          </span>
        )}
        {item.kind === "changed" && ot && nt && (
          <>
            {item.departureDeltaMin !== 0 ? (
              <>
                <span className="text-mute line-through">
                  {minutesToClock(ot.startMinutes)}
                </span>
                <ArrowRight className="h-2.5 w-2.5 text-mute" />
                <span className="text-ink">{minutesToClock(nt.startMinutes)}</span>
                <span className="rounded bg-amber-500/18 px-1 py-0.5 text-[8px] font-extrabold text-amber-800 dark:text-amber-200">
                  {formatMinutesDelta(item.departureDeltaMin)}
                </span>
              </>
            ) : (
              <span>
                {minutesToClock(nt.startMinutes)}–{minutesToClock(nt.endMinutes)}
                {item.arrivalDeltaMin !== 0 && (
                  <span className="ml-1 rounded bg-amber-500/15 px-1 py-0.5 text-[8px] text-amber-700 dark:text-amber-300">
                    przyj. {formatMinutesDelta(item.arrivalDeltaMin)}
                  </span>
                )}
              </span>
            )}
          </>
        )}
      </div>

      {/* Trasa (przystanek początkowy -> końcowy) */}
      <div className="min-w-[160px] flex-1">
        {item.kind === "changed" && item.routeChanged && ot && nt ? (
          <div className="space-y-0.5 text-[8.5px]">
            <div className="truncate text-mute line-through">
              {ot.firstStopName} → {ot.lastStopName} ({ot.stopCount} przyst.)
            </div>
            <div className="truncate font-bold text-ink">
              {nt.firstStopName} → {nt.lastStopName} ({nt.stopCount} przyst.)
            </div>
          </div>
        ) : (
          <div className="truncate text-[9px] font-semibold text-ink-soft">
            {(nt ?? ot)!.firstStopName} → {(nt ?? ot)!.lastStopName}{" "}
            <span className="text-[8px] text-mute">
              ({(nt ?? ot)!.stopCount} przyst.)
            </span>
          </div>
        )}
      </div>

      {/* Długość / zmiana km */}
      <div className="metric shrink-0 text-right text-[8.5px] font-bold">
        {item.kind === "added" && nt && (
          <span className="text-emerald-700 dark:text-emerald-300">
            +{formatKm(nt.lengthMeters)}
          </span>
        )}
        {item.kind === "removed" && ot && (
          <span className="text-rose-700 dark:text-rose-300">
            −{formatKm(ot.lengthMeters)}
          </span>
        )}
        {item.kind === "changed" && (
          <span className={deltaToneClass(item.lengthDeltaMeters)}>
            {Math.abs(item.lengthDeltaMeters) >= 50
              ? formatDeltaKm(item.lengthDeltaMeters)
              : formatKm((nt ?? ot)!.lengthMeters)}
          </span>
        )}
      </div>
    </div>
  );
}

function BrigadeDiffCard({
  brigade,
  expanded,
  onToggle,
}: {
  brigade: BrigadeScheduleDiff;
  expanded: boolean;
  onToggle: () => void;
}) {
  const badge = statusBadgeMeta(brigade.status);
  const canExpand = brigade.tripDiffs.length > 0;

  return (
    <div
      data-testid={`schedule-diff-brigade-${brigade.brigadeCode}`}
      className="rounded-xl border border-line bg-surface"
    >
      <button
        type="button"
        onClick={canExpand ? onToggle : undefined}
        className={cn(
          "flex w-full flex-wrap items-center gap-2.5 px-3 py-2 text-left",
          canExpand && "cursor-pointer hover:bg-raised/40",
        )}
      >
        <span
          className="metric grid h-7 min-w-[34px] shrink-0 place-items-center rounded px-1.5 text-[11px] font-extrabold"
          style={{
            backgroundColor: brigade.routeColor,
            color: brigade.routeTextColor,
          }}
        >
          {brigade.routeShort}
        </span>

        <div className="min-w-[95px]">
          <div className="flex items-center gap-1.5">
            <span className="metric text-[11px] font-extrabold text-ink">
              {brigade.brigadeCode}
            </span>
            {brigade.operatorKey && (
              <span className="rounded bg-raised px-1 py-0.5 text-[7.5px] font-extrabold text-mute">
                {brigade.operatorKey}
              </span>
            )}
          </div>
          <span
            className={cn(
              "mt-0.5 inline-block rounded-full border px-1.5 py-px text-[7.5px] font-extrabold uppercase",
              badge.className,
            )}
          >
            {badge.label}
          </span>
        </div>

        {/* Godziny pracy i kursy */}
        <div className="min-w-[150px] flex-1 space-y-0.5 text-[8.5px]">
          <div className="flex flex-wrap items-center gap-2 font-bold text-ink">
            <span className="metric">
              Kursy: {brigade.tripsOld} → {brigade.tripsNew} (
              <span className={deltaToneClass(brigade.tripsDelta)}>
                {formatDeltaInt(brigade.tripsDelta)}
              </span>
              )
            </span>
            {brigade.addedTrips > 0 && (
              <span className="inline-flex items-center rounded bg-emerald-500/15 px-1 py-px text-[8px] font-extrabold text-emerald-700 dark:text-emerald-300">
                <Plus className="h-2.5 w-2.5" />
                {brigade.addedTrips}
              </span>
            )}
            {brigade.removedTrips > 0 && (
              <span className="inline-flex items-center rounded bg-rose-500/15 px-1 py-px text-[8px] font-extrabold text-rose-700 dark:text-rose-300">
                <Minus className="h-2.5 w-2.5" />
                {brigade.removedTrips}
              </span>
            )}
            {brigade.changedTrips > 0 && (
              <span className="rounded bg-amber-500/15 px-1 py-px text-[8px] font-extrabold text-amber-700 dark:text-amber-300">
                ~{brigade.changedTrips}
              </span>
            )}
          </div>
          <div className="metric text-mute">
            Godz. pracy: {formatWorkSpan(brigade.firstDepOld, brigade.lastArrOld)}{" "}
            → {formatWorkSpan(brigade.firstDepNew, brigade.lastArrNew)}
          </div>
        </div>

        {/* Wozokilometry */}
        <div className="metric shrink-0 text-right">
          <div className="text-[9.5px] font-bold text-ink">
            {formatKm(brigade.metersOld)} → {formatKm(brigade.metersNew)}
          </div>
          <div
            className={cn(
              "text-[10px] font-extrabold",
              deltaToneClass(brigade.metersDelta),
            )}
          >
            {formatDeltaKm(brigade.metersDelta)}
            {brigade.metersDeltaPct !== null &&
              Math.abs(brigade.metersDeltaPct) >= 0.1 && (
                <span className="ml-1 text-[8.5px]">
                  ({brigade.metersDeltaPct > 0 ? "+" : ""}
                  {brigade.metersDeltaPct.toFixed(1).replace(".", ",")}%)
                </span>
              )}
          </div>
        </div>

        {canExpand && (
          <span className="shrink-0 text-mute">
            {expanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </span>
        )}
      </button>

      {expanded && brigade.tripDiffs.length > 0 && (
        <div className="space-y-1 border-t border-line bg-raised/35 px-3 py-2">
          <div className="text-[8px] font-extrabold uppercase tracking-[0.08em] text-mute">
            Zmienione kursy w brygadzie {brigade.brigadeCode} (
            {brigade.tripDiffs.length})
          </div>
          {brigade.tripDiffs.map((item) => (
            <TripDiffRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
