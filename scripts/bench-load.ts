// npm run bench:load
// Pomiar wczytywania danych w prawdziwej przeglądarce (Chromium + Vite).
//
// Mierzy to, co czuje użytkownik, a nie tylko czas CPU:
//  • `autobus` — kiedy na mapie pojawia się pierwsza pigułka autobusu,
//  • `rozkład` — kiedy indeks rozkładu jest gotowy (`gtfs:index`),
//  • `dane` — suma etapów wczytywania GTFS (pobranie, rozpakowanie, CSV, indeks),
//  • `blokady` — ile razy interfejs został zablokowany na >50 ms i ile to
//    łącznie trwało (to jest „płynność”).
//
// Drugie wejście (`ciepło`) korzysta z IndexedDB — pokazuje, ile daje zapisana
// gotowa baza rozkładu i brak ponownego parsowania.
//
// Uruchomienie: CHROMIUM_PATH=/tmp/chromium CHROMIUM_LIBS=/tmp/al2023/lib npm run bench:load
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium, type Page } from "playwright-core";
import { buildSyntheticGtfs } from "./lib/syntheticGtfs";

const feed = buildSyntheticGtfs({
  routes: 40,
  stops: 1200,
  tripsPerService: 1000,
  stopsPerTrip: 30,
  shapes: 300,
  pointsPerShape: 300,
});
console.log(
  `paczka: ${(feed.bytes / 1024 / 1024).toFixed(2)} MB · ${feed.trips} kursów · ` +
    `${feed.stopTimes} stop_times · ${feed.shapePoints} punktów kształtu`,
);

const tile =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce4d7"/></svg>';

const server = await createServer({
  logLevel: "error",
  server: { host: "0.0.0.0", port: 5198, strictPort: false },
});
await server.listen();
const address = server.httpServer.address();
if (!address || typeof address === "string") throw new Error("Vite nie wystartował");
const baseUrl = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  env: { ...process.env, ...(process.env.CHROMIUM_LIBS ? { LD_LIBRARY_PATH: process.env.CHROMIUM_LIBS } : {}) },
});

/** Sieć zastępowana lokalnie: paczka GTFS, kafle mapy i pozycje GPS. */
async function installRoutes(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === baseUrl) {
      if (url.pathname.endsWith("/walbrzych-gtfs.zip") && !url.searchParams.has("import")) {
        return route.fulfill({ status: 200, contentType: "application/zip", body: Buffer.from(feed.zip) });
      }
      return route.continue();
    }
    if (url.hostname.includes("openstreetmap") || url.hostname.includes("arcgisonline")) {
      return route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: tile,
      });
    }
    if (url.hostname === "api.zbiorkom.live") {
      const headers = { "Access-Control-Allow-Origin": "*" };
      if (url.pathname.includes("/positions/")) {
        return route.fulfill({
          headers,
          json: {
            positions: [
              {
                vehicle: { id: "1234", type: "bus", agency: "MZUK", model: "Solaris" },
                routeName: "7",
                routeColor: "#1e6fbf",
                brigade: "01",
                location: [50.76697, 16.28661],
                timestamp: Date.parse("2026-11-20T09:55:00+01:00"),
                bearing: 45,
                delay: 0,
                headsign: "Koniec",
                upcomingStops: [],
              },
            ],
          },
        });
      }
      return route.fulfill({ status: 404, headers });
    }
    return route.abort();
  });
}

