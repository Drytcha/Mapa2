// npm run test:schedule-diff
// Testy porównania dwóch wersji rozkładu GTFS (np. okres 387 vs 388):
// dodane/usunięte kursy, przesunięcia odjazdów, zmiany tras, wozokilometry brygad i eksport CSV.
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import {
  compareScheduleTrips,
  exportScheduleDiffCsv,
  listNsNhPairs,
  parseExternalGtfsZipForDiff,
  parseServiceIdParts,
  pickDefaultComparison,
  pickNsNhComparison,
  summarizeNsNhDifferences,
  type ScheduleTripSnapshot,
} from "../src/lib/engine/scheduleDiff";

// 1. Parsowanie service_id okresów Wałbrzycha
{
  const p1 = parseServiceIdParts("387_RS");
  assert.equal(p1.periodId, "387");
  assert.equal(p1.dayType, "RS");

  const p2 = parseServiceIdParts("388_NH");
  assert.equal(p2.periodId, "388");
  assert.equal(p2.dayType, "NH");

  const p3 = parseServiceIdParts("weekday");
  assert.equal(p3.periodId, "MAIN");
  assert.equal(p3.dayType, "WEEKDAY");
}

// 2. Testy jednostkowe silnika dopasowywania i liczenia wozokilometrów brygad
{
  const mk = (
    overrides: Partial<ScheduleTripSnapshot> & Pick<ScheduleTripSnapshot, "tripId" | "startMinutes" | "endMinutes">,
  ): ScheduleTripSnapshot => ({
    routeShort: "8",
    routeColor: "#1565c0",
    routeTextColor: "#ffffff",
    serviceId: "387_RS",
    directionId: 0,
    kursowkaCode: "8/01",
    operatorKey: "SKA",
    firstStopName: "Szczawienko",
    lastStopName: "Sobięcin",
    headsign: "Sobięcin",
    stopCount: 18,
    lengthMeters: 10_000,
    ...overrides,
  });

  const trips387: ScheduleTripSnapshot[] = [
    // Identyczny kurs
    mk({ tripId: "a1", startMinutes: 360, endMinutes: 395, kursowkaCode: "8/01", lengthMeters: 10_000 }),
    // Przesunięcie odjazdu o +5 min (06:15 -> 06:20)
    mk({ tripId: "a2", startMinutes: 375, endMinutes: 410, kursowkaCode: "8/01", lengthMeters: 10_000 }),
    // Zmiana trasy (skrócony w 388 do Pl. Grunwaldzki, krótszy o 3 km)
    mk({ tripId: "a3", startMinutes: 420, endMinutes: 455, kursowkaCode: "8/02", lengthMeters: 10_000 }),
    // Kurs, który zniknie w 388 (22:45)
    mk({ tripId: "a4", startMinutes: 1365, endMinutes: 1400, kursowkaCode: "8/02", lengthMeters: 10_000 }),
    // Kurs linii 11, której brygada 11/02 zostanie zlikwidowana
    mk({
      tripId: "a5",
      routeShort: "11",
      kursowkaCode: "11/02",
      firstStopName: "Podzamcze",
      lastStopName: "Kozice",
      startMinutes: 480,
      endMinutes: 515,
      lengthMeters: 12_500,
    }),
  ];

  const trips388: ScheduleTripSnapshot[] = [
    // Identyczny
    mk({ tripId: "b1", serviceId: "388_RS", startMinutes: 360, endMinutes: 395, kursowkaCode: "8/01", lengthMeters: 10_000 }),
    // Przesunięty o +5 min (06:20)
    mk({ tripId: "b2", serviceId: "388_RS", startMinutes: 380, endMinutes: 415, kursowkaCode: "8/01", lengthMeters: 10_000 }),
    // Skrócony (Pl. Grunwaldzki, 12 przyst., 7 km)
    mk({
      tripId: "b3",
      serviceId: "388_RS",
      startMinutes: 420,
      endMinutes: 445,
      kursowkaCode: "8/02",
      lastStopName: "Pl. Grunwaldzki",
      stopCount: 12,
      lengthMeters: 7_000,
    }),
    // Nowy kurs linii 8 o 07:30 na brygadzie 8/01 (+10 km)
    mk({ tripId: "b4", serviceId: "388_RS", startMinutes: 450, endMinutes: 485, kursowkaCode: "8/01", lengthMeters: 10_000 }),
    // Zupełnie nowa linia 30 z nową brygadą 30/01
    mk({
      tripId: "b5",
      serviceId: "388_RS",
      routeShort: "30",
      kursowkaCode: "30/01",
      firstStopName: "Szczawno-Zdrój",
      lastStopName: "Stary Zdrój",
      startMinutes: 500,
      endMinutes: 530,
      lengthMeters: 8_400,
    }),
  ];

  const diff = compareScheduleTrips(trips387, trips388, "387_RS", "388_RS");

  assert.equal(diff.totals.tripsOld, 5);
  assert.equal(diff.totals.tripsNew, 5);
  assert.equal(diff.totals.unchangedCount, 1, "1 kurs bez zmian");
  assert.equal(diff.totals.changedCount, 2, "2 kursy zmienione (godzina + skrócona trasa)");
  assert.equal(diff.totals.addedCount, 2, "2 dodane kursy (8 o 07:30 + nowa linia 30)");
  assert.equal(diff.totals.removedCount, 2, "2 usunięte kursy (8 o 22:45 + linia 11)");
  assert.equal(diff.totals.timeShiftedCount, 2, "2 kursy ze zmianą godziny odjazdu/przyjazdu");
  assert.equal(diff.totals.routeChangedCount, 1, "1 kurs ze zmianą trasy");

  // Sprawdź przesunięcie +5 min na kursie 06:15 -> 06:20
  const shifted = diff.trips.find((t) => t.oldTrip?.tripId === "a2");
  assert.ok(shifted && shifted.kind === "changed");
  assert.equal(shifted.departureDeltaMin, 5);
  assert.equal(shifted.routeChanged, false);

  // Sprawdź zmianę trasy na kursie a3 -> b3
  const shortened = diff.trips.find((t) => t.oldTrip?.tripId === "a3");
  assert.ok(shortened && shortened.kind === "changed");
  assert.equal(shortened.routeChanged, true);
  assert.equal(shortened.lengthDeltaMeters, -3_000);

  // Sprawdź statusy linii
  const line8 = diff.lines.find((l) => l.routeShort === "8")!;
  const line11 = diff.lines.find((l) => l.routeShort === "11")!;
  const line30 = diff.lines.find((l) => l.routeShort === "30")!;
  assert.equal(line8.status, "changed");
  assert.equal(line11.status, "removed");
  assert.equal(line30.status, "added");

  // Sprawdź wozokilometry brygad!
  const b801 = diff.brigades.find((b) => b.brigadeCode === "8/01")!;
  assert.equal(b801.metersOld, 20_000);
  assert.equal(b801.metersNew, 30_000);
  assert.equal(b801.metersDelta, 10_000, "brygada 8/01 dostała +10 km");
  assert.equal(b801.addedTrips, 1);
  assert.equal(b801.changedTrips, 1);

  const b802 = diff.brigades.find((b) => b.brigadeCode === "8/02")!;
  assert.equal(b802.metersOld, 20_000);
  assert.equal(b802.metersNew, 7_000);
  assert.equal(b802.metersDelta, -13_000, "brygada 8/02 straciła 13 km (-1 kurs i skrócenie)");

  const b1102 = diff.brigades.find((b) => b.brigadeCode === "11/02")!;
  assert.equal(b1102.status, "removed");
  assert.equal(b1102.metersDelta, -12_500);

  const b3001 = diff.brigades.find((b) => b.brigadeCode === "30/01")!;
  assert.equal(b3001.status, "added");
  assert.equal(b3001.metersDelta, 8_400);

  // Eksport CSV gotowy pod polski Excel (UTF-8 BOM + średniki)
  const csv = exportScheduleDiffCsv(diff);
  assert.ok(csv.startsWith("\uFEFF"), "CSV ma BOM UTF-8");
  assert.ok(csv.includes("BRYGADY I WOZOKILOMETRY"));
  assert.ok(csv.includes("8/01"));
  assert.ok(csv.includes("10,00"));
  assert.ok(csv.includes("ZMIANY KURSÓW"));
}

