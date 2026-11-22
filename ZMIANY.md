# Zmiany względem `Drytcha/Mapa2` (v0.32)

## 1. Brygady 30/01 i 30/02 „uciekły" od 1 grudnia

**Przyczyna.** Workflow `deploy.yml` wdrażał `GTFS/ST/GTFS.zip`. To wariant publiczny,
który **nie zawiera linii 30** (ani linii planistycznych S1–S4). Aplikacja (i API w
`src/app/api/transit/gtfs/route.ts`) używa `GTFS (full).zip`. Do tego przeglądarka trzymała
starą paczkę w IndexedDB do 12 h.

Sprawdzone na prawdziwym silniku (`loadBrigades`, 1.12.2026, linia 30):

| Paczka                 | Wynik                                   |
| ---------------------- | --------------------------------------- |
| `GTFS.zip` (stara)     | **0 brygad**                            |
| `GTFS (full).zip`      | **30‑01, 30‑02** (+ A‑01 jadąca linią 30) |

**Poprawki**
- `.github/workflows/deploy.yml` – pierwszy na liście jest `GTFS%20(full).zip`; zwykły
  `GTFS.zip` to tylko awaryjny zapas (z ostrzeżeniem). Build **pada**, jeśli feed obejmuje
  grudzień, a w paczce nie ma brygad `30/0x`.
- `src/lib/engine/gtfsStore.ts` – `DUTY_SCHEMA_VERSION` → `…-v3-full` (unieważnia stare cache).
- `src/lib/engine/brigadeVerification.ts` + `brigades.ts` – gdy rozkład operatora zna
  brygady, których nie ma w paczce, panel brygad pokazuje komunikat (`notice`) zamiast
  cichego braku. Brak fałszywych alarmów dla dni roboczych, sobót, niedziel handlowych i świąt.

## 2. Przerywane linie przy pokazywaniu danych kursów

**Przyczyny**
1. `shapeRepair.ts` oznaczał jako „lukę" odcinek ≥ 120 m dłuższy 3× od sąsiadów:
   **2955 luk w 483 z 513 kształtów** (56% < 250 m), przy medianie odcinka 18 m.
   Budżet zapytań OSRM się wyczerpywał, a pozostałe luki zostawały **otwarte**.
   Pomiar OSRM: ok. 90% takich odcinków to zwykła prosta droga (stosunek 1.00).
2. `MapView.tsx` rysował całą brygadę zawsze linią przerywaną `9 6` (też przybliżony kurs).
3. Obwódka każdego wariantu przecinała kolorową linię poprzedniego (wspólne ulice).
4. Oś przystanków w karcie kursu składała się z osobnych kresek 1 px.

**Poprawki**
- `shapeRepair.ts` – tylko odcinki ≥ 250 m są kandydatami do naprawy; wynik to **zawsze
  jedna ciągła linia** (nieuzupełniona luka = cięciwa), limit czasu 6 s na kształt.
- `gtfsStore.ts` / `journeyPlanner.ts` – większy limit zapytań, ciągła geometria.
- `MapView.tsx` – linia ciągła (bez `dashArray`), najpierw wszystkie obwódki, potem kolory,
  zaokrąglone końce; przybliżony kurs (sam łańcuch przystanków) jest tylko jaśniejszy.
- `CoursePreviewCard.tsx` – ciągła oś trasy 2 px w kolorze linii.

Test (`scripts/check-course.ts`, 210 kształtów, OSRM niedostępny = najgorszy przypadek):
kursy z przerwami **172 → 0**.

## Dla tej wersji (Vite)
Ta kopia działa jako statyczna strona (`dist/index.html`), bez Next.js/PostgreSQL:
`index.html` ustawia tryb statyczny, a `src/embeddedGtfs.ts` podmienia pobieranie
`data/walbrzych-gtfs.zip` na paczkę „full" wbudowaną w bundle.

Narzędzia diagnostyczne: `npx tsx scripts/check-brigades.ts <zip> 20261201 30`
oraz `npx tsx scripts/check-course.ts <zip> [online]`.

## Widoczność przystanków

- Przystanki z rozkładu są wyświetlane bez czekania na opcjonalne dane o wiatach
  z OpenStreetMap; błąd lub limit czasu tego źródła nie usuwa znaczników.
