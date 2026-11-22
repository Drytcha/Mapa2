import { BusFront, CircleDot, Flag, Loader2 } from "lucide-react";
import {
  buildTripProgress,
  describeStopDelta,
  TRIP_LEGEND,
  type TripStopRow,
} from "@/lib/liveBusProgress";
import { formatWarsawClock } from "@/lib/core/time";
import { cn } from "@/utils/cn";

/**
 * „Jak jedzie” — pełny przebieg kursu wybranego autobusu (wzór: myBus 3.0).
 * Wszystkie przystanki od początku do końcowego, przebyte wyszarzone, autobus
 * zaznaczony na osi. Obok godzina z rozkładu i prognoza GPS z różnicą.
 */
export default function LiveBusRunPanel({
  stops,
  complete,
  loading,
  delaySeconds,
  isRealtime,
  emptyLabel = "Brak danych o przystankach tego kursu.",
}: {
  stops: Parameters<typeof buildTripProgress>[0];
  complete: boolean;
  loading: boolean;
  delaySeconds: number;
  isRealtime: boolean;
  emptyLabel?: string;
}) {
  const rows = buildTripProgress(stops, { delaySeconds, isRealtime });
  if (!rows.length) {
    return (
      <p className="py-2 text-[9px] text-mute">
        {loading ? (
          <span className="flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" /> Wczytywanie przebiegu kursu…
          </span>
        ) : (
          emptyLabel
        )}
      </p>
    );
  }
  return (
    <div data-testid="bus-run-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[8px] font-extrabold uppercase tracking-[0.14em] text-mute">
          Przebieg kursu ({rows.length} przystanków)
        </span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-mute" />}
      </div>
      {!complete && (
        <p className="mt-1 rounded border border-warning/35 bg-warning-soft/60 px-1.5 py-1 text-[8px] leading-snug text-warning">
          Kursu nie ma w paczce rozkładu — pokazano tylko przystanki z GPS.
          Wcześniejszych nie znamy.
        </p>
      )}
      <ul
        className="scroll-area mt-1.5 max-h-[260px] overflow-y-auto pr-1"
        aria-label="Przebieg kursu — wszystkie przystanki"
      >
        {rows.map((row) => (
          <TripRow key={row.key} row={row} isLast={row === rows[rows.length - 1]} />
        ))}
      </ul>
      <div
        className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line/70 pt-1.5 text-[7.5px] text-mute"
        aria-label="Legenda punktualności"
      >
        {TRIP_LEGEND.map((entry) => (
          <span key={entry.label} className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: entry.style.bg }}
            />
            {entry.label}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full ring-1 ring-mute" />
          Brak GPS
        </span>
      </div>
      <p className="mt-1 text-[7px] leading-snug text-mute">
        Godzina z lewej — rozkład, kolorowa obok — prognoza GPS. Przebyte
        przystanki są wyszarzone. Czas polski.
      </p>
    </div>
  );
}

function TripRow({ row, isLast }: { row: TripStopRow; isLast: boolean }) {
  const passed = row.status === "passed";
  const isCurrent = row.status === "current";
  const isFinal = row.status === "final";
  const isNext = row.status === "next";
  return (
    <li
      data-testid="trip-stop"
      data-status={row.status}
      className={cn(
        "relative flex items-start gap-1.5 py-[3px] pl-0.5 text-[9px]",
        passed && "opacity-55",
      )}
    >
      <span aria-hidden="true" className="relative flex w-3 shrink-0 justify-center self-stretch">
        {!isLast && (
          <span
            className={cn(
              "absolute left-1/2 top-2 h-[calc(100%-2px)] w-px -translate-x-1/2",
              passed ? "bg-line" : "bg-brand/40",
            )}
          />
        )}
        {isCurrent ? (
          <BusFront className="relative z-10 mt-px h-3 w-3 rounded-full bg-brand p-[1.5px] text-on-brand" />
        ) : isFinal ? (
          <Flag className="relative z-10 mt-px h-2.5 w-2.5 text-brand-ink" />
        ) : (
          <CircleDot
            className={cn(
              "relative z-10 mt-px h-2.5 w-2.5 bg-surface",
              isNext ? "text-brand" : passed ? "text-line-strong" : "text-brand-ink/60",
            )}
          />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-semibold",
          passed ? "text-mute line-through decoration-line-strong/70" : "text-ink",
          (isCurrent || isNext) && "font-extrabold",
        )}
        title={row.name}
      >
        {row.name}
        {isCurrent && (
          <span className="ml-1 rounded bg-brand px-1 py-[1px] text-[6.5px] font-extrabold uppercase tracking-wide text-on-brand">
            tu jest
          </span>
        )}
        {isFinal && (
          <span className="ml-1 rounded bg-brand/15 px-1 py-[1px] text-[6.5px] font-extrabold uppercase tracking-wide text-brand-ink">
            końcowy
          </span>
        )}
      </span>
      <span
        className={cn(
          "shrink-0 font-mono text-[8.5px] font-bold tabular-nums",
          passed ? "text-mute" : "text-ink-soft",
        )}
      >
        {formatWarsawClock(row.plannedMs)}
      </span>
      {row.predictedMs !== null && !passed && (
        <span
          className="metric shrink-0 rounded px-1 font-mono text-[8.5px] font-extrabold tabular-nums"
          style={{ background: row.toneStyle.bg, color: row.toneStyle.fg }}
          title={`Prognoza GPS: ${formatWarsawClock(row.predictedMs)} (${describeStopDelta(
            row.deltaSeconds,
          )})`}
        >
          {formatWarsawClock(row.predictedMs)}
        </span>
      )}
    </li>
  );
}
