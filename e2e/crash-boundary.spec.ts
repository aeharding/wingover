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

  // CompassButton subscribes to "rotate", not "move", so a pan would never
  // make it re-read. Fire the event the store actually listens to; firing it
  // directly also avoids calling the getter we just broke from inside
  // page.evaluate, where the throw would land in the test instead of in React.
  await page.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="map-container"]',
    ) as HTMLElement & { __map?: { fire(type: string): void } };
    el.__map!.fire("rotate");
  });

  await expect(page.getByTestId("app-crashed")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  // The point of the boundary: a body with something in it.
  expect(await page.locator("#root").innerHTML()).not.toBe("");
});