// Rozgrzewka serwera deweloperskiego (kompilacja modułów, optymalizacja zależności)
// w osobnym kontekście — konteksty mają własne IndexedDB, więc pomiar „zimno”
// poniżej naprawdę startuje bez zapisanej bazy.
{
  const warmup = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const warmupPage = await warmup.newPage();
  warmupPage.setDefaultTimeout(40000);
  await installRoutes(warmupPage);
  await warmupPage.goto(baseUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await warmupPage.waitForTimeout(4000);
  await warmup.close();
}

const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await context.newPage();
page.setDefaultTimeout(40000);
await installRoutes(page);

/** Nasłuch długich zadań i znaczniki pojawienia się mapy oraz autobusu. */
await page.addInitScript(() => {
  const state = { longTasks: 0, blockingMs: 0, worstMs: 0, busAt: 0, tileAt: 0 };
  (window as unknown as { __bench: typeof state }).__bench = state;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks += 1;
        state.blockingMs += Math.max(0, entry.duration - 50);
        state.worstMs = Math.max(state.worstMs, entry.duration);
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* Starsze silniki nie raportują longtask. */
  }
  // MutationObserver zamiast rAF: w trybie headless klatki bywają wstrzymane.
  const observer = new MutationObserver(() => {
    if (!state.tileAt && document.querySelector(".leaflet-tile-container > *")) {
      state.tileAt = performance.now();
    }
    if (!state.busAt && document.querySelector(".leaflet-vehicles-pane .live-bus")) {
      state.busAt = performance.now();
    }
    if (state.tileAt && state.busAt) observer.disconnect();
  });
  document.addEventListener("DOMContentLoaded", () => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
  localStorage.setItem("mapplaner.visibility.v2", JSON.stringify({ stops: "all", liveBuses: true }));
});

const measure = async (label: string) => {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".leaflet-vehicles-pane .live-bus", { timeout: 60000 });
  // Znaczniki etapów istnieją tylko w wersji z pomiarem (starsze buildy ich nie mają).
  await page
    .waitForFunction(
      () =>
        (
          window as unknown as {
            __mapplanerPerf?: { getTimings: () => Array<{ name: string }> };
          }
        ).__mapplanerPerf
          ?.getTimings?.()
          .some((timing) => timing.name === "gtfs:index"),
      undefined,
      { timeout: 15000 },
    )
    .catch(() => undefined);
  // Czekamy, aż zapis bazy do IndexedDB na pewno się wykona (jak u użytkownika,
  // który zostaje na stronie kilka sekund), żeby zmierzyć ciepłe wejście.
  await page.waitForTimeout(3500);
  const result = await page.evaluate(() => {
    const bench = (
      window as unknown as {
        __bench: { longTasks: number; blockingMs: number; worstMs: number; busAt: number; tileAt: number };
      }
    ).__bench;
    const perf = (
      window as unknown as {
        __mapplanerPerf?: { getTimings: () => Array<{ name: string; ms: number; at: number }> };
      }
    ).__mapplanerPerf;
    const timings = perf?.getTimings?.() ?? [];
    const longest = timings.reduce((worst, timing) => Math.max(worst, timing.ms), 0);
    const gtfs = timings.filter((timing) => timing.name.startsWith("gtfs:"));
    const indexTiming = timings.find((timing) => timing.name === "gtfs:index");
    return {
      busAt: Math.round(bench.busAt),
      tileAt: Math.round(bench.tileAt),
      feedReadyAt: indexTiming?.at ? Math.round(indexTiming.at - performance.timeOrigin) : 0,
      longTasks: bench.longTasks,
      blockingMs: Math.round(bench.blockingMs),
      worstTaskMs: Math.round(bench.worstMs),
      loadMs: Math.round(gtfs.reduce((sum, timing) => sum + timing.ms, 0)),
      longestStageMs: Math.round(longest),
      stages: timings.map((timing) => `${timing.name}=${Math.round(timing.ms)}`),
    };
  });
  console.log(
    `${label.padEnd(7)} mapa ${String(result.tileAt).padStart(5)} ms · autobus ${String(result.busAt).padStart(5)} ms · ` +
      `rozkład ${String(result.feedReadyAt).padStart(5)} ms · dane ${String(result.loadMs).padStart(4)} ms · ` +
      `najdłuższy etap ${String(result.longestStageMs).padStart(4)} ms · ` +
      `blokady ${result.longTasks}× (${result.blockingMs} ms, max ${result.worstTaskMs} ms)`,
  );
  return result;
};

const cold = await measure("zimno");
const warm = await measure("ciepło");

console.log("\nEtapy (zimno):", cold.stages.join(", ") || "brak znaczników");
console.log("Etapy (ciepło):", warm.stages.join(", ") || "brak znaczników");

await context.close();
await browser.close();
await server.close();

// Zdrowy rozsądek: drugie wejście nie może być wolniejsze od pierwszego.
assert.ok(warm.busAt <= cold.busAt + 400, "ciepłe wejście nie jest wolniejsze");
console.log("\nOK: pomiar wczytywania danych zakończony");
