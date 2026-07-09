import { expect, test } from "@playwright/test";

test("imports GPX flights from the logbook menu", async ({ page }) => {
  await page.goto("/?map-style=blank");
  await page.getByText("Logbook", { exact: true }).click();
  await page.getByTestId("logbook-options").click();

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import GPX files" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles("e2e/fixtures/flight.gpx");

  await expect(page.getByText(/Imported 1 flight/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Tomahawk Test Flight" }),
  ).toBeVisible();

  await page.getByRole("heading", { name: "Tomahawk Test Flight" }).click();
  await expect(page.locator("[data-track-layer='true']")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("launch-marker")).toBeVisible();
  await expect(page.getByText("Max altitude")).toBeVisible();
});

test("composite map draws all flights even with a slow style", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await page.route("**/tiles.openfreemap.org/styles/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        version: 8,
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#222" },
          },
        ],
      }),
    });
  });
  await page.route("**/api.maptiler.com/**", (route) => route.abort());

  await page.goto("/?mock-speed=40&hold-ms=300");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const stopButton = page.getByRole("button", { name: /hold to stop/i });
  await stopButton.hover();
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();

  await page.getByText("Logbook", { exact: true }).click();
  await page.getByTestId("logbook-options").click();
  await page.getByRole("button", { name: "All Flights" }).click();

  await expect(
    page.locator("ion-title").filter({ hasText: "All Flights" }),
  ).toBeVisible();
  await expect(page.locator("[data-flights-layer='true']")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("Oldest → newest")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