// 3. Parsowanie wielookresowej paczki GTFS ZIP (387 vs 388) + automatyczny wybór pary
{
  const zipBytes = zipSync({
    "feed_info.txt": strToU8(
      "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version\n" +
        "ZDKiUM,https://walbrzych.pl,pl,20261101,20261231,387-388\n",
    ),
    "routes.txt": strToU8(
      "route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n" +
        "r8,8,Szczawienko - Sobięcin,3,1565c0,ffffff\n",
    ),
    "stops.txt": strToU8(
      "stop_id,stop_name,stop_lat,stop_lon\n" +
        "s1,Szczawienko,50.8200,16.2800\n" +
        "s2,Centrum,50.7900,16.2800\n" +
        "s3,Sobięcin,50.7600,16.2800\n",
    ),
    "calendar_dates.txt": strToU8(
      "service_id,date,exception_type\n" +
        "387_RS,20261120,1\n" +
        "387_SO,20261121,1\n" +
        "388_RS,20261201,1\n" +
        "388_SO,20261205,1\n",
    ),
    "trips.txt": strToU8(
      "route_id,service_id,trip_id,trip_headsign,direction_id,block_id\n" +
        "r8,387_RS,t_387_1,Sobięcin,0,8/01\n" +
        "r8,387_SO,t_387_so,Sobięcin,0,8/01\n" +
        "r8,388_RS,t_388_1,Sobięcin,0,8/01\n" +
        "r8,388_RS,t_388_2,Sobięcin,0,8/02\n" +
        "r8,388_SO,t_388_so,Sobięcin,0,8/01\n",
    ),
    "stop_times.txt": strToU8(
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
        "t_387_1,06:00:00,06:00:00,s1,1\n" +
        "t_387_1,06:15:00,06:15:00,s2,2\n" +
        "t_387_1,06:30:00,06:30:00,s3,3\n" +
        "t_387_so,08:00:00,08:00:00,s1,1\n" +
        "t_387_so,08:30:00,08:30:00,s3,2\n" +
        "t_388_1,06:05:00,06:05:00,s1,1\n" +
        "t_388_1,06:20:00,06:20:00,s2,2\n" +
        "t_388_1,06:35:00,06:35:00,s3,3\n" +
        "t_388_2,07:00:00,07:00:00,s1,1\n" +
        "t_388_2,07:15:00,07:15:00,s2,2\n" +
        "t_388_2,07:30:00,07:30:00,s3,3\n" +
        "t_388_so,08:00:00,08:00:00,s1,1\n" +
        "t_388_so,08:30:00,08:30:00,s3,2\n",
    ),
  });

  const archive = parseExternalGtfsZipForDiff(zipBytes, "GTFS-test.zip");
  assert.equal(archive.periods.length, 2, "wykrywa 2 okresy (387 i 388)");
  assert.equal(archive.periods[0].periodId, "387");
  assert.equal(archive.periods[1].periodId, "388");

  const def = pickDefaultComparison(archive);
  assert.ok(def);
  assert.equal(def.hasMultiplePeriods, true);
  assert.equal(def.serviceIdA, "387_RS", "domyślnie wybiera stary dzień roboczy 387_RS");
  assert.equal(def.serviceIdB, "388_RS", "domyślnie wybiera nowy dzień roboczy 388_RS");

  const zipDiff = compareScheduleTrips(
    archive.tripsByService.get(def.serviceIdA)!,
    archive.tripsByService.get(def.serviceIdB)!,
    def.serviceIdA,
    def.serviceIdB,
  );
  assert.equal(zipDiff.totals.changedCount, 1, "kurs 06:00 -> 06:05 wykryty jako zmieniony");
  assert.equal(zipDiff.totals.addedCount, 1, "nowy kurs 07:00 wykryty jako dodany");
  assert.ok(zipDiff.totals.metersDelta > 6_000, "wzkm wzrosły o długość nowego kursu (~6.67 km)");
}

