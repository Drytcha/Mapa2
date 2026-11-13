import { test, expect, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

const files: Record<string, string> = {
  "agency.txt":
    "agency_id,agency_name,agency_url,agency_timezone\n1,MZUK,https://example.org,Europe/Warsaw\n",
  "feed_info.txt":
    "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version\nTest,https://example.org,pl,20260601,20261231,test\n",
  "calendar_dates.txt":
    "service_id,date,exception_type\nS,20260616,1\nS,20260617,1\n",
  "routes.txt":
    "route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n2,2,Andersa,3,0d4f3b,ffffff\n5,5,Kierunki,3,6d28d9,ffffff\n",
  "stops.txt":
    "stop_id,stop_name,stop_lat,stop_lon\nA,Andersa Ludowa,50.77,16.28\nB,Barbusse'a końcowy,50.79,16.3\nB2,Barbusse'a drugi słupek,50.7905,16.3\nC,Boguszów-Gorce Traugutta,50.81,16.33\nG,Głuszyca,50.69,16.37\nK,Kuźnice,50.76,16.35\n",
  "trips.txt":
    "route_id,service_id,trip_id,trip_headsign,direction_id\n2,S,first,Barbusse'a końcowy,0\n5,S,early,Boguszów-Gorce Traugutta,0\n5,S,later,Boguszów-Gorce Traugutta,0\n5,S,gluszyca,Głuszyca,0\n5,S,kuznice,Kuźnice,0\n",
  "stop_times.txt":
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nfirst,08:18:00,08:18:00,A,1,0,0\nfirst,08:37:00,08:37:00,B,2,1,0\nearly,08:41:00,08:41:00,B2,1,0,0\nearly,08:58:00,08:58:00,C,2,1,0\nlater,08:45:00,08:45:00,B2,1,0,0\nlater,09:02:00,09:02:00,C,2,1,0\ngluszyca,11:25:00,11:25:00,A,1,0,0\ngluszyca,12:05:00,12:05:00,G,2,1,0\nkuznice,11:45:00,11:45:00,A,1,0,0\nkuznice,12:10:00,12:10:00,K,2,1,0\n",
};
const archive = Buffer.from(
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, value]) => [name, strToU8(value)]),
    ),
    { level: 0 },
  ),
);

async function prepare(page: Page, theme = "dark") {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-06-16T05:44:00Z") });
  await page.context().grantPermissions(["geolocation"]);
  await page
    .context()
    .setGeolocation({ latitude: 50.7697, longitude: 16.2795 });
  await page.addInitScript((theme) => {
    localStorage.setItem("mapplaner.theme", theme);
    localStorage.setItem(
      "mapplaner.visibility.v1",
      JSON.stringify({ stops: "all" }),
    );
  }, theme);
  await page.route("**/api6-open/walbrzych/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/gtfs/default"))
      return route.fulfill({
        status: 200,
        contentType: "application/zip",
        body: archive,
      });
    if (path.includes("/gtfsRealtime/"))
      return route.fulfill({
        status: 200,
        body: "",
        contentType: "application/octet-stream",
      });
    return route.fulfill({
      status: 200,
      json: { positions: [], departures: [] },
    });
  });
  await page.route("**/routed-foot/route/v1/foot/**", async (route) => {
    const coords = new URL(route.request().url()).pathname
      .split("/foot/")[1]
      .split(";")
      .map((c) => c.split(",").map(Number));
    const [a, b] = coords;
    const direct = Math.hypot((a[1] - b[1]) * 111320, (a[0] - b[0]) * 71000);
    const transfer =
      a[1] > 50.785 && a[1] < 50.8 && b[1] > 50.785 && b[1] < 50.8;
    const meters = transfer ? 280 : Math.max(150, direct * 1.4);
    return route.fulfill({
      status: 200,
      json: {
        code: "Ok",
        waypoints: coords.map((location) => ({ location, distance: 0 })),
        routes: [
          {
            distance: meters,
            duration: transfer ? 240 : meters / 1.3,
            geometry: {
              type: "LineString",
              coordinates: [a, [a[0] + 0.0003, a[1]], [a[0] + 0.0003, b[1]], b],
            },
          },
        ],
      },
    });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-stop-id="tt-A"]')).toBeAttached();
  return errors;
}

