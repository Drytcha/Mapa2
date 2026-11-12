/**
 * Przypisywanie brygad (kursówek) do autobusów GPS — Wałbrzych.
 *
 * Brygady są numerowane według linii WŁASNEJ brygady, a nie linii, którą wóz
 * aktualnie obsługuje. Sygnał GPS „linia 19, brygada 01” oznacza brygadę 9/01
 * (wóz z brygady 9-01 jedzie akurat kursem linii 19). Sklejanie „19/01” albo
 * „WY/04” tworzyło brygady, które nie istnieją.
 *
 * Kolejność dowodów (najmocniejszy pierwszy):
 *  1. kurs z GTFS-RT (linia + godzina startu) = kurs w rozkładzie brygady,
 *  2. rozkładowy czas najbliższego przystanku mieści się w kursie brygady,
 *  3. numer z wozu, gdy na tej linii jest tylko jedna taka brygada,
 *  4. przejazdy techniczne (PRZ/WY/ZJ): brygada potwierdzona wcześniej kursem
 *     tego samego wozu albo jedyna wolna brygada z tym numerem w przerwie.
 * Przydział jest globalny: jedna brygada = jeden wóz, jeden wóz = jedna brygada.
 *
 * Rozkład brygad: wbudowane wzorce typów dni (dni robocze, niedziele/święta),
 * wygenerowane z rozkładu operatora i sprawdzone na kilku dniach, a dla innych
 * dni — bieżący rozkład operatora wczytywany w tle. Gdy kursy z GTFS-RT
 * przestają pasować do wzorca (np. po zmianie rozkładu), wzorzec jest
 * odrzucany na rzecz bieżącego rozkładu operatora.
 */

import { DateTime } from "luxon";
import snapshotJson from "@/data/live-duty-snapshot.json";
import type { LiveBusVehicle } from "../types";
import { fetchLiveBlocks } from "./liveBrigades";
import { idbGetKv, idbSetKv } from "./storage";

export const DUTY_VERIFICATION_ZONE = "Europe/Warsaw";

export type DutyStatus = "confirmed" | "unresolved" | "invalid";
export type DutyEvidence = "trip" | "schedule" | "signal" | "memory";

type TimeWindow = [number, number];

interface SnapshotDuty {
  servedLines: string[];
  /** Minutes from the service-day midnight, per line actually driven. */
  windows: Record<string, TimeWindow[]>;
}

interface SnapshotPattern {
  id: string;
  label: string;
  sourceDate: string;
  signature: string;
  dates: string[];
  duties: Record<string, SnapshotDuty>;
}

interface SnapshotFile {
  version: number;
  generatedAt: string;
  zone: string;
  feed: { from: string; to: string };
  routes: string[];
  patterns: SnapshotPattern[];
}

const SNAPSHOT = snapshotJson as unknown as SnapshotFile;

/** Linie z rozkładu Wałbrzycha. Tylko one mogą być prefiksem numeru brygady. */
export const KNOWN_OPERATIONAL_LINES: ReadonlySet<string> = new Set(
  SNAPSHOT.routes.map((line) => line.trim().toUpperCase())
);

/** Przejazdy techniczne (przejazd, wyjazd, zjazd) — to nie są linie. */
const NON_REVENUE_ROUTES: ReadonlySet<string> = new Set([
  "PRZ",
  "WY",
  "ZJ",
  "ZJAZD",
  "WYJAZD",
  "DOJAZD",
  "TECH",
  "TECHN",
  "SERWIS",
  "TEST",
]);

const MINUTE = 60_000;
const EXACT_TRIP_MS = 90_000;
const NEAR_TRIP_MINUTES = 15;
const WINDOW_MARGIN_MS = 5 * MINUTE;
const NEAR_SCHEDULE_MINUTES = 25;
const NETWORK_TTL_MS = 12 * 60 * MINUTE;
const NETWORK_RETRY_MS = 3 * MINUTE;
const MEMORY_MAX_AGE_MS = 4 * 60 * MINUTE;
const GAP_MAX_MINUTES = 75;
const MEMORY_STORAGE_KEY = "mapplaner.dutyMemory.v1";
/** Wzorzec jest podejrzany, gdy mniej niż połowa kursów GTFS-RT ma w nim odpowiednik. */
const SNAPSHOT_MIN_EXACT_SHARE = 0.5;
const SNAPSHOT_MIN_SAMPLE = 6;

