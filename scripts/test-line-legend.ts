import assert from "node:assert/strict";
import { groupDeparturesByLine } from "../src/lib/departureGroups";
import {
  hasLineLegend,
  legendCodeForTrip,
  legendLines,
  legendText,
  lineLegend,
} from "../src/lib/lineLegend";
import { timetableLegendRows, timetableLegendText, timetableLineLabel, timetableVariantCode, type TimetablePdfTrip } from "../src/lib/engine/dutyTimetablePdf";
import type { BrigadeTripView } from "../src/lib/engine/brigades";
import type { TimetablePdfDuty } from "../src/lib/engine/dutyTimetablePdf";
import type { StopDepartureItem } from "../src/lib/types";

/**
 * Oficjalna legenda ustalona przez użytkownika — dokładnie te litery i opisy.
 * Ten test jest strażnikiem: każda zmiana tekstu lub litery wymaga decyzji.
 */
const SPEC: Record<string, Array<[string, string]>> = {
  "2": [
    ["b", "kurs przedłużony do Boguszowa-Gorc"],
    ["k", "kurs przedłużony do Kuźnic"],
    ["d", "kurs przedłużony do Dzikowca przez Kuźnice"],
    ["p", "kurs tylko do Placu Grunwaldzkiego"],
    ["v", "kurs przez Galerię Victoria"],
  ],
  "5": [
    ["*", "kurs do Głuszycy Górnej przez Jedlinę-Zdrój"],
    ["^", "kurs przez Jedlinę-Zdrój (Uzdrowisko)"],
    ["e", "kurs do Głuszycy przez Jedlinę-Zdrój"],
    ["u", "kurs do Jedliny-Zdroju /Uzdrowisko/"],
    ["k", "kurs do ul. Kolejowej w Szczawnie-Zdroju"],
  ],
  "8": [
    ["a", "kurs przez Al. Podwale"],
    ["l", "kurs do Lubiechowa"],
    ["z", "kurs do Zamku Książ przez Lubiechów"],
    ["d", "kurs do Dworca Miasto"],
    ["g", "kurs przez St. Bogaczowice do Gostkowa"],
    ["s", "kurs przedłużony do Strugi"],
    ["y", "kurs do Gostkowa przez Chwaliszów i Stare Bogaczowice"],
  ],
  "9": [["s", "kurs przez ul. Sokołowskiego - Szpital"]],
  "12": [
    ["a", "kurs przedłużony do Andrzejówki"],
    ["d", "kurs do Dworca Głównego PKP"],
    ["p", "kurs tylko do Śródmieścia"],
  ],
  "15": [
    ["p", "kurs tylko do Placu Grunwaldzkiego"],
    ["t", "kurs przez ul. Batorego"],
    ["a", "kurs przez Sokołowsko, Mieroszów do Golińska"],
    ["b", "kurs przez ul. Beethovena"],
    ["m", "kurs przez Sokołowsko do Mieroszowa"],
    ["z", "kurs do ul. Beethovena (MZUK)"],
  ],
  "18": [
    ["q", "kurs do ul. Ratuszowej /Aqua Zdroju/"],
    ["j", "kurs do ul. Uczniowskiej i ul. Jachimowicza"],
    ["m", "kurs do ul. Uczniowskiej (Mando)"],
    ["r", "kurs do ul. Uczniowskiej (Ronal)"],
    ["t", "kurs do ul. Uczniowskiej (Toyota)"],
    ["u", "kurs do ul. Uczniowskiej (Urząd Skarbowy)"],
  ],
  "19": [["s", "kurs przez ul. Sokołowskiego - Szpital"]],
  A: [
    ["a", "kurs przez Auchan"],
    ["s", "kurs przez ul. Sokołowskiego - Szpital"],
  ],
  C: [
    ["a", "kurs przez Auchan"],
    ["v", "kurs przez Galerię Victoria"],
  ],
  EX: [["v", "kurs przez Galerię Victoria"]],
};

// 1. Legenda w kodzie = legenda z rozpiski (litery i opisy, bez zmian).
assert.deepEqual(new Set(legendLines()), new Set(Object.keys(SPEC)));
for (const [line, entries] of Object.entries(SPEC)) {
  const legend = lineLegend(line);
  assert.ok(legend, `linia ${line} ma legendę`);
  assert.deepEqual(
    legend.map(({ code, text }) => [code, text]),
    entries,
    `legenda linii ${line}: litery, opisy i kolejność jak w rozpiski`,
  );
  for (const [code, text] of entries) assert.equal(legendText(line, code), text);
}
assert.equal(hasLineLegend("11"), false, "linie spoza rozpiski nie dostają wymyślonych liter");
assert.equal(legendCodeForTrip("11", { destination: "Głuszyca" }), "");

