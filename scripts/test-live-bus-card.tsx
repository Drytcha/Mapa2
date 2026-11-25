import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import LiveBusRunPanel from "../src/components/LiveBusRunPanel";
import { LiveBusCard } from "../src/components/MapOverlays";
import type { VehicleTripStop } from "../src/lib/engine/gtfsStore";

/**
 * Karta pojazdu w stylu myBus 3.0: lista „Odjazdy” pokazuje **wszystkie**
 * przystanki kursu, przebyte wyszarzone, autobus oznaczony na osi,
 * godzina planowa + prognoza GPS, legenda kolorów pod listą.
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
  return { sequence, name, scheduledArrival: ms, scheduledDeparture: ms, passed };
}

const stops: VehicleTripStop[] = [
  stop(1, "Wałbrzych Rynek", 10, 0, true),
  stop(2, "Piaskowa Góra", 10, 12, true),
  stop(3, "Podzamcze", 10, 22),
  stop(4, "Szczawienko", 10, 30),
  stop(5, "Kozice", 10, 40),
];

const html = renderToStaticMarkup(
  <LiveBusRunPanel
    stops={stops}
    complete
    loading={false}
    delaySeconds={120}
    isRealtime
  />,
);

// 1. Cała trasa: 5 przystanków, w tym 2 przebyte.
assert.equal((html.match(/data-testid="trip-stop"/g) ?? []).length, 5);
assert.equal((html.match(/data-status="passed"/g) ?? []).length, 2);
assert.equal((html.match(/data-status="current"/g) ?? []).length, 1);
assert.equal((html.match(/data-status="next"/g) ?? []).length, 1);
assert.equal((html.match(/data-status="final"/g) ?? []).length, 1);

// 2. Przebyte przystanki nie znikają z listy i są wyszarzone (przekreślone).
const passedRow = html.slice(html.indexOf('data-status="passed"'));
assert.match(passedRow, /Wałbrzych Rynek/);
assert.match(passedRow, /line-through/);

// 3. Autobus jest zaznaczony na osi, końcowy podpisany.
assert.match(html, /tu jest/);
assert.match(html, /końcowy/);

// 4. Godzina planowa i prognoza GPS (10:22 planowo → 10:24 z +2 min opóźnienia).
assert.match(html, /11:22/);
assert.match(html, /11:24/);
const predictedChip = html.match(/background:#fca5a5[^>]*>11:24</);
assert.ok(predictedChip, "prognoza powinna dostać kolor punktualności");

// 5. Legenda kolorów pod listą, razem ze stanem „czeka na odjazd”.
assert.match(html, /Legenda punktualności/);
assert.match(html, /Czeka na odjazd/);
assert.match(html, /Opóźnienie powyżej 3 min/);
assert.match(html, /Brak GPS/);
assert.match(html, /Godzina z lewej — rozkład, kolorowa obok — prognoza GPS/);

// 6. Gdy kursu nie ma w paczce, karta mówi o tym wprost — nie zmyśla przebytych.
const partial = renderToStaticMarkup(
  <LiveBusRunPanel
    stops={stops.filter((item) => !item.passed)}
    complete={false}
    loading={false}
    delaySeconds={0}
    isRealtime={false}
  />,
);
assert.match(partial, /pokazano tylko przystanki z GPS/);
assert.ok(!partial.includes('data-status="passed"'));

// 7. Puste dane: komunikat zamiast pustej listy.
const empty = renderToStaticMarkup(
  <LiveBusRunPanel
    stops={[]}
    complete={false}
    loading
    delaySeconds={0}
    isRealtime={false}
  />,
);
assert.match(empty, /Wczytywanie przebiegu kursu/);

// 8. Cała karta pojazdu: kierunek, chipsy stanu, zakładki Odjazdy/Szczegóły.
const bus = {
  vehicleId: "1234",
  model: "Solaris Urbino 12",
  operatorKey: "mzuk" as const,
  operatorName: "MZUK",
  operatorSource: "auto" as const,
  routeName: "9",
  routeColor: "#1e6fbf",
  brigade: "01",
  dutyCode: "9/01",
  dutyStatus: "confirmed" as const,
  dutyLine: "9",
  dutySource: "trip" as const,
  kursowka: "9/01",
  tripId: "t1",
  lat: 50.78,
  lon: 16.28,
  bearing: null,
  delaySeconds: 120,
  speedKmh: 32,
  headsign: "Kozice",
  timestamp: at(10, 20),
  upcomingStops: [
    {
      sequence: 3,
      name: "Podzamcze",
      scheduledArrival: at(10, 22),
      scheduledDeparture: at(10, 22),
    },
  ],
};
const card = renderToStaticMarkup(
  <LiveBusCard
    bus={bus}
    onClose={() => undefined}
    onOpenKursowka={() => undefined}
    onCenter={() => undefined}
    onSetOperator={() => undefined}
  />,
);
assert.match(card, /Kozice/, "kierunek kursu w nagłówku");
assert.match(card, /Pojazd #1234/);
assert.match(card, /Zadanie 9\/01/);
assert.match(card, /data-testid="bus-pane-odjazdy"/);
assert.match(card, /data-testid="bus-pane-szczegoly"/);
assert.match(card, /max-sm:max-h-\[38dvh\]/, "karta podróżnego zajmuje mniej wysokości na telefonie");
const compactRun = renderToStaticMarkup(
  <LiveBusRunPanel
    stops={stops}
    complete
    loading={false}
    delaySeconds={120}
    isRealtime
    compact
  />,
);
assert.match(compactRun, /max-h-\[130px\]/, "lista kursu w widoku podróżnego jest bardziej kompaktowa");
// Domyślnie otwarta jest lista „Odjazdy” (myBus 3.0), a nie szczegóły.
assert.match(
  card,
  /aria-pressed="true"[^>]*data-testid="bus-pane-odjazdy"|data-testid="bus-pane-odjazdy"[^>]*aria-pressed="true"/,
);

console.log("OK: karta przebiegu kursu — wszystkie przystanki, oś, GPS, legenda, zakładki");
