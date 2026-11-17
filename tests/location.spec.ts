import { expect, test } from "@playwright/test";

const HERE = { latitude: 50.7745, longitude: 16.2849, accuracy: 12 };

async function mapCenter(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const map = (document.querySelector(".leaflet-container") as any).__map;
    const center = map.getCenter();
    return { lat: center.lat, lon: center.lng };
  });
}

test("asks for GPS on load, centers the map and shows speed", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation(HERE);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const hud = page.getByTestId("user-location-hud");
  await expect(hud).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("user-location-marker")).toBeAttached();
  await expect(page.getByTestId("user-accuracy")).toContainText("±12 m");
  await expect
    .poll(async () => {
      const center = await mapCenter(page);
      return Math.hypot(center.lat - HERE.latitude, center.lon - HERE.longitude);
    }, { timeout: 8000 })
    .toBeLessThan(0.002);

  const button = page.getByTestId("center-on-me");
  await expect(button).toHaveAttribute("aria-pressed", "true");

  // Ręczne przesunięcie mapy wyłącza śledzenie, przycisk wraca na lokalizację.
  const box = (await page.locator(".leaflet-container").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 220, box.y + box.height / 2 + 60, { steps: 8 });
  await page.mouse.up();
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => {
      const center = await mapCenter(page);
      return Math.hypot(center.lat - HERE.latitude, center.lon - HERE.longitude);
    }, { timeout: 8000 })
    .toBeLessThan(0.002);

  // Przesunięcie pozycji liczy prędkość i kierunek (północ).
  await page.waitForTimeout(1200);
  await context.setGeolocation({ ...HERE, latitude: HERE.latitude + 0.0004 });
  await expect(page.getByTestId("user-speed")).not.toHaveText("—", { timeout: 10000 });
  await expect(page.getByTestId("user-heading")).toContainText("N");
});

test("explains a blocked location instead of failing silently", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("alert").filter({ hasText: "Lokalizacja zablokowana" })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByTestId("center-on-me")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
