import { useCallback, useEffect, useState } from "react";
import { BusFront, DownloadCloud, Loader2, X } from "lucide-react";
import { onRuntimeEvent } from "@/lib/core/runtimeHub";
import {
  getGtfsLines,
  syncWalbrzychGtfs,
  type GtfsLineItem,
} from "@/lib/engine/gtfsStore";
import type { LiveBusVehicle, Waypoint } from "@/lib/types";
import { cn } from "@/utils/cn";
import BrigadesPanel from "./BrigadesPanel";
import type { KursowkaShapeOverlay } from "./MapView";
import { Dialog } from "./Modals";

interface Props {
  open: boolean;
  initialKursowkaId?: string | null;
  initialKursowkaCode?: string | null;
  initialDateId?: string | null;
  liveVehicles: LiveBusVehicle[];
  onSelectBus: (bus: LiveBusVehicle) => void;
  /** Uwagi techniczne, rozliczenie km/godzin i podział wg firm widzi planista. */
  isPlanner?: boolean;
  onClose: () => void;
  onShowShapeOverlay?: (overlay: KursowkaShapeOverlay) => void;
  onPreviewCourse?: (tripId: string, dateId: string) => Promise<boolean>;
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
  initialDateId,
  liveVehicles,
  onSelectBus,
  onClose,
  onShowShapeOverlay,
  onPreviewCourse,
  onLoadTripToPlanner,
  canLoadToPlanner = true,
  isPlanner = false,
}: Props) {
  const [routes, setRoutes] = useState<GtfsLineItem[]>([]);
  const [feedInfo, setFeedInfo] = useState<{ version: string; source: string } | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");

  const loadLines = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const data = await getGtfsLines();
      setRoutes(data.routes);
      if (data.feed) {
        setFeedInfo({
          version: data.feed.version,
          source: data.feed.source,
        });
      }
    } catch (cause) {
      setLoadError(
        cause instanceof Error
          ? cause.message
          : "Nie udało się wczytać listy linii."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    if (!routes.length) void loadLines();
    return onRuntimeEvent("gtfs:updated", () => {
      void loadLines();
    });
  }, [open, routes.length, loadLines]);

  const handleSyncGtfs = async () => {
    setSyncing(true);
    setSyncNotice(null);
    setLoadError("");
    try {
      const res = await syncWalbrzychGtfs({ forceLive: true });
      await loadLines();
      setSyncNotice(
        `Zaktualizowano z gtfs.walbrzych.eu: wydanie ${res.version.split("+")[0]} (${res.routes} linii, ${res.trips} kursów).`
      );
    } catch (cause) {
      setLoadError(
        cause instanceof Error
          ? cause.message
          : "Nie udało się pobrać aktualizacji z gtfs.walbrzych.eu."
      );
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="Kursówki Wałbrzych"
      className="duty-dialog-shell h-[94dvh] max-w-[1240px]"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-brand-soft text-brand-ink">
          <BusFront className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-[13px] font-extrabold tracking-[-0.02em] text-ink">
          Kursówki Wałbrzych
        </h2>
        <span className="hidden min-w-0 truncate text-[9px] text-mute md:inline">
          {isPlanner
            ? `Oficjalny rozkład gtfs.walbrzych.eu · podział na firmy MZUK i ŚKA${feedInfo ? ` · wydanie ${feedInfo.version}` : ""}`
            : "Kursy i brygady według aktualnego rozkładu"}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {isPlanner && (
            <button
              type="button"
              onClick={handleSyncGtfs}
              disabled={syncing}
              title="Pobierz najnowsze archiwa GTFS (full, 1 - SKA, 2 - MZUK) prosto z gtfs.walbrzych.eu"
              className={cn(
                "flex h-6 items-center gap-1 rounded-md border border-line bg-raised px-2 text-[9px] font-bold text-ink-soft transition-colors hover:border-brand/50 hover:text-brand-ink disabled:opacity-50"
              )}
            >
              {syncing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <DownloadCloud className="h-3 w-3" />
              )}
              <span className="hidden sm:inline">
                {syncing ? "Aktualizuję…" : "Aktualizuj z gtfs.walbrzych.eu"}
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Zamknij"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-mute transition-colors hover:bg-raised hover:text-ink"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>
      {syncNotice && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-[9px] font-bold text-emerald-700 dark:text-emerald-300">
          <span>{syncNotice}</span>
          <button
            type="button"
            onClick={() => setSyncNotice(null)}
            className="underline"
          >
            Ukryj
          </button>
        </div>
      )}
      <div className="scroll-area min-h-0 flex-1 overflow-y-auto p-2 min-[900px]:overflow-hidden sm:p-2.5">
        {loading && !routes.length ? (
          <div
            role="status"
            className="flex items-center gap-2 py-12 text-[10px] text-mute"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Wczytywanie linii i brygad Wałbrzych…
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
            onShowShapeOverlay={
              onShowShapeOverlay
                ? (overlay) => {
                    onShowShapeOverlay(overlay);
                    onClose();
                  }
                : undefined
            }
            onPreviewCourse={
              onPreviewCourse
                ? async (tripId, dateId) => {
                    const opened = await onPreviewCourse(tripId, dateId);
                    if (opened) onClose();
                    return opened;
                  }
                : undefined
            }
            onLoadTripToPlanner={onLoadTripToPlanner}
            initialKursowkaId={initialKursowkaId}
            initialKursowkaCode={initialKursowkaCode}
            initialDateId={initialDateId}
            canLoadToPlanner={canLoadToPlanner}
            showTechnicalNotes={isPlanner}
          />
        )}
      </div>
    </Dialog>
  );
}