- Podczas ładowania GTFS i w przypadku jego niedostępności mapa pokazuje lokalną
  migawkę przystanków. Jest ona oznaczona jako potencjalnie nieaktualna; po
  wczytaniu GTFS zostaje zastąpiona aktualnymi danymi.
- Znaczniki są większe, kontrastowe i dostępne z klawiatury. Odświeżenie bieżącego
  widoku nie usuwa przystanków z pozostałego obszaru. Zapisany tryb „przy trasie”
  pokazuje wszystkie przystanki, dopóki trasa nie została wyznaczona.
- Paczka GTFS w `src/assets/` jest dostarczana przez workflow wdrożenia; lokalny
  build działa również bez niej, korzystając z dostępnych źródeł zapasowych.

## Wybór przystanku i rozkład

- Automatyczny pierwszy odczyt GPS nie przenosi już mapy poza sieć przystanków
  Wałbrzycha. Przycisk lokalizacji nadal pozwala świadomie wycentrować mapę na
  użytkowniku; ręczne przesunięcie lub wybranie przystanku zatrzymuje śledzenie.
- Przycisk **Przystanki** pozwala wyszukać nazwę lub linię, wybrać stanowisko
  i wrócić do niego na mapie. Gdy warstwa jest ukryta, można ją przywrócić.
- Rozkład statyczny jest pokazywany bez oczekiwania na GPS, który uzupełnia go
  później. Jeśli GTFS jest niedostępny, zbyt długo się ładuje lub nie obejmuje
  wybranej daty, aplikacja próbuje pobrać oznaczony rozkład awaryjny z
  zbiorkom.live. Ten rozkład nie obsługuje podglądu przebiegu kursu. Gdy GTFS
  nie obejmuje całego dnia, a źródło awaryjne jest niedostępne, znane kursy po
  północy z poprzedniego dnia obsługi są oznaczane jako niepełny rozkład.
- Dopasowanie stanowiska między źródłami wymaga zgodnej nazwy i położenia;
  niejednoznaczne dopasowanie nie pokazuje rozkładu sąsiedniego przystanku.
  Zmiana przystanku lub daty unieważnia wcześniejsze odpowiedzi.
- Karta przystanku ma dostępne przyciski również na wąskim ekranie, a w razie
  braku danych pokazuje komunikat zamiast pozornie pustego rozkładu.

Testy: `npm run test:stops` oraz `npm run test:stops:e2e` (dla testu przeglądarkowego
potrzebny jest Chromium, np. `npx playwright-core install chromium`, lub ścieżka
w zmiennej `CHROMIUM_PATH`). `npm run test:stops:build` sprawdza również osadzoną
paczkę w produkcyjnym, jednoplikowym buildzie pod ścieżką `/Mapa2/`. Testy
przeglądarkowe używają syntetycznej paczki GTFS oraz zapisanych odpowiedzi API,
a nie weryfikują bieżącej dostępności API ani CORS.

Mając prawdziwą paczkę, można dodatkowo uruchomić
`REAL_GTFS_ZIP=src/assets/walbrzych-gtfs.zip npm run test:stops:real`. Test sprawdza
widoczny i klikalny przystanek oraz godzinę odjazdu względem plików CSV paczki na
ekranie komputera i telefonu. Paczka musi obejmować bieżący dzień.

## Oficjalna legenda wariantów linii (jedno źródło prawdy)

Dotąd litery przy godzinach były **zgadywane** z pierwszej litery nazwy kierunku
(`11:25g → Głuszyca`), więc te same kursy miały różne oznaczenia w różnych
miejscach. Teraz litery pochodzą z jednej tabeli: `src/lib/lineLegend.ts`.

