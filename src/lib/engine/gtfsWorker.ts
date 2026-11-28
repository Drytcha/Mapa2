import type { LiveBusVehicle } from "../types";
import {
  planJourneysFromBase,
  type JourneyPlan,
  type JourneyPoint,
} from "../journeyPlannerCore";
import { updateDynamicDutyOperators } from "./brigadeVerification";
import {
  parseArchiveBytesDirect,
  parseShapesBytesDirect,
  type ParsedArchiveBase,
} from "./gtfsArchiveParser";
import {
  applyOverridesOverlay,
  initLineRouteOverrides,
  type OverridesWorkerOverlay,
} from "./lineRouteOverrides";

export type GtfsWorkerRequest =
  | {
      id: number;
      type: "parseArchive";
      identity: string;
      source: string;
      zipBytes: Uint8Array;
      dutyOperators?: Record<string, "ska" | "mzuk">;
    }
  | {
      id: number;
      type: "parseShapes";
      identity: string;
      zipBytes?: Uint8Array;
    }
  | {
      id: number;
      type: "syncArchive";
      identity: string;
      source: string;
      zipBytes: Uint8Array;
      dutyOperators?: Record<string, "ska" | "mzuk">;
    }
  | {
      id: number;
      type: "planJourneys";
      identity: string;
      source: string;
      zipBytes?: Uint8Array;
      dutyOperators?: Record<string, "ska" | "mzuk">;
      overridesOverlay?: OverridesWorkerOverlay;
      origin: JourneyPoint;
      destination: JourneyPoint;
      departMs?: number;
      nowMs: number;
      liveBuses: LiveBusVehicle[];
    }
  | {
      id: number;
      type: "abort";
    };

export type GtfsWorkerResponse =
  | { id: number; type: "progress"; message: string }
  | { id: number; type: "result"; payload: unknown }
  | { id: number; type: "error"; message: string; aborted?: boolean };

interface CachedWorkerArchive {
  identity: string;
  source: string;
  zipBytes: Uint8Array;
  base: ParsedArchiveBase | null;
  shapesLoaded: boolean;
}

let cachedArchive: CachedWorkerArchive | null = null;
let overridesReadyPromise: Promise<void> | null = null;
let appliedOverridesRevision = -1;
const activeControllers = new Map<number, AbortController>();

const workerScope = self as unknown as {
  postMessage: (message: GtfsWorkerResponse) => void;
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<GtfsWorkerRequest>) => void,
  ) => void;
};

async function ensureWorkerOverrides(
  overlay?: OverridesWorkerOverlay,
): Promise<void> {
  if (!overridesReadyPromise) {
    overridesReadyPromise = initLineRouteOverrides().catch(() => undefined);
  }
  await overridesReadyPromise;
  if (overlay && overlay.revision !== appliedOverridesRevision) {
    applyOverridesOverlay(overlay);
    appliedOverridesRevision = overlay.revision;
  }
}

async function ensureWorkerBase(
  identity: string,
  source: string,
  zipBytes?: Uint8Array,
  includeShapes = false,
): Promise<ParsedArchiveBase> {
  if (!cachedArchive || cachedArchive.identity !== identity) {
    if (!zipBytes) {
      throw new Error(
        "Brak archiwum GTFS w Web Workerze dla bieżącej sesji danych.",
      );
    }
    cachedArchive = {
      identity,
      source,
      zipBytes,
      base: null,
      shapesLoaded: false,
    };
  } else if (zipBytes && cachedArchive.zipBytes.byteLength === 0) {
    cachedArchive.zipBytes = zipBytes;
  }

  if (!cachedArchive.base) {
    cachedArchive.base = await parseArchiveBytesDirect(
      cachedArchive.zipBytes,
      cachedArchive.source,
      { cooperative: false },
    );
  }

  if (includeShapes && !cachedArchive.shapesLoaded) {
    const shapes = await parseShapesBytesDirect(cachedArchive.zipBytes, {
      cooperative: false,
    });
    cachedArchive.base.shapesById.clear();
    for (const [shapeId, pts] of shapes.entries()) {
      cachedArchive.base.shapesById.set(shapeId, pts);
    }
    cachedArchive.shapesLoaded = true;
  }

  return cachedArchive.base;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

workerScope.addEventListener(
  "message",
  (event: MessageEvent<GtfsWorkerRequest>) => {
    const req = event.data;
    if (!req || typeof req !== "object") return;

    if (req.type === "abort") {
      const controller = activeControllers.get(req.id);
      if (controller) {
        controller.abort();
        activeControllers.delete(req.id);
      }
      return;
    }

    const controller = new AbortController();
    activeControllers.set(req.id, controller);

    void (async () => {
      try {
        if ("dutyOperators" in req && req.dutyOperators) {
          updateDynamicDutyOperators(req.dutyOperators);
        }

        if (req.type === "syncArchive") {
          if (!cachedArchive || cachedArchive.identity !== req.identity) {
            cachedArchive = {
              identity: req.identity,
              source: req.source,
              zipBytes: req.zipBytes,
              base: null,
              shapesLoaded: false,
            };
          }
          workerScope.postMessage({ id: req.id, type: "result", payload: true });
          return;
        }

        if (req.type === "parseArchive") {
          const base = await parseArchiveBytesDirect(req.zipBytes, req.source, {
            cooperative: false,
          });
          cachedArchive = {
            identity: req.identity,
            source: req.source,
            zipBytes: req.zipBytes,
            base,
            shapesLoaded: false,
          };
          workerScope.postMessage({ id: req.id, type: "result", payload: base });
          return;
        }

        if (req.type === "parseShapes") {
          const bytes =
            req.zipBytes ??
            (cachedArchive?.identity === req.identity
              ? cachedArchive.zipBytes
              : null);
          if (!bytes) {
            throw new Error("Brak archiwum GTFS do odczytu shapes.txt.");
          }
          const shapes = await parseShapesBytesDirect(bytes, {
            cooperative: false,
          });
          if (cachedArchive && cachedArchive.identity === req.identity && cachedArchive.base) {
            cachedArchive.base.shapesById.clear();
            for (const [shapeId, pts] of shapes.entries()) {
              cachedArchive.base.shapesById.set(shapeId, pts);
            }
            cachedArchive.shapesLoaded = true;
          }
          workerScope.postMessage({
            id: req.id,
            type: "result",
            payload: shapes,
          });
          return;
        }

        if (req.type === "planJourneys") {
          await ensureWorkerOverrides(req.overridesOverlay);
          const base = await ensureWorkerBase(
            req.identity,
            req.source,
            req.zipBytes,
            true,
          );
          const plan: JourneyPlan = await planJourneysFromBase(base, {
            origin: req.origin,
            destination: req.destination,
            departMs: req.departMs,
            nowMs: req.nowMs,
            liveBuses: req.liveBuses,
            signal: controller.signal,
            onProgress: (message) => {
              workerScope.postMessage({
                id: req.id,
                type: "progress",
                message,
              });
            },
          });
          workerScope.postMessage({
            id: req.id,
            type: "result",
            payload: plan,
          });
        }
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          workerScope.postMessage({
            id: req.id,
            type: "error",
            message: "Aborted",
            aborted: true,
          });
          return;
        }
        workerScope.postMessage({
          id: req.id,
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "Błąd wewnętrzny Web Workera GTFS.",
        });
      } finally {
        activeControllers.delete(req.id);
      }
    })();
  },
);
