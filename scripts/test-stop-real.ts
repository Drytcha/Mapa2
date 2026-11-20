// REAL_GTFS_ZIP=src/assets/walbrzych-gtfs.zip npm run test:stops:real
// Unlike the other browser tests, this consumes the supplied actual GTFS archive.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DateTime } from "luxon";
import { strFromU8, unzipSync } from "fflate";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { getTimetableStops } from "../src/lib/engine/timetableStops";
import { getStopDepartures } from "../src/lib/engine/gtfsStore";
import { isPlannerOnlyLine } from "../src/lib/core/text";

const archivePath = process.env.REAL_GTFS_ZIP;
if (!archivePath) throw new Error("Set REAL_GTFS_ZIP to the real Wałbrzych GTFS archive.");
const bytes = await readFile(archivePath);
const files = unzipSync(bytes);
const readText = (name: string) => files[name] ? strFromU8(files[name]) : "";

// Independent check against raw CSV, rather than merely trusting the app's
// departure index. GTFS fields may be quoted and contain commas.
function parseLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(field.trim());
      field = "";
    } else field += char;
  }
  fields.push(field.trim());
  return fields;
}
function csvRows(text: string): Array<Record<string, string>> {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headers = parseLine(lines.shift() ?? "");
  return lines.map((line) => {
    const fields = parseLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? ""]));
  });
}
const trips = new Map(csvRows(readText("trips.txt")).map((row) => [row.trip_id, row]));
const calendar = csvRows(readText("calendar.txt"));
const exceptions = csvRows(readText("calendar_dates.txt"));
const stopTimeText = readText("stop_times.txt");
assert.ok(trips.size && stopTimeText, "The archive must contain trips.txt and stop_times.txt.");

function isActive(serviceId: string, dateId: string): boolean {
  const day = DateTime.fromFormat(dateId, "yyyyLLdd", { zone: "Europe/Warsaw" });
  const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  let active = calendar.some((row) => row.service_id === serviceId && row.start_date <= dateId && row.end_date >= dateId && row[weekdays[day.weekday - 1]] === "1");
  for (const row of exceptions) {
    if (row.service_id === serviceId && row.date === dateId) {
      if (row.exception_type === "1" || row.exception_type === "") active = true;
      if (row.exception_type === "2") active = false;
    }
  }
  return active;
}
function rawContainsDeparture(tripId: string, stopId: string, clock: string): boolean {
  const lines = stopTimeText.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = parseLine(lines[0]);
  const tripCol = header.indexOf("trip_id");
  const stopCol = header.indexOf("stop_id");
  const depCol = header.indexOf("departure_time");
  const arrCol = header.indexOf("arrival_time");
  const pickCol = header.indexOf("pickup_type");
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i].includes(tripId)) continue;
    const row = parseLine(lines[i]);
    if (row[tripCol] !== tripId || row[stopCol] !== stopId || row[pickCol] === "1") continue;
    const raw = (row[depCol] || row[arrCol] || "").split(":").map(Number);
    if (raw.length < 2 || !Number.isFinite(raw[0]) || !Number.isFinite(raw[1])) continue;
    const minutes = (raw[0] * 60 + raw[1] + Math.round((raw[2] || 0) / 60)) % 1440;
    const rawClock = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    if (rawClock === clock) return true;
  }
  return false;
}

// The Node engine and the browser both load exactly the supplied archive;
// live services are intentionally unavailable to test independent static times.
globalThis.fetch = async (input) => String(input).includes("walbrzych-gtfs.zip")
  ? new Response(new Uint8Array(bytes), { status: 200 })
  : new Response("", { status: 404 });
