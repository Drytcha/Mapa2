import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Clock,
  Crosshair,
  Footprints,
  Loader2,
  LocateFixed,
  MapPin,
  Radio,
  RefreshCw,
  Route,
  Search,
  X,
  Zap,
} from "lucide-react";
import { DateTime } from "luxon";
import type { LiveBusVehicle } from "@/lib/types";
import { cn } from "@/utils/cn";
import { formatDelay, formatVehicleNumber } from "@/lib/delay";
import { formatDistanceCompact } from "@/lib/geo";
import {
  JOURNEY_ZONE,
  planJourneys,
  type Journey,
  type JourneyBusLeg,
  type JourneyPlan,
  type JourneyPoint,
  type JourneyWalkLeg,
} from "@/lib/journeyPlanner";
import { searchGtfsStops, type GtfsStopRecord } from "@/lib/engine/gtfsStore";

const clock = (ms: number | null | undefined) =>
  Number.isFinite(ms) && (ms ?? 0) > 0
    ? DateTime.fromMillis(ms as number, { zone: JOURNEY_ZONE }).toFormat(
        "HH:mm",
      )
    : "—";

const minutesLabel = (seconds: number) => {
  if (seconds < 60) return "< 1 min";
  return `${Math.ceil(seconds / 60)} min`;
};

const transfersLabel = (count: number) => {
  if (count === 0) return "bez przesiadek";
  if (count === 1) return "1 przesiadka";
  return `${count} przesiadki`;
};

type PlanState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; plan: JourneyPlan };

interface TripPlannerPanelProps {
  buses: LiveBusVehicle[];
  origin: JourneyPoint | null;
  destination: JourneyPoint | null;
  onOriginChange: (point: JourneyPoint | null) => void;
  onDestinationChange: (point: JourneyPoint | null) => void;
  pickTarget: "origin" | "destination" | null;
  onPickTargetChange: (target: "origin" | "destination" | null) => void;
  onSelectBus: (bus: LiveBusVehicle) => void;
  onCenter: (lat: number, lon: number, zoom?: number) => void;
  onPreview: (journey: Journey | null) => void;
  onRefresh: () => void;
  onClose: () => void;
  refreshNonce: number;
}

/* -------------------------------------------------------------------------- */
/*  Wiersze osi czasu                                                         */
/* -------------------------------------------------------------------------- */

function WalkRow({ leg }: { leg: JourneyWalkLeg }) {
  const text =
    leg.role === "access"
      ? `do przystanku ${leg.to.name}`
      : leg.role === "egress"
        ? "do celu"
        : `przejdź na przystanek ${leg.to.name}`;
  return (
    <div className="grid grid-cols-[30px_14px_1fr] items-start gap-x-1.5">
      <span className="metric pt-px text-right text-[8px] font-bold text-mute">
        {clock(leg.departMs)}
      </span>
      <span className="flex h-full justify-center">
        <span className="h-full w-0 border-l-2 border-dotted border-teal-600/70" />
      </span>
      <span className="flex items-center gap-1 pb-1.5 text-[8px] font-semibold text-mute">
        <Footprints
          className="h-2.5 w-2.5 shrink-0 text-teal-700 dark:text-teal-300"
          strokeWidth={2.4}
        />
        pieszo {minutesLabel(leg.seconds)} · {formatDistanceCompact(leg.meters)}{" "}
        {text}
      </span>
    </div>
  );
}

function WaitRow({
  seconds,
  stopName,
  transfer,
}: {
  seconds: number;
  stopName: string;
  transfer: boolean;
}) {
  return (
    <div className="grid grid-cols-[30px_14px_1fr] items-start gap-x-1.5">
      <span />
      <span className="flex h-full justify-center">
        <span className="h-full w-0 border-l-2 border-dotted border-line-strong" />
      </span>
      <span
        className={cn(
          "mb-1.5 inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-[7.5px] font-extrabold",
          transfer
            ? "bg-warning-soft text-warning ring-1 ring-warning/30"
            : "bg-raised text-ink-soft ring-1 ring-line",
        )}
      >
        <Clock className="h-2.5 w-2.5" strokeWidth={2.6} />
        {transfer ? "Przesiadka" : "Oczekiwanie"} · {minutesLabel(seconds)}
        {transfer ? ` na ${stopName}` : ""}
      </span>
    </div>
  );
}

