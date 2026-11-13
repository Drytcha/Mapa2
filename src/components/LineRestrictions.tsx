import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Construction,
  ExternalLink,
  Footprints,
  Loader2,
  MapPin,
  RefreshCw,
  Ruler,
  TrainFront,
  TriangleAlert,
  Weight,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { formatDistanceCompact } from "@/lib/geo";
import {
  getLineBridgeRestrictions,
  type BridgeRestriction,
  type LineRestrictions,
} from "@/lib/engine/bridgeRestrictions";

interface Props {
  /** Linie obsługiwane przez kursówkę (zwykle jedna). */
  lines: string[];
  className?: string;
}

const decimal = (value: number) =>
  value.toLocaleString("pl-PL", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  });

const SEVERITY_STYLE = {
  critical: {
    border: "border-danger/50 bg-danger/10",
    dot: "bg-danger",
    text: "text-danger",
    icon: TriangleAlert,
  },
  warning: {
    border: "border-warning/45 bg-warning-soft/60",
    dot: "bg-warning",
    text: "text-warning",
    icon: TriangleAlert,
  },
  info: {
    border: "border-line bg-raised/70",
    dot: "bg-emerald-500",
    text: "text-ink-soft",
    icon: Construction,
  },
  none: {
    border: "border-line bg-raised/60",
    dot: "bg-mute",
    text: "text-mute",
    icon: Construction,
  },
} as const;

function KindIcon({ item }: { item: BridgeRestriction }) {
  if (item.kind === "bridge-rail") return <TrainFront className="h-3 w-3" />;
  if (item.kind === "footbridge") return <Footprints className="h-3 w-3" />;
  return <Construction className="h-3 w-3" />;
}

function RestrictionRow({ item }: { item: BridgeRestriction }) {
  const style = SEVERITY_STYLE[item.severity];
  const osmUrl = /^(node|way|relation)-(\d+)$/.exec(item.id);
  return (
    <li
      className={cn("rounded-lg border px-2 py-1.5", style.border)}
      data-testid="bridge-restriction"
      data-severity={item.severity}
    >
      <div className="flex items-start gap-1.5">
        <span
          className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", style.dot)}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1">
            <span className={cn("mt-px shrink-0", style.text)}>
              <KindIcon item={item} />
            </span>
            <div className="min-w-0 flex-1">
              <p
                className="truncate text-[10px] font-extrabold leading-tight text-ink"
                title={item.name}
              >
                {item.name}
              </p>
              <p className="truncate text-[7.5px] font-semibold text-mute">
                {item.kindLabel}
                {item.carries ? ` · ${item.carries}` : ""}
              </p>
            </div>
            {osmUrl && (
              <a
                href={`https://www.openstreetmap.org/${osmUrl[1]}/${osmUrl[2]}`}
                target="_blank"
                rel="noreferrer"
                className="grid h-5 w-5 shrink-0 place-items-center rounded text-mute hover:bg-surface hover:text-brand-ink"
                aria-label={`${item.name} w OpenStreetMap`}
                title="Zobacz obiekt w OpenStreetMap"
              >
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {item.clearanceM !== null ? (
              <span
                className={cn(
                  "metric rounded px-1 py-0.5 text-[8px] font-extrabold ring-1",
                  item.severity === "critical"
                    ? "bg-danger/15 text-danger ring-danger/30"
                    : item.severity === "warning"
                      ? "bg-warning/15 text-warning ring-warning/30"
                      : "bg-surface text-ink ring-line",
                )}
                title={`maxheight = ${item.clearanceRaw ?? `${item.clearanceM} m`}`}
              >
                <Ruler className="mr-0.5 inline h-2 w-2" />
                {decimal(item.clearanceM)} m
              </span>
            ) : (
              <span className="rounded bg-surface px-1 py-0.5 text-[7.5px] font-bold text-mute ring-1 ring-line">
                brak limitu wysokości
              </span>
            )}
            {item.weightT !== null && (
              <span
                className="metric rounded bg-surface px-1 py-0.5 text-[8px] font-bold text-ink-soft ring-1 ring-line"
                title={`maxweight = ${item.weightRaw ?? `${item.weightT} t`}`}
              >
                <Weight className="mr-0.5 inline h-2 w-2" />
                {decimal(item.weightT)} t
              </span>
            )}
            {item.widthM !== null && (
              <span className="metric rounded bg-surface px-1 py-0.5 text-[8px] font-bold text-ink-soft ring-1 ring-line">
                szer. {decimal(item.widthM)} m
              </span>
            )}
            {item.lanes !== null && item.lanes > 0 && (
              <span className="rounded bg-surface px-1 py-0.5 text-[7.5px] font-bold text-mute ring-1 ring-line">
                {item.lanes} pas.
              </span>
            )}
          </div>
          <p className={cn("mt-0.5 text-[7.5px] font-bold", style.text)}>
            {item.severityLabel}
          </p>
          <p className="flex items-center gap-0.5 text-[7px] leading-snug text-mute">
            <MapPin className="h-2 w-2 shrink-0" />
            <span className="min-w-0 truncate">
              {item.relationLabel}
              {item.nearestStop
                ? ` · ${item.nearestStop}${item.nearestStopMeters !== null ? ` (${formatDistanceCompact(item.nearestStopMeters)})` : ""}`
                : ""}
            </span>
          </p>
        </div>
      </div>
    </li>
  );
}

function LineSection({ data }: { data: LineRestrictions }) {
  const [showAll, setShowAll] = useState(false);
  const restrictions = useMemo(
    () =>
      data.items.filter(
        (item) => item.severity === "critical" || item.severity === "warning",
      ),
    [data.items],
  );
  const shown = showAll
    ? data.items
    : restrictions.length
      ? restrictions.slice(0, 4)
      : data.items.slice(0, 3);
  const hiddenCount = data.items.length - shown.length;

  return (
    <div className="space-y-1" data-testid="line-restrictions">
      <div className="flex items-center gap-1">
        <span className="metric rounded bg-surface px-1 py-0.5 text-[9px] font-extrabold text-ink ring-1 ring-line">
          {data.routeShort}
        </span>
        <span className="text-[8px] font-bold text-ink-soft">
          {data.restrictionsCount > 0
            ? `${data.restrictionsCount} ${data.restrictionsCount === 1 ? "ograniczenie" : data.restrictionsCount < 5 ? "ograniczenia" : "ograniczeń"}`
            : "bez ograniczeń wysokości"}
        </span>
        {data.criticalCount > 0 && (
          <span className="rounded bg-danger/15 px-1 py-0.5 text-[7.5px] font-extrabold text-danger ring-1 ring-danger/30">
            krytyczne: {data.criticalCount}
          </span>
        )}
        <span className="ml-auto text-[7px] font-semibold text-mute">
          {data.source === "live"
            ? "OSM · teraz"
            : data.source === "cache"
              ? "OSM · cache"
              : "OSM · nieaktualne"}
        </span>
      </div>
      {data.note && (
        <p className="rounded border border-line bg-raised/60 px-1.5 py-1 text-[7.5px] leading-snug text-mute">
          {data.note}
        </p>
      )}
      {shown.length > 0 ? (
        <ul className="space-y-1">
          {shown.map((item) => (
            <RestrictionRow key={item.id} item={item} />
          ))}
        </ul>
      ) : (
        <p className="py-1 text-[8px] text-mute">
          Brak wiaduktów w pobliżu trasy.
        </p>
      )}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          className="flex w-full items-center justify-center gap-1 rounded border border-line bg-surface py-1 text-[8px] font-bold text-ink-soft hover:bg-raised hover:text-ink"
        >
          {showAll ? (
            <>
              <ChevronUp className="h-2.5 w-2.5" /> Pokaż tylko ograniczenia
            </>
          ) : (
            <>
              <ChevronDown className="h-2.5 w-2.5" /> Pokaż wszystkie obiekty (+
              {hiddenCount})
            </>
          )}
        </button>
      )}
    </div>
  );
}

