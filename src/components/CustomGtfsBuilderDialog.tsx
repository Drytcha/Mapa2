import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Check,
  CheckSquare,
  Clock,
  Copy,
  Download,
  Eye,
  FileArchive,
  Layers,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Route as RouteIcon,
  Save,
  Search,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { polylineLengthMeters } from "@/lib/core/spatial";
import { foldPolish } from "@/lib/core/text";
import {
  buildMergedGtfsZip,
  createEmptyCustomLine,
  createOppositeVariant,
  customLinesToExportEntries,
  deleteCustomGtfsLine,
  exportCustomGtfsLinesJson,
  formatGtfsClockHm,
  generateHeadwayTrips,
  inspectGtfsSourceZip,
  loadCustomGtfsLines,
  parseClockToMinutes,
  parseCustomGtfsLinesJson,
  parseDepartureTimesText,
  saveAllCustomGtfsLines,
  upsertCustomGtfsLine,
  type CustomGtfsLine,
  type CustomGtfsServiceDef,
  type CustomGtfsStop,
  type CustomGtfsTrip,
  type CustomGtfsVariant,
  type GtfsExportSummary,
  type GtfsSourceMetadata,
} from "@/lib/engine/customGtfsLines";
import {
  ensureGtfsSeeded,
  getLoadedGtfsArchiveBytes,
  type GtfsStopRecord,
} from "@/lib/engine/gtfsStore";
import { listLineRouteOverrides } from "@/lib/engine/lineRouteOverrides";
import { routeThroughStopsViaOsrm, type LatLng } from "@/lib/routeEditorGeometry";
import {
  exportRoutesToGeoJson,
  exportRoutesToGpx,
  exportRoutesToGtfsShapesTxt,
  sanitizeGtfsId,
  triggerBinaryDownload,
  triggerTextDownload,
} from "@/lib/routeExportFormats";
import { cn } from "@/utils/cn";
import type { CustomGtfsMapSession } from "./CustomGtfsMapDrawToolbar";
import type { KursowkaShapeOverlay } from "./MapView";
import { Dialog } from "./Modals";

export interface CustomGtfsResumeTarget {
  lineId: string;
  variantId: string;
  tab?: "meta" | "stops" | "schedule" | "export";
  pickedCoords?: { lat: number; lon: number };
  nonce: number;
}

interface CustomGtfsBuilderDialogProps {
  open: boolean;
  onClose: () => void;
  onShowOnMap: (overlay: KursowkaShapeOverlay) => void;
  onStartMapSession?: (session: CustomGtfsMapSession) => void;
  resumeTarget?: CustomGtfsResumeTarget | null;
  onToast?: (message: string) => void;
}

type BuilderTab = "meta" | "stops" | "schedule" | "export";
type SourceMode = "app-feed" | "uploaded-zip" | "standalone";

const PRESET_COLORS = [
  "#1d4ed8",
  "#0d4f3b",
  "#b91c1c",
  "#7c3aed",
  "#c2410c",
  "#0f766e",
  "#a21caf",
  "#334155",
];

