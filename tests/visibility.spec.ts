import { expect, test, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

const labels = {
  visibility: "Ustawienia widoczno\u015bci",
  info: "Darmowe \u017ar\u00f3d\u0142a i informacje",
  infoTitle: "Wszystko bez op\u0142at za API",
  profile: "Wyb\u00f3r profilu: Planista / Podr\u00f3\u017cny",
};

// A small, deterministic feed exercises the real parser without public API dependencies.
function gtfsFixture() {
  const files: Record<string, string> = {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\n1,Test transport,https://example.test,Europe/Warsaw\n",
    "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version\nTest,https://example.test,pl,20261109,20261115,test\n",
    "routes.txt": "route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n15,15,Terminal,3,0059ce,ffffff\n2,2,Station,3,00658c,ffffff\n",
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon,location_type\na,First,50.7714,16.2833,0\nb,Second,50.7724,16.2863,0\nc,Terminal,50.7744,16.2883,0\n",
    "trips.txt": "route_id,service_id,trip_id,trip_headsign,direction_id\n15,service,t15,Terminal,0\n2,service,t2,Station,0\n",
    "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nt15,08:00:00,08:00:00,a,0,0,0\nt15,08:05:00,08:05:00,b,1,0,0\nt15,08:10:00,08:10:00,c,2,0,0\nt2,09:00:00,09:00:00,a,0,0,0\nt2,09:10:00,09:10:00,c,1,0,0\n",
    "calendar_dates.txt": "service_id,date,exception_type\nservice,20261109,1\nservice,20261114,1\nservice,20261115,1\n",
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])), { level: 0 }));
}

const marker = (page: Page, line: string) => page.locator(".live-bus-wrap").filter({
  has: page.locator(".live-bus-line", { hasText: new RegExp(`^${line}$`) }),
});

async function openVisibility(page: Page) {
  await page.getByRole("button", { name: labels.visibility, exact: true }).click();
  return page.getByRole("dialog", { name: labels.visibility, exact: true });
}

test.beforeEach(async ({ page }) => {
  const zip = gtfsFixture();
  let fixes = 0;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    const headers = { "Access-Control-Allow-Origin": "*" };
    if (url.pathname.endsWith("/gtfs/default")) {
      return route.fulfill({ body: zip, contentType: "application/zip", headers });
    }
    if (url.pathname.includes("/positions/")) {
      fixes += 1;
      return route.fulfill({
        json: { positions: [
          { vehicle: { id: "340", type: "3", model: null }, routeName: "15", brigade: "01", location: [16.2853 + fixes * 0.0001, 50.7714], timestamp: Date.now() + fixes * 10_000, bearing: 90, delay: 80_000, headsign: "Terminal", upcomingStops: [] },
          { vehicle: { id: "3", type: "3", model: "Solaris Urbino 12 hydrogen" }, routeName: "2", brigade: "08", location: [16.2883, 50.7694], timestamp: Date.now() + fixes * 10_000, bearing: 180, delay: -45_000, headsign: "Station", upcomingStops: [] },
        ] },
        headers,
      });
    }
    if (url.pathname.includes("gtfsRealtime")) {
      return route.fulfill({ body: Buffer.alloc(0), contentType: "application/octet-stream", headers });
    }
    if (route.request().resourceType() === "image") {
      return route.fulfill({
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmS8AAAAASUVORK5CYII=", "base64"),
        contentType: "image/png",
        headers,
      });
    }
    if (route.request().resourceType() === "stylesheet") {
      return route.fulfill({ body: "", contentType: "text/css", headers });
    }
    return route.fulfill({ status: 404, body: "", headers });
  });
  await page.goto("/");
  await expect(page.locator(".live-bus-wrap")).toHaveCount(2);
});

