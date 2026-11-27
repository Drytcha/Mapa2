// npm run test:course:e2e
// Widok Użytkownika: panel kursu (węższy) i „trasa do przystanku” — podróżny
// wybiera przystanek, do którego chce dojechać, a nie tylko koniec kursu.
//
// Wymaga przeglądarki Chromium: ustaw CHROMIUM_PATH albo zainstaluj Playwrighta.
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { chromium } from "playwright-core";
import { createServer } from "vite";

// ── Fikstura GTFS: kurs linii 7 z czterema przystankami i geometrią ──────────
const files = {
  "feed_info.txt":
    "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.com,pl,20260101,20261231\n",
  "routes.txt":
    "route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\nr7,7,Testowa 7,3,1E6FBF,FFFFFF\n",
  "stops.txt":
    "stop_id,stop_name,stop_lat,stop_lon\n" +
    "a,Piłsudskiego - Plac Tuwima,50.76697,16.28661\n" +
    "b,Północ,50.77400,16.29000\n" +
    "c,Rondo,50.77900,16.29300\n" +
    "d,Koniec,50.78500,16.29500\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign\nr7,daily,t7,Koniec\n",
  "calendar_dates.txt": "service_id,date,exception_type\ndaily,20261119,1\n",
  "stop_times.txt":
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n" +
    "t7,08:00:00,08:00:00,a,1,0,0\n" +
    "t7,08:06:00,08:06:00,b,2,0,0\n" +
    "t7,08:12:00,08:12:00,c,3,0,0\n" +
    "t7,08:18:00,08:18:00,d,4,0,0\n",
  // Kształt biegnie po ulicy: 4 punkty, żeby trasa była ciągłą linią.
  "shapes.txt":
    "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n" +
    "s7,50.76697,16.28661,1\n" +
    "s7,50.77400,16.29000,2\n" +
    "s7,50.77900,16.29300,3\n" +
    "s7,50.78500,16.29500,4\n",
};
const zip = Buffer.from(
  zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
    { level: 0 },
  ),
);
const tile =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce4d7"/></svg>';

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
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  async function openApp({ viewport, mobile = false }) {
    const context = await browser.newContext({
      viewport,
      ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      // Zegar przesunięty na dzień fikstury, ale nadal chodzący (animacje Leafleta).
      const NativeDate = Date;
      const offset = NativeDate.parse("2026-11-19T07:10:00+01:00") - NativeDate.now();
      window.Date = class extends NativeDate {
        constructor(...args) {
          super(...(args.length ? args : [NativeDate.now() + offset]));
        }
        static now() {
          return NativeDate.now() + offset;
        }
      };
      localStorage.setItem("mapplaner.role", "traveler");
      localStorage.setItem(
        "mapplaner.visibility.v2",
        JSON.stringify({ stops: "all", liveBuses: false }),
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
      // OSRM (naprawa geometrii, routing pieszy) i Overpass: brak sieci.
      return route.abort();
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator('[data-stop-id="tt-a"], .bus-stop').first().waitFor({ timeout: 25000 });
    return { page, context, errors };
  }

  // ── 1. Panel kursu jest węższy i nadal kompletny ─────────────────────────
  const { page, context, errors } = await openApp({ viewport: { width: 1280, height: 860 } });

  // Początek testu: żaden panel kursu nie jest jeszcze otwarty.
  assert.equal(await page.getByTestId("course-preview-sidebar-root").count(), 0, "brak panelu przed wyborem kursu");
  await page.getByTestId("map-sidebar-toggle").click();
  await page.getByRole("button", { name: "Kursówki" }).first().click();
  // W dialogu kursówek: brygada → kurs → podgląd przebiegu na mapie.
  await page.getByTestId("brigade-card").first().click({ timeout: 20000 });
  const previewButton = page.getByTestId("preview-course-button").first();
  await previewButton.waitFor({ timeout: 20000 });
  await previewButton.click();

  const sidebar = page.getByTestId("course-preview-card");
  await sidebar.waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="course-preview-stop"]').length === 4);

  const width = await sidebar.evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(width <= 320, `panel kursu jest delikatnie zmniejszony (jest ${Math.round(width)} px)`);
  assert.ok(width >= 260, `panel nie jest za wąski dla treści (jest ${Math.round(width)} px)`);

  // Przebieg całego kursu: wszystkie przystanki widoczne, brak przycięcia.
  const overlayPaths = () =>
    page.evaluate(() => document.querySelectorAll(".leaflet-kursowka-pane path").length);
  assert.ok((await overlayPaths()) > 0, "cała trasa kursu jest narysowana");

  // ── 2. Trasa do przystanku pośredniego ───────────────────────────────────
  const thirdStop = page.getByTestId("course-preview-stop").nth(2);
  const targetName = (await thirdStop.innerText()).split("\n").filter(Boolean).at(-1);
  await thirdStop.click();

  const summary = page.getByTestId("course-target-summary");
  await summary.waitFor({ timeout: 10000 });
  assert.match(await summary.innerText(), new RegExp(String(targetName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await page.waitForFunction(() => document.querySelectorAll(".leaflet-courseTarget-pane path").length === 2);

  // Wycinek kończy się pod wybranym przystankiem, a nie na końcu kursu:
  // długość fioletowej linii jest mniejsza niż całej trasy kursu.
  const lengths = await page.evaluate(() => {
    const straight = Array.from(document.querySelectorAll(".leaflet-courseTarget-pane path")).at(-1);
    const whole = Array.from(document.querySelectorAll(".leaflet-kursowka-pane path")).at(-1);
    return { target: straight?.getTotalLength() ?? 0, whole: whole?.getTotalLength() ?? 0 };
  });
  assert.ok(lengths.target > 0, "narysowano odcinek do przystanku");
  assert.ok(
    lengths.target < lengths.whole * 0.98,
    `trasa do przystanku jest krótsza niż cały kurs (${lengths.target.toFixed(0)} < ${lengths.whole.toFixed(0)})`,
  );

  // Wiersz wybranego przystanku jest wyróżniony w liście.
  assert.equal(await page.locator('[data-testid="course-preview-stop"][data-target="true"]').count(), 1);
  assert.equal((await page.getByTestId("course-preview-stop").nth(2).getAttribute("data-target")), "true");

  // Cały przebieg kursu zostaje na mapie jako tło (wygaszony), nie znika.
  const dimmed = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".leaflet-kursowka-pane path")).every(
      (path) => Number(getComputedStyle(path).strokeOpacity) < 0.6,
    ),
  );
  assert.equal(dimmed, true, "po wyborze przystanku cały kurs jest wygaszony");

  // Drugi klik w ten sam przystanek wraca do całej trasy.
  await page.getByTestId("course-preview-stop").nth(2).click();
  await page.waitForFunction(() => document.querySelectorAll(".leaflet-courseTarget-pane path").length === 0);
  assert.equal(await page.getByTestId("course-target-summary").count(), 0, "podsumowanie znika po powrocie do całej trasy");
  const restored = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".leaflet-kursowka-pane path")).every(
      (path) => Number(getComputedStyle(path).strokeOpacity) > 0.6,
    ),
  );
  assert.equal(restored, true, "cała trasa wraca do pełnej widoczności");

  // ── 3. Przycisk „Cała trasa kursu” w stopce panelu ───────────────────────
  await page.getByTestId("course-preview-stop").nth(1).click();
  await page.getByTestId("course-target-clear").click();
  await page.waitForFunction(() => document.querySelectorAll(".leaflet-courseTarget-pane path").length === 0);

  // ── 4. Kropka przystanku na mapie działa jak klik w liście ───────────────
  await page.waitForFunction(() => document.querySelectorAll(".leaflet-courseStops-pane path.course-stop--tappable").length >= 3);
  await page.evaluate(() => {
    const dot = document.querySelectorAll(".leaflet-courseStops-pane path.course-stop--tappable")[2];
    const box = dot.getBoundingClientRect();
    dot.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      }),
    );
  });
  await page.waitForFunction(() => document.querySelectorAll(".leaflet-courseTarget-pane path").length === 2);
  assert.equal(await page.locator('[data-testid="course-preview-stop"][data-target="true"]').count(), 1);

  assert.deepEqual(errors, []);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await context.close();

  // ── 5. Telefon: panel zwinięty startuje z uchwytem, cała mapa widoczna ───
  const mobile = await openApp({ viewport: { width: 390, height: 844 }, mobile: true });
  await mobile.page.getByTestId("map-sidebar-toggle").click();
  await mobile.page.getByRole("button", { name: "Kursówki" }).first().click();
  await mobile.page.getByTestId("brigade-card").first().click({ timeout: 20000 });
  await mobile.page.getByTestId("preview-course-button").first().click({ timeout: 20000 });
  await mobile.page.getByTestId("course-drawer-toggle").waitFor({ timeout: 20000 });
  assert.equal(
    await mobile.page.getByTestId("course-preview-card").getAttribute("data-open"),
    "false",
    "na telefonie panel kursu startuje zwinięty — widać mapę",
  );
  assert.deepEqual(mobile.errors, []);
  await mobile.context.close();

  console.log(
    "OK: panel kursu jest węższy, a podróżny może pokazać trasę do dowolnego przystanku (lista, mapa, powrót do całej trasy)",
  );
} finally {
  await browser?.close();
  await server.close();
}
