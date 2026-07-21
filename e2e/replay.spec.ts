import { expect, test } from "@playwright/test";

type Page = import("@playwright/test").Page;

async function openImportedFlight(page: Page) {
  await page.goto("/?map-style=blank");
  await page.locator("#tab-button-logbook").click();
  await page.getByTestId("logbook-options").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import GPX files" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles("e2e/fixtures/flight.gpx");
  await page.getByRole("heading", { name: "Tomahawk Test Flight" }).click();
  await expect(page.getByText("Max altitude")).toBeVisible();
}

// The player's own map (the detail page's inline map is a second,
// separate container underneath the overlay).
function aircraftDisplay(page: Page) {
  return page
    .locator(".replay-fullroot .map-container")
    .evaluate(
      (el) =>
        (el as HTMLElement & { __display?: { lng: number; lat: number } })
          .__display ?? null,
    );
}

async function sliderFraction(page: Page) {
  const barogram = page.getByTestId("barogram");
  const now = Number(await barogram.getAttribute("aria-valuenow"));
  const max = Number(await barogram.getAttribute("aria-valuemax"));
  return now / max;
}

test("replay plays the flight, scrubs, and cycles speed", async ({ page }) => {
  await openImportedFlight(page);

  await page.getByTestId("replay-open").click();
  await expect(page.locator(".replay-fullroot")).toBeVisible();

  // Paused at launch: the aircraft stands on the first fix.
  await expect.poll(() => aircraftDisplay(page)).not.toBeNull();
  const start = (await aircraftDisplay(page))!;

  // Play: the aircraft leaves the launch point.
  await page.getByTestId("replay-play").click();
  await expect
    .poll(async () => {
      const at = await aircraftDisplay(page);
      return at !== null && (at.lng !== start.lng || at.lat !== start.lat);
    })
    .toBe(true);

  // Speed control cycles the ?mock-speed vocabulary.
  await expect(page.getByTestId("replay-speed")).toHaveText("30×");
  await page.getByTestId("replay-speed").click();
  await expect(page.getByTestId("replay-speed")).toHaveText("60×");
  await page.getByTestId("replay-speed").click();
  await expect(page.getByTestId("replay-speed")).toHaveText("10×");

  // Scrub: press near the end of the barogram, drag back to mid-flight.
  const box = (await page.getByTestId("barogram").boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.95, y);
  await page.mouse.down();
  await expect.poll(() => sliderFraction(page)).toBeGreaterThan(0.8);
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 5 });
  await page.mouse.up();
  const mid = await sliderFraction(page);
  expect(mid).toBeGreaterThan(0.3);
  expect(mid).toBeLessThan(0.7);

  // Close: back to the intact detail page.
  await page.getByTestId("replay-close").click();
  await expect(page.locator(".replay-fullroot")).toBeHidden();
  await expect(page.getByText("Max altitude")).toBeVisible();
});

test("replay opens over the fullscreen map and closes back to it", async ({
  page,
}) => {
  await openImportedFlight(page);

  await page.locator(".map-tap-layer").click();
  await expect(page.locator(".flight-detail-map-fullroot")).toBeVisible();

  await page.getByTestId("replay-open-full").click();
  await expect(page.locator(".replay-fullroot")).toBeVisible();

  // Closing the player must not tear down the fullscreen map under it.
  await page.getByTestId("replay-close").click();
  await expect(page.locator(".replay-fullroot")).toBeHidden();
  await expect(page.locator(".flight-detail-map-fullroot")).toBeVisible();

  await page.getByTestId("map-shrink").click();
  await expect(page.locator(".flight-detail-map-fullroot")).toBeHidden();
});
