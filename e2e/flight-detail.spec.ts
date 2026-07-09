import { expect, test } from "@playwright/test";

async function recordQuickFlight(page: import("@playwright/test").Page) {
  await page.goto("/?mock-speed=40&map-style=blank&hold-ms=300");
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
}

test("flight detail draws the track even when the map style loads slowly", async ({
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
  await page.getByRole("heading", { name: /^Flight / }).click();

  await expect(page.getByTestId("launch-marker")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("landing-marker")).toBeVisible();
  await expect(page.locator("[data-track-layer='true']")).toBeVisible({
    timeout: 10_000,
  });
  expect(pageErrors).toEqual([]);
});

test("flight detail shows stats, exports GPX, and deletes", async ({
  page,
}) => {
  await recordQuickFlight(page);

  await page.getByText("Logbook", { exact: true }).click();
  await page.getByRole("heading", { name: /^Flight / }).click();

  await expect(page.getByText("Max altitude")).toBeVisible();
  await expect(page.getByText("Avg speed")).toBeVisible();

  await page.getByTestId("detail-options").click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export GPX" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.gpx$/);
  await expect(
    page.getByRole("button", { name: "Export GPX" }),
  ).not.toBeVisible();

  await page.getByTestId("detail-options").click();
  await page.getByRole("button", { name: "Delete flight" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(page.getByText("No flights yet.")).toBeVisible();
});