test("defaults show direction, LINE, speed and delay; options only add identifiers", async ({ page }, testInfo) => {
  const late = marker(page, "15");
  const early = marker(page, "2");
  await expect(late.locator(".live-bus-label")).toHaveText("15");
  await expect(early.locator(".live-bus-label")).toHaveText("2");
  await expect(late.locator(".live-bus-arrow")).toHaveAttribute("style", /rotate\(90deg\)/);
  await expect(late.locator(".live-bus-chip")).toContainText("km/h|-1:20");
  await expect(early.locator(".live-bus-chip")).toContainText("km/h|+0:45");
  await expect(page.locator(".bus-stop")).toHaveCount(0);
  await expect(page.getByRole("button", { name: labels.info, exact: true })).toHaveCount(0);

  const panel = await openVisibility(page);
  await expect(panel).toContainText("kierunek jazdy, linia,");
  await expect(panel.getByRole("button", { name: "Ukryte", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("switch", { name: /^Kurs/ })).not.toBeChecked();
  await expect(panel.getByRole("switch", { name: /^Numer taborowy/ })).not.toBeChecked();
  await panel.getByRole("switch", { name: /^Kurs/ }).click();
  await expect(late.locator(".live-bus-label")).toHaveText("15|15/01");
  await expect(early.locator(".live-bus-label")).toHaveText("2|2/08");
  await panel.getByRole("switch", { name: /^Numer taborowy/ }).click();
  await expect(late.locator(".live-bus-label")).toHaveText("15|15/01|#340");
  await expect(early.locator(".live-bus-label")).toHaveText("2|2/08|#3");
  await panel.getByRole("switch", { name: /^Kurs/ }).click();
  await expect(late.locator(".live-bus-label")).toHaveText("15|#340");
  await expect(early.locator(".live-bus-label")).toHaveText("2|#3");

  await panel.getByRole("button", { name: "Wszystkie", exact: true }).click();
  await expect(page.locator(".bus-stop")).toHaveCount(3);
  await panel.getByRole("button", { name: /Przywr/ }).click();
  await expect(page.locator(".bus-stop")).toHaveCount(0);
  await expect(late.locator(".live-bus-label")).toHaveText("15");
  await expect(early.locator(".live-bus-label")).toHaveText("2");
  await expect(late.locator(".live-bus-chip")).toBeVisible();
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: testInfo.outputPath("visibility-settings.png") });
});

test("preferences survive reload; speed and delay remain visible after zooming out", async ({ page }) => {
  const panel = await openVisibility(page);
  await panel.getByRole("switch", { name: /^Numer taborowy/ }).click();
  await expect(marker(page, "2").locator(".live-bus-label")).toHaveText("2|#3");
  await page.reload();
  await expect(marker(page, "15").locator(".live-bus-label")).toHaveText("15|#340");
  await expect(page.locator(".bus-stop")).toHaveCount(0);

  await page.locator(".leaflet-container").evaluate((element) => {
    const map = (element as HTMLElement & { __map: { setZoom: (zoom: number, options: object) => void } }).__map;
    map.setZoom(10, { animate: false });
  });
  await expect(marker(page, "15").locator(".live-bus-chip")).toBeVisible();
  await expect(marker(page, "2").locator(".live-bus-chip")).toBeVisible();
  await expect(marker(page, "15").locator(".live-bus-line")).toHaveText("15");
});

test("information window is available only after login, including mobile menu", async ({ page }, testInfo) => {
  await expect(page.getByRole("button", { name: labels.info, exact: true })).toHaveCount(0);
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "Menu aplikacji", exact: true }).click();
    await expect(page.getByRole("button", { name: labels.info, exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Menu aplikacji", exact: true }).click();
  }
  await page.getByTitle(labels.profile, { exact: true }).click();
  await page.getByRole("menuitemradio", { name: /^Planista/ }).click();
  const login = page.getByRole("dialog", { name: "Logowanie Planisty", exact: true });
  await login.getByLabel("Login", { exact: true }).fill("admin");
  await login.getByLabel("Has\u0142o", { exact: true }).fill("incorrect");
  await login.getByRole("button", { name: /^Zaloguj/ }).click();
  await expect(login.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: labels.info, exact: true })).toHaveCount(0);

  await login.getByLabel("Has\u0142o", { exact: true }).fill("mzk007#");
  await login.getByRole("button", { name: /^Zaloguj/ }).click();
  await expect(login).toHaveCount(0);
  await page.getByRole("button", { name: labels.info, exact: true }).click();
  await expect(page.getByRole("heading", { name: labels.infoTitle, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: labels.infoTitle, exact: true })).toHaveCount(0);

  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "Menu aplikacji", exact: true }).click();
    await expect(page.getByRole("button", { name: labels.info, exact: true })).toHaveCount(2);
    await page.getByRole("button", { name: labels.info, exact: true }).last().click();
    await expect(page.getByRole("heading", { name: labels.infoTitle, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await page.getByTitle(labels.profile, { exact: true }).click();
  await page.getByRole("menuitemradio", { name: /^Podr/ }).click();
  await expect(page.getByRole("button", { name: labels.info, exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: labels.infoTitle, exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: labels.visibility, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: labels.info, exact: true })).toHaveCount(0);
});
test("a new visit always starts with an empty route, even with a saved snapshot", async ({ page }, testInfo) => {
  // Seed a complete "last route" snapshot from a previous session, in the planner profile.
  await page.addInitScript(() => {
    localStorage.setItem("mapplaner.role", "planner");
    const fleet = [12, 18].map((lengthM) => ({
      id: `bus-${lengthM}`,
      name: `Autobus ${lengthM} m`,
      lengthM,
      weightT: lengthM,
      averageSpeed: 25,
      limits: { motorway: 90 },
    }));
    localStorage.setItem("mapplaner.last-route.v4", JSON.stringify({
      version: 4,
      waypoints: [
        { id: "a", label: "Wałbrzych, Rynek", short: "Rynek", lat: 50.7716, lon: 16.2843 },
        { id: "b", label: "Zamek Książ", short: "Zamek Książ", lat: 50.8231, lon: 16.2931 },
      ],
      vehicle: fleet[0].id,
      fleet,
      speeds: {},
      schedule: { mode: "now", date: "2026-11-10", time: "12:00", trafficEnabled: false, peakDelayPercent: 0, liveTrafficEnabled: false, trafficLightsEnabled: false, secondsPerSignal: 20, bufferMinutes: 0, occurrence: "earlier" },
      avoid: { tolls: false, ferries: false, unpaved: false },
      route: {
        coords: [[50.7716, 16.2843], [50.795, 16.288], [50.8231, 16.2931]],
        distance: 6200,
        duration: 720,
        steps: [],
        legs: [{ distance: 6200, duration: 720 }],
        engine: "osrm",
        labels: ["Rynek", "Zamek Książ"],
      },
      planKey: "a:50.771600,16.284300|b:50.823100,16.293100|000",
      savedAt: new Date().toISOString(),
    }));
  });
  await page.goto("/");
  await expect(page.locator(".live-bus-wrap")).toHaveCount(2);
  // No route polyline and no waypoint pins are restored on a fresh visit.
  await expect(page.locator("path.route-main")).toHaveCount(0);
  await expect(page.locator(".pin.pin--start, .pin.pin--end, .pin.pin--via")).toHaveCount(0);
  // The planner inputs are empty too (on mobile the bottom sheet must be expanded first).
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: /Edytuj tras/ }).click();
  }
  await expect(page.getByRole("textbox", { name: "Start", exact: true })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "Meta", exact: true })).toHaveValue("");
});

