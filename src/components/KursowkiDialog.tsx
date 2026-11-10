import { useEffect, useState } from "react";
import { BusFront, Loader2 } from "lucide-react";
import { Dialog, ModalHeader } from "./Modals";
import BrigadesPanel from "./BrigadesPanel";
import { getGtfsLines, type GtfsLineItem } from "@/lib/engine/gtfsStore";
import type { LiveBusVehicle, Waypoint } from "@/lib/types";

interface Props {
  open: boolean;
  initialKursowkaId?: string | null;
  initialKursowkaCode?: string | null;
  liveVehicles: LiveBusVehicle[];
  onSelectBus: (bus: LiveBusVehicle) => void;
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
            cause instanceof Error ? cause.message : "Nie udało się wczytać listy linii."
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
      className="max-w-[1120px] duty-dialog-shell"
    >
      <ModalHeader
        eyebrow="Pełny rozkład · wszystkie brygady"
        title="Kursówki Wałbrzych"
        subtitle="Katalog brygad według linii i daty — wszystkie kursy z rozkładu, także gdy autobus nie jest teraz w mieście."
        onClose={onClose}
        icon={<BusFront className="h-5 w-5" />}
      />
      <div className="scroll-area min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
        {loading && !routes.length ? (
          <div role="status" className="flex items-center gap-2 py-16 text-xs text-mute">
            <Loader2 className="h-4 w-4 animate-spin" />
            Wczytywanie linii Wałbrzych…
          </div>
        ) : loadError && !routes.length ? (
          <div role="alert" className="rounded-lg border border-warning/30 bg-warning-soft p-4 text-xs text-warning">
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
          />
        )}
      </div>
    </Dialog>
  );
}
