/**
 * Shared persistence & resolution layer for Planner-edited bus line routes.
 *
 * Visibility for everyone ("widoczność u wszystkich") works across all environments:
 *  1. Bundled `src/data/line-route-overrides.json` is baked into every build (offline-ready).
 *  2. On load, every user (traveler & planner) refreshes the latest published JSON from
 *     either the local dev API (`/api/line-route-overrides`) or the public repository file
 *     on GitHub (`Drytcha/Mapa2` `main/src/data/line-route-overrides.json`), cached in IndexedDB.
 *  3. Planner edits save immediately to IndexedDB (and auto-write to disk when running on the
 *     dev server), and can be published globally to GitHub with one click (fine-grained PAT) or
 *     exported/imported as `line-route-overrides.json`.
 */

import bundledFileRaw from "@/data/line-route-overrides.json";
import { emitRuntimeEvent, runDeduped } from "../core/runtimeHub";
import { foldStopKey } from "../core/text";
import { isValidLatLng, sanitizePath, type LatLng } from "../routeEditorGeometry";
import { idbGetKv, idbSetKv } from "./storage";

export const DEFAULT_GITHUB_OWNER = "Drytcha";
export const DEFAULT_GITHUB_REPO = "Mapa2";
export const DEFAULT_GITHUB_BRANCH = "main";
export const DEFAULT_OVERRIDES_REPO_PATH = "src/data/line-route-overrides.json";

const LOCAL_DIFF_KV_KEY = "line_route_overrides_local_diff_v1";
const REMOTE_CACHE_KV_KEY = "line_route_overrides_remote_cache_v1";
const GITHUB_CONFIG_STORAGE_KEY = "mapplaner.githubPublish.v1";
const DEV_API_ENDPOINT = "/api/line-route-overrides";

export interface LineRouteOverride {
  lineShort: string;
  variantKey: string;
  directionId: number;
  firstStopId?: string;
  firstStopName: string;
  lastStopId?: string;
  lastStopName: string;
  path: LatLng[];
  note?: string;
  updatedAt: string;
}

export interface LineRouteOverridesFile {
  version: 1;
  updatedAt: string;
  overrides: Record<string, LineRouteOverride>;
}

interface LocalDiffState {
  /** Locally saved overrides not yet published to the shared file (or matching it). */
  saved: Record<string, LineRouteOverride>;
  /** Keys explicitly reverted to GTFS locally, awaiting publication. */
  deleted: string[];
}

interface RemoteCacheRecord {
  fetchedAt: number;
  source: "dev-api" | "github-raw" | "github-api" | "custom";
  file: LineRouteOverridesFile;
}

export type OverrideSyncStatus =
  | "none"
  | "published"
  | "local-modified"
  | "local-deleted";

export interface GitHubPublishConfig {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  token: string;
}

export interface PublishResult {
  mode: "dev-api" | "github";
  commitUrl?: string;
  publishedCount: number;
  updatedAt: string;
}

export interface LineRouteOverridesSummary {
  revision: number;
  totalActive: number;
  publishedCount: number;
  pendingLocalCount: number;
  pendingDeleteCount: number;
  devApiAvailable: boolean;
  remoteSource: "bundled" | "dev-api" | "github-raw" | "github-api" | "custom";
  remoteUpdatedAt: string | null;
  lastRemoteFetchAt: number | null;
}

export function normalizeLineShort(lineShort: string): string {
  return lineShort.trim().toUpperCase();
}

export function makeOverrideKey(lineShort: string, variantKey: string): string {
  return `${normalizeLineShort(lineShort)}::${variantKey.trim()}`;
}

