"use client";

import { useEffect, useState } from "react";
import type { LiveBusVehicle, LiveTrafficSummary } from "@/lib/types";

export interface LiveFleetSnapshot {
  vehicles: LiveBusVehicle[];
  traffic: LiveTrafficSummary;
  source: string;
}

/* -------------------------------------------------------------------------- */
/*  1. Bounded LRU + TTL Cache                                                */
/* -------------------------------------------------------------------------- */

export class LruTtlCache<K, V> {
  private readonly map = new Map<K, { at: number; value: V }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number
  ) {}

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  hasFresh(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (Date.now() - entry.at > this.ttlMs) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  set(key: K, value: V, customAt = Date.now()): V {
    this.map.delete(key);
    this.map.set(key, { at: customAt, value });
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return value;
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

/* -------------------------------------------------------------------------- */
/*  2. Shared In-Flight Task Deduplicator                                     */
/* -------------------------------------------------------------------------- */

const inFlightTasks = new Map<string, Promise<unknown>>();

/**
 * Deduplicates concurrent async operations across modules.
 * While `key` is in flight, every caller shares the exact same Promise.
 */
export function runDeduped<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = inFlightTasks.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = task().finally(() => {
    if (inFlightTasks.get(key) === promise) {
      inFlightTasks.delete(key);
    }
  });
  inFlightTasks.set(key, promise);
  return promise;
}

/* -------------------------------------------------------------------------- */
/*  3. Typed Cross-Module Event Bus                                           */
/* -------------------------------------------------------------------------- */

export interface RuntimeEventMap {
  "gtfs:updated": { version: string };
  "observations:updated": void;
  "operators:updated": { vehicleId: string };
  "fleet:updated": { snapshot: LiveFleetSnapshot; signature: string };
  "fleet:loading": boolean;
}

type EventListener<K extends keyof RuntimeEventMap> = (
  payload: RuntimeEventMap[K]
) => void;

const listeners = new Map<
  keyof RuntimeEventMap,
  Set<EventListener<keyof RuntimeEventMap>>
>();

export function onRuntimeEvent<K extends keyof RuntimeEventMap>(
  event: K,
  listener: EventListener<K>
): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(listener as EventListener<keyof RuntimeEventMap>);
  return () => {
    set?.delete(listener as EventListener<keyof RuntimeEventMap>);
  };
}

