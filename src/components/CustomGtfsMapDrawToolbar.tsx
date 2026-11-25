import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BoxSelect,
  Check,
  Eraser,
  Loader2,
  MapPin,
  Move,
  Pencil,
  Redo2,
  RotateCcw,
  Route as RouteIcon,
  Trash2,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import { polylineLengthMeters } from "@/lib/core/spatial";
import {
  insertVertexOnPath,
  moveVertexInPath,
  removeVertexFromPath,
  removeVerticesFromPath,
  roundCoord,
  routeSegmentViaOsrm,
  routeThroughStopsViaOsrm,
  sanitizePath,
  type LatLng,
} from "@/lib/routeEditorGeometry";
import { cn } from "@/utils/cn";
import type { LineEditorMapHandlers } from "./LineRouteEditorPanel";
import type { LineEditorMode, LineRouteEditorMapState } from "./MapView";

export interface CustomGtfsMapStopRef {
  id: string;
  name: string;
  lat: number;
  lon: number;
  sequence: number;
}

export type CustomGtfsMapSession =
  | {
      kind: "draw-route";
      lineId: string;
      variantId: string;
      lineShort: string;
      variantName: string;
      color: string;
      initialPath: LatLng[];
      stops: CustomGtfsMapStopRef[];
    }
  | {
      kind: "pick-stop";
      lineId: string;
      variantId: string;
      lineShort: string;
      variantName: string;
      color: string;
      existingPath: LatLng[];
      stops: CustomGtfsMapStopRef[];
    };

interface CustomGtfsMapDrawToolbarProps {
  session: CustomGtfsMapSession;
  onMapStateChange: (state: LineRouteEditorMapState | null) => void;
  handlersRef: React.MutableRefObject<LineEditorMapHandlers | null>;
  onApplyRoute: (lineId: string, variantId: string, path: LatLng[]) => void;
  onPickStopCoords: (
    lineId: string,
    variantId: string,
    lat: number,
    lon: number,
  ) => void;
  onCancel: () => void;
  onToast?: (message: string) => void;
}

function formatKm(meters: number): string {
  return `${(meters / 1000).toLocaleString("pl-PL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} km`;
}