export function sanitizeOverrideEntry(raw: unknown): LineRouteOverride | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const lineShort =
    typeof obj.lineShort === "string" ? normalizeLineShort(obj.lineShort) : "";
  const variantKey =
    typeof obj.variantKey === "string" ? obj.variantKey.trim() : "";
  if (!lineShort || !variantKey) return null;

  const rawPath = Array.isArray(obj.path) ? obj.path : [];
  const validPairs = rawPath.filter(isValidLatLng);
  const path = sanitizePath(validPairs);
  if (path.length < 2) return null;

  const directionId =
    typeof obj.directionId === "number" && Number.isFinite(obj.directionId)
      ? Math.trunc(obj.directionId)
      : 0;

  return {
    lineShort,
    variantKey,
    directionId,
    firstStopId:
      typeof obj.firstStopId === "string" && obj.firstStopId.trim()
        ? obj.firstStopId.trim()
        : undefined,
    firstStopName:
      typeof obj.firstStopName === "string" ? obj.firstStopName.trim() : "",
    lastStopId:
      typeof obj.lastStopId === "string" && obj.lastStopId.trim()
        ? obj.lastStopId.trim()
        : undefined,
    lastStopName:
      typeof obj.lastStopName === "string" ? obj.lastStopName.trim() : "",
    path,
    note:
      typeof obj.note === "string" && obj.note.trim()
        ? obj.note.trim().slice(0, 240)
        : undefined,
    updatedAt:
      typeof obj.updatedAt === "string" && obj.updatedAt.trim()
        ? obj.updatedAt.trim()
        : new Date().toISOString(),
  };
}

export function parseOverridesFile(raw: unknown): LineRouteOverridesFile | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const rawMap = obj.overrides;
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) return null;

  const overrides: Record<string, LineRouteOverride> = {};
  for (const [k, value] of Object.entries(rawMap as Record<string, unknown>)) {
    const clean = sanitizeOverrideEntry(value);
    if (!clean) continue;
    const key = makeOverrideKey(clean.lineShort, clean.variantKey);
    overrides[key || k] = clean;
  }

  return {
    version: 1,
    updatedAt:
      typeof obj.updatedAt === "string" && obj.updatedAt.trim()
        ? obj.updatedAt.trim()
        : new Date(0).toISOString(),
    overrides,
  };
}

function emptyFile(): LineRouteOverridesFile {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    overrides: {},
  };
}

const bundledFile: LineRouteOverridesFile =
  parseOverridesFile(bundledFileRaw) ?? emptyFile();

let remoteFile: LineRouteOverridesFile | null = null;
let remoteSource: LineRouteOverridesSummary["remoteSource"] = "bundled";
let lastRemoteFetchAt: number | null = null;
let devApiAvailable = false;
let localDiff: LocalDiffState = { saved: {}, deleted: [] };
let mergedMap = new Map<string, LineRouteOverride>();
let revision = 0;
let initialized = false;

function basePublishedMap(): Map<string, LineRouteOverride> {
  const out = new Map<string, LineRouteOverride>();
  const source =
    remoteFile &&
    (Date.parse(remoteFile.updatedAt) >= Date.parse(bundledFile.updatedAt) ||
      Object.keys(remoteFile.overrides).length > 0)
      ? remoteFile
      : bundledFile;
  for (const [key, value] of Object.entries(source.overrides)) {
    out.set(key, value);
  }
  return out;
}

function rebuildMerged(emit = true): void {
  const next = basePublishedMap();
  const deletedSet = new Set(localDiff.deleted);
  for (const key of deletedSet) {
    next.delete(key);
  }
  for (const [key, value] of Object.entries(localDiff.saved)) {
    next.set(key, value);
  }
  mergedMap = next;
  revision += 1;
  if (emit) {
    emitRuntimeEvent("routes:overrides-updated", { revision });
  }
}

// Initialize bundled overrides synchronously at module load.
rebuildMerged(false);

export function getOverridesRevision(): number {
  return revision;
}

export function getLineRouteOverride(
  lineShort: string,
  variantKey: string,
): LineRouteOverride | null {
  return mergedMap.get(makeOverrideKey(lineShort, variantKey)) ?? null;
}