test("legend omits planner-only start/meta markers for travelers", async ({ page }) => {
  // The bottom-left legend is desktop-only (hidden sm:flex); on mobile there is nothing to check.
  if (page.viewportSize()!.width < 640) {
    test.skip(true, "Legend is hidden below the sm breakpoint");
    return;
  }
  const legend = page.locator("main div").filter({ hasText: "MZUK" }).last();
  await expect(legend).toContainText("MZUK");
  await expect(legend).not.toContainText("A start");
  await expect(legend).not.toContainText("B meta");

  await page.getByTitle(labels.profile, { exact: true }).click();
  await page.getByRole("menuitemradio", { name: /^Planista/ }).click();
  const login = page.getByRole("dialog", { name: "Logowanie Planisty", exact: true });
  await login.getByLabel("Login", { exact: true }).fill("admin");
  await login.getByLabel("Has\u0142o", { exact: true }).fill("mzk007#");
  await login.getByRole("button", { name: /^Zaloguj/ }).click();
  await expect(legend).toContainText("A start");
  await expect(legend).toContainText("B meta");
});

test("travelers never see the planner product name; a logged-in planner does", async ({ page }, testInfo) => {
  // Traveler (default): no name in the logo, its tooltip, the page text or the browser tab.
  await expect(page.getByTestId("brand-name")).toHaveCount(0);
  await expect(page.getByTestId("brand-tagline")).toBeVisible();
  await expect(page.getByTestId("app-brand")).not.toHaveAttribute("title", /MapPlaner/);
  await expect(page.locator("body")).not.toContainText("MapPlaner");
  await expect(page).not.toHaveTitle(/MapPlaner|planer/i);
  await page.screenshot({ path: testInfo.outputPath("traveler-header.png") });

  await page.getByTitle(labels.profile, { exact: true }).click();
  await expect(page.locator("body")).not.toContainText("MapPlaner");
  await page.getByRole("menuitemradio", { name: /^Planista/ }).click();
  const login = page.getByRole("dialog", { name: "Logowanie Planisty", exact: true });
  await expect(page.locator("body")).not.toContainText("MapPlaner");
  await login.getByLabel("Login", { exact: true }).fill("admin");
  await login.getByLabel("Has\u0142o", { exact: true }).fill("mzk007#");
  await login.getByRole("button", { name: /^Zaloguj/ }).click();

  // Planner: the name is back in the logo and the tab title.
  await expect(page.getByTestId("brand-name")).toHaveText("MapPlaner");
  await expect(page.getByTestId("app-brand")).toHaveAttribute("title", "MapPlaner");
  await expect(page).toHaveTitle(/^MapPlaner/);
  await page.screenshot({ path: testInfo.outputPath("planner-header.png") });

  // Logging out removes it again, also after a reload.
  await page.getByTitle(labels.profile, { exact: true }).click();
  await page.getByRole("menuitemradio", { name: /^Podr/ }).click();
  await expect(page.getByTestId("brand-name")).toHaveCount(0);
  await expect(page).not.toHaveTitle(/MapPlaner/);
  await page.reload();
  await expect(page.locator(".live-bus-wrap")).toHaveCount(2);
  await expect(page.getByTestId("brand-name")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("MapPlaner");
  await expect(page).not.toHaveTitle(/MapPlaner/);
});
