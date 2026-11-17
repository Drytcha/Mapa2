/**
 * Pure brigade builder — no browser APIs, no network, no external services.
 *
 * A Wałbrzych duty (kursówka) is one physical bus for the whole day. It can run
 * trips on several lines (e.g. "8-02" also serving line 2). Therefore the chains
 * MUST be built across all lines of the selected service day; filtering by line
 * happens only afterwards, otherwise cross-line brigades are torn apart.
 */

export interface BuilderTrip {
  id: string;
  line: string;
  headsign: string;
  startMinutes: number;
  endMinutes: number;
  firstStopId: string;
  lastStopId: string;
  firstStopName: string;
  lastStopName: string;
  lengthMeters: number;
  /** Confirmed duty number from the vehicle's on-board computer, e.g. "2-03". */
  observedBrigade?: string;
  vehicleId?: string;
}

export interface BuilderStop {
  lat: number;
  lon: number;
}

export interface BuiltBrigade {
  /** Empty when the duty has no confirmed on-board number. Never invented. */
  number: string;
  primaryLine: string;
  lineIds: string[];
  trips: BuilderTrip[];
  source: "gtfs" | "live";
  unassigned: boolean;
  vehicleId?: string;
}

export interface BuildInput {
  trips: BuilderTrip[];
  stops: Map<string, BuilderStop>;
  /**
   * When false (default), unconfirmed chains stay numberless instead of being
   * given fictional sequential labels that do not exist in Wałbrzych.
   */
  numberUnconfirmed?: boolean;
  /** Keep unverified trips separate from numbered duties when evidence is scarce. */
  attachUnconfirmedToConfirmed?: boolean;
}

export interface FeedValidity {
  /** feed_info.txt: feed_start_date / feed_end_date (YYYYMMDD), 0 if absent. */
  from: number;
  to: number;
}

function readableDate(key: number): string {
  const text = String(key);
  if (text.length !== 8) return String(key);
  return `${text.slice(6, 8)}.${text.slice(4, 6)}.${text.slice(0, 4)}`;
}

/**
 * Only the timetable that is actually valid on THIS date is used.
 * No "weekday fallback", no representative date, no schedule "from ever to never".
 */
export function resolveActiveServices(
  dateKey: number,
  serviceIdsByDate: Map<number, Set<string>>,
  validity: FeedValidity
): { services?: Set<string>; error?: string } {
  if (validity.from > 0 && validity.to > 0) {
    if (dateKey < validity.from || dateKey > validity.to) {
      return {
        error: `Aktualny rozkład GTFS Wałbrzycha obowiązuje od ${readableDate(validity.from)} do ${readableDate(validity.to)}. Wybierz datę z tego okresu.`,
      };
    }
  }
  const services = serviceIdsByDate.get(dateKey);
  if (!services || services.size === 0) {
    return {
      error: `Brak obowiązującego rozkładu jazdy na ${readableDate(dateKey)} w aktualnym feedzie GTFS.`,
    };
  }
  return { services };
}

const MIN_LAYOVER_MINUTES = 2;
const MAX_LAYOVER_MINUTES = 90;
/** Terminal changes on foot / via a short deadhead run are allowed. */
const MAX_TERMINAL_DISTANCE_M = 900;

function distanceMeters(a?: BuilderStop, b?: BuilderStop): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const dLat = (b.lat - a.lat) * 110540;
  const dLon = (b.lon - a.lon) * 111320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
}