export function listLineRouteOverrides(): LineRouteOverride[] {
  return [...mergedMap.values()].sort(
    (a, b) =>
      a.lineShort.localeCompare(b.lineShort, "pl", { numeric: true }) ||
      a.directionId - b.directionId ||
      a.lastStopName.localeCompare(b.lastStopName, "pl"),
  );
}

export function getOverrideStatus(
  lineShort: string,
  variantKey: string,
): OverrideSyncStatus {
  const key = makeOverrideKey(lineShort, variantKey);
  if (localDiff.saved[key]) return "local-modified";
  if (localDiff.deleted.includes(key)) return "local-deleted";
  const published = basePublishedMap();
  if (published.has(key)) return "published";
  return "none";
}

export function getOverridesSummary(): LineRouteOverridesSummary {
  const published = basePublishedMap();
  const pendingDeleteCount = localDiff.deleted.filter((key) =>
    published.has(key),
  ).length;
  return {
    revision,
    totalActive: mergedMap.size,
    publishedCount: published.size,
    pendingLocalCount: Object.keys(localDiff.saved).length,
    pendingDeleteCount,
    devApiAvailable,
    remoteSource,
    remoteUpdatedAt: (remoteFile ?? bundledFile).updatedAt || null,
    lastRemoteFetchAt,
  };
}

/**
 * Resolves the best matching saved route override for a GTFS trip or variant.
 * Matches in priority order:
 *  1. Exact `(lineShort, shapeId)` key
 *  2. Exact `(lineShort, firstStopId>lastStopId)` key
 *  3. Semantic fallback `(lineShort, directionId, firstStop, lastStop)` so edits
 *     remain active even after Wałbrzych publishes a new GTFS feed with new shape_ids.
 */
export function findLineRouteOverride(params: {
  lineShort: string;
  shapeId?: string | null;
  firstStopId?: string | null;
  lastStopId?: string | null;
  firstStopName?: string | null;
  lastStopName?: string | null;
  directionId?: number;
}): { override: LineRouteOverride; exactVariantMatch: boolean } | null {
  if (mergedMap.size === 0) return null;
  const line = normalizeLineShort(params.lineShort);
  if (!line) return null;

  if (params.shapeId) {
    const byShape = mergedMap.get(makeOverrideKey(line, params.shapeId));
    if (byShape) {
      const sameFirst =
        !byShape.firstStopId ||
        !params.firstStopId ||
        byShape.firstStopId === params.firstStopId;
      const sameLast =
        !byShape.lastStopId ||
        !params.lastStopId ||
        byShape.lastStopId === params.lastStopId;
      return { override: byShape, exactVariantMatch: sameFirst && sameLast };
    }
  }

  if (params.firstStopId && params.lastStopId) {
    const stopPairKey = `${params.firstStopId}>${params.lastStopId}`;
    const byPair = mergedMap.get(makeOverrideKey(line, stopPairKey));
    if (byPair) {
      return { override: byPair, exactVariantMatch: true };
    }
  }

  const wantedFirstName = params.firstStopName
    ? foldStopKey(params.firstStopName)
    : "";
  const wantedLastName = params.lastStopName
    ? foldStopKey(params.lastStopName)
    : "";

  for (const override of mergedMap.values()) {
    if (override.lineShort !== line) continue;
    if (
      params.directionId !== undefined &&
      override.directionId !== params.directionId
    ) {
      continue;
    }
    if (
      params.firstStopId &&
      params.lastStopId &&
      override.firstStopId === params.firstStopId &&
      override.lastStopId === params.lastStopId
    ) {
      return { override, exactVariantMatch: true };
    }
    if (
      wantedFirstName &&
      wantedLastName &&
      override.firstStopName &&
      override.lastStopName &&
      foldStopKey(override.firstStopName) === wantedFirstName &&
      foldStopKey(override.lastStopName) === wantedLastName
    ) {
      return { override, exactVariantMatch: true };
    }
  }

  return null;
}

