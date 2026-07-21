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

// The aircraft glyph rides the HOST map (the fullscreen detail map).
function aircraftDisplay(page: Page) {
  return page
    .locator(".flight-detail-map-fullroot .map-container")
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

test("the Replay pill opens fullscreen with the dock and auto-plays", async ({
  page,
}) => {
  await openImportedFlight(page);

  await page.getByTestId("replay-open").click();
  await expect(page.locator(".flight-detail-map-fullroot")).toBeVisible();
  await expect(page.getByTestId("replay-dock")).toBeVisible();

  // Auto-play: the short fixture plays through and holds at the end.
  await expect.poll(() => sliderFraction(page)).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("replay-play")).toHaveAttribute(
    "aria-label",
    "Replay again",
  );
  const atEnd = await aircraftDisplay(page);
  expect(atEnd).not.toBeNull();

  // Scrub back to mid-flight: the aircraft follows the playhead.
  const box = (await page.getByTestId("barogram").boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.5, y);
  await page.mouse.down();
  await page.mouse.up();
  const mid = await sliderFraction(page);
  expect(mid).toBeGreaterThan(0.3);
  expect(mid).toBeLessThan(0.7);
  const midAt = await aircraftDisplay(page);
  expect(midAt!.lng !== atEnd!.lng || midAt!.lat !== atEnd!.lat).toBe(true);

  // Speed control cycles the ?mock-speed vocabulary.
  await expect(page.getByTestId("replay-speed")).toHaveText("30×");
  await page.getByTestId("replay-speed").click();
  await expect(page.getByTestId("replay-speed")).toHaveText("60×");

  // Shrink: back to the intact detail page, dock gone.
  await page.getByTestId("map-shrink").click();
  await expect(page.locator(".flight-detail-map-fullroot")).toBeHidden();
  await expect(page.getByTestId("replay-dock")).toBeHidden();
  await expect(page.getByText("Max altitude")).toBeVisible();
});

test("Expand keeps the map clean; the play button opens the pane playing; stop closes it", async ({
  page,
}) => {
  await openImportedFlight(page);

  await page.getByTestId("map-expand").click();
  await expect(page.locator(".flight-detail-map-fullroot")).toBeVisible();
  // No pane, no glyph — just the map, plus a floating play button.
  await expect(page.getByTestId("replay-dock")).toBeHidden();
  await expect(page.getByTestId("replay-start")).toBeVisible();

  await page.getByTestId("replay-start").click();
  await expect(page.getByTestId("replay-dock")).toBeVisible();
  await expect(page.getByTestId("replay-start")).toBeHidden();
  await expect.poll(() => aircraftDisplay(page)).not.toBeNull();
  await expect.poll(() => sliderFraction(page)).toBeGreaterThan(0);

  // Stop slides the pane away and the play button returns.
  await page.getByTestId("replay-stop").click();
  await expect(page.getByTestId("replay-dock")).toBeHidden();
  await expect(page.getByTestId("replay-start")).toBeVisible();
});

test("the timeline zooms with the wheel and resets", async ({ page }) => {
  // The 11s fixture is below the minimum zoom window; record ~40s instead.
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();

  await page.getByText("Logbook", { exact: true }).click();
  await page.locator(".flight-row").click();
  await expect(page.getByText("Max altitude")).toBeVisible();
  await page.getByTestId("map-expand").click();
  await page.getByTestId("replay-start").click();

  const barogram = page.getByTestId("barogram");
  await expect(barogram).toBeVisible();
  await expect(barogram).toHaveAttribute("data-zoomed", "false");

  const box = (await barogram.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Poll with repeated wheel input: a single event can land in the gap
  // before the (post-paint) wheel listener attaches.
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, -300);
      return barogram.getAttribute("data-zoomed");
    })
    .toBe("true");
  await expect(page.locator(".barogram-overview")).toBeVisible();

  await page.getByTestId("timeline-reset").click();
  await expect(barogram).toHaveAttribute("data-zoomed", "false");
});
