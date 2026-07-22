import { expect, type Page, test } from "@playwright/test";

// The CSS→JS inset bridge: the map's buttons read var(--ion-safe-area-*)
// straight from CSS, but the basemap attribution (MapKit's logo, and this
// mirror) goes through MapCanvas's probe → setInsets. The bug class this
// guards: the fullscreen toggle REPARENTS the map surface (reverse portal)
// in the same commit as the consume-class change, and a style-observer
// built on transition events sees nothing for changes applied across a
// DOM move — the CSS side updates, the JS side goes stale until the next
// in-place change (rotation). data-insets on the probe mirrors what was
// actually pushed.

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

  const probe = page
    .getByTestId("flight-detail-map")
    .getByTestId("map-inset-probe");

  // Inline the map is a boxed mid-page preview: every edge is covered by
  // page chrome (consume-all), so the bridge must have pushed zeros.
  await expect(probe).toHaveAttribute("data-insets", "0,0,0,0");

  // Expand: the surface reparents into the body-level fullroot and the
  // region stops consuming — all four device edges are now the map's.
  await page.getByTestId("map-expand").click();
  await expect(page.getByTestId("flight-detail-map-fullroot")).toBeVisible();
  await expect(probe).toHaveAttribute("data-insets", "11,22,33,44");

  // And back: the inline preview consumes everything again.
  await page.getByTestId("map-shrink").click();
  await expect(page.getByTestId("flight-detail-map-fullroot")).toBeHidden();
  await expect(probe).toHaveAttribute("data-insets", "0,0,0,0");
});