interface DutyEntry {
  /** Rozkładowy identyfikator, np. "9-01". */
  code: string;
  /** Wyświetlany kod, np. "9/01". */
  display: string;
  line: string;
  suffix: string;
  servedLines: Set<string>;
  /** Kursy według linii (absolutne ms); puste, gdy znamy tylko wszystkie kursy. */
  windowsByLine: Map<string, TimeWindow[]>;
  allWindows: TimeWindow[];
}

interface DayRoster {
  dateId: string;
  source: "snapshot" | "network";
  label: string;
  duties: DutyEntry[];
}

export interface DutyResolution {
  status: DutyStatus;
  code: string | null;
  dutyLine: string | null;
  evidence: DutyEvidence | "none";
  tripStartMs: number | null;
  reason: string;
}

/* -------------------------------------------------------------------------- */
/*  Codes                                                                     */
/* -------------------------------------------------------------------------- */

export function localDutyDateId(ms: number = Date.now()): string {
  return DateTime.fromMillis(ms, { zone: DUTY_VERIFICATION_ZONE }).toFormat("yyyyLLdd");
}

function serviceMidnight(dateId: string): number | null {
  const day = DateTime.fromFormat(dateId, "yyyyLLdd", { zone: DUTY_VERIFICATION_ZONE });
  return day.isValid ? day.startOf("day").toMillis() : null;
}

function clock(ms: number): string {
  return DateTime.fromMillis(ms, { zone: DUTY_VERIFICATION_ZONE }).toFormat("HH:mm");
}

/**
 * Sam numer z sygnału operatora ("01", "1", "8/01" → "01"). Prefiks z sygnału
 * nigdy nie trafia do wyświetlanego kodu bez dopasowania do rozkładu.
 */
export function observedBrigadeSuffix(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const clean = String(raw).trim().toUpperCase().replace(/\s+/g, "");
  if (!clean) return null;
  const prefixed = clean.match(/^[A-Z0-9]+[/:\-](\d{1,3})$/);
  const digits = prefixed?.[1] ?? (/^\d{1,3}$/.test(clean) ? clean : null);
  if (!digits) return null;
  const value = Number(digits);
  if (!Number.isInteger(value) || value < 1 || value > 199) return null;
  return digits.padStart(2, "0");
}

