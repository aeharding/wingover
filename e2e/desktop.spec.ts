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
  await expect(page).toHaveURL(/\/logbook$/);
  await expect(page.locator("ion-tab-button", { hasText: "Logbook" })).toBeVisible();
  await expect(page.locator("ion-tab-button", { hasText: "Fly" })).toHaveCount(
    0,
  );
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

  await page.getByText("Logbook", { exact: true }).click();
  // The pane's totals strip.
  await expect(page.getByText("Airtime")).toBeVisible();

  await page.getByRole("heading", { name: /^Flight / }).first().click();
  await expect(page).toHaveURL(/\/logbook\/recorded-/);
  // Split: the list (totals strip) and the detail (stats) share the screen.
  await expect(page.getByText("Airtime")).toBeVisible();
  await expect(page.getByText("Max altitude")).toBeVisible();
  // No back button in the split; the list IS the navigation.
  await expect(page.locator("ion-back-button")).toHaveCount(0);
});

test("the plan page grows a pin pane at desktop width", async ({ page }) => {
  await page.goto("/plan?map-style=blank");
  await expect(page.getByTestId("plan-pane")).toBeVisible();
  await expect(page.getByText("Long-press the map")).toBeVisible();
});