// 2. Rozpoznawanie wariantów po kierunku i trasie.
const code = (line: string, destination: string, stops: string[] = []) =>
  legendCodeForTrip(line, { destination, stops });
assert.equal(code("2", "Boguszów-Gorce Dworzec"), "b");
assert.equal(code("2", "Wałbrzych Kuźnice"), "k");
assert.equal(code("2", "Dzikowiec"), "d");
assert.equal(code("2", "Plac Grunwaldzki"), "p");
assert.equal(code("2", "Boguszów-Gorce", ["Bystrzycka", "Galeria Victoria"]), "b");
assert.equal(code("2", "Szczawienko", ["Rynek", "Galeria Victoria"]), "v");
assert.equal(code("5", "Głuszyca Górna"), "*");
assert.equal(code("5", "Głuszyca"), "e");
assert.equal(code("5", "Jedlina-Zdrój Uzdrowisko"), "u");
assert.equal(code("5", "Jedlina-Zdrój", ["Jedlina-Zdrój Uzdrowisko"]), "^");
assert.equal(code("5", "Szczawno-Zdrój ul. Kolejowa"), "k");
assert.equal(code("8", "Gostków", ["Stare Bogaczowice"]), "g");
assert.equal(code("8", "Gostków", ["Chwaliszów", "Stare Bogaczowice"]), "y");
assert.equal(code("8", "Lubiechów"), "l");
assert.equal(code("8", "Zamek Książ", ["Lubiechów"]), "z");
assert.equal(code("8", "Dworzec Miasto"), "d");
assert.equal(code("8", "Struga"), "s");
assert.equal(code("8", "Szczawienko", ["Al. Podwale"]), "a");
assert.equal(code("9", "Szczawienko", ["Szpital"]), "s");
assert.equal(code("12", "Andrzejówka"), "a");
assert.equal(code("12", "Dworzec Główny PKP"), "d");
assert.equal(code("12", "Śródmieście"), "p");
assert.equal(code("15", "Golińsk", ["Sokołowsko", "Mieroszów"]), "a");
assert.equal(code("15", "Mieroszów", ["Sokołowsko"]), "m");
assert.equal(code("15", "ul. Beethovena (MZUK)"), "z");
assert.equal(code("15", "Biały Kamień", ["ul. Beethovena"]), "b");
assert.equal(
  code("15", "Biały Kamień przez ul. Beethovena", ["ul. Beethovena"]),
  "b",
  "„przez ul. Beethovena” w kierunku to trasa, nie kurs do Beethovena (z)",
);
assert.equal(code("8", "Gostków przez Chwaliszów", ["Chwaliszów", "Stare Bogaczowice"]), "y");
assert.equal(code("15", "Biały Kamień", ["ul. Batorego"]), "t");
assert.equal(code("15", "Plac Grunwaldzki"), "p");
assert.equal(code("18", "ul. Ratuszowa /Aqua Zdrój/"), "q");
assert.equal(code("18", "ul. Uczniowska i ul. Jachimowicza"), "j");
assert.equal(code("18", "ul. Uczniowska (Mando)"), "m");
assert.equal(code("18", "ul. Uczniowska (Ronal)"), "r");
assert.equal(code("18", "ul. Uczniowska (Toyota)"), "t");
assert.equal(code("18", "ul. Uczniowska (Urząd Skarbowy)"), "u");
assert.equal(code("19", "Podzamcze", ["Szpital"]), "s");
assert.equal(code("A", "Centrum", ["Auchan"]), "a");
assert.equal(code("A", "Centrum", ["Szpital"]), "s");
assert.equal(code("C", "Centrum", ["Auchan"]), "a");
assert.equal(code("C", "Centrum", ["Galeria Victoria"]), "v");
assert.equal(code("EX", "Centrum", ["Galeria Victoria"]), "v");
assert.equal(code("8", "Lubiechów"), "l", "kurs podstawowy bez wariantu trasy zostaje bez litery");

// 3. Rozkład na przystanku: litery wyłącznie z legendy, kurs podstawowy bez litery.
const departure = (
  line: string,
  finalStop: string,
  clock: string,
  minutes: number,
  legendCode?: string,
): StopDepartureItem => ({
  tripId: `${line}-${clock}-${finalStop}`,
  serviceDateId: "20261120",
  kursowkaId: "",
  kursowka: "",
  brigadeSource: "none",
  routeShort: line,
  routeColor: "#0d4f3b",
  routeTextColor: "#ffffff",
  routeLong: `Linia ${line}`,
  headsign: finalStop,
  finalStop,
  legendCode,
  legendText: legendCode ? legendText(line, legendCode) : "",
  direction: 0,
  minutes,
  atMs: minutes * 60_000,
  clock,
  dateLabel: "",
  isRealtime: false,
  delaySeconds: 0,
  vehicleId: null,
  operatorName: null,
  operatorKey: null,
});

