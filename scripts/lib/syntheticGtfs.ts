/**
 * Syntetyczna, ale realistyczna paczka GTFS (rozmiarami zbliżona do wałbrzyskiej):
 * 40 linii, 1200 przystanków, 3000 kursów w trzech typach dnia, ~90 tys. wpisów
 * stop_times i ~90 tys. punktów kształtu. Służy do pomiaru czasu wczytywania danych
 * (`scripts/bench-gtfs-load.ts`) — nie do testów poprawności rozkładu.
 */
import { strToU8, zipSync } from "fflate";

export interface SyntheticGtfsOptions {
  routes?: number;
  stops?: number;
  tripsPerService?: number;
  stopsPerTrip?: number;
  shapes?: number;
  pointsPerShape?: number;
}

export interface SyntheticGtfs {
  zip: Uint8Array;
  routes: number;
  stops: number;
  trips: number;
  stopTimes: number;
  shapePoints: number;
  bytes: number;
}

const SERVICES = ["20261101-WD", "20261101-SO", "20261101-NS"];

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function clock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  return `${pad(h)}:${pad(minutes % 60)}:00`;
}

export function buildSyntheticGtfs(options: SyntheticGtfsOptions = {}): SyntheticGtfs {
  const routes = options.routes ?? 40;
  const stops = options.stops ?? 1200;
  const tripsPerService = options.tripsPerService ?? 1000;
  const stopsPerTrip = options.stopsPerTrip ?? 30;
  const shapes = options.shapes ?? 300;
  const pointsPerShape = options.pointsPerShape ?? 300;

  const baseLat = 50.77;
  const baseLon = 16.28;

  const files: Record<string, string> = {};

  files["feed_info.txt"] =
    "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version\n" +
    "Syntetyk,https://example.com,pl,20261101,20261231,bench\n";
  files["agency.txt"] =
    "agency_id,agency_name,agency_url,agency_timezone\n" +
    "MZUK,ZDKiUM Wałbrzych,https://example.com,Europe/Warsaw\n";

  const routeRows = ["route_id,route_short_name,route_long_name,route_type,route_color,route_text_color"];
  for (let i = 0; i < routes; i += 1) {
    const short = i < 30 ? String(i + 1) : `S${i - 29}`;
    routeRows.push(`r${i},${short},Linia ${short} przez Wałbrzych,3,1E6FBF,FFFFFF`);
  }
  files["routes.txt"] = `${routeRows.join("\n")}\n`;

  const stopRows = ["stop_id,stop_name,stop_lat,stop_lon"];
  for (let i = 0; i < stops; i += 1) {
    const lat = baseLat + (i % 40) * 0.0025;
    const lon = baseLon + Math.floor(i / 40) * 0.0035;
    stopRows.push(`s${i},Przystanek ${i} ${i % 7 === 0 ? "kierunek powrotny" : "centrum"},${lat.toFixed(6)},${lon.toFixed(6)}`);
  }
  files["stops.txt"] = `${stopRows.join("\n")}\n`;

  const calendarRows = [
    "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
    `${SERVICES[0]},1,1,1,1,1,0,0,20261101,20261231`,
    `${SERVICES[1]},0,0,0,0,0,1,0,20261101,20261231`,
    `${SERVICES[2]},0,0,0,0,0,0,1,20261101,20261231`,
  ];
  files["calendar.txt"] = `${calendarRows.join("\n")}\n`;
  files["calendar_dates.txt"] =
    "service_id,date,exception_type\n20261101-WD,20261225,2\n20261101-NS,20261225,1\n";

  const tripRows = ["route_id,service_id,trip_id,trip_headsign,block_id,shape_id,direction_id"];
  const stopTimeRows = ["trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type"];
  let tripCount = 0;
  let stopTimeCount = 0;

  SERVICES.forEach((serviceId, serviceIdx) => {
    const perService = Math.max(1, Math.round(tripsPerService * (serviceIdx === 0 ? 1 : 0.55)));
    for (let t = 0; t < perService; t += 1) {
      const routeIdx = t % routes;
      const tripId = `t${serviceIdx}-${t}`;
      const shapeId = `sh${t % shapes}`;
      const brigade = `${pad((t % 60) + 1)}/${pad(routeIdx + 1)}`;
      tripRows.push(
        `r${routeIdx},${serviceId},${tripId},Przystanek ${(t * 7) % stops},${brigade},${shapeId},${t % 2}`,
      );
      tripCount += 1;
      const start = 4 * 60 + (t * 7) % (18 * 60);
      for (let s = 0; s < stopsPerTrip; s += 1) {
        const stopIdx = (t * 13 + s * 5) % stops;
        const time = start + s * 2;
        stopTimeRows.push(
          `${tripId},${clock(time)},${clock(time)},s${stopIdx},${s + 1},0,0`,
        );
        stopTimeCount += 1;
      }
    }
  });
  files["trips.txt"] = `${tripRows.join("\n")}\n`;
  files["stop_times.txt"] = `${stopTimeRows.join("\n")}\n`;

  const shapeRows = ["shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence"];
  for (let sh = 0; sh < shapes; sh += 1) {
    for (let p = 0; p < pointsPerShape; p += 1) {
      const lat = baseLat + sh * 0.0004 + p * 0.00009;
      const lon = baseLon + Math.sin(p / 12) * 0.004 + sh * 0.0002;
      shapeRows.push(`sh${sh},${lat.toFixed(6)},${lon.toFixed(6)},${p + 1}`);
    }
  }
  files["shapes.txt"] = `${shapeRows.join("\n")}\n`;

  const zip = zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
    { level: 6 },
  );

  return {
    zip,
    routes,
    stops,
    trips: tripCount,
    stopTimes: stopTimeCount,
    shapePoints: shapes * pointsPerShape,
    bytes: zip.byteLength,
  };
}
