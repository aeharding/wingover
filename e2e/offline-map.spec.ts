import { expect, type Page, test } from "@playwright/test";

// Offline basemap (issue #164). MapLibre is forced because these drills are
// about what happens when the map's NETWORK dies; MapKit is a separate adapter
// with its own story.
const URL = "/?map=maplibre";

// Kill the map's network without killing the app's. On device the app is a
// local Tauri bundle, so a dead network must never stop it loading — only the
// basemap it reaches for.
async function cutMapNetwork(page: Page) {
  await page.route("**/*", (route) => {
    const host = new global.URL(route.request().url()).hostname;
    const local = host === "localhost" || host === "127.0.0.1";
    return local ? route.continue() : route.abort("internetdisconnected");
  });
}

// The one assertion that actually discriminates. A map with no style has no
// layers at all — that is the reported failure, where the track vanished along
// with the basemap. Counting real basemap SOURCES separates "blank style up"
// from "real basemap up"; `getLayer("track")` proves the pilot's own data
// survived either way.
function mapState(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="map-container"]') as
      (HTMLElement & { __map?: MapLibreLike }) | null;
    const map = el?.__map;
    if (!map?.getStyle) return { ready: false as const };
    const sources = Object.values(map.getStyle()?.sources ?? {});
    return {
      ready: true as const,
      track: !!map.getLayer("track"),
      // By TYPE, not by name: a basemap is vector or raster, while every
      // overlay we add ourselves is geojson and needs no network. Names would
      // not discriminate — the track's source id is its testId, "track".
      basemapSources: sources.filter(
        (source) => source.type === "vector" || source.type === "raster",
      ).length,
    };
  });
}

interface MapLibreLike {
  getStyle(): { sources?: Record<string, { type: string }> } | undefined;
  getLayer(id: string): unknown;
}

// Seed a flight from the local GPX fixture and open its detail map. Import is
// entirely local, so it works with every external host blocked.
async function openTrack(page: Page) {
  await page.locator("#tab-button-logbook").click();
  await page.getByTestId("logbook-options").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import GPX files" }).click();
  await (await chooser).setFiles("e2e/fixtures/flight.gpx");
  await page.getByRole("heading", { name: "Tomahawk Test Flight" }).click();
  await expect(page.getByTestId("map-container")).toBeVisible();
}

test("with no network the track still draws", async ({ page }) => {
  await cutMapNetwork(page);
  await page.goto(URL);
  await openTrack(page);

  // The track is local data and owes the network nothing. Before this fix a
  // failed style meant maplibre never fired style.load, the overlay registry
  // never ran, and the track disappeared with the basemap.
  await expect
    .poll(async () => (await mapState(page)).track, { timeout: 15_000 })
    .toBe(true);
  expect((await mapState(page)).basemapSources).toBe(0);
});

// The requirement that forced the retry: the Fly map is mounted for a whole
// flight, so a pilot who takes off out of coverage has no navigation left to
// re-resolve the style. Flying back into coverage must fill the map in by
// itself.
test("the basemap arrives on its own once the network returns", async ({
  page,
}) => {
  // Waits out a real retry cycle, so it needs more than the default budget.
  test.setTimeout(90_000);
  let blocked = true;
  await page.route("**/*", (route) => {
    const host = new global.URL(route.request().url()).hostname;
    if (host === "localhost" || host === "127.0.0.1") return route.continue();
    if (!blocked) return route.continue();
    return route.abort("internetdisconnected");
  });

  await page.goto(URL);
  await openTrack(page);
  await expect
    .poll(async () => (await mapState(page)).track, { timeout: 15_000 })
    .toBe(true);
  expect((await mapState(page)).basemapSources).toBe(0);

  // No reload, no interaction, no connectivity event — just coverage back.
  blocked = false;
  await expect
    .poll(async () => (await mapState(page)).basemapSources, {
      timeout: 45_000,
    })
    .toBeGreaterThan(0);
  // And the pilot's data comes back with it. Polled, not instant: setStyle
  // drops every runtime-added layer and the content registry re-adds them on
  // style.load, so there is a brief window mid-swap with no track. That window
  // is pre-existing — an appearance flip does the same — and what matters is
  // that it closes.
  await expect
    .poll(async () => (await mapState(page)).track, { timeout: 15_000 })
    .toBe(true);
});