| Linia | Legenda |
| ----- | ------- |
| 2  | b – kurs przedłużony do Boguszowa-Gorc (przez Stary Lesieniec) · k – kurs przedłużony do Boguszowa-Gorc - Kuźnic · d – kurs przedłużony do Boguszowa-Gorc - Dzikowca przez Kuźnice · p – kurs tylko do Placu Grunwaldzkiego · v – kurs przez Galerię Victoria |
| 5  | \* – do Głuszycy Górnej przez Jedlinę-Zdrój · ^ – przez Jedlinę-Zdrój (Uzdrowisko) · e – do Głuszycy przez Jedlinę-Zdrój · u – do Jedliny-Zdroju /Uzdrowisko/ · k – do ul. Kolejowej w Szczawnie-Zdroju |
| 8  | a – kurs przez Al. Podwale · l – kurs przedłużony do Lubiechowa · z – kurs przedłużony do Zamku Książ przez Lubiechów · d – kurs do Dworca Miasto · g – kurs przedłużony przez Stare Bogaczowice do Gostkowa · s – kurs przedłużony do Strugi · y – kurs przedłużony do Gostkowa przez Chwaliszów i Stare Bogaczowice |
| 9  | \* – przesiadka na Uczniowska-US linią 18 · a – kurs przedłużony do przystanku Podwale - Forteczna · d – kurs do Dworca Szczawienko · s – kurs przez ul. Sokołowskiego /szpital/ · c – kurs przedłużony do ul. Jachimowicza · j – kurs przedłużony do ul. Jachimowicza (Faurecia) |
| 12 | a – kurs przedłużony do Andrzejówki · d – kurs do Dworca Głównego PKP · p – kurs tylko do Śródmieścia |
| 15 | p – kurs tylko do Placu Grunwaldzkiego · t – kurs przez ul. Batorego · a – kurs przedłużony przez Sokołowsko, Mieroszów do Golińska · b – kurs przez ul. Beethovena · m – kurs przedłużony przez Sokołowsko do Mieroszowa · z – kurs do ul. Beethovena (MZUK) |
| 18 | q – do ul. Ratuszowej /Aqua Zdroju/ · j – do ul. Uczniowskiej i ul. Jachimowicza · m – (Mando) · r – (Ronal) · t – (Toyota) · u – (Urząd Skarbowy) |
| 19 | \* – przesiadka na Uczniowska-US linią 18 · a – kurs przedłużony do przystanku Podwale - Forteczna · d – kurs do Dworca Szczawienko · s – kurs przez ul. Sokołowskiego /szpital/ · c – kurs przedłużony do ul. Jachimowicza · j – kurs przedłużony do ul. Jachimowicza (Faurecia) |
| A  | a – przez Auchan · s – przez ul. Sokołowskiego - Szpital |
| C  | a – przez Auchan · v – przez Galerię Victoria |
| EX | v – przez Galerię Victoria |

**Jak rozpoznawany jest wariant.** Po kierunku kursu (`trip_headsign` / ostatni
przystanek) *oraz* po przystankach na trasie — warianty „przez …” (Galeria
Victoria, Al. Podwale, Auchan, Szpital, Batorego, Beethovena, Chwaliszów,
Uzdrowisko) nie da się odróżnić samą nazwą celu. Kurs bez litery jest kursem
podstawowym. Rozkład awaryjny zbiorkom.live nie podaje pełnej trasy, więc
rozpoznaje tylko warianty wynikające z kierunku — nie dopisuje liter „na
wyczucie”. Linie spoza tabeli zachowują dotychczasowy podział (kierunek główny
+ odchylenia) i nie dostają wymyślonych liter.

Gdzie to działa:

- **rozkład na przystanku** – litery przy godzinach i legenda pod linią pokazują
  oficjalny opis wariantu (np. `b → kurs przedłużony do Boguszowa-Gorc`),
  szczegóły odjazdu podają dodatkowo kierunek,
- **podgląd kursu** – plakietka `2b` i opis wariantu,
- **wydruk kursówki (PDF)** – kolumna *Linia* pokazuje numer z literą (`2b`, `8s`,
  `18q`), a stopka każdej strony zawiera legendę **tylko użytych** wariantów,
- **opis funkcji w Pomocy** – zaktualizowany do oficjalnej legendy.

### Wzór wydruku kursówki — jak papierowy `RJ_KWKI_90(Z0)`

Każda kursówka PDF (bez względu na linię) ma teraz ten sam układ, odwzorowany
z rozkładu dla kierowców:

