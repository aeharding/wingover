import { expect, test } from "@playwright/test";

// Tests of the real MapLibre backend and its resilience — the parts a fake
// map cannot exercise: slow/partial style loading, sprite stalls, and the
// setStyle layer-teardown restore path. These use plain @playwright/test (no
// fake-backend fixture); on localhost resolveBackend() picks MapLibre, and
// they intercept MapTiler / poke the live map directly. MapKit rendering is
// verified on-device, against wingover.local.

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

  await page.goto("/?mock-speed=40&map=maplibre");
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

  await page.goto("/?mock-speed=40&map=maplibre");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-aircraft-layer='true']")).toBeVisible({
    timeout: 10_000,
  });
  expect(pageErrors).toEqual([]);
});

test("a style reload that drops the aircraft layer restores it", async ({
  page,
}) => {
  await page.goto("/?mock-speed=40&map-style=blank&map=maplibre");
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
    };
  });

  expect(result.goneAfterRemove).toBe(true);
  expect(result.trackSourceStillPresent).toBe(true);

  // The app's sync() re-adds the aircraft layer — but it only runs its work
  // once the style is loaded, so under load the fired styledata can no-op and a
  // following styledata/idle does the restore. Wait for the layer rather than
  // reading it in the same tick we fired the event.
  await page.waitForFunction(
    () => {
      const map = (
        document.querySelector(".map-container") as HTMLElement & {
          __map?: { getLayer: (id: string) => unknown };
        }
      )?.__map;
      return !!map?.getLayer("aircraft");
    },
    { timeout: 10_000 },
  );
});

test("flight detail draws the track even when the map style loads slowly", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

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

  await page.goto("/?mock-speed=40&map=maplibre");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();

  await page.getByText("Logbook", { exact: true }).click();
  await page.getByRole("heading", { name: /^Flight / }).click();

  await expect(page.getByTestId("launch-marker")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("landing-marker")).toBeVisible();
  await expect(page.locator("[data-track-layer='true']")).toBeVisible({
    timeout: 10_000,
  });
  expect(pageErrors).toEqual([]);
});

test("composite map draws all flights even with a slow style", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

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

  await page.goto("/?mock-speed=40&map=maplibre");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();

  await page.getByText("Logbook", { exact: true }).click();
  await page.getByTestId("logbook-options").click();
  await page.getByRole("button", { name: "All Flights" }).click();

  await expect(
    page.locator("ion-title").filter({ hasText: "All Flights" }),
  ).toBeVisible();
  await expect(page.locator("[data-flights-layer='true']")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("Oldest → newest")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