function BusRow({
  leg,
  onSelectBus,
}: {
  leg: JourneyBusLeg;
  onSelectBus: (bus: LiveBusVehicle) => void;
}) {
  const [open, setOpen] = useState(false);
  const inner = leg.stops.slice(1, -1);
  const rideMinutes = Math.max(
    1,
    Math.round((leg.arriveMs - leg.departMs) / 60_000),
  );
  const stopsRidden = leg.stops.length - 1;
  return (
    <div className="grid grid-cols-[30px_14px_1fr] gap-x-1.5">
      {/* wsiadanie */}
      <span className="metric text-right text-[9px] font-extrabold text-ink">
        {clock(leg.departMs)}
      </span>
      <span className="relative flex justify-center">
        <span
          className="absolute top-1 bottom-[-2px] w-[4px] rounded-full"
          style={{ backgroundColor: leg.routeColor }}
        />
        <span
          className="relative z-10 mt-[3px] h-2.5 w-2.5 rounded-full border-2 bg-surface"
          style={{ borderColor: leg.routeColor }}
        />
      </span>
      <div className="min-w-0">
        <div className="flex items-start gap-1.5">
          <span
            className="metric grid h-5 min-w-[22px] shrink-0 place-items-center rounded-md px-1 text-[9.5px] font-extrabold"
            style={{
              backgroundColor: leg.routeColor,
              color: leg.routeTextColor,
            }}
          >
            {leg.routeShort}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[9px] font-extrabold text-ink">
              {leg.board.name}
            </div>
            <div className="truncate text-[7.5px] font-bold text-mute">
              kierunek {leg.headsign}
            </div>
          </div>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {leg.live ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onSelectBus(leg.live!);
              }}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[7px] font-extrabold text-emerald-700 ring-1 ring-emerald-500/30 transition-colors hover:bg-emerald-500/25 dark:text-emerald-300"
              title="Wóz jest widoczny na mapie — kliknij, aby go śledzić"
            >
              <Radio className="h-2.5 w-2.5" strokeWidth={2.6} />
              na żywo {formatVehicleNumber(leg.live.vehicleId)}
              {leg.delaySeconds !== null && leg.delaySeconds !== 0 && (
                <span className="font-mono">
                  · {formatDelay(leg.delaySeconds)}
                </span>
              )}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[7px] font-bold text-mute ring-1 ring-line">
              wg rozkładu
            </span>
          )}
          {leg.delaySeconds !== null &&
            Math.abs(leg.departMs - leg.scheduledDepartMs) >= 60_000 && (
              <span className="text-[7px] font-semibold text-mute">
                plan {clock(leg.scheduledDepartMs)}
              </span>
            )}
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
          className="mt-1 inline-flex items-center gap-1 text-[7.5px] font-bold text-ink-soft transition-colors hover:text-ink"
        >
          {stopsRidden}{" "}
          {stopsRidden === 1
            ? "przystanek"
            : stopsRidden < 5
              ? "przystanki"
              : "przystanków"}{" "}
          · {rideMinutes} min jazdy
          {inner.length > 0 &&
            (open ? (
              <ChevronUp className="h-2.5 w-2.5" strokeWidth={2.6} />
            ) : (
              <ChevronDown className="h-2.5 w-2.5" strokeWidth={2.6} />
            ))}
        </button>
        {open && inner.length > 0 && (
          <ul className="mt-1 space-y-0.5 border-l border-line pl-2">
            {inner.map((stop) => (
              <li
                key={`${stop.id}-${stop.atMs}`}
                className="flex items-baseline gap-1.5 text-[7.5px]"
              >
                <span className="metric shrink-0 font-bold text-mute">
                  {clock(stop.atMs)}
                </span>
                <span className="truncate font-semibold text-ink-soft">
                  {stop.name}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="h-2" />
      </div>

      {/* wysiadanie */}
      <span className="metric text-right text-[9px] font-extrabold text-ink">
        {clock(leg.arriveMs)}
      </span>
      <span className="relative flex justify-center">
        <span
          className="relative z-10 mt-[3px] h-2.5 w-2.5 rounded-full border-2 bg-surface"
          style={{ borderColor: leg.routeColor }}
        />
      </span>
      <div className="min-w-0 pb-1.5 leading-tight">
        <div className="truncate text-[9px] font-extrabold text-ink">
          {leg.alight.name}
        </div>
        <div className="text-[7.5px] font-bold text-mute">wysiądź</div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Karta połączenia                                                          */
/* -------------------------------------------------------------------------- */

function JourneyCard({
  journey,
  nearest,
  fastest,
  active,
  now,
  onActivate,
  onSelectBus,
  onCenter,
}: {
  journey: Journey;
  nearest: boolean;
  fastest: boolean;
  active: boolean;
  now: number;
  onActivate: () => void;
  onSelectBus: (bus: LiveBusVehicle) => void;
  onCenter: (lat: number, lon: number, zoom?: number) => void;
}) {
  const leaveInMin = Math.round((journey.departMs - now) / 60_000);
  const firstBus = journey.legs.find(
    (leg): leg is JourneyBusLeg => leg.kind === "bus",
  );

  const rows: ReactElement[] = [];
  journey.legs.forEach((leg, index) => {
    const prev = journey.legs[index - 1];
    if (leg.kind === "walk") {
      if (leg.meters < 25) return;
      rows.push(<WalkRow key={`w${index}`} leg={leg} />);
      return;
    }
    if (prev) {
      const waitSeconds = Math.round((leg.departMs - prev.arriveMs) / 1000);
      if (prev.kind === "bus") {
        rows.push(
          <WaitRow
            key={`t${index}`}
            seconds={waitSeconds}
            stopName={leg.board.name}
            transfer
          />,
        );
      } else if (
        waitSeconds >= 60 &&
        (prev.role !== "access" || prev.meters < 25)
      ) {
        rows.push(
          <WaitRow
            key={`t${index}`}
            seconds={waitSeconds}
            stopName={leg.board.name}
            transfer={prev.role === "transfer"}
          />,
        );
      }
    }
    rows.push(<BusRow key={`b${index}`} leg={leg} onSelectBus={onSelectBus} />);
  });

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
        }
      }}
      aria-pressed={active}
      className={cn(
        "cursor-pointer rounded-xl border p-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/40",
        active
          ? "border-brand/60 bg-brand-soft/60 ring-1 ring-brand/25"
          : "border-line bg-raised/60 hover:border-line-strong",
      )}
    >
      <div className="flex flex-wrap items-center gap-1">
        {nearest && (
          <span className="inline-flex items-center gap-1 rounded-full bg-brand px-1.5 py-0.5 text-[6.5px] font-extrabold uppercase tracking-[0.14em] text-on-brand">
            <Clock className="h-2.5 w-2.5" strokeWidth={2.6} />
            Najbliższe
          </span>
        )}
        {fastest && (
          <span className="inline-flex items-center gap-1 rounded-full bg-highlight px-1.5 py-0.5 text-[6.5px] font-extrabold uppercase tracking-[0.14em] text-[#102016]">
            <Zap className="h-2.5 w-2.5" strokeWidth={2.6} />
            Najszybciej
          </span>
        )}
        {active && (
          <span className="inline-flex items-center gap-1 rounded-full bg-ink px-1.5 py-0.5 text-[6.5px] font-extrabold uppercase tracking-[0.14em] text-canvas">
            <Route className="h-2.5 w-2.5" strokeWidth={2.6} />
            Na mapie
          </span>
        )}
      </div>

      <div className="mt-1 flex items-end justify-between gap-2">
        <div className="flex items-baseline gap-1">
          <span className="metric text-[14px] font-extrabold text-ink">
            {clock(journey.departMs)}
          </span>
          <ArrowRight className="h-3 w-3 text-mute" strokeWidth={2.6} />
          <span className="metric text-[14px] font-extrabold text-ink">
            {clock(journey.arriveMs)}
          </span>
        </div>
        <span className="metric rounded-md bg-surface px-1.5 py-0.5 text-[9px] font-extrabold text-ink ring-1 ring-line">
          {journey.durationMinutes} min
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[7.5px] font-bold text-mute">
        <span>{transfersLabel(journey.transfers)}</span>
        <span>·</span>
        <span>pieszo {formatDistanceCompact(journey.walkMeters)}</span>
        <span>·</span>
        <span
          className={cn(
            "font-extrabold",
            leaveInMin <= 2 ? "text-danger" : "text-brand-ink",
          )}
        >
          {leaveInMin <= 0
            ? "wyjdź teraz"
            : leaveInMin === 1
              ? "wyjdź za 1 min"
              : `wyjdź za ${leaveInMin} min`}
        </span>
      </div>

      <div className="mt-2 border-t border-line/60 pt-2">{rows}</div>

      <div className="flex items-center gap-1.5 border-t border-line/60 pt-1.5">
        <span className="text-[7px] font-semibold text-mute">
          {journey.legs
            .filter((leg): leg is JourneyBusLeg => leg.kind === "bus")
            .map((leg) => leg.routeShort)
            .join(" → ")}
        </span>
        <div className="ml-auto flex gap-1">
          {firstBus && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onActivate();
                onCenter(firstBus.board.lat, firstBus.board.lon, 16);
              }}
              className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-[7.5px] font-bold text-ink-soft transition-colors hover:text-ink"
            >
              Przystanek
            </button>
          )}
          {firstBus?.live && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onSelectBus(firstBus.live!);
              }}
              className="rounded-md bg-brand px-1.5 py-0.5 text-[7.5px] font-extrabold text-on-brand transition-opacity hover:opacity-90"
            >
              Śledź wóz
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Panel                                                                     */
/* -------------------------------------------------------------------------- */