/** Sekcja techniczna kursówki: wiadukty, tunele i limity na trasie linii. */
export default function LineRestrictions({ lines, className }: Props) {
  const key = lines
    .map((line) => line.toUpperCase())
    .sort()
    .join(",");
  const [data, setData] = useState<LineRestrictions[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!key) {
      setData([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    Promise.all(
      lines.map((line) =>
        getLineBridgeRestrictions(line, {
          signal: controller.signal,
          force: retry > 0,
        }).catch((cause: unknown) => {
          if (controller.signal.aborted) return null;
          throw cause;
        }),
      ),
    )
      .then((results) => {
        if (cancelled) return;
        setData(
          results.filter((item): item is LineRestrictions => Boolean(item)),
        );
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Nie udało się pobrać danych o wiaduktach.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // `lines` jest reprezentowane przez stabilny klucz `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);

  const totalRestrictions = data.reduce(
    (sum, item) => sum + item.restrictionsCount,
    0,
  );
  const totalCritical = data.reduce((sum, item) => sum + item.criticalCount, 0);

  return (
    <section
      className={cn("rounded-lg border border-line bg-surface", className)}
      aria-label="Wiadukty i ograniczenia na trasie linii"
      data-testid="line-restrictions-section"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left"
      >
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-brand-soft text-brand-ink">
          <Construction className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-extrabold leading-tight text-ink">
            Wiadukty i ograniczenia
          </span>
          <span className="block truncate text-[7px] font-semibold text-mute">
            wysokość, masa, przejazd pod obiektem · OpenStreetMap
          </span>
        </span>
        {loading && (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-mute" />
        )}
        {!loading && totalCritical > 0 && (
          <span className="rounded bg-danger/15 px-1 py-0.5 text-[7.5px] font-extrabold text-danger ring-1 ring-danger/30">
            {totalCritical} kryt.
          </span>
        )}
        {!loading && totalRestrictions > 0 && (
          <span className="rounded bg-warning-soft px-1 py-0.5 text-[7.5px] font-extrabold text-warning ring-1 ring-warning/30">
            {totalRestrictions} ogr.
          </span>
        )}
        {open ? (
          <ChevronUp className="h-3 w-3 shrink-0 text-mute" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0 text-mute" />
        )}
      </button>
      {open && (
        <div className="border-t border-line px-2.5 py-2">
          {loading && !data.length ? (
            <p
              role="status"
              className="flex items-center gap-1.5 py-1.5 text-[8px] font-semibold text-mute"
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              Sprawdzam wiadukty i limity wysokości na linii {lines.join(", ")}…
            </p>
          ) : error ? (
            <div
              role="alert"
              className="rounded border border-warning/40 bg-warning-soft/60 px-2 py-1.5 text-[8px] leading-snug text-warning"
            >
              {error}
              <button
                type="button"
                onClick={() => setRetry((value) => value + 1)}
                className="ml-1 inline-flex items-center gap-0.5 font-extrabold underline"
              >
                <RefreshCw className="h-2.5 w-2.5" /> Spróbuj ponownie
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {data.map((item) => (
                <LineSection key={item.signature} data={item} />
              ))}
              <p className="text-[7px] leading-snug text-mute">
                Limity z tagów OSM (maxheight/maxweight). Wysokość autobusu ~3,5
                m; ostateczne oznaczenie i prześwit sprawdź w terenie. Dane
                zapisywane na 30 dni.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
