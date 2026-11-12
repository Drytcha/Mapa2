/**
 * Pure client-side IndexedDB persistence layer replacing PostgreSQL for GitHub Pages.
 * Gracefully degrades to an in-memory map if IndexedDB is unavailable.
 */

const DB_NAME = "mapplaner-walbrzych-v1";
const DB_VERSION = 1;

const STORE_KV = "kv";
const STORE_OBSERVATIONS = "live_observations";
const STORE_SIGNALS = "traffic_signals";

export interface LiveTripObservation {
  tripId: string;
  routeShort: string;
  brigadeNum: string;
  /**
   * Confirmed full duty code ("9/01"), resolved against the operator roster.
   * Legacy cached rows without `verified` were synthesized from route + GPS
   * suffix and must never be used again.
   */
  kursowkaCode: string;
  dutyLine?: string | null;
  verified?: boolean;
  vehicleId: string;
  operatorName: string;
  observedAt: number;
}

export interface CachedSignalsEntry {
  bboxKey: string;
  signals: Array<{ id: string; lat: number; lon: number }>;
  fetchedAt: number;
}

const memoryKv = new Map<string, unknown>();
const memoryObservations = new Map<string, LiveTripObservation>();
const memorySignals = new Map<string, CachedSignalsEntry>();

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_KV)) {
          db.createObjectStore(STORE_KV);
        }
        if (!db.objectStoreNames.contains(STORE_OBSERVATIONS)) {
          db.createObjectStore(STORE_OBSERVATIONS, { keyPath: "tripId" });
        }
        if (!db.objectStoreNames.contains(STORE_SIGNALS)) {
          db.createObjectStore(STORE_SIGNALS, { keyPath: "bboxKey" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export async function idbGetKv<T>(key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return (memoryKv.get(key) as T | undefined) ?? null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_KV, "readonly");
      const req = tx.objectStore(STORE_KV).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => resolve((memoryKv.get(key) as T | undefined) ?? null);
    } catch {
      resolve((memoryKv.get(key) as T | undefined) ?? null);
    }
  });
}

export async function idbSetKv<T>(key: string, value: T): Promise<void> {
  memoryKv.set(key, value);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_KV, "readwrite");
      tx.objectStore(STORE_KV).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function loadLiveObservations(): Promise<LiveTripObservation[]> {
  const db = await openDb();
  if (!db) {
    return Array.from(memoryObservations.values()).filter((row) => row.verified === true);
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_OBSERVATIONS, "readonly");
      const req = tx.objectStore(STORE_OBSERVATIONS).getAll();
      req.onsuccess = () => {
        const rows = (req.result as LiveTripObservation[] | undefined) ?? [];
        // Starsze wpisy były tworzone przez sklejenie linii z sygnałem GPS
        // (np. 19/01). Bez potwierdzenia w rozkładzie nie wolno ich używać.
        const verified = rows.filter((row) => row.verified === true);
        for (const row of verified) memoryObservations.set(row.tripId, row);
        resolve(verified);
      };
      req.onerror = () => resolve(Array.from(memoryObservations.values()));
    } catch {
      resolve(Array.from(memoryObservations.values()));
    }
  });
}

/** Upserts observed GPS trip -> kursówka mappings; returns true if any mapping changed. */
export async function upsertLiveObservations(entries: LiveTripObservation[]): Promise<boolean> {
  if (!entries.length) return false;
  let changed = false;
  const toPersist: LiveTripObservation[] = [];

  for (const entry of entries) {
    const prev = memoryObservations.get(entry.tripId);
    if (
      !prev ||
      prev.routeShort !== entry.routeShort ||
      prev.brigadeNum !== entry.brigadeNum ||
      prev.kursowkaCode !== entry.kursowkaCode ||
      prev.dutyLine !== entry.dutyLine ||
      prev.verified !== entry.verified ||
      prev.vehicleId !== entry.vehicleId ||
      prev.operatorName !== entry.operatorName
    ) {
      changed = true;
      memoryObservations.set(entry.tripId, entry);
      toPersist.push(entry);
    }
  }

  if (!toPersist.length) return false;
  const db = await openDb();
  if (!db) return changed;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_OBSERVATIONS, "readwrite");
      const store = tx.objectStore(STORE_OBSERVATIONS);
      for (const row of toPersist) store.put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
  return changed;
}

export async function getCachedTrafficSignals(bboxKey: string): Promise<CachedSignalsEntry | null> {
  const mem = memorySignals.get(bboxKey);
  if (mem) return mem;
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_SIGNALS, "readonly");
      const req = tx.objectStore(STORE_SIGNALS).get(bboxKey);
      req.onsuccess = () => {
        const res = (req.result as CachedSignalsEntry | undefined) ?? null;
        if (res) memorySignals.set(bboxKey, res);
        resolve(res);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function setCachedTrafficSignals(entry: CachedSignalsEntry): Promise<void> {
  memorySignals.set(entry.bboxKey, entry);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_SIGNALS, "readwrite");
      tx.objectStore(STORE_SIGNALS).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
