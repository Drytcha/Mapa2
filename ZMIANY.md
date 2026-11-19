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
