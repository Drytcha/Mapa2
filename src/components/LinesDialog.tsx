import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Eye, Loader2, MapPinned, Pencil, Search, Waypoints, X } from "lucide-react";
import { DateTime } from "luxon";
import { onRuntimeEvent } from "@/lib/core/runtimeHub";
import { foldPolish, isPlannerOnlyLine } from "@/lib/core/text";
import { WARSAW_ZONE } from "@/lib/core/time";
import { getBrigadeShapeOverlay } from "@/lib/engine/gtfsStore";
import {
  getLineCatalogue,
  type LineEntry,
  type LineVariant,
} from "@/lib/engine/lineRoutes";
import { lineLegend } from "@/lib/lineLegend";
import { cn } from "@/utils/cn";
import type { KursowkaShapeOverlay } from "./MapView";
import { Dialog } from "./Modals";

interface Props {
  open: boolean;
  /** Linie planistyczne (S1–S4) widzi tylko planista. */
  isPlanner?: boolean;
  onClose: () => void;
  onShowShapeOverlay: (overlay: KursowkaShapeOverlay) => void;
  /** Tylko dla Planisty: otwiera interaktywny edytor przebiegu trasy wybranego wariantu. */
  onEditLineRoute?: (lineShort: string, variantKey?: string | null) => void;
}

const VARIANTS_COLLAPSED = 6;

function dateLabel(dateId: number): string {
  const text = String(dateId);
  return text.length === 8 ? `${text.slice(6, 8)}.${text.slice(4, 6)}.${text.slice(0, 4)}` : "—";
}

function tripsNoun(count: number): string {
  if (count === 1) return "kurs";
  const last = count % 10;
  const lastTwo = count % 100;
  return last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14) ? "kursy" : "kursów";
}

function kilometres(meters: number): string {
  return `${(meters / 1000).toLocaleString("pl-PL", { maximumFractionDigits: 1 })} km`;
}

/** Szkic trasy (SVG) — wszystkie warianty linii, wybrany wyróżniony. */
function RoutePreview({
  variants,
  activeKey,
  color,
}: {
  variants: LineVariant[];
  activeKey: string | null;
  color: string;
}) {
  const W = 440;
  const H = 280;
  const PAD = 16;

  const shapes = useMemo(() => {
    let latMin = Infinity;
    let latMax = -Infinity;
    let lonMin = Infinity;
    let lonMax = -Infinity;
    for (const variant of variants) {
      for (const [lat, lon] of variant.path) {
        if (lat < latMin) latMin = lat;
        if (lat > latMax) latMax = lat;
        if (lon < lonMin) lonMin = lon;
        if (lon > lonMax) lonMax = lon;
      }
    }
    const kx = Math.cos((((latMin + latMax) / 2) * Math.PI) / 180);
    const spanX = Math.max((lonMax - lonMin) * kx, 1e-6);
    const spanY = Math.max(latMax - latMin, 1e-6);
    const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
    const offX = (W - 2 * PAD - spanX * scale) / 2;
    const offY = (H - 2 * PAD - spanY * scale) / 2;
    const project = ([lat, lon]: [number, number]): [number, number] => [
      PAD + offX + (lon - lonMin) * kx * scale,
      H - (PAD + offY + (lat - latMin) * scale),
    ];
    return variants.map((variant) => {
      const step = Math.max(1, Math.ceil(variant.path.length / 600));
      const points: [number, number][] = [];
      for (let i = 0; i < variant.path.length; i += step) points.push(project(variant.path[i]));
      points.push(project(variant.path[variant.path.length - 1]));
      return {
        key: variant.key,
        points: points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "),
        start: points[0],
        end: points[points.length - 1],
      };
    });
  }, [variants]);

  const active = shapes.find((shape) => shape.key === activeKey);
  const ordered = [...shapes].sort((a, b) => Number(a.key === activeKey) - Number(b.key === activeKey));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Szkic przebiegu trasy"
      className="h-auto w-full rounded-xl border border-line bg-raised"
    >
      {ordered.map((shape) => {
        const dim = activeKey !== null && shape.key !== activeKey;
        return (
          <g key={shape.key}>
            <polyline
              points={shape.points}
              fill="none"
              stroke="#ffffff"
              strokeWidth={dim ? 4 : 7}
              strokeOpacity={dim ? 0.25 : 0.9}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <polyline
              points={shape.points}
              fill="none"
              stroke={color}
              strokeWidth={dim ? 2 : 4}
              strokeOpacity={dim ? 0.3 : 1}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        );
      })}
      {(active ? [active] : shapes.length === 1 ? shapes : []).map((shape) => (
        <g key={`ends-${shape.key}`}>
          <circle cx={shape.start[0]} cy={shape.start[1]} r={6} fill="#0891b2" stroke="#fff" strokeWidth={2.5} />
          <circle cx={shape.end[0]} cy={shape.end[1]} r={6} fill="#e11d48" stroke="#fff" strokeWidth={2.5} />
        </g>
      ))}
    </svg>
  );
}

