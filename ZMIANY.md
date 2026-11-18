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
