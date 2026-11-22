// npm run test:geometry
// Geometria tras rysowanych przy autobusach i rozkładach.
//
// Zgłoszenia:
//  1. „linie urywają się w połowie i pokazują od losowego miejsca” — polilinia
//     była dzielona na kawałki przy każdym dłuższym odcinku kształtu, a nieudane
//     uzupełnienie OSRM zostawiało dziurę.
//  2. „linia 11 kończy na pętli Kozice, a nie ~300 m od niej” — ostatni wpis
//     `stop_times` bywa węzłem (`location_type=1`), który był po cichu pomijany,
//     a kształt kończył się przed pętlą.
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";

const loop = { lat: 50.77238, lon: 16.32741, name: "Strzegomska - Kozice" };
const beforeLoop = { lat: 50.76983, lon: 16.32433, name: "Strzegomska - na żądanie" };
// ~250 m prostego odcinka (rzadkie próbkowanie drogi) w środku kształtu linii 7.
const sparseA = { lat: 50.76697, lon: 16.28661 };
const sparseB = { lat: 50.76697, lon: 16.28958 };
const sparseC = { lat: 50.7692, lon: 16.2921 };

const files: Record<string, string> = {
  "feed_info.txt":
    "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.com,pl,20260101,20261231\n",
  "routes.txt":
    "route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n" +
    "r11,11,Jedlina-Zdrój,3,1E6FBF,FFFFFF\n" +
    "r7,7,Podzamcze,3,0d4f3b,FFFFFF\n" +
    "r9,9,Sobięcin,3,8a5a12,FFFFFF\n" +
    "r5,5,Głuszyca,3,6c2bd9,FFFFFF\n" +
    "r6,6,Podzamcze przez Książ,3,0891b2,FFFFFF\n",
  "stops.txt":
    "stop_id,stop_name,stop_lat,stop_lon,location_type\n" +
    `s1,Piłsudskiego - Plac Tuwima,${beforeLoop.lat},${beforeLoop.lon},0\n` +
    `s2,${beforeLoop.name},${beforeLoop.lat},${beforeLoop.lon},0\n` +
    `st-loop,${loop.name},${loop.lat},${loop.lon},1\n` +
    "s7a,Podzamcze,50.76697,16.28661,0\n" +
    "s7b,Północ,50.7692,16.2921,0\n" +
    "s9a,Sobięcin,50.76000,16.25000,0\n" +
    "s9b,Nowe Miasto,50.77000,16.26000,0\n" +
    "s9c,Koniec,50.78000,16.27000,0\n" +
    "s5a,Start,50.76000,16.30000,0\n" +
    "s5b,Środek,50.76500,16.30500,0\n" +
    "s5c,Przystanek,50.76520,16.30520,0\n" +
    "s5d,Koniec,50.77000,16.31000,0\n" +
    "s6a,A,50.76000,16.31000,0\n" +
    "s6d,D,50.76300,16.31300,0\n",
  "calendar_dates.txt": "service_id,date,exception_type\ndaily,20261120,1\ndaily,20261121,1\n",
  "trips.txt":
    "route_id,service_id,trip_id,trip_headsign,block_id,shape_id,direction_id\n" +
    "r11,daily,t11,Jedlina-Zdrój,11/01,sh11,0\n" +
    "r7,daily,t7,Podzamcze,7/01,sh7,0\n" +
    "r9,daily,t9,Sobięcin,9/01,,0\n" +
    "r5,daily,t5,Głuszyca,5/01,sh5,0\n" +
    "r6,daily,t6,Książ,6/01,sh6,0\n",
  // stop_times linii 11 kończą się węzłem (pętla) — tak jak w prawdziwej paczce.
  "stop_times.txt":
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n" +
    "t11,10:00:00,10:00:00,s1,1,0,0\n" +
    "t11,10:05:00,10:05:00,s2,2,0,0\n" +
    "t11,10:09:00,10:09:00,st-loop,3,1,0\n" +
    "t7,11:00:00,11:00:00,s7a,1,0,0\n" +
    "t7,11:06:00,11:06:00,s7b,2,0,0\n" +
    "t9,12:00:00,12:00:00,s9a,1,0,0\n" +
    "t9,12:05:00,12:05:00,s9b,2,0,0\n" +
    "t9,12:10:00,12:10:00,s9c,3,0,0\n" +
    "t5,13:00:00,13:00:00,s5a,1,0,0\n" +
    "t5,13:05:00,13:05:00,s5b,2,0,0\n" +
    "t5,13:06:00,13:06:00,s5c,3,0,0\n" +
    "t5,13:12:00,13:12:00,s5d,4,0,0\n" +
    "t6,14:00:00,14:00:00,s6a,1,0,0\n" +
    "t6,14:10:00,14:10:00,s6d,2,0,0\n",
  // Kształt linii 11 kończy się PRZED pętlą (jak w paczce), linia 7 ma długi prosty odcinek.
  "shapes.txt":
    "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n" +
    "sh11,50.76500,16.32000,1\n" +
    `sh11,${beforeLoop.lat},${beforeLoop.lon},2\n` +
    `sh7,${sparseA.lat},${sparseA.lon},1\n` +
    `sh7,${sparseB.lat},${sparseB.lon},2\n` +
    `sh7,${sparseC.lat},${sparseC.lon},3\n` +
    // Linia 5: dwa długie odcinki (rzadkie próbkowanie) — pierwszy uzupełnia OSRM,
    // drugi nie. Stara wersja rysowała wtedy tylko kawałek do „Środka”.
    "sh5,50.76000,16.30000,1\n" +
    "sh5,50.76500,16.30500,2\n" +
    "sh5,50.76520,16.30520,3\n" +
    "sh5,50.77000,16.31000,4\n" +
    // Ten sam kształt w dwóch blokach (numeracja zaczyna się od nowa) — kolejność
    // punktów z pliku musi zostać zachowana.
    "sh6,50.76000,16.31000,1\n" +
    "sh6,50.76100,16.31100,2\n" +
    "sh6,50.76200,16.31200,1\n" +
    "sh6,50.76300,16.31300,2\n",
};