async function persistLocalDiff(): Promise<void> {
  await idbSetKv(LOCAL_DIFF_KV_KEY, localDiff);
}

function buildEffectiveFile(): LineRouteOverridesFile {
  const overrides: Record<string, LineRouteOverride> = {};
  for (const [key, value] of mergedMap.entries()) {
    overrides[key] = value;
  }
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    overrides,
  };
}

function customRemoteUrl(): string | null {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const url = env?.VITE_ROUTE_OVERRIDES_URL?.trim();
    return url || null;
  } catch {
    return null;
  }
}

function githubRawUrl(cfg: Pick<GitHubPublishConfig, "owner" | "repo" | "branch" | "path">): string {
  return `https://raw.githubusercontent.com/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/${encodeURIComponent(cfg.branch)}/${cfg.path}?t=${Date.now()}`;
}

function githubApiContentsUrl(
  cfg: Pick<GitHubPublishConfig, "owner" | "repo" | "branch" | "path">,
  includeRef = true,
): string {
  const base = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${cfg.path}`;
  return includeRef ? `${base}?ref=${encodeURIComponent(cfg.branch)}` : base;
}

export function githubWebEditUrl(
  cfg: Pick<GitHubPublishConfig, "owner" | "repo" | "branch" | "path"> = loadGitHubPublishConfig(),
): string {
  return `https://github.com/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/edit/${encodeURIComponent(cfg.branch)}/${cfg.path}`;
}

function decodeBase64Utf8(b64: string): string {
  const clean = b64.replace(/\s+/g, "");
  if (typeof Buffer !== "undefined") {
    return Buffer.from(clean, "base64").toString("utf8");
  }
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(text: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(text, "utf8").toString("base64");
  }
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function fetchJsonWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 7_000,
): Promise<{ ok: boolean; status: number; json: unknown | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    if (!res.ok) return { ok: false, status: res.status, json: null };
    const ct = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (!text.trim().startsWith("{") && !ct.includes("json")) {
      return { ok: false, status: res.status, json: null };
    }
    return { ok: true, status: res.status, json: JSON.parse(text) };
  } catch {
    return { ok: false, status: 0, json: null };
  } finally {
    clearTimeout(timer);
  }
}

async function tryWriteDevApi(file: LineRouteOverridesFile): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const res = await fetch(DEV_API_ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(file, null, 2),
    });
    if (res.ok) {
      devApiAvailable = true;
      return true;
    }
  } catch {
    /* Static build or offline — fall through cleanly. */
  }
  return false;
}

/**
 * Loads local IndexedDB edits + cached remote overrides, then refreshes the latest
 * shared overrides file in the background so every user sees published route edits.
 */
export async function initLineRouteOverrides(): Promise<void> {
  if (initialized) return;
  initialized = true;

  await runDeduped("lineRouteOverrides:init", async () => {
    const [storedLocal, storedRemote] = await Promise.all([
      idbGetKv<LocalDiffState>(LOCAL_DIFF_KV_KEY),
      idbGetKv<RemoteCacheRecord>(REMOTE_CACHE_KV_KEY),
    ]);

    if (storedLocal && typeof storedLocal === "object") {
      const cleanSaved: Record<string, LineRouteOverride> = {};
      for (const [k, raw] of Object.entries(storedLocal.saved ?? {})) {
        const clean = sanitizeOverrideEntry(raw);
        if (clean) cleanSaved[makeOverrideKey(clean.lineShort, clean.variantKey) || k] = clean;
      }
      localDiff = {
        saved: cleanSaved,
        deleted: Array.isArray(storedLocal.deleted)
          ? storedLocal.deleted.filter((k): k is string => typeof k === "string")
          : [],
      };
    }

    if (storedRemote?.file) {
      const parsed = parseOverridesFile(storedRemote.file);
      if (parsed) {
        remoteFile = parsed;
        remoteSource = storedRemote.source;
        lastRemoteFetchAt = storedRemote.fetchedAt;
      }
    }

    rebuildMerged(true);

    if (typeof window !== "undefined") {
      void refreshRemoteLineRouteOverrides(false);
    }
  });
}

