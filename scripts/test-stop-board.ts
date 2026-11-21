import assert from "node:assert/strict";
import type { DepartureDirection, DepartureLineGroup } from "../src/lib/departureGroups";
import type { StopDepartureItem } from "../src/lib/types";
import {
  boardLegend,
  formatEta,
  minutesUntil,
  nextDepartures,
  PUNCTUALITY_LEGEND,
} from "../src/lib/stopBoard";

/**
 * Tablica „Najbliższe odjazdy” (wzór: ekran przystanku z myBus 3.0):
 * płaska lista najbliższych kursów wszystkich linii, sortowana po czasie
 * prognozowanym z GPS, z odliczaniem i kolorem punktualności.
 */

const NOW = Date.UTC(2026, 10, 20, 9, 0, 0); // 10:00 czasu polskiego

function departure(
  clock: string,
  atMs: number,
  extra: Partial<StopDepartureItem> = {},
): StopDepartureItem {
  return {
    tripId: `t-${clock}`,
    canPreviewCourse: true,
    serviceDateId: "20261120",
    kursowkaId: "k1",
    kursowka: "9/01",
    brigadeSource: "gtfs",
    routeShort: "9",
    routeColor: "#123456",
    routeTextColor: "#ffffff",
    routeLong: "Linia 9",
    headsign: "Wałbrzych",
    finalStop: "Wałbrzych",
    legendCode: "",
    legendText: undefined,
    direction: 0,
    minutes: 0,
    atMs,
    clock,
    dateLabel: "20.11.2026",
    isRealtime: false,
    delaySeconds: 0,
    vehicleId: null,
    operatorName: null,
    operatorKey: null,
    ...extra,
  };
}

function direction(label: string, suffix = "", legendText?: string): DepartureDirection {
  return {
    key: `${label}|${suffix}`,
    label,
    suffix,
    main: !suffix,
    count: 1,
    legendText,
  };
}

function group(
  line: string,
  dirs: DepartureDirection[],
  rows: Array<{ dep: StopDepartureItem; dir: DepartureDirection }>,
): DepartureLineGroup {
  return {
    line,
    color: "#123456",
    textColor: "#ffffff",
    directions: dirs,
    departures: rows.map((row) => ({ departure: row.dep, direction: row.dir })),
  };
}

const main9 = direction("Wałbrzych Główny");
const variant9 = direction("Wałbrzych Główny", "a", "kurs przedłużony do przystanku Podwale - Forteczna");
const main2 = direction("Boguszów-Gorce");

const groups: DepartureLineGroup[] = [
  group("9", [main9, variant9], [
    { dep: departure("10:05", NOW + 5 * 60_000), dir: main9 },
    { dep: departure("10:35", NOW + 35 * 60_000), dir: variant9 },
    { dep: departure("09:50", NOW - 10 * 60_000), dir: main9 },
    {
      dep: departure("10:10", NOW + 10 * 60_000, {
        tripId: "late",
        isRealtime: true,
        delaySeconds: 300,
      }),
      dir: main9,
    },
  ]),
  group("2", [main2], [
    { dep: departure("10:12", NOW + 12 * 60_000, { routeShort: "2" }), dir: main2 },
    { dep: departure("10:02", NOW + 2 * 60_000, { routeShort: "2" }), dir: main2 },
  ]),
];

// 1. Kursy już odjechane nie trafiają na tablicę.
const rows = nextDepartures(groups, { nowMs: NOW });
assert.ok(!rows.some((row) => row.clock === "09:50"), "kurs z przeszłości na tablicy");

// 2. Sortowanie po czasie prognozowanym: 10:02 → 10:05 → 10:12 → 10:10+5 min GPS (=10:15) → 10:35.
assert.deepEqual(
  rows.map((row) => row.line),
  ["2", "9", "2", "9", "9"],
);
assert.deepEqual(
  rows.map((row) => row.clock),
  ["10:02", "10:05", "10:12", "10:10", "10:35"],
);
assert.equal(rows[3].etaMs, NOW + 15 * 60_000, "GPS musi przesuwać czas odjazdu");
assert.equal(rows[3].minutes, 15);

// 3. Odliczanie i formatowanie.
assert.equal(rows[0].minutes, 2);
assert.equal(formatEta(0), "teraz");
assert.equal(formatEta(1), "za 1 min");
assert.equal(formatEta(59), "za 59 min");
assert.equal(formatEta(60), "za 1 h");
assert.equal(formatEta(75), "za 1 h 15 min");
assert.equal(minutesUntil(NOW + 90_000, NOW), 1);
assert.equal(minutesUntil(NOW - 90_000, NOW), 0);

// 4. Kolory punktualności (myBus 3.0: kolor + legenda pod listą).
const late = rows.find((row) => row.clock === "10:10")!;
assert.equal(late.tone, "late-high");
assert.match(late.toneStyle.label, /powyżej 3 min/);
assert.equal(rows.find((row) => row.clock === "10:05")!.tone, "early-small");
assert.equal(rows.find((row) => row.clock === "10:02")!.isRealtime, false);
assert.deepEqual(
  PUNCTUALITY_LEGEND.map((entry) => entry.tone),
  ["early-small", "late", "late-high", "early-big"],
);

// 5. Limit 10 odjazdów, tak jak na tablicy myBus.
const many: DepartureLineGroup[] = [
  group(
    "9",
    [main9],
    Array.from({ length: 25 }, (_, index) => ({
      dep: departure(
        `1${String(Math.floor(index / 6)).padStart(1, "0")}:${String((index % 6) * 10).padStart(2, "0")}`,
        NOW + (index + 1) * 60_000,
      ),
      dir: main9,
    })),
  ),
];
assert.equal(nextDepartures(many, { nowMs: NOW }).length, 10);
assert.equal(nextDepartures(many, { nowMs: NOW, limit: 3 }).length, 3);

// 6. Legenda pod listą: tylko litery z oficjalnym opisem, bez duplikatów.
assert.deepEqual(boardLegend([group("9", [main9, variant9], [])]), [
  { line: "9", code: "a", text: "kurs przedłużony do przystanku Podwale - Forteczna" },
]);
assert.deepEqual(boardLegend([group("2", [main2], [])]), []);

console.log("OK: tablica najbliższych odjazdów, odliczanie, kolory i legenda");
