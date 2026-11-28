import type { LiveBusVehicle } from "../types";
import type { JourneyPlan, JourneyPoint } from "../journeyPlannerCore";
import { exportDynamicDutyOperators } from "./brigadeVerification";
import type { ParsedArchiveBase } from "./gtfsArchiveParser";
import type { GtfsWorkerRequest, GtfsWorkerResponse } from "./gtfsWorker";
import { exportOverridesOverlay } from "./lineRouteOverrides";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onProgress?: (message: string) => void;
  cleanupAbort?: () => void;
}

let workerInstance: Worker | null = null;
let workerDisabled = false;
let nextRequestId = 1;
let workerKnownIdentity: string | null = null;
const pendingRequests = new Map<number, PendingRequest>();

function makeAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Operacja przerwana.", "AbortError");
  }
  const err = new Error("Operacja przerwana.");
  err.name = "AbortError";
  return err;
}

export function isGtfsWorkerAvailable(): boolean {
  return (
    !workerDisabled &&
    typeof window !== "undefined" &&
    typeof Worker !== "undefined"
  );
}

function getOrCreateWorker(): Worker | null {
  if (!isGtfsWorkerAvailable()) return null;
  if (workerInstance) return workerInstance;

  try {
    const worker = new Worker(new URL("./gtfsWorker.ts", import.meta.url), {
      type: "module",
    });

    worker.addEventListener(
      "message",
      (event: MessageEvent<GtfsWorkerResponse>) => {
        const msg = event.data;
        if (!msg || typeof msg !== "object") return;
        const pending = pendingRequests.get(msg.id);
        if (!pending) return;

        if (msg.type === "progress") {
          pending.onProgress?.(msg.message);
          return;
        }

        pendingRequests.delete(msg.id);
        pending.cleanupAbort?.();

        if (msg.type === "result") {
          pending.resolve(msg.payload);
        } else {
          pending.reject(
            msg.aborted ? makeAbortError() : new Error(msg.message),
          );
        }
      },
    );

    worker.addEventListener("error", (event) => {
      workerDisabled = true;
      workerInstance = null;
      workerKnownIdentity = null;
      const err = new Error(
        event.message || "Web Worker GTFS zakończył działanie z błędem.",
      );
      for (const [, pending] of pendingRequests) {
        pending.cleanupAbort?.();
        pending.reject(err);
      }
      pendingRequests.clear();
    });

    workerInstance = worker;
    return worker;
  } catch {
    workerDisabled = true;
    workerInstance = null;
    return null;
  }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

function sendWorkerRequest<T>(
  buildReq: (id: number) => GtfsWorkerRequest,
  options?: {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  },
): Promise<T> {
  const worker = getOrCreateWorker();
  if (!worker) {
    return Promise.reject(new Error("Web Worker niedostępny."));
  }
  options?.signal?.throwIfAborted();

  const id = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    let cleanupAbort: (() => void) | undefined;
    if (options?.signal) {
      const onAbort = () => {
        if (!pendingRequests.has(id)) return;
        pendingRequests.delete(id);
        cleanupAbort?.();
        try {
          worker.postMessage({ id, type: "abort" } satisfies GtfsWorkerRequest);
        } catch {
          // ignore
        }
        reject(makeAbortError());
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      cleanupAbort = () => options.signal?.removeEventListener("abort", onAbort);
    }

    pendingRequests.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      onProgress: options?.onProgress,
      cleanupAbort,
    });

    try {
      worker.postMessage(buildReq(id));
    } catch (err) {
      pendingRequests.delete(id);
      cleanupAbort?.();
      reject(err);
    }
  });
}

export async function parseArchiveViaWorker(
  zipBytes: Uint8Array,
  source: string,
  identity: string,
): Promise<ParsedArchiveBase | null> {
  if (!isGtfsWorkerAvailable()) return null;
  try {
    const dutyOperators = exportDynamicDutyOperators();
    const base = await sendWorkerRequest<ParsedArchiveBase>((id) => ({
      id,
      type: "parseArchive",
      identity,
      source,
      zipBytes,
      dutyOperators,
    }));
    workerKnownIdentity = identity;
    return base;
  } catch {
    return null;
  }
}

export async function parseShapesViaWorker(
  zipBytes: Uint8Array,
  identity: string,
): Promise<Map<string, [number, number][]> | null> {
  if (!isGtfsWorkerAvailable()) return null;
  try {
    const needsBytes = workerKnownIdentity !== identity;
    const shapes = await sendWorkerRequest<Map<string, [number, number][]>>(
      (id) => ({
        id,
        type: "parseShapes",
        identity,
        zipBytes: needsBytes ? zipBytes : undefined,
      }),
    );
    if (needsBytes) {
      workerKnownIdentity = identity;
    }
    return shapes;
  } catch {
    return null;
  }
}

export function syncArchiveToWorkerInBackground(
  zipBytes: Uint8Array,
  source: string,
  identity: string,
): void {
  if (!isGtfsWorkerAvailable() || workerKnownIdentity === identity) return;
  const dutyOperators = exportDynamicDutyOperators();
  void sendWorkerRequest<boolean>((id) => ({
    id,
    type: "syncArchive",
    identity,
    source,
    zipBytes,
    dutyOperators,
  }))
    .then(() => {
      workerKnownIdentity = identity;
    })
    .catch(() => undefined);
}

export async function planJourneysViaWorker(params: {
  identity: string;
  source: string;
  getZipBytes: () => Promise<Uint8Array | null>;
  origin: JourneyPoint;
  destination: JourneyPoint;
  departMs?: number;
  nowMs: number;
  liveBuses: LiveBusVehicle[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<JourneyPlan | null> {
  if (!isGtfsWorkerAvailable()) return null;

  let zipBytes: Uint8Array | undefined;
  if (workerKnownIdentity !== params.identity) {
    const loaded = await params.getZipBytes();
    if (!loaded) return null;
    zipBytes = loaded;
  }

  try {
    const dutyOperators = exportDynamicDutyOperators();
    const overridesOverlay = exportOverridesOverlay();
    const plan = await sendWorkerRequest<JourneyPlan>(
      (id) => ({
        id,
        type: "planJourneys",
        identity: params.identity,
        source: params.source,
        zipBytes,
        dutyOperators,
        overridesOverlay,
        origin: params.origin,
        destination: params.destination,
        departMs: params.departMs,
        nowMs: params.nowMs,
        liveBuses: params.liveBuses,
      }),
      {
        signal: params.signal,
        onProgress: params.onProgress,
      },
    );
    if (zipBytes) {
      workerKnownIdentity = params.identity;
    }
    return plan;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    return null;
  }
}

export type GtfsWorkerRequestWithoutId = DistributiveOmit<
  GtfsWorkerRequest,
  "id"
>;
