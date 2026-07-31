import { expect, type Page, test } from "@playwright/test";

// The pilot's own aircraft must stay the topmost thing on the flight surface
// across a mid-flight style swap (#167).
//
// It is a WebGL custom layer, and maplibre's style diff cannot see custom
// layers — they are absent from Style.serialize(), so diff() emits nothing to
// move or remove one. What keeps the aircraft on top is that carryOverlays
// appends the carried track layers LAST, so the incoming basemap's layers are
// added `before` them, which is also below the aircraft.
//
// That is incidental, not declared, and it is invisible to the obvious check:
// getLayer("aircraft") and data-aircraft-layer both stay truthy whatever the
// index is. Hence this measures _order.
const URL = "/?map=maplibre&mock-speed=40";

async function cutMapNetwork(page: Page) {
  await page.route("**/*", (route) => {
    const host = new global.URL(route.request().url()).hostname;
    const local = host === "localhost" || host === "127.0.0.1";
    return local ? route.continue() : route.abort("internetdisconnected");
  });
}

function layerOrder(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="map-container"]') as
      | (HTMLElement & {
          __map?: {
            style?: { _order?: string[] };
            getStyle():
              | {
                  sources?: Record<string, { type: string }>;
                }
              | undefined;
          };
        })
      | null;
    const map = el?.__map;
    const order = map?.style?._order ?? [];
    const sources = Object.values(map?.getStyle()?.sources ?? {});
    return {
      aircraft: order.indexOf("aircraft"),
      // How many layers are drawn OVER the aircraft. Must be zero.
      above: order.length - 1 - order.indexOf("aircraft"),
      basemapSources: sources.filter(
        (source) => source.type === "vector" || source.type === "raster",
      ).length,
    };
  });
}

test("the aircraft stays above the basemap that arrives mid-flight", async ({
  page,
}) => {
  await cutMapNetwork(page);
  await page.goto(URL);

  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-aircraft-layer='true']")).toBeVisible();

  const offline = await layerOrder(page);
  expect(offline.basemapSources).toBe(0);
  expect(offline.above).toBe(0);

  // Signal returns and the retry swaps a real basemap in with the flight still
  // recording — what a pilot who took off out of coverage actually flies.
  await page.unroute("**/*");
  await expect
    .poll(async () => (await layerOrder(page)).basemapSources, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);

  const online = await layerOrder(page);
  expect(online.aircraft).toBeGreaterThanOrEqual(0);
  expect(online.above).toBe(0);
});
