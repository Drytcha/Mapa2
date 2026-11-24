import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowLeftRight,
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  CloudUpload,
  Copy,
  Crosshair,
  Download,
  ExternalLink,
  GitBranch,
  Globe,
  Loader2,
  MapPin,
  MousePointerClick,
  Pencil,
  Redo2,
  RefreshCw,
  RotateCcw,
  Route as RouteIcon,
  Save,
  Scissors,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { onRuntimeEvent } from "@/lib/core/runtimeHub";
import { polylineLengthMeters } from "@/lib/core/spatial";
import { foldPolish } from "@/lib/core/text";
import { getTripOrderedStops } from "@/lib/engine/gtfsStore";
import {
  getLineCatalogue,
  type LineEntry,
  type LineVariant,
} from "@/lib/engine/lineRoutes";
import {
  clearGitHubPublishToken,
  deleteLineRouteOverride,
  exportLineRouteOverridesJson,
  getOverridesSummary,
  githubWebEditUrl,
  importLineRouteOverridesJson,
  listLineRouteOverrides,
  loadGitHubPublishConfig,
  publishLineRouteOverridesToGitHub,
  refreshRemoteLineRouteOverrides,
  saveGitHubPublishConfig,
  saveLineRouteOverride,
  type GitHubPublishConfig,
  type LineRouteOverride,
  type LineRouteOverridesSummary,
} from "@/lib/engine/lineRouteOverrides";
import {
  insertVertexOnPath,
  moveVertexInPath,
  removeVertexFromPath,
  replacePathSegment,
  roundCoord,
  routeSegmentViaOsrm,
  routeThroughStopsViaOsrm,
  sanitizePath,
  simplifyPath,
  snapEndsToStops,
  type LatLng,
} from "@/lib/routeEditorGeometry";
import { cn } from "@/utils/cn";
import type { LineEditorMode, LineRouteEditorMapState } from "./MapView";

export interface LineEditorMapHandlers {
  onVertexMove: (index: number, lat: number, lon: number) => void;
  onVertexInsert: (lat: number, lon: number) => void;
  onVertexRemove: (index: number) => void;
  onMapClick: (lat: number, lon: number) => void;
  onSegmentPickVertex: (index: number) => void;
}

interface LineRouteEditorPanelProps {
  initialLineShort?: string | null;
  initialVariantKey?: string | null;
  onClose: () => void;
  onMapStateChange: (state: LineRouteEditorMapState | null) => void;
  handlersRef: React.MutableRefObject<LineEditorMapHandlers | null>;
  onToast: (message: string) => void;
}

interface OrderedStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  sequence: number;
}

const MAX_HISTORY = 50;

function formatKm(meters: number): string {
  return `${(meters / 1000).toLocaleString("pl-PL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} km`;
}

function formatDiffKm(diffMeters: number): string {
  const sign = diffMeters > 0 ? "+" : "";
  return `${sign}${(diffMeters / 1000).toLocaleString("pl-PL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} km`;
}

function pathsEqual(a: readonly LatLng[], b: readonly LatLng[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      Math.abs(a[i][0] - b[i][0]) > 1e-6 ||
      Math.abs(a[i][1] - b[i][1]) > 1e-6
    ) {
      return false;
    }
  }
  return true;
}

