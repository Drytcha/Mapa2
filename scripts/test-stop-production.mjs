// npm run test:stops:build
// Build an isolated GitHub Pages-style single-file bundle with SYNTHETIC GTFS,
// then exercise the embedded archive, marker and timetable in Chromium.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { strToU8, zipSync } from "fflate";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(path.join(tmpdir(), "mapa-stops-build-"));
const files = {
  "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.com,pl,20260101,20261231\n",
  "routes.txt": "route_id,route_short_name,route_long_name,route_type\nr1,7,Test,3\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\na,Piłsudskiego - Plac Tuwima,50.76697,16.28661\nb,Koniec,50.83,16.29\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign\nr1,daily,t1,Koniec\n",
  "calendar_dates.txt": "service_id,date,exception_type\ndaily,20261119,1\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nt1,08:00:00,08:00:00,a,1,0,0\nt1,08:10:00,08:10:00,b,2,0,0\n",
  // Exceed Vite's default 4 KB asset limit to exercise single-file inlining.
  "padding.txt": "x".repeat(16_384),
};
const zip = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), { level: 0 });
let server;
let browser;
try {
  await cp(path.join(root, "src"), path.join(scratch, "src"), { recursive: true });
  await mkdir(path.join(scratch, "src/assets"), { recursive: true });
  await writeFile(path.join(scratch, "src/assets/walbrzych-gtfs.zip"), zip);
  for (const file of ["index.html", "package.json", "vite.config.ts", "tsconfig.json"]) {
    await cp(path.join(root, file), path.join(scratch, file));
  }
  await symlink(path.join(root, "node_modules"), path.join(scratch, "node_modules"), "dir");
  await promisify(execFile)(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build"], {
    cwd: scratch,
    env: { ...process.env, GITHUB_PAGES: "true", NEXT_PUBLIC_STATIC_EXPORT: "1", NEXT_PUBLIC_BASE_PATH: "/Mapa2" },
    maxBuffer: 10_000_000,
  });
  const html = await readFile(path.join(scratch, "dist/index.html"));
  assert.match(html.toString("utf8"), /data:application\/(?:zip|octet-stream);base64,/);
  server = createServer((request, response) => {
    if (request.url === "/Mapa2/" || request.url === "/Mapa2/index.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "0.0.0.0", resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: ["--no-sandbox", ...(process.env.CHROMIUM_ARGS?.split(" ").filter(Boolean) ?? [])],
  });
  const tile = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce4d7"/></svg>';
  for (const viewport of [{ width: 1365, height: 850 }, { width: 320, height: 568 }]) {
    const context = await browser.newContext({ viewport, permissions: ["geolocation"], geolocation: { latitude: 51.1079, longitude: 17.0385 } });
    const page = await context.newPage();
    const errors = [];
    const archiveRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const NativeDate = Date;
      const offset = NativeDate.parse("2026-11-19T07:00:00+01:00") - NativeDate.now();
      window.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [NativeDate.now() + offset])); }
        static now() { return NativeDate.now() + offset; }
      };
      const nativeFetch = window.fetch;
      window.__embeddedGtfsFetched = false;
      window.fetch = (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (/^data:application\/(?:zip|octet-stream);base64,/i.test(url)) window.__embeddedGtfsFetched = true;
        return nativeFetch(input, init);
      };
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === "data:") return route.continue();
      if (url.origin === baseUrl) {
        if (url.pathname.endsWith("walbrzych-gtfs.zip")) archiveRequests.push(url.href);
        return route.continue();
      }
      if (url.hostname === "tile.openstreetmap.org") return route.fulfill({ status: 200, contentType: "image/svg+xml", body: tile });
      return route.abort();
    });
    await page.goto(`${baseUrl}/Mapa2/`, { waitUntil: "domcontentloaded" });
    const stop = page.locator('[data-stop-id="tt-a"]');
    await stop.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(400);
    const clickable = await stop.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return x > 0 && x < innerWidth && y > 0 && y < innerHeight && (hit === element || element.contains(hit));
    });
    assert.equal(clickable, true, `marker must be visible and clickable in the ${viewport.width}px production viewport`);
    await stop.click();
    await page.getByRole("heading", { name: "Piłsudskiego - Plac Tuwima" }).waitFor();
    const departure = page.getByTestId("compact-departure").filter({ hasText: "08:00" });
    await departure.waitFor({ state: "visible", timeout: 10_000 });
    await departure.scrollIntoViewIfNeeded();
    await departure.click();
    await page.getByRole("region", { name: "Szczegóły odjazdu" }).waitFor();
    assert.equal(await page.getByText(/Rozkład awaryjny: zbiorkom.live/).count(), 0);
    assert.equal(await page.evaluate(() => window.__embeddedGtfsFetched), true, "the ZIP should be read from the built HTML itself");
    assert.deepEqual(archiveRequests, [], "no separate ZIP should be needed on GitHub Pages");
    assert.deepEqual(errors, []);
    console.log(`${viewport.width}px: embedded synthetic GTFS marker and timetable work under /Mapa2/`);
    await context.close();
  }
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
