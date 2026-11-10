# MapPlaner — Wałbrzych (GitHub Pages · Pure TypeScript)

Statyczna aplikacja webowa napisana w czystym **TypeScript + React + Vite**, wdrażana **wyłącznie na GitHub Pages** — bez serwera Node.js, bez Next.js, bez Dockera, bez `render.yaml` i bez bazy PostgreSQL.

## Funkcje

- **Planowanie tras (do 50 punktów)** z wyszukiwarką OpenStreetMap (Nominatim) oraz lokalną bazą Wałbrzycha i Dolnego Śląska, obsługą przeciągania pinezek, dodawania punktów na linii i menu kontekstowego (prawy przycisk myszy).
- **Kursówki Wałbrzych GTFS** — automatyczne pobieranie z otwartego feedu `api.zbiorkom.live` (z wbudowaną kopią zapasową `public/data/walbrzych-gtfs.zip`), parsowanie archiwum ZIP (`fflate`) po stronie przeglądarki, zapis w `IndexedDB` i łączenie kursów z obserwacjami GPS na żywo.
- **Kursówki według daty** — wykaz brygad dla wybranej linii i daty: nawigacja Wczoraj / Dziś / Jutro oraz dowolna data (ograniczona do okresu ważności feedu), wybór linii lub „Wszystkie linie", liczba kursów i bloki pracy, podgląd wszystkich kursów brygady z przystankami, czasem trwania i postojami, oznaczenie wozów obecnych w GPS oraz przycisk „Wczytaj do Planera". Link do konkretnej kursówki otwiera od razu jej brygadę. Linki głębokie: `#/walbrzych/brigades/2?date=20261109`.
- **Tylko aktualny, obowiązujący rozkład** — `feed_info.txt` wyznacza okres ważności (np. `20261107–20261231`), a `calendar_dates.txt` dokładny zestaw `service_id` aktywnych **w tej konkretnej dacie**. Nie ma fallbacku „dzień roboczy od zawsze": daty spoza feedu zwracają komunikat o braku rozkładu, a kalendarz blokuje ich wybór.
- **Prawdziwe numery brygad (jak na livetransport.eu)** — numery pochodzą z rozkładu pracy kierowców operatora (otwarte API `api.livetransport.eu`, to samo źródło, z którego korzysta livetransport.eu): np. linia 2 → `2-01 … 2-08`, a brygady wieloliniowe (`8-02`, `15-01`, `A-05`, `EX-02`) są poprawnie widoczne pod każdą obsługiwaną linią. Aplikacja **nie wymyśla numerów** (`18-07`, `18-10` itp.). Odpowiedzi są cache'owane w IndexedDB (dzień działa też offline); gdy źródło jest chwilowo niedostępne lub data wykracza poza jego okno, pokazywany jest rozkład GTFS **bez** fikcyjnych numerów wraz z wyjaśnieniem.
- **Brygady wieloliniowe** — jeden autobus może w ciągu dnia obsługiwać kilka linii. Łańcuchy kursów budowane są ze wszystkich linii dnia naraz (ciągłość pętli + przerwa 2–90 min), a dopiero potem filtrowane po linii. Wybranie linii A pokazuje więc **wszystkie brygady wykonujące kursy na A**, łącznie z tymi o numerach innych linii.
- **Autobusy GPS na żywo (MZUK i ŚKA)** — dekodowanie feedu pozycji JSON oraz binarnego GTFS-RT Protobuf bezpośrednio w TypeScript, wyliczanie prędkości z kolejnych odczytów GPS, ręczne przypisywanie przewoźników (`localStorage`), podgląd najbliższych przystanków i punktualności.
- **Przystanki i odjazdy — tylko obsługiwane przez kursy** — na mapie i w listach są wyłącznie przystanki GTFS, na których w okresie ważności feedu zatrzymuje się co najmniej jeden kurs (kursówka). Pomijane są przystanki ze `stops.txt` bez żadnego kursu, przejazdy bez zatrzymania (`pickup_type` = `drop_off_type` = 1), pozycje znane tylko z migawki `rozklad.walbrzych.eu` oraz przystanki z OpenStreetMap. Linie przy przystanku wynikają z realnych zatrzymań, a karta przystanku pokazuje liczbę kursów w dni robocze, soboty i niedziele.
- **Sygnalizacja świetlna i korki** — wykrywanie skrzyżowań ze światłami wzdłuż trasy, model godzin szczytu (strefa `Europe/Warsaw`) z korektą na podstawie bieżących opóźnień GPS.
- **Eksport do PDF i CSV** — generowanie mapy całej trasy i pełnej listy przystanków bezpośrednio w przeglądarce (`jsPDF` z osadzoną polską czcionką Lato).

### Źródła danych i brak zewnętrznych zależności

Wykaz brygad i kursów generowany jest w 100% lokalnie w przeglądarce w oparciu o:
1. **Oficjalny rozkład GTFS Wałbrzycha** (`api.zbiorkom.live/api6-open/walbrzych/gtfs/default` + lokalna kopia zapasowa) – zawiera pełny zbiór wszystkich kursów, czasów przyjazdów/odjazdów i pętli.
2. **Otwarty feed GPS na żywo** (`api.zbiorkom.live/api6-open/walbrzych/positions/...`) – zasilający brygady potwierdzonymi numerami z komputerów pokładowych wozów MZUK i ŚKA.

Aplikacja działa w 100% statycznie na GitHub Pages, bez serwera Node.js, bez baz danych i bez żadnych serwerów proxy.

## Wdrożenie na GitHub Pages

1. Wypchnij zawartość repozytorium na gałąź `main` lub `master`.
2. W ustawieniach repozytorium na GitHub otwórz **Settings → Pages** i ustaw **Source: GitHub Actions**.
3. Workflow `.github/workflows/deploy.yml` wykona automatycznie:
   - `npm ci`
   - `npx tsc --noEmit`
   - `npm run build` (generuje statyczny katalog `./dist`)
   - publikację katalogu `./dist` przez `actions/deploy-pages`.

## Uruchomienie lokalne

```bash
npm install
npm run dev
```

Sprawdzenie typów i budowanie produkcyjne:

```bash
npx tsc --noEmit
npm run build
```

Weryfikacja kompletności katalogu brygad na realnym GTFS (3 rundy × 3 daty × 17 linii,
każdy kurs musi należeć do dokładnie jednej brygady i być widoczny po wybraniu swojej linii):

```bash
curl -sL https://api.zbiorkom.live/api6-open/walbrzych/gtfs/default -o public/data/walbrzych-gtfs.zip
node tests/brigades-verify.mjs      # kompletność i ważność rozkładu GTFS
node tests/live-brigades-check.mjs  # prawdziwe numery brygad (3 rundy)
node tests/served-stops-verify.mjs  # na mapie są wyłącznie przystanki z kursami
```