export default function LineRouteEditorPanel({
  initialLineShort = null,
  initialVariantKey = null,
  onClose,
  onMapStateChange,
  handlersRef,
  onToast,
}: LineRouteEditorPanelProps) {
  const [entries, setEntries] = useState<LineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [lineQuery, setLineQuery] = useState("");
  const [selectedLineShort, setSelectedLineShort] = useState<string | null>(
    initialLineShort,
  );
  const [selectedVariantKey, setSelectedVariantKey] = useState<string | null>(
    initialVariantKey,
  );

  // Editable geometry + history stack
  const [draftPath, setDraftPath] = useState<LatLng[]>([]);
  const [originalPath, setOriginalPath] = useState<LatLng[]>([]);
  const [baselinePath, setBaselinePath] = useState<LatLng[]>([]);
  const [history, setHistory] = useState<LatLng[][]>([]);
  const [future, setFuture] = useState<LatLng[][]>([]);
  const [stops, setStops] = useState<OrderedStop[]>([]);
  const [note, setNote] = useState("");
  const [baselineNote, setBaselineNote] = useState("");

  // Tool & display state
  const [mode, setMode] = useState<LineEditorMode>("vertices");
  const [snapToRoads, setSnapToRoads] = useState(true);
  const [showOriginal, setShowOriginal] = useState(true);
  const [showStops, setShowStops] = useState(true);
  const [fitNonce, setFitNonce] = useState(0);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);

  // Segment replacement (A -> B) state
  const [segmentStartIndex, setSegmentStartIndex] = useState<number | null>(null);
  const [segmentEndIndex, setSegmentEndIndex] = useState<number | null>(null);
  const [segmentDraftPoints, setSegmentDraftPoints] = useState<LatLng[]>([]);
  const [segmentPreviewPath, setSegmentPreviewPath] = useState<LatLng[]>([]);
  const segmentAbortRef = useRef<AbortController | null>(null);
  const osrmAbortRef = useRef<AbortController | null>(null);

  // Global publishing & overrides state
  const [summary, setSummary] = useState<LineRouteOverridesSummary>(() =>
    getOverridesSummary(),
  );
  const [allOverrides, setAllOverrides] = useState<LineRouteOverride[]>(() =>
    listLineRouteOverrides(),
  );
  const [publishSectionOpen, setPublishSectionOpen] = useState(false);
  const [modifiedListOpen, setModifiedListOpen] = useState(false);
  const [ghConfig, setGhConfig] = useState<GitHubPublishConfig>(() =>
    loadGitHubPublishConfig(),
  );
  const [publishing, setPublishing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshingRemote, setRefreshingRemote] = useState(false);
  const [lastCommitUrl, setLastCommitUrl] = useState<string | null>(null);
  const [publishError, setPublishError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadCatalogue = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getLineCatalogue();
      setEntries(data);
      setSummary(getOverridesSummary());
      setAllOverrides(listLineRouteOverrides());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalogue();
    const unsubGtfs = onRuntimeEvent("gtfs:updated", () => {
      void loadCatalogue();
    });
    const unsubOverrides = onRuntimeEvent("routes:overrides-updated", () => {
      setSummary(getOverridesSummary());
      setAllOverrides(listLineRouteOverrides());
      void getLineCatalogue().then(setEntries);
    });
    return () => {
      unsubGtfs();
      unsubOverrides();
    };
  }, [loadCatalogue]);

  // Update selection when external initial target changes (e.g. clicking "Edytuj" from LinesDialog).
  useEffect(() => {
    if (initialLineShort) setSelectedLineShort(initialLineShort);
    if (initialVariantKey) setSelectedVariantKey(initialVariantKey);
  }, [initialLineShort, initialVariantKey]);

  const filteredLines = useMemo(() => {
    const needle = foldPolish(lineQuery.trim());
    if (!needle) return entries;
    return entries.filter((entry) =>
      foldPolish(`${entry.shortName} ${entry.longName}`).includes(needle),
    );
  }, [entries, lineQuery]);

  const selectedLine: LineEntry | null = useMemo(() => {
    if (!entries.length) return null;
    if (selectedLineShort) {
      const exact = entries.find(
        (e) => e.shortName.toUpperCase() === selectedLineShort.toUpperCase(),
      );
      if (exact) return exact;
    }
    return filteredLines[0] ?? entries[0];
  }, [entries, filteredLines, selectedLineShort]);

  const selectedVariant: LineVariant | null = useMemo(() => {
    if (!selectedLine?.variants.length) return null;
    if (selectedVariantKey) {
      const exact = selectedLine.variants.find((v) => v.key === selectedVariantKey);
      if (exact) return exact;
    }
    return selectedLine.variants[0];
  }, [selectedLine, selectedVariantKey]);

  // Track which variant is currently loaded into the editor draft.
  const loadedVariantIdRef = useRef<string>("");
  const currentVariantId =
    selectedLine && selectedVariant
      ? `${selectedLine.shortName}::${selectedVariant.key}`
      : "";

  const isDirty = useMemo(
    () =>
      !pathsEqual(draftPath, baselinePath) ||
      note.trim() !== baselineNote.trim(),
    [draftPath, baselinePath, note, baselineNote],
  );

  // Load selected variant geometry & ordered stops whenever the variant changes.
  useEffect(() => {
    if (!selectedLine || !selectedVariant) return;
    if (loadedVariantIdRef.current === currentVariantId) return;
    loadedVariantIdRef.current = currentVariantId;

    const initialDraft = sanitizePath(selectedVariant.path);
    const initialOriginal = sanitizePath(selectedVariant.originalPath);
    setDraftPath(initialDraft);
    setBaselinePath(initialDraft);
    setOriginalPath(initialOriginal);
    setHistory([]);
    setFuture([]);
    setNote(selectedVariant.customNote ?? "");
    setBaselineNote(selectedVariant.customNote ?? "");
    setSegmentStartIndex(null);
    setSegmentEndIndex(null);
    setSegmentDraftPoints([]);
    setSegmentPreviewPath([]);
    setLastCommitUrl(null);
    setPublishError("");

    let active = true;
    void getTripOrderedStops(selectedVariant.representativeTripId).then(
      (tripStops) => {
        if (active) setStops(tripStops);
      },
    );
    return () => {
      active = false;
    };
  }, [selectedLine, selectedVariant, currentVariantId]);

  // Clear map overlay on unmount
  useEffect(() => {
    return () => {
      segmentAbortRef.current?.abort();
      osrmAbortRef.current?.abort();
      onMapStateChange(null);
      handlersRef.current = null;
    };
  }, [onMapStateChange, handlersRef]);

  const commitPathChange = useCallback((nextPath: LatLng[]) => {
    const clean = sanitizePath(nextPath);
    setDraftPath((current) => {
      if (pathsEqual(current, clean)) return current;
      setHistory((prev) => [...prev.slice(-(MAX_HISTORY - 1)), current]);
      setFuture([]);
      return clean;
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((prev) => {
      if (!prev.length) return prev;
      const previous = prev[prev.length - 1];
      setDraftPath((current) => {
        setFuture((f) => [current, ...f.slice(0, MAX_HISTORY - 1)]);
        return previous;
      });
      return prev.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((prev) => {
      if (!prev.length) return prev;
      const next = prev[0];
      setDraftPath((current) => {
        setHistory((h) => [...h.slice(-(MAX_HISTORY - 1)), current]);
        return next;
      });
      return prev.slice(1);
    });
  }, []);

  // Keyboard shortcuts: Ctrl+Z / Ctrl+Y / Escape
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "y"
      ) {
        event.preventDefault();
        redo();
      } else if (event.key === "Escape" && mode === "segment") {
        setSegmentStartIndex(null);
        setSegmentEndIndex(null);
        setSegmentDraftPoints([]);
        setSegmentPreviewPath([]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo, mode]);

  // Recompute live segment A->B preview whenever endpoints or draft via-points change.
  useEffect(() => {
    segmentAbortRef.current?.abort();
    if (
      mode !== "segment" ||
      segmentStartIndex === null ||
      segmentEndIndex === null ||
      segmentStartIndex === segmentEndIndex ||
      segmentStartIndex >= draftPath.length ||
      segmentEndIndex >= draftPath.length
    ) {
      setSegmentPreviewPath([]);
      return;
    }

    const startPt = draftPath[segmentStartIndex];
    const endPt = draftPath[segmentEndIndex];
    const waypoints: LatLng[] = [startPt, ...segmentDraftPoints, endPt];

    if (!snapToRoads) {
      setSegmentPreviewPath(waypoints);
      return;
    }

    // Immediate straight preview while OSRM computes road geometry.
    setSegmentPreviewPath(waypoints);
    const controller = new AbortController();
    segmentAbortRef.current = controller;
    setBusyMessage("Dopasowywanie fragmentu do ulic (OSRM)…");
    void routeSegmentViaOsrm(waypoints, controller.signal)
      .then(({ path }) => {
        if (!controller.signal.aborted) {
          setSegmentPreviewPath(path);
        }
      })
      .catch(() => {
        /* Aborted or fallback already displayed */
      })
      .finally(() => {
        if (segmentAbortRef.current === controller) {
          setBusyMessage(null);
        }
      });

    return () => {
      controller.abort();
    };
  }, [
    mode,
    segmentStartIndex,
    segmentEndIndex,
    segmentDraftPoints,
    draftPath,
    snapToRoads,
  ]);

  // Sync MapView state
  useEffect(() => {
    if (!selectedLine || !selectedVariant) {
      onMapStateChange(null);
      return;
    }
    onMapStateChange({
      fitKey: currentVariantId,
      fitNonce,
      lineShort: selectedLine.shortName,
      color: selectedLine.color,
      path: draftPath,
      originalPath,
      showOriginal,
      stops,
      showStops,
      mode,
      segmentStartIndex,
      segmentEndIndex,
      segmentDraftPoints,
      segmentPreviewPath,
    });
  }, [
    selectedLine,
    selectedVariant,
    currentVariantId,
    fitNonce,
    draftPath,
    originalPath,
    showOriginal,
    stops,
    showStops,
    mode,
    segmentStartIndex,
    segmentEndIndex,
    segmentDraftPoints,
    segmentPreviewPath,
    onMapStateChange,
  ]);

  // Register interactive map callbacks
  const draftPathRef = useRef(draftPath);
  draftPathRef.current = draftPath;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const snapRef = useRef(snapToRoads);
  snapRef.current = snapToRoads;
  const segStartRef = useRef(segmentStartIndex);
  segStartRef.current = segmentStartIndex;
  const segEndRef = useRef(segmentEndIndex);
  segEndRef.current = segmentEndIndex;

  useEffect(() => {
    handlersRef.current = {
      onVertexMove: (index, lat, lon) => {
        const current = draftPathRef.current;
        const moved = moveVertexInPath(current, index, [lat, lon]);
        if (!snapRef.current || current.length < 3 || index <= 0 || index >= current.length - 1) {
          commitPathChange(moved);
          return;
        }
        // When OSRM road-snap is enabled, re-route between the neighboring vertices.
        commitPathChange(moved);
        osrmAbortRef.current?.abort();
        const controller = new AbortController();
        osrmAbortRef.current = controller;
        const prevIdx = Math.max(0, index - 1);
        const nextIdx = Math.min(current.length - 1, index + 1);
        setBusyMessage("Dopasowywanie zakrętu do dróg (OSRM)…");
        void routeSegmentViaOsrm(
          [current[prevIdx], roundCoord([lat, lon]), current[nextIdx]],
          controller.signal,
        )
          .then(({ path, snapped }) => {
            if (!controller.signal.aborted && snapped && path.length >= 2) {
              const merged = replacePathSegment(current, prevIdx, nextIdx, path);
              setDraftPath(merged);
            }
          })
          .catch(() => {
            /* Keep freehand move if OSRM fails or aborted */
          })
          .finally(() => {
            if (osrmAbortRef.current === controller) setBusyMessage(null);
          });
      },
      onVertexInsert: (lat, lon) => {
        const { nextPoints } = insertVertexOnPath(draftPathRef.current, [lat, lon]);
        commitPathChange(nextPoints);
      },
      onVertexRemove: (index) => {
        const current = draftPathRef.current;
        if (current.length <= 2) {
          onToast("Trasa musi mieć co najmniej 2 punkty.");
          return;
        }
        commitPathChange(removeVertexFromPath(current, index, 2));
      },
      onSegmentPickVertex: (index) => {
        if (segStartRef.current === null) {
          setSegmentStartIndex(index);
          setSegmentEndIndex(null);
          setSegmentDraftPoints([]);
        } else if (segEndRef.current === null) {
          if (index === segStartRef.current) return;
          setSegmentEndIndex(index);
          setSegmentDraftPoints([]);
        } else {
          // Picking a new vertex resets A -> B selection to start fresh.
          setSegmentStartIndex(index);
          setSegmentEndIndex(null);
          setSegmentDraftPoints([]);
        }
      },
      onMapClick: (lat, lon) => {
        const clickPt = roundCoord([lat, lon]);
        if (modeRef.current === "segment") {
          if (segStartRef.current !== null && segEndRef.current !== null) {
            setSegmentDraftPoints((prev) => [...prev, clickPt]);
          }
          return;
        }
        if (modeRef.current !== "draw") return;

        const current = draftPathRef.current;
        if (current.length === 0 || !snapRef.current) {
          commitPathChange([...current, clickPt]);
          return;
        }

        const tail = current[current.length - 1];
        osrmAbortRef.current?.abort();
        const controller = new AbortController();
        osrmAbortRef.current = controller;
        setBusyMessage("Prowadzenie odcinka po drogach (OSRM)…");
        void routeSegmentViaOsrm([tail, clickPt], controller.signal)
          .then(({ path }) => {
            if (controller.signal.aborted) return;
            const appended =
              path.length >= 2 ? [...current, ...path.slice(1)] : [...current, clickPt];
            commitPathChange(appended);
          })
          .catch(() => {
            /* Aborted */
          })
          .finally(() => {
            if (osrmAbortRef.current === controller) setBusyMessage(null);
          });
      },
    };
  }, [commitPathChange, handlersRef, onToast]);

  const selectLineAndVariant = (lineShort: string, variantKey: string | null) => {
    if (isDirty) {
      const ok = window.confirm(
        "Masz niezapisane zmiany w bieżącym przebiegu. Przełączyć linię bez zapisywania?",
      );
      if (!ok) return;
    }
    loadedVariantIdRef.current = "";
    setSelectedLineShort(lineShort);
    setSelectedVariantKey(variantKey);
  };

  const applySegmentReplacement = () => {
    if (
      segmentStartIndex === null ||
      segmentEndIndex === null ||
      segmentPreviewPath.length < 2
    ) {
      return;
    }
    const next = replacePathSegment(
      draftPath,
      segmentStartIndex,
      segmentEndIndex,
      segmentPreviewPath,
    );
    commitPathChange(next);
    setSegmentStartIndex(null);
    setSegmentEndIndex(null);
    setSegmentDraftPoints([]);
    setSegmentPreviewPath([]);
    onToast("Zastąpiono zaznaczony fragment trasy.");
  };

  const handleRouteThroughStops = async () => {
    if (stops.length < 2) {
      onToast("Brak wystarczającej liczby przystanków dla tego wariantu.");
      return;
    }
    osrmAbortRef.current?.abort();
    const controller = new AbortController();
    osrmAbortRef.current = controller;
    setBusyMessage(`Wyznaczanie trasy przez ${stops.length} przystanków (OSRM)…`);
    try {
      const { path, snappedChunks, totalChunks } = await routeThroughStopsViaOsrm(
        stops,
        controller.signal,
        (done, total) => {
          setBusyMessage(`Wyznaczanie po drogach: ${done}/${total} odcinków…`);
        },
      );
      if (controller.signal.aborted) return;
      if (path.length >= 2) {
        commitPathChange(path);
        onToast(
          snappedChunks === totalChunks
            ? `Poprowadzono trasę po drogach przez ${stops.length} przystanków.`
            : `Poprowadzono trasę (${snappedChunks}/${totalChunks} odcinków po drogach; pozostałe można poprawić ręcznie).`,
        );
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        onToast("Nie udało się wyznaczyć trasy po drogach.");
      }
    } finally {
      if (osrmAbortRef.current === controller) setBusyMessage(null);
    }
  };

  const handleSimplify = () => {
    if (draftPath.length <= 4) {
      onToast("Trasa ma już bardzo mało punktów.");
      return;
    }
    const simplified = simplifyPath(draftPath, 8);
    commitPathChange(simplified);
    onToast(
      `Uproszczono trasę: ${draftPath.length} → ${simplified.length} punktów (łatwiejsza edycja wierzchołków).`,
    );
  };

  const handleSnapEnds = () => {
    if (draftPath.length < 2 || stops.length < 2) return;
    commitPathChange(
      snapEndsToStops(draftPath, stops[0], stops[stops.length - 1]),
    );
    onToast("Dopasowano początek i koniec linii do skrajnych przystanków.");
  };

  const handleReverse = () => {
    if (draftPath.length < 2) return;
    commitPathChange([...draftPath].reverse());
    onToast("Odwrócono kierunek przebiegu trasy.");
  };

  const handleClearToDraw = () => {
    commitPathChange([]);
    setMode("draw");
    onToast("Wyczyszczono ścieżkę — klikaj na mapie, aby narysować trasę od nowa.");
  };

  const handleRestoreGtfs = async () => {
    if (!selectedLine || !selectedVariant) return;
    const ok = window.confirm(
      `Przywrócić oryginalny przebieg GTFS dla linii ${selectedLine.shortName} (${selectedVariant.headsign})?`,
    );
    if (!ok) return;
    try {
      const { syncedToDevServer } = await deleteLineRouteOverride(
        selectedLine.shortName,
        selectedVariant.key,
      );
      const restored = sanitizePath(originalPath);
      setDraftPath(restored);
      setBaselinePath(restored);
      setHistory([]);
      setFuture([]);
      setNote("");
      setBaselineNote("");
      setSummary(getOverridesSummary());
      setAllOverrides(listLineRouteOverrides());
      onToast(
        syncedToDevServer
          ? "Przywrócono oryginał GTFS i zapisano w pliku projektu."
          : "Przywrócono oryginał GTFS. Opublikuj zmiany, aby przywrócić go u wszystkich.",
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Nie udało się przywrócić trasy.");
    }
  };

  const handleSave = async (alsoPublishToGitHub = false) => {
    if (!selectedLine || !selectedVariant) return;
    const clean = sanitizePath(draftPath);
    if (clean.length < 2) {
      onToast("Narysuj co najmniej 2 punkty trasy przed zapisaniem.");
      return;
    }

    setSaving(true);
    setPublishError("");
    try {
      const { syncedToDevServer } = await saveLineRouteOverride({
        lineShort: selectedLine.shortName,
        variantKey: selectedVariant.key,
        directionId: selectedVariant.directionId,
        firstStopId: selectedVariant.firstStopId,
        firstStopName: selectedVariant.firstStop,
        lastStopId: selectedVariant.lastStopId,
        lastStopName: selectedVariant.lastStop,
        path: clean,
        note: note.trim() || undefined,
      });

      setDraftPath(clean);
      setBaselinePath(clean);
      setBaselineNote(note.trim());
      setSummary(getOverridesSummary());
      setAllOverrides(listLineRouteOverrides());

      if (alsoPublishToGitHub && ghConfig.token.trim()) {
        setPublishing(true);
        try {
          saveGitHubPublishConfig(ghConfig);
          const result = await publishLineRouteOverridesToGitHub(ghConfig);
          setLastCommitUrl(result.commitUrl ?? null);
          setSummary(getOverridesSummary());
          setAllOverrides(listLineRouteOverrides());
          onToast(
            `Zapisano i opublikowano linię ${selectedLine.shortName} dla wszystkich (${result.publishedCount} tras w rejestrze)!`,
          );
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Publikacja na GitHub nie powiodła się.";
          setPublishError(msg);
          setPublishSectionOpen(true);
          onToast(
            `Zapisano lokalnie linię ${selectedLine.shortName}, ale publikacja na GitHub wymaga uwagi.`,
          );
        } finally {
          setPublishing(false);
        }
        return;
      }

      if (syncedToDevServer) {
        onToast(
          `Zapisano trasę linii ${selectedLine.shortName} w wspólnym pliku projektu (widoczna dla wszystkich).`,
        );
      } else {
        onToast(
          `Zapisano trasę linii ${selectedLine.shortName} lokalnie. Użyj „Widoczność u wszystkich”, aby opublikować ją dla wszystkich użytkowników.`,
        );
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Nie udało się zapisać trasy.");
    } finally {
      setSaving(false);
    }
  };

  const handlePublishAllToGitHub = async () => {
    setPublishing(true);
    setPublishError("");
    setLastCommitUrl(null);
    try {
      saveGitHubPublishConfig(ghConfig);
      const result = await publishLineRouteOverridesToGitHub(ghConfig);
      setLastCommitUrl(result.commitUrl ?? null);
      setSummary(getOverridesSummary());
      setAllOverrides(listLineRouteOverrides());
      onToast(
        `Opublikowano ${result.publishedCount} poprawionych tras na GitHub — widoczne dla wszystkich!`,
      );
    } catch (err) {
      setPublishError(
        err instanceof Error ? err.message : "Publikacja na GitHub nie powiodła się.",
      );
    } finally {
      setPublishing(false);
    }
  };

  const handleRefreshRemote = async () => {
    setRefreshingRemote(true);
    try {
      const res = await refreshRemoteLineRouteOverrides(true);
      setSummary(getOverridesSummary());
      setAllOverrides(listLineRouteOverrides());
      onToast(
        res.ok
          ? `Odświeżono wspólne trasy (${res.count} wariantów z ${res.source}).`
          : "Nie udało się pobrać pliku ze zdalnego repozytorium (sprawdź połączenie).",
      );
    } finally {
      setRefreshingRemote(false);
    }
  };

  const handleDownloadJson = () => {
    const text = exportLineRouteOverridesJson();
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "line-route-overrides.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    onToast("Pobrano plik line-route-overrides.json.");
  };

  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(exportLineRouteOverridesJson());
      onToast("Skopiowano JSON do schowka — wklej go do src/data/line-route-overrides.json na GitHub.");
    } catch {
      onToast("Nie udało się skopiować do schowka. Użyj przycisku „Pobierz JSON”.");
    }
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const res = await importLineRouteOverridesJson(text);
      loadedVariantIdRef.current = "";
      await loadCatalogue();
      onToast(
        `Zaimportowano ${res.importedCount} tras${res.syncedToDevServer ? " i zapisano w pliku projektu" : ""}.`,
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Nie udało się zaimportować pliku JSON.");
    }
  };

  const draftMeters = useMemo(() => polylineLengthMeters(draftPath), [draftPath]);
  const originalMeters = useMemo(
    () => polylineLengthMeters(originalPath),
    [originalPath],
  );
  const diffMeters = draftMeters - originalMeters;
  const pendingTotal = summary.pendingLocalCount + summary.pendingDeleteCount;
  const linesWithOverrides = useMemo(
    () => new Set(allOverrides.map((o) => o.lineShort.toUpperCase())),
    [allOverrides],
  );

  const handleRequestClose = () => {
    if (isDirty) {
      const ok = window.confirm(
        "Masz niezapisane zmiany w edytowanej trasie. Zamknąć edytor bez zapisywania?",
      );
      if (!ok) return;
    }
    onClose();
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="line-route-editor-panel"
    >
      {/* ── Nagłówek ────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-line px-3.5 pb-2.5 pt-2.5">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={handleRequestClose}
            className="flex h-7 items-center gap-1 rounded-lg border border-line bg-raised px-2 text-[9.5px] font-bold text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            <ArrowLeft className="h-3 w-3" />
            Planer
          </button>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[8px] font-extrabold",
              pendingTotal > 0
                ? "border-amber-500/40 bg-amber-500/12 text-amber-700 dark:text-amber-300"
                : summary.totalActive > 0
                  ? "border-emerald-500/40 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                  : "border-line bg-raised text-mute",
            )}
          >
            <Globe className="h-2.5 w-2.5" />
            {pendingTotal > 0
              ? `${pendingTotal} do publikacji`
              : summary.totalActive > 0
                ? `${summary.totalActive} opublikowanych`
                : "Tryb edycji tras"}
          </span>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand text-on-brand">
            <Pencil className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-[15px] font-extrabold leading-tight tracking-[-0.02em] text-ink">
              Edytor przebiegu linii
            </h1>
            <p className="text-[8.5px] leading-snug text-mute">
              Popraw przebieg trasy zgodnie z realiami i zapisz dla wszystkich.
            </p>
          </div>
        </div>
      </div>

      {/* ── Treść przewijana ────────────────────────────────────────── */}
      <div className="scroll-area flex-1 space-y-2.5 overflow-y-auto px-3.5 py-2.5">
        {loading && !entries.length ? (
          <div className="flex items-center gap-2 py-8 text-[10px] text-mute">
            <Loader2 className="h-4 w-4 animate-spin" />
            Wczytywanie katalogu linii GTFS…
          </div>
        ) : (
          <>
            {/* 1. Wybór linii i wariantu */}
            <section className="rounded-xl border border-line bg-raised/70 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[8.5px] font-extrabold uppercase tracking-[0.12em] text-mute">
                  1. Linia i wariant trasy
                </span>
                <span className="text-[8px] font-semibold text-mute">
                  {entries.length} linii
                </span>
              </div>

              <div className="mt-1.5 flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface px-2 focus-within:border-brand/60">
                <Search className="h-3 w-3 shrink-0 text-mute" />
                <input
                  value={lineQuery}
                  onChange={(e) => setLineQuery(e.target.value)}
                  placeholder="Filtruj linię (np. 7, 11, A, S1)…"
                  aria-label="Filtruj linię"
                  className="min-w-0 flex-1 bg-transparent text-[9.5px] font-semibold text-ink outline-none placeholder:text-mute"
                />
                {lineQuery && (
                  <button
                    type="button"
                    onClick={() => setLineQuery("")}
                    aria-label="Wyczyść filtr"
                    className="text-mute hover:text-ink"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>

              <div
                className="mt-1.5 flex flex-wrap gap-1"
                role="listbox"
                aria-label="Wybierz linię"
              >
                {filteredLines.map((entry) => {
                  const active = selectedLine?.shortName === entry.shortName;
                  const hasCustom = linesWithOverrides.has(
                    entry.shortName.toUpperCase(),
                  );
                  return (
                    <button
                      key={entry.shortName}
                      type="button"
                      data-testid={`editor-line-${entry.shortName}`}
                      onClick={() => selectLineAndVariant(entry.shortName, null)}
                      className={cn(
                        "relative flex h-7 min-w-[34px] items-center justify-center rounded-md px-2 text-[10.5px] font-extrabold transition-all",
                        active
                          ? "ring-2 ring-brand ring-offset-1 ring-offset-surface"
                          : "opacity-80 hover:opacity-100",
                      )}
                      style={{
                        backgroundColor: entry.color,
                        color: entry.textColor,
                      }}
                      title={entry.longName}
                    >
                      {entry.shortName}
                      {hasCustom && (
                        <span
                          className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-white bg-emerald-400"
                          title="Linia ma poprawioną trasę"
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              {selectedLine && (
                <div className="mt-2">
                  <label className="block">
                    <span className="text-[8px] font-bold uppercase tracking-[0.1em] text-mute">
                      Wariant ({selectedLine.variants.length})
                    </span>
                    <select
                      data-testid="editor-variant-select"
                      value={selectedVariant?.key ?? ""}
                      onChange={(e) =>
                        selectLineAndVariant(selectedLine.shortName, e.target.value)
                      }
                      className="mt-1 h-8 w-full rounded-lg border border-line bg-surface px-2 text-[9.5px] font-bold text-ink outline-none focus:border-brand/60"
                    >
                      {selectedLine.variants.map((variant) => {
                        const tag =
                          variant.customStatus === "published"
                            ? " ★ Opublikowano"
                            : variant.customStatus === "local-modified"
                              ? " ● Lokalnie"
                              : "";
                        return (
                          <option key={variant.key} value={variant.key}>
                            {variant.firstStop} → {variant.lastStop} (
                            {variant.stopCount} przyst.){tag}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                </div>
              )}
            </section>

            {/* 2. Metryki i szybki stan */}
            {selectedLine && selectedVariant && (
              <>
                <section className="grid grid-cols-3 gap-1.5 rounded-xl border border-line bg-surface p-2 text-center">
                  <div>
                    <div className="text-[7.5px] font-bold uppercase text-mute">
                      Długość
                    </div>
                    <div
                      className="metric text-[11px] font-extrabold text-ink"
                      data-testid="editor-length"
                    >
                      {formatKm(draftMeters)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[7.5px] font-bold uppercase text-mute">
                      Punkty
                    </div>
                    <div
                      className="metric text-[11px] font-extrabold text-ink"
                      data-testid="editor-points-count"
                    >
                      {draftPath.length}
                    </div>
                  </div>
                  <div>
                    <div className="text-[7.5px] font-bold uppercase text-mute">
                      Vs GTFS
                    </div>
                    <div
                      className={cn(
                        "metric text-[11px] font-extrabold",
                        Math.abs(diffMeters) < 15
                          ? "text-mute"
                          : "text-brand-ink",
                      )}
                    >
                      {formatDiffKm(diffMeters)}
                    </div>
                  </div>
                </section>

                {/* 3. Narzędzia edycji na mapie */}
                <section className="rounded-xl border border-line bg-raised/70 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[8.5px] font-extrabold uppercase tracking-[0.12em] text-mute">
                      2. Narzędzie edycji na mapie
                    </span>
                    <button
                      type="button"
                      onClick={() => setFitNonce((n) => n + 1)}
                      className="flex items-center gap-1 text-[8.5px] font-bold text-brand-ink hover:underline"
                    >
                      <Crosshair className="h-2.5 w-2.5" /> Dopasuj widok
                    </button>
                  </div>

                  <div className="mt-1.5 grid grid-cols-2 gap-1">
                    {(
                      [
                        {
                          id: "vertices",
                          label: "Wierzchołki",
                          icon: MousePointerClick,
                        },
                        {
                          id: "segment",
                          label: "Fragment A→B",
                          icon: Scissors,
                        },
                        {
                          id: "draw",
                          label: "Rysuj / dopisz",
                          icon: Pencil,
                        },
                        {
                          id: "delete",
                          label: "Usuń punkty",
                          icon: Trash2,
                        },
                      ] as const
                    ).map((tool) => {
                      const Icon = tool.icon;
                      const active = mode === tool.id;
                      return (
                        <button
                          key={tool.id}
                          type="button"
                          data-testid={`editor-mode-${tool.id}`}
                          onClick={() => {
                            setMode(tool.id);
                            if (tool.id !== "segment") {
                              setSegmentStartIndex(null);
                              setSegmentEndIndex(null);
                              setSegmentDraftPoints([]);
                              setSegmentPreviewPath([]);
                            }
                          }}
                          className={cn(
                            "flex h-8 items-center justify-center gap-1.5 rounded-lg border px-2 text-[9.5px] font-bold transition-colors",
                            active
                              ? "border-brand bg-brand text-on-brand"
                              : "border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink",
                          )}
                        >
                          <Icon className="h-3 w-3 shrink-0" />
                          {tool.label}
                        </button>
                      );
                    })}
                  </div>

                  {/* Kontekstowa instrukcja dla wybranego trybu */}
                  <div className="mt-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[8.5px] leading-snug text-ink-soft">
                    {mode === "vertices" && (
                      <>
                        <b>Przeciągnij</b> punkt, aby przesunąć trasę ·{" "}
                        <b>Kliknij linię</b>, aby dodać nowy punkt ·{" "}
                        <b>PPM / Shift+klik</b> na punkcie usuwa go.
                        {draftPath.length > 140 && (
                          <span className="mt-1 block text-brand-ink">
                            Wskazówka: trasa ma {draftPath.length} punktów — przybliż
                            mapę (zoom ≥ 15) lub kliknij „Uprość punkty”.
                          </span>
                        )}
                      </>
                    )}
                    {mode === "draw" && (
                      <>
                        <b>Klikaj kolejne punkty na mapie</b>, aby przedłużyć trasę
                        (albo użyj „Wyczyść” i narysuj od zera). Przy włączonym OSRM
                        trasa prowadzi po drogach; przy wyłączonym — dokładnie po
                        kliknięciach (pętle, buspasy).
                      </>
                    )}
                    {mode === "delete" && (
                      <>
                        <b>Kliknij dowolny czerwony punkt</b> na trasie, aby go
                        natychmiast usunąć.
                      </>
                    )}
                    {mode === "segment" && (
                      <>
                        {segmentStartIndex === null ? (
                          <span>
                            <b>Krok 1/3:</b> Kliknij na trasie punkt <b>A</b> (początek
                            błędnego odcinka).
                          </span>
                        ) : segmentEndIndex === null ? (
                          <span>
                            <b>Krok 2/3:</b> Kliknij na trasie punkt <b>B</b> (koniec
                            błędnego odcinka).
                          </span>
                        ) : (
                          <div className="space-y-1.5">
                            <span>
                              <b>Krok 3/3:</b> Kliknij opcjonalne punkty pośrednie na
                              właściwej ulicy ({segmentDraftPoints.length} dodanych) i
                              zastosuj zielony podgląd.
                            </span>
                            <div className="flex flex-wrap gap-1 pt-0.5">
                              <button
                                type="button"
                                data-testid="editor-apply-segment"
                                onClick={applySegmentReplacement}
                                disabled={segmentPreviewPath.length < 2}
                                className="flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2.5 text-[9px] font-extrabold text-white hover:bg-emerald-700 disabled:opacity-50"
                              >
                                <Check className="h-3 w-3" /> Zastosuj fragment
                              </button>
                              {segmentDraftPoints.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setSegmentDraftPoints((prev) => prev.slice(0, -1))
                                  }
                                  className="h-7 rounded-md border border-line bg-raised px-2 text-[8.5px] font-bold text-ink-soft hover:text-ink"
                                >
                                  Cofnij punkt
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setSegmentStartIndex(null);
                                  setSegmentEndIndex(null);
                                  setSegmentDraftPoints([]);
                                  setSegmentPreviewPath([]);
                                }}
                                className="h-7 rounded-md border border-line bg-raised px-2 text-[8.5px] font-bold text-ink-soft hover:text-ink"
                              >
                                Anuluj
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {/* Przyciąganie do dróg OSRM */}
                  <label className="mt-2 flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5">
                    <span className="min-w-0">
                      <span className="block text-[9.5px] font-bold text-ink">
                        Przyciągaj do dróg (OSRM)
                      </span>
                      <span className="block text-[8px] text-mute">
                        Wyłącz dla pętli, buspasów i skrótów niedostępnych dla aut
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={snapToRoads}
                      onChange={(e) => setSnapToRoads(e.target.checked)}
                      className="h-4 w-4 accent-brand"
                    />
                  </label>

                  {busyMessage && (
                    <div
                      role="status"
                      className="mt-2 flex items-center gap-1.5 rounded-lg border border-brand/30 bg-brand-soft px-2.5 py-1.5 text-[9px] font-bold text-brand-ink"
                    >
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                      {busyMessage}
                    </div>
                  )}

                  {/* Akcje pomocnicze geometrii */}
                  <div className="mt-2 grid grid-cols-2 gap-1">
                    <button
                      type="button"
                      onClick={undo}
                      disabled={!history.length}
                      title="Cofnij (Ctrl+Z)"
                      className="flex h-7 items-center justify-center gap-1 rounded-md border border-line bg-surface text-[9px] font-bold text-ink-soft hover:text-ink disabled:opacity-40"
                    >
                      <Undo2 className="h-3 w-3" /> Cofnij ({history.length})
                    </button>
                    <button
                      type="button"
                      onClick={redo}
                      disabled={!future.length}
                      title="Ponów (Ctrl+Y)"
                      className="flex h-7 items-center justify-center gap-1 rounded-md border border-line bg-surface text-[9px] font-bold text-ink-soft hover:text-ink disabled:opacity-40"
                    >
                      <Redo2 className="h-3 w-3" /> Ponów ({future.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRouteThroughStops()}
                      disabled={Boolean(busyMessage) || stops.length < 2}
                      title="Poprowadź całą trasę po drogach przez przystanki rozkładowe"
                      className="col-span-2 flex h-7 items-center justify-center gap-1.5 rounded-md border border-brand/30 bg-brand-soft text-[9px] font-extrabold text-brand-ink hover:border-brand/60 disabled:opacity-50"
                    >
                      <Wand2 className="h-3 w-3" /> Poprowadź po przystankach (OSRM)
                    </button>
                    <button
                      type="button"
                      data-testid="editor-simplify"
                      onClick={handleSimplify}
                      disabled={draftPath.length <= 4}
                      title="Zredukuj gęste wierzchołki GTFS (tolerancja 8 m)"
                      className="flex h-7 items-center justify-center gap-1 rounded-md border border-line bg-surface text-[8.5px] font-bold text-ink-soft hover:text-ink disabled:opacity-40"
                    >
                      <Sparkles className="h-3 w-3" /> Uprość punkty
                    </button>
                    <button
                      type="button"
                      onClick={handleSnapEnds}
                      disabled={draftPath.length < 2 || stops.length < 2}
                      title="Dociągnij pierwszy i ostatni punkt do skrajnych przystanków"
                      className="flex h-7 items-center justify-center gap-1 rounded-md border border-line bg-surface text-[8.5px] font-bold text-ink-soft hover:text-ink disabled:opacity-40"
                    >
                      <MapPin className="h-3 w-3" /> Końce do przyst.
                    </button>
                    <button
                      type="button"
                      onClick={handleReverse}
                      disabled={draftPath.length < 2}
                      className="flex h-7 items-center justify-center gap-1 rounded-md border border-line bg-surface text-[8.5px] font-bold text-ink-soft hover:text-ink disabled:opacity-40"
                    >
                      <ArrowLeftRight className="h-3 w-3" /> Odwróć
                    </button>
                    <button
                      type="button"
                      onClick={handleClearToDraw}
                      className="flex h-7 items-center justify-center gap-1 rounded-md border border-line bg-surface text-[8.5px] font-bold text-ink-soft hover:text-warning"
                    >
                      <Trash2 className="h-3 w-3" /> Rysuj od zera
                    </button>
                  </div>

                  {/* Opcje widoku podglądu */}
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-2 text-[8.5px] font-semibold text-ink-soft">
                    <label className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={showOriginal}
                        onChange={(e) => setShowOriginal(e.target.checked)}
                        className="h-3.5 w-3.5 accent-brand"
                      />
                      Oryginał GTFS w tle
                    </label>
                    <label className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={showStops}
                        onChange={(e) => setShowStops(e.target.checked)}
                        className="h-3.5 w-3.5 accent-brand"
                      />
                      Przystanki ({stops.length})
                    </label>
                  </div>
                </section>

                {/* 4. Zapis i notatka */}
                <section className="rounded-xl border border-line bg-raised/70 p-2.5">
                  <span className="text-[8.5px] font-extrabold uppercase tracking-[0.12em] text-mute">
                    3. Zapisz przebieg
                  </span>
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={240}
                    placeholder="Notatka (np. prosto ul. Żeromskiego bez objazdu)"
                    aria-label="Notatka do zmiany trasy"
                    className="mt-1.5 h-8 w-full rounded-lg border border-line bg-surface px-2.5 text-[9.5px] font-semibold text-ink outline-none placeholder:font-normal placeholder:text-mute focus:border-brand/60"
                  />

                  <div className="mt-2 space-y-1.5">
                    {ghConfig.token.trim() && !summary.devApiAvailable ? (
                      <>
                        <button
                          type="button"
                          data-testid="editor-save-publish"
                          disabled={saving || publishing || draftPath.length < 2}
                          onClick={() => void handleSave(true)}
                          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 text-[10.5px] font-extrabold text-on-brand transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          {saving || publishing ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <CloudUpload className="h-3.5 w-3.5" />
                          )}
                          Zapisz i opublikuj dla wszystkich
                        </button>
                        <button
                          type="button"
                          data-testid="editor-save-local"
                          disabled={saving || publishing || draftPath.length < 2}
                          onClick={() => void handleSave(false)}
                          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[9.5px] font-bold text-ink-soft hover:text-ink disabled:opacity-50"
                        >
                          <Save className="h-3 w-3" /> Zapisz lokalnie (roboczo)
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        data-testid="editor-save"
                        disabled={saving || draftPath.length < 2}
                        onClick={() => void handleSave(false)}
                        className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3 text-[10.5px] font-extrabold text-on-brand transition-opacity hover:opacity-90 disabled:opacity-50"
                      >
                        {saving ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Save className="h-3.5 w-3.5" />
                        )}
                        {summary.devApiAvailable
                          ? "Zapisz trasę (wspólny plik)"
                          : "Zapisz trasę"}
                      </button>
                    )}

                    {selectedVariant.customized && (
                      <button
                        type="button"
                        data-testid="editor-restore-gtfs"
                        onClick={() => void handleRestoreGtfs()}
                        className="flex h-7 w-full items-center justify-center gap-1 rounded-lg border border-warning/30 bg-warning-soft text-[9px] font-bold text-warning hover:border-warning/60"
                      >
                        <RotateCcw className="h-3 w-3" /> Przywróć oryginał GTFS
                      </button>
                    )}
                  </div>
                </section>
              </>
            )}

            {/* 5. Widoczność u wszystkich (Publikacja GitHub + JSON) */}
            <section className="rounded-xl border border-line bg-raised/70">
              <button
                type="button"
                data-testid="editor-publish-toggle"
                onClick={() => setPublishSectionOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left"
              >
                <span className="flex items-center gap-1.5 text-[9.5px] font-extrabold text-ink">
                  <Globe className="h-3.5 w-3.5 text-brand-ink" />
                  Widoczność u wszystkich
                  {pendingTotal > 0 && (
                    <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[7.5px] font-extrabold text-amber-700 dark:text-amber-300">
                      {pendingTotal} nowe
                    </span>
                  )}
                </span>
                {publishSectionOpen ? (
                  <ChevronUp className="h-3.5 w-3.5 text-mute" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-mute" />
                )}
              </button>

              {publishSectionOpen && (
                <div className="space-y-2.5 border-t border-line px-2.5 pb-2.5 pt-2 text-[9px]">
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2 py-1.5">
                    <div className="min-w-0">
                      <div className="font-bold text-ink">
                        Opublikowane: {summary.publishedCount} · Lokalne zmiany:{" "}
                        {pendingTotal}
                      </div>
                      <div className="text-[8px] text-mute">
                        Źródło:{" "}
                        {summary.remoteSource === "dev-api"
                          ? "Serwer lokalny (zapis bezpośredni)"
                          : summary.remoteSource === "github-api" ||
                              summary.remoteSource === "github-raw"
                            ? "GitHub (Drytcha/Mapa2)"
                            : "Wbudowane w aplikację"}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRefreshRemote()}
                      disabled={refreshingRemote}
                      title="Pobierz najnowsze opublikowane trasy"
                      className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-line bg-raised px-2 text-[8.5px] font-bold text-ink-soft hover:text-ink"
                    >
                      <RefreshCw
                        className={cn(
                          "h-3 w-3",
                          refreshingRemote && "animate-spin",
                        )}
                      />
                      Odśwież
                    </button>
                  </div>

                  {/* Bezpośrednia publikacja na GitHub */}
                  <div className="space-y-1.5 rounded-lg border border-line bg-surface p-2">
                    <div className="flex items-center gap-1.5 font-extrabold text-ink">
                      <GitBranch className="h-3 w-3 text-brand-ink" />
                      Publikacja bezpośrednia na GitHub
                    </div>
                    <p className="text-[8px] leading-snug text-mute">
                      Aplikacja działa statycznie na GitHub Pages. Aby każda
                      poprawiona trasa była od razu widoczna u wszystkich
                      użytkowników, wklej jednorazowo token GitHub (Fine-grained
                      PAT z uprawnieniem <b>Contents: Read and write</b> dla{" "}
                      <code>
                        {ghConfig.owner}/{ghConfig.repo}
                      </code>
                      ). Token jest zapisywany wyłącznie w Twojej przeglądarce.
                    </p>

                    <div className="grid grid-cols-2 gap-1.5">
                      <input
                        type="text"
                        value={ghConfig.owner}
                        onChange={(e) =>
                          setGhConfig((c) => ({ ...c, owner: e.target.value }))
                        }
                        placeholder="Owner (Drytcha)"
                        aria-label="Właściciel repozytorium GitHub"
                        className="h-7 rounded-md border border-line bg-raised px-2 text-[9px] font-semibold text-ink outline-none focus:border-brand/60"
                      />
                      <input
                        type="text"
                        value={ghConfig.repo}
                        onChange={(e) =>
                          setGhConfig((c) => ({ ...c, repo: e.target.value }))
                        }
                        placeholder="Repo (Mapa2)"
                        aria-label="Nazwa repozytorium GitHub"
                        className="h-7 rounded-md border border-line bg-raised px-2 text-[9px] font-semibold text-ink outline-none focus:border-brand/60"
                      />
                    </div>

                    <div className="flex gap-1">
                      <input
                        type="password"
                        value={ghConfig.token}
                        onChange={(e) => {
                          const next = { ...ghConfig, token: e.target.value };
                          setGhConfig(next);
                          saveGitHubPublishConfig(next);
                        }}
                        placeholder="github_pat_… (token zapisu)"
                        aria-label="Token GitHub Personal Access Token"
                        autoComplete="off"
                        className="h-7 min-w-0 flex-1 rounded-md border border-line bg-raised px-2 text-[9px] font-semibold text-ink outline-none focus:border-brand/60"
                      />
                      {ghConfig.token && (
                        <button
                          type="button"
                          onClick={() => {
                            clearGitHubPublishToken();
                            setGhConfig((c) => ({ ...c, token: "" }));
                            onToast("Usunięto token GitHub z tej przeglądarki.");
                          }}
                          title="Zapomnij token"
                          className="h-7 rounded-md border border-line bg-raised px-2 text-[8.5px] font-bold text-mute hover:text-warning"
                        >
                          Usuń
                        </button>
                      )}
                    </div>

                    {publishError && (
                      <p
                        role="alert"
                        className="rounded-md border border-warning/30 bg-warning-soft px-2 py-1 text-[8.5px] font-bold text-warning"
                      >
                        {publishError}
                      </p>
                    )}

                    {lastCommitUrl && (
                      <a
                        href={lastCommitUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[8.5px] font-bold text-emerald-700 hover:underline dark:text-emerald-300"
                      >
                        <Cloud className="h-3 w-3 shrink-0" />
                        Opublikowano na GitHub — zobacz commit
                        <ExternalLink className="ml-auto h-2.5 w-2.5" />
                      </a>
                    )}

                    <button
                      type="button"
                      data-testid="editor-publish-github"
                      disabled={publishing || !ghConfig.token.trim()}
                      onClick={() => void handlePublishAllToGitHub()}
                      className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-2.5 text-[9.5px] font-extrabold text-on-brand transition-opacity hover:opacity-90 disabled:opacity-45"
                    >
                      {publishing ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <CloudUpload className="h-3 w-3" />
                      )}
                      Opublikuj wszystkie zmiany dla wszystkich
                    </button>
                  </div>

                  {/* Eksport / Import JSON (bez tokena) */}
                  <div className="space-y-1.5 rounded-lg border border-line bg-surface p-2">
                    <div className="font-extrabold text-ink">
                      Bez tokena: plik <code>line-route-overrides.json</code>
                    </div>
                    <div className="grid grid-cols-2 gap-1">
                      <button
                        type="button"
                        onClick={handleDownloadJson}
                        className="flex h-7 items-center justify-center gap-1 rounded-md border border-line bg-raised text-[8.5px] font-bold text-ink-soft hover:text-ink"
                      >
                        <Download className="h-3 w-3" /> Pobierz JSON
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleCopyJson()}
                        className="flex h-7 items-center justify-center gap-1 rounded-md border border-line bg-raised text-[8.5px] font-bold text-ink-soft hover:text-ink"
                      >
                        <Copy className="h-3 w-3" /> Kopiuj JSON
                      </button>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="flex h-7 items-center justify-center gap-1 rounded-md border border-line bg-raised text-[8.5px] font-bold text-ink-soft hover:text-ink"
                      >
                        <Upload className="h-3 w-3" /> Importuj JSON
                      </button>
                      <a
                        href={githubWebEditUrl(ghConfig)}
                        target="_blank"
                        rel="noreferrer"
                        className="flex h-7 items-center justify-center gap-1 rounded-md border border-line bg-raised text-[8.5px] font-bold text-brand-ink hover:border-brand/50"
                      >
                        <ExternalLink className="h-3 w-3" /> Edytuj w GitHub
                      </a>
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="application/json,.json"
                      onChange={(e) => void handleImportFile(e)}
                      className="hidden"
                    />
                  </div>
                </div>
              )}
            </section>

            {/* 6. Lista zmodyfikowanych wariantów */}
            <section className="rounded-xl border border-line bg-raised/70">
              <button
                type="button"
                onClick={() => setModifiedListOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left"
              >
                <span className="flex items-center gap-1.5 text-[9.5px] font-extrabold text-ink">
                  <RouteIcon className="h-3.5 w-3.5 text-brand-ink" />
                  Zmodyfikowane trasy ({allOverrides.length})
                </span>
                {modifiedListOpen ? (
                  <ChevronUp className="h-3.5 w-3.5 text-mute" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-mute" />
                )}
              </button>

              {modifiedListOpen && (
                <div className="border-t border-line px-2.5 pb-2.5 pt-2">
                  {allOverrides.length === 0 ? (
                    <p className="py-2 text-center text-[9px] text-mute">
                      Brak zapisanych korekt tras. Edytuj dowolną linię powyżej i
                      kliknij „Zapisz trasę”.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {allOverrides.map((ovr) => {
                        const lineMeta = entries.find(
                          (e) =>
                            e.shortName.toUpperCase() ===
                            ovr.lineShort.toUpperCase(),
                        );
                        return (
                          <li key={`${ovr.lineShort}::${ovr.variantKey}`}>
                            <button
                              type="button"
                              onClick={() =>
                                selectLineAndVariant(
                                  ovr.lineShort,
                                  ovr.variantKey,
                                )
                              }
                              className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1.5 text-left transition-colors hover:border-brand/50"
                            >
                              <span
                                className="metric grid h-6 min-w-[28px] shrink-0 place-items-center rounded px-1 text-[10px] font-extrabold"
                                style={{
                                  backgroundColor: lineMeta?.color ?? "#0d4f3b",
                                  color: lineMeta?.textColor ?? "#ffffff",
                                }}
                              >
                                {ovr.lineShort}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[9px] font-bold text-ink">
                                  {ovr.firstStopName} → {ovr.lastStopName}
                                </span>
                                {ovr.note && (
                                  <span className="block truncate text-[8px] text-mute">
                                    {ovr.note}
                                  </span>
                                )}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