export function blockCodeFromBlock(block: string): string | null {
  const clean = block.trim().toUpperCase().replace(/\s+/g, "");
  const tail = clean.includes("_") ? clean.split("_").at(-1) ?? "" : clean;
  const match = tail.match(/^([A-Z0-9]+)[/:\-](\d{1,3})$/);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}` : null;
}

/** "9-01" → "9/01", o ile prefiks jest prawdziwą linią (nigdy „WY/04”). */
export function dutyCodeFromBlock(
  block: string,
  knownLines: ReadonlySet<string> = KNOWN_OPERATIONAL_LINES
): string | null {
  const code = blockCodeFromBlock(block);
  if (!code) return null;
  const [line, number] = code.split("-");
  return knownLines.has(line) ? `${line}/${number}` : null;
}

function makeEntry(
  rawCode: string,
  servedLines: Iterable<string>,
  windowsByLine: Map<string, TimeWindow[]>,
  allWindows: TimeWindow[]
): DutyEntry | null {
  const code = blockCodeFromBlock(rawCode);
  const display = code ? dutyCodeFromBlock(code) : null;
  if (!code || !display) return null;
  const [line, suffix] = code.split("-");
  return {
    code,
    display,
    line,
    suffix,
    servedLines: new Set([...servedLines].map((entry) => entry.trim().toUpperCase())),
    windowsByLine,
    allWindows: [...allWindows].sort((a, b) => a[0] - b[0]),
  };
}

/* -------------------------------------------------------------------------- */
/*  Day rosters                                                               */
/* -------------------------------------------------------------------------- */

const snapshotRosters = new Map<string, DayRoster | null>();
const suspectSnapshots = new Set<string>();

function snapshotRoster(dateId: string): DayRoster | null {
  if (snapshotRosters.has(dateId)) return snapshotRosters.get(dateId) ?? null;
  const pattern = SNAPSHOT.patterns.find((entry) => entry.dates.includes(dateId));
  const midnight = serviceMidnight(dateId);
  let roster: DayRoster | null = null;
  if (pattern && midnight !== null) {
    const duties: DutyEntry[] = [];
    for (const [code, duty] of Object.entries(pattern.duties)) {
      const byLine = new Map<string, TimeWindow[]>();
      const all: TimeWindow[] = [];
      for (const [line, windows] of Object.entries(duty.windows)) {
        const absolute = windows.map(
          ([start, end]) => [midnight + start * MINUTE, midnight + end * MINUTE] as TimeWindow
        );
        byLine.set(line.toUpperCase(), absolute);
        all.push(...absolute);
      }
      const entry = makeEntry(code, duty.servedLines, byLine, all);
      if (entry) duties.push(entry);
    }
    roster = { dateId, source: "snapshot", label: pattern.label, duties };
  }
  snapshotRosters.set(dateId, roster);
  return roster;
}

interface StoredRoster {
  at: number;
  duties: Array<{ code: string; servedLines: string[]; windows: TimeWindow[] }>;
}

const networkRosters = new Map<string, DayRoster>();
const networkState = new Map<string, { loading: boolean; failedAt?: number }>();

function rosterFromStored(dateId: string, stored: StoredRoster): DayRoster {
  return {
    dateId,
    source: "network",
    label: "Rozkład brygad operatora",
    duties: stored.duties
      .map((duty) => makeEntry(duty.code, duty.servedLines, new Map(), duty.windows))
      .filter((duty): duty is DutyEntry => Boolean(duty)),
  };
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]);
    })
  );
}

async function loadNetworkRoster(dateId: string): Promise<void> {
  const key = `dutyRoster.v2.${dateId}`;
  const stored = await idbGetKv<StoredRoster>(key);
  if (stored?.duties?.length && Date.now() - stored.at < NETWORK_TTL_MS) {
    networkRosters.set(dateId, rosterFromStored(dateId, stored));
    return;
  }
  const served = new Map<string, Set<string>>();
  const windows = new Map<string, TimeWindow[]>();
  await mapLimit([...KNOWN_OPERATIONAL_LINES], 3, async (line) => {
    try {
      for (const block of await fetchLiveBlocks(line, dateId)) {
        const code = blockCodeFromBlock(block.blockId);
        if (!code) continue;
        const set = served.get(code) ?? new Set<string>();
        set.add(line);
        served.set(code, set);
        windows.set(code, block.times.map(([start, end]) => [start, end] as TimeWindow));
      }
    } catch {
      /* Pozostałe linie nadal mogą się wczytać. */
    }
  });
  if (!served.size) throw new Error("Rozkład brygad chwilowo niedostępny.");
  const payload: StoredRoster = {
    at: Date.now(),
    duties: [...served.entries()].map(([code, lines]) => ({
      code,
      servedLines: [...lines],
      windows: windows.get(code) ?? [],
    })),
  };
  networkRosters.set(dateId, rosterFromStored(dateId, payload));
  void idbSetKv(key, payload);
}

/** Wczytuje w tle rozkład brygad dla dni spoza (lub z podejrzanych) wzorców. */
export function ensureDutyRosters(dateIds: string[]): void {
  for (const dateId of new Set(dateIds)) {
    const trustedSnapshot = snapshotRoster(dateId) && !suspectSnapshots.has(dateId);
    if (trustedSnapshot || networkRosters.has(dateId)) continue;
    const state = networkState.get(dateId);
    if (state?.loading) continue;
    if (state?.failedAt && Date.now() - state.failedAt < NETWORK_RETRY_MS) continue;
    networkState.set(dateId, { loading: true });
    loadNetworkRoster(dateId)
      .then(() => networkState.set(dateId, { loading: false }))
      .catch(() => networkState.set(dateId, { loading: false, failedAt: Date.now() }));
  }
}

function rosterFor(dateId: string): DayRoster | null {
  if (suspectSnapshots.has(dateId) && networkRosters.has(dateId)) {
    return networkRosters.get(dateId) ?? null;
  }
  return snapshotRoster(dateId) ?? networkRosters.get(dateId) ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Vehicle memory (jeden wóz jeździ zwykle całą brygadę)                     */
/* -------------------------------------------------------------------------- */

interface MemoryEntry {
  dateId: string;
  code: string;
  at: number;
}

let vehicleMemory: Map<string, MemoryEntry> | null = null;

function memory(): Map<string, MemoryEntry> {
  if (vehicleMemory) return vehicleMemory;
  vehicleMemory = new Map();
  try {
    const raw =
      typeof localStorage !== "undefined" ? localStorage.getItem(MEMORY_STORAGE_KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as Record<string, MemoryEntry>) : {};
    for (const [vehicleId, entry] of Object.entries(parsed)) {
      if (
        entry &&
        typeof entry.code === "string" &&
        typeof entry.dateId === "string" &&
        typeof entry.at === "number"
      ) {
        vehicleMemory.set(vehicleId, entry);
      }
    }
  } catch {
    /* Pamięć jest opcjonalna. */
  }
  return vehicleMemory;
}

function rememberDuties(entries: Array<[string, MemoryEntry]>): void {
  if (!entries.length) return;
  const map = memory();
  let changed = false;
  for (const [vehicleId, entry] of entries) {
    const previous = map.get(vehicleId);
    if (
      !previous ||
      previous.code !== entry.code ||
      previous.dateId !== entry.dateId ||
      entry.at - previous.at > MINUTE
    ) {
      map.set(vehicleId, entry);
      changed = true;
    }
  }
  if (!changed) return;
  const cutoff = Date.now() - 36 * 60 * MINUTE;
  for (const [vehicleId, entry] of map) if (entry.at < cutoff) map.delete(vehicleId);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
    }
  } catch {
    /* Pamięć jest opcjonalna. */
  }
}

function rememberedDuty(vehicleId: string, dateId: string, now: number): string | null {
  const entry = memory().get(vehicleId);
  return entry && entry.dateId === dateId && now - entry.at <= MEMORY_MAX_AGE_MS
    ? entry.code
    : null;
}

/* -------------------------------------------------------------------------- */
/*  Matching                                                                  */
/* -------------------------------------------------------------------------- */

interface Pair {
  bus: LiveBusVehicle;
  duty: DutyEntry;
  score: number;
  evidence: DutyEvidence;
  windowStart: number | null;
  suffixMatch: boolean;
}

function serviceDateFor(bus: LiveBusVehicle, now: number): string {
  if (bus.tripServiceDate && /^\d{8}$/.test(bus.tripServiceDate)) return bus.tripServiceDate;
  const at = DateTime.fromMillis(Number.isFinite(bus.timestamp) ? bus.timestamp : now, {
    zone: DUTY_VERIFICATION_ZONE,
  });
  // Kursy nocne po północy należą jeszcze do poprzedniego dnia rozkładowego.
  return (at.hour < 3 ? at.minus({ days: 1 }) : at).toFormat("yyyyLLdd");
}

function scheduledReference(bus: LiveBusVehicle): number | null {
  const next = bus.upcomingStops?.[0]?.scheduledDeparture;
  if (typeof next === "number" && Number.isFinite(next)) return next;
  if (!Number.isFinite(bus.timestamp)) return null;
  return bus.timestamp - (bus.delaySeconds || 0) * 1000;
}

function currentLine(bus: LiveBusVehicle): string {
  return (bus.tripRouteShort || bus.routeName || "").trim().toUpperCase();
}

function windowsOnLine(duty: DutyEntry, line: string): TimeWindow[] {
  const exact = duty.windowsByLine.get(line);
  if (exact) return exact;
  if (duty.windowsByLine.size) return [];
  return duty.servedLines.has(line) ? duty.allWindows : [];
}

function scorePair(bus: LiveBusVehicle, duty: DutyEntry, remembered: string | null): Pair | null {
  const line = currentLine(bus);
  if (!KNOWN_OPERATIONAL_LINES.has(line) || !duty.servedLines.has(line)) return null;
  const suffix = observedBrigadeSuffix(bus.rawBrigade ?? bus.brigade);
  const suffixMatch = suffix !== null && suffix === duty.suffix;
  const windows = windowsOnLine(duty, line);

  let timeScore: number | null = null;
  let evidence: DutyEvidence = "signal";
  let windowStart: number | null = null;

  if (typeof bus.tripStartMs === "number" && windows.length) {
    let best = Number.POSITIVE_INFINITY;
    let bestStart: number | null = null;
    for (const [start] of windows) {
      const diff = Math.abs(start - bus.tripStartMs);
      if (diff < best) {
        best = diff;
        bestStart = start;
      }
    }
    const minutes = best / MINUTE;
    if (best <= EXACT_TRIP_MS) {
      timeScore = 100;
      evidence = "trip";
      windowStart = bestStart;
    } else if (minutes <= NEAR_TRIP_MINUTES) {
      timeScore = 60 - minutes * 2;
      evidence = "trip";
      windowStart = bestStart;
    }
  }

  if (timeScore === null) {
    const reference = scheduledReference(bus);
    if (reference !== null && windows.length) {
      let best = Number.POSITIVE_INFINITY;
      let bestStart: number | null = null;
      for (const [start, end] of windows) {
        const distance =
          reference < start - WINDOW_MARGIN_MS
            ? start - WINDOW_MARGIN_MS - reference
            : reference > end + WINDOW_MARGIN_MS
              ? reference - end - WINDOW_MARGIN_MS
              : 0;
        if (distance < best) {
          best = distance;
          bestStart = start;
        }
      }
      const minutes = best / MINUTE;
      if (best === 0) {
        timeScore = 40;
        evidence = "schedule";
        windowStart = bestStart;
      } else if (minutes <= NEAR_SCHEDULE_MINUTES) {
        timeScore = 25 - minutes;
        evidence = "schedule";
        windowStart = bestStart;
      }
    }
  }

  const exactTrip = evidence === "trip" && timeScore === 100;
  // Bez zgodnego numeru akceptujemy tylko twardy dowód: identyczny kurs.
  if (!suffixMatch && !exactTrip) return null;

  return {
    bus,
    duty,
    score:
      (timeScore ?? -20) +
      (suffixMatch ? 45 : 0) +
      (duty.line === line ? 5 : 0) +
      (remembered === duty.code ? 8 : 0),
    evidence: timeScore === null ? "signal" : evidence,
    windowStart,
    suffixMatch,
  };
}

/**
 * Druga runda dla wozów bez przydziału: przejazdy techniczne i wozy bez kursu.
 * Pamięć wozu (brygada potwierdzona wcześniej jego kursem) albo — tylko dla
 * PRZ/WY/ZJ — jedyna wolna brygada z tym numerem, która ma teraz przerwę.
 */
function leftoverPair(
  bus: LiveBusVehicle,
  roster: DayRoster,
  taken: Map<string, Pair>,
  dateId: string,
  now: number
): Pair | null {
  const line = currentLine(bus);
  const suffix = observedBrigadeSuffix(bus.rawBrigade ?? bus.brigade);
  const at = Number.isFinite(bus.timestamp) ? bus.timestamp : now;
  const technical = NON_REVENUE_ROUTES.has(line);

  const remembered = rememberedDuty(bus.vehicleId, dateId, now);
  if (remembered) {
    const duty = roster.duties.find((entry) => entry.code === remembered);
    if (
      duty &&
      !taken.has(duty.code) &&
      (suffix === null || suffix === duty.suffix) &&
      (technical || !line || duty.servedLines.has(line))
    ) {
      return { bus, duty, score: 0, evidence: "memory", windowStart: null, suffixMatch: suffix === duty.suffix };
    }
  }

  if (!technical || !suffix) return null;
  const inGap = roster.duties.filter((duty) => {
    if (duty.suffix !== suffix || taken.has(duty.code) || !duty.allWindows.length) return false;
    const onTrip = duty.allWindows.some(
      ([start, end]) => at >= start - 2 * MINUTE && at <= end + 2 * MINUTE
    );
    if (onTrip) return false;
    const nearest = Math.min(
      ...duty.allWindows.map(([start, end]) => Math.min(Math.abs(at - start), Math.abs(at - end)))
    );
    return nearest <= GAP_MAX_MINUTES * MINUTE;
  });
  return inGap.length === 1
    ? { bus, duty: inGap[0], score: 0, evidence: "schedule", windowStart: null, suffixMatch: true }
    : null;
}

function confirmedResolution(pair: Pair, roster: DayRoster): DutyResolution {
  const line = currentLine(pair.bus);
  const { duty } = pair;
  const tripClock =
    typeof pair.bus.tripStartMs === "number" ? clock(pair.bus.tripStartMs) : null;
  const rosterClock = pair.windowStart !== null ? clock(pair.windowStart) : null;
  let reason: string;
  if (pair.evidence === "memory") {
    reason = `${NON_REVENUE_ROUTES.has(line) ? `Przejazd techniczny (${line}). ` : ""}Ten wóz jeździ dziś w brygadzie ${duty.display} — potwierdzone wcześniej jej kursem.`;
  } else if (NON_REVENUE_ROUTES.has(line)) {
    reason = `Przejazd techniczny (${line}) z numerem ${duty.suffix}: jedyna wolna brygada z tym numerem, która ma teraz przerwę między kursami, to ${duty.display}.`;
  } else if (pair.evidence === "trip" && tripClock && rosterClock === tripClock) {
    reason = `Kurs linii ${line} z ${tripClock} należy do brygady ${duty.display}.`;
  } else if (pair.evidence === "trip" && tripClock) {
    reason = `Kurs linii ${line} z ${tripClock} odpowiada kursowi brygady ${duty.display} z ${rosterClock ?? "—"}.`;
  } else if (pair.evidence === "schedule") {
    reason = `Rozkładowy czas kursu linii ${line} i numer z wozu wskazują brygadę ${duty.display}.`;
  } else {
    reason = `Numer z wozu wskazuje jedyną brygadę ${duty.display} kursującą na linii ${line}.`;
  }
  if (!pair.suffixMatch && pair.evidence === "trip") {
    reason += " Numer z wozu był inny — rozstrzygnął kurs.";
  }
  return {
    status: "confirmed",
    code: duty.display,
    dutyLine: duty.line,
    evidence: pair.evidence,
    tripStartMs: pair.windowStart,
    reason: `${reason} Źródło: ${roster.label}.`,
  };
}

function unassignedResolution(
  bus: LiveBusVehicle,
  candidates: Pair[],
  taken: Map<string, Pair>
): DutyResolution {
  const line = currentLine(bus);
  const raw = (bus.rawBrigade ?? bus.brigade ?? "").trim();
  const suffix = observedBrigadeSuffix(raw);
  const base = { code: null, dutyLine: null, evidence: "none" as const, tripStartMs: null };
  if (!line) return { ...base, status: "invalid", reason: "Wóz nie podaje numeru linii." };
  if (NON_REVENUE_ROUTES.has(line)) {
    return {
      ...base,
      status: "unresolved",
      reason: `Przejazd techniczny (${line}) — brygady z numerem ${suffix ?? "—"} nie da się teraz jednoznacznie wskazać.`,
    };
  }
  if (!KNOWN_OPERATIONAL_LINES.has(line)) {
    return {
      ...base,
      status: "unresolved",
      reason: `„${line}” nie występuje w rozkładzie brygad (linia specjalna) — brygady nie przypisujemy.`,
    };
  }
  const blocker = candidates
    .map((pair) => taken.get(pair.duty.code))
    .find((pair) => pair && pair.bus.vehicleId !== bus.vehicleId);
  if (blocker) {
    return {
      ...base,
      status: "unresolved",
      reason: `Brygada ${blocker.duty.display} jest przypisana do wozu #${blocker.bus.vehicleId}, który jedzie jej kursem. Ten wóz najpewniej zjeżdża lub jest w rezerwie.`,
    };
  }
  if (!suffix) {
    return {
      ...base,
      status: "invalid",
      reason: "Wóz nie jest na kursie z rozkładu i nie podaje numeru brygady.",
    };
  }
  return {
    ...base,
    status: "unresolved",
    reason: `Na linii ${line} nie ma w tym dniu brygady z numerem ${suffix}, a kurs wozu nie pasuje do żadnej brygady.`,
  };
}