/**
 * Fetches the latest shared `line-route-overrides.json` visible to all users.
 * Priority: local dev API -> custom `VITE_ROUTE_OVERRIDES_URL` -> GitHub raw / API.
 */
export async function refreshRemoteLineRouteOverrides(
  forceFresh = true,
): Promise<{ ok: boolean; source: LineRouteOverridesSummary["remoteSource"]; count: number }> {
  if (typeof window === "undefined") {
    return { ok: false, source: remoteSource, count: mergedMap.size };
  }

  return runDeduped(`lineRouteOverrides:refresh:${forceFresh ? "fresh" : "bg"}`, async () => {
    const cfg = loadGitHubPublishConfig();

    // 1. Local dev server middleware (present during `npm run dev` or custom backend)
    const devRes = await fetchJsonWithTimeout(DEV_API_ENDPOINT, undefined, 2_500);
    if (devRes.ok) {
      const parsed = parseOverridesFile(devRes.json);
      if (parsed) {
        devApiAvailable = true;
        remoteFile = parsed;
        remoteSource = "dev-api";
        lastRemoteFetchAt = Date.now();
        await idbSetKv<RemoteCacheRecord>(REMOTE_CACHE_KV_KEY, {
          fetchedAt: lastRemoteFetchAt,
          source: "dev-api",
          file: parsed,
        });
        rebuildMerged(true);
        return { ok: true, source: "dev-api", count: Object.keys(parsed.overrides).length };
      }
    }

    // 2. Optional custom URL override
    const customUrl = customRemoteUrl();
    if (customUrl) {
      const res = await fetchJsonWithTimeout(customUrl);
      const parsed = res.ok ? parseOverridesFile(res.json) : null;
      if (parsed) {
        remoteFile = parsed;
        remoteSource = "custom";
        lastRemoteFetchAt = Date.now();
        await idbSetKv<RemoteCacheRecord>(REMOTE_CACHE_KV_KEY, {
          fetchedAt: lastRemoteFetchAt,
          source: "custom",
          file: parsed,
        });
        rebuildMerged(true);
        return { ok: true, source: "custom", count: Object.keys(parsed.overrides).length };
      }
    }

    // 3. GitHub API (zero CDN lag when refreshing explicitly or token is configured)
    if (forceFresh || cfg.token) {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
      };
      if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
      const apiRes = await fetchJsonWithTimeout(githubApiContentsUrl(cfg, true), { headers });
      if (apiRes.ok && apiRes.json && typeof apiRes.json === "object") {
        const body = apiRes.json as { content?: string };
        if (typeof body.content === "string") {
          try {
            const parsed = parseOverridesFile(JSON.parse(decodeBase64Utf8(body.content)));
            if (parsed) {
              remoteFile = parsed;
              remoteSource = "github-api";
              lastRemoteFetchAt = Date.now();
              await idbSetKv<RemoteCacheRecord>(REMOTE_CACHE_KV_KEY, {
                fetchedAt: lastRemoteFetchAt,
                source: "github-api",
                file: parsed,
              });
              rebuildMerged(true);
              return {
                ok: true,
                source: "github-api",
                count: Object.keys(parsed.overrides).length,
              };
            }
          } catch {
            /* Fall back to raw.githubusercontent.com */
          }
        }
      }
    }

    // 4. GitHub Raw (public, CORS-enabled, no rate-limit for anonymous visitors)
    const rawRes = await fetchJsonWithTimeout(githubRawUrl(cfg));
    const parsedRaw = rawRes.ok ? parseOverridesFile(rawRes.json) : null;
    if (parsedRaw) {
      remoteFile = parsedRaw;
      remoteSource = "github-raw";
      lastRemoteFetchAt = Date.now();
      await idbSetKv<RemoteCacheRecord>(REMOTE_CACHE_KV_KEY, {
        fetchedAt: lastRemoteFetchAt,
        source: "github-raw",
        file: parsedRaw,
      });
      rebuildMerged(true);
      return {
        ok: true,
        source: "github-raw",
        count: Object.keys(parsedRaw.overrides).length,
      };
    }

    return { ok: false, source: remoteSource, count: mergedMap.size };
  });
}

