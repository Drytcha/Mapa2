import { unzipSync } from "fflate";
import {
  parseShapesFromZipBytes,
  unpackShapesFromTransfer,
} from "./gtfsShapesParser";
import type {
  GtfsWorkerRequest,
  GtfsWorkerResponse,
  GtfsWorkerSuccessResponse,
} from "./gtfsCompute.worker";
import type {
  ScheduleDiffResult,
  ScheduleSourceArchive,
  ScheduleTripSnapshot,
} from "./scheduleDiff";
import type {
  RouteAuditThresholds,
  RouteQualityAuditReport,
} from "./routeQualityAudit";
import type { LineEntry } from "./lineRoutes";

interface PendingRequest {
  resolve: (res: GtfsWorkerResponse) => void;
  reject: (err: Error) => void;
}

let workerInstance: Worker | null = null;
let workerDisabled = false;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function failAllPending(reason: string): void {
  const err = new Error(reason);
  for (const item of pending.values()) {
    item.reject(err);
  }
  pending.clear();
}

function getWorker(): Worker | null {
  if (workerDisabled) return null;
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return null;
  }
  if (workerInstance) return workerInstance;
  try {
    const worker = new Worker(
      new URL("./gtfsCompute.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (event: MessageEvent<GtfsWorkerResponse>) => {
      const res = event.data;
      const entry = pending.get(res.id);
      if (!entry) return;
      pending.delete(res.id);
      if (res.ok) {
        entry.resolve(res);
      } else {
        entry.reject(new Error(res.error || "Błąd wątku roboczego GTFS."));
      }
    };
    worker.onerror = () => {
      workerDisabled = true;
      workerInstance?.terminate();
      workerInstance = null;
      failAllPending("GTFS Web Worker uległ awarii — przełączono na wątek główny.");
    };
    workerInstance = worker;
    return worker;
  } catch {
    workerDisabled = true;
    return null;
  }
}

function callWorker<T extends GtfsWorkerSuccessResponse["type"]>(
  buildReq: (id: number) => { req: GtfsWorkerRequest; transfer?: Transferable[] },
): Promise<Extract<GtfsWorkerSuccessResponse, { type: T }> | null> {
  const worker = getWorker();
  if (!worker) return Promise.resolve(null);
  const id = nextRequestId++;
  const { req, transfer } = buildReq(id);
  return new Promise((resolve) => {
    pending.set(id, {
      resolve: (res) => {
        if (res.ok) {
          resolve(res as Extract<GtfsWorkerSuccessResponse, { type: T }>);
        } else {
          resolve(null);
        }
      },
      reject: () => resolve(null),
    });
    try {
      worker.postMessage(req, transfer ?? []);
    } catch {
      pending.delete(id);
      workerDisabled = true;
      resolve(null);
    }
  });
}

/**
 * Rozpakowuje archiwum GTFS (bez `shapes.txt`) w Web Workerze, z automatycznym
 * fallbackiem do wątku głównego w środowiskach bez Workerów (Node/SSR).
 */
export async function unzipGtfsWithoutShapesOffThread(
  zipBytes: Uint8Array,
): Promise<Record<string, Uint8Array>> {
  const res = await callWorker<"unzip-without-shapes">((id) => {
    // Kopia bufora chroni oryginalny `zipBytes` używany później w IndexedDB / shapes.
    const workerCopy = zipBytes.slice();
    return {
      req: { id, type: "unzip-without-shapes", zipBytes: workerCopy },
      transfer: [workerCopy.buffer as ArrayBuffer],
    };
  });
  if (res) return res.files;
  return unzipSync(zipBytes, { filter: (file) => file.name !== "shapes.txt" });
}

/**
 * Rozpakowuje i parsuje `shapes.txt` w Web Workerze (transfer zero-copy Float64Array).
 */
export async function parseGtfsShapesOffThread(
  zipBytes: Uint8Array,
): Promise<Map<string, [number, number][]>> {
  const res = await callWorker<"parse-shapes">((id) => {
    const workerCopy = zipBytes.slice();
    return {
      req: { id, type: "parse-shapes", zipBytes: workerCopy },
      transfer: [workerCopy.buffer as ArrayBuffer],
    };
  });
  if (res) {
    return unpackShapesFromTransfer(res.packed);
  }
  return parseShapesFromZipBytes(zipBytes);
}

/**
 * Porównuje dwa zbiory kursów GTFS w Web Workerze bez blokowania interfejsu.
 */
export async function compareScheduleTripsOffThread(
  tripsA: ScheduleTripSnapshot[],
  tripsB: ScheduleTripSnapshot[],
  labelA: string,
  labelB: string,
): Promise<ScheduleDiffResult> {
  const res = await callWorker<"compare-schedule">((id) => ({
    req: {
      id,
      type: "compare-schedule",
      tripsA,
      tripsB,
      labelA,
      labelB,
    },
  }));
  if (res) return res.diff;
  const { compareScheduleTrips } = await import("./scheduleDiff");
  return compareScheduleTrips(tripsA, tripsB, labelA, labelB);
}

/**
 * Parsuje wgrany zewnętrzny plik GTFS (.zip) w Web Workerze.
 */
export async function parseExternalGtfsZipForDiffOffThread(
  bytes: Uint8Array,
  label: string,
): Promise<ScheduleSourceArchive> {
  const res = await callWorker<"parse-external-gtfs-diff">((id) => {
    const workerCopy = bytes.slice();
    return {
      req: {
        id,
        type: "parse-external-gtfs-diff",
        zipBytes: workerCopy,
        label,
      },
      transfer: [workerCopy.buffer as ArrayBuffer],
    };
  });
  if (res) {
    return {
      id: res.archive.id,
      label: res.archive.label,
      feedVersion: res.archive.feedVersion,
      fromDate: res.archive.fromDate,
      toDate: res.archive.toDate,
      services: res.archive.services,
      periods: res.archive.periods,
      tripsByService: new Map(res.archive.tripsEntries),
      routeMeta: new Map(res.archive.routeMetaEntries),
    };
  }
  const { parseExternalGtfsZipForDiff } = await import("./scheduleDiff");
  return parseExternalGtfsZipForDiff(bytes, label);
}

/**
 * Uruchamia audyt jakości geometrii tras GTFS w Web Workerze.
 */
export async function auditLineCatalogueOffThread(
  entries: LineEntry[],
  thresholds?: RouteAuditThresholds,
): Promise<RouteQualityAuditReport> {
  const res = await callWorker<"audit-catalogue">((id) => ({
    req: {
      id,
      type: "audit-catalogue",
      entries,
      thresholds,
    },
  }));
  if (res) return res.report;
  const { auditLineCatalogue } = await import("./routeQualityAudit");
  return auditLineCatalogue(entries, thresholds);
}
