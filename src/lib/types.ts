export type VehicleId = string;
export type MapStyle = "osm" | "light" | "dark" | "satellite";
export type ThemeMode = "light" | "dark";
/** Planista = pełny planer; Podróżny = mapa, przystanki, GPS i rozkład bez planowania tras. */
export type AppRole = "planner" | "traveler";
export type SpeedOverrides = Partial<Record<VehicleId, number>>;

export interface TrafficSignalIntersection {
  id: string;
  lat: number;
  lon: number;
  routeOffsetMeters: number;
}

export interface ScheduleSettings {
  mode: "now" | "departure" | "arrival";
  date: string;
  time: string;
  trafficEnabled: boolean;
  peakDelayPercent: number;
  liveTrafficEnabled: boolean;
  trafficLightsEnabled: boolean;
  secondsPerSignal: number;
  bufferMinutes: number;
  occurrence: "earlier" | "later";
}

export interface JourneyTiming {
  mode: ScheduleSettings["mode"];
  zone: "Europe/Warsaw";
  departure: number;
  arrival: number;
  targetArrival?: number;
  baseSeconds: number;
  signalCount: number;
  signalSeconds: number;
  travelSeconds: number;
  delaySeconds: number;
  bufferSeconds: number;
  trafficEnabled: boolean;
  liveTrafficEnabled: boolean;
  trafficLightsEnabled: boolean;
  peakDelayPercent: number;
}

export const MAX_WAYPOINTS = 50;

export interface BrigadeInfo {
  line: string;
  duty: string;
}

export interface Waypoint {
  id: string;
  label: string;
  short: string;
  lat: number;
  lon: number;
  empty?: boolean;
}

export interface Place {
  id: string;
  label: string;
  short: string;
  lat: number;
  lon: number;
  source: "local" | "osm";
  kind?: string;
}

export interface BusStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  lines: string[];
  shelter: boolean;
  operator?: string;
  ref?: string;
  direction?: string;
  towards?: string;
  side?: string;
  platformKey?: string;
  kind?: "platform" | "bus_stop" | "stop_position";
  kinds?: Array<"platform" | "bus_stop" | "stop_position">;
  merged?: number;
  /** GTFS stop id used to read departures / kursówki for this stop. */
  gtfsId?: string;
  /** Where the stop comes from: Wałbrzych timetable (GTFS + rozklad.walbrzych.eu) or OpenStreetMap only. */
  source?: "timetable" | "osm";
}

export interface RouteStep {
  instruction: string;
  distance: number;
  duration: number;
  maneuver: string;
  modifier?: string;
  leg: number;
  location?: [number, number];
}

export interface RouteLeg {
  distance: number;
  duration: number;
}

export interface RouteData {
  coords: [number, number][];
  distance: number;
  duration: number;
  steps: RouteStep[];
  legs?: RouteLeg[];
  engine: "osrm" | "demo";
  labels: string[];
  warnings?: string[];
}

export interface TruckParams {
  weight: number;
  height: number;
  width: number;
  length: number;
  axles: number;
  adr: boolean;
  trailer: boolean;
}

export interface AvoidOptions {
  tolls: boolean;
  ferries: boolean;
  unpaved: boolean;
}

export interface VehicleProfile {
  id: VehicleId;
  name: string;
  short: string;
  description: string;
  lengthM: number;
  weightT: number;
  heightM?: number;
  widthM?: number;
  averageSpeed: number;
  custom?: boolean;
  timeFactor: number;
  distanceFactor: number;
  icon: string;
  limits: {
    motorway: number;
    expressway: number;
    rural: number;
    urban: number;
  };
  note: string;
}

export interface ProfileMetrics {
  id: VehicleId;
  name?: string;
  short?: string;
  profile?: VehicleProfile;
  distance: number;
  duration: number;
  restrictions: number;
  toll: number;
  customSpeed?: number;
  automaticDuration: number;
  journey?: JourneyTiming;
}

export type WalbrzychOperatorKey = "mzuk" | "ska" | "other";

export interface LiveBusVehicle {
  vehicleId: string;
  model: string | null;
  operatorKey: WalbrzychOperatorKey;
  operatorName: string;
  /** "manual" when the assignment was overridden by the user. */
  operatorSource: "auto" | "manual";
  routeName: string;
  routeColor: string;
  /** Raw operator signal, often only a suffix ("01"), never a full duty by itself. */
  brigade: string;
  /** Alias kept explicit so raw signals can never be mistaken for a verified duty. */
  rawBrigade?: string;
  /** Verified full duty code ("9/01"). Empty/null when it cannot be proven. */
  dutyCode?: string | null;
  /** Verification state of the duty; unverified codes are never rendered. */
  dutyStatus?: "confirmed" | "unresolved" | "invalid";
  /** The duty's own line prefix (e.g. "9" for 9-01, even when serving line 19). */
  dutyLine?: string | null;
  /** How the duty was matched: GTFS-RT trip, schedule time, or the vehicle's signal alone. */
  dutySource?: "trip" | "schedule" | "signal" | "memory" | "none";
  dutyNote?: string;
  /** Start (ms) of the roster trip the bus is matched to — used to highlight it. */
  dutyTripStartMs?: number | null;
  /** GTFS-RT TripDescriptor of the current trip: start (ms), service day, route. */
  tripStartMs?: number | null;
  tripServiceDate?: string | null;
  tripRouteShort?: string | null;
  /**
   * Full verified duty code. It is intentionally empty when the GPS signal
   * cannot be matched to the operator's roster — never `${routeName}/${brigade}`.
   */
  kursowka: string;
  tripId: string | null;
  lat: number;
  lon: number;
  bearing: number | null;
  delaySeconds: number;
  /** Speed derived from consecutive GPS fixes; null until two fixes are known. */
  speedKmh: number | null;
  headsign: string | null;
  timestamp: number;
  upcomingStops: Array<{
    sequence: number;
    name: string;
    scheduledArrival: number;
    scheduledDeparture: number;
  }>;
}

export interface LiveTrafficSummary {
  totalVehicles: number;
  trackedOnTripCount: number;
  avgDelaySeconds: number;
  maxDelaySeconds: number;
  delayedCount: number;
  onTimeCount: number;
  congestionLevel: "niski" | "umiarkowany" | "wysoki";
  recommendedPeakPercent: number;
  operatorBreakdown: {
    mzuk: number;
    ska: number;
    other: number;
  };
  fetchedAt: number;
}

export interface StopDepartureItem {
  tripId: string;
  kursowkaId: string;
  kursowka: string;
  brigadeSource: string;
  routeShort: string;
  routeColor: string;
  routeTextColor: string;
  routeLong: string;
  headsign: string;
  finalStop: string;
  direction: number;
  minutes: number;
  atMs: number;
  clock: string;
  dateLabel: string;
  isRealtime: boolean;
  delaySeconds: number;
  vehicleId: string | null;
  operatorName: string | null;
  operatorKey: WalbrzychOperatorKey | null;
}