const groups = groupDeparturesByLine([
  departure("2", "Bystrzycka", "10:00", 600, ""),
  departure("2", "Bystrzycka", "10:30", 630, ""),
  departure("2", "Boguszów-Gorce Dworzec", "11:00", 660, "b"),
  departure("2", "Dzikowiec", "11:40", 700, "d"),
  departure("2", "Szczawienko", "12:10", 730, "v"),
  departure("5", "Głuszyca Górna", "13:00", 780, "*"),
  departure("8", "Gostków", "14:00", 840, "y"),
  departure("11", "Głuszyca", "15:00", 900, ""),
  departure("11", "Głuszyca", "15:20", 920, ""),
  departure("11", "Głuszyca", "15:40", 940, ""),
  departure("11", "Głuszyca", "16:00", 960, ""),
  departure("11", "Głuszyca Górna", "16:30", 990, ""),
]);
const line2 = groups.find((group) => group.line === "2")!;
assert.deepEqual(
  line2.directions.map(({ suffix, main, legendText: text }) => [suffix, main, text ?? ""]),
  [
    ["", true, ""],
    ["b", false, "kurs przedłużony do Boguszowa-Gorc"],
    ["d", false, "kurs przedłużony do Dzikowca przez Kuźnice"],
    ["v", false, "kurs przez Galerię Victoria"],
  ],
  "linia 2: podstawa bez litery + litery z legendy w jej kolejności",
);
assert.deepEqual(
  line2.departures.map(({ direction }) => direction.suffix),
  ["", "", "b", "d", "v"],
);
const line5 = groups.find((group) => group.line === "5")!;
assert.deepEqual(line5.directions.map(({ suffix }) => suffix), ["*"], "linia 5 używa znaku * z legendy");
const line11 = groups.find((group) => group.line === "11")!;
assert.deepEqual(
  line11.directions.map(({ suffix }) => suffix),
  ["", "g"],
  "linia bez legendy zachowuje dotychczasowy podział na kierunek główny i odchylenia",
);

// 4. Wydruk: numer linii z literą wariantu, bez „/ZJ*”, legenda użytych liter.
const pdfTrip = (line: string, destination: string, stops: string[]): TimetablePdfTrip => ({
  trip: {
    id: `${line}-${destination}`,
    lineId: line,
    destination,
    length: 0,
    startMs: 0,
    endMs: 0,
    firstStop: { id: "a", name: stops[0] ?? destination },
    lastStop: { id: "b", name: stops.at(-1) ?? destination },
  } as BrigadeTripView,
  stops: stops.map((name) => ({ name, arrival: 0, departure: 0 })),
});
const struga = pdfTrip("8", "Struga", ["Szczawienko", "Struga"]);
assert.equal(timetableVariantCode(struga), "s");
assert.equal(timetableLineLabel(struga), "8s");
const boguszow = pdfTrip("2", "Boguszów-Gorce", ["Bystrzycka", "Boguszów-Gorce"]);
assert.equal(timetableLineLabel(boguszow), "2b");
assert.equal(timetableLineLabel(pdfTrip("11", "Głuszyca", ["A", "Głuszyca"])), "11");
assert.equal(timetableLineLabel(pdfTrip("WY", "Zajezdnia", ["Zajezdnia", "A"])), "WY");
const duty = {
  item: { unassigned: false } as never,
  trips: [
    boguszow,
    pdfTrip("8", "Struga", ["Bystrzycka", "Struga"]),
    pdfTrip("8", "Gostków", ["Chwaliszów", "Stare Bogaczowice", "Gostków"]),
    pdfTrip("8", "Bystrzycka", ["Struga", "Bystrzycka"]),
  ],
} as TimetablePdfDuty;
assert.deepEqual(timetableLegendRows(duty), [
  { line: "2", code: "b", text: "kurs przedłużony do Boguszowa-Gorc" },
  { line: "8", code: "s", text: "kurs przedłużony do Strugi" },
  { line: "8", code: "y", text: "kurs do Gostkowa przez Chwaliszów i Stare Bogaczowice" },
]);

assert.equal(
  timetableLegendText(duty),
  "Legenda wariantów: 2: b – kurs przedłużony do Boguszowa-Gorc · 8: s – kurs przedłużony do Strugi, y – kurs do Gostkowa przez Chwaliszów i Stare Bogaczowice",
  "stopka wydruku opisuje każdą literę użytego wariantu",
);

console.log("official line legends, stop timetables and print labels are normalized");