function withDutyResolution(bus: LiveBusVehicle, resolution: DutyResolution): LiveBusVehicle {
  return {
    ...bus,
    rawBrigade: bus.rawBrigade ?? bus.brigade ?? "",
    dutyCode: resolution.code,
    dutyStatus: resolution.status,
    dutyLine: resolution.dutyLine,
    dutySource: resolution.evidence,
    dutyNote: resolution.reason,
    dutyTripStartMs: resolution.tripStartMs,
    // Pełny kod brygady pokazujemy wyłącznie po przypisaniu z rozkładu.
    kursowka: resolution.status === "confirmed" ? resolution.code ?? "" : "",
  };
}

/** Odrzuca wzorzec dnia, jeśli kursy GTFS-RT przestały mieć w nim odpowiedniki. */
function checkSnapshotHealth(dateId: string, roster: DayRoster, buses: LiveBusVehicle[]): void {
  if (roster.source !== "snapshot" || suspectSnapshots.has(dateId)) return;
  const sample = buses.filter(
    (bus) => typeof bus.tripStartMs === "number" && KNOWN_OPERATIONAL_LINES.has(currentLine(bus))
  );
  if (sample.length < SNAPSHOT_MIN_SAMPLE) return;
  const exact = sample.filter((bus) =>
    roster.duties.some((duty) =>
      windowsOnLine(duty, currentLine(bus)).some(
        ([start]) => Math.abs(start - (bus.tripStartMs as number)) <= EXACT_TRIP_MS
      )
    )
  ).length;
  if (exact / sample.length < SNAPSHOT_MIN_EXACT_SHARE) {
    suspectSnapshots.add(dateId);
    ensureDutyRosters([dateId]);
  }
}

