import { unzipSync } from "fflate";
import {
  packShapesForTransfer,
  parseShapesFromZipBytes,
  type PackedShapesPayload,
} from "./gtfsShapesParser";
import {
  compareScheduleTrips,
  parseExternalGtfsZipForDiff,
  type ScheduleDiffResult,
  type SchedulePeriodOption,
  type ScheduleServiceOption,
  type ScheduleTripSnapshot,
} from "./scheduleDiff";
import {
  auditLineCatalogue,
  type RouteAuditThresholds,
  type RouteQualityAuditReport,
} from "./routeQualityAudit";
import type { LineEntry } from "./lineRoutes";

export interface SerializedScheduleArchive {
  id: string;
  label: string;
  feedVersion: string;
  fromDate: number;
  toDate: number;
  services: ScheduleServiceOption[];
  periods: SchedulePeriodOption[];
  tripsEntries: Array<[string, ScheduleTripSnapshot[]]>;
  routeMetaEntries: Array<
    [string, { color: string; textColor: string; longName: string }]
  >;
}

export type GtfsWorkerRequest =
  | {
      id: number;
      type: "unzip-without-shapes";
      zipBytes: Uint8Array;
    }
  | {
      id: number;
      type: "parse-shapes";
      zipBytes: Uint8Array;
    }
  | {
      id: number;
      type: "compare-schedule";
      tripsA: ScheduleTripSnapshot[];
      tripsB: ScheduleTripSnapshot[];
      labelA: string;
      labelB: string;
    }
  | {
      id: number;
      type: "parse-external-gtfs-diff";
      zipBytes: Uint8Array;
      label: string;
    }
  | {
      id: number;
      type: "audit-catalogue";
      entries: LineEntry[];
      thresholds?: RouteAuditThresholds;
    };

export type GtfsWorkerSuccessResponse =
  | { id: number; ok: true; type: "unzip-without-shapes"; files: Record<string, Uint8Array> }
  | { id: number; ok: true; type: "parse-shapes"; packed: PackedShapesPayload }
  | { id: number; ok: true; type: "compare-schedule"; diff: ScheduleDiffResult }
  | {
      id: number;
      ok: true;
      type: "parse-external-gtfs-diff";
      archive: SerializedScheduleArchive;
    }
  | { id: number; ok: true; type: "audit-catalogue"; report: RouteQualityAuditReport };

export type GtfsWorkerResponse =
  | GtfsWorkerSuccessResponse
  | { id: number; ok: false; error: string };

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<GtfsWorkerRequest>) => void) | null;
  postMessage: (message: GtfsWorkerResponse, transfer?: Transferable[]) => void;
};

ctx.onmessage = (event: MessageEvent<GtfsWorkerRequest>) => {
  const req = event.data;
  try {
    if (req.type === "unzip-without-shapes") {
      const files = unzipSync(req.zipBytes, {
        filter: (file) => file.name !== "shapes.txt",
      });
      const transfer: Transferable[] = [];
      const seenBuffers = new Set<ArrayBufferLike>();
      for (const value of Object.values(files)) {
        if (
          value instanceof Uint8Array &&
          value.byteOffset === 0 &&
          value.byteLength === value.buffer.byteLength &&
          !seenBuffers.has(value.buffer)
        ) {
          seenBuffers.add(value.buffer);
          transfer.push(value.buffer as ArrayBuffer);
        }
      }
      ctx.postMessage({ id: req.id, ok: true, type: req.type, files }, transfer);
      return;
    }

    if (req.type === "parse-shapes") {
      const shapes = parseShapesFromZipBytes(req.zipBytes);
      const packed = packShapesForTransfer(shapes);
      ctx.postMessage(
        { id: req.id, ok: true, type: req.type, packed },
        [packed.coords.buffer as ArrayBuffer],
      );
      return;
    }

    if (req.type === "compare-schedule") {
      const diff = compareScheduleTrips(
        req.tripsA,
        req.tripsB,
        req.labelA,
        req.labelB,
      );
      ctx.postMessage({ id: req.id, ok: true, type: req.type, diff });
      return;
    }

    if (req.type === "parse-external-gtfs-diff") {
      const parsed = parseExternalGtfsZipForDiff(req.zipBytes, req.label);
      const archive: SerializedScheduleArchive = {
        id: parsed.id,
        label: parsed.label,
        feedVersion: parsed.feedVersion,
        fromDate: parsed.fromDate,
        toDate: parsed.toDate,
        services: parsed.services,
        periods: parsed.periods,
        tripsEntries: Array.from(parsed.tripsByService.entries()),
        routeMetaEntries: Array.from(parsed.routeMeta.entries()),
      };
      ctx.postMessage({ id: req.id, ok: true, type: req.type, archive });
      return;
    }

    if (req.type === "audit-catalogue") {
      const report = auditLineCatalogue(req.entries, req.thresholds);
      ctx.postMessage({ id: req.id, ok: true, type: req.type, report });
      return;
    }
  } catch (error) {
    ctx.postMessage({
      id: req.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
