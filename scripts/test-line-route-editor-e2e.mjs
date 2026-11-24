// node scripts/test-line-route-editor-e2e.mjs
// End-to-end test w Chromium:
//  1. Planista otwiera Edytor przebiegu tras linii, upraszcza/edytuje przebieg linii 7,
//     dodaje notatkę i zapisuje do wspólnego pliku (/api/line-route-overrides).
//  2. Niezależny użytkownik (pasażer w czystym kontekście bez roli Planisty) otwiera
//     aplikację i od razu widzi poprawiony przebieg w katalogu linii (bez przycisków edycji).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const OVERRIDES_PATH = path.resolve("src/data/line-route-overrides.json");
const originalOverridesFile = fs.readFileSync(OVERRIDES_PATH, "utf8");

const files = {
  "feed_info.txt":
    "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.com,pl,20260101,20261231\n",
  "routes.txt":
    "route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n" +
    "r7,7,Podzamcze - Centrum,3,006e28,FFFFFF\n",
  "stops.txt":
    "stop_id,stop_name,stop_lat,stop_lon,location_type\n" +
    "s1,Podzamcze,50.81000,16.26000,0\n" +
    "s2,Żeromskiego,50.79000,16.27500,0\n" +
    "s3,Pl. Grunwaldzki,50.77000,16.28500,0\n",
  "calendar_dates.txt":
    "service_id,date,exception_type\n2026_RS,20261124,1\n2026_RS,20261125,1\n",
  "trips.txt":
    "route_id,service_id,trip_id,trip_headsign,block_id,shape_id,direction_id\n" +
    "r7,2026_RS,t7_1,Pl. Grunwaldzki,7/01,sh7_e2e,0\n",
  "stop_times.txt":
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n" +
    "t7_1,10:00:00,10:00:00,s1,1,0,0\n" +
    "t7_1,10:08:00,10:08:00,s2,2,0,0\n" +
    "t7_1,10:15:00,10:15:00,s3,3,0,0\n",
  "shapes.txt":
    "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n" +
    "sh7_e2e,50.81000,16.26000,1\n" +
    "sh7_e2e,50.80500,16.26300,2\n" +
    "sh7_e2e,50.80000,16.26600,3\n" +
    "sh7_e2e,50.79500,16.26900,4\n" +
    "sh7_e2e,50.79000,16.27200,5\n" +
    "sh7_e2e,50.78000,16.27800,6\n" +
    "sh7_e2e,50.77000,16.28500,7\n",
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
  server: { host: "0.0.0.0", port: 5205, strictPort: false },
});
await server.listen();
const address = server.httpServer.address();
if (!address || typeof address === "string") throw new Error("Vite server failed to bind");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function setupRoutes(context) {
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(baseUrl)) return route.continue();
    if (url.includes("tile.openstreetmap.org") || url.includes("arcgisonline")) {
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: tile });
    }
    if (url.includes("zbiorkom.live") || url.includes("livetransport.eu")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    if (url.includes(".zip") || url.includes("/api/transit/gtfs")) {
      return route.fulfill({ status: 200, contentType: "application/zip", body: zip });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

let browser;
try {
  // Zacznij od czystego pliku overrides
  fs.writeFileSync(
    OVERRIDES_PATH,
    `${JSON.stringify({ version: 1, updatedAt: "2026-11-24T00:00:00.000Z", overrides: {} }, null, 2)}\n`,
    "utf8",
  );

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: ["--no-sandbox"],
  });

  // ── 1. Sesja Planisty ──────────────────────────────────────────────────
  const plannerCtx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await setupRoutes(plannerCtx);
  const plannerPage = await plannerCtx.newPage();
  const pageErrors = [];
  plannerPage.on("pageerror", (err) => pageErrors.push(err.message));

  // Ustaw rolę Planisty i otwórz aplikację
  await plannerPage.addInitScript(() => {
    localStorage.setItem("mapplaner.role", "planner");
  });
  await plannerPage.goto(baseUrl, { waitUntil: "domcontentloaded" });

  // Otwórz edytor tras linii z panelu Planisty
  const openBtn = plannerPage.getByTestId("open-line-route-editor");
  await openBtn.waitFor({ state: "visible", timeout: 20_000 });
  await openBtn.click();

  const editorPanel = plannerPage.getByTestId("line-route-editor-panel");
  await editorPanel.waitFor({ state: "visible", timeout: 15_000 });

  // Poczekaj aż załaduje się linia 7 z punktami
  const line7Btn = plannerPage.getByTestId("editor-line-7");
  await line7Btn.waitFor({ state: "visible", timeout: 15_000 });
  await line7Btn.click();

  const pointsTextBefore = await plannerPage.getByTestId("editor-points-count").textContent();
  const pointsBefore = Number(pointsTextBefore?.trim() ?? "0");
  assert.ok(pointsBefore >= 5, `oczekiwano załadowanej geometrii GTFS (jest ${pointsBefore} pkt)`);

  // Sprawdź obecność interaktywnych uchwytów wierzchołków na mapie Leaflet
  await plannerPage.waitForSelector(".line-editor-vertex-wrap", { timeout: 10_000 });
  const handleCount = await plannerPage.locator(".line-editor-vertex-wrap").count();
  assert.ok(handleCount >= 2, `uchwyty wierzchołków na mapie są widoczne (${handleCount})`);

  // Kliknij „Uprość punkty”, dodaj notatkę i kliknij „Zapisz trasę”
  await plannerPage.getByTestId("editor-simplify").click();
  await plannerPage.getByLabel("Notatka do zmiany trasy").fill("Realny przebieg linii 7 E2E");
  await plannerPage.getByTestId("editor-save").click();

  // Zweryfikuj, że zapis trafił do wspólnego pliku projektu na dysku
  await plannerPage.waitForTimeout(600);
  const diskJson = JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8"));
  const savedKeys = Object.keys(diskJson.overrides);
  assert.equal(savedKeys.length, 1, "zapisana korekta trafiła do src/data/line-route-overrides.json");
  assert.equal(
    diskJson.overrides[savedKeys[0]].note,
    "Realny przebieg linii 7 E2E",
    "notatka Planisty została zapisana",
  );
  assert.equal(pageErrors.length, 0, `brak błędów JS u Planisty: ${pageErrors.join("; ")}`);
  await plannerCtx.close();

  // ── 2. Sesja Pasażera (czysty kontekst — widoczność u wszystkich!) ────
  const travelerCtx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await setupRoutes(travelerCtx);
  const travelerPage = await travelerCtx.newPage();
  const travelerErrors = [];
  travelerPage.on("pageerror", (err) => travelerErrors.push(err.message));

  await travelerPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await travelerPage.getByRole("button", { name: "Linie" }).click();

  // Pasażer widzi linię 7 z badge „Poprawiona”, a NIE widzi przycisków „Edytuj”
  await travelerPage.getByTestId("line-card").first().waitFor({ state: "visible", timeout: 15_000 });
  await travelerPage.getByTestId("line-variant").first().waitFor({ state: "visible", timeout: 10_000 });
  const variantText = await travelerPage.getByTestId("line-variant").first().textContent();
  assert.match(variantText ?? "", /Poprawiona/i, "pasażer widzi zapisaną korektę trasy");
  assert.equal(
    await travelerPage.getByTestId("line-edit-route").count(),
    0,
    "pasażer nie widzi przycisku edycji trasy (tylko moduł Planisty)",
  );
  assert.equal(
    travelerErrors.length,
    0,
    `brak błędów JS u pasażera: ${travelerErrors.join("; ")}`,
  );
  await travelerCtx.close();

  console.log(
    "OK E2E: Planista edytuje i zapisuje trasę linii na mapie, a pasażer w czystej przeglądarce od razu widzi poprawiony przebieg!",
  );
} finally {
  fs.writeFileSync(OVERRIDES_PATH, originalOverridesFile, "utf8");
  if (browser) await browser.close();
  await server.close();
}