export function emitRuntimeEvent<K extends keyof RuntimeEventMap>(
  event: K,
  payload: RuntimeEventMap[K]
): void {
  const set = listeners.get(event);
  if (!set?.size) return;
  for (const fn of set) {
    try {
      (fn as EventListener<K>)(payload);
    } catch {
      /* Subscriber errors never break other connected modules. */
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  4. Multiplexed Visibility-Aware Clock                                     */
/* -------------------------------------------------------------------------- */

interface ClockBucket {
  subs: Set<(now: number) => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const clockBuckets = new Map<number, ClockBucket>();
let clockVisibilityAttached = false;

function syncClockTimers(): void {
  if (typeof document === "undefined") return;
  const hidden = document.hidden;
  const now = Date.now();
  for (const [intervalMs, bucket] of clockBuckets) {
    if (hidden || bucket.subs.size === 0) {
      if (bucket.timer !== null) {
        clearInterval(bucket.timer);
        bucket.timer = null;
      }
      continue;
    }
    if (bucket.timer === null) {
      bucket.timer = setInterval(() => {
        if (document.hidden) return;
        const tick = Date.now();
        for (const cb of bucket.subs) cb(tick);
      }, intervalMs);
    }
    for (const cb of bucket.subs) cb(now);
  }
}

function ensureClockVisibilityListener(): void {
  if (clockVisibilityAttached || typeof document === "undefined") return;
  clockVisibilityAttached = true;
  document.addEventListener("visibilitychange", syncClockTimers);
}

export function subscribeSharedClock(
  intervalMs: number,
  callback: (now: number) => void
): () => void {
  if (typeof window === "undefined") return () => {};
  ensureClockVisibilityListener();
  let bucket = clockBuckets.get(intervalMs);
  if (!bucket) {
    bucket = { subs: new Set(), timer: null };
    clockBuckets.set(intervalMs, bucket);
  }
  bucket.subs.add(callback);
  if (!document.hidden && bucket.timer === null) {
    bucket.timer = setInterval(() => {
      if (document.hidden) return;
      const tick = Date.now();
      for (const cb of bucket!.subs) cb(tick);
    }, intervalMs);
  }
  return () => {
    const current = clockBuckets.get(intervalMs);
    if (!current) return;
    current.subs.delete(callback);
    if (current.subs.size === 0 && current.timer !== null) {
      clearInterval(current.timer);
      current.timer = null;
    }
  };
}

/** React hook connected to the shared visibility-aware clock multiplexer. */
export function useSharedClock(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    return subscribeSharedClock(intervalMs, setNow);
  }, [intervalMs, enabled]);
  return now;
}

/* -------------------------------------------------------------------------- */
/*  5. Adaptive Single-Timer Live Fleet Coordinator                           */
/* -------------------------------------------------------------------------- */

export interface FleetDemand {
  /** True when live buses, trip planner, stop timetable, or kursówki are open. */
  active: boolean;
  /** True when a single bus card is open and requires smooth 2.5 s tracking. */
  fast?: boolean;
}

type FleetFetcher = (force?: boolean) => Promise<LiveFleetSnapshot>;

let fleetFetcher: FleetFetcher | null = null;
let latestFleet: { at: number; snapshot: LiveFleetSnapshot; signature: string } | null = null;
let fleetLoading = false;
let fleetTimer: ReturnType<typeof setTimeout> | null = null;
let fleetVisibilityAttached = false;
const fleetDemands = new Map<string, FleetDemand>();

export function computeFleetSignature(snapshot: LiveFleetSnapshot): string {
  const vPart = snapshot.vehicles
    .map(
      (v) =>
        `${v.vehicleId}:${v.lat.toFixed(5)},${v.lon.toFixed(5)}:${v.delaySeconds}:${v.dutyCode ?? ""}:${v.operatorKey}:${v.speedKmh === null ? "-" : Math.round(v.speedKmh)}:${v.routeName}:${v.tripId ?? ""}:${v.upcomingStops[0]?.sequence ?? ""}:${v.upcomingStops[0]?.scheduledDeparture ?? ""}`
    )
    .join("|");
  return `${snapshot.vehicles.length}#${snapshot.traffic.recommendedPeakPercent}#${vPart}`;
}

export function registerFleetFetcher(fetcher: FleetFetcher): void {
  fleetFetcher = fetcher;
}

export function recordFleetSnapshot(snapshot: LiveFleetSnapshot): LiveFleetSnapshot {
  const signature = computeFleetSignature(snapshot);
  const changed = !latestFleet || latestFleet.signature !== signature;
  latestFleet = { at: Date.now(), snapshot, signature };
  if (changed) {
    emitRuntimeEvent("fleet:updated", { snapshot, signature });
  }
  return snapshot;
}

export function getLatestFleetSnapshot(maxAgeMs = 12_000): LiveFleetSnapshot | null {
  if (!latestFleet) return null;
  if (Date.now() - latestFleet.at > maxAgeMs) return null;
  return latestFleet.snapshot;
}

function desiredPollIntervalMs(): number | null {
  if (typeof document !== "undefined" && document.hidden) return null;
  if (fleetDemands.size === 0) return null;
  let anyFast = false;
  let anyActive = false;
  for (const demand of fleetDemands.values()) {
    if (demand.fast) anyFast = true;
    if (demand.active) anyActive = true;
  }
  if (anyFast) return 2_500;
  if (anyActive) return 4_000;
  // Eco heartbeat when all live layers & transit panels are hidden
  return 20_000;
}

function clearFleetTimer(): void {
  if (fleetTimer !== null) {
    clearTimeout(fleetTimer);
    fleetTimer = null;
  }
}

function scheduleNextFleetPoll(): void {
  clearFleetTimer();
  const delay = desiredPollIntervalMs();
  if (delay === null || !fleetFetcher) return;
  fleetTimer = setTimeout(() => {
    void triggerFleetRefresh(false);
  }, delay);
}

export async function triggerFleetRefresh(force = false): Promise<LiveFleetSnapshot | null> {
  if (!fleetFetcher) return latestFleet?.snapshot ?? null;
  if (!fleetLoading) {
    fleetLoading = true;
    emitRuntimeEvent("fleet:loading", true);
  }
  try {
    const data = await fleetFetcher(force);
    return recordFleetSnapshot(data);
  } catch {
    return latestFleet?.snapshot ?? null;
  } finally {
    if (fleetLoading) {
      fleetLoading = false;
      emitRuntimeEvent("fleet:loading", false);
    }
    scheduleNextFleetPoll();
  }
}

function ensureFleetVisibilityListener(): void {
  if (fleetVisibilityAttached || typeof document === "undefined") return;
  fleetVisibilityAttached = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearFleetTimer();
    } else if (fleetDemands.size > 0) {
      void triggerFleetRefresh(true);
    }
  });
}

/**
 * Registers or updates a UI consumer's live-bus demand and returns an unsubscribe cleanup.
 */
export function setFleetDemand(consumerId: string, demand: FleetDemand): () => void {
  ensureFleetVisibilityListener();
  const prevInterval = desiredPollIntervalMs();
  fleetDemands.set(consumerId, demand);
  const nextInterval = desiredPollIntervalMs();

  if (!latestFleet) {
    void triggerFleetRefresh(false);
  } else if (nextInterval !== null && (prevInterval === null || nextInterval < prevInterval)) {
    const elapsed = Date.now() - latestFleet.at;
    if (elapsed >= nextInterval) {
      void triggerFleetRefresh(demand.fast === true);
    } else {
      clearFleetTimer();
      fleetTimer = setTimeout(() => {
        void triggerFleetRefresh(false);
      }, Math.max(150, nextInterval - elapsed));
    }
  }

  return () => {
    fleetDemands.delete(consumerId);
    if (fleetDemands.size === 0) clearFleetTimer();
    else scheduleNextFleetPoll();
  };
}