/**
 * Przypisuje brygady całej flocie naraz. Synchroniczne — używa wbudowanych
 * wzorców lub wczytanego wcześniej rozkładu; brakujące dni zwraca w
 * `missingDates`, żeby można je było wczytać w tle.
 */
export function resolveFleetDuties(
  vehicles: LiveBusVehicle[],
  now: number = Date.now()
): { vehicles: LiveBusVehicle[]; missingDates: string[] } {
  const groups = new Map<string, LiveBusVehicle[]>();
  for (const bus of vehicles) {
    const dateId = serviceDateFor(bus, now);
    const list = groups.get(dateId) ?? [];
    list.push(bus);
    groups.set(dateId, list);
  }

  const resolved = new Map<string, LiveBusVehicle>();
  const missingDates: string[] = [];

  for (const [dateId, buses] of groups) {
    const roster = rosterFor(dateId);
    if (!roster) {
      missingDates.push(dateId);
      for (const bus of buses) {
        resolved.set(
          bus.vehicleId,
          withDutyResolution(bus, {
            status: "unresolved",
            code: null,
            dutyLine: null,
            evidence: "none",
            tripStartMs: null,
            reason: "Wczytywanie rozkładu brygad na ten dzień…",
          })
        );
      }
      continue;
    }
    checkSnapshotHealth(dateId, roster, buses);

    const pairs: Pair[] = [];
    const byBus = new Map<string, Pair[]>();
    for (const bus of buses) {
      const remembered = rememberedDuty(bus.vehicleId, dateId, now);
      const list: Pair[] = [];
      for (const duty of roster.duties) {
        const pair = scorePair(bus, duty, remembered);
        if (pair) list.push(pair);
      }
      byBus.set(bus.vehicleId, list);
      pairs.push(...list);
    }
    pairs.sort(
      (a, b) =>
        b.score - a.score ||
        a.duty.code.localeCompare(b.duty.code) ||
        a.bus.vehicleId.localeCompare(b.bus.vehicleId)
    );

    const busTaken = new Map<string, Pair>();
    const dutyTaken = new Map<string, Pair>();
    for (const pair of pairs) {
      if (busTaken.has(pair.bus.vehicleId) || dutyTaken.has(pair.duty.code)) continue;
      busTaken.set(pair.bus.vehicleId, pair);
      dutyTaken.set(pair.duty.code, pair);
    }

    for (const bus of buses) {
      if (busTaken.has(bus.vehicleId)) continue;
      const pair = leftoverPair(bus, roster, dutyTaken, dateId, now);
      if (pair) {
        busTaken.set(bus.vehicleId, pair);
        dutyTaken.set(pair.duty.code, pair);
      }
    }

    rememberDuties(
      [...busTaken.values()]
        .filter((pair) => pair.evidence === "trip")
        .map((pair) => [pair.bus.vehicleId, { dateId, code: pair.duty.code, at: now }])
    );

    for (const bus of buses) {
      const pair = busTaken.get(bus.vehicleId);
      resolved.set(
        bus.vehicleId,
        withDutyResolution(
          bus,
          pair
            ? confirmedResolution(pair, roster)
            : unassignedResolution(bus, byBus.get(bus.vehicleId) ?? [], dutyTaken)
        )
      );
    }
  }

  return {
    vehicles: vehicles.map((bus) => resolved.get(bus.vehicleId) ?? bus),
    missingDates,
  };
}

