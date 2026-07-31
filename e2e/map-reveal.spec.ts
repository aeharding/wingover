import { expect, test } from "@playwright/test";

// MapCanvas holds the maplibre canvas at opacity 0 until the adapter's `ready`
// resolves, so `ready` decides when the pilot may see their track.
//
// It used to resolve on maplibre's `load`, which waits for the sprite among
// other things. A sprite that never answers meant `load` never fired, and the
// reveal fell through to the 4s backstop with the track drawn and invisible
// the whole time. The sprite is a basemap detail; the track is not.
//
// The logbook flow, not the Fly page: it is the one where the real style lands
// before `load` can fire off the no-basemap style, which is what puts the
// reveal behind the sprite.
const REVEAL_FALLBACK_MS = 4000;

test("the map is revealed while the sprite is still hanging", async ({
  page,
}) => {
  // Never fulfilled, never aborted — a half-open connection, not a failure.
  await page.route("**/hang-sprite/**", () => {});
  // Served from memory so the upgrade off the no-basemap style always lands
  // before maplibre finishes its first-load bookkeeping. Left to the network,
  // that is a race, and when `load` wins there is nothing holding the veil and
  // the drill proves nothing.
  await page.route("**/api.maptiler.com/**", (route) => route.abort());
  await page.route(/tiles\.openfreemap\.org\/styles\//, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        version: 8,
        sprite: "https://tiles.openfreemap.org/hang-sprite/sprite",
        sources: {
          demo: {
            type: "vector",
            tiles: ["https://tiles.openfreemap.org/never/{z}/{x}/{y}.pbf"],
          },
        },
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

  await page.addInitScript(() => {
    const w = window as unknown as {
      __mapAt?: number;
      __revealAt?: number;
      __basemapAt?: number;
      __loadFired?: boolean;
    };
    setInterval(() => {
      const el = document.querySelector('[data-testid="map-container"]') as
        | (HTMLElement & {
            __map?: {
              on(e: string, f: () => void): void;
              getStyle():
                { sources?: Record<string, { type: string }> } | undefined;
            };
          })
        | null;
      const map = el?.__map;
      if (map && w.__mapAt === undefined) {
        w.__mapAt = performance.now();
        map.on("load", () => {
          w.__loadFired = true;
        });
      }
      const basemap = Object.values(map?.getStyle()?.sources ?? {}).some(
        (source) => source.type === "vector" || source.type === "raster",
      );
      if (basemap && w.__basemapAt === undefined)
        w.__basemapAt = performance.now();
      const canvas = el?.querySelector(".maplibregl-canvas");
      if (canvas && w.__revealAt === undefined) {
        if (getComputedStyle(canvas).opacity === "1")
          w.__revealAt = performance.now();
      }
    }, 25);
  });

  await page.goto("/?map=maplibre");
  await page.locator("#tab-button-logbook").click();
  await page.getByTestId("logbook-options").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import GPX files" }).click();
  (await chooser).setFiles("e2e/fixtures/flight.gpx");
  await page.getByRole("heading", { name: "Tomahawk Test Flight" }).click();
  await expect(page.getByText("Max altitude")).toBeVisible();

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __revealAt?: number }).__revealAt !==
            undefined,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);

  const marks = await page.evaluate(() => {
    const w = window as unknown as {
      __mapAt: number;
      __revealAt: number;
      __basemapAt?: number;
      __loadFired?: boolean;
    };
    return {
      toReveal: w.__revealAt - w.__mapAt,
      basemapIn: w.__basemapAt !== undefined,
      loadFired: !!w.__loadFired,
    };
  });

  // Comfortably inside the backstop, which is the only thing that lifted the
  // veil in this state before. The remainder is the 0.25s CSS fade.
  expect(marks.toReveal).toBeLessThan(REVEAL_FALLBACK_MS / 2);

  // Both guards keep the scenario honest: the real basemap style must have
  // landed (otherwise this only proves the no-basemap style reveals fast), and
  // `load` must NOT have fired (otherwise the sprite is not hanging and there
  // was nothing to hold the veil).
  expect(marks.basemapIn).toBe(true);
  expect(marks.loadFired).toBe(false);
});