```
>>> MAPA2 / ROZKŁAD KURSÓW [firma]            zakres · wydrukowano dd.MM.rrrr hh:mm · 1/1
Wersja RJ ważna od dd.MM.rrrr do dd.MM.rrrr                            Dzień: <dzień, data>

┌────────────┬──────────┬──────────────┬──────────────────┬───────────────┬──────────┬─────┐
│ KURSÓWKA   │ FIRMA    │ RODZAJ DNIA  │ CZAS PRACY       │ CZAS PRZERWANY│ DROGA    │ ZM. │
│ 9/01       │ MZUK     │ ROBOCZY …    │ 8:14 (04:59-23:05)│ (-)          │ 312,7 km │ 1   │
└────────────┴──────────┴──────────────┴──────────────────┴───────────────┴──────────┴─────┘

┌───────┬───────┬───────┬──────────┬──────────────────────────────────────────┬────────┬───────┐
│ Linia │ Uwagi │ Godz. │ Początek │        Przystanki kontrolne               │ Koniec │Zakoń. │
├───────┼───────┼───────┼──────────┼───────┬──────┬───────┬──────┬───────┬──────┼────────┼───────┤
│ 9     │ sj*   │ 05:00 │ Stacyjna │ 05:07 │ …    │ 05:14 │ …    │ 05:21 │ …    │ Jachim…│ 05:28 │
└───────┴───────┴───────┴──────────┴───────┴──────┴───────┴──────┴───────┴──────┴────────┴───────┘

UWAGI:  *  na przystanku Uczniowska-US przesiadka pasażerów linią-18
        a  kurs przedłużony do przystanku Podwale - Forteczna
        d  kurs do Dworca Szczawienko
        s  kurs przez ul. Sokołowskiego /szpital/
        c  kurs przedłużony do ul. Jachimowicza
        j  kurs przedłużony do ul. Jachimowicza (Faurecia)
WY: wyjazd, PRZ: przejazd techniczny, ZJ: zjazd. ~: według reguł, …
```

- **Pas podsumowania** ma siedem pól jak w papierze: kursówka, firma, rodzaj dnia,
  czas pracy z zakresem godzin, czas przerwany (`(-)` gdy brak), droga i liczba
  zmian.
- **Nagłówek tabeli jest dwupoziomowy**: wysokie kolumny `Linia | Uwagi | Godz. |
  Początek | Koniec | Zakoń.` oraz grupa `Przystanki kontrolne` nad czterema
  parami (godzina + przystanek).
- **Blok `UWAGI:`** to **jedna płaska lista** `litera | opis` — bez numeru
  linii przy każdej literze (przy kursówce jednej linii był to czysty
  duplikat, a przy dwóch liniach dublował wiersze). Maksymalnie 7 liter
  (`TIMETABLE_LEGEND_MAX_ROWS`); jeśli pełna legenda linii się nie mieści,
  druk bierze litery użyte w danej kursówce. Gdyby ta sama litera znaczyła co
  innego na dwóch liniach, opisy trafiają do jednego wiersza.
- **Kursy przedłużone są nazwane wprost**: `kurs przedłużony do …` /
  `kurs przedłużony przez … do …` (linie 2, 8, 9, 12, 15, 19). Skrócone kursy
  zostają przy `kurs tylko do …`, a warianty trasowe przy `kurs przez …`.
- Geometria jest deterministyczna (stałe `TIMETABLE_LEGEND_ROW_HEIGHT`,
  wysokości nagłówka), więc test PDF liczy pozycje pasków „zebra” bez
  mierzenia tekstu.

### Kolumna „Uwagi” z literami legendy — jak w rozkładzie dla kierowców

Oficjalny rozkład z `RJ_KWKI_90(Z0)` ma po numerze linii osobną kolumnę
**Uwagi**, a litery opisują kursy — **kurs może mieć kilka liter naraz**
(`sj`, `sd`, `j*`, `*a`). Tak samo działa teraz wydruk z planisty:

| Kolumna | Zawartość |
| ------- | --------- |
| Linia   | samo oznaczenie linii (`9`, `19`, `2`, `PRZ`, `ZJ`…) — bez liter |
| Uwagi   | litery legendy dla tego kursu, np. `sj`, `sd`, `a`, `c` |

Legenda linii 9 i 19 (wspólna, kolejność jak w rozpisce):

| Litera | Znaczenie |
| --- | --- |
| `*` | na przystanku Uczniowska-US przesiadka pasażerów linią-18 |
| `a` | kurs przedłużony do przystanku Podwale - Forteczna |
| `d` | kurs do Dworca Szczawienko |
| `s` | kurs przez ul. Sokołowskiego /szpital/ |
| `c` | kurs przedłużony do ul. Jachimowicza |
| `j` | kurs przedłużony do ul. Jachimowicza (Faurecia) |