/**
 * Saves an edited line variant route locally and, if running on the dev server,
 * writes it immediately to `src/data/line-route-overrides.json`.
 */
export async function saveLineRouteOverride(
  input: Omit<LineRouteOverride, "updatedAt"> & { updatedAt?: string },
): Promise<{ override: LineRouteOverride; syncedToDevServer: boolean }> {
  const clean = sanitizeOverrideEntry({
    ...input,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  });
  if (!clean) {
    throw new Error("Trasa musi zawierać co najmniej 2 poprawne punkty.");
  }

  const key = makeOverrideKey(clean.lineShort, clean.variantKey);
  localDiff = {
    saved: { ...localDiff.saved, [key]: clean },
    deleted: localDiff.deleted.filter((item) => item !== key),
  };

  rebuildMerged(true);

  const file = buildEffectiveFile();
  const syncedToDevServer = await tryWriteDevApi(file);
  if (syncedToDevServer) {
    remoteFile = file;
    remoteSource = "dev-api";
    lastRemoteFetchAt = Date.now();
    localDiff = { saved: {}, deleted: [] };
    await idbSetKv<RemoteCacheRecord>(REMOTE_CACHE_KV_KEY, {
      fetchedAt: lastRemoteFetchAt,
      source: "dev-api",
      file,
    });
    rebuildMerged(true);
  }

  await persistLocalDiff();
  return { override: clean, syncedToDevServer };
}

/**
 * Reverts a single variant back to original GTFS geometry.
 */
export async function deleteLineRouteOverride(
  lineShort: string,
  variantKey: string,
): Promise<{ syncedToDevServer: boolean }> {
  const key = makeOverrideKey(lineShort, variantKey);
  const nextSaved = { ...localDiff.saved };
  delete nextSaved[key];
  const published = basePublishedMap();
  const nextDeleted = published.has(key)
    ? [...new Set([...localDiff.deleted, key])]
    : localDiff.deleted.filter((item) => item !== key);

  localDiff = { saved: nextSaved, deleted: nextDeleted };
  rebuildMerged(true);

  const file = buildEffectiveFile();
  const syncedToDevServer = await tryWriteDevApi(file);
  if (syncedToDevServer) {
    remoteFile = file;
    remoteSource = "dev-api";
    lastRemoteFetchAt = Date.now();
    localDiff = { saved: {}, deleted: [] };
    await idbSetKv<RemoteCacheRecord>(REMOTE_CACHE_KV_KEY, {
      fetchedAt: lastRemoteFetchAt,
      source: "dev-api",
      file,
    });
    rebuildMerged(true);
  }

  await persistLocalDiff();
  return { syncedToDevServer };
}

/**
 * Publishes all active route overrides directly to `src/data/line-route-overrides.json`
 * in GitHub (`Drytcha/Mapa2`), making them immediately visible for all users.
 */
