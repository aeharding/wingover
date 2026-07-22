import { expect, type Page, test } from "@playwright/test";

// The CSS→JS inset bridge: the map's buttons read var(--ion-safe-area-*)
// straight from CSS, but the basemap attribution (MapKit's logo, and this
// mirror) goes through MapCanvas's probe → setInsets. The bug class this
// guards: the fullscreen toggle REPARENTS the map surface (reverse portal)
// in the same commit as the consume-class change, and a style-observer
// built on transition events sees nothing for changes applied across a
// DOM move — the CSS side updates, the JS side goes stale until the next
// in-place change (rotation). The container's __insets debug handle (the
// __map convention) mirrors what was actually pushed.

async function recordQuickFlight(page: Page) {
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

test("the fullscreen toggle re-feeds the basemap inset bridge", async ({
  page,
}) => {
  await recordQuickFlight(page);

  // Stand in for a device with real insets (headless env() is 0 on every
  // edge): the harness's distinct per-edge values, injected upstream of
  // the --ion-safe-area-* derivation exactly like e2e/inset-probe.mjs.
  await page.addStyleTag({
    content: `:root {
      --safe-area-inset-top: 11px;
      --safe-area-inset-right: 22px;
      --safe-area-inset-bottom: 33px;
      --safe-area-inset-left: 44px;
    }`,
  });

  await page.getByText("Logbook", { exact: true }).click();
  await page.getByTestId("flight-row").click();

  const container = page
    .getByTestId("flight-detail-map")
    .getByTestId("map-container");
  const insets = () =>
    container.evaluate(
      (el) => (el as HTMLElement & { __insets?: object }).__insets,
    );

  // Inline the map is a boxed mid-page preview: every edge is covered by
  // page chrome (consume-all), so the bridge must have pushed zeros.
  await expect.poll(insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });

  // Expand: the surface reparents into the body-level fullroot and the
  // region stops consuming — all four device edges are now the map's.
  await page.getByTestId("map-expand").click();
  await expect(page.getByTestId("flight-detail-map-fullroot")).toBeVisible();
  await expect
    .poll(insets)
    .toEqual({ top: 11, right: 22, bottom: 33, left: 44 });

  // And back: the inline preview consumes everything again.
  await page.getByTestId("map-shrink").click();
  await expect(page.getByTestId("flight-detail-map-fullroot")).toBeHidden();
  await expect.poll(insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
});

test("closing the replay pane restores the bottom inset without a box change", async ({
  page,
}) => {
  // Adversarial-review counterexample: the pane's close ANIMATES the map
  // region to its final size while consume-bottom is still applied
  // (isOpen holds through "closing"), then the class flips at
  // transitionend with no further resize. A container ResizeObserver's
  // last read has the bottom consumed; the restore must still land.
  await recordQuickFlight(page);
  await page.addStyleTag({
    content: `:root {
      --safe-area-inset-top: 11px;
      --safe-area-inset-right: 22px;
      --safe-area-inset-bottom: 33px;
      --safe-area-inset-left: 44px;
    }`,
  });
  await page.getByText("Logbook", { exact: true }).click();
  await page.getByTestId("flight-row").click();
  const container = page
    .getByTestId("flight-detail-map")
    .getByTestId("map-container");
  const insets = () =>
    container.evaluate(
      (el) => (el as HTMLElement & { __insets?: object }).__insets,
    );

  await page.getByTestId("map-expand").click();
  await expect
    .poll(insets)
    .toEqual({ top: 11, right: 22, bottom: 33, left: 44 });

  // Open the replay pane: it owns the home indicator, the map consumes it.
  await page.getByTestId("replay-start").click();
  await expect(page.getByTestId("replay-dock")).toBeVisible();
  await expect
    .poll(insets)
    .toEqual({ top: 11, right: 22, bottom: 0, left: 44 });

  // Collapse: the bottom edge is the map's again.
  await page.getByTestId("replay-collapse").click();
  await expect(page.getByTestId("replay-dock")).toBeHidden();
  await expect
    .poll(insets)
    .toEqual({ top: 11, right: 22, bottom: 33, left: 44 });
});

test("a sum-preserving left/right swap still re-feeds the bridge", async ({
  page,
}) => {
  // The 180-degree landscape flip in miniature: left and right swap while
  // every box keeps its exact size (the sums are unchanged), so nothing
  // resizes anywhere — only the resolved vars move.
  await recordQuickFlight(page);
  await page.addStyleTag({
    content: `:root {
      --safe-area-inset-top: 11px;
      --safe-area-inset-right: 22px;
      --safe-area-inset-bottom: 33px;
      --safe-area-inset-left: 44px;
    }`,
  });
  await page.getByText("Logbook", { exact: true }).click();
  await page.getByTestId("flight-row").click();
  const container = page
    .getByTestId("flight-detail-map")
    .getByTestId("map-container");
  const insets = () =>
    container.evaluate(
      (el) => (el as HTMLElement & { __insets?: object }).__insets,
    );

  await page.getByTestId("map-expand").click();
  await expect
    .poll(insets)
    .toEqual({ top: 11, right: 22, bottom: 33, left: 44 });

  await page.addStyleTag({
    content: `:root {
      --safe-area-inset-right: 44px;
      --safe-area-inset-left: 22px;
    }`,
  });
  await expect
    .poll(insets)
    .toEqual({ top: 11, right: 44, bottom: 33, left: 22 });
});