- Litery **sumują się**: `s` (przez szpital) i `*` (przesiadka) dokładają się do
  litery końca kursu. Wykluczają się tylko warianty końcowe — kurs kończy się
  w jednym miejscu (`a`/`d`/`c`/`j`). Kolejność w kolumnie: `s`, koniec, `*`.
- **Kierunkiem jest rzeczywisty ostatni przystanek kursu**, nie `trip_headsign`
  z GTFS. Wcześniej kurs kończący się na Dworcu Szczawienko dostawał literę
  „do Jachimowicza”, bo taki miał `headsign`; teraz dostaje `d` (i `s`, jeśli
  jechał przez szpital).
- Stopka wydruku wypisuje **pełną** legendę każdej linii z kursówki (wszystkie
  litery, nie tylko użyte w tym dniu). Stopka rezerwuje stałe 3 linijki
  (`TIMETABLE_LEGEND_RESERVED_LINES`) i pojawia się tylko wtedy, gdy kursówka ma
  choć jedną literę; jeśli pełna legenda się nie mieści, druk wraca do liter
  użytych w danym dniu.

## Zjazd zawsze osobno, bez „C/ZJ*”

- Numer linii na wydruku to **samo oznaczenie linii** (C, 8, 2…). Zjazd nie jest
  już dopisywany do numeru kursu w postaci `C/ZJ*`.
- Kurs, którego kierunek lub opis przystanku mówi o zjeździe, dostaje **osobny
  wiersz `ZJ`** zaraz po sobie (`Plac Grunwaldzki → Zajezdnia`). Ten sam kurs
  pozostaje kursem pasażerskim — nie zmieniamy klasyfikacji ani kilometrażu.
- Zajezdnia nazywa się po prostu **„Zajezdnia”** (wcześniej „Zajezdnia (do
  ustalenia)”, a przy braku potwierdzenia „Do ustalenia (kurs z zajezdni)”).
  Wiersz wyjazdu/zjazdu nie powstaje, gdy kurs i tak zaczyna się lub kończy na
  zajezdni.
- Stopka wydruku mówi wprost: „Zjazd zawsze osobnym wierszem (ZJ) — nie
  dopisujemy go do numeru linii”.

Testy: `npm run test:legend` (pełna tabela legendy + rozpoznawanie wariantów +
litera na wydruku), `npm run test:stops` (litery w rozkładzie przystanku
z prawdziwego indeksu GTFS) oraz `npm run test:duty-pdf` (osobny wiersz ZJ,
brak `linia/ZJ*`, nazwa „Zajezdnia”).

## Kierunek trasy bez animacji — statyczne strzałki

Ruchoma („płynąca”) linia na wyznaczonej trasie zniknęła: usunięto warstwę
`.route-flow` i animację `routeDash` (`src/app/globals.css`). Zamiast migającego
wzoru kierunek pokazują **statyczne strzałki** (`src/lib/routeArrows.ts`,
rysowane jako `L.divIcon` w panelu `routeArrows`, `z-index` 450 — nad linią,
pod przystankami i pinezkami). Nic się nie przesuwa, nie ma timerów ani
`animation`.

Skąd biorą się strzałki (w tej kolejności):

1. **Skrzyżowania i skręty** – z opisu manewrów OSRM (`turn`, `fork`,
   `roundabout`, `ramp`, `merge`, `end of road`, „lekko w prawo/lewo”).
   Strzałka stoi ~10 m za skrzyżowaniem i pokazuje kierunek drogi, w którą
   faktycznie skręca trasa. „Prosto”, zmiana nazwy ulicy i `continue` nie
   tworzą strzałki.
2. **Ta sama ulica w obie strony** (np. objazd i powrót) – odcinki w przeciwnym
   kierunku bliżej niż 26 m dostają strzałki w **obu** kierunkach, w kolorze
   pomarańczowym (`.route-arrow--reverse`), co ~130 m.
3. **Długie proste** bez skrętów – pojedyncza, mniejsza strzałka co ~1100 m,
   żeby na prostym odcinku też było widać kierunek.
4. Trasa bez żadnych manewrów (np. tryb demo) – jedna strzałka w połowie
   (dwie przy trasie > 1,5 km).