export async function publishLineRouteOverridesToGitHub(
  config: GitHubPublishConfig,
  commitMessage?: string,
): Promise<PublishResult> {
  const owner = config.owner.trim() || DEFAULT_GITHUB_OWNER;
  const repo = config.repo.trim() || DEFAULT_GITHUB_REPO;
  const branch = config.branch.trim() || DEFAULT_GITHUB_BRANCH;
  const path = config.path.trim() || DEFAULT_OVERRIDES_REPO_PATH;
  const token = config.token.trim();

  if (!token) {
    throw new Error("Podaj token GitHub (Fine-grained PAT z dostępem Contents: Read and write).");
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // 1. Fetch current remote SHA and remote overrides to merge cleanly without clobbering.
  const getUrl = githubApiContentsUrl({ owner, repo, branch, path }, true);
  let sha: string | undefined;
  let remoteOverrides: Record<string, LineRouteOverride> = {};

  const getRes = await fetch(getUrl, { headers, cache: "no-store" });
  if (getRes.ok) {
    const data = (await getRes.json()) as { sha?: string; content?: string };
    sha = data.sha;
    if (typeof data.content === "string") {
      try {
        const parsed = parseOverridesFile(JSON.parse(decodeBase64Utf8(data.content)));
        if (parsed) remoteOverrides = { ...parsed.overrides };
      } catch {
        /* If remote JSON was malformed, overwrite cleanly with valid structure. */
      }
    }
  } else if (getRes.status !== 404) {
    const errText = await getRes.text().catch(() => "");
    if (getRes.status === 401 || getRes.status === 403) {
      throw new Error(
        "Brak uprawnień GitHub (401/403). Sprawdź, czy token ma uprawnienie „Contents: Read and write” dla tego repozytorium.",
      );
    }
    throw new Error(`Nie udało się odczytać pliku z GitHub (HTTP ${getRes.status}): ${errText.slice(0, 140)}`);
  }

  // 2. Apply current local changes/deletions on top of latest remote state.
  const mergedOverrides: Record<string, LineRouteOverride> = { ...remoteOverrides };
  for (const deletedKey of localDiff.deleted) {
    delete mergedOverrides[deletedKey];
  }
  for (const [key, value] of Object.entries(localDiff.saved)) {
    mergedOverrides[key] = value;
  }
  // Ensure anything currently active in mergedMap (e.g. imported JSON) is also included.
  for (const [key, value] of mergedMap.entries()) {
    mergedOverrides[key] = value;
  }

  const nextFile: LineRouteOverridesFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    overrides: mergedOverrides,
  };

  const jsonBody = `${JSON.stringify(nextFile, null, 2)}\n`;
  const linesTouched = [
    ...new Set([
      ...Object.values(localDiff.saved).map((o) => o.lineShort),
      ...localDiff.deleted.map((k) => k.split("::")[0]),
    ]),
  ].sort();

  const message =
    commitMessage?.trim() ||
    (linesTouched.length
      ? `chore(routes): aktualizacja przebiegu linii ${linesTouched.join(", ")} (Planista)`
      : "chore(routes): aktualizacja przebiegu tras linii (Planista)");

  // 3. Commit updated JSON file to GitHub.
  const putUrl = githubApiContentsUrl({ owner, repo, branch, path }, false);
  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message,
      content: encodeBase64Utf8(jsonBody),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!putRes.ok) {
    const errData = (await putRes.json().catch(() => null)) as { message?: string } | null;
    if (putRes.status === 401 || putRes.status === 403) {
      throw new Error(
        "Token GitHub nie ma prawa zapisu (Contents: Read and write) dla repozytorium " +
          `${owner}/${repo}.`,
      );
    }
    if (putRes.status === 409) {
      throw new Error("Konflikt wersji pliku na GitHub. Spróbuj ponownie za chwilę.");
    }
    throw new Error(
      `Publikacja na GitHub nie powiodła się (HTTP ${putRes.status})${errData?.message ? `: ${errData.message}` : ""}.`,
    );
  }

  const putJson = (await putRes.json()) as { commit?: { html_url?: string } };

  remoteFile = nextFile;
  remoteSource = "github-api";
  lastRemoteFetchAt = Date.now();
  localDiff = { saved: {}, deleted: [] };

  await Promise.all([
    persistLocalDiff(),
    idbSetKv<RemoteCacheRecord>(REMOTE_CACHE_KV_KEY, {
      fetchedAt: lastRemoteFetchAt,
      source: "github-api",
      file: nextFile,
    }),
  ]);
  rebuildMerged(true);

  return {
    mode: "github",
    commitUrl: putJson.commit?.html_url,
    publishedCount: Object.keys(nextFile.overrides).length,
    updatedAt: nextFile.updatedAt,
  };
}