/** Kursy GTFS i rozkład brygad bywają przesunięte o kilka minut. */
const NEAR_DEPARTURE_MS = 10 * MINUTE;
const tripIndexCache = new Map<string, Map<string, string>>();

/**
 * Brygady rozkładowych kursów dnia (np. dla tablicy odjazdów). Kursy każdej
 * linii są parowane z kursami brygad jeden do jednego: najpierw identyczne
 * godziny, potem przesunięte o kilka minut. Gdy dwa kursy brygad pasują tak
 * samo dobrze, kurs zostaje bez brygady — nie zgadujemy.
 */
export function rosterDutiesForTrips(
  dateId: string,
  trips: Array<{ id: string; line: string; startMs: number }>
): Map<string, string> {
  const roster = rosterFor(dateId);
  if (!roster) {
    ensureDutyRosters([dateId]);
    return new Map();
  }
  const cacheKey = `${dateId}|${roster.source}|${trips.length}`;
  const cached = tripIndexCache.get(cacheKey);
  if (cached) return cached;

  // Przy rozkładzie bez podziału kursów na linie dopuszczamy tylko identyczne godziny.
  const tolerance = roster.source === "snapshot" ? NEAR_DEPARTURE_MS : EXACT_TRIP_MS;
  const result = new Map<string, string>();
  const byLine = new Map<string, Array<{ id: string; startMs: number }>>();
  for (const trip of trips) {
    const line = trip.line.trim().toUpperCase();
    const list = byLine.get(line) ?? [];
    list.push(trip);
    byLine.set(line, list);
  }

  for (const [line, lineTrips] of byLine) {
    const windows: Array<{ duty: DutyEntry; start: number; key: string }> = [];
    for (const duty of roster.duties) {
      for (const [start] of windowsOnLine(duty, line)) {
        windows.push({ duty, start, key: `${duty.code}@${start}` });
      }
    }
    if (!windows.length) continue;

    const pairs: Array<{ tripId: string; window: (typeof windows)[number]; diff: number }> = [];
    for (const trip of lineTrips) {
      let bestDiff = Number.POSITIVE_INFINITY;
      let bestCount = 0;
      const candidates: typeof pairs = [];
      for (const window of windows) {
        const diff = Math.abs(window.start - trip.startMs);
        if (diff > tolerance) continue;
        candidates.push({ tripId: trip.id, window, diff });
        if (diff < bestDiff) {
          bestDiff = diff;
          bestCount = 1;
        } else if (diff === bestDiff) {
          bestCount += 1;
        }
      }
      // Dwa kursy brygad równie blisko (np. odjazdy w obu kierunkach o tej samej
      // minucie) — bez dodatkowych danych nie da się rozstrzygnąć.
      if (bestCount === 1) pairs.push(...candidates);
    }
    pairs.sort((a, b) => a.diff - b.diff || a.window.key.localeCompare(b.window.key));
    const usedTrips = new Set<string>();
    const usedWindows = new Set<string>();
    for (const pair of pairs) {
      if (usedTrips.has(pair.tripId) || usedWindows.has(pair.window.key)) continue;
      usedTrips.add(pair.tripId);
      usedWindows.add(pair.window.key);
      result.set(pair.tripId, pair.window.duty.display);
    }
  }

  tripIndexCache.set(cacheKey, result);
  return result;
}