Odstępy są pilnowane (min. 55 m, skręty 40 m, maks. 40 strzałek), więc trasa
nie zmienia się w ciąg strzałek. Kolor strzałki (białe ramię + ciemna obwódka)
jest czytelny na jasnych i ciemnych kafelkach, a `pointer-events: none` oraz
`interactive: false` zostawiają działanie „kliknij linię, aby dodać punkt
pośredni”.

Testy: `npm run test:arrows` (kierunki na prostej, skręt, odcinek w obie
strony, brak fałszywych trafień na objazdzie kwartału, odstępy i limit,
odporność na `NaN`, czas liczenia oraz brak animacji w CSS i w `MapView`).

## Płynność planisty: mniej przerasterowania, mniej przerysowań

Planista „gubił klatki" przy przesuwaniu i przybliżaniu mapy oraz przy każdym
ticku flory/GPS. Cztery najdroższe rzeczy:

1. **Ciemna mapa filtrowana w całości.** Domyślny motyw to ciemny, a motyw
   ciemny oznacza kafle OSM przepuszczone przez
   `filter: invert(0.86) hue-rotate(180deg) brightness(1.38) contrast(0.98) saturate(0.86)`
   nałożony na **całą warstwę kafli**. Przeglądarka przerasterowywała wtedy cały
   widok mapy w każdej klatce ruchu. Teraz filtr siedzi na **pojedynczych
   kaflach** (`.basemap-layer--dark .leaflet-tile`) — kafel jest nieruchomy, więc
   wynik filtra zostaje w pamięci, a przesuwanie to samo compositing.
2. **24 px rozmycia tła w ~20 panelach nad mapą.** Panele mają tło kryjące w
   88–96%, więc rozmycie 24 px nic nie dawało wizualnie, a kazało przeglądarce
   rozmywać tło pod każdym panelem w każdej klatce ruchu mapy. `--blur-xl`
   schodzi do 8 px (`@theme` w `globals.css`).
3. **Etykiety przystanków.** Przy `zoom ≥ 16` mapa otwierała tooltip dla
   **każdego** widocznego przystanku (nawet 200+ elementów DOM) i przepisywała
   `tabindex` wszystkich ~550 markerów przy każdym `moveend`. Teraz otwarte
   etykiety są śledzone w `Set`, ograniczone do 80 najbliższych środka widoku
   (`MAX_STOP_LABELS`), `tabindex` zapisujemy tylko przy zmianie stanu, a
   `moveend` + `zoomend` w jednej klatce dają jedno odświeżenie (rAF).
4. **Pełny re-render planisty na szum danych.** GPS potrafi drgnąć o metr, gdy
   telefon leży na biurku — każdy taki odczyt przerysowywał całe drzewo.
   `useUserLocation` wysyła nową pozycję dopiero po ruchu ≥ 1,5 m, zmianie
   dokładności o 5 m, prędkości o 2 km/h albo po 3 s ciszy. Aktualizacje floty
   mają dodatkowo odcisk danych (`fleetSignature`), więc identyczny snapshot nie
   wywołuje re-rendera.

Dodatkowo:

- `updateWhenZooming: false` na kaflach — nowe kafle dopiero po animacji zoomu,
  w trakcie wystarcza przeskalowany raster,
- strzałki trasy liczą się w kolejnej klatce (`requestAnimationFrame`), więc
  sama linia trasy pojawia się natychmiast po odpowiedzi OSRM,
- usunięte selektory `:has()` (były na ~600 markerach) — kursor „grab" to teraz
  klasa `pin-wrap--grabbable`,
- `.route-arrow` bez `drop-shadow` (filtr = dodatkowa rasteryzacja przy zoomie).

**Jak to sprawdzić.** `?perf=1` (albo
`localStorage.setItem("mapplaner.perf","1")`) włącza licznik w lewym dolnym
rogu: FPS, najdłuższą klatkę, liczbę klatek > 34 ms na sekundę i liczbę węzłów
DOM. Bez tego parametru `PerfHud` nic nie renderuje i nie zakłada timerów.

Testy: `npm run test:perf` (pilnuje, żeby ciemne kafle nie wróciły do filtra CSS,
nie było `backdrop-filter` ani klas `backdrop-blur`, kafle nie wymuszały
`will-change`, etykiety przystanków miały limit, kafle nie pytały serwera
w trakcie zoomu, GPS miał próg ruchu, flota odcisk danych, a licznik FPS był
opt-in).

