import { expect, type Page, test } from "@playwright/test";

// A basemap style that PARSES but whose sprite never answers (#170). The
// existing slow-sprite drill in maplibre.spec.ts waits 1.2s and then answers,
// which is the recoverable case. This is the one that does not recover:
// captive portal, half-open connection, a CDN edge that accepts and stalls.
//
// The track is local data. It owes the sprite nothing.
const URL = "/?mock-speed=40&map=maplibre";

async function styleWithHangingSprite(page: Page) {
  await page.route("**/api.maptiler.com/**", (route) => route.abort());
  await page.route("**/styles/liberty", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        version: 8,
        sprite: "https://tiles.openfreemap.org/hang-sprite/sprite",
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
  // Never fulfilled, never aborted: the request just hangs, exactly as a
  // half-open connection does.
  await page.route("**/hang-sprite/**", () => {});
}

function mapState(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="map-container"]') as
      | (HTMLElement & {
          __map?: {
            isStyleLoaded(): boolean;
            getLayer(id: string): unknown;
            style?: { _order?: string[] };
          };
        })
      | null;
    const map = el?.__map;
    if (!map) return { ready: false as const };
    return {
      ready: true as const,
      styleLoaded: map.isStyleLoaded(),
      track: !!map.getLayer("track"),
      order: map.style?._order ?? [],
    };
  });
}

test("a sprite that never answers does not take the track down", async ({
  page,
}) => {
  await styleWithHangingSprite(page);
  await page.goto(URL);

  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 15_000 });

  await expect
    .poll(async () => (await mapState(page)).track, { timeout: 20_000 })
    .toBe(true);

  // The sprite is still hanging at this point — that is the whole scenario.
  // If it ever resolves, this drill has stopped testing what it claims to.
  expect((await mapState(page)).styleLoaded).toBe(false);
  await expect(page.locator("[data-aircraft-layer='true']")).toBeVisible();
});
