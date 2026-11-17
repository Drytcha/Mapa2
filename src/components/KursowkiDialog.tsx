import { useEffect, useState } from "react";
import { BusFront, Loader2, X } from "lucide-react";
import { Dialog } from "./Modals";
import BrigadesPanel from "./BrigadesPanel";
import { getGtfsLines, type GtfsLineItem } from "@/lib/engine/gtfsStore";
import type { LiveBusVehicle, Waypoint } from "@/lib/types";

interface Props {
  open: boolean;
  initialKursowkaId?: string | null;
  initialKursowkaCode?: string | null;
  liveVehicles: LiveBusVehicle[];
  onSelectBus: (bus: LiveBusVehicle) => void;
  /** Uwagi techniczne o dopasowaniu brygad widzi tylko planista. */
  isPlanner?: boolean;
  onClose: () => void;
  onLoadTripToPlanner: (payload: {
    line: string;
    duty: string;
    waypoints: Waypoint[];
    departureTime?: string;
    headsign?: string;
  }) => void;
  canLoadToPlanner?: boolean;
}

export default function KursowkiDialog({
  open,
  initialKursowkaId,
  initialKursowkaCode,
  liveVehicles,
  onSelectBus,
  onClose,
  onLoadTripToPlanner,
  canLoadToPlanner = true,
  isPlanner = false,
}: Props) {
  const [routes, setRoutes] = useState<GtfsLineItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!open || routes.length) return;
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    getGtfsLines()
      .then((data) => {
        if (!cancelled) setRoutes(data.routes);
      })
      .catch((cause) => {
        if (!cancelled) {
          setLoadError(
            cause instanceof Error
              ? cause.message
              : "Nie udało się wczytać listy linii.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, routes.length]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="Kursówki Wałbrzych"
      className="duty-dialog-shell h-[92dvh] max-w-[1180px]"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-brand-soft text-brand-ink">
          <BusFront className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-[13px] font-extrabold tracking-[-0.02em] text-ink">
          Kursówki Wałbrzych
        </h2>
        <span className="hidden min-w-0 truncate text-[9px] text-mute sm:inline">
          Brygady według linii i daty · pełny rozkład, także bez autobusu na GPS
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
      <div className="scroll-area min-h-0 flex-1 overflow-y-auto p-2 min-[900px]:overflow-hidden sm:p-2.5">
        {loading && !routes.length ? (
          <div
            role="status"
            className="flex items-center gap-2 py-12 text-[10px] text-mute"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Wczytywanie linii Wałbrzych…
          </div>
        ) : loadError && !routes.length ? (
          <div
            role="alert"
            className="rounded-lg border border-warning/30 bg-warning-soft p-4 text-xs text-warning"
          >
            {loadError}
          </div>
        ) : (
          <BrigadesPanel
            routes={routes}
            liveVehicles={liveVehicles}
            onSelectBus={onSelectBus}
            onLoadTripToPlanner={onLoadTripToPlanner}
            initialKursowkaId={initialKursowkaId}
            initialKursowkaCode={initialKursowkaCode}
            canLoadToPlanner={canLoadToPlanner}
            showTechnicalNotes={isPlanner}
          />
        )}
      </div>
    </Dialog>
  );
}