async function destinationPosition(page: Page) {
  return page.evaluate(() => {
    const map = (document.querySelector(".leaflet-container") as any).__map;
    const marker = Object.values(map._layers).find(
      (layer: any) =>
        layer.getElement?.()?.dataset?.testid === "trip-destination-marker",
    ) as any;
    const point = marker.getLatLng();
    return { lat: point.lat, lon: point.lng };
  });
}

test("compact daily departures show direction suffixes and expandable details", async ({
  page,
}) => {
  const errors = await prepare(page);
  await page.locator('[data-stop-id="tt-A"]').click();
  const schedule = page.getByTestId("gtfs-schedule");
  await expect(schedule.getByText("Odjazdy według linii")).toBeVisible();
  await expect(schedule.getByTestId("compact-departure")).toHaveCount(3);
  const time = schedule.getByRole("button", {
    name: "Linia 5, 11:25g, kierunek Głuszyca",
    exact: true,
  });
  await expect(time).toBeVisible();
  await time.click();
  await expect(
    schedule.getByRole("region", { name: "Szczegóły odjazdu" }),
  ).toContainText("11:25g → Głuszyca");
  await schedule.getByLabel("Filtr linii").selectOption("5");
  await expect(schedule.getByTestId("compact-departure")).toHaveCount(2);
  await schedule.getByRole("button", { name: "Następny dzień" }).click();
  await expect(schedule.getByLabel("Dzień rozkładu")).toHaveValue("2026-06-17");
  await expect(schedule.getByTestId("compact-departure")).toHaveCount(2);
  await page.screenshot({ path: "test-results/compact-dark.png" });
  expect(errors).toEqual([]);
});

test("road geometry is rendered and the destination supports click-move, Escape and dragging", async ({
  page,
}) => {
  const errors = await prepare(page);
  await page
    .getByRole("button", { name: "Planer podróży", exact: true })
    .click();
  await page.getByRole("button", { name: "Lokalizacja", exact: true }).click();
  await expect(page.locator(".trip-marker--origin")).toBeVisible();
  await page
    .getByPlaceholder("Szukaj przystanku docelowego…")
    .fill("Traugutta");
  await page.getByRole("button", { name: /Boguszów-Gorce Traugutta/ }).click();
  await expect(page.getByText("Na mapie", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByText("08:45", { exact: true }).first()).toBeVisible();
  const shapes = await page.evaluate(() => {
    const map = (document.querySelector(".leaflet-container") as any).__map;
    return Object.values(map._layers)
      .filter((l: any) => l.options?.pane === "trip" && l.options?.dashArray)
      .map((l: any) => l.getLatLngs().length);
  });
  expect(shapes.length).toBeGreaterThan(0);
  expect(shapes.every((length) => length > 2)).toBeTruthy();
  const marker = page.getByTestId("trip-destination-marker");
  await marker.click();
  await expect(marker).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(marker).toHaveAttribute("aria-pressed", "false");
  const before = await destinationPosition(page);
  await marker.click();
  await page
    .locator(".leaflet-container")
    .click({ position: { x: 1000, y: 450 } });
  await expect.poll(() => destinationPosition(page)).not.toEqual(before);
  await expect(marker).toHaveAttribute("aria-pressed", "false");
  await page.waitForTimeout(1200);
  const beforeDrag = await destinationPosition(page);
  const box = (await marker.boundingBox())!;
  await page.mouse.move(box.x + 13, box.y + 13);
  await page.mouse.down();
  await page.mouse.move(box.x + 73, box.y + 63, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => destinationPosition(page)).not.toEqual(beforeDrag);
  await page.screenshot({ path: "test-results/destination-edit.png" });
  expect(errors).toEqual([]);
});

test("compact timetable fits a narrow screen in light theme", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await prepare(page, "light");
  await page.locator('[data-stop-id="tt-A"]').click();
  const schedule = page.getByTestId("gtfs-schedule");
  await expect(schedule.getByTestId("compact-departure")).toHaveCount(3);
  expect(
    await schedule.evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBeTruthy();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({ path: "test-results/compact-mobile.png" });
  expect(errors).toEqual([]);
});