function normalizeBrigade(value: string): string {
  const clean = value.trim().toUpperCase().replace(/\s+/g, "");
  const match = clean.match(/^([A-Z0-9]+)[/:\-](\d+)$/);
  return match
    ? `${match[1]}-${match[2].padStart(2, "0")}`
    : clean.replace(/\//g, "-");
}

interface Chain {
  number?: string;
  primaryLine?: string;
  source: "gtfs" | "live";
  vehicleId?: string;
  trips: BuilderTrip[];
}

function connectionScore(
  previous: BuilderTrip,
  next: BuilderTrip,
  stops: Map<string, BuilderStop>,
): number | null {
  const gap = next.startMinutes - previous.endMinutes;
  if (gap < 0 || gap > MAX_LAYOVER_MINUTES) return null;
  const dist =
    previous.lastStopId === next.firstStopId
      ? 0
      : distanceMeters(stops.get(previous.lastStopId), stops.get(next.firstStopId));
  if (dist > MAX_TERMINAL_DISTANCE_M || (gap < MIN_LAYOVER_MINUTES && dist > 100)) {
    return null;
  }
  return gap + dist / 100;
}

/**
 * Builds every duty of the day exactly once.
 * Invariant: each input trip belongs to exactly one returned brigade.
 */
export function buildBrigadesFromTrips({
  trips,
  stops,
  numberUnconfirmed = false,
  attachUnconfirmedToConfirmed = true,
}: BuildInput): BuiltBrigade[] {
  const ordered = [...trips].sort(
    (a, b) => a.startMinutes - b.startMinutes || a.id.localeCompare(b.id)
  );

  const chains: Chain[] = [];

  // 1. Anchor duties confirmed by live GPS observations (on-board computers).
  const confirmed = new Map<string, BuilderTrip[]>();
  for (const trip of ordered) {
    if (!trip.observedBrigade) continue;
    const key = normalizeBrigade(trip.observedBrigade);
    const list = confirmed.get(key) ?? [];
    list.push(trip);
    confirmed.set(key, list);
  }
  const claimed = new Set<string>();
  const conflicting: BuilderTrip[] = [];
  for (const [number, group] of confirmed) {
    group.sort((a, b) => a.startMinutes - b.startMinutes || a.id.localeCompare(b.id));
    const accepted: BuilderTrip[] = [];
    for (const trip of group) {
      claimed.add(trip.id);
      if (accepted.some((other) => trip.startMinutes < other.endMinutes)) {
        conflicting.push(trip);
      } else {
        accepted.push(trip);
      }
    }
    chains.push({
      number,
      primaryLine: number.split("-")[0],
      source: "live",
      vehicleId: accepted.find((trip) => trip.vehicleId)?.vehicleId,
      trips: accepted,
    });
  }
  for (const trip of conflicting) {
    chains.push({ source: "gtfs", vehicleId: trip.vehicleId, trips: [trip] });
  }

  // 2. Insert between known trips only if both neighbouring connections fit.
  for (const trip of ordered) {
    if (claimed.has(trip.id)) continue;

    let best: Chain | null = null;
    let bestScore = Infinity;
    let bestIndex = 0;

    for (const chain of chains) {
      if (chain.number && !attachUnconfirmedToConfirmed) continue;
      const index = chain.trips.findIndex((entry) => entry.startMinutes > trip.startMinutes);
      const insertAt = index === -1 ? chain.trips.length : index;
      const previous = chain.trips[insertAt - 1];
      const next = chain.trips[insertAt];
      const before = previous ? connectionScore(previous, trip, stops) : null;
      const after = next ? connectionScore(trip, next, stops) : null;
      if ((previous && before === null) || (next && after === null)) continue;

      const score = (before ?? 0) + (after ?? 0) - (chain.source === "live" ? 1 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = chain;
        bestIndex = insertAt;
      }
    }

    if (best) {
      best.trips.splice(bestIndex, 0, trip);
      if (!best.vehicleId && trip.vehicleId) best.vehicleId = trip.vehicleId;
    } else {
      chains.push({
        source: "gtfs",
        vehicleId: trip.vehicleId,
        trips: [trip],
      });
    }
    claimed.add(trip.id);
  }

  for (const chain of chains) {
    chain.trips.sort((a, b) => a.startMinutes - b.startMinutes || a.id.localeCompare(b.id));
  }

  // 3. Number unconfirmed duties per primary line, skipping GPS-confirmed numbers.
  const usedPerLine = new Map<string, Set<string>>();
  for (const chain of chains) {
    if (!chain.number) continue;
    const [line, num] = chain.number.split("-");
    const set = usedPerLine.get(line) ?? new Set<string>();
    set.add(num);
    usedPerLine.set(line, set);
  }

  const counters = new Map<string, number>();
  chains.sort(
    (a, b) =>
      a.trips[0].startMinutes - b.trips[0].startMinutes ||
      a.trips[0].id.localeCompare(b.trips[0].id)
  );

  for (const chain of chains) {
    if (chain.number || !numberUnconfirmed) continue;

    // The dominant line of the duty determines its number, e.g. "A-03".
    const counts = new Map<string, number>();
    for (const trip of chain.trips) {
      counts.set(trip.line, (counts.get(trip.line) ?? 0) + 1);
    }
    const primaryLine =
      [...counts.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pl", { numeric: true })
      )[0]?.[0] ?? chain.trips[0].line;
    chain.primaryLine = primaryLine;

    const used = usedPerLine.get(primaryLine) ?? new Set<string>();
    let counter = counters.get(primaryLine) ?? 1;
    while (used.has(String(counter).padStart(2, "0"))) counter += 1;
    const num = String(counter).padStart(2, "0");
    used.add(num);
    usedPerLine.set(primaryLine, used);
    counters.set(primaryLine, counter + 1);
    chain.number = `${primaryLine}-${num}`;
  }

  // 4. Guarantee unique identifiers even if two sources produced the same number.
  const seenNumbers = new Set<string>();
  for (const chain of chains) {
    if (!chain.number) continue;
    let candidate = chain.number;
    let suffix = 1;
    while (seenNumbers.has(candidate)) {
      suffix += 1;
      candidate = `${chain.number}-${suffix}`;
    }
    seenNumbers.add(candidate);
    chain.number = candidate;
  }

  return chains
    .map<BuiltBrigade>((chain) => ({
      number: chain.number ?? "",
      primaryLine:
        chain.primaryLine ??
        chain.number?.split("-")[0] ??
        chain.trips[0]?.line ??
        "",
      lineIds: [...new Set(chain.trips.map((trip) => trip.line))].sort((a, b) =>
        a.localeCompare(b, "pl", { numeric: true })
      ),
      trips: chain.trips,
      source: chain.source,
      unassigned: !chain.number,
      vehicleId: chain.vehicleId,
    }))
    .sort(
      (a, b) =>
        Number(a.unassigned) - Number(b.unassigned) ||
        a.number.localeCompare(b.number, "pl", { numeric: true }) ||
        (a.trips[0]?.startMinutes ?? 0) - (b.trips[0]?.startMinutes ?? 0)
    );
}

/** Every brigade that contains at least one trip of the given line. */
export function filterBrigadesByLine(
  brigades: BuiltBrigade[],
  line: string
): BuiltBrigade[] {
  if (line === "all") return brigades;
  const wanted = line.toUpperCase();
  return brigades.filter((brigade) =>
    brigade.lineIds.some((entry) => entry.toUpperCase() === wanted)
  );
}
