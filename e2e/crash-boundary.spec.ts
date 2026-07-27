import { expect, test } from "@playwright/test";

// #185 ended with a black screen because nothing caught the throw: MapKit's
// camera getter died, CompassButton read it from React's RENDER phase, and the
// root unmounted. This asserts the outcome the pilot sees now.
//
// The throw is injected test-side rather than through a production seam: the
// map adapter stashes its handle on the container, and CompassButton reads the
// bearing through it during render, so breaking that getter reproduces the
// exact shape of the original crash without the app knowing it is under test.
test("a crash on a ground page shows the crash screen, not a blank page", async ({
  page,
}) => {
  await page.goto("/plan?map=maplibre&map-style=blank");

  const container = page.locator(
    '[data-testid="map-container"], [data-testid="live-map"] [data-testid="map-container"]',
  );
  await expect(container.first()).toBeVisible({ timeout: 15_000 });
  // The handle is attached asynchronously, after the adapter resolves its
  // style — waiting for it, rather than assuming it, is what maplibre.spec:348
  // does not do (#152).
  await page.waitForFunction(
    () =>
      !!(
        document.querySelector(
          '[data-testid="map-container"]',
        ) as HTMLElement & {
          __map?: unknown;
        }
      )?.__map,
    { timeout: 15_000 },
  );

  await page.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="map-container"]',
    ) as HTMLElement & { __map?: { getBearing(): number } };
    el.__map!.getBearing = () => {
      throw new Error("e2e: simulated MapKit camera failure");
    };
  });

  // CompassButton subscribes to "rotate", not "move", so nudge the stream it
  // actually listens to. Every hop is optional on purpose: depending on
  // timing the map may re-read the broken getter and crash on its own first,
  // in which case React has already removed this element and a non-optional
  // chain would throw here — failing the drill at the moment the feature
  // worked. Firing the event directly (rather than reading the getter from
  // page.evaluate) also keeps the throw inside React, where the boundary is.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="map-container"]') as
      (HTMLElement & { __map?: { fire?(type: string): void } }) | null;
    el?.__map?.fire?.("rotate");
  });
  await expect(page.getByTestId("app-crashed")).toBeVisible({
    timeout: 15_000,
  });

  // Clicked, not merely visible. A crash screen whose only way out is dead
  // leaves the pilot exactly where the black screen did, and `toBeVisible`
  // would ship that green.
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByTestId("app-crashed")).toBeHidden({ timeout: 15_000 });
  await expect(
    page.locator('[data-testid="map-container"]').first(),
  ).toBeVisible({ timeout: 15_000 });
});
