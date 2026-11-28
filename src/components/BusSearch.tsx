import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Bus, BusFront, Search, X } from "lucide-react";
import type { BusStop, LiveBusVehicle } from "@/lib/types";
import { filterStops, stopDisplayName } from "@/lib/busStops";
import { normalizeBusLine } from "@/lib/busMarker";
import {
  filterLinesForRole,
  foldPolish,
  formatDutyCode,
  isPlannerOnlyLine,
  isSameDutyLine,
} from "@/lib/core/text";
import {
  DELAY_STYLES,
  delayTone,
  describeDelay,
  formatDelay,
  formatVehicleNumber,
} from "@/lib/delay";
import { dutyLabel } from "@/lib/engine/brigadeVerification";
import { findBuses, OPERATOR_STYLES } from "@/lib/transit";
import { cn } from "@/utils/cn";

type SearchScope = "all" | "stops" | "buses";

interface Props {
  vehicles: LiveBusVehicle[];
  stops?: BusStop[];
  onSelectVehicle: (bus: LiveBusVehicle) => void;
  onSelectStop?: (stop: BusStop) => void;
  compact?: boolean;
  /** Osadzona w kompaktowej kapsułce mapy (bez podwójnej ramki). */
  embedded?: boolean;
  onQueryChange?: (query: string) => void;
  query?: string;
  /** Planista widzi też ostrzeżenie przy wozach bez przypisanej brygady. */
  showDutyStatus?: boolean;
  /** Planista widzi także linie specjalne (np. S1) na przystankach i wozach. */
  isPlanner?: boolean;
  defaultOpen?: boolean;
}

function stopMatchRank(stop: BusStop, foldedTerm: string): number {
  if (!foldedTerm) return 0;
  const name = foldPolish(stop.name);
  if (name.startsWith(foldedTerm)) return 0;
  if (name.includes(foldedTerm)) return 1;
  if (stop.lines.some((line) => foldPolish(line) === foldedTerm)) return 2;
  return 3;
}

