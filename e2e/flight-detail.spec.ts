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

// Ionic keeps other tab pages mounted, so "the first ion-content in the DOM"
// is not the visible page's. Anchor on the map frame, which is unique to the
// detail page. (Not Ionic's center hit-test idiom: while the map is full
// screen, the center is the body-level overlay, which deliberately has no
// enclosing ion-content — the test must still reach the scroller under it.)
async function detailScrollHost(page: Page) {
  await page.waitForFunction(() =>
    document.querySelector(".flight-detail-map-frame")?.closest("ion-content"),
  );
  return page.evaluateHandle(async () => {
    const content = document
      .querySelector(".flight-detail-map-frame")!
      .closest("ion-content")!;
    return content.getScrollElement();
  });
}

async function detailScrollTop(page: Page) {
  const host = await detailScrollHost(page);
  try {
    return await host.evaluate((el) => Math.round(el.scrollTop));
  } finally {
    await host.dispose();
  }
}

async function setDetailScrollTop(page: Page, top: number) {
  const host = await detailScrollHost(page);
  try {
    await host.evaluate((el, value) => {
      el.scrollTop = value;
    }, top);
  } finally {
    await host.dispose();
  }
}

async function recordQuickFlight(page: import("@playwright/test").Page) {
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();
}

test("flight detail shows stats, exports GPX, and deletes", async ({
  page,
}) => {
  await recordQuickFlight(page);

  await page.getByText("Logbook", { exact: true }).click();
  await page.locator(".flight-row").click();

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

test("map preview expands on tap and collapses on tap", async ({ page }) => {
  await openImportedFlight(page);
  const fullroot = page.locator(".flight-detail-map-fullroot");

  // Tap anywhere on the preview (the tap layer covers it) → full screen: the
  // map surface reparents into a body-level overlay (covering the bars).
  await page.locator(".map-tap-layer").click();
  await expect(fullroot).toBeVisible();
  await expect(page.getByTestId("map-shrink")).toBeVisible();
  await expect(page.getByTestId("map-expand")).toBeHidden();

  // Tap the map again → collapse. A lone tap only registers after the
  // double-tap window (a fast second tap means zoom), and taps landing
  // within 800ms of expanding are dropped as the tail of a preview
  // double-tap — so wait clear of the guard, like a human would.
  await page.waitForTimeout(900);
  await page
    .locator(".flight-detail-map")
    .click({ position: { x: 180, y: 300 } });
  await expect(fullroot).toBeHidden();
  await expect(page.getByTestId("map-expand")).toBeVisible();
});

test.describe("scrolled details", () => {
  // A short viewport guarantees the detail rows overflow the scroll area —
  // at full phone height the imported flight's list can fit entirely, which
  // would leave nothing to scroll and nothing to assert.
  test.use({ viewport: { width: 390, height: 600 } });

  test("expand/collapse preserves the details scroll position", async ({
    page,
  }) => {
    await openImportedFlight(page);

    // Scroll down into the details, then remember where we actually landed
    // (the exact max depends on content height).
    await setDetailScrollTop(page, 250);
    const before = await detailScrollTop(page);
    expect(before).toBeGreaterThan(100);

    // Expand — via a synthetic click on the tap layer. NOT locator.click():
    // Playwright's actionability auto-scrolls the target into view first,
    // and the tap layer's top is above the fold here — that scroll corrupts
    // the very position this test protects (a finger tap never scrolls).
    await page
      .locator(".map-tap-layer")
      .evaluate((el) => (el as HTMLElement).click());
    await expect(page.locator(".flight-detail-map-fullroot")).toBeVisible();
    // The map lifts to a body-level overlay; the scroller underneath is
    // untouched by construction.
    expect(await detailScrollTop(page)).toBe(before);

    // Collapse: still exactly where we were. mouse.click skips actionability
    // (the fullscreen map covers the viewport anyway); the wait clears the
    // single-tap double-tap guards — see the tap test above.
    await page.waitForTimeout(900);
    await page.mouse.click(180, 300);
    await expect(page.locator(".flight-detail-map-fullroot")).toBeHidden();
    await expect.poll(() => detailScrollTop(page)).toBe(before);
  });

  test("expand pill also expands, and wheel over the preview scrolls the details", async ({
    page,
  }) => {
    await openImportedFlight(page);

    await page.getByTestId("map-expand").click();
    await expect(page.locator(".flight-detail-map-fullroot")).toBeVisible();
    await page.getByTestId("map-shrink").click();
    await expect(page.locator(".flight-detail-map-fullroot")).toBeHidden();

    // Inline, the map is a scroll-through preview: scroll input over it moves
    // the details instead of being swallowed by the map (pointer-events: none;
    // an interactive map would consume this to zoom). Normalize the position
    // first and drive the mouse raw — locator actions (and the tracer's
    // snapshots around them) auto-scroll and would poison the measurement.
    await setDetailScrollTop(page, 0);
    await page.mouse.move(195, 150);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => detailScrollTop(page)).toBeGreaterThan(0);
  });
});

test("name and launch fields hint a Done return key", async ({ page }) => {
  await openImportedFlight(page);

  // enterkeyhint reaches the native inputs so the iOS keyboard shows ✓/Done
  // (the Enter-to-blur handler itself is Tauri-only).
  await expect(page.locator('ion-input[enterkeyhint="done"]')).toHaveCount(2);
});
