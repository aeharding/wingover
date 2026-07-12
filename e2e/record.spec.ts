import { expect, test } from "@playwright/test";

test("arm, auto-takeoff, reload kill drill, stop, logbook", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();

  await expect(page.getByTestId("armed")).toBeVisible();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("ion-tab-bar")).toBeHidden();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await expect(page.locator("[data-aircraft-layer='true']")).toBeVisible();
  await expect(page.getByTestId("instrument-duration")).not.toHaveText("0:00");

  // Style regression guards. The attribution must stay transparent
  // (MapView.css loading after maplibre's css), and the fly page must not
  // scroll — the scrollbar lives in ion-content's shadow DOM inner-scroll,
  // which document-level overflow checks cannot see.
  const styleGuards = await page.evaluate(() => ({
    attribBackground: getComputedStyle(
      document.querySelector(".maplibregl-ctrl-attrib")!,
    ).backgroundColor,
    innerScrollOverflowY: getComputedStyle(
      document
        .querySelector("ion-content.fly-content")!
        .shadowRoot!.querySelector(".inner-scroll")!,
    ).overflowY,
  }));
  expect(styleGuards.attribBackground).toBe("rgba(0, 0, 0, 0)");
  expect(styleGuards.innerScrollOverflowY).toBe("hidden");

  await page.getByRole("button", { name: "Track up" }).click();
  await expect(page.getByRole("button", { name: "Track up" })).toHaveAttribute(
    "data-active",
    "true",
  );

  await page.waitForTimeout(1000);
  await page.goto("/?mock-speed=40&map-style=blank");

  await expect(page.getByTestId("recording")).toBeVisible();
  await expect(page.getByRole("button", { name: "Track up" })).toHaveAttribute(
    "data-active",
    "true",
  );
  const rehydrated = await page
    .getByTestId("instrument-duration")
    .textContent();
  expect(rehydrated).not.toBe("0:00");
  expect(rehydrated).not.toBeNull();

  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop & save" }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("ion-tab-bar")).toBeVisible();

  await page.getByText("Logbook", { exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Flight / })).toBeVisible();
  await expect(page.getByText(/1 flights/)).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("live map survives a slow-loading style", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  // Abort all MapTiler first, then win specifically for the street style
  // (now MapTiler streets-v4-dark) with a slow, minimal style.
  await page.route("**/api.maptiler.com/**", (route) => route.abort());
  await page.route(
    "**/maps/streets-v4-dark/style.json**",
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          version: 8,
          sources: {},
          layers: [
            {
              id: "background",
              type: "background",
              paint: { "background-color": "#222" },
            },
          ],
        }),
      });
    },
  );

  await page.goto("/?mock-speed=40");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-aircraft-layer='true']")).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(1500);
  expect(pageErrors).toEqual([]);
});

test("live map layers appear despite a slow sprite holding the style", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  // style.load fires when the style JSON parses, but isStyleLoaded() stays
  // false until sprites finish — the window where layer setup used to get
  // permanently skipped until a view toggle.
  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  // Abort MapTiler first; the specific routes below win for the street
  // style (now MapTiler streets-v4-dark) and the fake slow sprite.
  await page.route("**/api.maptiler.com/**", (route) => route.abort());
  await page.route("**/maps/streets-v4-dark/style.json**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        version: 8,
        sprite: "https://tiles.openfreemap.org/test-sprite/sprite",
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#222" },
          },
        ],
      }),
    }),
  );
  await page.route("**/test-sprite/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (route.request().url().includes(".json")) {
      await route.fulfill({ contentType: "application/json", body: "{}" });
    } else {
      await route.fulfill({ contentType: "image/png", body: onePixelPng });
    }
  });

  await page.goto("/?mock-speed=40");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-aircraft-layer='true']")).toBeVisible({
    timeout: 10_000,
  });
  expect(pageErrors).toEqual([]);
});

