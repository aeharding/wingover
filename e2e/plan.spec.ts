import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("http://localhost:5173")) return route.continue();
    return route.abort();
  });
});

test("tap to drop pins, persist across reload, tap to delete", async ({
  page,
}) => {
  await page.goto("/?map-style=blank");
  await page.getByText("Plan", { exact: true }).click();

  const canvas = page.locator(".map-container");
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(500);

  const box = (await canvas.boundingBox())!;
  for (const [x, y] of [
    [150, 300],
    [250, 400],
  ]) {
    await page.mouse.move(box.x + x, box.y + y);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
  }

  await expect(page.getByTestId("pin-marker")).toHaveCount(2);

  // Two pins connect into an ordered route line.
  const mapContainer = page.locator(".map-container");
  await expect(mapContainer).not.toHaveAttribute("data-route-coords", "");
  const routeBefore = await mapContainer.getAttribute("data-route-coords");
  expect(routeBefore!.split(";")).toHaveLength(2);

  // Two pins → the route distance shows for planning.
  await expect(page.getByTestId("plan-distance")).toContainText("Route:");

  await canvas.click({ position: { x: 60, y: 200 } });
  await expect(page.getByTestId("pin-marker")).toHaveCount(2);

  await page.goto("/?map-style=blank");
  await page.getByText("Plan", { exact: true }).click();
  await expect(page.getByTestId("pin-marker")).toHaveCount(2);

  // The route survives reload in the same order (creation order).
  await expect(mapContainer).toHaveAttribute("data-route-coords", routeBefore!);

  await page.getByTestId("pin-marker").first().click();
  await expect(page.getByTestId("pin-marker")).toHaveCount(1);

  // One pin is no route.
  await expect(mapContainer).toHaveAttribute("data-route-coords", "");
  await expect(page.getByTestId("plan-distance")).toHaveCount(0);

  await page.getByTestId("pin-marker").click();
  await expect(page.getByTestId("pin-marker")).toHaveCount(0);
});

test("rotating off north summons the compass; a tap re-norths", async ({
  page,
}) => {
  await page.goto("/?map-style=blank");
  await page.getByText("Plan", { exact: true }).click();

  const canvas = page.locator(".map-container");
  await expect(canvas).toBeVisible();

  // North-up: no compass.
  await expect(page.getByTestId("map-compass")).toHaveCount(0);

  // Rotate the map programmatically (stands in for the two-finger gesture,
  // which fires the same rotate event). The backend resolves async, so wait
  // for the adapter to stash the live map on the container first.
  await page.waitForFunction(() => {
    const container = document.querySelector(
      ".map-container",
    ) as HTMLElement & { __map?: { setBearing(bearing: number): void } };
    if (!container?.__map) return false;
    container.__map.setBearing(120);
    return true;
  });

  const compass = page.getByTestId("map-compass");
  await expect(compass).toBeVisible();

  await compass.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          document.querySelector(".map-container") as HTMLElement & {
            __map?: { getBearing(): number };
          }
        ).__map!.getBearing(),
      ),
    )
    .toBe(0);
  await expect(page.getByTestId("map-compass")).toHaveCount(0);
});