export default function TripPlannerPanel({
  buses,
  origin,
  destination,
  onOriginChange,
  onDestinationChange,
  pickTarget,
  onPickTargetChange,
  onSelectBus,
  onCenter,
  onPreview,
  onRefresh,
  onClose,
  refreshNonce,
}: TripPlannerPanelProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GtfsStopRecord[]>([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const [departInput, setDepartInput] = useState("");
  const [plan, setPlan] = useState<PlanState>({ status: "idle" });
  const [refreshing, setRefreshing] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [autoTick, setAutoTick] = useState(0);
  const [progress, setProgress] = useState("");
  const busyRef = useRef(false);
  const searchKeyRef = useRef("");
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const busesRef = useRef(buses);
  busesRef.current = buses;
  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  const planRef = useRef(plan);
  planRef.current = plan;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  /* Wyszukiwarka celu po nazwie przystanku GTFS. */
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const found = await searchGtfsStops(q, 6);
        if (!cancelled) setResults(found);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const departMsFromInput = (): number | undefined => {
    if (!/^\d{2}:\d{2}$/.test(departInput)) return undefined;
    const [hour, minute] = departInput.split(":").map(Number);
    return DateTime.now()
      .setZone(JOURNEY_ZONE)
      .set({ hour, minute, second: 0, millisecond: 0 })
      .toMillis();
  };

  /* Planowanie po ustaleniu punktów, zmianie godziny, „Odśwież" i co 30 s na żywo. */
  useEffect(() => {
    if (!origin || !destination) {
      setPlan({ status: "idle" });
      setActiveId(null);
      previewRef.current(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const key = JSON.stringify([origin, destination, departInput]);
    const silent =
      planRef.current.status === "done" && searchKeyRef.current === key;
    searchKeyRef.current = key;
    busyRef.current = true;
    setProgress("Analizuję rozkład i dojścia piesze...");
    if (silent) setRefreshing(true);
    else {
      setPlan({ status: "loading" });
      previewRef.current(null);
    }

    planJourneys({
      origin,
      destination,
      departMs: departMsFromInput(),
      liveBuses: busesRef.current,
      signal: controller.signal,
      onProgress: (message) => {
        if (!cancelled) setProgress(message);
      },
    })
      .then((result) => {
        if (cancelled) return;
        setPlan({ status: "done", plan: result });
        const next =
          result.journeys.find((j) => j.id === activeIdRef.current) ??
          result.journeys[0] ??
          null;
        setActiveId(next?.id ?? null);
        previewRef.current(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        previewRef.current(null);
        setPlan({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Nie udało się przeanalizować rozkładu.",
        });
      })
      .finally(() => {
        if (!cancelled) {
          setRefreshing(false);
          busyRef.current = false;
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
      busyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, destination, departInput, refreshNonce, autoTick]);

  useEffect(() => {
    if (!origin || !destination) return;
    const timer = window.setInterval(() => {
      if (!document.hidden && !busyRef.current)
        setAutoTick((value) => value + 1);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [origin, destination]);

  const locateMe = () => {
    if (!("geolocation" in navigator)) {
      setLocateError("Przeglądarka nie udostępnia lokalizacji.");
      return;
    }
    setLocating(true);
    setLocateError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        onOriginChange({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          label: "Moja lokalizacja",
        });
      },
      () => {
        setLocating(false);
        setLocateError(
          "Brak dostępu do lokalizacji — użyj kliknięcia na mapie.",
        );
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
    );
  };

  const togglePick = (target: "origin" | "destination") => {
    onPickTargetChange(pickTarget === target ? null : target);
  };

  const ready = Boolean(origin && destination);
  const journeys = plan.status === "done" ? plan.plan.journeys : [];
  const fastestId = journeys.length
    ? journeys.reduce(
        (best, j) => (j.arriveMs < best.arriveMs ? j : best),
        journeys[0],
      ).id
    : null;
  const nearestId = journeys[0]?.id ?? null;

  const pickButton = (target: "origin" | "destination") => (
    <button
      type="button"
      onClick={() => togglePick(target)}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1.5 text-[8px] font-extrabold transition-colors",
        pickTarget === target
          ? "border-sky-500/50 bg-sky-500/15 text-sky-700 dark:text-sky-300"
          : "border-line text-ink-soft hover:bg-raised hover:text-ink",
      )}
    >
      <MapPin className="h-3 w-3" strokeWidth={2.4} />
      Mapa
    </button>
  );

  return (
    <div className="pointer-events-auto flex max-h-[min(640px,calc(100dvh-280px))] w-[332px] max-w-[calc(100vw-24px)] select-none flex-col overflow-hidden rounded-[14px] border border-line/80 bg-surface/96 shadow-[0_16px_44px_rgba(13,42,28,0.19)] backdrop-blur-xl animate-rise-in dark:bg-surface/93">
      <div className="flex shrink-0 items-center gap-2 border-b border-line/70 bg-brand-soft/80 px-3 py-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand text-on-brand">
          <Route className="h-3.5 w-3.5" strokeWidth={2.4} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[12px] font-extrabold leading-tight tracking-[-0.01em] text-ink">
            Planer podróży
          </h3>
          <p className="text-[7.5px] font-bold uppercase tracking-[0.12em] text-brand-ink/75">
            rozkład + GPS · skomunikowania
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Zamknij planer podróży"
          className="grid h-6 w-6 place-items-center rounded-md text-mute transition-colors hover:bg-surface hover:text-ink"
        >
          <X className="h-3 w-3" strokeWidth={2.3} />
        </button>
      </div>

      <div className="scroll-area min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        {pickTarget && (
          <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2 py-1.5 text-[8.5px] font-bold text-sky-700 dark:text-sky-300">
            <Crosshair className="h-3 w-3 shrink-0" strokeWidth={2.4} />
            <span className="min-w-0 flex-1">
              Kliknij na mapie (lub na przystanku), aby zaznaczyć{" "}
              {pickTarget === "origin" ? "punkt startowy" : "cel"}.
            </span>
            <button
              type="button"
              onClick={() => onPickTargetChange(null)}
              className="shrink-0 rounded border border-current px-1 py-0.5 text-[7px] font-extrabold uppercase"
            >
              Anuluj
            </button>
          </div>
        )}

        {/* Skąd */}
        <div className="text-[8px] font-extrabold uppercase tracking-[0.14em] text-mute">
          Skąd
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <span
            className={cn(
              "min-w-0 flex-1 truncate rounded-lg border px-2 py-1.5 text-[9.5px] font-bold",
              origin
                ? "border-line bg-raised text-ink"
                : "border-dashed border-line-strong bg-transparent text-mute",
            )}
          >
            {origin ? origin.label : "nie ustawiono"}
          </span>
          <button
            type="button"
            onClick={locateMe}
            disabled={locating}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1.5 text-[8px] font-extrabold text-ink-soft transition-colors hover:bg-raised hover:text-ink disabled:opacity-60"
          >
            {locating ? (
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.4} />
            ) : (
              <LocateFixed className="h-3 w-3" strokeWidth={2.4} />
            )}
            Lokalizacja
          </button>
          {pickButton("origin")}
          {origin && (
            <button
              type="button"
              onClick={() => onOriginChange(null)}
              aria-label="Wyczyść punkt startowy"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-mute transition-colors hover:bg-raised hover:text-ink"
            >
              <X className="h-3 w-3" strokeWidth={2.4} />
            </button>
          )}
        </div>
        {locateError && (
          <p className="mt-1 text-[8px] font-semibold text-warning">
            {locateError}
          </p>
        )}

        {/* Dokąd */}
        <div className="mt-3 text-[8px] font-extrabold uppercase tracking-[0.14em] text-mute">
          Dokąd
        </div>
        {destination ? (
          <div className="mt-1 flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate rounded-lg border border-line bg-raised px-2 py-1.5 text-[9.5px] font-bold text-ink">
              {destination.label}
            </span>
            {pickButton("destination")}
            <button
              type="button"
              onClick={() => {
                setQuery("");
                onDestinationChange(null);
              }}
              aria-label="Wyczyść cel"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-mute transition-colors hover:bg-raised hover:text-ink"
            >
              <X className="h-3 w-3" strokeWidth={2.4} />
            </button>
          </div>
        ) : (
          <div className="relative mt-1">
            <div className="flex items-center gap-1.5">
              <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5 focus-within:border-brand/60">
                {searching ? (
                  <Loader2
                    className="h-3 w-3 shrink-0 animate-spin text-mute"
                    strokeWidth={2.4}
                  />
                ) : (
                  <Search
                    className="h-3 w-3 shrink-0 text-mute"
                    strokeWidth={2.4}
                  />
                )}
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Szukaj przystanku docelowego…"
                  className="w-full min-w-0 bg-transparent text-[9.5px] font-bold text-ink outline-none placeholder:font-semibold placeholder:text-mute"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Wyczyść wyszukiwanie"
                    className="grid h-4 w-4 shrink-0 place-items-center rounded text-mute hover:text-ink"
                  >
                    <X className="h-2.5 w-2.5" strokeWidth={2.6} />
                  </button>
                )}
              </span>
              {pickButton("destination")}
            </div>
            {results.length > 0 && (
              <div className="absolute inset-x-0 top-full z-[130] mt-1 overflow-hidden rounded-lg border border-line bg-surface shadow-[0_12px_32px_rgba(9,35,23,0.2)]">
                {results.map((stop) => (
                  <button
                    key={stop.id}
                    type="button"
                    onClick={() => {
                      onDestinationChange({
                        lat: stop.lat,
                        lon: stop.lon,
                        label: stop.name,
                        stopId: stop.id,
                      });
                      onPickTargetChange(null);
                      setQuery("");
                      setResults([]);
                    }}
                    className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-brand-soft/70"
                  >
                    <MapPin
                      className="h-2.5 w-2.5 shrink-0 text-brand-ink"
                      strokeWidth={2.4}
                    />
                    <span className="min-w-0 flex-1 truncate text-[9px] font-bold text-ink">
                      {stop.name}
                    </span>
                    <span className="shrink-0 text-[7px] font-bold uppercase text-mute">
                      {stop.agency}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Odjazd */}
        <div className="mt-3 flex items-center gap-1.5">
          <span className="text-[8px] font-extrabold uppercase tracking-[0.14em] text-mute">
            Odjazd
          </span>
          <button
            type="button"
            onClick={() => setDepartInput("")}
            className={cn(
              "rounded-md border px-1.5 py-1 text-[8px] font-extrabold transition-colors",
              departInput === ""
                ? "border-brand/50 bg-brand-soft text-brand-ink"
                : "border-line text-ink-soft hover:bg-raised hover:text-ink",
            )}
          >
            Teraz
          </button>
          <input
            type="time"
            value={departInput}
            onChange={(event) => setDepartInput(event.target.value)}
            aria-label="Godzina odjazdu"
            className="h-6 rounded-md border border-line bg-surface px-1.5 font-mono text-[8.5px] font-bold text-ink outline-none focus:border-brand/60"
          />
          {departInput && (
            <span className="text-[7px] font-semibold text-mute">dziś</span>
          )}
        </div>

        {/* Wyniki */}
        <div className="mt-3 border-t border-line/70 pt-2">
          <div className="flex items-center justify-between">
            <span className="text-[8px] font-extrabold uppercase tracking-[0.14em] text-mute">
              {ready
                ? plan.status === "done"
                  ? `Połączenia od ${clock(plan.plan.searchedFromMs)}`
                  : "Połączenia"
                : "Jak to działa"}
            </span>
            {ready && plan.status !== "loading" && (
              <button
                type="button"
                onClick={onRefresh}
                className="flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[7.5px] font-extrabold text-ink-soft transition-colors hover:bg-raised hover:text-ink"
              >
                <RefreshCw
                  className={cn("h-2.5 w-2.5", refreshing && "animate-spin")}
                  strokeWidth={2.6}
                />
                Odśwież
              </button>
            )}
          </div>

          {!ready && (
            <p className="mt-1.5 text-[8.5px] leading-snug text-mute">
              Ustaw punkt startowy (lokalizacja lub klik na mapie) i cel
              (wyszukiwarka albo klik na mapie). Planer liczy połączenia na
              rozkładzie z przesiadkami — kolejny kurs szuka od godziny
              przyjazdu na przystanek — i koryguje czasy o opóźnienia wozów z
              GPS.
            </p>
          )}

          {ready && plan.status === "loading" && (
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-line bg-raised/70 px-2.5 py-2 text-[8.5px] font-bold text-ink-soft">
              <Loader2
                className="h-3.5 w-3.5 animate-spin text-brand-ink"
                strokeWidth={2.4}
              />
              {progress}
            </div>
          )}

          {ready && plan.status === "error" && (
            <p className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-2 text-[8.5px] font-semibold leading-snug text-danger">
              {plan.message}
            </p>
          )}

          {ready && plan.status === "done" && (
            <div className="mt-2 flex flex-col gap-1.5">
              {plan.plan.note && (
                <p className="rounded-lg border border-line bg-raised/70 px-2.5 py-1.5 text-[8px] font-semibold leading-snug text-ink-soft">
                  {plan.plan.note}
                </p>
              )}
              {journeys.map((journey) => (
                <JourneyCard
                  key={journey.id}
                  journey={journey}
                  nearest={journey.id === nearestId}
                  fastest={journey.id === fastestId && journeys.length > 1}
                  active={activeId === journey.id}
                  now={now}
                  onActivate={() => {
                    setActiveId(journey.id);
                    onPreview(journey);
                  }}
                  onSelectBus={onSelectBus}
                  onCenter={onCenter}
                />
              ))}
              {journeys.length > 0 && (
                <>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-line/70 bg-raised/50 px-2 py-1.5 text-[7px] font-bold text-mute">
                    <span className="flex items-center gap-1">
                      <span className="h-[3px] w-4 rounded-full bg-brand" />{" "}
                      jazda autobusem
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="h-0 w-4 border-t-2 border-dotted border-teal-600" />{" "}
                      pieszo
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-[#0891b2]" />{" "}
                      start
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-[#e11d48]" /> cel
                    </span>
                  </div>
                  <p className="px-0.5 text-[7px] font-semibold leading-snug text-mute">
                    Czasy z rozkładu GTFS; dla kursów z wozem na mapie
                    uwzględniono opóźnienie GPS. Dojścia po drogach i ścieżkach
                    OpenStreetMap; czas marszu jest szacunkowy. Na przesiadkę
                    doliczamy 1,5 min zapasu, na pierwsze wejście 30 s. Lista
                    odświeża się co 30 s.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