export default function CustomGtfsMapDrawToolbar({
  session,
  onMapStateChange,
  handlersRef,
  onApplyRoute,
  onPickStopCoords,
  onCancel,
  onToast,
}: CustomGtfsMapDrawToolbarProps) {
  const initialPath = useMemo(
    () =>
      session.kind === "draw-route"
        ? sanitizePath(session.initialPath)
        : sanitizePath(session.existingPath),
    [session],
  );

  const [path, setPath] = useState<LatLng[]>(initialPath);
  const [undoStack, setUndoStack] = useState<LatLng[][]>([]);
  const [redoStack, setRedoStack] = useState<LatLng[][]>([]);
  const [mode, setMode] = useState<LineEditorMode>("draw");
  const [snapToRoad, setSnapToRoad] = useState(true);
  const [selectedVertexIndices, setSelectedVertexIndices] = useState<number[]>(
    [],
  );
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [fitNonce] = useState(() => Date.now());

  const pathRef = useRef(path);
  pathRef.current = path;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const snapToRoadRef = useRef(snapToRoad);
  snapToRoadRef.current = snapToRoad;
  const selectedRef = useRef(selectedVertexIndices);
  selectedRef.current = selectedVertexIndices;
  const osrmAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setPath(initialPath);
    setUndoStack([]);
    setRedoStack([]);
    setSelectedVertexIndices([]);
    setMode("draw");
  }, [initialPath]);

  const commitPath = useCallback((nextPath: LatLng[]) => {
    const clean = sanitizePath(nextPath);
    setUndoStack((prev) => [...prev.slice(-39), pathRef.current]);
    setRedoStack([]);
    setSelectedVertexIndices([]);
    setPath(clean);
  }, []);

  const handleUndo = useCallback(() => {
    setUndoStack((prev) => {
      if (!prev.length) return prev;
      const previous = prev[prev.length - 1];
      setRedoStack((r) => [...r.slice(-39), pathRef.current]);
      setPath(previous);
      setSelectedVertexIndices([]);
      return prev.slice(0, -1);
    });
  }, []);

  const handleRedo = useCallback(() => {
    setRedoStack((prev) => {
      if (!prev.length) return prev;
      const restored = prev[prev.length - 1];
      setUndoStack((u) => [...u.slice(-39), pathRef.current]);
      setPath(restored);
      setSelectedVertexIndices([]);
      return prev.slice(0, -1);
    });
  }, []);

  const handleDeleteSelected = useCallback(() => {
    const indices = selectedRef.current;
    if (!indices.length) return;
    const { nextPoints } = removeVerticesFromPath(pathRef.current, indices);
    commitPath(nextPoints);
  }, [commitPath]);

  const handleRouteThroughStops = useCallback(async () => {
    if (session.stops.length < 2) {
      onToast?.("Dodaj co najmniej 2 przystanki wariantu, aby poprowadzić przez nie trasę.");
      return;
    }
    osrmAbortRef.current?.abort();
    const controller = new AbortController();
    osrmAbortRef.current = controller;
    setBusyMessage("Wyznaczanie trasy przez przystanki (OSRM)…");
    try {
      const { path: routed } = await routeThroughStopsViaOsrm(
        session.stops,
        controller.signal,
        (done, total) => setBusyMessage(`Wyznaczanie OSRM: ${done}/${total}…`),
      );
      if (controller.signal.aborted) return;
      if (routed.length >= 2) {
        commitPath(routed);
        onToast?.(
          `Poprowadzono trasę przez ${session.stops.length} przystanków (${formatKm(polylineLengthMeters(routed))}).`,
        );
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        onToast?.("Nie udało się połączyć z OSRM — możesz dalej klikać punkty ręcznie.");
      }
    } finally {
      if (osrmAbortRef.current === controller) setBusyMessage(null);
    }
  }, [session.stops, commitPath, onToast]);

  // Obsługa skrótów klawiaturowych (Ctrl+Z, Ctrl+Y, Delete, Escape)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
      } else if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedRef.current.length > 0
      ) {
        e.preventDefault();
        handleDeleteSelected();
      } else if (e.key === "Escape") {
        if (selectedRef.current.length > 0) {
          setSelectedVertexIndices([]);
        } else {
          onCancel();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleUndo, handleRedo, handleDeleteSelected, onCancel]);

  // Podpięcie zdarzeń kliknięć i edycji z MapView
  useEffect(() => {
    handlersRef.current = {
      onMapClick: (lat, lon) => {
        const clicked = roundCoord([lat, lon]);
        if (session.kind === "pick-stop") {
          onPickStopCoords(
            session.lineId,
            session.variantId,
            clicked[0],
            clicked[1],
          );
          return;
        }
        if (modeRef.current !== "draw") return;

        const current = pathRef.current;
        if (current.length === 0) {
          commitPath([clicked]);
          return;
        }

        const prevPoint = current[current.length - 1];
        if (!snapToRoadRef.current) {
          commitPath([...current, clicked]);
          return;
        }

        osrmAbortRef.current?.abort();
        const controller = new AbortController();
        osrmAbortRef.current = controller;
        setBusyMessage("Prowadzenie odcinka po drogach (OSRM)…");
        void routeSegmentViaOsrm([prevPoint, clicked], controller.signal)
          .then(({ path: leg }) => {
            if (controller.signal.aborted) return;
            const appended =
              leg.length >= 2 ? [...current, ...leg.slice(1)] : [...current, clicked];
            commitPath(appended);
          })
          .catch((err) => {
            if (!(err instanceof DOMException && err.name === "AbortError")) {
              commitPath([...current, clicked]);
            }
          })
          .finally(() => {
            if (osrmAbortRef.current === controller) setBusyMessage(null);
          });
      },
      onVertexMove: (index, lat, lon) => {
        if (session.kind !== "draw-route") return;
        commitPath(moveVertexInPath(pathRef.current, index, [lat, lon]));
      },
      onVertexInsert: (lat, lon) => {
        if (session.kind !== "draw-route") return;
        commitPath(insertVertexOnPath(pathRef.current, [lat, lon]).nextPoints);
      },
      onVertexRemove: (index) => {
        if (session.kind !== "draw-route") return;
        const current = pathRef.current;
        if (current.length <= 1) {
          commitPath([]);
          return;
        }
        if (current.length === 2) {
          commitPath(current.filter((_, i) => i !== index));
          return;
        }
        commitPath(removeVertexFromPath(current, index));
      },
      onSegmentPickVertex: () => {},
      onBoxSelect: (indices, additive) => {
        if (session.kind !== "draw-route") return;
        setSelectedVertexIndices((prev) => {
          const base = additive ? new Set(prev) : new Set<number>();
          for (const idx of indices) base.add(idx);
          return [...base].sort((a, b) => a - b);
        });
      },
      onToggleSelectVertex: (index) => {
        if (session.kind !== "draw-route") return;
        setSelectedVertexIndices((prev) =>
          prev.includes(index)
            ? prev.filter((i) => i !== index)
            : [...prev, index].sort((a, b) => a - b),
        );
      },
      onDeleteSelected: handleDeleteSelected,
      onClearSelection: () => setSelectedVertexIndices([]),
    };
    return () => {
      osrmAbortRef.current?.abort();
      handlersRef.current = null;
    };
  }, [
    session,
    handlersRef,
    commitPath,
    handleDeleteSelected,
    onPickStopCoords,
  ]);

  // Synchronizacja warstwy trasy z MapView
  useEffect(() => {
    onMapStateChange({
      fitKey: `custom-gtfs:${session.lineId}:${session.variantId}:${session.kind}`,
      fitNonce,
      lineShort: session.lineShort,
      color: session.color,
      path,
      originalPath: [],
      showOriginal: false,
      stops: session.stops,
      showStops: true,
      mode: session.kind === "pick-stop" ? "draw" : mode,
      segmentStartIndex: null,
      segmentEndIndex: null,
      segmentDraftPoints: [],
      segmentPreviewPath: [],
      selectedVertexIndices,
    });
  }, [session, path, mode, selectedVertexIndices, fitNonce, onMapStateChange]);

  useEffect(() => {
    return () => {
      onMapStateChange(null);
    };
  }, [onMapStateChange]);

  const lengthMeters = useMemo(() => polylineLengthMeters(path), [path]);

  // Tryb 1: Szybkie wskazanie lokalizacji nowego przystanku GPS na mapie
  if (session.kind === "pick-stop") {
    return (
      <div
        data-testid="custom-gtfs-pick-stop-banner"
        className="pointer-events-auto flex max-w-[460px] flex-wrap items-center gap-2 rounded-xl border border-brand/50 bg-surface/95 px-3 py-2 shadow-lg"
      >
        <span
          className="metric grid h-7 min-w-[30px] shrink-0 place-items-center rounded px-1.5 text-[11px] font-extrabold text-white"
          style={{ backgroundColor: session.color }}
        >
          {session.lineShort}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-[10px] font-extrabold text-ink">
            <MapPin className="h-3.5 w-3.5 text-brand-ink" />
            Kliknij na mapie lokalizację nowego przystanku
          </div>
          <div className="text-[8.5px] text-mute">
            Współrzędne GPS zostaną automatycznie wstawione do formularza przystanku.
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="flex h-7 items-center gap-1 rounded-md border border-line bg-raised px-2 text-[9px] font-bold text-ink-soft hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />
          Anuluj
        </button>
      </div>
    );
  }

  // Tryb 2: Interaktywne rysowanie i edycja punktów trasy na mapie
  return (
    <div
      data-testid="custom-gtfs-map-draw-toolbar"
      className="pointer-events-auto w-full max-w-[660px] rounded-xl border border-brand/45 bg-surface/96 p-2.5 shadow-xl"
    >
      {/* Górny wiersz: nazwa linii, statystyki i przyciski Zastosuj / Anuluj */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="metric grid h-7 min-w-[32px] shrink-0 place-items-center rounded px-1.5 text-[11px] font-extrabold text-white"
          style={{ backgroundColor: session.color }}
        >
          {session.lineShort}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[10.5px] font-extrabold text-ink">
            Rysowanie trasy GTFS · {session.variantName}
          </div>
          <div className="metric flex flex-wrap items-center gap-2 text-[8.5px] text-mute">
            <span>{path.length} pkt</span>
            <span>·</span>
            <span>{formatKm(lengthMeters)}</span>
            {session.stops.length > 0 && (
              <>
                <span>·</span>
                <span>{session.stops.length} przystanków na mapie</span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="flex h-8 items-center gap-1 rounded-lg border border-line bg-raised px-2.5 text-[9.5px] font-bold text-ink-soft hover:text-ink"
          >
            <X className="h-3.5 w-3.5" />
            Anuluj
          </button>
          <button
            type="button"
            data-testid="custom-gtfs-map-apply"
            disabled={path.length < 2}
            onClick={() =>
              onApplyRoute(session.lineId, session.variantId, sanitizePath(path))
            }
            className="flex h-8 items-center gap-1.5 rounded-lg bg-brand px-3 text-[9.5px] font-extrabold text-on-brand hover:opacity-90 disabled:opacity-45"
          >
            <Check className="h-3.5 w-3.5" />
            Zastosuj trasę i wróć
          </button>
        </div>
      </div>

      {/* Drugi wiersz: narzędzia zaznaczania punktów i edycji */}
      <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-line pt-2">
        {(
          [
            {
              id: "draw",
              label: "Klikaj trasę",
              icon: Pencil,
              title: "Klikaj na mapie kolejne punkty, którędy ma jechać autobus",
            },
            {
              id: "vertices",
              label: "Przesuwaj",
              icon: Move,
              title: "Przeciągaj punkty lub kliknij linię, aby wstawić nowy punkt",
            },
            {
              id: "delete",
              label: "Usuń pkt",
              icon: Eraser,
              title: "Kliknij punkt, aby go usunąć",
            },
            {
              id: "box-delete",
              label: "Ramka",
              icon: BoxSelect,
              title: "Przeciągnij ramkę, aby zaznaczyć i usunąć wiele punktów naraz",
            },
          ] as const
        ).map((tool) => {
          const Icon = tool.icon;
          const active = mode === tool.id;
          return (
            <button
              key={tool.id}
              type="button"
              data-testid={`custom-gtfs-map-mode-${tool.id}`}
              title={tool.title}
              onClick={() => setMode(tool.id)}
              className={cn(
                "flex h-7 items-center gap-1 rounded-md px-2 text-[9px] font-extrabold transition-colors",
                active
                  ? "bg-brand text-on-brand"
                  : "border border-line bg-raised text-ink-soft hover:text-ink",
              )}
            >
              <Icon className="h-3 w-3" />
              {tool.label}
            </button>
          );
        })}

        <label
          title="Gdy włączone, kliknięcie kolejnego punktu automatycznie prowadzi trasę po ulicach (OSRM)"
          className="ml-1 flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-raised px-2 text-[8.5px] font-bold text-ink"
        >
          <input
            type="checkbox"
            data-testid="custom-gtfs-map-snap-road"
            checked={snapToRoad}
            onChange={(e) => setSnapToRoad(e.target.checked)}
            className="h-3.5 w-3.5 accent-brand"
          />
          <RouteIcon className="h-3 w-3 text-brand-ink" />
          Po drogach (OSRM)
        </label>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            disabled={!undoStack.length}
            onClick={handleUndo}
            title="Cofnij ostatni punkt / odcinek (Ctrl+Z)"
            className="grid h-7 w-7 place-items-center rounded-md border border-line bg-raised text-ink-soft hover:text-ink disabled:opacity-35"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={!redoStack.length}
            onClick={handleRedo}
            title="Ponów (Ctrl+Y)"
            className="grid h-7 w-7 place-items-center rounded-md border border-line bg-raised text-ink-soft hover:text-ink disabled:opacity-35"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>
          {session.stops.length >= 2 && (
            <button
              type="button"
              disabled={Boolean(busyMessage)}
              onClick={() => void handleRouteThroughStops()}
              title="Automatycznie poprowadź trasę przez wszystkie dodane przystanki wariantu"
              className="flex h-7 items-center gap-1 rounded-md border border-brand/40 bg-brand-soft px-2 text-[8.5px] font-extrabold text-brand-ink hover:border-brand disabled:opacity-45"
            >
              <Wand2 className="h-3 w-3" />
              Przez przystanki
            </button>
          )}
          <button
            type="button"
            disabled={!path.length}
            onClick={() => commitPath([])}
            title="Wyczyść wszystkie punkty trasy"
            className="flex h-7 items-center gap-1 rounded-md border border-line bg-raised px-2 text-[8.5px] font-bold text-mute hover:border-warning/40 hover:text-warning disabled:opacity-35"
          >
            <Trash2 className="h-3 w-3" />
            Wyczyść
          </button>
          {initialPath.length >= 2 && (
            <button
              type="button"
              onClick={() => commitPath(initialPath)}
              title="Przywróć trasę sprzed otwarcia mapy"
              className="grid h-7 w-7 place-items-center rounded-md border border-line bg-raised text-mute hover:text-ink"
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Podpowiedź / status OSRM */}
      <div className="mt-1.5 flex items-center gap-1.5 text-[8.5px] text-mute">
        {busyMessage ? (
          <span className="flex items-center gap-1 font-bold text-brand-ink">
            <Loader2 className="h-3 w-3 animate-spin" />
            {busyMessage}
          </span>
        ) : mode === "draw" ? (
          <span>
            <b>Klikaj na mapie</b> kolejne punkty trasy (
            {snapToRoad
              ? "trasa automatycznie dopasuje się do ulic"
              : "odcinki proste bez przyciągania do ulic"}
            ). <kbd className="rounded border border-line px-1">Ctrl+Z</kbd>{" "}
            cofa ostatni odcinek.
          </span>
        ) : mode === "vertices" ? (
          <span>
            <b>Przeciągaj</b> kółka wierzchołków, <b>kliknij linię</b> aby dodać
            punkt pośredni, prawy przycisk myszy usuwa punkt.
          </span>
        ) : mode === "delete" ? (
          <span>
            <b>Kliknij</b> dowolny punkt na trasie, aby go usunąć.
          </span>
        ) : (
          <span>
            <b>Przeciągnij ramkę</b> na mapie, aby zaznaczyć fragment punktów do
            usunięcia (klawisz <kbd className="rounded border border-line px-1">Delete</kbd>).
          </span>
        )}
      </div>
    </div>
  );
}
