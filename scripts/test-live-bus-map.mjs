// npm run test:bus:e2e
// Wymaga przeglądarki Chromium: ustaw CHROMIUM_PATH albo zainstaluj Playwrighta.
// Test sprawdza CAŁĄ drogę kliknięcia w autobus na mapie: marker → karta
// pojazdu → trasa kursu narysowana na mapie (myBus 3.0).
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const files = {
  "feed_info.txt":
    "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.com,pl,20260101,20261231\n",
  "routes.txt":
    "route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\nr7,7,Testowa 7,3,1E6FBF,FFFFFF\n",
  "stops.txt":
    "stop_id,stop_name,stop_lat,stop_lon\na,Piłsudskiego - Plac Tuwima,50.76697,16.28661\nb,Północ,50.77500,16.29000\nc,Koniec,50.78500,16.29500\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign\nr7,daily,t-bus,Koniec\n",
  // Celowo brak dnia kursu w kalendarzu: trasa autobusu nie może od tego zależeć.
  "calendar_dates.txt": "service_id,date,exception_type\ndaily,20261201,1\n",
  "stop_times.txt":
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n" +
    "t-bus,10:00:00,10:00:00,a,1,0,0\n" +
    "t-bus,10:10:00,10:10:00,b,2,0,0\n" +
    "t-bus,10:20:00,10:20:00,c,3,0,0\n",
};
const zip = Buffer.from(
  zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), {
    level: 0,
  }),
);
const tile =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce4d7"/></svg>';
const at = (hours, minutes) =>
  Date.parse(
    `2026-11-20T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00+01:00`,
  );

const server = await createServer({
  logLevel: "error",
  server: { host: "0.0.0.0", port: 5199, strictPort: false },
});
await server.listen();
const address = server.httpServer.address();
if (!address || typeof address === "string") throw new Error("Vite did not start on a TCP port");
const baseUrl = `http://127.0.0.1:${address.port}`;

let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", ...(process.env.CHROMIUM_ARGS?.split(" ").filter(Boolean) ?? [])],
    env: { ...process.env, ...(process.env.CHROMIUM_LIBS ? { LD_LIBRARY_PATH: process.env.CHROMIUM_LIBS } : {}) },
  });
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    // Zamrażamy zegar na dniu fikstury (Leaflet potrzebuje działającego Date).
    const NativeDate = Date;
    const offset = NativeDate.parse("2026-11-20T09:55:00+01:00") - NativeDate.now();
    window.Date = class extends NativeDate {
      constructor(...args) {
        super(...(args.length ? args : [NativeDate.now() + offset]));
      }
      static now() {
        return NativeDate.now() + offset;
      }
    };
    localStorage.setItem(
      "mapplaner.visibility.v2",
      JSON.stringify({ stops: "all", liveBuses: true }),
    );
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === baseUrl) {
      if (url.pathname.endsWith("/walbrzych-gtfs.zip") && !url.searchParams.has("import")) {
        return route.fulfill({ status: 200, contentType: "application/zip", body: zip });
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
      const cors = { "Access-Control-Allow-Origin": "*" };
      if (url.pathname.includes("/positions/")) {
        return route.fulfill({
          headers: cors,
          json: {
            positions: [
              {
                vehicle: { id: "1234", type: "bus", agency: "MZUK", model: "Solaris" },
                routeName: "7",
                routeColor: "#1e6fbf",
                brigade: "01",
                location: [50.76697, 16.28661],
                timestamp: at(9, 55),
                bearing: 45,
                delay: 0,
                headsign: "Koniec",
                upcomingStops: [
                  { sequence: 1, name: "Piłsudskiego - Plac Tuwima", scheduledArrival: at(10, 0), scheduledDeparture: at(10, 0) },
                  { sequence: 2, name: "Północ", scheduledArrival: at(10, 10), scheduledDeparture: at(10, 10) },
                  { sequence: 3, name: "Koniec", scheduledArrival: at(10, 20), scheduledDeparture: at(10, 20) },
                ],
              },
            ],
          },
        });
      }
      return route.fulfill({ status: 404, headers: cors });
    }
    return route.abort();
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".live-bus", { timeout: 25000 });
  assert.equal(await page.locator('[data-testid="bus-run-panel"]').count(), 0, "karta zamknięta przed kliknięciem");
  assert.equal(await page.locator(".leaflet-kursowka-pane path").count(), 0, "brak trasy przed kliknięciem");

  // Klik trafia w widoczną pigułkę autobusu — dokładnie tak, jak klika użytkownik.
  // (Bezpośrednie zdarzenie w przeglądarce, bo pozycja markera w kadrze zależy od
  // rozmiaru kontenera mapy, a nie od samej logiki kliknięcia.)
  await page.evaluate(() => {
    const label = document.querySelector(".live-bus-label") ?? document.querySelector(".live-bus");
    if (!label) throw new Error("brak pigułki autobusu");
    label.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });

  await page.waitForSelector('[data-testid="bus-pane-odjazdy"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="bus-run-panel"]', { timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelectorAll(".leaflet-kursowka-pane path").length > 0,
    undefined,
    { timeout: 15000 },
  );

  // Karta: kierunek, przystanki (przebyte + kolejne) i podpis trasy.
  const card = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="bus-run-panel"]');
    return {
      rows: panel?.querySelectorAll('[data-testid="trip-stop"]').length ?? 0,
      passed: panel?.querySelectorAll('[data-status="passed"]').length ?? 0,
      current: panel?.querySelectorAll('[data-status="current"]').length ?? 0,
      overlayTitle: Array.from(document.querySelectorAll("div,span"))
        .map((el) => el.textContent || "")
        .find((text) => text.startsWith("Trasa linii 7")) ?? "",
      paths: document.querySelectorAll(".leaflet-kursowka-pane path").length,
      selected: document.querySelectorAll(".live-bus--selected").length,
    };
  });
  assert.ok(card.rows >= 2, `karta ma pokazać cały kurs (jest ${card.rows})`);
  assert.equal(card.passed, 0, "autobus stoi na pierwszym przystanku — nic jeszcze nie przejechał");
  assert.equal(card.current, 1, "autobus musi być zaznaczony na osi kursu");
  assert.ok(card.paths > 0, "trasa kursu musi być narysowana na mapie");
  assert.ok(card.overlayTitle.includes("Trasa linii 7"), "mapa podpisuje narysowaną trasę");
  assert.equal(card.selected, 1, "wybrany autobus jest wyróżniony");

  // Drugi klik w ten sam autobus zamyka kartę i chowa trasę.
  await page.evaluate(() => {
    const label = document.querySelector(".live-bus-label") ?? document.querySelector(".live-bus");
    label.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
  await page.waitForFunction(
    () => document.querySelectorAll(".leaflet-kursowka-pane path").length === 0,
    undefined,
    { timeout: 10000 },
  );
  assert.equal(await page.locator('[data-testid="bus-run-panel"]').count(), 0, "karta zamknięta po drugim kliknięciu");

  assert.deepEqual(errors, []);
  await context.close();
  console.log("OK: klik w autobus otwiera kartę i rysuje trasę kursu na mapie");
} finally {
  if (browser) await browser.close();
  await server.close();
}
