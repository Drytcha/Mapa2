// npm run test:stops:e2e
// Install a Playwright Chromium browser, or set CHROMIUM_PATH to a local executable.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { strToU8, zipSync } from "fflate";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const files = {
  "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.com,pl,20260101,20261231\n",
  "routes.txt": "route_id,route_short_name,route_long_name,route_type\nr1,7,Test,3\nr2,9,Test 2,3\nr3,S1,Linia planistyczna,3\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\na,Piłsudskiego - Plac Tuwima,50.76697,16.28661\nb,Północ,50.82,16.29\nc,Koniec,50.83,16.29\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign\nr1,daily,t1,Koniec\nr1,daily,t2,Koniec\nr2,daily,t3,Głuszyca\nr1,tomorrow,t4,Koniec\nr3,daily,ts,Koniec\n",
  "calendar_dates.txt": "service_id,date,exception_type\ndaily,20261119,1\ntomorrow,20261120,1\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nt1,08:00:00,08:00:00,a,1,0,0\nt1,08:10:00,08:10:00,c,2,0,0\nt2,08:00:00,08:00:00,b,1,0,0\nt2,08:10:00,08:10:00,c,2,0,0\nt3,09:35:00,09:35:00,a,1,0,0\nt3,09:50:00,09:50:00,c,2,0,0\nt4,10:15:00,10:15:00,a,1,0,0\nt4,10:30:00,10:30:00,c,2,0,0\nts,11:30:00,11:30:00,a,1,0,0\nts,11:45:00,11:45:00,c,2,0,0\n",
};
const makeZip = (entries) => Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, strToU8(text)])), { level: 0 }));
const zip = makeZip(files);
const expiredFiles = {
  ...files,
  "feed_info.txt": files["feed_info.txt"].replace("20261231", "20261118"),
  "calendar_dates.txt": files["calendar_dates.txt"] + "daily,20261118,1\n",
};
const expiredZip = makeZip(expiredFiles);
const partialZip = makeZip({
  ...expiredFiles,
  "trips.txt": files["trips.txt"] + "r1,night,night1,Koniec\n",
  "calendar_dates.txt": expiredFiles["calendar_dates.txt"] + "night,20261118,1\n",
  "stop_times.txt": files["stop_times.txt"] + "night1,24:30:00,24:30:00,a,1,0,0\nnight1,24:40:00,24:40:00,c,2,0,0\n",
});
const clock = (minute) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00`;
const manyTrips = Array.from({ length: 80 }, (_, index) => ({ id: `many${index}`, minute: 240 + index * 15 }));
const manyZip = makeZip({
  ...files,
  "trips.txt": files["trips.txt"] + manyTrips.map(({ id }) => `r1,daily,${id},Koniec\n`).join(""),
  "stop_times.txt": files["stop_times.txt"] + manyTrips.map(({ id, minute }) =>
    `${id},${clock(minute)},${clock(minute)},a,1,0,0\n${id},${clock(minute + 5)},${clock(minute + 5)},c,2,0,0\n`).join(""),
});
const tile = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce4d7"/><path d="M0 82H256M0 180H256M70 0V256M190 0V256" fill="none" stroke="#f5f4ee" stroke-width="8"/></svg>';
// Captured API data are replayed deterministically; they are not a live-feed test.
const sample = JSON.parse(await readFile(new URL("./fixtures/zbiorkom-stop-sample.json", import.meta.url), "utf8"));

const server = await createServer({
  logLevel: "error",
  server: { host: "0.0.0.0", port: 5173, strictPort: false },
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Vite did not start on a TCP port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: ["--no-sandbox", ...(process.env.CHROMIUM_ARGS?.split(" ").filter(Boolean) ?? [])],
  });

  async function openPage({ mode = "online", role, stops, mobile = false, viewport, geo, lateGeo = false } = {}) {
    const context = await browser.newContext({
      viewport: viewport ?? (mobile ? { width: 390, height: 844 } : { width: 1365, height: 850 }),
      ...(geo ? { permissions: ["geolocation"], geolocation: { ...geo, accuracy: 10 } } : {}),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    const requests = [];
    let releaseArchive = () => {};
    const archiveReady = ["slow", "slow-fallback"].includes(mode)
      ? new Promise((resolve) => { releaseArchive = resolve; }) : Promise.resolve();
    let releaseLive = () => {};
    const liveReady = mode === "live-hang" ? new Promise((resolve) => { releaseLive = resolve; }) : Promise.resolve();
    let releaseFallback = () => {};
    const fallbackReady = mode === "switch-fallback" ? new Promise((resolve) => { releaseFallback = resolve; }) : Promise.resolve();
    page.on("close", () => { releaseArchive(); releaseLive(); releaseFallback(); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(({ role, stops, lateGeo }) => {
      // Shift the clock to the fixture's day while allowing it to advance: Leaflet
      // animations use Date.now(), so a completely frozen clock breaks flyTo.
      const NativeDate = Date;
      const offset = NativeDate.parse("2026-11-19T07:00:00+01:00") - NativeDate.now();
      window.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [NativeDate.now() + offset])); }
        static now() { return NativeDate.now() + offset; }
      };
      if (role && !localStorage.getItem("mapplaner.role")) localStorage.setItem("mapplaner.role", role);
      if (stops && !localStorage.getItem("mapplaner.visibility.v2")) {
        localStorage.setItem("mapplaner.visibility.v2", JSON.stringify({ stops, liveBuses: false }));
      }
      if (lateGeo) {
        Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
          watchPosition: (success) => { window.__sendLocation = success; return 1; },
          clearWatch: () => {},
        } });
      }
      const originalFetch = window.fetch;
      window.__overpassCalls = 0;
      window.fetch = (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("overpass")) {
          window.__overpassCalls += 1;
          // Simulate an internal Overpass timeout, not a caller cancellation.
          return Promise.reject(new DOMException("Timed out", "AbortError"));
        }
        return originalFetch(input, init);
      };
    }, { role, stops, lateGeo });
    await page.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      requests.push(requestUrl.href);
      if (requestUrl.origin === baseUrl) {
        // Vite imports an embedded archive through a JS module first; only
        // intercept the subsequent bytes request, not ?import&url itself.
        if (requestUrl.pathname.endsWith("/walbrzych-gtfs.zip") && !requestUrl.searchParams.has("import")) {
          await archiveReady;
          if (["offline", "fallback", "switch-fallback"].includes(mode)) return route.fulfill({ status: 503, body: "offline" });
          if (mode === "html") return route.fulfill({ status: 200, contentType: "text/html", body: "<html>" + "x".repeat(1600) + "</html>" });
          const body = mode === "expired-partial" ? partialZip : mode.startsWith("expired-") ? expiredZip : mode === "many" ? manyZip : zip;
          return route.fulfill({ status: 200, contentType: "application/zip", body }).catch(() => {});
        }
        return route.continue();
      }
      if (requestUrl.hostname === "tile.openstreetmap.org" || requestUrl.hostname === "server.arcgisonline.com") {
        return route.fulfill({ status: 200, contentType: "image/svg+xml", headers: { "Access-Control-Allow-Origin": "*" }, body: tile });
      }
      if (requestUrl.hostname === "api.zbiorkom.live") {
        const cors = { "Access-Control-Allow-Origin": "*" };
        if (requestUrl.pathname.endsWith("/gtfs/default") && mode === "html") {
          return route.fulfill({ status: 200, contentType: "application/zip", headers: cors, body: zip });
        }
        if (["fallback", "slow-fallback", "switch-fallback", "expired-fallback"].includes(mode) && requestUrl.pathname.endsWith("/stops")) {
          return route.fulfill({ json: { stops: sample.stops }, headers: cors });
        }
        const stopId = requestUrl.pathname.split("/").at(-1);
        if (["fallback", "slow-fallback", "switch-fallback", "expired-fallback"].includes(mode) && sample.departuresByStop[stopId]) {
          if (mode === "switch-fallback" && stopId === "pilsudskiego-plac-tuwima-a8ncm") await fallbackReady;
          const cursor = Number(requestUrl.searchParams.get("time"));
          const departures = sample.departuresByStop[stopId].filter((row) => row.scheduledDeparture >= cursor).slice(0, 3);
          return route.fulfill({ json: { departures }, headers: cors }).catch(() => {});
        }
        if (mode === "live-hang" && (requestUrl.pathname.includes("/positions/") || requestUrl.pathname.includes("/gtfsRealtime/") || stopId === "a")) {
          await liveReady;
          if (stopId === "a") return route.fulfill({ headers: cors, json: { departures: [{ trip: { route: { name: "7" }, headsign: "Koniec" }, scheduledDeparture: 1795071600000, delay: 120000, isRealtime: true }] } }).catch(() => {});
          if (requestUrl.pathname.includes("/positions/")) return route.fulfill({ headers: cors, json: { positions: [] } }).catch(() => {});
          return route.fulfill({ status: 404, headers: cors }).catch(() => {});
        }
      }
      return route.abort();
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    return { page, context, errors, requests, releaseArchive, releaseLive, releaseFallback };
  }

  /**
   * Markery przystanków rysujemy tylko wokół widoku, więc czekamy na przystanek
   * z centrum kadru (tt-a), a nie na wszystkie przystanki fikstury. Dalsze
   * przystanki (tt-b, tt-c) pojawiają się, gdy test sam przesunie mapę.
   */
  async function waitForGtfs(page) {
    await page.locator('[data-stop-id="tt-a"]').waitFor({ state: "attached", timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-stop-id^="snapshot-"]').length === 0);
    assert.ok(await page.locator('.bus-stop[data-stop-id^="tt-"]').count() >= 1);
  }

  /** Ustawia kadr tak, żeby wskazany przystanek na pewno był narysowany. */
  async function showStop(page, lat, lon, zoom = 16) {
    await page.evaluate(({ lat, lon, zoom }) => {
      document.querySelector('[role="application"]').__map.setView([lat, lon], zoom, { animate: false });
    }, { lat, lon, zoom });
  }

  async function assertOnScreenAndClickable(locator) {
    await locator.waitFor({ state: "visible" });
    const state = await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      let visible = true;
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) visible = false;
      }
      return { rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        inside: x > 0 && x < innerWidth && y > 0 && y < innerHeight,
        hit: hit === element || element.contains(hit), hitElement: hit?.outerHTML.slice(0, 300), visible };
    });
    assert.equal(state.inside, true, `element is outside the viewport: ${JSON.stringify(state)}`);
    assert.equal(state.visible, true, `element or an ancestor is hidden: ${JSON.stringify(state)}`);
    assert.equal(state.hit, true, `another overlay covers the element: ${JSON.stringify(state)}`);
  }

  async function assertBlueStopActuallyPainted(page, stop) {
    await page.waitForTimeout(350); // Wait for the marker's entrance animation to finish.
    await assertOnScreenAndClickable(stop);
    const box = await stop.boundingBox();
    assert.ok(box);
    const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
    const bluePixels = await page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] < 45 && pixels[i + 1] > 45 && pixels[i + 2] > 120 && pixels[i + 2] > pixels[i] * 2) count += 1;
      }
      return count;
    }, png.toString("base64"));
    assert.ok(bluePixels > 30, `expected painted blue marker pixels, got ${bluePixels}`);
  }

  // The GTFS update during startup must not wait for optional Overpass data.
  if (!process.env.TEST_CASE || process.env.TEST_CASE === "startup") {
    console.log("Checking startup, refresh, keyboard and map styles…");
    const { page, context, errors } = await openPage();
    await waitForGtfs(page);
    assert.equal(await page.evaluate(() => window.__overpassCalls), 0);
    const stop = page.locator('[data-stop-id="tt-a"]');
    const style = await stop.evaluate((element) => ({
      width: getComputedStyle(element).width,
      height: getComputedStyle(element).height,
      background: getComputedStyle(element).backgroundColor,
    }));
    assert.deepEqual(style, { width: "26px", height: "26px", background: "rgb(7, 93, 204)" });
    assert.match(await stop.locator("..").getAttribute("aria-label"), /^Przystanek Piłsudskiego/);
    await assertBlueStopActuallyPainted(page, stop);

    // Refreshing the viewport with a timed-out Overpass request must preserve
    // both the visible GTFS stop and the one elsewhere in the city.
    await page.getByRole("button", { name: "Pobierz przystanki dla bieżącego widoku mapy" }).click();
    await page.waitForFunction(() => window.__overpassCalls > 0);
    await page.waitForFunction(() => document.querySelector('button[aria-label="Pobierz przystanki dla bieżącego widoku mapy"]')?.textContent?.includes("2"));
    await waitForGtfs(page);
    await page.evaluate(() => document.querySelector('[role="application"]').__map.setView([50.82, 16.29], 16, { animate: false }));
    // Markery dochodzą po `moveend` (następna klatka), więc czekamy na sam marker.
    await page.locator('[data-stop-id="tt-b"]').waitFor({ state: "attached", timeout: 15000 });
    const northMarker = page.locator('[data-stop-id="tt-b"]').locator("..");
    await northMarker.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Północ" }).waitFor();
    await page.locator(".leaflet-tooltip.stop-name-label", { hasText: "Północ" }).waitFor();

    // Icons remain visible when switching basemaps.
    for (const name of ["Mapa jasna", "Satelita", "Mapa ciemna"]) {
      await page.getByRole("button", { name: "Styl mapy" }).click();
      await page.getByRole("button", { name: new RegExp(name) }).click();
      assert.equal(await page.locator('[data-stop-id="tt-b"]').isVisible(), true);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }

  // If GTFS is unavailable, the saved snapshot stays visible and is clearly labelled.
  if (!process.env.TEST_CASE || process.env.TEST_CASE === "offline") {
    console.log("Checking offline snapshot…");
    const { page, context, errors } = await openPage({ mode: "offline" });
    await page.waitForFunction(() => document.querySelectorAll('.bus-stop[data-stop-id^="snapshot-"]').length > 20);
    // Markery poza kadrem nie trafiają do DOM — w kadrze jest ich znacznie mniej niż ~550.
    assert.ok(await page.locator('.bus-stop[data-stop-id^="snapshot-"]').count() < 400);
    console.log("  Snapshot drawn (viewport culling)");
    const status = page.getByTestId("stop-data-status");
    await status.getByRole("button", { name: "Ponów" }).waitFor();
    assert.match(await status.innerText(), /migawki.*nieaktualne/i);
    console.log("  Offline message shown");
    await page.locator('[data-stop-id="snapshot-3"]').click();
    await page.getByRole("heading", { name: "Piłsudskiego - Plac Tuwima" }).waitFor();
    assert.match(await page.locator("body").innerText(), /Migawka · dane mogą być nieaktualne/i);
    const schedule = page.getByTestId("gtfs-schedule");
    await schedule.getByRole("alert").waitFor();
    assert.match(await schedule.innerText(), /Rozkład awaryjny też jest niedostępny/i);
    assert.equal(await schedule.getByTestId("compact-departure").count(), 0);
    console.log("  Snapshot selection and unavailable timetable message work");
    await status.getByRole("button", { name: "Ponów" }).click();
    await status.getByRole("button", { name: "Ponów" }).waitFor();
    assert.ok(await page.locator('.bus-stop[data-stop-id^="snapshot-"]').count() > 20);
    assert.deepEqual(errors, []);
    await context.close();
    console.log("  Offline check complete");
  }

  // A selection made while GTFS is loading follows the matching current stop.
  if (!process.env.TEST_CASE || process.env.TEST_CASE === "slow") {
    console.log("Checking selection during GTFS loading…");
    const { page, context, errors, releaseArchive } = await openPage({ mode: "slow" });
    await page.locator('[data-stop-id="snapshot-3"]').click();
    await page.getByRole("heading", { name: "Piłsudskiego - Plac Tuwima" }).waitFor();
    releaseArchive();
    await waitForGtfs(page);
    await page.locator('[data-stop-id="tt-a"].bus-stop--on').waitFor();
    assert.equal(await page.getByRole("heading", { name: "Piłsudskiego - Plac Tuwima" }).count(), 1);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // A saved "near route" mode cannot blank a planner with no route; explicit
  // hidden/all choices still work and survive a reload.
  if (!process.env.TEST_CASE || process.env.TEST_CASE === "visibility") {
    console.log("Checking saved visibility settings…");
    const { page, context, errors } = await openPage({ role: "planner", stops: "route" });
    await waitForGtfs(page);
    await page.getByRole("button", { name: "Ustawienia widoczności", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Ustawienia widoczności" });
    assert.equal(await dialog.getByRole("button", { name: "Wszystkie", exact: true }).getAttribute("aria-pressed"), "true");
    await dialog.getByRole("button", { name: "Przy trasie", exact: true }).click();
    await page.getByText("Wyznacz trasę, aby pokazać przystanki przy niej.").waitFor();
    assert.equal(await page.locator(".bus-stop").count(), 2);
    await dialog.getByRole("button", { name: "Ukryte", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".bus-stop").length === 0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Ustawienia widoczności", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Ustawienia widoczności" });
    assert.equal(await dialog.getByRole("button", { name: "Ukryte", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".bus-stop").count(), 0);
    await dialog.getByRole("button", { name: "Wszystkie", exact: true }).click();
    await waitForGtfs(page);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // SPA fallback HTML must be rejected so a valid remote archive can be used.
  if (!process.env.TEST_CASE || process.env.TEST_CASE === "html") {
    console.log("Checking invalid static asset fallback…");
    const { page, context, errors, requests } = await openPage({ mode: "html" });
    await waitForGtfs(page);
    assert.ok(requests.some((url) => url.includes("api.zbiorkom.live") && url.endsWith("/gtfs/default")));
    assert.deepEqual(errors, []);
    await context.close();
  }

  // The marker and the card's controls must be genuinely visible and clickable
  // on a narrow screen, not merely present in the DOM.
  if (!process.env.TEST_CASE || process.env.TEST_CASE === "mobile") {
    console.log("Checking mobile viewport and timetable controls…");
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
      const { page, context, errors } = await openPage({ viewport });
      await waitForGtfs(page);
      const stop = page.locator('[data-stop-id="tt-a"]');
      await assertBlueStopActuallyPainted(page, stop);
      await stop.click();
      await page.getByRole("heading", { name: "Piłsudskiego - Plac Tuwima" }).waitFor();
      const departure = page.getByTestId("compact-departure").filter({ hasText: "08:00" });
      await departure.scrollIntoViewIfNeeded();
      await assertOnScreenAndClickable(departure);
      await departure.click();
      await page.getByRole("region", { name: "Szczegóły odjazdu" }).waitFor();
      const close = page.getByRole("button", { name: "Zamknij kartę przystanku" });
      await assertOnScreenAndClickable(close);
      await close.click();
      await page.getByRole("heading", { name: "Piłsudskiego - Plac Tuwima" }).waitFor({ state: "hidden" });
      assert.deepEqual(errors, []);
      await context.close();
    }
    for (const viewport of [{ width: 320, height: 568 }, { width: 640, height: 568 }]) {
      const long = await openPage({ mode: "many", viewport });
      await waitForGtfs(long.page);
      await long.page.locator('[data-stop-id="tt-a"]').click();
      const last = long.page.getByTestId("compact-departure").filter({ hasText: "23:45" });
      await last.scrollIntoViewIfNeeded();
      await assertOnScreenAndClickable(last);
      await last.click();
      await long.page.getByRole("region", { name: "Szczegóły odjazdu" }).waitFor();
      const date = long.page.getByRole("button", { name: "Następny dzień" });
      await date.scrollIntoViewIfNeeded();
      await assertOnScreenAndClickable(date);
      assert.deepEqual(long.errors, []);
      await long.context.close();
    }
  }

  if (!process.env.TEST_CASE || process.env.TEST_CASE === "gps") {
    console.log("Checking GPS outside Wałbrzych and explicit stop search…");
    const { page, context, errors } = await openPage({ geo: { latitude: 51.1079, longitude: 17.0385 } });
    await waitForGtfs(page);
    await page.getByTestId("user-speed").waitFor();
    await page.waitForTimeout(1200);
    let center = await page.evaluate(() => document.querySelector('[role="application"]').__map.getCenter());
    assert.ok(Math.abs(center.lat - 50.7714) < 0.01, `GPS moved the initial map away from its stops: ${JSON.stringify(center)}`);
    await assertBlueStopActuallyPainted(page, page.locator('[data-stop-id="tt-a"]'));

    // Explicitly centering on the user still works even far outside the network.
    await page.getByTestId("center-on-me").click();
    await page.waitForFunction(() => Math.abs(document.querySelector('[role="application"]').__map.getCenter().lat - 51.1079) < 0.002);
    await page.getByRole("button", { name: "Przystanki", exact: true }).click();
    const finder = page.getByRole("dialog", { name: "Znajdź przystanek" });
    await finder.getByRole("searchbox", { name: "Szukaj przystanku" }).fill("Piłsudskiego - Plac Tuwima");
    await finder.getByRole("button", { name: /Piłsudskiego - Plac Tuwima/ }).click();
    await page.getByRole("heading", { name: "Piłsudskiego - Plac Tuwima" }).waitFor();
    await page.getByTestId("compact-departure").filter({ hasText: "08:00" }).waitFor();
    await page.waitForFunction(() => Math.abs(document.querySelector('[role="application"]').__map.getCenter().lat - 50.76697) < 0.002);
    await assertOnScreenAndClickable(page.locator('[data-stop-id="tt-a"]'));
    assert.equal(await page.getByTestId("center-on-me").getAttribute("aria-pressed"), "false");
    assert.deepEqual(errors, []);
    await context.close();

    // A nearby first fix keeps the existing useful automatic GPS centering.
    const near = await openPage({ geo: { latitude: 50.76697, longitude: 16.28661 } });
    await waitForGtfs(near.page);
    await near.page.waitForFunction(() => document.querySelector('[data-testid="center-on-me"]')?.getAttribute("aria-pressed") === "true");
    await near.page.waitForFunction(() => Math.abs(document.querySelector('[role="application"]').__map.getCenter().lat - 50.76697) < 0.002);
    await near.page.waitForTimeout(1000);
    await near.page.getByRole("button", { name: "Przybliż mapę" }).click();
    await near.page.waitForFunction(() => document.querySelector('[data-testid="center-on-me"]')?.getAttribute("aria-pressed") === "false");
    await near.page.getByTestId("center-on-me").click();
    await near.page.waitForFunction(() => document.querySelector('[data-testid="center-on-me"]')?.getAttribute("aria-pressed") === "true");
    // A new explicit fly while a tracking pan is running must not be mistaken
    // for a user zoom, which would switch follow mode back off.
    await near.page.waitForTimeout(1000);
    await near.context.setGeolocation({ latitude: 50.7676, longitude: 16.287, accuracy: 10 });
    await near.page.waitForTimeout(100);
    await near.page.getByTestId("center-on-me").click();
    await near.page.waitForTimeout(1000);
    assert.equal(await near.page.getByTestId("center-on-me").getAttribute("aria-pressed"), "true");
    assert.deepEqual(near.errors, []);
    await near.context.close();

    // A delayed first fix must not drag the map away after a stop was selected.
    const late = await openPage({ lateGeo: true });
    await waitForGtfs(late.page);
    await late.page.locator('[data-stop-id="tt-a"]').click();
    await late.page.getByRole("heading", { name: "Piłsudskiego - Plac Tuwima" }).waitFor();
    await late.page.waitForFunction(() => typeof window.__sendLocation === "function");
    await late.page.evaluate(() => window.__sendLocation({ coords: { latitude: 50.82, longitude: 16.29, accuracy: 10, altitude: null, heading: null, speed: null }, timestamp: Date.now() }));
    await late.page.getByTestId("user-speed").waitFor();
    await late.page.waitForTimeout(1200);
    center = await late.page.evaluate(() => document.querySelector('[role="application"]').__map.getCenter());
    assert.ok(Math.abs(center.lat - 50.7714) < 0.01, `late GPS fix displaced the selected stop: ${JSON.stringify(center)}`);
    assert.deepEqual(late.errors, []);
    await late.context.close();

    const dragged = await openPage({ lateGeo: true });
    await waitForGtfs(dragged.page);
    const mapBox = await dragged.page.locator('[role="application"]').boundingBox();
    assert.ok(mapBox);
    const x = mapBox.x + mapBox.width * 0.46;
    const y = mapBox.y + mapBox.height * 0.60;
    await dragged.page.mouse.move(x, y);
    await dragged.page.mouse.down();
    await dragged.page.mouse.move(x + 100, y + 35, { steps: 10 });
    await dragged.page.mouse.up();
    await dragged.page.waitForTimeout(500);
    const manualCenter = await dragged.page.evaluate(() => document.querySelector('[role="application"]').__map.getCenter());
    await dragged.page.evaluate(() => window.__sendLocation({ coords: { latitude: 50.82, longitude: 16.29, accuracy: 10, altitude: null, heading: null, speed: null }, timestamp: Date.now() }));
    await dragged.page.getByTestId("user-speed").waitFor();
    await dragged.page.waitForTimeout(1200);
    center = await dragged.page.evaluate(() => document.querySelector('[role="application"]').__map.getCenter());
    assert.ok(Math.abs(center.lat - manualCenter.lat) < 0.001 && Math.abs(center.lng - manualCenter.lng) < 0.001,
      `late GPS fix displaced a manually moved map: ${JSON.stringify({ manualCenter, center })}`);
    assert.deepEqual(dragged.errors, []);
    await dragged.context.close();

    const zoomed = await openPage({ lateGeo: true });
    await waitForGtfs(zoomed.page);
    await zoomed.page.getByRole("button", { name: "Przybliż mapę" }).click();
    await zoomed.page.waitForTimeout(500);
    const zoomBeforeFix = await zoomed.page.evaluate(() => document.querySelector('[role="application"]').__map.getZoom());
    await zoomed.page.evaluate(() => window.__sendLocation({ coords: { latitude: 50.82, longitude: 16.29, accuracy: 10, altitude: null, heading: null, speed: null }, timestamp: Date.now() }));
    await zoomed.page.getByTestId("user-speed").waitFor();
    await zoomed.page.waitForTimeout(1200);
    center = await zoomed.page.evaluate(() => document.querySelector('[role="application"]').__map.getCenter());
    assert.ok(Math.abs(center.lat - 50.7714) < 0.01, `late GPS fix displaced the zoomed map: ${JSON.stringify(center)}`);
    assert.equal(await zoomed.page.evaluate(() => document.querySelector('[role="application"]').__map.getZoom()), zoomBeforeFix);
    assert.deepEqual(zoomed.errors, []);
    await zoomed.context.close();
  }

  if (!process.env.TEST_CASE || process.env.TEST_CASE === "hidden") {
    console.log("Checking recovery from a deliberately hidden stop layer…");
    const { page, context, errors } = await openPage({ stops: "off" });
    await page.getByText("Przystanki są ukryte.").waitFor();
    assert.equal(await page.locator(".bus-stop").count(), 0);
    await page.getByRole("button", { name: "Pokaż przystanki", exact: true }).click();
    await waitForGtfs(page);
    await assertBlueStopActuallyPainted(page, page.locator('[data-stop-id="tt-a"]'));
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForGtfs(page);
    assert.equal(await page.getByText("Przystanki są ukryte.").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();

    // Search itself also restores the layer and opens the requested stop.
    const search = await openPage({ stops: "off" });
    await search.page.getByRole("button", { name: "Przystanki", exact: true }).click();
    const finder = search.page.getByRole("dialog", { name: "Znajdź przystanek" });
    await finder.getByRole("searchbox", { name: "Szukaj przystanku" }).fill("Piłsudskiego - Plac Tuwima");
    await finder.getByRole("button", { name: /Piłsudskiego - Plac Tuwima/ }).first().click();
    await search.page.getByRole("heading", { name: "Piłsudskiego - Plac Tuwima" }).waitFor();
    await search.page.getByTestId("compact-departure").filter({ hasText: "08:00" }).waitFor();
    await waitForGtfs(search.page);
    assert.deepEqual(search.errors, []);
    await search.context.close();
  }

  if (!process.env.TEST_CASE || process.env.TEST_CASE === "search") {
    console.log("Checking stop search respects traveler and planner line visibility…");
    const traveler = await openPage();
    await waitForGtfs(traveler.page);
    await traveler.page.getByRole("button", { name: "Przystanki", exact: true }).click();
    let finder = traveler.page.getByRole("dialog", { name: "Znajdź przystanek" });
    await finder.getByRole("searchbox", { name: "Szukaj przystanku" }).fill("S1");
    await finder.getByText("Brak przystanków pasujących do wyszukiwania.").waitFor();
    await finder.getByRole("searchbox", { name: "Szukaj przystanku" }).fill("Piłsudskiego");
    assert.doesNotMatch(await finder.innerText(), /\bS1\b/);
    assert.deepEqual(traveler.errors, []);
    await traveler.context.close();

    const planner = await openPage({ role: "planner" });
    await waitForGtfs(planner.page);
    await planner.page.getByRole("button", { name: "Przystanki", exact: true }).click();
    finder = planner.page.getByRole("dialog", { name: "Znajdź przystanek" });
    await finder.getByRole("searchbox", { name: "Szukaj przystanku" }).fill("S1");
    await finder.getByRole("button", { name: /Piłsudskiego.*S1/ }).click();
    await planner.page.getByRole("heading", { name: "Piłsudskiego - Plac Tuwima" }).waitFor();
    await planner.page.getByTestId("compact-departure").filter({ hasText: "11:30" }).waitFor();
    assert.deepEqual(planner.errors, []);
    await planner.context.close();
  }

  if (!process.env.TEST_CASE || process.env.TEST_CASE === "schedule") {
    console.log("Checking timetable is immediate when GPS is stalled, then enriched…");
    const { page, context, errors, requests, releaseLive } = await openPage({ mode: "live-hang" });
    await waitForGtfs(page);
    await page.locator('[data-stop-id="tt-a"]').click();
    const first = page.getByTestId("compact-departure").filter({ hasText: "08:00" });
    await first.waitFor({ state: "visible", timeout: 2500 });
    await page.getByTestId("compact-departure").filter({ hasText: "09:35" }).waitFor({ state: "visible", timeout: 2500 });
    assert.equal(await page.getByTestId("gtfs-schedule").getAttribute("aria-busy"), "false");
    await page.waitForFunction(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('/stops/a')) || document.querySelector('[data-testid="compact-departure"]'));
    assert.ok(requests.some((url) => url.includes("/stops/a")), "the live request should really be stalled during this test");
    releaseLive();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="compact-departure"]')].some((el) => el.getAttribute('aria-label')?.includes('08:00') && el.getAttribute('aria-label')?.includes('GPS')));
    await page.getByRole("button", { name: "Następny dzień" }).click();
    await page.getByTestId("compact-departure").filter({ hasText: "10:15" }).waitFor();
    assert.equal(await page.getByTestId("compact-departure").filter({ hasText: "08:00" }).count(), 0);
    await page.getByRole("button", { name: "Następny dzień" }).click();
    await page.getByText("Brak odjazdów tego dnia.").waitFor();
    assert.equal(await page.getByTestId("gtfs-schedule").getByRole("alert").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();

    const stale = await openPage({ mode: "live-hang" });
    await waitForGtfs(stale.page);
    await stale.page.locator('[data-stop-id="tt-a"]').click();
    await stale.page.getByTestId("compact-departure").filter({ hasText: "08:00" }).waitFor();
    await stale.page.getByRole("button", { name: "Następny dzień" }).click();
    await stale.page.getByTestId("compact-departure").filter({ hasText: "10:15" }).waitFor();
    stale.releaseLive();
    await stale.page.waitForTimeout(300);
    assert.equal(await stale.page.getByTestId("compact-departure").filter({ hasText: "08:00" }).count(), 0);
    assert.deepEqual(stale.errors, []);
    await stale.context.close();
  }

  if (!process.env.TEST_CASE || process.env.TEST_CASE === "fallback") {
    console.log("Checking replayed real API responses when the GTFS archive is unavailable…");
    const { page, context, errors } = await openPage({ mode: "fallback", viewport: { width: 320, height: 568 } });
    const marker = page.locator('[data-stop-id="snapshot-3"]');
    await assertBlueStopActuallyPainted(page, marker);
    await marker.click();
    await page.getByRole("heading", { name: "Piłsudskiego - Plac Tuwima" }).waitFor();
    const schedule = page.getByTestId("gtfs-schedule");
    await schedule.getByText(/Rozkład awaryjny: zbiorkom.live/).waitFor();
    const first = schedule.getByTestId("compact-departure").filter({ hasText: "04:30" });
    await assertOnScreenAndClickable(first);
    assert.equal(await schedule.getByTestId("compact-departure").count(), 3);
    await first.click();
    await page.getByRole("region", { name: "Szczegóły odjazdu" }).waitFor();
    assert.equal(await page.getByTestId("preview-departure-course").count(), 0);
    await page.getByRole("button", { name: "Następny dzień" }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="Dzień rozkładu"]')?.value === '2026-11-20' && document.querySelector('[data-testid="gtfs-schedule"]')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('[data-testid="compact-departure"]').length === 1);
    assert.equal(await schedule.getByTestId("compact-departure").first().innerText(), "04:30");
    assert.deepEqual(errors, []);
    await context.close();

    // A slow archive must not hide fallback departures, and the real GTFS wins
    // when it becomes available later (the archive here is still synthetic).
    const slow = await openPage({ mode: "slow-fallback" });
    await slow.page.locator('[data-stop-id="snapshot-3"]').click();
    await slow.page.getByTestId("gtfs-schedule").getByText(/Rozkład awaryjny: zbiorkom.live/).waitFor();
    await slow.page.getByTestId("compact-departure").filter({ hasText: "04:30" }).waitFor();
    slow.releaseArchive();
    await waitForGtfs(slow.page);
    await slow.page.getByTestId("compact-departure").filter({ hasText: "08:00" }).waitFor();
    assert.equal(await slow.page.getByText(/Rozkład awaryjny: zbiorkom.live/).count(), 0);
    assert.deepEqual(slow.errors, []);
    await slow.context.close();

    // A snapshot selected before GTFS arrives must not be closed, or silently
    // replaced by another stop, when the archive has no matching platform.
    const missing = await openPage({ mode: "slow-fallback" });
    await missing.page.locator('[data-stop-id="snapshot-2"]').click();
    await missing.page.getByTestId("compact-departure").filter({ hasText: "03:54" }).waitFor();
    missing.releaseArchive();
    await waitForGtfs(missing.page);
    await missing.page.getByRole("heading", { name: "Mickiewicza - Plac Tuwima" }).waitFor();
    await missing.page.getByTestId("gtfs-schedule").getByText(/Rozkład awaryjny: zbiorkom.live/).waitFor();
    assert.equal(await missing.page.getByTestId("compact-departure").filter({ hasText: "03:54" }).count(), 1);
    assert.equal(await missing.page.getByTestId("compact-departure").filter({ hasText: "08:00" }).count(), 0);
    assert.deepEqual(missing.errors, []);
    await missing.context.close();

    // An expired GTFS is not a valid "no departures" answer. Prefer current
    // fallback data, or explicitly tell the user if that is also unavailable.
    const expired = await openPage({ mode: "expired-fallback" });
    await waitForGtfs(expired.page);
    await expired.page.locator('[data-stop-id="tt-a"]').click();
    await expired.page.getByTestId("gtfs-schedule").getByText(/Rozkład awaryjny: zbiorkom.live/).waitFor();
    await expired.page.getByTestId("compact-departure").filter({ hasText: "04:30" }).waitFor();
    assert.equal(await expired.page.getByTestId("compact-departure").filter({ hasText: "08:00" }).count(), 0);
    assert.deepEqual(expired.errors, []);
    await expired.context.close();

    const expiredOffline = await openPage({ mode: "expired-offline" });
    await waitForGtfs(expiredOffline.page);
    await expiredOffline.page.locator('[data-stop-id="tt-a"]').click();
    await expiredOffline.page.getByRole("alert").filter({ hasText: /GTFS nie obejmuje wybranego dnia/ }).waitFor();
    assert.equal(await expiredOffline.page.getByTestId("compact-departure").count(), 0);
    assert.deepEqual(expiredOffline.errors, []);
    await expiredOffline.context.close();

    // A previous, valid service day may contain a trip after midnight, even
    // though the selected calendar day is outside feed_info. Show it as partial.
    const partial = await openPage({ mode: "expired-partial" });
    await waitForGtfs(partial.page);
    await partial.page.locator('[data-stop-id="tt-a"]').click();
    const partialSchedule = partial.page.getByTestId("gtfs-schedule");
    await partialSchedule.getByText(/Rozkład GTFS nie obejmuje całego dnia/).waitFor();
    const overnight = partialSchedule.getByTestId("compact-departure").filter({ hasText: "00:30" });
    await overnight.click();
    await partial.page.getByTestId("preview-departure-course").waitFor();
    assert.equal(await partialSchedule.getByTestId("compact-departure").count(), 1);
    assert.deepEqual(partial.errors, []);
    await partial.context.close();

    // Changing stops while a response is in flight must never display the old
    // stop's departures under the new stop's name.
    const switching = await openPage({ mode: "switch-fallback" });
    const firstRequest = switching.page.waitForEvent("request", {
      predicate: (request) => request.url().includes("/stops/pilsudskiego-plac-tuwima-a8ncm"),
      timeout: 10_000,
    });
    await switching.page.locator('[data-stop-id="snapshot-3"]').click();
    await firstRequest;
    await switching.page.evaluate(() => document.querySelector('[role="application"]').__map.setView([50.76508, 16.28453], 16, { animate: false }));
    await switching.page.locator('[data-stop-id="snapshot-2"]').click();
    await switching.page.getByRole("heading", { name: "Mickiewicza - Plac Tuwima" }).waitFor();
    await switching.page.getByTestId("gtfs-schedule").getByText(/Rozkład awaryjny: zbiorkom.live/).waitFor();
    await switching.page.getByTestId("compact-departure").filter({ hasText: "03:54" }).waitFor();
    switching.releaseFallback();
    await switching.page.waitForTimeout(350);
    assert.equal(await switching.page.getByTestId("compact-departure").filter({ hasText: "04:30" }).count(), 0);
    assert.equal(await switching.page.getByTestId("compact-departure").filter({ hasText: "03:54" }).count(), 1);
    assert.deepEqual(switching.errors, []);
    await switching.context.close();
  }
  // Przystanki rysujemy tylko wokół widoku — mniej elementów DOM = płynniejsza mapa.
  if (!process.env.TEST_CASE || process.env.TEST_CASE === "culling") {
    console.log("Checking viewport culling of stop markers…");
    const { page, context, errors } = await openPage({ role: "planner" });
    await waitForGtfs(page);
    const drawn = await page.locator(".bus-stop").count();
    assert.ok(drawn > 10, `expected stop markers around the view, got ${drawn}`);
    assert.ok(drawn < 400, `expected culling (dataset has ~550 stops), got ${drawn}`);

    // Skok w inny rejon mapy wymienia markery, nie dokłada ich bez końca.
    await showStop(page, 50.62, 16.36, 15);
    await page.waitForTimeout(500);
    const moved = await page.locator(".bus-stop").count();
    assert.ok(moved > 0, "markers follow the viewport");
    assert.ok(moved < 400, `markers stay culled after panning, got ${moved}`);
    assert.equal(
      await page.locator('[data-stop-id="tt-a"]').count(),
      0,
      "markers far outside the viewport are removed from the DOM",
    );
    assert.deepEqual(errors, []);
    await context.close();
  }

  console.log("stop map browser tests passed");
} finally {
  await browser?.close();
  await server.close();
}
