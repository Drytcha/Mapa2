import { useState } from "react";
import { Loader2, MapPinned, X } from "lucide-react";
import { formatDelay, formatVehicleNumber } from "@/lib/delay";
import type { DepartureDirection } from "@/lib/departureGroups";
import type { StopDepartureItem } from "@/lib/types";
import { formatWarsawClock } from "@/lib/core/time";

export interface DepartureEntry {
  departure: StopDepartureItem;
  direction: DepartureDirection;
}

/**
 * Szczegóły jednego odjazdu (GPS, wóz, przewoźnik, przebieg kursu, kursówka).
 * Współdzielone przez pełny rozkład dnia i tablicę „Najbliższe” (jak w myBus 3.0).
 */
export default function StopDepartureDetail({
  line,
  entry,
  directionCount,
  onClose,
  onOpenKursowka,
  onPreviewCourse,
}: {
  line: string;
  entry: DepartureEntry;
  directionCount: number;
  onClose: () => void;
  onOpenKursowka?: (id: string, code: string) => void;
  onPreviewCourse?: (tripId: string, dateId: string) => Promise<boolean>;
}) {
  const [previewing, setPreviewing] = useState(false);
  const { departure, direction } = entry;
  return (
    <div
      className="mt-2 border-l-2 border-brand bg-brand-soft/50 py-1.5 pl-2 pr-1 text-[10px] leading-relaxed"
      role="region"
      aria-label="Szczegóły odjazdu"
    >
      <div className="flex items-start justify-between gap-1">
        <p className="font-bold text-ink">
          {departure.clock}
          {direction.suffix}
          {" → "}
          {direction.legendText ?? direction.label}
          {direction.main && directionCount > 1 && (
            <span className="ml-1 rounded bg-surface px-1 py-0.5 text-[8px] font-bold text-mute ring-1 ring-line">
              kierunek główny
            </span>
          )}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Zamknij szczegóły odjazdu"
          className="grid h-6 w-6 shrink-0 place-items-center rounded hover:bg-surface"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {direction.legendText && (
        <p className="text-ink-soft">Kierunek: {direction.label}</p>
      )}
      {departure.isRealtime ? (
        <p className="text-brand-ink">
          GPS: {formatDelay(departure.delaySeconds)} · przewidywany{" "}
          {formatWarsawClock(departure.atMs + departure.delaySeconds * 1000)}
        </p>
      ) : (
        <p className="text-mute">Według rozkładu; brak prognozy GPS.</p>
      )}
      {departure.vehicleId ? (
        <p className="text-ink-soft">
          Wóz {formatVehicleNumber(departure.vehicleId)}{" "}
          {departure.operatorName}
        </p>
      ) : departure.operatorName ? (
        <p className="text-ink-soft">Przewoźnik: {departure.operatorName}</p>
      ) : null}
      {onPreviewCourse && departure.canPreviewCourse !== false && (
        <button
          type="button"
          data-testid="preview-departure-course"
          aria-label={`Pokaż przebieg kursu linii ${line} z ${departure.clock}`}
          onClick={async () => {
            if (previewing) return;
            setPreviewing(true);
            try {
              await onPreviewCourse(departure.tripId, departure.serviceDateId);
            } finally {
              setPreviewing(false);
            }
          }}
          disabled={previewing}
          className="mt-1.5 flex h-7 w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-2 text-[9px] font-extrabold text-on-brand transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {previewing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <MapPinned className="h-3 w-3" />
          )}
          Pokaż przebieg kursu na mapie
        </button>
      )}
      {departure.kursowka && onOpenKursowka && (
        <button
          type="button"
          className="mt-1 font-bold text-brand-ink underline underline-offset-2"
          onClick={() => onOpenKursowka(departure.kursowkaId, departure.kursowka)}
        >
          Kursówka {departure.kursowka}
          {departure.operatorKey === "mzuk"
            ? " (MZUK)"
            : departure.operatorKey === "ska"
              ? " (ŚKA)"
              : ""}
        </button>
      )}
    </div>
  );
}
