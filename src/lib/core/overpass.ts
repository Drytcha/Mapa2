/**
 * Unified Overpass API client with:
 * - Single shared mirror list
 * - Global Overpass rate-gate (`withOverpassSlot`)
 * - In-flight query deduplication (`runDeduped`)
 * - Optional in-memory + IndexedDB TTL caching
 */

import { idbGetKv, idbSetKv } from "@/lib/engine/storage";
import { withOverpassSlot } from "@/lib/requests";
import { OVERPASS_URL } from "@/lib/services";
import { LruTtlCache, runDeduped } from "./runtimeHub";

export const OVERPASS_ENDPOINTS = [
  OVERPASS_URL,
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
].filter((url, index, list) => list.indexOf(url) === index);

const memoryQueryCache = new LruTtlCache<string, unknown[]>(64, 30 * 60_000);

export interface OverpassQueryOptions {
  signal?: AbortSignal;
  /** Per-mirror HTTP timeout in milliseconds (default 12_000). */
  timeoutMs?: number;
  /** Optional persistent IndexedDB cache key. */
  cacheKey?: string;
  /** Persistent cache TTL in milliseconds (default 7 days). */
  cacheTtlMs?: number;
  /** Bypass cached entries when forcing a live refresh. */
  force?: boolean;
  /** Throw when all mirrors fail instead of returning `null`. */
  throwOnFailure?: boolean;
}

interface PersistedOverpassCache<T> {
  fetchedAt: number;
  elements: T[];
}

async function postSingleMirror<T>(
  url: string,
  query: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T[] | null> {
  return withOverpassSlot(async () => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { elements?: T[]; remark?: string };
      if (json.remark || !Array.isArray(json.elements)) return null;
      return json.elements;
    } catch (error) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }, signal);
}

export async function queryOverpass<T = unknown>(
  query: string,
  options: OverpassQueryOptions = {}
): Promise<{ elements: T[] | null; fromCache: boolean }> {
  const {
    signal,
    timeoutMs = 12_000,
    cacheKey,
    cacheTtlMs = 7 * 24 * 3600_000,
    force = false,
    throwOnFailure = false,
  } = options;

  const dedupKey = cacheKey || `overpass:${query}`;

  if (!force) {
    const mem = memoryQueryCache.get(dedupKey) as T[] | undefined;
    if (mem) return { elements: mem, fromCache: true };

    if (cacheKey) {
      const cached = await idbGetKv<PersistedOverpassCache<T>>(cacheKey);
      if (
        cached &&
        Array.isArray(cached.elements) &&
        Date.now() - cached.fetchedAt < cacheTtlMs
      ) {
        memoryQueryCache.set(dedupKey, cached.elements);
        return { elements: cached.elements, fromCache: true };
      }
    }
  }

  const execute = async (): Promise<T[] | null> => {
    let lastError: unknown = null;
    for (let idx = 0; idx < OVERPASS_ENDPOINTS.length; idx += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        const result = await postSingleMirror<T>(
          OVERPASS_ENDPOINTS[idx],
          query,
          idx === 0 ? timeoutMs : Math.max(6_000, Math.round(timeoutMs * 0.8)),
          signal
        );
        if (result) {
          memoryQueryCache.set(dedupKey, result);
          if (cacheKey) {
            void idbSetKv<PersistedOverpassCache<T>>(cacheKey, {
              fetchedAt: Date.now(),
              elements: result,
            });
          }
          return result;
        }
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          throw error;
        }
        lastError = error;
      }
    }
    if (throwOnFailure) {
      throw lastError instanceof Error
        ? lastError
        : new Error("Nie udało się pobrać danych z OpenStreetMap.");
    }
    return null;
  };

  const elements = signal ? await execute() : await runDeduped(dedupKey, execute);
  return { elements, fromCache: false };
}