export function exportLineRouteOverridesJson(): string {
  return `${JSON.stringify(buildEffectiveFile(), null, 2)}\n`;
}

export async function importLineRouteOverridesJson(
  rawJsonText: string,
): Promise<{ importedCount: number; syncedToDevServer: boolean }> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawJsonText);
  } catch {
    throw new Error("Plik nie jest poprawnym dokumentem JSON.");
  }

  const parsed = parseOverridesFile(parsedJson);
  if (!parsed) {
    throw new Error("Nieprawidłowy format pliku line-route-overrides.json.");
  }

  const entries = Object.entries(parsed.overrides);
  const nextSaved = { ...localDiff.saved };
  const importedKeys = new Set<string>();
  for (const [key, value] of entries) {
    nextSaved[key] = value;
    importedKeys.add(key);
  }

  localDiff = {
    saved: nextSaved,
    deleted: localDiff.deleted.filter((key) => !importedKeys.has(key)),
  };
  rebuildMerged(true);

  const file = buildEffectiveFile();
  const syncedToDevServer = await tryWriteDevApi(file);
  if (syncedToDevServer) {
    remoteFile = file;
    remoteSource = "dev-api";
    lastRemoteFetchAt = Date.now();
    localDiff = { saved: {}, deleted: [] };
    await idbSetKv<RemoteCacheRecord>(REMOTE_CACHE_KV_KEY, {
      fetchedAt: lastRemoteFetchAt,
      source: "dev-api",
      file,
    });
    rebuildMerged(true);
  }

  await persistLocalDiff();
  return { importedCount: entries.length, syncedToDevServer };
}

export function loadGitHubPublishConfig(): GitHubPublishConfig {
  const defaults: GitHubPublishConfig = {
    owner: DEFAULT_GITHUB_OWNER,
    repo: DEFAULT_GITHUB_REPO,
    branch: DEFAULT_GITHUB_BRANCH,
    path: DEFAULT_OVERRIDES_REPO_PATH,
    token: "",
  };
  if (typeof localStorage === "undefined") return defaults;
  try {
    const raw = localStorage.getItem(GITHUB_CONFIG_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<GitHubPublishConfig>;
    return {
      owner: parsed.owner?.trim() || defaults.owner,
      repo: parsed.repo?.trim() || defaults.repo,
      branch: parsed.branch?.trim() || defaults.branch,
      path: parsed.path?.trim() || defaults.path,
      token: parsed.token?.trim() || "",
    };
  } catch {
    return defaults;
  }
}

export function saveGitHubPublishConfig(config: GitHubPublishConfig): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      GITHUB_CONFIG_STORAGE_KEY,
      JSON.stringify({
        owner: config.owner.trim() || DEFAULT_GITHUB_OWNER,
        repo: config.repo.trim() || DEFAULT_GITHUB_REPO,
        branch: config.branch.trim() || DEFAULT_GITHUB_BRANCH,
        path: config.path.trim() || DEFAULT_OVERRIDES_REPO_PATH,
        token: config.token.trim(),
      }),
    );
  } catch {
    /* Optional storage */
  }
}

export function clearGitHubPublishToken(): void {
  const cfg = loadGitHubPublishConfig();
  saveGitHubPublishConfig({ ...cfg, token: "" });
}

/** Test-only reset helper so unit tests start from a clean override state. */
export function resetLineRouteOverridesForTests(): void {
  remoteFile = null;
  remoteSource = "bundled";
  lastRemoteFetchAt = null;
  devApiAvailable = false;
  localDiff = { saved: {}, deleted: [] };
  initialized = false;
  rebuildMerged(false);
}
