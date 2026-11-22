import assert from "node:assert/strict";
import type { VehicleTripStop } from "../src/lib/engine/gtfsStore";
import {
  buildTripProgress,
  currentStopIndex,
  describeStopDelta,
  serviceDateId,
  TRIP_LEGEND,
  tripVariantLabel,
  vehicleChipLabel,
  waitingForDeparture,
} from "../src/lib/liveBusProgress";

/**
 * Przebieg kursu autobusu (myBus 3.0): wszystkie przystanki, przebyte na
 * liście, autobus na osi, godzina planowa + prognoza GPS.
 */

const DAY = Date.UTC(2026, 10, 22, 0, 0, 0);
const at = (hours: number, minutes: number) => DAY + (hours * 60 + minutes) * 60_000;

function stop(
  sequence: number,
  name: string,
  hours: number,
  minutes: number,
  passed = false,
): VehicleTripStop {
  const ms = at(hours, minutes);
  return {
    sequence,
    name,
    scheduledArrival: ms,
    scheduledDeparture: ms,
    passed,
  };
}

// Kurs: 3 przebyte, bieżący, następny, dwa kolejne (końcowy = ostatni).
const stops: VehicleTripStop[] = [
  stop(1, "Wałbrzych Rynek", 10, 0, true),
  stop(2, "Wałbrzych Główna", 10, 8, true),
  stop(3, "Piaskowa Góra", 10, 15, true),
  stop(4, "Podzamcze", 10, 22),
  stop(5, "Szczawienko", 10, 30),
  stop(6, "Stary Zdrój", 10, 38),
  stop(7, "Kozice", 10, 46),
];

// 1. Indeks bieżącego przystanku = pierwszy nieprzebyty.
assert.equal(currentStopIndex(stops), 3);

const rows = buildTripProgress(stops, { delaySeconds: 120, isRealtime: true });

// 2. Przebyte przystanki **zostają** na liście (cała trasa, jak w myBus).
assert.equal(rows.length, stops.length);
assert.deepEqual(
  rows.map((row) => row.status),
  ["passed", "passed", "passed", "current", "next", "upcoming", "final"],
);
assert.deepEqual(
  rows.filter((row) => row.status === "passed").map((row) => row.name),
  ["Wałbrzych Rynek", "Wałbrzych Główna", "Piaskowa Góra"],
);

// 3. Prognoza GPS = rozkład + opóźnienie, z różnicą w konwencji aplikacji.
const current = rows[3];
assert.equal(current.plannedMs, at(10, 22));
assert.equal(current.predictedMs, at(10, 22) + 120_000);
assert.equal(current.deltaSeconds, 120);
assert.equal(describeStopDelta(current.deltaSeconds), "-2:00");
assert.equal(describeStopDelta(null), "planowo");
assert.equal(describeStopDelta(10), "planowo");
assert.equal(describeStopDelta(-90), "+1:30");

// 4. Bez GPS nie zmyślamy prognozy.
const plannedOnly = buildTripProgress(stops);
assert.equal(plannedOnly[3].predictedMs, null);
assert.equal(plannedOnly[3].deltaSeconds, null);

// 5. Autobus czeka na odjazd tylko na przystanku początkowym przed godziną odjazdu.
const notStarted: VehicleTripStop[] = [
  stop(1, "Wałbrzych Rynek", 10, 1),
  stop(2, "Wałbrzych Główna", 10, 9),
];
const waiting = waitingForDeparture(notStarted, {
  delaySeconds: 0,
  isRealtime: true,
  nowMs: at(10, 0),
});
assert.equal(waiting.waiting, true);
assert.match(waiting.label, /^Czeka na odjazd o \d{2}:\d{2}$/);
assert.equal(
  waitingForDeparture(stops, { delaySeconds: 0, isRealtime: true, nowMs: at(10, 20) }).waiting,
  false,
  "kurs w trasie nie może być oznaczony jako czekający",
);
assert.equal(
  waitingForDeparture(notStarted, { delaySeconds: 0, isRealtime: true, nowMs: at(10, 5) }).waiting,
  false,
  "po odjeździe nie czeka",
);

// 6. Chipsy pojazdu i zadania.
assert.equal(vehicleChipLabel("1234"), "Pojazd #1234");
assert.equal(vehicleChipLabel(null), "Pojazd");

// 7. Legenda kolorów zawiera stan „czeka na odjazd” (myBus 3.0).
assert.ok(TRIP_LEGEND.some((entry) => entry.label === "Czeka na odjazd"));
assert.ok(TRIP_LEGEND.some((entry) => /powyżej 3 min/.test(entry.label)));

// 8. Litera wariantu pochodzi z oficjalnej legendy linii 9 (kurs przez Sokołowskiego).
const line9: VehicleTripStop[] = [
  stop(1, "Wałbrzych Rynek", 10, 0),
  stop(2, "Szpital Sokołowskiego", 10, 12),
  stop(3, "Kozice", 10, 30),
];
const line9Variant = tripVariantLabel("9", line9, "Kozice");
assert.equal(line9Variant.code, "s");
assert.match(line9Variant.text, /Sokołowskiego/);
// Linia bez wariantów nie dostaje litery.
assert.deepEqual(tripVariantLabel("30", line9, "Kozice"), { code: "", text: "" });

// 9. Dzień obsługi kursu z GPS (po północy zostaje dniem poprzednim).
assert.equal(serviceDateId(at(10, 0)), "20261122");
assert.equal(serviceDateId(Date.UTC(2026, 10, 22, 23, 30)), "20261123");

console.log("OK: przebieg kursu, przebyte przystanki, czekanie na odjazd, warianty");
