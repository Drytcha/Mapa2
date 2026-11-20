/**
 * Oficjalna legenda wariantów kursów (litery przy numerze linii).
 *
 * Jedno źródło prawdy dla rozkładów na przystankach, legend pod linią oraz
 * wydruków PDF (kursówki i rozkłady linii). Litery NIE są już zgadywane
 * z pierwszej litery kierunku: każda linia ma zamkniętą listę wariantów,
 * a kurs bez litery jest kursem podstawowym.
 *
 * Dopasowanie wariantu:
 *  - `to`  – wzorce w kierunku kursu (GTFS trip_headsign / nazwa ostatniego
 *            przystanku); `headsign` jest używany tylko wtedy, gdy kierunku
 *            brakuje, żeby „przez …” w opisie nie udawało celu,
 *  - `via` – wzorce w nazwach przystanków, przez które kurs przejeżdża.
 *
 * Wzorce są porównywane po złożeniu polskich znaków (`foldStopKey`), więc
 * „Głuszyca Górna”, „GLUSZYCA GORNA” i „głuszyca  górna” pasują tak samo.
 * Kolejność wpisów ma znaczenie: pierwszy pasujący wariant wygrywa.
 */

import { foldStopKey } from "./core/text";

export interface LineLegendEntry {
  /** Litera (lub znak, np. `*` i `^` na linii 5) wg oficjalnej legendy. */
  code: string;
  /** Opis wariantu bez litery, np. „kurs przedłużony do Boguszowa-Gorc”. */
  text: string;
}

export interface LineLegendRule extends LineLegendEntry {
  /** Wzorce kierunku (końcowy przystanek / trip_headsign). */
  to?: readonly string[];
  /** Wzorce przystanków na trasie — wymagane wszystkie. */
  via?: readonly string[];
}

/** Kolejność linii w legendzie wydruku. */
const LINE_ORDER = ["2", "5", "8", "9", "12", "15", "18", "19", "A", "C", "EX"];

/**
 * Linie 9 i 19 mają tę samą oficjalną legendę. Kolejność dopasowania ma
 * znaczenie: kurs do Jachimowicza (Faurecia) musi trafić w `j` przed ogólnym
 * „Jachimowicza” (`c`).
 */
const LINE_9_19_RULES: readonly LineLegendRule[] = [
  { code: "j", text: "kurs do ul. Jachimowicza (Faurecia)", to: ["faurecia"] },
  { code: "c", text: "kurs do ul. Jachimowicza", to: ["jachimowicz"] },
  {
    code: "a",
    text: "kurs do przystanku Podwale - Forteczna",
    to: ["forteczna"],
  },
  { code: "d", text: "kurs do Dworca Szczawienko", to: ["szczawienko"] },
];