### 9 fps przy ruchu mapy: kafle w kanwie i koniec rozmywania tła

**Przyczyny.** Ruch mapy nie rysuje niczego od nowa — Leaflet przesuwa tylko
warstwę kafli. Cały koszt siedział więc w kompozycji:
1. Ciemny motyw był filtrem CSS **na każdym z ~40 kafli**, a Leaflet dokłada do
   każdego kafla `mix-blend-mode: plus-lighter`. Filtr + mieszanie to dwie
   dodatkowe powierzchnie na kafel, przeliczane przy każdym ruchu.
2. Panele nad mapą (kilkanaście) miały `backdrop-filter: blur(...)` — rozmycie
   tła jest liczone **od nowa w każdej klatce**, bo tło się przesuwa.
3. Kafle miały `will-change: opacity`, czyli osobną warstwę kompozycji każdy.
4. W trakcie ruchu dalej działały nieskończone animacje markerów (`pinPulse`,
   `vehicleFloat`), których przy przesuwaniu i tak nie widać.

**Poprawki**
- `src/lib/mapTiles.ts` — nowa warstwa kafli `createDarkTileLayer`: kafel jest
  przyciemniany **raz**, w kanwie (`ctx.filter`), a na ekran trafia zwykły
  `<canvas>`: zero filtra CSS, zero `mix-blend-mode`, zero dodatkowych
  powierzchni. Przeglądarki bez `ctx.filter` dostają filtr tylko na kaflu
  (fallback, ten sam wygląd).
- `globals.css` — `backdrop-filter` wyłączony globalnie (`none !important`),
  usunięte `will-change: opacity` z kafli; klasy `backdrop-blur*` zniknęły
  z komponentów, a panele dostały kryjące tło (92–95%), więc wygląd się nie
  zmienia.
- `MapView.tsx` + `globals.css` — podczas przesuwania/przybliżania kontener mapy
  dostaje klasę `map-busy`, która pauzuje pulsowanie i unoszenie markerów.
- `npm run test:perf` pilnuje wszystkich czterech punktów, żeby nie wróciły.

### Przystanki tylko wokół widoku

Warstwa przystanków trzymała w DOM **wszystkie ~550 markerów** miasta niezależnie
od kadru — plus hit-testowanie każdego z nich przy ruchu myszy. Teraz markery są
dodawane z zapasem 12% widoku (`STOP_SHOW_PAD`) i usuwane dopiero po wyjściu
poza bufor 50% (`STOP_KEEP_PAD`), więc przy przesuwaniu nie migają. Wybrany
przystanek nigdy nie znika. Dochodzenie markerów idzie partiami po 140 na klatkę
(`STOP_ADD_PER_FRAME`), żeby przesunięcie mapy nie kończyło się długim zadaniem.

Test `npm run test:stops:e2e` sprawdza teraz przycinanie zamiast „wszystkie
przystanki w DOM”: liczba markerów w kadrze jest mniejsza niż zbiór danych,
a po przeskoku w inny rejon mapy stare markery znikają (nowy przypadek
`TEST_CASE=culling`). `waitForGtfs` czeka na przystanek z centrum kadru, bo
dalsze przystanki fikstury pojawiają się dopiero po przesunięciu mapy.

## Tablica najbliższych odjazdów i legenda pod listą (wzór: myBus 3.0)

Ekran przystanku z **myBus 3.0** (PZI TARAN, używany w Wałbrzychu przez ZDKiUM)
zbiera najbliższe odjazdy i rozkład dnia na jednym ekranie, a pod listą chowa
wyjaśnienia oznaczeń. Nasza karta przystanku robi to samo:

- **Trzy zakładki** nad listą: **Najbliższe | Cały dzień | Od teraz**.
  `Najbliższe` to płaska tablica **10 najbliższych kursów wszystkich linii**
  (myBus pokazuje tablicę odjazdów, nie rozbicie na linie), sortowana po czasie
  prognozowanym z GPS — opóźniony kurs spada na właściwe miejsce, a kurs już
  odjechany znika. Obok godziny jest odliczanie (`teraz`, `za 3 min`, `za 1 h 5 min`).