test("canceling while acquiring GPS discards the session", async ({ page }) => {
  await page.goto("/?mock-speed=2&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();

  await expect(page.getByTestId("armed")).toBeVisible();
  await expect(page.getByText("Acquiring GPS")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();

  await page.getByText("Logbook", { exact: true }).click();
  await expect(page.getByText("No flights yet.")).toBeVisible();
});

test("canceling the stop confirmation keeps recording", async ({ page }) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();

  await expect(page.getByTestId("recording")).toBeVisible();
  await expect(page.getByTestId("instrument-duration")).not.toHaveText("0:00");
});

test("a two-hour flight lands itself and reaches the logbook hands-free", async ({
  page,
}) => {
  await page.goto("/?mock-speed=6000&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  // The simulated pilot stops in place after two hours of flight; landing
  // detection, the fix-time grace, finalization, and collection all run
  // with zero interaction.
  await expect(page.getByText("Flight saved to logbook")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "Start Flight" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator("ion-tab-bar")).toBeVisible();
});

test("zoom control zooms one-fingered from anywhere without unpinning follow", async ({
  page,
}) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });

  const control = page.getByRole("slider", { name: "Zoom" });
  await expect(control).toBeVisible();
  // Bounds are ground spans, not tile-stack limits: ~20 mi and ~0.35 mi
  // across the screen (both latitude/viewport dependent).
  const valuemin = async () =>
    Number(await control.getAttribute("aria-valuemin"));
  const valuemax = async () =>
    Number(await control.getAttribute("aria-valuemax"));
  const valuenow = async () =>
    Number(await control.getAttribute("aria-valuenow"));
  expect(await valuemin()).toBeGreaterThan(9);
  expect(await valuemin()).toBeLessThan(12);
  expect(await valuemax()).toBeGreaterThan(15);
  expect(await valuemax()).toBeLessThan(18);
  const before = await valuenow();

  // Relative drag: press anywhere in the zone (off-center) and drag DOWN
  // to zoom in. No thumb to hit — the start point does not matter.
  const box = (await control.boundingBox())!;
  const downX = box.x + box.width * 0.6;
  await page.mouse.move(downX, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(downX, box.y + 150, { steps: 8 });
  await page.mouse.up();

  await expect.poll(valuenow).toBeGreaterThan(before);
  // Dragging the control is not a map drag: follow must stay pinned.
  await expect(
    page.getByRole("button", { name: "Follow aircraft" }),
  ).toHaveAttribute("data-active", "true");

  // Dragging UP from a fresh grab zooms back out (relative each time).
  const zoomedIn = await valuenow();
  const upX = box.x + box.width * 0.4;
  await page.mouse.move(upX, box.y + box.height - 10);
  await page.mouse.down();
  await page.mouse.move(upX, box.y + box.height - 140, { steps: 8 });
  await page.mouse.up();
  await expect.poll(valuenow).toBeLessThan(zoomedIn);
});

test("edge guards stop an edge swipe from panning, inland drag still pans", async ({
  page,
}) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });

  const follow = page.getByRole("button", { name: "Follow aircraft" });
  await expect(follow).toHaveAttribute("data-active", "true");

  const map = (await page.locator(".live-map").boundingBox())!;
  // A swipe from the very bottom edge lands on the guard, not the map: the
  // map must not pan, so follow stays pinned (the iOS app-switch swipe).
  await page.mouse.move(map.x + map.width / 2, map.y + map.height - 3);
  await page.mouse.down();
  await page.mouse.move(map.x + map.width / 2 - 160, map.y + map.height - 3, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(follow).toHaveAttribute("data-active", "true");

  // A normal inland drag still pans, which unpins follow.
  await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);
  await page.mouse.down();
  await page.mouse.move(map.x + map.width / 2 - 140, map.y + map.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(follow).toHaveAttribute("data-active", "false");
});

test("a style reload that drops the aircraft layer restores it", async ({
  page,
}) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });

  // Gate on the real map state, not the (write-once) DOM attribute: the
  // style must be loaded and the aircraft layer actually present before we
  // manipulate it, or firing styledata races an unloaded style.
  await page.waitForFunction(
    () => {
      const map = (
        document.querySelector(".map-container") as HTMLElement & {
          __map?: {
            isStyleLoaded: () => boolean;
            getLayer: (id: string) => unknown;
          };
        }
      )?.__map;
      return !!map && map.isStyleLoaded() && !!map.getLayer("aircraft");
    },
    { timeout: 10_000 },
  );

  // A mid-flight map-style switch calls setStyle, which tears down every
  // runtime-added custom layer while the geojson track source can outlive
  // it. Reproduce that exact state — drop the aircraft layer but keep the
  // track source — then let the app's own styledata listener run. It must
  // restore the aircraft (the "aircraft vanishes until app restart" bug).
  const result = await page.evaluate(() => {
    const container = document.querySelector(".map-container") as HTMLElement & {
      __map?: {
        getLayer: (id: string) => unknown;
        getSource: (id: string) => unknown;
        removeLayer: (id: string) => void;
        fire: (event: string) => void;
      };
    };
    const map = container.__map!;
    map.removeLayer("aircraft");
    const goneAfterRemove = !map.getLayer("aircraft");
    map.fire("styledata");
    return {
      goneAfterRemove,
      trackSourceStillPresent: !!map.getSource("track"),
      aircraftRestored: !!map.getLayer("aircraft"),
    };
  });

  expect(result.goneAfterRemove).toBe(true);
  expect(result.trackSourceStillPresent).toBe(true);
  expect(result.aircraftRestored).toBe(true);
});