export default function LinesDialog({
  open,
  isPlanner = false,
  onClose,
  onShowShapeOverlay,
  onEditLineRoute,
}: Props) {
  const [entries, setEntries] = useState<LineEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const today = useMemo(
    () => Number(DateTime.now().setZone(WARSAW_ZONE).toFormat("yyyyLLdd")),
    []
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setEntries(await getLineCatalogue());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się wczytać linii.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    const unsubGtfs = onRuntimeEvent("gtfs:updated", () => {
      void load();
    });
    const unsubOverrides = onRuntimeEvent("routes:overrides-updated", () => {
      void load();
    });
    return () => {
      unsubGtfs();
      unsubOverrides();
    };
  }, [open, load]);

  const visible = useMemo(
    () => (isPlanner ? entries : entries.filter((entry) => !isPlannerOnlyLine(entry.shortName))),
    [entries, isPlanner]
  );
  const filtered = useMemo(() => {
    const needle = foldPolish(query.trim());
    if (!needle) return visible;
    return visible.filter((entry) =>
      foldPolish(`${entry.shortName} ${entry.longName}`).includes(needle)
    );
  }, [visible, query]);

  const selected =
    visible.find((entry) => entry.shortName === selectedLine) ?? filtered[0] ?? visible[0] ?? null;
  const activeKey =
    selected && selected.variants.some((variant) => variant.key === selectedKey) ? selectedKey : null;
  const shownVariants = selected
    ? expanded
      ? selected.variants
      : selected.variants.slice(0, VARIANTS_COLLAPSED)
    : [];

  const showOnMap = async (entry: LineEntry, variants: LineVariant[], title: string, busy: string) => {
    if (busyKey) return;
    setBusyKey(busy);
    setError("");
    try {
      const overlay = await getBrigadeShapeOverlay(
        title,
        entry.color,
        variants.map((variant) => variant.representativeTripId)
      );
      if (!overlay) {
        setError("Brak geometrii trasy dla tej linii w rozkładzie.");
        return;
      }
      onShowShapeOverlay(overlay);
      onClose();
    } catch {
      setError("Nie udało się narysować trasy. Spróbuj ponownie.");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="Linie Wałbrzych"
      className="duty-dialog-shell h-[94dvh] max-w-[1240px]"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-brand-soft text-brand-ink">
          <Waypoints className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-[13px] font-extrabold tracking-[-0.02em] text-ink">Linie Wałbrzych</h2>
        <span className="hidden min-w-0 truncate text-[9px] text-mute md:inline">
          Wszystkie linie i przebieg ich tras według aktualnego rozkładu
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Zamknij"
          className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-md text-mute transition-colors hover:bg-raised hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      {loading && !entries.length ? (
        <div role="status" className="flex items-center gap-2 p-6 text-[10px] text-mute">
          <Loader2 className="h-4 w-4 animate-spin" />
          Wczytywanie linii i tras…
        </div>
      ) : error && !entries.length ? (
        <div role="alert" className="m-3 rounded-lg border border-warning/30 bg-warning-soft p-4 text-xs text-warning">
          {error}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* ── Lista linii ───────────────────────────────────────────── */}
          <aside className="flex max-h-[38dvh] shrink-0 flex-col border-b border-line md:max-h-none md:w-[310px] md:border-b-0 md:border-r">
            <div className="shrink-0 p-2">
              <div className="flex h-8 items-center gap-1.5 rounded-md border border-line bg-raised px-2 focus-within:border-brand/60">
                <Search className="h-3 w-3 shrink-0 text-mute" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Szukaj linii lub miejsca (np. 7, Szczawno)"
                  aria-label="Szukaj linii"
                  autoComplete="off"
                  className="min-w-0 flex-1 bg-transparent text-[10px] font-semibold text-ink outline-none placeholder:font-medium placeholder:text-mute"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Wyczyść wyszukiwanie"
                    className="grid h-5 w-5 place-items-center rounded text-mute hover:text-ink"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <p className="mt-1.5 px-0.5 text-[8.5px] font-bold text-mute">
                {filtered.length} {filtered.length === 1 ? "linia" : "linii"}
              </p>
            </div>
            <ul aria-label="Lista linii" className="scroll-area min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
              {filtered.map((entry) => {
                const isActive = selected?.shortName === entry.shortName;
                return (
                  <li key={entry.shortName}>
                    <button
                      type="button"
                      data-testid="line-card"
                      aria-pressed={isActive}
                      onClick={() => {
                        setSelectedLine(entry.shortName);
                        setSelectedKey(null);
                        setExpanded(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg border px-2 py-1.5 text-left transition-colors",
                        isActive
                          ? "border-brand bg-brand-soft"
                          : "border-line bg-raised/60 hover:border-line-strong hover:bg-raised"
                      )}
                    >
                      <span
                        className="metric grid h-8 min-w-[38px] shrink-0 place-items-center rounded-md px-1.5 text-[13px] font-extrabold"
                        style={{ backgroundColor: entry.color, color: entry.textColor }}
                      >
                        {entry.shortName}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[10px] font-extrabold text-ink">{entry.longName}</span>
                        <span className="block truncate text-[8.5px] font-semibold text-mute">
                          {entry.variants.length} {entry.variants.length === 1 ? "wariant trasy" : "warianty/ów trasy"}
                          {entry.from > today && (
                            <span className="ml-1 font-extrabold text-warning">· od {dateLabel(entry.from)}</span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {!filtered.length && (
                <li className="px-2 py-6 text-center text-[10px] text-mute">Brak linii pasujących do wyszukiwania.</li>
              )}
            </ul>
          </aside>

          {/* ── Szczegóły wybranej linii ─────────────────────────────── */}
          <section className="scroll-area min-h-0 flex-1 overflow-y-auto p-3" aria-label="Trasa wybranej linii">
            {selected ? (
              <div className="mx-auto max-w-[760px] space-y-3">
                <div className="flex items-start gap-3">
                  <span
                    className="metric grid h-11 min-w-[52px] shrink-0 place-items-center rounded-lg px-2 text-[20px] font-extrabold"
                    style={{ backgroundColor: selected.color, color: selected.textColor }}
                  >
                    {selected.shortName}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[14px] font-extrabold leading-tight text-ink">{selected.longName}</h3>
                    <p className="mt-0.5 text-[9px] font-semibold text-mute">
                      Rozkład: {dateLabel(selected.from)} – {dateLabel(selected.to)} · w dzień roboczy{" "}
                      {dateLabel(selected.refDate)}: {selected.refTrips} {tripsNoun(selected.refTrips)}
                    </p>
                    {selected.from > today && (
                      <p className="mt-1 inline-block rounded bg-warning-soft px-1.5 py-0.5 text-[9px] font-bold text-warning">
                        Linia kursuje od {dateLabel(selected.from)}.
                      </p>
                    )}
                  </div>
                </div>

                <RoutePreview variants={selected.variants} activeKey={activeKey} color={selected.color} />

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="line-show-all"
                    disabled={Boolean(busyKey)}
                    onClick={() =>
                      void showOnMap(
                        selected,
                        selected.variants,
                        `Linia ${selected.shortName} · wszystkie warianty`,
                        "all"
                      )
                    }
                    className="flex h-8 items-center gap-1.5 rounded-lg bg-brand px-3 text-[10px] font-extrabold text-on-brand transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    {busyKey === "all" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPinned className="h-3.5 w-3.5" />}
                    Pokaż całą linię na mapie
                  </button>
                  {isPlanner && onEditLineRoute && (
                    <button
                      type="button"
                      data-testid="line-edit-route"
                      onClick={() => {
                        onEditLineRoute(
                          selected.shortName,
                          activeKey ?? selected.variants[0]?.key ?? null,
                        );
                        onClose();
                      }}
                      className="flex h-8 items-center gap-1.5 rounded-lg border border-brand/40 bg-brand-soft px-3 text-[10px] font-extrabold text-brand-ink transition-colors hover:border-brand"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edytuj przebieg linii
                    </button>
                  )}
                  {activeKey && (
                    <button
                      type="button"
                      onClick={() => setSelectedKey(null)}
                      className="h-8 rounded-lg border border-line bg-surface px-2.5 text-[9.5px] font-bold text-ink-soft hover:bg-soft hover:text-ink"
                    >
                      Pokaż wszystkie warianty na szkicu
                    </button>
                  )}
                </div>

                {error && (
                  <p role="alert" className="rounded-md border border-warning/30 bg-warning-soft px-2 py-1.5 text-[9.5px] font-bold text-warning">
                    {error}
                  </p>
                )}

                <div>
                  <h4 className="mb-1.5 text-[8.5px] font-extrabold uppercase tracking-[0.12em] text-mute">
                    Warianty tras ({selected.variants.length})
                  </h4>
                  <ul className="space-y-1.5">
                    {shownVariants.map((variant) => {
                      const isActive = activeKey === variant.key;
                      return (
                        <li
                          key={variant.key}
                          data-testid="line-variant"
                          className={cn(
                            "flex items-stretch gap-1.5 rounded-lg border p-1",
                            isActive ? "border-brand bg-brand-soft" : "border-line bg-raised/60"
                          )}
                        >
                          <button
                            type="button"
                            aria-pressed={isActive}
                            onClick={() => setSelectedKey(isActive ? null : variant.key)}
                            title="Wyróżnij ten wariant na szkicu"
                            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface/60"
                          >
                            <span
                              className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-white"
                              style={{ backgroundColor: selected.color }}
                              aria-hidden="true"
                            >
                              <ArrowRight className="h-3 w-3" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span className="truncate text-[10px] font-extrabold text-ink">{variant.headsign}</span>
                                {variant.main && (
                                  <span className="shrink-0 rounded bg-brand px-1 py-px text-[7px] font-extrabold uppercase text-on-brand">
                                    Główny
                                  </span>
                                )}
                                {variant.customized && (
                                  <span
                                    className="shrink-0 rounded border border-emerald-500/40 bg-emerald-500/12 px-1 py-px text-[7px] font-extrabold uppercase text-emerald-700 dark:text-emerald-300"
                                    title={
                                      variant.customNote ||
                                      (variant.customScope === "direction"
                                        ? "Wspólna trasa kierunku skorygowana przez Planistę"
                                        : "Trasa wariantu skorygowana przez Planistę")
                                    }
                                  >
                                    {variant.customStatus === "local-modified"
                                      ? "Lokalnie"
                                      : "Poprawiona"}
                                  </span>
                                )}
                              </span>
                              <span className="block truncate text-[8.5px] font-semibold text-mute">
                                {variant.firstStop} → {variant.lastStop}
                              </span>
                              <span className="block text-[8px] font-semibold text-mute">
                                {variant.stopCount} przystanków · {isPlanner && `${kilometres(variant.lengthMeters)} · `}
                                {variant.refCount > 0
                                  ? `${variant.refCount} ${tripsNoun(variant.refCount)} w dzień roboczy`
                                  : `${variant.tripCount} ${tripsNoun(variant.tripCount)} (poza dniami roboczymi)`}
                                {variant.approximate && " · trasa orientacyjna"}
                              </span>
                            </span>
                          </button>
                          {isPlanner && onEditLineRoute && (
                            <button
                              type="button"
                              data-testid="line-variant-edit"
                              onClick={() => {
                                onEditLineRoute(selected.shortName, variant.key);
                                onClose();
                              }}
                              title="Edytuj przebieg tego wariantu na mapie"
                              className="flex shrink-0 items-center gap-1 rounded-md border border-brand/35 bg-brand-soft px-2 text-[8.5px] font-extrabold text-brand-ink transition-colors hover:border-brand"
                            >
                              <Pencil className="h-3 w-3" />
                              <span className="hidden sm:inline">Edytuj</span>
                            </button>
                          )}
                          <button
                            type="button"
                            data-testid="line-variant-map"
                            disabled={Boolean(busyKey)}
                            onClick={() =>
                              void showOnMap(
                                selected,
                                [variant],
                                `Linia ${selected.shortName} · ${variant.headsign}`,
                                variant.key
                              )
                            }
                            className="flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface px-2 text-[8.5px] font-extrabold text-brand-ink transition-colors hover:border-brand/50 disabled:opacity-60"
                          >
                            {busyKey === variant.key ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
                            <span className="hidden sm:inline">Mapa</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {lineLegend(selected.shortName) && (
                    <div
                      data-testid="line-legend"
                      className="mt-2 rounded-lg border border-line bg-raised/60 px-2 py-1.5"
                    >
                      <h4 className="mb-1 text-[8.5px] font-extrabold uppercase tracking-[0.12em] text-mute">
                        Oficjalna legenda wariantów
                      </h4>
                      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] leading-snug text-ink-soft">
                        {lineLegend(selected.shortName)!.map((entry) => (
                          <li key={entry.code} className="flex min-w-0 items-baseline gap-1">
                            <b className="font-mono font-extrabold text-brand-ink">{entry.code}</b>
                            <span aria-hidden="true" className="text-mute">–</span>
                            <span>{entry.text}</span>
                          </li>
                        ))}
                        <li className="text-mute">kurs bez litery – kurs podstawowy</li>
                      </ul>
                    </div>
                  )}
                  {selected.variants.length > VARIANTS_COLLAPSED && (
                    <button
                      type="button"
                      onClick={() => setExpanded((value) => !value)}
                      className="mt-1.5 text-[9.5px] font-bold text-brand-ink hover:underline"
                    >
                      {expanded
                        ? "Pokaż mniej wariantów"
                        : `Pokaż pozostałe warianty (${selected.variants.length - VARIANTS_COLLAPSED})`}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <p className="py-10 text-center text-[10px] text-mute">Brak linii w aktualnym rozkładzie.</p>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}
