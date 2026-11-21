import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import GtfsSchedule, {
  NextDeparturesBoard,
  StopBoardLegend,
} from "../src/components/GtfsSchedule";
import type { DepartureDirection, DepartureLineGroup } from "../src/lib/departureGroups";
import type { StopDepartureItem } from "../src/lib/types";

/**
 * Widok przystanku w stylu myBus 3.0: kolejność zakładek, tablica najbliższych
 * odjazdów z kropką punktualności i zwijana legenda oznaczeń.
 */

const NOW = Date.UTC(2026, 10, 20, 9, 0, 0);

const main: DepartureDirection = {
  key: "main",
  label: "Wałbrzych Główny",
  suffix: "",
  main: true,
  count: 3,
};
const variant: DepartureDirection = {
  key: "a",
  label: "Wałbrzych Główny",
  suffix: "a",
  main: false,
  count: 1,
  legendText: "kurs przedłużony do przystanku Podwale - Forteczna",
};

function departure(
  clock: string,
  offsetMinutes: number,
  extra: Partial<StopDepartureItem> = {},
): StopDepartureItem {
  return {
    tripId: `t-${clock}`,
    canPreviewCourse: false,
    serviceDateId: "20261120",
    kursowkaId: "k1",
    kursowka: "9/01",
    brigadeSource: "gtfs",
    routeShort: "9",
    routeColor: "#123456",
    routeTextColor: "#ffffff",
    routeLong: "Linia 9",
    headsign: "Wałbrzych Główny",
    finalStop: "Wałbrzych Główny",
    legendCode: "",
    direction: 0,
    minutes: offsetMinutes,
    atMs: NOW + offsetMinutes * 60_000,
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

const groups: DepartureLineGroup[] = [
  {
    line: "9",
    color: "#123456",
    textColor: "#ffffff",
    directions: [main, variant],
    departures: [
      { departure: departure("10:05", 5), direction: main },
      {
        departure: departure("10:20", 20, { isRealtime: true, delaySeconds: 600 }),
        direction: variant,
      },
      { departure: departure("09:55", -5), direction: main },
    ],
  },
];

// 1. Tablica: tylko przyszłe kursy, godzina + litera, odliczanie, kropka GPS.
const board = renderToStaticMarkup(
  <NextDeparturesBoard groups={groups} now={NOW} />,
);
assert.match(board, /10:05/);
assert.match(board, /za 5 min/);
assert.match(board, /przewidywany 10:30/);
assert.match(board, /za 30 min/);
assert.ok(!board.includes("09:55"), "kurs z przeszłości nie może być na tablicy");
assert.match(board, /data-testid="board-departure"/);
assert.match(board, /Kolory punktualności|Opóźnienie powyżej 3 min/);
// Opóźniony kurs pokazuje godzinę prognozowaną, nie planową.
assert.ok(!board.includes(">10:20<"), "przy GPS pokazujemy czas prognozowany");
assert.match(board, /aria-label="Opóźnienie powyżej 3 min"/);

// 2. Legenda: litery użyte w widoku, opisy kolorów i kurs podstawowy.
const legend = renderToStaticMarkup(<StopBoardLegend groups={groups} />);
assert.match(legend, /Litery wariantów/);
assert.match(legend, /kurs przedłużony do przystanku Podwale - Forteczna/);
assert.match(legend, /\(linia 9\)/);
assert.match(legend, /Kolory punktualności/);
assert.match(legend, /Opóźnienie do 3 min/);
assert.match(legend, /Na czas \/ przyspieszenie do 1 min/);
assert.match(legend, /Brak prognozy GPS \(czas z rozkładu\)/);
assert.match(legend, /Kurs bez litery = kurs podstawowy/);
assert.ok(
  !/Boguszowa-Gorc/.test(legend),
  "legenda nie może wracać do błędnego kursu do Boguszowa-Gorc",
);

// 3. Karta przystanku ma trzy zakładki w kolejności: Najbliższe, Cały dzień, Od teraz.
const card = renderToStaticMarkup(
  <GtfsSchedule
    stop={{
      id: "s1",
      name: "Piłsudskiego - Plac Tuwima",
      lat: 50.78,
      lon: 16.28,
      lines: ["9"],
    }}
  />,
);
const order = ["Najbliższe", "Cały dzień", "Od teraz"].map((label) =>
  card.indexOf(`>${label}</button>`),
);
assert.ok(order.every((index) => index > 0), `brak zakładki: ${order.join(",")}`);
assert.deepEqual([...order].sort((a, b) => a - b), order, "zła kolejność zakładek");
assert.match(card, /data-testid="tab-next"/);

console.log("OK: zakładki, tablica najbliższych odjazdów i legenda oznaczeń");