const { stops } = await getTimetableStops();
const byId = new Map(stops.filter((stop) => stop.gtfsId).map((stop) => [stop.gtfsId!, stop]));
const allIds = stops.flatMap((stop) => stop.gtfsIds ?? (stop.gtfsId ? [stop.gtfsId] : []));
assert.equal(new Set(allIds).size, allIds.length, "Each GTFS stop may belong to only one visible platform.");
assert.ok(byId.size, "No boardable stops found in the supplied GTFS archive.");
const start = DateTime.now().setZone("Europe/Warsaw").startOf("day");
const fromMs = start.toMillis();
const toMs = start.plus({ days: 1 }).toMillis();
const server = await createServer({ logLevel: "error", server: { host: "0.0.0.0", port: 5173, strictPort: false } });
let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite did not start on a TCP port.");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  // Verify every merged platform against independent per-ID timetable queries.
  for (const stop of stops.filter((entry) => (entry.gtfsIds?.length ?? 0) > 1)) {
    const options = { lat: stop.lat, lon: stop.lon, name: stop.name, fromMs, toMs, includeLive: false };
    const merged = await getStopDepartures({ ...options, stopIds: stop.gtfsIds });
    const parts = await Promise.all(stop.gtfsIds!.map((stopId) => getStopDepartures({ ...options, stopId })));
    const keys = (rows: typeof merged.departures) => [...new Set(rows.map((d) => `${d.tripId}|${d.serviceDateId}|${d.atMs}`))].sort();
    assert.deepEqual(keys(merged.departures), keys(parts.flatMap((part) => part.departures)), `Incomplete timetable: ${stop.name}`);
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: ["--no-sandbox", ...(process.env.CHROMIUM_ARGS?.split(" ").filter(Boolean) ?? [])],
  });
  const tile = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce4d7"/></svg>';
  for (const viewport of [{ width: 1365, height: 850 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === baseUrl) {
        // An embedded asset is first imported as a JavaScript URL module.
        // Intercept only the archive bytes, not Vite's ?import&url module.
        if (url.pathname.endsWith("/walbrzych-gtfs.zip") && !url.searchParams.has("import")) {
          return route.fulfill({ status: 200, contentType: "application/zip", body: bytes });
        }
        return route.continue();
      }
      if (url.hostname === "tile.openstreetmap.org") return route.fulfill({ status: 200, contentType: "image/svg+xml", body: tile });
      return route.abort();
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll('.bus-stop[data-stop-id^="tt-"]').length > 0, null, { timeout: 60_000 });
    await page.waitForTimeout(1_000); // allow marker chunks and entrance animation to finish
    const onScreen = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.bus-stop[data-stop-id^="tt-"]')].flatMap((element) => {
      const box = element.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (x <= 0 || y <= 0 || x >= innerWidth || y >= innerHeight || !(hit === element || element.contains(hit)) || getComputedStyle(element).opacity === "0") return [];
      return [element.dataset.stopId!.slice(3)];
    }));
    assert.ok(onScreen.length, "No clickable GTFS stop is actually visible in the viewport.");
    let selected: { stopId: string; departure: Awaited<ReturnType<typeof getStopDepartures>>["departures"][number] } | null = null;
    for (const stopId of onScreen) {
      const stop = byId.get(stopId);
      if (!stop) continue;
      const schedule = await getStopDepartures({ lat: stop.lat, lon: stop.lon, name: stop.name, stopId, stopIds: stop.gtfsIds, fromMs, toMs, includeLive: false });
      const departure = schedule.departures.find((item) => !isPlannerOnlyLine(item.routeShort));
      if (departure) { selected = { stopId, departure }; break; }
    }
    assert.ok(selected, `No visible stop has passenger departures on ${start.toISODate()}; check the GTFS validity.`);
    const trip = trips.get(selected.departure.tripId);
    assert.ok(trip && isActive(trip.service_id, selected.departure.serviceDateId), "The departure's service day must be active in the supplied CSV calendar.");
    assert.ok((byId.get(selected.stopId)?.gtfsIds ?? [selected.stopId]).some((id) => rawContainsDeparture(selected!.departure.tripId, id, selected!.departure.clock)), "The displayed departure must exist in the actual stop_times.txt.");
    const stop = page.locator(`[data-stop-id=${JSON.stringify(`tt-${selected.stopId}`)}]`);
    await stop.click({ timeout: 10_000 });
    await page.getByRole("heading", { name: byId.get(selected.stopId)!.name, exact: true }).waitFor({ timeout: 15_000 });
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const departure = page.getByTestId("gtfs-schedule").getByRole("button", { name: new RegExp(`^Linia ${escape(selected.departure.routeShort)}, ${escape(selected.departure.clock)}`) });
    await departure.first().waitFor({ state: "visible", timeout: 15_000 });
    await departure.first().scrollIntoViewIfNeeded();
    await departure.first().click();
    await page.getByRole("region", { name: "Szczegóły odjazdu" }).waitFor();
    assert.equal(await page.getByText(/Rozkład awaryjny: zbiorkom.live/).count(), 0);
    assert.deepEqual(errors, []);
    console.log(`${viewport.width}px: ${byId.get(selected.stopId)!.name} · linia ${selected.departure.routeShort} · ${selected.departure.clock} verified against GTFS CSV`);
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