- **Kolory punktualności** jak w myBus: zielony = na czas / przyspieszenie do
  1 min, pomarańczowy = opóźnienie do 3 min, czerwony = powyżej 3 min, szary
  pierścień = brak prognozy GPS. Kolor jest kropką przy godzinie, a jego opis
  znajduje się w legendzie.
- **„Legenda oznaczeń”** — link pod listą (domyślnie zwinięty) rozwija litery
  wariantów **użyte w tym widoku** (kod + oficjalny opis z legendy linii, z numerem
  linii), opis kolorów punktualności i przypomnienie, że kurs bez litery jest
  kursem podstawowym. Znika statyczne zdanie o „kursie przedłużonym do Boguszowa-Gorc”,
  które było nieprawdziwe.
- **Szczegóły odjazdu** (GPS, wóz, przewoźnik, „Pokaż przebieg kursu na mapie”,
  kursówka) są współdzielone przez tablicę i pełny rozkład — `StopDepartureDetail.tsx`.

`src/lib/stopBoard.ts` trzyma czystą logikę (`nextDepartures`, `minutesUntil`,
`formatEta`, `boardLegend`, `PUNCTUALITY_LEGEND`), więc tablicę pokrywa szybki
test `npm run test:board` (dołączony też do `npm run test:stops`). Domyślnie
karta otwiera się na „Cały dzień”, żeby dotychczasowe nawigacje i testy
przeglądarkowe działały bez zmian.

## Klik w autobus: cały przebieg kursu i każdy przystanek (wzór: myBus 3.0)

W myBus 3.0 kliknięcie pojazdu na ekranie „Pojazdy na żywo” pokazuje jego
kierunek, stan („Czeka na odjazd o 10:01”, „Pojazd 1”, „Zadanie 9/01”), legendę
punktualności i zakładki **Odjazdy / Szczegóły**, a pod nimi cały kurs. Nasza
karta pojazdu robi teraz to samo:

- **Cały kurs, nie tylko pozostałe przystanki.** Nowa `getVehicleTripStops(bus)`
  (`src/lib/engine/gtfsStore.ts`) dopasowuje pojazd do kursu w paczce GTFS i
  zwraca **wszystkie** przystanki od początku do końcowego z flagą „przebyty”.
  Dopasowanie kursu wydzielono do wspólnego `resolveVehicleTrip`, więc lista
  „do końcowego” i pełny przebieg korzystają z jednej logiki (w tym kursy po
  północy i różne numeracje `stop_sequence`).
- **Oś przebiegu** (`src/components/LiveBusRunPanel.tsx`): przebyte przystanki
  wyszarzone i przekreślone, bieżący z ikoną autobusu i podpisem „tu jest”,
  następny wyróżniony, końcowy z flagą. Obok godzina z rozkładu i **prognoza
  GPS** w kolorze punktualności.
- **Nagłówek karty** jak w myBus: kierunek, litera wariantu z oficjalnej legendy
  linii (np. `s` – przez Sokołowskiego) z opisem, chipsy `Czeka na odjazd o …` /
  `Pojazd #…` / `Zadanie 9/01` / model wozu.
- **Zakładki „Odjazdy” (domyślnie) i „Szczegóły”** — szczegóły (dopasowanie
  brygady, prędkość, edycja przewoźnika) zostały bez zmian, tylko schowane pod
  drugą zakładką; przyciski „Wszystkie kursy …” i centrowanie są widoczne zawsze.
- **Klik w autobus rysuje od razu trasę kursu na mapie** — bez zamykania karty
  (nowe opcje `keepBusCard` / `silent` w `handlePreviewCourse`). Gdy kursu nie ma
  w paczce, karta mówi to wprost („pokazano tylko przystanki z GPS”) i nie
  wymyśla wcześniejszej trasy.
- **Nowy stan punktualności „Czeka na odjazd”** (`WAITING_STYLE` w `src/lib/delay.ts`)
  — w legendzie karty i w chipsie nagłówka.

Logika jest czysta (`src/lib/liveBusProgress.ts`: `buildTripProgress`,
`currentStopIndex`, `waitingForDeparture`, `tripVariantLabel`, `describeStopDelta`,
`serviceDateId`), więc pokrywają ją szybkie testy `npm run test:bus`
(`test-live-bus-progress.ts` + render `test-live-bus-card.tsx`).