const zip = Buffer.from(
  zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), {
    level: 0,
  }),
);

let osrmCalls = 0;
const realFetch = globalThis.fetch;
(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("kind=operators")) {
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes(".zip") || url.includes("/api/transit/gtfs")) {
    return new Response(zip, { status: 200, headers: { "content-type": "application/zip" } });
  }
  if (url.includes("/route/v1/")) {
    osrmCalls += 1;
    // Pierwsze przejście linii 5 (16.3 -> 16.305) router potrafi uzupełnić,
    // drugiego już nie — dokładnie tak wygląda „urwana w połowie” trasa.
    if (url.includes("16.300000,50.760000")) {
      return new Response(
        JSON.stringify({
          code: "Ok",
          routes: [
            {
              distance: 700,
              geometry: {
                coordinates: [
                  [16.3, 50.76],
                  [16.3025, 50.7625],
                  [16.305, 50.765],
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error("OSRM niedostępny");
  }
  throw new Error(`nieoczekiwane zapytanie: ${url}`);
}) as typeof fetch;

const {
  getCoursePreview,
  getVehicleRouteOverlay,
  syncWalbrzychGtfs,
  ensureGtfsSeeded,
} = await import("../src/lib/engine/gtfsStore");

await syncWalbrzychGtfs();
await ensureGtfsSeeded();

const closeTo = (a: [number, number], b: { lat: number; lon: number }, meters: number) => {
  const dLat = Math.abs(a[0] - b.lat) * 111_320;
  const dLon = Math.abs(a[1] - b.lon) * 111_320 * Math.cos((b.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon) <= meters;
};

// ── 1. Linia 11: koniec trasy na pętli, choć kształt kończy się wcześniej ──────
{
  const overlay = await getVehicleRouteOverlay({
    vehicleId: "11",
    routeName: "11",
    routeColor: "#1e6fbf",
    headsign: "Jedlina-Zdrój",
    lat: beforeLoop.lat,
    lon: beforeLoop.lon,
    bearing: 90,
    timestamp: Date.now(),
    delaySeconds: 0,
    speedKmh: 20,
    operatorKey: "mzuk",
    operatorName: "MZUK",
    brigade: "11/01",
    tripId: "t11",
    upcomingStops: [],
  } as never);
  assert.ok(overlay, "linia 11 musi mieć trasę");
  assert.equal(overlay.polylines.length, 1, "trasa to jedna ciągła linia");
  const end = overlay.polylines[0][overlay.polylines[0].length - 1];
  assert.ok(closeTo(end, loop, 5), "linia 11 musi dojechać do pętli Kozice");
  assert.equal(
    overlay.stops[overlay.stops.length - 1].name,
    loop.name,
    "przystanek końcowy linii 11 to pętla Kozice",
  );
  assert.ok(
    closeTo([overlay.stops[overlay.stops.length - 1].lat, overlay.stops[overlay.stops.length - 1].lon], loop, 5),
    "przystanek końcowy ma współrzędne pętli",
  );
}

// ── 2. Kurs (rozkład) linii 11: ta sama reguła ────────────────────────────────
{
  const course = await getCoursePreview("t11", "20261120");
  assert.ok(course, "podgląd kursu linii 11 musi istnieć");
  assert.equal(course.polylines.length, 1, "kurs rysowany jedną linią");
  const end = course.polylines[0][course.polylines[0].length - 1];
  assert.ok(closeTo(end, loop, 5), "kurs kończy się na pętli");
  assert.ok(
    closeTo([course.stops[course.stops.length - 1].lat, course.stops[course.stops.length - 1].lon], loop, 5),
    "lista przystanków kursu kończy się na pętli",
  );
}

// ── 3. Linia 7: długi odcinek kształtu nie może rozciąć linii ─────────────────
{
  const before = osrmCalls;
  const course = await getCoursePreview("t7", "20261120");
  assert.ok(course);
  assert.equal(course.polylines.length, 1, "jeden kawałek trasy, nie dwa");
  assert.ok(
    course.polylines[0].length >= 3,
    "cały kształt jest rysowany (żadnego punktu nie gubimy)",
  );
  assert.equal(osrmCalls, before, "kształt z paczki nie wymaga zapytań do OSRM");
  assert.ok(closeTo(course.polylines[0][0], sparseA, 5), "linia startuje w pierwszym punkcie kształtu");
  assert.ok(closeTo(course.polylines[0][course.polylines[0].length - 1], sparseB, 5) ||
    closeTo(course.polylines[0][course.polylines[0].length - 1], sparseC, 5), "linia dochodzi do końca kształtu");
}

// ── 4. Linia 9: brak shapes.txt, OSRM niedostępny — linia i tak jest cała ─────
{
  const course = await getCoursePreview("t9", "20261120");
  assert.ok(course);
  assert.equal(course.polylines.length, 1, "brak dziur: trasa jest jedną linią");
  assert.equal(course.polylines[0].length, 3, "wszystkie przystanki są na trasie");
  assert.ok(closeTo(course.polylines[0][0], { lat: 50.76, lon: 16.25 }, 5), "start = pierwszy przystanek");
  assert.ok(
    closeTo(course.polylines[0][2], { lat: 50.78, lon: 16.27 }, 5),
    "koniec = ostatni przystanek",
  );
}

// ── 5. Częściowo działający OSRM nie może urwać końcówki trasy ───────────────
{
  const before = osrmCalls;
  const course = await getCoursePreview("t5", "20261120");
  assert.ok(course);
  assert.equal(osrmCalls, before, "kształt z paczki nie jest kierowany przez OSRM");
  assert.equal(course.polylines.length, 1, "trasa jest jedną linią, nie kawałkiem");
  const path = course.polylines[0];
  assert.ok(
    closeTo(path[path.length - 1], { lat: 50.77, lon: 16.31 }, 5),
    "linia dochodzi do ostatniego punktu kształtu (żadnej urwanej końcówki)",
  );
}

// ── 6. Kształt w dwóch blokach: kolejność punktów z pliku, bez „skoków” ──────
{
  const course = await getCoursePreview("t6", "20261120");
  assert.ok(course);
  assert.equal(course.polylines.length, 1);
  const path = course.polylines[0];
  assert.equal(path.length, 4, "cztery punkty kształtu");
  const expected: Array<[number, number]> = [
    [50.76, 16.31],
    [50.761, 16.311],
    [50.762, 16.312],
    [50.763, 16.313],
  ];
  path.forEach((point, index) => {
    assert.ok(
      closeTo(point, { lat: expected[index][0], lon: expected[index][1] }, 5),
      `punkt ${index} w kolejności z pliku (jest ${point.join(",")})`,
    );
  });
}

(globalThis as { fetch: typeof fetch }).fetch = realFetch;
console.log(
  "OK: trasy są ciągłe (kształt w całości, brak dziur), a linia 11 kończy na pętli Kozice",
);