const RULES: Record<string, readonly LineLegendRule[]> = {
  "2": [
    { code: "b", text: "kurs przedłużony do Boguszowa-Gorc", to: ["boguszow"] },
    {
      code: "d",
      text: "kurs przedłużony do Dzikowca przez Kuźnice",
      to: ["dzikowiec"],
    },
    { code: "k", text: "kurs przedłużony do Kuźnic", to: ["kuznic"] },
    {
      code: "p",
      text: "kurs tylko do Placu Grunwaldzkiego",
      to: ["grunwaldzk"],
    },
    {
      code: "v",
      text: "kurs przez Galerię Victoria",
      via: ["victoria"],
    },
  ],
  "5": [
    {
      code: "*",
      text: "kurs do Głuszycy Górnej przez Jedlinę-Zdrój",
      to: ["gluszyca gorna"],
    },
    {
      code: "u",
      text: "kurs do Jedliny-Zdroju /Uzdrowisko/",
      to: ["uzdrowisko"],
    },
    {
      code: "^",
      text: "kurs przez Jedlinę-Zdrój (Uzdrowisko)",
      via: ["uzdrowisko"],
    },
    {
      code: "e",
      text: "kurs do Głuszycy przez Jedlinę-Zdrój",
      to: ["gluszyca"],
    },
    {
      code: "k",
      text: "kurs do ul. Kolejowej w Szczawnie-Zdroju",
      to: ["kolejow"],
    },
  ],
  "8": [
    {
      code: "y",
      text: "kurs do Gostkowa przez Chwaliszów i Stare Bogaczowice",
      to: ["gostkow"],
      via: ["chwaliszow"],
    },
    {
      code: "g",
      text: "kurs przez St. Bogaczowice do Gostkowa",
      to: ["gostkow"],
      via: ["bogaczowice"],
    },
    {
      code: "z",
      text: "kurs do Zamku Książ przez Lubiechów",
      to: ["ksiaz"],
    },
    { code: "l", text: "kurs do Lubiechowa", to: ["lubiechow"] },
    { code: "d", text: "kurs do Dworca Miasto", to: ["dworzec miasto"] },
    {
      code: "s",
      text: "kurs przedłużony do Strugi",
      to: ["struga"],
    },
    {
      code: "a",
      text: "kurs przez Al. Podwale",
      via: ["podwale"],
    },
  ],
  "9": LINE_9_19_RULES,
  "12": [
    {
      code: "a",
      text: "kurs przedłużony do Andrzejówki",
      to: ["andrzejowka"],
    },
    {
      code: "d",
      text: "kurs do Dworca Głównego PKP",
      to: ["dworzec glowny", "dworzec pkp"],
    },
    {
      code: "p",
      text: "kurs tylko do Śródmieścia",
      to: ["srodmiescie"],
    },
  ],
  "15": [
    {
      code: "a",
      text: "kurs przez Sokołowsko, Mieroszów do Golińska",
      to: ["golinsk"],
    },
    { code: "m", text: "kurs przez Sokołowsko do Mieroszowa", to: ["mieroszow"] },
    {
      code: "z",
      text: "kurs do ul. Beethovena (MZUK)",
      to: ["beethoven"],
    },
    {
      code: "p",
      text: "kurs tylko do Placu Grunwaldzkiego",
      to: ["grunwaldzk"],
    },
    {
      code: "b",
      text: "kurs przez ul. Beethovena",
      via: ["beethoven"],
    },
    {
      code: "t",
      text: "kurs przez ul. Batorego",
      via: ["batorego"],
    },
  ],
  "18": [
    {
      code: "j",
      text: "kurs do ul. Uczniowskiej i ul. Jachimowicza",
      to: ["jachimowicz"],
    },
    {
      code: "q",
      text: "kurs do ul. Ratuszowej /Aqua Zdroju/",
      to: ["ratuszow", "aqua"],
    },
    { code: "m", text: "kurs do ul. Uczniowskiej (Mando)", to: ["mando"] },
    { code: "r", text: "kurs do ul. Uczniowskiej (Ronal)", to: ["ronal"] },
    { code: "t", text: "kurs do ul. Uczniowskiej (Toyota)", to: ["toyota"] },
    {
      code: "u",
      text: "kurs do ul. Uczniowskiej (Urząd Skarbowy)",
      to: ["urzad skarbowy"],
    },
  ],
  "19": LINE_9_19_RULES,
  A: [
    { code: "a", text: "kurs przez Auchan", via: ["auchan"] },
    {
      code: "s",
      text: "kurs przez ul. Sokołowskiego - Szpital",
      via: ["szpital"],
    },
  ],
  C: [
    { code: "a", text: "kurs przez Auchan", via: ["auchan"] },
    { code: "v", text: "kurs przez Galerię Victoria", via: ["victoria"] },
  ],
  EX: [{ code: "v", text: "kurs przez Galerię Victoria", via: ["victoria"] }],
};

/**
 * Kolejność druku legendy — dokładnie taka, jak w oficjalnej rozpiski.
 * Kolejność dopasowania w `RULES` jest inna (najpierw warianty końcowe,
 * potem „przez …”), żeby kurs nie dostał litery tylko dlatego, że mija
 * przystanek innego wariantu.
 */