/** Unified map search for stops and live GPS buses, independent of map layer filters. */
export default function BusSearch({
  vehicles,
  stops = [],
  onSelectVehicle,
  onSelectStop,
  compact = false,
  embedded = false,
  onQueryChange,
  query: controlledQuery,
  showDutyStatus = false,
  isPlanner = false,
  defaultOpen = false,
}: Props) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [internalQuery, setInternalQuery] = useState("");
  const query = controlledQuery ?? internalQuery;
  const setQuery = (value: string) => {
    setInternalQuery(value);
    onQueryChange?.(value);
  };
  const [open, setOpen] = useState(defaultOpen);
  const [active, setActive] = useState(0);
  const [scope, setScope] = useState<SearchScope>("all");

  const hasStopSearch = Boolean(onSelectStop);
  const trimmedQuery = query.trim();
  const foldedTerm = foldPolish(trimmedQuery);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
    };
  }, [open]);

  const searchableVehicles = useMemo(
    () =>
      isPlanner
        ? vehicles
        : vehicles.filter((vehicle) => !isPlannerOnlyLine(vehicle.routeName)),
    [vehicles, isPlanner]
  );

  const originalStopsById = useMemo(
    () => new Map(stops.map((stop) => [stop.id, stop] as const)),
    [stops]
  );

  const searchableStops = useMemo(
    () =>
      isPlanner
        ? stops
        : stops.map((stop) => ({
            ...stop,
            lines: filterLinesForRole(stop.lines, false),
          })),
    [stops, isPlanner]
  );

  const busMatches = useMemo(() => {
    if (!trimmedQuery) {
      return [...searchableVehicles].sort((a, b) =>
        (a.dutyCode ?? a.routeName ?? "~").localeCompare(
          b.dutyCode ?? b.routeName ?? "~",
          "pl",
          { numeric: true }
        )
      );
    }
    return findBuses(searchableVehicles, trimmedQuery);
  }, [searchableVehicles, trimmedQuery]);

  const stopMatches = useMemo(() => {
    if (!hasStopSearch) return [];
    const filtered = trimmedQuery
      ? filterStops(searchableStops, trimmedQuery)
      : searchableStops;
    return [...filtered].sort((a, b) => {
      const rankDiff =
        stopMatchRank(a, foldedTerm) - stopMatchRank(b, foldedTerm);
      if (rankDiff !== 0) return rankDiff;
      return stopDisplayName(a).localeCompare(stopDisplayName(b), "pl", {
        numeric: true,
      });
    });
  }, [hasStopSearch, searchableStops, trimmedQuery, foldedTerm]);

  const shownBuses = useMemo(() => {
    if (hasStopSearch && scope === "stops") return [];
    if (hasStopSearch && !trimmedQuery && scope === "all") return [];
    const limit = scope === "buses" ? 20 : hasStopSearch ? 6 : 8;
    return busMatches.slice(0, limit);
  }, [hasStopSearch, scope, trimmedQuery, busMatches]);

  const shownStops = useMemo(() => {
    if (!hasStopSearch || scope === "buses") return [];
    if (!trimmedQuery && scope === "all") return [];
    const limit = scope === "stops" ? 30 : 24;
    return stopMatches.slice(0, limit);
  }, [hasStopSearch, scope, trimmedQuery, stopMatches]);

  const flatItems = useMemo(
    () => [
      ...shownBuses.map((bus) => ({ kind: "bus" as const, bus })),
      ...shownStops.map((stop) => ({ kind: "stop" as const, stop })),
    ],
    [shownBuses, shownStops]
  );

  const chooseBus = (bus: LiveBusVehicle) => {
    onSelectVehicle(bus);
    setQuery(bus.dutyCode || formatVehicleNumber(bus.vehicleId));
    setOpen(false);
  };

  const chooseStop = (stop: BusStop) => {
    onSelectStop?.(originalStopsById.get(stop.id) ?? stop);
    setOpen(false);
  };

  const showDropdown = open && (hasStopSearch || Boolean(trimmedQuery));

  return (
    <div
      ref={rootRef}
      className="relative min-w-0 w-full"
      data-testid="bus-search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <div
        className={cn(
          "flex items-center gap-1.5",
          embedded
            ? "px-1.5"
            : "rounded-xl border border-line/80 bg-surface/96 px-2.5 shadow-[0_8px_24px_rgba(13,42,28,0.14)] focus-within:border-brand-ink"
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-mute" aria-hidden="true" />
        <input
          type="search"
          aria-label={
            hasStopSearch
              ? "Szukaj przystanku lub autobusu"
              : "Znajdź autobus po kursówce lub numerze wozu"
          }
          aria-expanded={showDropdown}
          aria-controls={showDropdown ? `${id}-results` : undefined}
          autoComplete="off"
          value={query}
          placeholder={
            hasStopSearch
              ? embedded
                ? "Przystanek lub autobus…"
                : compact
                  ? "Przystanek lub autobus: 2/03, #404"
                  : "Szukaj przystanku, linii, kursówki 2/03 lub #404"
              : compact
                ? "Znajdź autobus: 2/03 lub #404"
                : "Szukaj autobusu: kursówka 2/03 lub wóz #404"
          }
          className={cn(
            "min-w-0 flex-1 select-text bg-transparent text-[11px] text-ink outline-none placeholder:text-mute sm:text-[11.5px]",
            embedded ? "h-7" : compact ? "h-8" : "h-11"
          )}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActive((index) =>
                flatItems.length ? Math.min(index + 1, flatItems.length - 1) : 0
              );
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(0, index - 1));
            }
            if (event.key === "Enter" && showDropdown && flatItems[active]) {
              event.preventDefault();
              const item = flatItems[active];
              if (item.kind === "bus") chooseBus(item.bus);
              else chooseStop(item.stop);
            }
          }}
        />
        {query && (
          <button
            type="button"
            aria-label="Wyczyść wyszukiwanie"
            className="p-1 text-mute hover:text-ink"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setQuery("");
              setActive(0);
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {showDropdown && (
        <div
          id={`${id}-results`}
          role="region"
          aria-label="Wyniki wyszukiwania"
          className={cn(
            "scroll-area absolute top-full z-[60] flex max-h-[min(380px,56dvh)] flex-col overflow-hidden rounded-xl border border-line bg-surface p-1.5 shadow-[0_18px_46px_rgba(0,0,0,0.26)]",
            embedded ? "-left-[38px] mt-2" : "left-0 mt-1.5",
            hasStopSearch
              ? "w-[min(332px,calc(100vw-20px))]"
              : "right-0"
          )}
        >
          {hasStopSearch && (
            <div className="mb-1 flex shrink-0 items-center gap-0.5 rounded-lg bg-soft p-0.5">
              {(
                [
                  {
                    id: "all",
                    label: trimmedQuery
                      ? `Wszystko (${busMatches.length + stopMatches.length})`
                      : "Wszystko",
                  },
                  {
                    id: "stops",
                    label: `Przystanki (${stopMatches.length})`,
                  },
                  {
                    id: "buses",
                    label: `Autobusy (${busMatches.length})`,
                  },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  data-testid={`search-scope-${tab.id}`}
                  aria-pressed={scope === tab.id}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setScope(tab.id);
                    setActive(0);
                  }}
                  className={cn(
                    "flex h-6 flex-1 items-center justify-center rounded-md px-1.5 text-[8.5px] font-extrabold transition-colors",
                    scope === tab.id
                      ? "bg-surface text-brand-ink shadow-[0_1px_3px_rgba(13,42,28,0.12)]"
                      : "text-mute hover:text-ink"
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}

          {hasStopSearch && !trimmedQuery && scope === "all" ? (
            <p className="px-2 py-2 text-[10px] leading-relaxed text-mute">
              Wpisz nazwę przystanku, linię, brygadę (np. 2/03) lub numer wozu
              (#404) — albo przełącz na listę przystanków lub autobusów powyżej.
            </p>
          ) : (
            <div className="scroll-area min-h-0 overflow-y-auto">
              {shownBuses.length > 0 && (
                <div>
                  {hasStopSearch && (
                    <div className="px-2 pb-1 pt-1 text-[8px] font-extrabold uppercase tracking-[0.14em] text-mute">
                      Autobusy GPS ({busMatches.length}
                      {busMatches.length > shownBuses.length
                        ? ` · pierwsze ${shownBuses.length}`
                        : ""}
                      )
                    </div>
                  )}
                  {shownBuses.map((bus, index) => {
                    const company = OPERATOR_STYLES[bus.operatorKey];
                    const style = DELAY_STYLES[delayTone(bus.delaySeconds)];
                    const duty = dutyLabel(bus);
                    return (
                      <button
                        key={bus.vehicleId}
                        id={`${id}-option-${index}`}
                        type="button"
                        data-active={active === index}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left",
                          active === index ? "bg-raised" : "hover:bg-raised"
                        )}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => chooseBus(bus)}
                      >
                        <span
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg"
                          style={{ background: style.bg, color: style.fg }}
                        >
                          <BusFront className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1 text-[11px] font-bold text-ink">
                            {duty.code &&
                            isSameDutyLine(bus.routeName, duty.code) ? (
                              <span className="metric rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-extrabold text-brand-ink">
                                Brygada {formatDutyCode(duty.code, "/")}
                              </span>
                            ) : normalizeBusLine(bus.routeName) ? (
                              <>
                                <span>Linia {normalizeBusLine(bus.routeName)}</span>
                                {duty.code ? (
                                  <span className="metric rounded bg-brand-soft px-1.5 py-0.5 text-[9.5px] font-extrabold text-brand-ink">
                                    bryg. {formatDutyCode(duty.code, "/")}
                                  </span>
                                ) : null}
                              </>
                            ) : (
                              <span>Autobus {formatVehicleNumber(bus.vehicleId)}</span>
                            )}
                            {!duty.code && showDutyStatus ? (
                              <span
                                className="rounded border border-warning/30 bg-warning-soft px-1.5 py-0.5 text-[8.5px] font-extrabold text-warning"
                                title={duty.detail}
                              >
                                brak brygady
                              </span>
                            ) : null}
                            <span className="metric ml-auto">
                              {formatVehicleNumber(bus.vehicleId)}
                            </span>
                          </span>
                          <span className="block truncate text-[9.5px] text-mute">
                            {company.label} · GPS na żywo ·{" "}
                            {describeDelay(bus.delaySeconds)}{" "}
                            {formatDelay(bus.delaySeconds)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {shownStops.length > 0 && (
                <div
                  className={cn(
                    shownBuses.length > 0 && "mt-1 border-t border-line/70 pt-1"
                  )}
                >
                  <div className="px-2 pb-1 pt-1 text-[8px] font-extrabold uppercase tracking-[0.14em] text-mute">
                    Przystanki ({stopMatches.length}
                    {stopMatches.length > shownStops.length
                      ? ` · pierwsze ${shownStops.length}`
                      : ""}
                    )
                  </div>
                  {shownStops.map((stop, stopIdx) => {
                    const flatIndex = shownBuses.length + stopIdx;
                    return (
                      <button
                        key={stop.id}
                        id={`${id}-option-${flatIndex}`}
                        type="button"
                        data-active={active === flatIndex}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left",
                          active === flatIndex ? "bg-raised" : "hover:bg-raised"
                        )}
                        onMouseEnter={() => setActive(flatIndex)}
                        onClick={() => chooseStop(stop)}
                      >
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#075dcc] text-white">
                          <Bus className="h-3.5 w-3.5" strokeWidth={2.2} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] font-bold leading-snug text-ink">
                            {stopDisplayName(stop)}
                          </span>
                          <span className="block truncate text-[9.5px] text-mute">
                            {stop.lines.length
                              ? `Linie: ${stop.lines.join(", ")}`
                              : `${stop.lat.toFixed(5)}, ${stop.lon.toFixed(5)}`}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {shownBuses.length === 0 && shownStops.length === 0 && (
                <p
                  className="px-2.5 py-3 text-[11px] leading-relaxed text-mute"
                  role="status"
                >
                  {hasStopSearch && scope === "stops"
                    ? "Brak przystanków pasujących do wyszukiwania."
                    : hasStopSearch && scope === "all"
                      ? `Brak przystanków pasujących do wyszukiwania oraz aktywnych autobusów GPS dla „${query}”.`
                      : trimmedQuery
                        ? `Brak autobusu GPS dla „${query}”. Wpisz brygadę (np. 9/01), linię lub numer wozu — autobus może być teraz poza trasą.`
                        : "Brak aktywnych autobusów GPS w tej chwili."}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
