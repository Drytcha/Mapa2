import { expect, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

const feed = {
  "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\n1,MZUK,https://example.org,Europe/Warsaw\n",
  "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\nTest,https://example.org,pl,20261101,20261231\n",
  "calendar_dates.txt": "service_id,date,exception_type\nS,20261113,1\n",
  "routes.txt": "route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n7,7,Line seven,3,006d29,ffffff\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nR,Ratuszowa Aqua Zdroj,50.78330,16.25163\nS,Sokolowskiego Koncowy,50.80153,16.27925\nH,Sokolowskiego Szpital,50.80186,16.27947\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign,direction_id\n7,S,first,Sokolowskiego Koncowy,0\n7,S,extra,Sokolowskiego Koncowy,0\n7,S,return1,Ratuszowa Aqua Zdroj,1\n7,S,out2,Sokolowskiego Koncowy,0\n7,S,return2,Ratuszowa Aqua Zdroj,1\n7,S,out3,Sokolowskiego Koncowy,0\n",
  "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nfirst,05:24:00,05:24:00,R,1\nfirst,05:50:00,05:50:00,S,2\nextra,06:14:00,06:14:00,R,1\nextra,06:40:00,06:40:00,S,2\nreturn1,06:15:00,06:15:00,H,1\nreturn1,06:39:00,06:39:00,R,2\nout2,06:50:00,06:50:00,R,1\nout2,07:16:00,07:16:00,S,2\nreturn2,07:20:00,07:20:00,H,1\nreturn2,07:44:00,07:44:00,R,2\nout3,07:45:00,07:45:00,R,1\nout3,08:11:00,08:11:00,S,2\n",
};
const archive = Buffer.from(
  zipSync(Object.fromEntries(Object.entries(feed).map(([name, csv]) => [name, strToU8(csv)]))),
);

test("7/01 shows only its trips and mobile timetables remain scrollable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.clock.install({ time: new Date("2026-11-13T09:00:00Z") });
  await page.addInitScript(() => localStorage.setItem("mapplaner.role", "planner"));
  await page.route("**/api6-open/walbrzych/**", async (route) => {
    if (route.request().url().endsWith("/gtfs/default")) {
      return route.fulfill({ status: 200, contentType: "application/zip", body: archive });
    }
    if (route.request().url().includes("/gtfsRealtime/")) {
      return route.fulfill({ status: 200, body: "" });
    }
    return route.fulfill({ status: 200, json: { positions: [], departures: [] } });
  });
  await page.route("**/api.livetransport.eu/walbrzych/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: "[]",
    }),
  );

  await page.goto("/#/walbrzych/brigades/7?date=20261113");
  const cards = page.getByTestId("brigade-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("7/01");
  await expect(cards.last()).toContainText("?");
  await cards.first().click();

  const detail = page.getByTestId("brigade-detail-pane");
  await expect(detail.locator(".duty-trip-card")).toHaveCount(5);
  await expect(detail).not.toContainText("06:14");
  const scrollArea = page.getByRole("dialog").locator(".scroll-area");
  expect(
    await scrollArea.evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  await detail.locator(".duty-trip-card").last().scrollIntoViewIfNeeded();
  expect(await scrollArea.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});