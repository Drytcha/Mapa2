import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Eye,
  Loader2,
  MapPinned,
  Pencil,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import { onRuntimeEvent } from "@/lib/core/runtimeHub";
import { foldPolish } from "@/lib/core/text";
import {
  buildAuditMapOverlay,
  exportRouteAuditCsv,
  issueKindLabel,
  runRouteQualityAudit,
  type RouteAuditIssueKind,
  type RouteAuditSeverity,
  type RouteQualityAuditReport,
  type VariantQualityAudit,
} from "@/lib/engine/routeQualityAudit";
import { cn } from "@/utils/cn";
import type { KursowkaShapeOverlay } from "./MapView";
import { Dialog } from "./Modals";

interface RouteAuditDialogProps {
  open: boolean;
  onClose: () => void;
  onFixInEditor: (lineShort: string, variantKey: string) => void;
  onShowOnMap: (overlay: KursowkaShapeOverlay) => void;
  onToast?: (message: string) => void;
}

type SeverityFilter = "issues" | "error" | "warning" | "all";
type IssueKindFilter = "ALL" | RouteAuditIssueKind;

function formatKm(meters: number): string {
  return `${(meters / 1000).toLocaleString("pl-PL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} km`;
}

function severityMeta(severity: RouteAuditSeverity): {
  label: string;
  badgeClass: string;
  borderClass: string;
} {
  switch (severity) {
    case "error":
      return {
        label: "Błąd",
        badgeClass:
          "border-rose-500/40 bg-rose-500/12 text-rose-700 dark:text-rose-300",
        borderClass: "border-rose-500/30",
      };
    case "warning":
      return {
        label: "Ostrzeżenie",
        badgeClass:
          "border-amber-500/40 bg-amber-500/12 text-amber-700 dark:text-amber-300",
        borderClass: "border-amber-500/30",
      };
    default:
      return {
        label: "OK",
        badgeClass:
          "border-emerald-500/40 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
        borderClass: "border-line",
      };
  }
}