function formatKm(meters: number): string {
  return `${(meters / 1000).toLocaleString("pl-PL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} km`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function CustomGtfsBuilderDialog({
  open,
  onClose,
  onShowOnMap,
  onStartMapSession,
  resumeTarget,
  onToast,
}: CustomGtfsBuilderDialogProps) {
  const [lines, setLines] = useState<CustomGtfsLine[]>([]);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [selectedForExportIds, setSelectedForExportIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [activeTab, setActiveTab] = useState<BuilderTab>("meta");
  const [activeVariantId, setActiveVariantId] = useState<string | null>(null);

  // Source GTFS state (stops, services, raw archive bytes)
  const [gtfsStops, setGtfsStops] = useState<GtfsStopRecord[]>([]);
  const [appSourceBytes, setAppSourceBytes] = useState<Uint8Array | null>(null);
  const [appSourceMeta, setAppSourceMeta] = useState<GtfsSourceMetadata | null>(
    null,
  );
  const [uploadedZipBytes, setUploadedZipBytes] = useState<Uint8Array | null>(
    null,
  );
  const [uploadedZipMeta, setUploadedZipMeta] =
    useState<GtfsSourceMetadata | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>("app-feed");
  const [includeRouteOverrides, setIncludeRouteOverrides] = useState(true);
  const [overridesCount, setOverridesCount] = useState(
    () => listLineRouteOverrides().length,
  );

  // Stop search & custom stop creation
  const [stopQuery, setStopQuery] = useState("");
  const [customStopOpen, setCustomStopOpen] = useState(false);
  const [newStopName, setNewStopName] = useState("");
  const [newStopLat, setNewStopLat] = useState("50.7714");
  const [newStopLon, setNewStopLon] = useState("16.2843");
  const [newStopCode, setNewStopCode] = useState("");
  const [routingBusy, setRoutingBusy] = useState<string | null>(null);

  // Schedule entry state
  const [activeServiceId, setActiveServiceId] = useState("");
  const [headwayStart, setHeadwayStart] = useState("05:30");
  const [headwayEnd, setHeadwayEnd] = useState("22:30");
  const [headwayInterval, setHeadwayInterval] = useState("30");
  const [headwayBlock, setHeadwayBlock] = useState("");
  const [pasteTimesText, setPasteTimesText] = useState("");
  const [singleTime, setSingleTime] = useState("06:00");
  const [singleBlock, setSingleBlock] = useState("");
  const [newCalOpen, setNewCalOpen] = useState(false);
  const [newCalId, setNewCalId] = useState("CUSTOM_RS");
  const [newCalLabel, setNewCalLabel] = useState("Dni robocze");
  const [newCalStart, setNewCalStart] = useState("20260101");
  const [newCalEnd, setNewCalEnd] = useState("20271231");
  const [newCalDays, setNewCalDays] = useState<
    [boolean, boolean, boolean, boolean, boolean, boolean, boolean]
  >([true, true, true, true, true, false, false]);

  // Export result & loading
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [lastExportSummary, setLastExportSummary] =
    useState<GtfsExportSummary | null>(null);
  const [lastExportWarnings, setLastExportWarnings] = useState<string[]>([]);
  const [exportError, setExportError] = useState("");

  const zipInputRef = useRef<HTMLInputElement | null>(null);
  const jsonImportRef = useRef<HTMLInputElement | null>(null);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    try {
      const [savedLines, store, archive] = await Promise.all([
        loadCustomGtfsLines(),
        ensureGtfsSeeded().catch(() => null),
        getLoadedGtfsArchiveBytes().catch(() => null),
      ]);
      setLines(savedLines);
      setSelectedForExportIds((prev) => {
        if (prev.size > 0) return prev;
        return new Set(savedLines.map((l) => l.id));
      });
      if (savedLines.length > 0) {
        setSelectedLineId((prev) =>
          prev && savedLines.some((l) => l.id === prev) ? prev : savedLines[0].id,
        );
      }
      if (store) {
        setGtfsStops(store.base.stops);
      }
      if (archive?.bytes) {
        setAppSourceBytes(archive.bytes);
        try {
          setAppSourceMeta(
            inspectGtfsSourceZip(archive.bytes, `Aktualny GTFS (${archive.source})`),
          );
        } catch {
          setAppSourceMeta(null);
        }
      }
      setOverridesCount(listLineRouteOverrides().length);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void bootstrap();
  }, [open, bootstrap]);

  useEffect(() => {
    if (!open || !resumeTarget) return;
    setSelectedLineId(resumeTarget.lineId);
    setActiveVariantId(resumeTarget.variantId);
    if (resumeTarget.tab) setActiveTab(resumeTarget.tab);
    if (resumeTarget.pickedCoords) {
      setCustomStopOpen(true);
      setNewStopLat(resumeTarget.pickedCoords.lat.toFixed(6));
      setNewStopLon(resumeTarget.pickedCoords.lon.toFixed(6));
    }
  }, [open, resumeTarget]);

  const activeSourceMeta =
    sourceMode === "uploaded-zip"
      ? uploadedZipMeta
      : sourceMode === "app-feed"
        ? appSourceMeta
        : null;

  const activeLine: CustomGtfsLine | null = useMemo(() => {
    if (!lines.length) return null;
    if (selectedLineId) {
      const exact = lines.find((l) => l.id === selectedLineId);
      if (exact) return exact;
    }
    return lines[0];
  }, [lines, selectedLineId]);

  const activeVariant: CustomGtfsVariant | null = useMemo(() => {
    if (!activeLine?.variants.length) return null;
    if (activeVariantId) {
      const exact = activeLine.variants.find((v) => v.id === activeVariantId);
      if (exact) return exact;
    }
    return activeLine.variants[0];
  }, [activeLine, activeVariantId]);

  // All available service_ids (from chosen source GTFS + line's own custom services)
  const availableServiceIds = useMemo(() => {
    const out: Array<{ id: string; label: string; custom: boolean }> = [];
    const seen = new Set<string>();
    for (const sid of activeSourceMeta?.serviceIds ?? []) {
      seen.add(sid);
      out.push({ id: sid, label: `${sid} (ze źródła GTFS)`, custom: false });
    }
    for (const cs of activeLine?.customServices ?? []) {
      if (seen.has(cs.serviceId)) continue;
      seen.add(cs.serviceId);
      out.push({
        id: cs.serviceId,
        label: `${cs.serviceId} (${cs.label})`,
        custom: true,
      });
    }
    return out;
  }, [activeSourceMeta, activeLine]);

  useEffect(() => {
    if (!availableServiceIds.length) return;
    if (!activeServiceId || !availableServiceIds.some((s) => s.id === activeServiceId)) {
      const preferred =
        availableServiceIds.find((s) => /_RS$/i.test(s.id)) ??
        availableServiceIds[0];
      setActiveServiceId(preferred.id);
    }
  }, [availableServiceIds, activeServiceId]);

  const persistLineUpdate = useCallback(async (updated: CustomGtfsLine) => {
    const withTime = { ...updated, updatedAt: new Date().toISOString() };
    setLines((prev) => prev.map((l) => (l.id === withTime.id ? withTime : l)));
    await upsertCustomGtfsLine(withTime);
  }, []);

  const updateActiveLine = (updater: (line: CustomGtfsLine) => CustomGtfsLine) => {
    if (!activeLine) return;
    const next = updater(activeLine);
    void persistLineUpdate(next);
  };

  const updateActiveVariant = (
    updater: (variant: CustomGtfsVariant) => CustomGtfsVariant,
  ) => {
    if (!activeLine || !activeVariant) return;
    updateActiveLine((line) => ({
      ...line,
      variants: line.variants.map((v) =>
        v.id === activeVariant.id ? updater(v) : v,
      ),
    }));
  };

  const handleCreateNewLine = async () => {
    const existingShorts = new Set(lines.map((l) => l.shortName.toUpperCase()));
    let num = 5;
    while (existingShorts.has(`S${num}`)) num += 1;
    const defaultSvc = availableServiceIds[0]?.id ?? "";
    const fresh = createEmptyCustomLine(`S${num}`, defaultSvc);
    const saved = await upsertCustomGtfsLine(fresh);
    setLines(saved);
    setSelectedLineId(fresh.id);
    setActiveVariantId(fresh.variants[0]?.id ?? null);
    setSelectedForExportIds((prev) => new Set([...prev, fresh.id]));
    setActiveTab("meta");
    onToast?.(`Utworzono nową linię ${fresh.shortName}.`);
  };

  const handleDuplicateLine = async (line: CustomGtfsLine) => {
    const copyShort = `${line.shortName}B`;
    const copy: CustomGtfsLine = {
      ...structuredClone(line),
      id: `cline_${Date.now().toString(36)}`,
      shortName: copyShort,
      routeId: `CUSTOM_${sanitizeGtfsId(copyShort)}`,
      longName: `${line.longName} (kopia)`,
      updatedAt: new Date().toISOString(),
    };
    const saved = await upsertCustomGtfsLine(copy);
    setLines(saved);
    setSelectedLineId(copy.id);
    setSelectedForExportIds((prev) => new Set([...prev, copy.id]));
    onToast?.(`Zduplikowano linię jako ${copyShort}.`);
  };

  const handleDeleteLine = async (line: CustomGtfsLine) => {
    const ok = window.confirm(
      `Usunąć projekt linii ${line.shortName} (${line.longName})?`,
    );
    if (!ok) return;
    const saved = await deleteCustomGtfsLine(line.id);
    setLines(saved);
    setSelectedForExportIds((prev) => {
      const next = new Set(prev);
      next.delete(line.id);
      return next;
    });
    if (selectedLineId === line.id) {
      setSelectedLineId(saved[0]?.id ?? null);
    }
    onToast?.(`Usunięto projekt linii ${line.shortName}.`);
  };

  const toggleLineForExport = (lineId: string) => {
    setSelectedForExportIds((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  };

  // Stop search results
  const filteredGtfsStops = useMemo(() => {
    const needle = foldPolish(stopQuery.trim());
    if (!needle) return gtfsStops.slice(0, 25);
    const out: GtfsStopRecord[] = [];
    for (const s of gtfsStops) {
      if (
        foldPolish(`${s.name} ${s.code ?? ""} ${s.id}`).includes(needle)
      ) {
        out.push(s);
        if (out.length >= 30) break;
      }
    }
    return out;
  }, [gtfsStops, stopQuery]);

  const handleAppendGtfsStop = (stop: GtfsStopRecord) => {
    if (!activeVariant) return;
    const lastOffset =
      activeVariant.stops.length > 0
        ? activeVariant.stops[activeVariant.stops.length - 1].offsetMinutes
        : -2;
    const newStop: CustomGtfsStop = {
      id: `stp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      stopId: stop.id,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      code: stop.code ?? undefined,
      isCustomStop: false,
      offsetMinutes: activeVariant.stops.length === 0 ? 0 : lastOffset + 2,
      dwellMinutes: 0,
    };
    updateActiveVariant((v) => {
      const nextStops = [...v.stops, newStop];
      return {
        ...v,
        stops: nextStops,
        headsign: newStop.name,
        name:
          nextStops.length >= 2
            ? `${nextStops[0].name} → ${newStop.name}`
            : v.name,
      };
    });
  };

  const handleAddCustomStop = () => {
    if (!activeVariant) return;
    const lat = Number(newStopLat.replace(",", "."));
    const lon = Number(newStopLon.replace(",", "."));
    if (!newStopName.trim() || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      onToast?.("Podaj poprawną nazwę oraz współrzędne GPS (szerokość i długość).");
      return;
    }
    const lastOffset =
      activeVariant.stops.length > 0
        ? activeVariant.stops[activeVariant.stops.length - 1].offsetMinutes
        : -2;
    const customId = `CUSTOM_STOP_${Date.now().toString(36).toUpperCase()}`;
    const newStop: CustomGtfsStop = {
      id: `stp_${Date.now().toString(36)}`,
      stopId: customId,
      name: newStopName.trim(),
      lat,
      lon,
      code: newStopCode.trim() || undefined,
      isCustomStop: true,
      offsetMinutes: activeVariant.stops.length === 0 ? 0 : lastOffset + 2,
      dwellMinutes: 0,
    };
    updateActiveVariant((v) => {
      const nextStops = [...v.stops, newStop];
      return {
        ...v,
        stops: nextStops,
        headsign: newStop.name,
      };
    });
    setNewStopName("");
    setNewStopCode("");
    setCustomStopOpen(false);
    onToast?.(`Dodano nowy przystanek „${newStop.name}” (zostanie dopisany do stops.txt).`);
  };

  const handleMoveStop = (idx: number, delta: -1 | 1) => {
    if (!activeVariant) return;
    const target = idx + delta;
    if (target < 0 || target >= activeVariant.stops.length) return;
    updateActiveVariant((v) => {
      const arr = [...v.stops];
      const [item] = arr.splice(idx, 1);
      arr.splice(target, 0, item);
      return {
        ...v,
        stops: arr,
        headsign: arr[arr.length - 1]?.name || v.headsign,
      };
    });
  };

  const handleUpdateStopOffset = (idx: number, offsetMin: number) => {
    updateActiveVariant((v) => ({
      ...v,
      stops: v.stops.map((s, i) =>
        i === idx ? { ...s, offsetMinutes: Math.max(0, Math.round(offsetMin)) } : s,
      ),
    }));
  };

  const handleUpdateStopDwell = (idx: number, dwellMin: number) => {
    updateActiveVariant((v) => ({
      ...v,
      stops: v.stops.map((s, i) =>
        i === idx ? { ...s, dwellMinutes: Math.max(0, Math.round(dwellMin)) } : s,
      ),
    }));
  };

  const handleRemoveStop = (idx: number) => {
    updateActiveVariant((v) => {
      const next = v.stops.filter((_, i) => i !== idx);
      return {
        ...v,
        stops: next,
        headsign: next[next.length - 1]?.name || v.headsign,
      };
    });
  };

  const handleRouteVariantViaOsrm = async () => {
    if (!activeVariant || activeVariant.stops.length < 2) {
      onToast?.("Dodaj najpierw co najmniej 2 przystanki do wariantu.");
      return;
    }
    setRoutingBusy("Wyznaczanie przebiegu po drogach (OSRM)…");
    try {
      const { path, snappedChunks, totalChunks } = await routeThroughStopsViaOsrm(
        activeVariant.stops,
        undefined,
        (done, total) => setRoutingBusy(`Wyznaczanie OSRM: ${done}/${total}…`),
      );
      if (path.length >= 2) {
        updateActiveVariant((v) => ({ ...v, path }));
        onToast?.(
          snappedChunks === totalChunks
            ? `Poprowadzono trasę po drogach przez ${activeVariant.stops.length} przystanków (${formatKm(polylineLengthMeters(path))}).`
            : `Poprowadzono trasę (${snappedChunks}/${totalChunks} odcinków po drogach).`,
        );
      }
    } catch {
      onToast?.("Nie udało się połączyć z OSRM — użyj „Połącz prosto po przystankach”.");
    } finally {
      setRoutingBusy(null);
    }
  };

  const handleConnectStopsStraight = () => {
    if (!activeVariant || activeVariant.stops.length < 2) return;
    const straight: LatLng[] = activeVariant.stops.map((s) => [s.lat, s.lon]);
    updateActiveVariant((v) => ({ ...v, path: straight }));
    onToast?.("Utworzono ścieżkę łączącą kolejno wszystkie przystanki.");
  };

  const handleAddOppositeVariant = () => {
    if (!activeLine || !activeVariant) return;
    const opp = createOppositeVariant(activeVariant, activeLine.shortName);
    updateActiveLine((line) => ({
      ...line,
      variants: [...line.variants, opp],
    }));
    setActiveVariantId(opp.id);
    onToast?.(
      `Utworzono wariant powrotny (${opp.stops.length} przystanków z odwróconymi czasami). Kliknij „Poprowadź po drogach (OSRM)”, aby dopasować go do ulic jednokierunkowych.`,
    );
  };

  const handleAddBlankVariant = () => {
    if (!activeLine) return;
    const nextIdx = activeLine.variants.length;
    const newVar: CustomGtfsVariant = {
      id: `var_${Date.now().toString(36)}`,
      name: `Wariant ${nextIdx + 1}`,
      directionId: nextIdx % 2,
      headsign: "",
      shapeId: `CUSTOM_SHAPE_${sanitizeGtfsId(activeLine.shortName)}_${nextIdx}`,
      stops: [],
      path: [],
    };
    updateActiveLine((line) => ({
      ...line,
      variants: [...line.variants, newVar],
    }));
    setActiveVariantId(newVar.id);
  };

  const handlePreviewVariantOnMap = () => {
    if (!activeLine || !activeVariant) return;
    const path =
      activeVariant.path.length >= 2
        ? activeVariant.path
        : activeVariant.stops.map((s): [number, number] => [s.lat, s.lon]);
    if (path.length < 2) {
      onToast?.("Zaznacz trasę na mapie lub dodaj co najmniej 2 przystanki przed podglądem.");
      return;
    }
    onShowOnMap({
      title: `Nowa linia ${activeLine.shortName} · ${activeVariant.name}`,
      color: activeLine.color,
      polylines: [path],
      stops: activeVariant.stops.map((s, idx) => ({
        name: `${idx + 1}. ${s.name} (+${s.offsetMinutes} min)`,
        lat: s.lat,
        lon: s.lon,
        sequence: idx + 1,
      })),
    });
    onClose();
  };

  const handleStartDrawOnMap = async () => {
    if (!activeLine || !activeVariant || !onStartMapSession) return;
    await persistLineUpdate(activeLine);
    onStartMapSession({
      kind: "draw-route",
      lineId: activeLine.id,
      variantId: activeVariant.id,
      lineShort: activeLine.shortName,
      variantName: activeVariant.name,
      color: activeLine.color,
      initialPath: activeVariant.path,
      stops: activeVariant.stops.map((s, idx) => ({
        id: s.id,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        sequence: idx + 1,
      })),
    });
  };

  const handleStartPickStopOnMap = async () => {
    if (!activeLine || !activeVariant || !onStartMapSession) return;
    await persistLineUpdate(activeLine);
    onStartMapSession({
      kind: "pick-stop",
      lineId: activeLine.id,
      variantId: activeVariant.id,
      lineShort: activeLine.shortName,
      variantName: activeVariant.name,
      color: activeLine.color,
      existingPath: activeVariant.path,
      stops: activeVariant.stops.map((s, idx) => ({
        id: s.id,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        sequence: idx + 1,
      })),
    });
  };

  // Schedule actions
  const handleAddHeadwaySeries = () => {
    if (!activeLine || !activeVariant) return;
    const startMin = parseClockToMinutes(headwayStart);
    const endMin = parseClockToMinutes(headwayEnd);
    const step = Number(headwayInterval);
    if (startMin === null || endMin === null || !Number.isFinite(step) || step < 1) {
      onToast?.("Podaj poprawne godziny (np. 05:30 – 22:30) oraz takt w minutach.");
      return;
    }
    const svc = activeServiceId || `CUSTOM_${sanitizeGtfsId(activeLine.shortName)}_RS`;
    const created = generateHeadwayTrips({
      variantId: activeVariant.id,
      serviceId: svc,
      startMinutes: startMin,
      endMinutes: endMin,
      intervalMinutes: step,
      blockId: headwayBlock,
    });
    updateActiveLine((line) => ({
      ...line,
      trips: [...line.trips, ...created].sort(
        (a, b) => a.departureMinutes - b.departureMinutes,
      ),
    }));
    onToast?.(`Dodano ${created.length} kursów (${headwayStart}–${headwayEnd} co ${step} min).`);
  };

  const handleAddPastedTimes = () => {
    if (!activeLine || !activeVariant) return;
    const mins = parseDepartureTimesText(pasteTimesText);
    if (!mins.length) {
      onToast?.("Nie rozpoznano godzin odjazdów. Użyj formatu HH:MM (np. 05:15, 05:45, 06:15).");
      return;
    }
    const svc = activeServiceId || `CUSTOM_${sanitizeGtfsId(activeLine.shortName)}_RS`;
    const created: CustomGtfsTrip[] = mins.map((m, idx) => ({
      id: `trip_${Date.now().toString(36)}_${idx}`,
      variantId: activeVariant.id,
      serviceId: svc,
      departureMinutes: m,
      blockId: headwayBlock.trim() || undefined,
    }));
    updateActiveLine((line) => ({
      ...line,
      trips: [...line.trips, ...created].sort(
        (a, b) => a.departureMinutes - b.departureMinutes,
      ),
    }));
    setPasteTimesText("");
    onToast?.(`Dodano ${created.length} kursów z wklejonej listy godzin.`);
  };

  const handleAddSingleTrip = () => {
    if (!activeLine || !activeVariant) return;
    const dep = parseClockToMinutes(singleTime);
    if (dep === null) {
      onToast?.("Podaj godzinę w formacie HH:MM (np. 06:15 lub 24:10).");
      return;
    }
    const svc = activeServiceId || `CUSTOM_${sanitizeGtfsId(activeLine.shortName)}_RS`;
    const trip: CustomGtfsTrip = {
      id: `trip_${Date.now().toString(36)}`,
      variantId: activeVariant.id,
      serviceId: svc,
      departureMinutes: dep,
      blockId: singleBlock.trim() || undefined,
    };
    updateActiveLine((line) => ({
      ...line,
      trips: [...line.trips, trip].sort(
        (a, b) => a.departureMinutes - b.departureMinutes,
      ),
    }));
  };

  const handleAddCustomCalendar = () => {
    if (!activeLine || !newCalId.trim()) return;
    const def: CustomGtfsServiceDef = {
      serviceId: sanitizeGtfsId(newCalId.trim()),
      label: newCalLabel.trim() || newCalId.trim(),
      startDate: /^\d{8}$/.test(newCalStart) ? newCalStart : "20260101",
      endDate: /^\d{8}$/.test(newCalEnd) ? newCalEnd : "20271231",
      days: [...newCalDays] as [boolean, boolean, boolean, boolean, boolean, boolean, boolean],
    };
    updateActiveLine((line) => ({
      ...line,
      customServices: [
        ...(line.customServices ?? []).filter((c) => c.serviceId !== def.serviceId),
        def,
      ],
    }));
    setActiveServiceId(def.serviceId);
    setNewCalOpen(false);
    onToast?.(`Dodano własny kalendarz ${def.serviceId}.`);
  };

  // Upload custom source GTFS .zip
  const handleSourceZipSelected = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setExportError("");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const meta = inspectGtfsSourceZip(bytes, `Plik: ${file.name}`);
      setUploadedZipBytes(bytes);
      setUploadedZipMeta(meta);
      setSourceMode("uploaded-zip");
      onToast?.(
        `Wczytano źródłowy GTFS „${file.name}” (${meta.routeCount} linii, ${meta.stopCount} przystanków).`,
      );
    } catch (err) {
      setExportError(
        err instanceof Error
          ? err.message
          : "Nie udało się odczytać pliku źródłowego GTFS (.zip).",
      );
    }
  };

  const selectedLinesForExport = useMemo(
    () => lines.filter((l) => selectedForExportIds.has(l.id)),
    [lines, selectedForExportIds],
  );

  // Merge & export complete GTFS .zip
  const handleExportMergedGtfs = () => {
    setExportError("");
    setLastExportSummary(null);
    setLastExportWarnings([]);

    const sourceBytes =
      sourceMode === "uploaded-zip"
        ? uploadedZipBytes
        : sourceMode === "app-feed"
          ? appSourceBytes
          : null;

    if (sourceMode === "uploaded-zip" && !sourceBytes) {
      setExportError("Wgraj najpierw plik źródłowy GTFS (.zip) albo wybierz aktualną paczkę z aplikacji.");
      return;
    }

    const overridesToBake =
      includeRouteOverrides && sourceBytes ? listLineRouteOverrides() : [];

    if (!selectedLinesForExport.length && overridesToBake.length === 0) {
      setExportError(
        "Zaznacz co najmniej jedną dodatkową linię do dołączenia (albo włącz dołączenie poprawek z Edytora linii).",
      );
      return;
    }

    setExporting(true);
    try {
      const result = buildMergedGtfsZip({
        sourceZipBytes: sourceBytes,
        selectedLines: selectedLinesForExport,
        routeOverrides: overridesToBake,
      });
      const tag = selectedLinesForExport.length
        ? selectedLinesForExport
            .map((l) => sanitizeGtfsId(l.shortName))
            .slice(0, 4)
            .join("-")
        : "poprawki";
      const fileName =
        sourceMode === "standalone"
          ? `GTFS-wlasne-linie-${tag}.zip`
          : `GTFS-polaczony-${tag}.zip`;
      triggerBinaryDownload(result.zipBytes, fileName, "application/zip");
      setLastExportSummary(result.summary);
      setLastExportWarnings(result.warnings);
      onToast?.(
        `Wyeksportowano paczkę GTFS (${fileName}): +${result.summary.addedRoutes} linii, +${result.summary.addedTrips} kursów!`,
      );
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : "Eksport paczki GTFS nie powiódł się.",
      );
    } finally {
      setExporting(false);
    }
  };

  const handleExportSelectedGeometry = (format: "shapes" | "geojson" | "gpx") => {
    const targetLines =
      selectedLinesForExport.length > 0
        ? selectedLinesForExport
        : activeLine
          ? [activeLine]
          : [];
    const entries = customLinesToExportEntries(targetLines);
    if (!entries.length) {
      onToast?.("Wybrane linie nie mają jeszcze co najmniej 2 przystanków / punktów trasy.");
      return;
    }
    if (format === "shapes") {
      triggerTextDownload(
        exportRoutesToGtfsShapesTxt(entries),
        "custom-shapes.txt",
        "text/csv;charset=utf-8",
      );
    } else if (format === "geojson") {
      triggerTextDownload(
        exportRoutesToGeoJson(entries),
        "custom-lines.geojson",
        "application/geo+json;charset=utf-8",
      );
    } else {
      triggerTextDownload(
        exportRoutesToGpx(entries),
        "custom-lines.gpx",
        "application/gpx+xml;charset=utf-8",
      );
    }
    onToast?.(`Wyeksportowano ${entries.length} tras w formacie ${format.toUpperCase()}.`);
  };

  const handleBackupJson = () => {
    triggerTextDownload(
      exportCustomGtfsLinesJson(lines),
      "moje-linie-gtfs.json",
      "application/json;charset=utf-8",
    );
    onToast?.("Zapisano kopię projektów własnych linii (JSON).");
  };

  const handleRestoreJson = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const imported = parseCustomGtfsLinesJson(await file.text());
      const mergedMap = new Map<string, CustomGtfsLine>();
      for (const l of lines) mergedMap.set(l.id, l);
      for (const l of imported) mergedMap.set(l.id, l);
      const saved = await saveAllCustomGtfsLines([...mergedMap.values()]);
      setLines(saved);
      setSelectedForExportIds(
        (prev) => new Set([...prev, ...imported.map((l) => l.id)]),
      );
      if (imported[0]) setSelectedLineId(imported[0].id);
      onToast?.(`Zaimportowano ${imported.length} projektów linii z pliku JSON.`);
    } catch (err) {
      onToast?.(
        err instanceof Error ? err.message : "Nie udało się wczytać pliku JSON.",
      );
    }
  };

  const activeVariantTrips = useMemo(() => {
    if (!activeLine || !activeVariant) return [];
    return activeLine.trips
      .filter(
        (t) =>
          t.variantId === activeVariant.id &&
          (!activeServiceId || t.serviceId === activeServiceId),
      )
      .sort((a, b) => a.departureMinutes - b.departureMinutes);
  }, [activeLine, activeVariant, activeServiceId]);

  const variantDurationMin =
    activeVariant && activeVariant.stops.length > 0
      ? activeVariant.stops[activeVariant.stops.length - 1].offsetMinutes
      : 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="Kreator linii i eksport GTFS"
      className="duty-dialog-shell h-[94dvh] max-w-[1320px]"
    >
      {/* ── Nagłówek ───────────────────────────────────────────────── */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-brand text-on-brand">
          <FileArchive className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-[13.5px] font-extrabold tracking-[-0.02em] text-ink">
            Kreator nowych linii i eksport paczki GTFS (.zip)
          </h2>
          <p className="hidden text-[8.5px] text-mute sm:block">
            Twórz własne linie (przystanki, czasy przejazdu, trasa po ulicach,
            odjazdy), wybierz które dodać do źródłowego GTFS i wyeksportuj gotową
            paczkę `.zip`.
          </p>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleBackupJson}
            disabled={!lines.length}
            title="Zapisz kopię projektów linii do JSON"
            className="flex h-7 items-center gap-1 rounded-md border border-line bg-raised px-2 text-[8.5px] font-bold text-ink-soft hover:text-ink disabled:opacity-45"
          >
            <Save className="h-3 w-3" />
            Kopia JSON
          </button>
          <button
            type="button"
            onClick={() => jsonImportRef.current?.click()}
            title="Wczytaj projekty linii z JSON"
            className="flex h-7 items-center gap-1 rounded-md border border-line bg-raised px-2 text-[8.5px] font-bold text-ink-soft hover:text-ink"
          >
            <Upload className="h-3 w-3" />
            Wczytaj JSON
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Zamknij"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-mute transition-colors hover:bg-raised hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <input
        ref={zipInputRef}
        type="file"
        accept=".zip,application/zip"
        onChange={(e) => void handleSourceZipSelected(e)}
        className="hidden"
      />
      <input
        ref={jsonImportRef}
        type="file"
        accept=".json,application/json"
        onChange={(e) => void handleRestoreJson(e)}
        className="hidden"
      />

      {loading && !lines.length && !appSourceMeta ? (
        <div
          role="status"
          className="flex flex-1 items-center justify-center gap-2 p-8 text-[11px] text-mute"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          Wczytywanie bazy przystanków i źródłowego archiwum GTFS…
        </div>
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row"
          data-testid="custom-gtfs-builder-body"
        >
          {/* ── Lewy panel: lista utworzonych linii + wybór do eksportu ── */}
          <aside className="flex max-h-[34dvh] shrink-0 flex-col border-b border-line bg-raised/35 md:max-h-none md:w-[275px] md:border-b-0 md:border-r">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2">
              <span className="text-[9px] font-extrabold uppercase tracking-[0.1em] text-mute">
                Dodatkowe linie ({lines.length})
              </span>
              <button
                type="button"
                data-testid="custom-gtfs-new-line"
                onClick={() => void handleCreateNewLine()}
                className="flex h-7 items-center gap-1 rounded-md bg-brand px-2 text-[9px] font-extrabold text-on-brand hover:opacity-90"
              >
                <Plus className="h-3 w-3" />
                Nowa linia
              </button>
            </div>

            <div className="scroll-area flex-1 space-y-1.5 overflow-y-auto p-2.5">
              {lines.length === 0 ? (
                <div className="rounded-lg border border-dashed border-line bg-surface p-4 text-center">
                  <p className="text-[9.5px] font-bold text-ink">
                    Brak własnych linii
                  </p>
                  <p className="mt-1 text-[8.5px] text-mute">
                    Kliknij „Nowa linia”, aby utworzyć pierwszą linię i dodać ją
                    do pliku źródłowego GTFS.
                  </p>
                </div>
              ) : (
                lines.map((line) => {
                  const isActive = activeLine?.id === line.id;
                  const checked = selectedForExportIds.has(line.id);
                  return (
                    <div
                      key={line.id}
                      data-testid={`custom-gtfs-line-item-${line.shortName}`}
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg border p-1.5 transition-colors",
                        isActive
                          ? "border-brand bg-brand/8"
                          : "border-line bg-surface hover:border-line-strong",
                      )}
                    >
                      <button
                        type="button"
                        data-testid={`custom-gtfs-check-${line.shortName}`}
                        onClick={() => toggleLineForExport(line.id)}
                        title={
                          checked
                            ? "Zaznaczona do dodania przy eksporcie GTFS"
                            : "Nie zostanie dodana do eksportu GTFS"
                        }
                        className="shrink-0 text-brand-ink"
                      >
                        {checked ? (
                          <CheckSquare className="h-4 w-4" />
                        ) : (
                          <Square className="h-4 w-4 text-mute" />
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setSelectedLineId(line.id);
                          setActiveVariantId(line.variants[0]?.id ?? null);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span
                          className="metric grid h-7 min-w-[32px] shrink-0 place-items-center rounded px-1.5 text-[10.5px] font-extrabold"
                          style={{
                            backgroundColor: line.color,
                            color: line.textColor,
                          }}
                        >
                          {line.shortName}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[9.5px] font-extrabold text-ink">
                            {line.longName}
                          </div>
                          <div className="text-[8px] font-semibold text-mute">
                            {line.variants.length} war. · {line.trips.length}{" "}
                            kursów
                          </div>
                        </div>
                      </button>

                      <div className="flex shrink-0 flex-col gap-0.5">
                        <button
                          type="button"
                          onClick={() => void handleDuplicateLine(line)}
                          title="Duplikuj linię"
                          className="rounded p-0.5 text-mute hover:bg-raised hover:text-ink"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteLine(line)}
                          title="Usuń linię"
                          className="rounded p-0.5 text-mute hover:bg-warning-soft hover:text-warning"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="shrink-0 border-t border-line bg-surface p-2.5">
              <div className="text-[8.5px] font-bold text-ink">
                Wybrane do GTFS:{" "}
                <span className="text-brand-ink">
                  {selectedLinesForExport.length} z {lines.length} linii
                </span>
              </div>
              <button
                type="button"
                data-testid="custom-gtfs-goto-export"
                onClick={() => setActiveTab("export")}
                className="mt-1.5 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-2.5 text-[9.5px] font-extrabold text-on-brand hover:opacity-90"
              >
                <FileArchive className="h-3.5 w-3.5" />
                Połącz i eksportuj GTFS (.zip)
              </button>
            </div>
          </aside>

          {/* ── Prawy obszar roboczy: 4 zakładki ───────────────────── */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* Zakładki */}
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-surface px-3.5 py-2">
              {(
                [
                  { id: "meta", label: "1. Linia i warianty", icon: Layers },
                  { id: "stops", label: "2. Przystanki i trasa", icon: MapPin },
                  { id: "schedule", label: "3. Rozkład i czasy", icon: Clock },
                  {
                    id: "export",
                    label: `4. Eksport GTFS (${selectedLinesForExport.length})`,
                    icon: FileArchive,
                  },
                ] as const
              ).map((tab) => {
                const Icon = tab.icon;
                const active = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    data-testid={`custom-gtfs-tab-${tab.id}`}
                    onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      "flex h-8 items-center gap-1.5 rounded-lg px-3 text-[9.5px] font-extrabold transition-colors",
                      active
                        ? "bg-brand text-on-brand"
                        : "border border-line bg-raised text-ink-soft hover:text-ink",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <div className="scroll-area min-h-0 flex-1 overflow-y-auto p-3.5">
              {/* Brak aktywnej linii (poza zakładką eksportu) */}
              {!activeLine && activeTab !== "export" ? (
                <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-raised/30 p-10 text-center">
                  <RouteIcon className="h-8 w-8 text-brand-ink" />
                  <h3 className="text-[13px] font-extrabold text-ink">
                    Stwórz pierwszą dodatkową linię do GTFS
                  </h3>
                  <p className="max-w-[440px] text-[9.5px] text-mute">
                    Zdefiniuj numer, przystanki (z bazy GTFS lub własne GPS),
                    czasy przejazdu, przebieg po drogach i odjazdy. Następnie
                    zaznacz, które linie dopisać do źródłowego pliku GTFS i
                    pobierz gotową paczkę `.zip`.
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleCreateNewLine()}
                    className="mt-2 flex h-9 items-center gap-1.5 rounded-lg bg-brand px-4 text-[10.5px] font-extrabold text-on-brand hover:opacity-90"
                  >
                    <Plus className="h-4 w-4" />
                    Utwórz nową linię
                  </button>
                </div>
              ) : null}

              {/* ── TAB 1: LINIA I WARIANTY ─────────────────────────── */}
              {activeTab === "meta" && activeLine && (
                <div className="space-y-3">
                  <section className="rounded-xl border border-line bg-surface p-3">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-[10.5px] font-extrabold text-ink">
                        Dane linii (routes.txt)
                      </h3>
                      <span
                        className="metric inline-flex h-8 min-w-[44px] items-center justify-center rounded-md px-2.5 text-[13px] font-extrabold"
                        style={{
                          backgroundColor: activeLine.color,
                          color: activeLine.textColor,
                        }}
                      >
                        {activeLine.shortName || "?"}
                      </span>
                    </div>

                    <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                      <label className="block">
                        <span className="text-[8px] font-bold uppercase text-mute">
                          Numer linii (route_short_name)
                        </span>
                        <input
                          type="text"
                          data-testid="custom-gtfs-short-name"
                          value={activeLine.shortName}
                          onChange={(e) => {
                            const val = e.target.value.toUpperCase();
                            updateActiveLine((l) => ({
                              ...l,
                              shortName: val,
                            }));
                          }}
                          className="mt-1 h-8 w-full rounded-md border border-line bg-raised px-2.5 text-[10.5px] font-extrabold text-ink outline-none focus:border-brand/60"
                        />
                      </label>

                      <label className="block sm:col-span-2">
                        <span className="text-[8px] font-bold uppercase text-mute">
                          Nazwa pełna (route_long_name)
                        </span>
                        <input
                          type="text"
                          value={activeLine.longName}
                          onChange={(e) =>
                            updateActiveLine((l) => ({
                              ...l,
                              longName: e.target.value,
                            }))
                          }
                          placeholder="np. Szczawienko – Podzamcze – Sobięcin"
                          className="mt-1 h-8 w-full rounded-md border border-line bg-raised px-2.5 text-[10px] font-semibold text-ink outline-none focus:border-brand/60"
                        />
                      </label>

                      <label className="block">
                        <span className="text-[8px] font-bold uppercase text-mute">
                          GTFS route_id
                        </span>
                        <input
                          type="text"
                          value={activeLine.routeId}
                          onChange={(e) =>
                            updateActiveLine((l) => ({
                              ...l,
                              routeId: e.target.value,
                            }))
                          }
                          className="mt-1 h-8 w-full rounded-md border border-line bg-raised px-2.5 font-mono text-[9.5px] font-semibold text-ink outline-none focus:border-brand/60"
                        />
                      </label>

                      <label className="block">
                        <span className="text-[8px] font-bold uppercase text-mute">
                          Typ (route_type)
                        </span>
                        <select
                          value={activeLine.routeType}
                          onChange={(e) =>
                            updateActiveLine((l) => ({
                              ...l,
                              routeType: Number(e.target.value),
                            }))
                          }
                          className="mt-1 h-8 w-full rounded-md border border-line bg-raised px-2 text-[9.5px] font-bold text-ink outline-none"
                        >
                          <option value={3}>3 — Autobus</option>
                          <option value={0}>0 — Tramwaj</option>
                          <option value={2}>2 — Kolej</option>
                          <option value={11}>11 — Trolejbus</option>
                        </select>
                      </label>

                      <div className="sm:col-span-2">
                        <span className="text-[8px] font-bold uppercase text-mute">
                          Kolor linii (route_color)
                        </span>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {PRESET_COLORS.map((c) => (
                            <button
                              key={c}
                              type="button"
                              onClick={() =>
                                updateActiveLine((l) => ({ ...l, color: c }))
                              }
                              className={cn(
                                "h-6 w-6 rounded-md border transition-transform",
                                activeLine.color.toLowerCase() === c
                                  ? "scale-110 ring-2 ring-brand ring-offset-1 ring-offset-surface"
                                  : "border-white/25",
                              )}
                              style={{ backgroundColor: c }}
                              aria-label={`Kolor ${c}`}
                            />
                          ))}
                          <input
                            type="color"
                            value={activeLine.color}
                            onChange={(e) =>
                              updateActiveLine((l) => ({
                                ...l,
                                color: e.target.value,
                              }))
                            }
                            aria-label="Własny kolor linii"
                            className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent"
                          />
                        </div>
                      </div>

                      <label className="block">
                        <span className="text-[8px] font-bold uppercase text-mute">
                          agency_id (opcjonalnie)
                        </span>
                        <input
                          type="text"
                          value={activeLine.agencyId ?? ""}
                          onChange={(e) =>
                            updateActiveLine((l) => ({
                              ...l,
                              agencyId: e.target.value || undefined,
                            }))
                          }
                          placeholder={
                            activeSourceMeta?.agencyIds[0]
                              ? `Auto: ${activeSourceMeta.agencyIds[0]}`
                              : "Auto ze źródła"
                          }
                          className="mt-1 h-8 w-full rounded-md border border-line bg-raised px-2.5 text-[9.5px] font-semibold text-ink outline-none"
                        />
                      </label>
                    </div>
                  </section>

                  {/* Warianty / kierunki linii */}
                  <section className="rounded-xl border border-line bg-surface p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-[10.5px] font-extrabold text-ink">
                          Warianty i kierunki jazdy ({activeLine.variants.length})
                        </h3>
                        <p className="text-[8.5px] text-mute">
                          Dodaj kierunek „Tam” i jednym kliknięciem wygeneruj
                          odwrócony kierunek „Powrót”.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {activeVariant && activeVariant.stops.length >= 2 && (
                          <button
                            type="button"
                            data-testid="custom-gtfs-add-opposite"
                            onClick={handleAddOppositeVariant}
                            className="flex h-7 items-center gap-1 rounded-md border border-brand/40 bg-brand-soft px-2.5 text-[8.5px] font-extrabold text-brand-ink hover:border-brand"
                          >
                            <ArrowLeftRight className="h-3 w-3" />
                            Utwórz kierunek powrotny
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={handleAddBlankVariant}
                          className="flex h-7 items-center gap-1 rounded-md border border-line bg-raised px-2.5 text-[8.5px] font-bold text-ink hover:border-brand/50"
                        >
                          <Plus className="h-3 w-3" />
                          Dodaj wariant
                        </button>
                      </div>
                    </div>

                    <div className="mt-2.5 space-y-2">
                      {activeLine.variants.map((variant) => {
                        const isSel = activeVariant?.id === variant.id;
                        const varTrips = activeLine.trips.filter(
                          (t) => t.variantId === variant.id,
                        ).length;
                        return (
                          <div
                            key={variant.id}
                            className={cn(
                              "rounded-lg border p-2.5",
                              isSel
                                ? "border-brand bg-brand/6"
                                : "border-line bg-raised/40",
                            )}
                          >
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                              <label className="block sm:col-span-2">
                                <span className="text-[7.5px] font-bold uppercase text-mute">
                                  Nazwa wariantu
                                </span>
                                <input
                                  type="text"
                                  value={variant.name}
                                  onFocus={() => setActiveVariantId(variant.id)}
                                  onChange={(e) =>
                                    updateActiveLine((line) => ({
                                      ...line,
                                      variants: line.variants.map((v) =>
                                        v.id === variant.id
                                          ? { ...v, name: e.target.value }
                                          : v,
                                      ),
                                    }))
                                  }
                                  className="mt-0.5 h-7 w-full rounded border border-line bg-surface px-2 text-[9.5px] font-bold text-ink outline-none"
                                />
                              </label>
                              <label className="block">
                                <span className="text-[7.5px] font-bold uppercase text-mute">
                                  Kierunek (direction_id)
                                </span>
                                <select
                                  value={variant.directionId}
                                  onChange={(e) =>
                                    updateActiveLine((line) => ({
                                      ...line,
                                      variants: line.variants.map((v) =>
                                        v.id === variant.id
                                          ? {
                                              ...v,
                                              directionId: Number(e.target.value),
                                            }
                                          : v,
                                      ),
                                    }))
                                  }
                                  className="mt-0.5 h-7 w-full rounded border border-line bg-surface px-2 text-[9px] font-bold text-ink outline-none"
                                >
                                  <option value={0}>0 — Tam</option>
                                  <option value={1}>1 — Powrót</option>
                                </select>
                              </label>
                              <label className="block">
                                <span className="text-[7.5px] font-bold uppercase text-mute">
                                  Kierunek na tablicy (headsign)
                                </span>
                                <input
                                  type="text"
                                  value={variant.headsign}
                                  onChange={(e) =>
                                    updateActiveLine((line) => ({
                                      ...line,
                                      variants: line.variants.map((v) =>
                                        v.id === variant.id
                                          ? { ...v, headsign: e.target.value }
                                          : v,
                                      ),
                                    }))
                                  }
                                  placeholder="np. Sobięcin"
                                  className="mt-0.5 h-7 w-full rounded border border-line bg-surface px-2 text-[9.5px] font-semibold text-ink outline-none"
                                />
                              </label>
                            </div>

                            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[8.5px]">
                              <div className="metric flex items-center gap-3 text-mute">
                                <span>{variant.stops.length} przystanków</span>
                                <span>
                                  Kształt: {variant.path.length} pkt (
                                  {formatKm(polylineLengthMeters(variant.path))})
                                </span>
                                <span>{varTrips} kursów</span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActiveVariantId(variant.id);
                                    setActiveTab("stops");
                                  }}
                                  className="rounded border border-brand/40 bg-brand-soft px-2 py-0.5 font-extrabold text-brand-ink hover:border-brand"
                                >
                                  Edytuj przystanki i trasę →
                                </button>
                                {activeLine.variants.length > 1 && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateActiveLine((line) => ({
                                        ...line,
                                        variants: line.variants.filter(
                                          (v) => v.id !== variant.id,
                                        ),
                                        trips: line.trips.filter(
                                          (t) => t.variantId !== variant.id,
                                        ),
                                      }))
                                    }
                                    className="rounded border border-line bg-surface px-1.5 py-0.5 font-bold text-mute hover:text-warning"
                                  >
                                    Usuń
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                </div>
              )}

              {/* ── TAB 2: PRZYSTANKI, CZASY PRZEJAZDU I TRASA ──────── */}
              {activeTab === "stops" && activeLine && activeVariant && (
                <div className="space-y-3">
                  {/* Wybór wariantu */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {activeLine.variants.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setActiveVariantId(v.id)}
                        className={cn(
                          "h-7 rounded-md border px-2.5 text-[9px] font-extrabold",
                          v.id === activeVariant.id
                            ? "border-brand bg-brand text-on-brand"
                            : "border-line bg-surface text-ink-soft hover:text-ink",
                        )}
                      >
                        {v.directionId === 0 ? "→" : "←"} {v.name} (
                        {v.stops.length} przyst.)
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-[310px_1fr]">
                    {/* Wyszukiwarka przystanków z bazy GTFS + własny GPS */}
                    <section className="flex max-h-[520px] flex-col rounded-xl border border-line bg-surface p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[9px] font-extrabold uppercase tracking-[0.08em] text-mute">
                          Dodaj przystanki ({gtfsStops.length} w GTFS)
                        </span>
                        <button
                          type="button"
                          data-testid="custom-gtfs-toggle-custom-stop"
                          onClick={() => setCustomStopOpen((v) => !v)}
                          className="text-[8.5px] font-extrabold text-brand-ink hover:underline"
                        >
                          {customStopOpen ? "Ukryj GPS" : "+ Nowy GPS"}
                        </button>
                      </div>

                      {customStopOpen && (
                        <div className="mt-2 space-y-1.5 rounded-lg border border-brand/30 bg-brand/6 p-2">
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[8.5px] font-extrabold text-brand-ink">
                              Nowy przystanek (dopisany do stops.txt)
                            </span>
                            {onStartMapSession && (
                              <button
                                type="button"
                                data-testid="custom-gtfs-pick-stop-map"
                                onClick={() => void handleStartPickStopOnMap()}
                                className="flex items-center gap-0.5 rounded border border-brand/40 bg-surface px-1.5 py-0.5 text-[7.5px] font-extrabold text-brand-ink hover:border-brand"
                              >
                                <MapPin className="h-2.5 w-2.5" />
                                Wskaż na mapie
                              </button>
                            )}
                          </div>
                          <input
                            type="text"
                            value={newStopName}
                            onChange={(e) => setNewStopName(e.target.value)}
                            placeholder="Nazwa przystanku (np. Park Nauki)"
                            className="h-7 w-full rounded border border-line bg-surface px-2 text-[9px] font-semibold text-ink outline-none"
                          />
                          <div className="grid grid-cols-2 gap-1.5">
                            <input
                              type="text"
                              value={newStopLat}
                              onChange={(e) => setNewStopLat(e.target.value)}
                              placeholder="Lat (50.7714)"
                              className="h-7 rounded border border-line bg-surface px-2 text-[9px] font-semibold text-ink outline-none"
                            />
                            <input
                              type="text"
                              value={newStopLon}
                              onChange={(e) => setNewStopLon(e.target.value)}
                              placeholder="Lon (16.2843)"
                              className="h-7 rounded border border-line bg-surface px-2 text-[9px] font-semibold text-ink outline-none"
                            />
                          </div>
                          <div className="flex gap-1.5">
                            <input
                              type="text"
                              value={newStopCode}
                              onChange={(e) => setNewStopCode(e.target.value)}
                              placeholder="Kod słupka (opc.)"
                              className="h-7 min-w-0 flex-1 rounded border border-line bg-surface px-2 text-[9px] font-semibold text-ink outline-none"
                            />
                            <button
                              type="button"
                              onClick={handleAddCustomStop}
                              className="h-7 rounded bg-brand px-2.5 text-[8.5px] font-extrabold text-on-brand hover:opacity-90"
                            >
                              Dodaj
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="mt-2 flex h-8 items-center gap-1.5 rounded-md border border-line bg-raised px-2 focus-within:border-brand/60">
                        <Search className="h-3.5 w-3.5 shrink-0 text-mute" />
                        <input
                          value={stopQuery}
                          onChange={(e) => setStopQuery(e.target.value)}
                          placeholder="Szukaj przystanku GTFS…"
                          aria-label="Szukaj przystanku GTFS"
                          className="min-w-0 flex-1 bg-transparent text-[9.5px] font-semibold text-ink outline-none placeholder:text-mute"
                        />
                        {stopQuery && (
                          <button
                            type="button"
                            onClick={() => setStopQuery("")}
                            className="text-mute hover:text-ink"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </div>

                      <ul className="scroll-area mt-2 flex-1 space-y-1 overflow-y-auto">
                        {filteredGtfsStops.map((stop) => (
                          <li key={stop.id}>
                            <button
                              type="button"
                              onClick={() => handleAppendGtfsStop(stop)}
                              className="flex w-full items-center justify-between gap-2 rounded-md border border-line bg-raised/60 px-2 py-1.5 text-left transition-colors hover:border-brand/50 hover:bg-brand-soft/40"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[9px] font-bold text-ink">
                                  {stop.name}
                                </div>
                                <div className="truncate text-[7.5px] text-mute">
                                  ID: {stop.id}
                                  {stop.code ? ` · nr ${stop.code}` : ""}
                                </div>
                              </div>
                              <Plus className="h-3.5 w-3.5 shrink-0 text-brand-ink" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>

                    {/* Kolejność przystanków, czasy przejazdu i geometria trasy */}
                    <div className="space-y-3">
                      <section className="rounded-xl border border-line bg-surface p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <h3 className="text-[10.5px] font-extrabold text-ink">
                              Kolejność przystanków i czasy przejazdu (
                              {activeVariant.stops.length})
                            </h3>
                            <p className="text-[8.5px] text-mute">
                              Podaj minuty od odjazdu (np. 0, 3, 6, 10…) — każdy
                              kurs wyliczy automatycznie godziny `stop_times.txt`.
                              Łączny czas przejazdu:{" "}
                              <b>{variantDurationMin} min</b>.
                            </p>
                          </div>
                        </div>

                        {activeVariant.stops.length === 0 ? (
                          <div className="mt-2.5 rounded-lg border border-dashed border-line bg-raised/30 p-6 text-center text-[9.5px] text-mute">
                            Klikaj przystanki po lewej (albo dodaj nowy GPS), aby
                            zbudować ciąg przystanków wariantu.
                          </div>
                        ) : (
                          <div className="mt-2.5 space-y-1">
                            <div className="grid grid-cols-[24px_1fr_76px_64px_72px] items-center gap-1.5 px-1.5 text-[7.5px] font-extrabold uppercase text-mute">
                              <span>#</span>
                              <span>Przystanek</span>
                              <span className="text-center">Min. od startu</span>
                              <span className="text-center">Postój</span>
                              <span className="text-right">Kolejność</span>
                            </div>
                            {activeVariant.stops.map((stop, idx) => (
                              <div
                                key={stop.id}
                                className="grid grid-cols-[24px_1fr_76px_64px_72px] items-center gap-1.5 rounded-lg border border-line bg-raised/50 px-1.5 py-1 text-[9px]"
                              >
                                <span className="metric text-center font-extrabold text-mute">
                                  {idx + 1}
                                </span>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1">
                                    <span className="truncate font-bold text-ink">
                                      {stop.name}
                                    </span>
                                    {stop.isCustomStop && (
                                      <span className="shrink-0 rounded bg-brand/15 px-1 text-[7px] font-extrabold text-brand-ink">
                                        Nowy
                                      </span>
                                    )}
                                  </div>
                                  <div className="truncate text-[7.5px] text-mute">
                                    {stop.stopId}
                                  </div>
                                </div>
                                <input
                                  type="number"
                                  min={0}
                                  max={360}
                                  aria-label={`Minuty od startu dla ${stop.name}`}
                                  value={stop.offsetMinutes}
                                  onChange={(e) =>
                                    handleUpdateStopOffset(
                                      idx,
                                      Number(e.target.value),
                                    )
                                  }
                                  className="metric h-7 w-full rounded border border-line bg-surface px-1.5 text-center text-[9.5px] font-extrabold text-ink outline-none focus:border-brand/60"
                                />
                                <input
                                  type="number"
                                  min={0}
                                  max={60}
                                  aria-label={`Postój w minutach na ${stop.name}`}
                                  value={stop.dwellMinutes ?? 0}
                                  onChange={(e) =>
                                    handleUpdateStopDwell(
                                      idx,
                                      Number(e.target.value),
                                    )
                                  }
                                  className="metric h-7 w-full rounded border border-line bg-surface px-1.5 text-center text-[9px] font-semibold text-ink outline-none"
                                />
                                <div className="flex items-center justify-end gap-0.5">
                                  <button
                                    type="button"
                                    disabled={idx === 0}
                                    onClick={() => handleMoveStop(idx, -1)}
                                    title="W górę"
                                    className="rounded p-1 text-mute hover:bg-surface hover:text-ink disabled:opacity-30"
                                  >
                                    <ArrowUp className="h-3 w-3" />
                                  </button>
                                  <button
                                    type="button"
                                    disabled={
                                      idx === activeVariant.stops.length - 1
                                    }
                                    onClick={() => handleMoveStop(idx, 1)}
                                    title="W dół"
                                    className="rounded p-1 text-mute hover:bg-surface hover:text-ink disabled:opacity-30"
                                  >
                                    <ArrowDown className="h-3 w-3" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveStop(idx)}
                                    title="Usuń przystanek"
                                    className="rounded p-1 text-mute hover:bg-warning-soft hover:text-warning"
                                  >
                                    <X className="h-3 w-3" />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </section>

                      {/* Geometria trasy do shapes.txt */}
                      <section className="rounded-xl border border-line bg-surface p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <h3 className="text-[10.5px] font-extrabold text-ink">
                              Geometria trasy (shapes.txt)
                            </h3>
                            <p className="metric text-[8.5px] text-mute">
                              {activeVariant.path.length >= 2
                                ? `Zapisano ${activeVariant.path.length} punktów (${formatKm(polylineLengthMeters(activeVariant.path))})`
                                : "Kliknij „Zaznacz trasę na mapie”, aby wyklikać punkty którędy ma jechać linia, albo wyznacz przez przystanki."}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={handlePreviewVariantOnMap}
                            disabled={
                              activeVariant.path.length < 2 &&
                              activeVariant.stops.length < 2
                            }
                            className="flex h-7 items-center gap-1 rounded-md border border-line bg-raised px-2.5 text-[8.5px] font-bold text-brand-ink hover:border-brand/50 disabled:opacity-45"
                          >
                            <Eye className="h-3 w-3" />
                            Podgląd na mapie
                          </button>
                        </div>

                        {routingBusy && (
                          <div className="mt-2 flex items-center gap-1.5 rounded-md border border-brand/30 bg-brand-soft px-2.5 py-1 text-[8.5px] font-bold text-brand-ink">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            {routingBusy}
                          </div>
                        )}

                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {onStartMapSession && (
                            <button
                              type="button"
                              data-testid="custom-gtfs-draw-on-map"
                              onClick={() => void handleStartDrawOnMap()}
                              className="flex h-8 items-center gap-1.5 rounded-lg bg-brand px-3 text-[9.5px] font-extrabold text-on-brand hover:opacity-90"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              {activeVariant.path.length >= 2
                                ? "Edytuj / zaznacz trasę na mapie"
                                : "Zaznacz trasę na mapie"}
                            </button>
                          )}
                          <button
                            type="button"
                            data-testid="custom-gtfs-route-osrm"
                            disabled={
                              Boolean(routingBusy) ||
                              activeVariant.stops.length < 2
                            }
                            onClick={() => void handleRouteVariantViaOsrm()}
                            className="flex h-8 items-center gap-1.5 rounded-lg border border-brand/40 bg-brand-soft px-3 text-[9px] font-extrabold text-brand-ink hover:border-brand disabled:opacity-45"
                          >
                            <Wand2 className="h-3.5 w-3.5" />
                            Poprowadź przez przystanki (OSRM)
                          </button>
                          <button
                            type="button"
                            disabled={activeVariant.stops.length < 2}
                            onClick={handleConnectStopsStraight}
                            className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 text-[9px] font-bold text-ink-soft hover:text-ink disabled:opacity-45"
                          >
                            <Sparkles className="h-3 w-3" />
                            Połącz prosto
                          </button>
                        </div>
                      </section>
                    </div>
                  </div>
                </div>
              )}

              {/* ── TAB 3: ROZKŁAD ODJAZDÓW (KURSY) ────────────────── */}
              {activeTab === "schedule" && activeLine && activeVariant && (
                <div className="space-y-3">
                  {/* Wybór wariantu i kalendarza (service_id) */}
                  <section className="rounded-xl border border-line bg-surface p-3">
                    <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                      <label className="block">
                        <span className="text-[8px] font-bold uppercase text-mute">
                          Wariant / kierunek
                        </span>
                        <select
                          value={activeVariant.id}
                          onChange={(e) => setActiveVariantId(e.target.value)}
                          className="mt-1 h-8 w-full rounded-md border border-line bg-raised px-2 text-[9.5px] font-bold text-ink outline-none"
                        >
                          {activeLine.variants.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.directionId === 0 ? "→" : "←"} {v.name} (
                              {v.stops.length} przyst., czas:{" "}
                              {v.stops[v.stops.length - 1]?.offsetMinutes ?? 0}{" "}
                              min)
                            </option>
                          ))}
                        </select>
                      </label>

                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-[8px] font-bold uppercase text-mute">
                            Kalendarz / typ dnia (service_id)
                          </span>
                          <button
                            type="button"
                            onClick={() => setNewCalOpen((v) => !v)}
                            className="text-[8px] font-extrabold text-brand-ink hover:underline"
                          >
                            {newCalOpen ? "Anuluj" : "+ Własny kalendarz"}
                          </button>
                        </div>
                        <select
                          data-testid="custom-gtfs-service-select"
                          value={activeServiceId}
                          onChange={(e) => setActiveServiceId(e.target.value)}
                          className="mt-1 h-8 w-full rounded-md border border-line bg-raised px-2 text-[9.5px] font-bold text-ink outline-none"
                        >
                          {availableServiceIds.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {newCalOpen && (
                      <div className="mt-2.5 space-y-2 rounded-lg border border-brand/30 bg-brand/6 p-2.5">
                        <div className="text-[9px] font-extrabold text-brand-ink">
                          Nowy wpis do calendar.txt
                        </div>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <input
                            type="text"
                            value={newCalId}
                            onChange={(e) => setNewCalId(e.target.value)}
                            placeholder="service_id (np. CUSTOM_RS)"
                            className="h-7 rounded border border-line bg-surface px-2 text-[9px] font-bold text-ink outline-none"
                          />
                          <input
                            type="text"
                            value={newCalLabel}
                            onChange={(e) => setNewCalLabel(e.target.value)}
                            placeholder="Opis (np. Robocze)"
                            className="h-7 rounded border border-line bg-surface px-2 text-[9px] font-semibold text-ink outline-none"
                          />
                          <input
                            type="text"
                            value={newCalStart}
                            onChange={(e) => setNewCalStart(e.target.value)}
                            placeholder="Od YYYYMMDD"
                            className="h-7 rounded border border-line bg-surface px-2 text-[9px] font-semibold text-ink outline-none"
                          />
                          <input
                            type="text"
                            value={newCalEnd}
                            onChange={(e) => setNewCalEnd(e.target.value)}
                            placeholder="Do YYYYMMDD"
                            className="h-7 rounded border border-line bg-surface px-2 text-[9px] font-semibold text-ink outline-none"
                          />
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {["Pon", "Wt", "Śr", "Czw", "Pt", "Sob", "Ndz"].map(
                            (day, i) => (
                              <label
                                key={day}
                                className="flex cursor-pointer items-center gap-1 rounded border border-line bg-surface px-2 py-0.5 text-[8.5px] font-bold text-ink"
                              >
                                <input
                                  type="checkbox"
                                  checked={newCalDays[i]}
                                  onChange={(e) =>
                                    setNewCalDays((prev) => {
                                      const next = [...prev] as [
                                        boolean,
                                        boolean,
                                        boolean,
                                        boolean,
                                        boolean,
                                        boolean,
                                        boolean,
                                      ];
                                      next[i] = e.target.checked;
                                      return next;
                                    })
                                  }
                                  className="accent-brand"
                                />
                                {day}
                              </label>
                            ),
                          )}
                          <button
                            type="button"
                            onClick={handleAddCustomCalendar}
                            className="ml-auto h-7 rounded bg-brand px-3 text-[8.5px] font-extrabold text-on-brand"
                          >
                            Dodaj kalendarz
                          </button>
                        </div>
                      </div>
                    )}
                  </section>

                  {/* 3 szybkie sposoby dodawania kursów */}
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    {/* Generator taktu */}
                    <section className="rounded-xl border border-line bg-surface p-3">
                      <h4 className="text-[9.5px] font-extrabold text-ink">
                        Generator taktu (seria odjazdów)
                      </h4>
                      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <label className="block">
                          <span className="text-[7.5px] font-bold uppercase text-mute">
                            Od
                          </span>
                          <input
                            type="text"
                            value={headwayStart}
                            onChange={(e) => setHeadwayStart(e.target.value)}
                            placeholder="05:30"
                            className="metric mt-0.5 h-7 w-full rounded border border-line bg-raised px-2 text-[9.5px] font-bold text-ink outline-none"
                          />
                        </label>
                        <label className="block">
                          <span className="text-[7.5px] font-bold uppercase text-mute">
                            Do
                          </span>
                          <input
                            type="text"
                            value={headwayEnd}
                            onChange={(e) => setHeadwayEnd(e.target.value)}
                            placeholder="22:30"
                            className="metric mt-0.5 h-7 w-full rounded border border-line bg-raised px-2 text-[9.5px] font-bold text-ink outline-none"
                          />
                        </label>
                        <label className="block">
                          <span className="text-[7.5px] font-bold uppercase text-mute">
                            Co (min)
                          </span>
                          <input
                            type="number"
                            min={1}
                            max={240}
                            value={headwayInterval}
                            onChange={(e) => setHeadwayInterval(e.target.value)}
                            className="metric mt-0.5 h-7 w-full rounded border border-line bg-raised px-2 text-[9.5px] font-bold text-ink outline-none"
                          />
                        </label>
                        <label className="block">
                          <span className="text-[7.5px] font-bold uppercase text-mute">
                            Brygada (opc.)
                          </span>
                          <input
                            type="text"
                            value={headwayBlock}
                            onChange={(e) => setHeadwayBlock(e.target.value)}
                            placeholder={`${activeLine.shortName}/01`}
                            className="mt-0.5 h-7 w-full rounded border border-line bg-raised px-2 text-[9px] font-semibold text-ink outline-none"
                          />
                        </label>
                      </div>
                      <button
                        type="button"
                        data-testid="custom-gtfs-generate-headway"
                        onClick={handleAddHeadwaySeries}
                        className="mt-2 flex h-7 w-full items-center justify-center gap-1 rounded-md bg-brand text-[9px] font-extrabold text-on-brand hover:opacity-90"
                      >
                        <Plus className="h-3 w-3" />
                        Generuj serię kursów
                      </button>
                    </section>

                    {/* Wklej listę godzin + pojedynczy kurs */}
                    <section className="rounded-xl border border-line bg-surface p-3">
                      <h4 className="text-[9.5px] font-extrabold text-ink">
                        Wklej godziny odjazdów (lub dodaj pojedynczo)
                      </h4>
                      <textarea
                        rows={2}
                        value={pasteTimesText}
                        onChange={(e) => setPasteTimesText(e.target.value)}
                        placeholder="np. 05:15, 05:45, 06:15, 06:45, 07:15 (można wkleić z Excela)"
                        className="metric mt-1.5 w-full rounded border border-line bg-raised p-1.5 text-[9px] font-semibold text-ink outline-none focus:border-brand/60"
                      />
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          data-testid="custom-gtfs-add-pasted"
                          onClick={handleAddPastedTimes}
                          className="flex h-7 items-center gap-1 rounded-md bg-brand px-2.5 text-[8.5px] font-extrabold text-on-brand hover:opacity-90"
                        >
                          <Plus className="h-3 w-3" />
                          Dodaj wklejone
                        </button>
                        <span className="text-[8px] text-mute">lub 1 kurs:</span>
                        <input
                          type="text"
                          value={singleTime}
                          onChange={(e) => setSingleTime(e.target.value)}
                          placeholder="06:00"
                          className="metric h-7 w-16 rounded border border-line bg-raised px-1.5 text-center text-[9px] font-bold text-ink outline-none"
                        />
                        <input
                          type="text"
                          value={singleBlock}
                          onChange={(e) => setSingleBlock(e.target.value)}
                          placeholder="Bryg."
                          className="h-7 w-16 rounded border border-line bg-raised px-1.5 text-[9px] font-semibold text-ink outline-none"
                        />
                        <button
                          type="button"
                          onClick={handleAddSingleTrip}
                          className="h-7 rounded border border-line bg-raised px-2 text-[8.5px] font-bold text-ink hover:border-brand/50"
                        >
                          +1
                        </button>
                      </div>
                    </section>
                  </div>

                  {/* Lista zaplanowanych odjazdów */}
                  <section className="rounded-xl border border-line bg-surface p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-[10px] font-extrabold text-ink">
                        Zaplanowane odjazdy ({activeVariantTrips.length} dla{" "}
                        {activeServiceId || "wszystkich"})
                      </h4>
                      {activeVariantTrips.length > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            updateActiveLine((line) => ({
                              ...line,
                              trips: line.trips.filter(
                                (t) =>
                                  !(
                                    t.variantId === activeVariant.id &&
                                    (!activeServiceId ||
                                      t.serviceId === activeServiceId)
                                  ),
                              ),
                            }))
                          }
                          className="text-[8.5px] font-bold text-warning hover:underline"
                        >
                          Wyczyść tę serię
                        </button>
                      )}
                    </div>

                    {activeVariantTrips.length === 0 ? (
                      <p className="py-5 text-center text-[9.5px] text-mute">
                        Brak odjazdów dla tego wariantu i kalendarza. Użyj
                        generatora taktu lub wklej listę godzin powyżej.
                      </p>
                    ) : (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {activeVariantTrips.map((trip) => (
                          <span
                            key={trip.id}
                            className="metric inline-flex items-center gap-1.5 rounded-md border border-line bg-raised px-2 py-1 text-[9px] font-bold text-ink"
                          >
                            <span>
                              {formatGtfsClockHm(trip.departureMinutes)}
                            </span>
                            <span className="text-[8px] font-normal text-mute">
                              →{" "}
                              {formatGtfsClockHm(
                                trip.departureMinutes + variantDurationMin,
                              )}
                            </span>
                            {trip.blockId && (
                              <span className="rounded bg-surface px-1 text-[7.5px] text-brand-ink">
                                {trip.blockId}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                updateActiveLine((line) => ({
                                  ...line,
                                  trips: line.trips.filter(
                                    (t) => t.id !== trip.id,
                                  ),
                                }))
                              }
                              aria-label="Usuń kurs"
                              className="text-mute hover:text-warning"
                            >
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              )}

              {/* ── TAB 4: POŁĄCZ ZE ŹRÓDŁEM I EKSPORTUJ GTFS (.ZIP) ── */}
              {activeTab === "export" && (
                <div className="space-y-3">
                  {/* Krok A: Wybór pliku źródłowego GTFS */}
                  <section className="rounded-xl border border-line bg-surface p-3">
                    <h3 className="text-[10.5px] font-extrabold text-ink">
                      1. Plik źródłowy GTFS (baza do połączenia)
                    </h3>
                    <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
                      <button
                        type="button"
                        onClick={() => setSourceMode("app-feed")}
                        className={cn(
                          "rounded-lg border p-2.5 text-left transition-colors",
                          sourceMode === "app-feed"
                            ? "border-brand bg-brand/8"
                            : "border-line bg-raised/40 hover:border-line-strong",
                        )}
                      >
                        <div className="text-[9.5px] font-extrabold text-ink">
                          Aktualna paczka GTFS z aplikacji
                        </div>
                        <div className="mt-0.5 text-[8px] text-mute">
                          {appSourceMeta
                            ? `${appSourceMeta.routeCount} linii · ${appSourceMeta.stopCount} przyst. · ${appSourceBytes ? formatBytes(appSourceBytes.byteLength) : ""}`
                            : "Wczytywanie / brak lokalnej paczki"}
                        </div>
                      </button>

                      <div
                        className={cn(
                          "rounded-lg border p-2.5 text-left transition-colors",
                          sourceMode === "uploaded-zip"
                            ? "border-brand bg-brand/8"
                            : "border-line bg-raised/40 hover:border-line-strong",
                        )}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              uploadedZipBytes
                                ? setSourceMode("uploaded-zip")
                                : zipInputRef.current?.click()
                            }
                            className="text-left text-[9.5px] font-extrabold text-ink"
                          >
                            Własny plik źródłowy (.zip)
                          </button>
                          <button
                            type="button"
                            data-testid="custom-gtfs-upload-source"
                            onClick={() => zipInputRef.current?.click()}
                            className="rounded border border-brand/40 bg-surface px-1.5 py-0.5 text-[8px] font-extrabold text-brand-ink hover:border-brand"
                          >
                            Wybierz ZIP
                          </button>
                        </div>
                        <div className="mt-0.5 truncate text-[8px] text-mute">
                          {uploadedZipMeta
                            ? `${uploadedZipMeta.label} (${uploadedZipMeta.routeCount} linii)`
                            : "Wgraj źródłowy GTFS .zip z dysku"}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => setSourceMode("standalone")}
                        className={cn(
                          "rounded-lg border p-2.5 text-left transition-colors",
                          sourceMode === "standalone"
                            ? "border-brand bg-brand/8"
                            : "border-line bg-raised/40 hover:border-line-strong",
                        )}
                      >
                        <div className="text-[9.5px] font-extrabold text-ink">
                          Samodzielny GTFS (tylko nowe linie)
                        </div>
                        <div className="mt-0.5 text-[8px] text-mute">
                          Eksportuje czystą paczkę GTFS wyłącznie z zaznaczonymi
                          liniami własnymi.
                        </div>
                      </button>
                    </div>
                  </section>

                  {/* Krok B: Wybór dodatkowych linii do dołączenia */}
                  <section className="rounded-xl border border-line bg-surface p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-[10.5px] font-extrabold text-ink">
                          2. Wybierz, które dodatkowe linie dodać do GTFS (
                          {selectedLinesForExport.length} z {lines.length})
                        </h3>
                        <p className="text-[8.5px] text-mute">
                          Zaznaczone linie zostaną dopisane do `routes.txt`,
                          `stops.txt`, `shapes.txt`, `trips.txt`,
                          `stop_times.txt` i `calendar.txt`.
                        </p>
                      </div>
                      {lines.length > 0 && (
                        <div className="flex gap-1.5 text-[8.5px] font-bold">
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedForExportIds(
                                new Set(lines.map((l) => l.id)),
                              )
                            }
                            className="text-brand-ink hover:underline"
                          >
                            Zaznacz wszystkie
                          </button>
                          <span className="text-mute">·</span>
                          <button
                            type="button"
                            onClick={() => setSelectedForExportIds(new Set())}
                            className="text-mute hover:text-ink"
                          >
                            Odznacz wszystkie
                          </button>
                        </div>
                      )}
                    </div>

                    {lines.length === 0 ? (
                      <p className="mt-2 rounded-lg border border-dashed border-line bg-raised/30 p-4 text-center text-[9.5px] text-mute">
                        Nie utworzono jeszcze żadnej dodatkowej linii. Możesz
                        utworzyć nową linię po lewej stronie albo wyeksportować
                        samo źródło z poprawkami kształtów z Edytora linii.
                      </p>
                    ) : (
                      <div className="mt-2.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                        {lines.map((line) => {
                          const checked = selectedForExportIds.has(line.id);
                          const readyVariants = line.variants.filter(
                            (v) => v.stops.length >= 2,
                          ).length;
                          const ready = readyVariants > 0;
                          return (
                            <label
                              key={line.id}
                              data-testid={`export-select-line-${line.shortName}`}
                              className={cn(
                                "flex cursor-pointer items-center gap-2.5 rounded-lg border p-2 transition-colors",
                                checked
                                  ? "border-brand bg-brand/6"
                                  : "border-line bg-raised/40",
                              )}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleLineForExport(line.id)}
                                className="h-4 w-4 accent-brand"
                              />
                              <span
                                className="metric grid h-7 min-w-[34px] shrink-0 place-items-center rounded px-1.5 text-[11px] font-extrabold"
                                style={{
                                  backgroundColor: line.color,
                                  color: line.textColor,
                                }}
                              >
                                {line.shortName}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[9.5px] font-extrabold text-ink">
                                  {line.longName}
                                </div>
                                <div className="text-[8px] text-mute">
                                  {readyVariants}/{line.variants.length} gotowych
                                  war. · {line.trips.length} kursów
                                </div>
                              </div>
                              {ready ? (
                                <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[7.5px] font-extrabold text-emerald-700 dark:text-emerald-300">
                                  <Check className="h-2.5 w-2.5" />
                                  Gotowa
                                </span>
                              ) : (
                                <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[7.5px] font-extrabold text-amber-700 dark:text-amber-300">
                                  <AlertTriangle className="h-2.5 w-2.5" />
                                  Dodaj przyst.
                                </span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    )}

                    {/* Wbudowanie poprawek kształtów z Edytora linii */}
                    {sourceMode !== "standalone" && (
                      <label className="mt-3 flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-raised/50 px-2.5 py-2 text-[9px] font-bold text-ink">
                        <input
                          type="checkbox"
                          checked={includeRouteOverrides}
                          onChange={(e) =>
                            setIncludeRouteOverrides(e.target.checked)
                          }
                          className="h-3.5 w-3.5 accent-brand"
                        />
                        <span>
                          Wbuduj do `shapes.txt` także poprawione przebiegi
                          istniejących linii z Edytora tras ({overridesCount}{" "}
                          zapisanych poprawek)
                        </span>
                      </label>
                    )}
                  </section>

                  {/* Krok C: Przyciski eksportu i wynik */}
                  <section className="rounded-xl border border-line bg-surface p-3">
                    {exportError && (
                      <div
                        role="alert"
                        className="mb-2.5 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[9.5px] font-bold text-warning"
                      >
                        {exportError}
                      </div>
                    )}

                    {lastExportSummary && (
                      <div
                        className="mb-2.5 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-[9px] text-emerald-900 dark:text-emerald-200"
                        data-testid="custom-gtfs-export-result"
                      >
                        <div className="font-extrabold">
                          Paczka GTFS (.zip) wygenerowana i pobrana (
                          {formatBytes(lastExportSummary.zipSizeBytes)} ·{" "}
                          {lastExportSummary.totalFilesInZip} plików)!
                        </div>
                        <div className="metric mt-0.5 text-[8.5px]">
                          Dodano: +{lastExportSummary.addedRoutes} linii (
                          {lastExportSummary.includedLines.join(", ") || "—"}), +
                          {lastExportSummary.addedStops} nowych przystanków, +
                          {lastExportSummary.addedShapes} kształtów, +
                          {lastExportSummary.addedTrips} kursów, +
                          {lastExportSummary.addedStopTimes} wierszy stop_times
                          {lastExportSummary.updatedOverrideShapes > 0
                            ? `, zaktualizowano ${lastExportSummary.updatedOverrideShapes} kształtów z Edytora linii`
                            : ""}
                          .
                        </div>
                        {lastExportWarnings.length > 0 && (
                          <ul className="mt-1 list-disc pl-4 text-[8px] text-amber-700 dark:text-amber-300">
                            {lastExportWarnings.map((w, i) => (
                              <li key={i}>{w}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        data-testid="custom-gtfs-export-zip"
                        disabled={exporting}
                        onClick={handleExportMergedGtfs}
                        className="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-[11px] font-extrabold text-on-brand transition-opacity hover:opacity-90 disabled:opacity-50"
                      >
                        {exporting ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <FileArchive className="h-4 w-4" />
                        )}
                        Połącz ze źródłem i eksportuj GTFS (.zip)
                      </button>

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleExportSelectedGeometry("shapes")}
                          className="flex h-10 items-center gap-1 rounded-lg border border-line bg-raised px-2.5 text-[9px] font-bold text-ink-soft hover:border-brand/50 hover:text-brand-ink"
                        >
                          <Download className="h-3 w-3" />
                          shapes.txt
                        </button>
                        <button
                          type="button"
                          onClick={() => handleExportSelectedGeometry("geojson")}
                          className="flex h-10 items-center gap-1 rounded-lg border border-line bg-raised px-2.5 text-[9px] font-bold text-ink-soft hover:border-brand/50 hover:text-brand-ink"
                        >
                          <Download className="h-3 w-3" />
                          GeoJSON
                        </button>
                        <button
                          type="button"
                          onClick={() => handleExportSelectedGeometry("gpx")}
                          className="flex h-10 items-center gap-1 rounded-lg border border-line bg-raised px-2.5 text-[9px] font-bold text-ink-soft hover:border-brand/50 hover:text-brand-ink"
                        >
                          <Download className="h-3 w-3" />
                          GPX
                        </button>
                      </div>
                    </div>
                  </section>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
