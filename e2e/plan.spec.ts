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

  await page.getByTestId("pin-marker").click();
  await expect(page.getByTestId("pin-marker")).toHaveCount(0);
});
