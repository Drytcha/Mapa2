# MapPlaner — Wałbrzych (GitHub Pages · Pure TypeScript)

Statyczna aplikacja webowa napisana w czystym **TypeScript + React + Vite**, wdrażana **wyłącznie na GitHub Pages** — bez serwera Node.js, bez Next.js, bez Dockera, bez `render.yaml` i bez bazy PostgreSQL.

## Funkcje

- **Planowanie tras (do 50 punktów)** z wyszukiwarką OpenStreetMap (Nominatim) oraz lokalną bazą Wałbrzycha i Dolnego Śląska, obsługą przeciągania pinezek, dodawania punktów na linii i menu kontekstowego (prawy przycisk myszy).
- **Kursówki Wałbrzych GTFS** — automatyczne pobieranie z otwartego feedu `api.zbiorkom.live` (z wbudowaną kopią zapasową `public/data/walbrzych-gtfs.zip`), parsowanie archiwum ZIP (`fflate`) po stronie przeglądarki, zapis w `IndexedDB` i łączenie kursów z obserwacjami GPS na żywo.
- **Autobusy GPS na żywo (MZUK i ŚKA)** — dekodowanie feedu pozycji JSON oraz binarnego GTFS-RT Protobuf bezpośrednio w TypeScript, wyliczanie prędkości z kolejnych odczytów GPS, ręczne przypisywanie przewoźników (`localStorage`), podgląd najbliższych przystanków i punktualności.
- **Przystanki i odjazdy** — łączenie przystanków GTFS z migawką oficjalnego rozkładu `rozklad.walbrzych.eu` i Overpass API (OSM).
- **Sygnalizacja świetlna i korki** — wykrywanie skrzyżowań ze światłami wzdłuż trasy, model godzin szczytu (strefa `Europe/Warsaw`) z korektą na podstawie bieżących opóźnień GPS.
- **Eksport do PDF i CSV** — generowanie mapy całej trasy i pełnej listy przystanków bezpośrednio w przeglądarce (`jsPDF` z osadzoną polską czcionką Lato).

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