const DISPLAY_ORDER: Record<string, readonly string[]> = {
  "2": ["b", "k", "d", "p", "v"],
  "5": ["*", "^", "e", "u", "k"],
  "8": ["a", "l", "z", "d", "g", "s", "y"],
  "9": ["a", "d", "c", "j"],
  "12": ["a", "d", "p"],
  "15": ["p", "t", "a", "b", "m", "z"],
  "18": ["q", "j", "m", "r", "t", "u"],
  "19": ["a", "d", "c", "j"],
  A: ["a", "s"],
  C: ["a", "v"],
  EX: ["v"],
};

const normalizeLine = (line: string) => line.trim().toUpperCase();

/** Warianty oficjalnej legendy linii (w kolejności druku) albo `null`. */
export function lineLegend(line: string): LineLegendEntry[] | null {
  const key = normalizeLine(line);
  const rules = RULES[key];
  if (!rules) return null;
  const order = DISPLAY_ORDER[key] ?? rules.map((rule) => rule.code);
  return [...rules]
    .sort(
      (a, b) =>
        order.indexOf(a.code) - order.indexOf(b.code) ||
        a.code.localeCompare(b.code, "pl"),
    )
    .map(({ code, text }) => ({ code, text }));
}

/** Opis wariantu (bez litery) albo `""`, gdy litera nie jest znana. */
export function legendText(line: string, code: string): string {
  const rules = RULES[normalizeLine(line)];
  if (!rules || !code) return "";
  return rules.find((rule) => rule.code === code)?.text ?? "";
}

/** Czy linia ma warianty zależne od trasy (potrzebna lista przystanków)? */
export function lineLegendNeedsStops(line: string): boolean {
  const rules = RULES[normalizeLine(line)];
  return Boolean(rules?.some((rule) => rule.via?.length));
}

/** Czy linia ma jakąkolwiek oficjalną legendę? */
export function hasLineLegend(line: string): boolean {
  return Boolean(RULES[normalizeLine(line)]);
}

/** Wszystkie linie z oficjalną legendą, w kolejności wydruku. */
export function legendLines(): string[] {
  return [...LINE_ORDER];
}

/**
 * Litera oficjalnego wariantu dla kursu; `""` = kurs podstawowy (bez litery).
 *
 * `stops` jest opcjonalne: bez niego rozpoznawane są tylko warianty końcowe
 * (`to`). Źródła bez pełnej trasy (np. rozkład awaryjny) nie dostają
 * wymyślonych liter — zostają przy kierunku podstawowym.
 */
export function legendCodeForTrip(
  line: string,
  trip: {
    destination?: string;
    headsign?: string;
    stops?: readonly string[];
  },
): string {
  const rules = RULES[normalizeLine(line)];
  if (!rules) return "";
  // „… przez cokolwiek” opisuje trasę, nie cel — do litery wariantu liczy się
  // tylko końcowy przystanek, inaczej „przez ul. Beethovena” udawałoby kurs
  // kończący się na Beethovena.
  const destination = (trip.destination || trip.headsign || "").replace(
    /\s+(?:przez|via)\s+.*$/iu,
    "",
  );
  const target = foldStopKey(destination);
  const route = (trip.stops ?? []).map(foldStopKey).filter(Boolean);
  for (const rule of rules) {
    if (rule.to && (!target || !rule.to.some((pattern) => target.includes(pattern)))) {
      continue;
    }
    if (rule.via) {
      if (!route.length) continue;
      if (!rule.via.every((pattern) => route.some((stop) => stop.includes(pattern)))) continue;
    }
    return rule.code;
  }
  return "";
}

/** Etykieta kursu do wydruku: numer linii + litera wariantu (np. `2b`). */
export function legendLineLabel(line: string, code: string): string {
  const clean = line.trim();
  return code ? `${clean}${code}` : clean;
}