// 4. Porównywarka NS vs NH (niedziela niehandlowa / święto vs niedziela handlowa)
{
  const nsNhZip = zipSync({
    "feed_info.txt": strToU8(
      "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version\n" +
        "ZDKiUM,https://walbrzych.pl,pl,20261101,20261231,387-388-ns-nh\n",
    ),
    "routes.txt": strToU8(
      "route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n" +
        "r5,5,Szczawienko - Rusinowa,3,0d9488,ffffff\n" +
        "r8,8,Szczawienko - Sobięcin,3,1565c0,ffffff\n" +
        "rC,C,Podzamcze - Galeria Victoria,3,d97706,ffffff\n",
    ),
    "stops.txt": strToU8(
      "stop_id,stop_name,stop_lat,stop_lon\n" +
        "s1,Szczawienko,50.8200,16.2800\n" +
        "s2,Centrum,50.7900,16.2800\n" +
        "s3,Sobięcin,50.7600,16.2800\n" +
        "s4,Galeria Victoria,50.7750,16.2700\n" +
        "s5,Rusinowa,50.7650,16.3200\n",
    ),
    "calendar_dates.txt": strToU8(
      "service_id,date,exception_type\n" +
        "387_NS,20261108,1\n" +
        "387_NH,20261129,1\n" +
        "388_NS,20261206,1\n" +
        "388_NH,20261213,1\n" +
        "388_NH,20261220,1\n",
    ),
    "trips.txt": strToU8(
      "route_id,service_id,trip_id,trip_headsign,direction_id,block_id\n" +
        // Okres 387 (minimalny)
        "r8,387_NS,t387_ns_8,Sobięcin,0,8/01\n" +
        "r8,387_NH,t387_nh_8,Sobięcin,0,8/01\n" +
        // Okres 388:
        // Linia 8 — identyczna w NS i NH
        "r8,388_NS,t388_ns_8,Sobięcin,0,8/01\n" +
        "r8,388_NH,t388_nh_8,Sobięcin,0,8/01\n" +
        // Linia 5 — w NS jedzie do Rusinowej, w NH ten kurs jest wydłużony / skierowany przez Galerię Victoria + dochodzi dodatkowy kurs do Galerii
        "r5,388_NS,t388_ns_5_1,Rusinowa,0,5/01\n" +
        "r5,388_NH,t388_nh_5_1,Galeria Victoria,0,5/01\n" +
        "r5,388_NH,t388_nh_5_2,Galeria Victoria,0,5/01\n" +
        // Linia C — kursuje WYŁĄCZNIE w niedzielę handlową (NH)
        "rC,388_NH,t388_nh_c_1,Galeria Victoria,0,C/01\n",
    ),
    "stop_times.txt": strToU8(
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
        "t387_ns_8,09:00:00,09:00:00,s1,1\n" +
        "t387_ns_8,09:30:00,09:30:00,s3,2\n" +
        "t387_nh_8,09:00:00,09:00:00,s1,1\n" +
        "t387_nh_8,09:30:00,09:30:00,s3,2\n" +
        "t388_ns_8,10:00:00,10:00:00,s1,1\n" +
        "t388_ns_8,10:30:00,10:30:00,s3,2\n" +
        "t388_nh_8,10:00:00,10:00:00,s1,1\n" +
        "t388_nh_8,10:30:00,10:30:00,s3,2\n" +
        "t388_ns_5_1,10:15:00,10:15:00,s1,1\n" +
        "t388_ns_5_1,10:45:00,10:45:00,s5,2\n" +
        "t388_nh_5_1,10:15:00,10:15:00,s1,1\n" +
        "t388_nh_5_1,10:35:00,10:35:00,s2,2\n" +
        "t388_nh_5_1,10:50:00,10:50:00,s4,3\n" +
        "t388_nh_5_2,11:15:00,11:15:00,s1,1\n" +
        "t388_nh_5_2,11:45:00,11:45:00,s4,2\n" +
        "t388_nh_c_1,12:00:00,12:00:00,s2,1\n" +
        "t388_nh_c_1,12:20:00,12:20:00,s4,2\n",
    ),
  });

  const archive = parseExternalGtfsZipForDiff(nsNhZip, "GTFS-ns-nh.zip");
  const pairs = listNsNhPairs(archive);
  assert.equal(pairs.length, 2, "wykrywa 2 pary NS vs NH (okres 388 i 387)");
  assert.equal(pairs[0].periodId, "388", "posortowane od najnowszego okresu");
  assert.equal(pairs[1].periodId, "387");

  // Wybór aktywnego okresu wg daty dzisiejszej
  const pickedNov = pickNsNhComparison(archive, undefined, 20261115);
  assert.ok(pickedNov);
  assert.equal(pickedNov.serviceIdA, "387_NS");
  assert.equal(pickedNov.serviceIdB, "387_NH");

  // Wybór domyślny (najnowszy okres) oraz wg jawnego periodId
  const pickedLatest = pickNsNhComparison(archive);
  assert.ok(pickedLatest);
  assert.equal(pickedLatest.serviceIdA, "388_NS");
  assert.equal(pickedLatest.serviceIdB, "388_NH");

  const pickedExplicit = pickNsNhComparison(archive, "387");
  assert.ok(pickedExplicit);
  assert.equal(pickedExplicit.serviceIdA, "387_NS");
  assert.equal(pickedExplicit.serviceIdB, "387_NH");

  // Podsumowanie różnic NS -> NH w okresie 388
  const nsNhDiff = compareScheduleTrips(
    archive.tripsByService.get("388_NS")!,
    archive.tripsByService.get("388_NH")!,
    "388_NS",
    "388_NH",
  );
  const summary = summarizeNsNhDifferences(nsNhDiff);
  assert.deepEqual(
    summary.changedLines.map((l) => l.routeShort).sort(),
    ["5", "C"],
    "zmienione w NH są linie 5 i C",
  );
  assert.deepEqual(
    summary.unchangedLines.map((l) => l.routeShort),
    ["8"],
    "linia 8 ma identyczny rozkład w NS i NH",
  );
  assert.deepEqual(
    summary.addedOnlyInNhLines.map((l) => l.routeShort),
    ["C"],
    "linia C pojawia się wyłącznie w niedzielę handlową",
  );
  assert.ok(
    summary.distinctNewRelations.some(
      (r) => r.routeShort === "5" && r.relation === "Szczawienko → Galeria Victoria" && r.count === 2,
    ),
    "wykrywa 2 kursy linii 5 w relacji do Galerii Victoria (1 zmieniony + 1 dodany)",
  );
  assert.ok(
    summary.distinctNewRelations.some(
      (r) => r.routeShort === "C" && r.relation === "Centrum → Galeria Victoria" && r.count === 1,
    ),
    "wykrywa kurs nowej linii handlowej C",
  );
}

console.log(
  "OK: porównanie dwóch wersji rozkładu GTFS + porównywarka NS vs NH (okresy, kursy +/-/~, przesunięcia, relacje NH, wzkm brygad, CSV)",
);
