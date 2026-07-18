import { expect, test } from "@playwright/test";

// The suite's default viewport is a phone (playwright.config.ts), which is
// exactly what keeps every other spec on the phone layout. This file opts
// into a laptop-sized window to exercise the rail + split layout.
test.use({ viewport: { width: 1280, height: 800 } });

test("a plain browser hides Fly and lands on the logbook", async ({
  page,
}) => {
  // No ?mock-speed: this is a real browser visitor, not the e2e engine seam.
  await page.goto("/?map-style=blank");
  // The index redirect now carries the query string across (it is ?mock-speed
  // that must survive in general), so the landing URL keeps ?map-style here.
  await expect(page).toHaveURL(/\/logbook(\?|$)/);
  await expect(page.getByTestId("rail-logbook")).toBeVisible();
  await expect(page.getByTestId("rail-fly")).toHaveCount(0);
  // Empty logbook in a browser is the connect funnel, not a dead end.
  await expect(page.getByTestId("funnel-signin")).toBeVisible();
  await expect(page.getByTestId("funnel-import")).toBeVisible();
});

test("the logbook splits: list stays while the flight shows", async ({
  page,
}) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();

  await page.getByTestId("rail-logbook").click();
  // The pane's totals strip.
  await expect(page.getByText("Airtime")).toBeVisible();

  await page.locator(".flight-row").first().click();
  await expect(page).toHaveURL(/\/logbook\/recorded-/);
  // Split: the list (totals strip) and the detail (stats) share the screen.
  await expect(page.getByText("Airtime")).toBeVisible();
  await expect(page.getByText("Max altitude")).toBeVisible();
  // No back button in the split; the list IS the navigation.
  await expect(page.locator("ion-back-button")).toHaveCount(0);
});

test("selection swaps the seat without remounting the list or the map", async ({
  page,
}) => {
  // Two flights, so there is something to flip between.
  await page.goto("/?mock-speed=40&map-style=blank");
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Start Flight" }).click();
    await expect(page.getByTestId("recording")).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Stop flight" }).click();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Start Flight" }),
    ).toBeVisible();
  }

  await page.getByTestId("rail-logbook").click();
  const rows = page.locator(".flight-row");
  await rows.first().click();
  await expect(page).toHaveURL(/\/logbook\/recorded-/);
  const firstUrl = page.url();

  // Tag the live map AND the stats card; if either remounts on selection,
  // its tag dies with it.
  await page
    .locator(".seat-map .map-container")
    .evaluate((el) => el.setAttribute("data-alive", "1"));
  await page
    .locator(".seat-card")
    .evaluate((el) => el.setAttribute("data-alive", "1"));

  await rows.nth(1).click();
  await expect(page).not.toHaveURL(firstUrl);
  // Arrow keys walk the list too: up returns to the first flight.
  await page.keyboard.press("ArrowUp");
  await expect(page).toHaveURL(firstUrl);
  await page.keyboard.press("ArrowDown");
  await expect(page).not.toHaveURL(firstUrl);
  // Same elements, still tagged: the seat swapped data, not DOM.
  await expect(
    page.locator('.seat-map .map-container[data-alive="1"]'),
  ).toBeVisible();
  await expect(page.locator('.seat-card[data-alive="1"]')).toBeVisible();
});

test("the list pane resizes by its edge and remembers the width", async ({
  page,
}) => {
  await page.goto("/?map-style=blank");
  const pane = page.locator(".logbook-pane");
  await expect(pane).toBeVisible();
  const before = (await pane.boundingBox())!.width;

  const handle = page.getByTestId("pane-resizer");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 103, box.y + 300, { steps: 5 });
  await page.mouse.up();
  const after = (await pane.boundingBox())!.width;
  expect(Math.round(after - before)).toBe(100);

  // Persisted per device: a fresh load keeps the chosen width.
  await page.reload();
  await expect(pane).toBeVisible();
  expect((await pane.boundingBox())!.width).toBe(after);
});

test("the rail sync chip opens a menu, and the sheet sits behind it", async ({
  page,
}) => {
  await page.goto("/?map-style=blank");
  await page.getByTestId("rail-sync").click();
  // Off: status plus the setup door, and nothing to log out of.
  await expect(page.getByTestId("rail-sync-manage")).toContainText("Log In");
  await expect(page.getByTestId("rail-sync-logout")).toHaveCount(0);
  // Nothing recorded either, so no local data to offer deleting.
  await expect(page.getByTestId("rail-sync-erase")).toHaveCount(0);
  await expect(page.locator("ion-popover")).toContainText("Sync: Off");
  await page.getByTestId("rail-sync-manage").click();
  await expect(page.getByTestId("sync-headline")).toBeVisible();
});

test("sync-off local flights can be erased from the chip menu, in place", async ({
  page,
}) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();

  await page.evaluate(() => document.body.setAttribute("data-no-reload", "1"));
  await page.getByTestId("rail-sync").click();
  await page.getByTestId("rail-sync-erase").click();
  const alert = page.locator("ion-alert:not(.overlay-hidden)");
  await expect(alert).toContainText("nothing is backed up");
  await alert.getByRole("button", { name: "Delete" }).click();

  // The store reset in place: the logbook empties to the funnel, the menu
  // item retires, and the document never reloaded.
  await page.getByTestId("rail-logbook").click();
  await expect(page.getByTestId("funnel-import")).toBeVisible();
  await page.getByTestId("rail-sync").click();
  await expect(page.getByTestId("rail-sync-erase")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute("data-no-reload", "1");
});

test("the plan page grows a pin pane at desktop width", async ({ page }) => {
  await page.goto("/plan?map-style=blank");
  await expect(page.getByTestId("plan-pane")).toBeVisible();
  await expect(page.getByText("Long-press the map")).toBeVisible();
});

test("the record opt-in shows Fly live, and turning it off hides it", async ({
  page,
}) => {
  await page.goto("/settings?map-style=blank");
  await expect(page.getByTestId("rail-fly")).toHaveCount(0);

  const toggle = page.locator("ion-toggle", {
    hasText: "Record in this browser",
  });
  await toggle.click();
  await page
    .locator("ion-alert")
    .getByRole("button", { name: "Turn on" })
    .click();
  await expect(page.getByTestId("rail-fly")).toBeVisible();

  await toggle.click();
  await expect(page.getByTestId("rail-fly")).toHaveCount(0);
});
