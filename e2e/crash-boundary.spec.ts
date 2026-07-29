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

// The two drills #188 specified for the in-flight boundary, which the first
// version of this file skipped. Their absence let a regression ship green: a
// compare-and-set inside the fallback answered `true` to the render React
// discards and `false` to the one that commits, so the heal silently never
// fired while every gate stayed green.
//
// The crash is injected by breaking a Number method the instruments format
// through, which is a render-phase read on the flight surface — the same shape
// as #185's camera getter, and the only injection point that does not need a
// production seam.
async function flyThenCrash(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { __alive?: boolean }).__alive = true;
    Number.prototype.toFixed = () => {
      throw new Error("e2e: simulated render failure on the flight surface");
    };
  });
}

test("a crash in flight heals itself, and the flight is still recording", async ({
  page,
}) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.evaluate(() => localStorage.removeItem("wingover.crash.healedAt"));
  await flyThenCrash(page);

  // The reload is the assertion: __alive was set before the crash and only a
  // fresh document clears it.
  await expect
    .poll(
      () => page.evaluate(() => (window as { __alive?: boolean }).__alive),
      { timeout: 20_000 },
    )
    .toBeUndefined();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("app-crashed")).toBeHidden();
});

test("a second crash inside the window stops reloading and surfaces", async ({
  page,
}) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  // A heal already spent, one second ago: the window has not elapsed.
  await page.evaluate(() =>
    localStorage.setItem("wingover.crash.healedAt", String(Date.now() - 1000)),
  );
  await flyThenCrash(page);

  await expect(page.getByTestId("app-crashed")).toBeVisible({
    timeout: 20_000,
  });
  // Still the same document: it must NOT have reloaded.
  expect(
    await page.evaluate(() => (window as { __alive?: boolean }).__alive),
  ).toBe(true);
});