/* -------------------------------------------------------------------------- */
/*  UI helpers                                                                */
/* -------------------------------------------------------------------------- */

const EVIDENCE_LABEL: Record<DutyEvidence | "none", string> = {
  trip: "po kursie z GTFS-RT",
  schedule: "po rozkładzie brygady",
  signal: "po numerze z wozu",
  memory: "po wcześniejszym kursie wozu",
  none: "brak dopasowania",
};

/** Pełny kod pokazujemy tylko po przypisaniu z rozkładu — nigdy „19/01” czy „WY/04”. */
export function dutyLabel(
  bus: Pick<
    LiveBusVehicle,
    "dutyCode" | "dutyStatus" | "rawBrigade" | "brigade" | "dutyNote" | "dutySource"
  >
): {
  code: string | null;
  short: string;
  tone: "confirmed" | "warning";
  detail: string;
  evidence: string;
} {
  const evidence = EVIDENCE_LABEL[bus.dutySource ?? "none"];
  if (bus.dutyStatus === "confirmed" && bus.dutyCode) {
    return {
      code: bus.dutyCode,
      short: bus.dutyCode,
      tone: "confirmed",
      detail: bus.dutyNote || "Brygada przypisana z rozkładu operatora.",
      evidence,
    };
  }
  return {
    code: null,
    short: "brak brygady",
    tone: "warning",
    detail: bus.dutyNote || "Nie udało się przypisać brygady z rozkładu.",
    evidence,
  };
}

/** Ile wozów (na liniach z rozkładu lub z przypisaną brygadą) ma brygadę. */
export function dutyAssignmentStats(vehicles: LiveBusVehicle[]): {
  assigned: number;
  eligible: number;
} {
  const eligible = vehicles.filter(
    (bus) =>
      KNOWN_OPERATIONAL_LINES.has(currentLine(bus)) ||
      (bus.dutyStatus === "confirmed" && Boolean(bus.dutyCode))
  );
  return {
    assigned: eligible.filter((bus) => bus.dutyStatus === "confirmed" && bus.dutyCode).length,
    eligible: eligible.length,
  };
}
