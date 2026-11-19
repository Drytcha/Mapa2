// npm run test:stops:e2e
// Install a Playwright Chromium browser, or set CHROMIUM_PATH to a local executable.
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const files = {
  "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.com,pl,20260101,20261231\n",
  "routes.txt": "route_id,route_short_name,route_long_name,route_type\nr1,7,Test,3\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\na,Piłsudskiego - Plac Tuwima,50.76697,16.28661\nb,Północ,50.82,16.29\nc,Koniec,50.83,16.29\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign\nr1,daily,t1,Koniec\nr1,daily,t2,Koniec\n",
  "calendar_dates.txt": "service_id,date,exception_type\ndaily,20261119,1\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nt1,08:00:00,08:00:00,a,1,0,0\nt1,08:10:00,08:10:00,c,2,0,0\nt2,08:00:00,08:00:00,b,1,0,0\nt2,08:10:00,08:10:00,c,2,0,0\n",
};
const zip = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), { level: 0 }));
const tile = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce4d7"/><path d="M0 82H256M0 180H256M70 0V256M190 0V256" fill="none" stroke="#f5f4ee" stroke-width="8"/></svg>';

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

  async function openPage({ mode = "online", role, stops, mobile = false } = {}) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 850 } });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    const requests = [];
    let releaseArchive = () => {};
    const archiveReady = mode === "slow" ? new Promise((resolve) => { releaseArchive = resolve; }) : Promise.resolve();
    page.on("close", () => releaseArchive());
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(({ role, stops }) => {
      if (role && !localStorage.getItem("mapplaner.role")) localStorage.setItem("mapplaner.role", role);
      if (stops && !localStorage.getItem("mapplaner.visibility.v2")) {
        localStorage.setItem("mapplaner.visibility.v2", JSON.stringify({ stops, liveBuses: false }));
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
    }, { role, stops });
    await page.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      requests.push(requestUrl.href);
      if (requestUrl.origin === baseUrl) {
        if (requestUrl.pathname.endsWith("/walbrzych-gtfs.zip")) {
          await archiveReady;
          if (mode === "offline") return route.fulfill({ status: 503, body: "offline" });
          if (mode === "html") return route.fulfill({ status: 200, contentType: "text/html", body: "<html>" + "x".repeat(1600) + "</html>" });
          return route.fulfill({ status: 200, contentType: "application/zip", body: zip });
        }
        return route.continue();
      }
      if (requestUrl.hostname === "tile.openstreetmap.org" || requestUrl.hostname === "server.arcgisonline.com") {
        return route.fulfill({ status: 200, contentType: "image/svg+xml", headers: { "Access-Control-Allow-Origin": "*" }, body: tile });
      }
      if (requestUrl.hostname === "api.zbiorkom.live" && requestUrl.pathname.endsWith("/gtfs/default") && mode === "html") {
        return route.fulfill({ status: 200, contentType: "application/zip", headers: { "Access-Control-Allow-Origin": "*" }, body: zip });
      }
      return route.abort();
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    return { page, context, errors, requests, releaseArchive };
  }

  async function waitForGtfs(page) {
    await page.locator('[data-stop-id="tt-a"]').waitFor({ state: "attached", timeout: 15000 });
    await page.locator('[data-stop-id="tt-b"]').waitFor({ state: "attached", timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('.bus-stop[data-stop-id^="tt-"]').length === 2);
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

    // Refreshing the viewport with a timed-out Overpass request must preserve
    // both the visible GTFS stop and the one elsewhere in the city.
    await page.getByRole("button", { name: "Pobierz przystanki dla bieżącego widoku mapy" }).click();
    await page.waitForFunction(() => window.__overpassCalls > 0);
    await page.waitForFunction(() => document.querySelector('button[aria-label="Pobierz przystanki dla bieżącego widoku mapy"]')?.textContent?.includes("2"));
    await waitForGtfs(page);
    await page.evaluate(() => document.querySelector('[role="application"]').__map.setView([50.82, 16.29], 16, { animate: false }));
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
    await page.waitForFunction(() => document.querySelectorAll('.bus-stop[data-stop-id^="snapshot-"]').length > 400);
    console.log("  Snapshot drawn");
    const status = page.getByTestId("stop-data-status");
    await status.getByRole("button", { name: "Ponów" }).waitFor();
    assert.match(await status.innerText(), /migawki.*nieaktualne/i);
    console.log("  Offline message shown");
    await page.locator('[data-stop-id="snapshot-3"]').click();
    await page.getByRole("heading", { name: "Piłsudskiego - Plac Tuwima" }).waitFor();
    assert.match(await page.locator("body").innerText(), /Migawka · dane mogą być nieaktualne/i);
    console.log("  Snapshot selection works");
    await status.getByRole("button", { name: "Ponów" }).click();
    await status.getByRole("button", { name: "Ponów" }).waitFor();
    assert.ok(await page.locator('.bus-stop[data-stop-id^="snapshot-"]').count() > 400);
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

  // The marker remains usable on a narrow touch-sized viewport.
  if (!process.env.TEST_CASE || process.env.TEST_CASE === "mobile") {
    console.log("Checking mobile viewport…");
    const { page, context, errors } = await openPage({ mobile: true });
    await waitForGtfs(page);
    await page.locator('[data-stop-id="tt-a"]').click();
    await page.getByRole("heading", { name: "Piłsudskiego - Plac Tuwima" }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("stop map browser tests passed");
} finally {
  await browser?.close();
  await server.close();
}