export default function RouteAuditDialog({
  open,
  onClose,
  onFixInEditor,
  onShowOnMap,
  onToast,
}: RouteAuditDialogProps) {
  const [report, setReport] = useState<RouteQualityAuditReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("issues");
  const [kindFilter, setKindFilter] = useState<IssueKindFilter>("ALL");
  const [lineFilter, setLineFilter] = useState<string>("ALL");
  const [onlyMain, setOnlyMain] = useState(false);
  const [hideCustomized, setHideCustomized] = useState(false);
  const [query, setQuery] = useState("");

  const scan = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await runRouteQualityAudit();
      setReport(next);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Nie udało się przeskanować przebiegów tras GTFS.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void scan();
    const unsubGtfs = onRuntimeEvent("gtfs:updated", () => {
      void scan();
    });
    const unsubOverrides = onRuntimeEvent("routes:overrides-updated", () => {
      void scan();
    });
    return () => {
      unsubGtfs();
      unsubOverrides();
    };
  }, [open, scan]);

  const foldedQuery = useMemo(() => foldPolish(query.trim()), [query]);

  const filteredVariants = useMemo(() => {
    if (!report) return [];
    return report.variants.filter((v) => {
      if (severityFilter === "issues" && v.severity === "ok") return false;
      if (severityFilter === "error" && v.severity !== "error") return false;
      if (severityFilter === "warning" && v.severity !== "warning") return false;
      if (kindFilter !== "ALL" && !v.issues.some((i) => i.kind === kindFilter)) {
        return false;
      }
      if (lineFilter !== "ALL" && v.lineShort !== lineFilter) return false;
      if (onlyMain && !v.main) return false;
      if (hideCustomized && v.customized) return false;
      if (foldedQuery) {
        const hay = foldPolish(
          [
            v.lineShort,
            v.firstStop,
            v.lastStop,
            v.headsign,
            ...v.issues.map((i) => `${i.title} ${i.detail}`),
          ].join(" "),
        );
        if (!hay.includes(foldedQuery)) return false;
      }
      return true;
    });
  }, [
    report,
    severityFilter,
    kindFilter,
    lineFilter,
    onlyMain,
    hideCustomized,
    foldedQuery,
  ]);

  const problematicFiltered = useMemo(
    () => filteredVariants.filter((v) => v.severity !== "ok"),
    [filteredVariants],
  );

  const handleShowAllErrorsOnMap = () => {
    if (!problematicFiltered.length) {
      onToast?.("Brak błędnych wariantów do wyświetlenia dla obecnych filtrów.");
      return;
    }
    const overlay = buildAuditMapOverlay(
      problematicFiltered,
      lineFilter === "ALL"
        ? `Mapa błędów GTFS (${Math.min(problematicFiltered.length, 25)} wariantów)`
        : `Mapa błędów linii ${lineFilter} (${problematicFiltered.length} wariantów)`,
      "#dc2626",
    );
    onShowOnMap(overlay);
    onClose();
  };

  const handleShowVariantOnMap = (variant: VariantQualityAudit) => {
    const overlay = buildAuditMapOverlay(
      [variant],
      `Audyt linii ${variant.lineShort} · ${variant.firstStop} → ${variant.lastStop}`,
      variant.severity === "error" ? "#dc2626" : variant.lineColor,
    );
    onShowOnMap(overlay);
    onClose();
  };

  const handleExportCsv = () => {
    if (!report) return;
    const csv = exportRouteAuditCsv(report);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "audyt-jakosci-tras-gtfs.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    onToast?.("Pobrano raport audytu jakości tras (CSV).");
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="Audyt jakości tras GTFS"
      className="duty-dialog-shell h-[94dvh] max-w-[1280px]"
    >
      {/* ── Nagłówek ───────────────────────────────────────────────── */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-rose-500/15 text-rose-600 dark:text-rose-300">
          <ShieldAlert className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-[13.5px] font-extrabold tracking-[-0.02em] text-ink">
            Audyt jakości tras GTFS („Mapa błędów”)
          </h2>
          <p className="hidden text-[8.5px] text-mute sm:block">
            Automatyczne skanowanie wszystkich linii: przystanki &gt; 60 m od
            trasy, skoki &gt; 120 m, zygzaki, brak shapes.txt i rozbieżność
            długości.
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="audit-show-map-all"
            disabled={!problematicFiltered.length}
            onClick={handleShowAllErrorsOnMap}
            className="flex h-7 items-center gap-1 rounded-md border border-rose-500/35 bg-rose-500/10 px-2.5 text-[9px] font-extrabold text-rose-700 transition-colors hover:border-rose-500/60 disabled:opacity-45 dark:text-rose-300"
          >
            <MapPinned className="h-3 w-3" />
            Mapa błędów ({problematicFiltered.length})
          </button>
          <button
            type="button"
            data-testid="audit-rescan"
            disabled={loading}
            onClick={() => void scan()}
            className="flex h-7 items-center gap-1 rounded-md border border-line bg-raised px-2 text-[9px] font-bold text-ink-soft hover:border-brand/50 hover:text-ink disabled:opacity-45"
          >
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            Skanuj
          </button>
          <button
            type="button"
            data-testid="audit-export-csv"
            disabled={!report}
            onClick={handleExportCsv}
            className="flex h-7 items-center gap-1 rounded-md border border-line bg-raised px-2 text-[9px] font-bold text-ink-soft hover:border-brand/50 hover:text-ink disabled:opacity-45"
          >
            <Download className="h-3 w-3" />
            CSV
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

      {loading && !report ? (
        <div
          role="status"
          className="flex flex-1 items-center justify-center gap-2 p-8 text-[11px] text-mute"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          Skanowanie geometrii wszystkich linii i przystanków GTFS…
        </div>
      ) : error && !report ? (
        <div
          role="alert"
          className="m-4 rounded-lg border border-warning/30 bg-warning-soft p-4 text-xs text-warning"
        >
          {error}
        </div>
      ) : report ? (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          data-testid="route-audit-dialog-body"
        >
          {/* ── Karty KPI (klikalne filtry) ─────────────────────────── */}
          <div className="grid shrink-0 grid-cols-2 gap-1.5 border-b border-line bg-surface px-3.5 py-2 sm:grid-cols-3 lg:grid-cols-6">
            <button
              type="button"
              onClick={() => {
                setSeverityFilter("error");
                setKindFilter("ALL");
              }}
              className={cn(
                "rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                severityFilter === "error" && kindFilter === "ALL"
                  ? "border-rose-500 bg-rose-500/15"
                  : "border-rose-500/30 bg-rose-500/8 hover:border-rose-500/55",
              )}
            >
              <div className="text-[7.5px] font-bold uppercase tracking-[0.08em] text-rose-700 dark:text-rose-300">
                Błędy krytyczne
              </div>
              <div
                className="metric mt-0.5 text-[15px] font-extrabold text-rose-700 dark:text-rose-300"
                data-testid="audit-error-count"
              >
                {report.errorVariants}
              </div>
              <div className="text-[7.5px] text-mute">wariantów do naprawy</div>
            </button>

            <button
              type="button"
              onClick={() => {
                setSeverityFilter("warning");
                setKindFilter("ALL");
              }}
              className={cn(
                "rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                severityFilter === "warning" && kindFilter === "ALL"
                  ? "border-amber-500 bg-amber-500/15"
                  : "border-amber-500/30 bg-amber-500/8 hover:border-amber-500/55",
              )}
            >
              <div className="text-[7.5px] font-bold uppercase tracking-[0.08em] text-amber-700 dark:text-amber-300">
                Ostrzeżenia
              </div>
              <div
                className="metric mt-0.5 text-[15px] font-extrabold text-amber-700 dark:text-amber-300"
                data-testid="audit-warning-count"
              >
                {report.warningVariants}
              </div>
              <div className="text-[7.5px] text-mute">do weryfikacji</div>
            </button>

            <button
              type="button"
              onClick={() => {
                setSeverityFilter("all");
                setKindFilter("ALL");
              }}
              className={cn(
                "rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                severityFilter === "all" && kindFilter === "ALL"
                  ? "border-emerald-500 bg-emerald-500/15"
                  : "border-emerald-500/30 bg-emerald-500/8 hover:border-emerald-500/55",
              )}
            >
              <div className="text-[7.5px] font-bold uppercase tracking-[0.08em] text-emerald-700 dark:text-emerald-300">
                Poprawne
              </div>
              <div
                className="metric mt-0.5 text-[15px] font-extrabold text-emerald-700 dark:text-emerald-300"
                data-testid="audit-ok-count"
              >
                {report.okVariants}
              </div>
              <div className="text-[7.5px] text-mute">
                z {report.totalVariants} ({report.customizedVariants} edyt.)
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setSeverityFilter("issues");
                setKindFilter(
                  kindFilter === "stop-off-route" ? "ALL" : "stop-off-route",
                );
              }}
              className={cn(
                "rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                kindFilter === "stop-off-route"
                  ? "border-brand bg-brand/12"
                  : "border-line bg-raised/50 hover:border-line-strong",
              )}
            >
              <div className="text-[7.5px] font-bold uppercase tracking-[0.08em] text-mute">
                Przystanki &gt; 60 m
              </div>
              <div className="metric mt-0.5 text-[14px] font-extrabold text-ink">
                {report.byKindCount["stop-off-route"]}
              </div>
              <div className="text-[7.5px] text-mute">poza linią trasy</div>
            </button>

            <button
              type="button"
              onClick={() => {
                setSeverityFilter("issues");
                setKindFilter(
                  kindFilter === "straight-jump" ? "ALL" : "straight-jump",
                );
              }}
              className={cn(
                "rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                kindFilter === "straight-jump" || kindFilter === "sharp-zigzag"
                  ? "border-brand bg-brand/12"
                  : "border-line bg-raised/50 hover:border-line-strong",
              )}
            >
              <div className="text-[7.5px] font-bold uppercase tracking-[0.08em] text-mute">
                Skoki / zygzaki
              </div>
              <div className="metric mt-0.5 text-[14px] font-extrabold text-ink">
                {report.byKindCount["straight-jump"]} /{" "}
                {report.byKindCount["sharp-zigzag"]}
              </div>
              <div className="text-[7.5px] text-mute">&gt; 120 m / cofki</div>
            </button>

            <button
              type="button"
              onClick={() => {
                setSeverityFilter("issues");
                setKindFilter(
                  kindFilter === "missing-shape" ? "ALL" : "missing-shape",
                );
              }}
              className={cn(
                "rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                kindFilter === "missing-shape" || kindFilter === "length-mismatch"
                  ? "border-brand bg-brand/12"
                  : "border-line bg-raised/50 hover:border-line-strong",
              )}
            >
              <div className="text-[7.5px] font-bold uppercase tracking-[0.08em] text-mute">
                Brak shape / długość
              </div>
              <div className="metric mt-0.5 text-[14px] font-extrabold text-ink">
                {report.byKindCount["missing-shape"]} /{" "}
                {report.byKindCount["length-mismatch"]}
              </div>
              <div className="text-[7.5px] text-mute">shapes.txt / proporcja</div>
            </button>
          </div>

          {/* ── Pasek linii ze statusem błędów ──────────────────────── */}
          <div className="shrink-0 space-y-1.5 border-b border-line bg-raised/35 px-3.5 py-2">
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => setLineFilter("ALL")}
                className={cn(
                  "h-6 rounded-md border px-2 text-[8.5px] font-extrabold transition-colors",
                  lineFilter === "ALL"
                    ? "border-brand bg-brand text-on-brand"
                    : "border-line bg-surface text-ink-soft hover:text-ink",
                )}
              >
                Wszystkie ({report.totalLines})
              </button>
              {report.lines.map((line) => {
                const active = lineFilter === line.lineShort;
                const issueCount = line.errorVariants + line.warningVariants;
                return (
                  <button
                    key={line.lineShort}
                    type="button"
                    data-testid={`audit-line-${line.lineShort}`}
                    onClick={() =>
                      setLineFilter(active ? "ALL" : line.lineShort)
                    }
                    className={cn(
                      "relative flex h-6 min-w-[30px] items-center justify-center gap-1 rounded-md px-1.5 text-[9.5px] font-extrabold transition-all",
                      active
                        ? "ring-2 ring-brand ring-offset-1 ring-offset-surface"
                        : issueCount === 0
                          ? "opacity-55 hover:opacity-100"
                          : "opacity-95 hover:opacity-100",
                    )}
                    style={{
                      backgroundColor: line.color,
                      color: line.textColor,
                    }}
                    title={`Linia ${line.lineShort}: ${line.errorVariants} błędów, ${line.warningVariants} ostrzeżeń`}
                  >
                    {line.lineShort}
                    {line.worstSeverity !== "ok" && (
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full border border-white",
                          line.worstSeverity === "error"
                            ? "bg-rose-500"
                            : "bg-amber-400",
                        )}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Filtry szczegółowe */}
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="flex flex-wrap items-center gap-1">
                {(
                  [
                    { id: "ALL", label: "Wszystkie typy" },
                    { id: "stop-off-route", label: "Przystanki > 60 m" },
                    { id: "straight-jump", label: "Skoki > 120 m" },
                    { id: "sharp-zigzag", label: "Zygzaki" },
                    { id: "missing-shape", label: "Brak shapes.txt" },
                    { id: "length-mismatch", label: "Długość trasy" },
                  ] as const
                ).map((pill) => (
                  <button
                    key={pill.id}
                    type="button"
                    data-testid={`audit-kind-${pill.id}`}
                    onClick={() => setKindFilter(pill.id)}
                    className={cn(
                      "h-6 rounded-md border px-2 text-[8.5px] font-bold transition-colors",
                      kindFilter === pill.id
                        ? "border-brand bg-brand/12 text-brand-ink"
                        : "border-line bg-surface text-ink-soft hover:text-ink",
                    )}
                  >
                    {pill.label}
                  </button>
                ))}
              </div>

              <label className="flex cursor-pointer items-center gap-1 text-[8.5px] font-semibold text-ink-soft">
                <input
                  type="checkbox"
                  checked={severityFilter === "issues"}
                  onChange={(e) =>
                    setSeverityFilter(e.target.checked ? "issues" : "all")
                  }
                  className="h-3.5 w-3.5 accent-brand"
                />
                Tylko podejrzane
              </label>

              <label className="flex cursor-pointer items-center gap-1 text-[8.5px] font-semibold text-ink-soft">
                <input
                  type="checkbox"
                  checked={onlyMain}
                  onChange={(e) => setOnlyMain(e.target.checked)}
                  className="h-3.5 w-3.5 accent-brand"
                />
                Tylko główne
              </label>

              <label className="flex cursor-pointer items-center gap-1 text-[8.5px] font-semibold text-ink-soft">
                <input
                  type="checkbox"
                  checked={hideCustomized}
                  onChange={(e) => setHideCustomized(e.target.checked)}
                  className="h-3.5 w-3.5 accent-brand"
                />
                Ukryj poprawione
              </label>

              <div className="ml-auto flex h-7 min-w-[170px] items-center gap-1.5 rounded-md border border-line bg-surface px-2 focus-within:border-brand/60">
                <Search className="h-3 w-3 shrink-0 text-mute" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Szukaj linii, pętli, przystanku…"
                  aria-label="Szukaj w wynikach audytu"
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
          </div>

          {/* ── Lista wariantów z wynikami audytu ───────────────────── */}
          <div className="scroll-area min-h-0 flex-1 space-y-2 overflow-y-auto px-3.5 py-2.5">
            {filteredVariants.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-line bg-raised/40 p-10 text-center">
                <CheckCircle2 className="h-7 w-7 text-emerald-500" />
                <div className="text-[11.5px] font-extrabold text-ink">
                  Brak błędów dla wybranych filtrów!
                </div>
                <p className="max-w-[420px] text-[9.5px] text-mute">
                  Wszystkie pasujące warianty przeszły sprawdzenie geometrii bez
                  zastrzeżeń.
                </p>
                {severityFilter !== "all" && (
                  <button
                    type="button"
                    onClick={() => {
                      setSeverityFilter("all");
                      setKindFilter("ALL");
                    }}
                    className="mt-1 rounded-md border border-line bg-surface px-3 py-1 text-[9px] font-bold text-brand-ink hover:border-brand/50"
                  >
                    Pokaż wszystkie {report.totalVariants} wariantów
                  </button>
                )}
              </div>
            ) : (
              filteredVariants.map((variant) => {
                const meta = severityMeta(variant.severity);
                return (
                  <article
                    key={`${variant.lineShort}::${variant.variantKey}`}
                    data-testid={`audit-variant-${variant.lineShort}-${variant.variantKey}`}
                    className={cn(
                      "rounded-xl border bg-surface p-2.5 transition-colors",
                      meta.borderClass,
                    )}
                  >
                    <div className="flex flex-wrap items-start gap-2.5">
                      <span
                        className="metric grid h-8 min-w-[36px] shrink-0 place-items-center rounded-md px-2 text-[12px] font-extrabold"
                        style={{
                          backgroundColor: variant.lineColor,
                          color: variant.lineTextColor,
                        }}
                      >
                        {variant.lineShort}
                      </span>

                      <div className="min-w-[180px] flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[10.5px] font-extrabold text-ink">
                            {variant.firstStop} → {variant.lastStop}
                          </span>
                          <span
                            className={cn(
                              "rounded-full border px-1.5 py-px text-[7.5px] font-extrabold uppercase",
                              meta.badgeClass,
                            )}
                          >
                            {meta.label}
                          </span>
                          {variant.main && (
                            <span className="rounded bg-brand px-1.5 py-px text-[7.5px] font-extrabold uppercase text-on-brand">
                              Główny
                            </span>
                          )}
                          {variant.customized && (
                            <span className="rounded border border-emerald-500/40 bg-emerald-500/12 px-1.5 py-px text-[7.5px] font-extrabold uppercase text-emerald-700 dark:text-emerald-300">
                              {variant.customScope === "direction"
                                ? "Poprawiona (kierunek)"
                                : "Poprawiona"}
                            </span>
                          )}
                        </div>

                        <div className="metric mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[8.5px] font-semibold text-mute">
                          <span>{variant.stopCount} przyst.</span>
                          <span>{variant.refCount} kursów/dzień</span>
                          <span>
                            Kształt: {formatKm(variant.shapeLengthMeters)} (przyst.:{" "}
                            {formatKm(variant.stopChainLengthMeters)})
                          </span>
                          {variant.maxStopOffsetMeters > 0 && (
                            <span
                              className={cn(
                                variant.maxStopOffsetMeters > 60 &&
                                  "font-bold text-rose-700 dark:text-rose-300",
                              )}
                            >
                              Maks. odl. przyst.: {variant.maxStopOffsetMeters} m
                            </span>
                          )}
                          {variant.maxJumpMeters > 120 && (
                            <span className="font-bold text-amber-700 dark:text-amber-300">
                              Maks. skok: {variant.maxJumpMeters} m
                            </span>
                          )}
                        </div>

                        {variant.issues.length > 0 && (
                          <ul className="mt-2 space-y-1">
                            {variant.issues.map((issue, idx) => (
                              <li
                                key={`${issue.kind}-${idx}`}
                                className={cn(
                                  "flex items-start gap-1.5 rounded-lg border px-2 py-1 text-[8.5px]",
                                  issue.severity === "error"
                                    ? "border-rose-500/25 bg-rose-500/6"
                                    : "border-amber-500/25 bg-amber-500/6",
                                )}
                              >
                                <AlertTriangle
                                  className={cn(
                                    "mt-0.5 h-3 w-3 shrink-0",
                                    issue.severity === "error"
                                      ? "text-rose-600 dark:text-rose-400"
                                      : "text-amber-600 dark:text-amber-400",
                                  )}
                                />
                                <div className="min-w-0 flex-1">
                                  <span className="font-extrabold text-ink">
                                    {issue.title}
                                  </span>
                                  <span className="ml-1.5 rounded bg-surface px-1 py-px text-[7.5px] font-bold text-mute">
                                    {issueKindLabel(issue.kind)}
                                  </span>
                                  <div className="text-[8px] leading-snug text-ink-soft">
                                    {issue.detail}
                                  </div>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          data-testid="audit-show-on-map"
                          onClick={() => handleShowVariantOnMap(variant)}
                          className="flex h-8 items-center gap-1 rounded-lg border border-line bg-raised px-2.5 text-[9px] font-bold text-ink-soft transition-colors hover:border-brand/50 hover:text-brand-ink"
                        >
                          <Eye className="h-3 w-3" />
                          Mapa
                        </button>
                        <button
                          type="button"
                          data-testid="audit-fix-variant"
                          onClick={() => {
                            onFixInEditor(variant.lineShort, variant.variantKey);
                            onClose();
                          }}
                          className="flex h-8 items-center gap-1 rounded-lg bg-brand px-2.5 text-[9px] font-extrabold text-on-brand transition-opacity hover:opacity-90"
                        >
                          <Pencil className="h-3 w-3" />
                          Napraw w edytorze
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
