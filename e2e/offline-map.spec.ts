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

// Watch the track CONTINUOUSLY from inside the page. A before/after check
// cannot see a gap that opens and closes between two awaits, and that gap is
// exactly the defect: the track vanished for about a second as the basemap
// swapped in.
async function startTrackSampler(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __gap?: number; __sampler?: number };
    w.__gap = 0;
    w.__sampler = window.setInterval(() => {
      const el = document.querySelector('[data-testid="map-container"]') as
        (HTMLElement & { __map?: { getLayer(id: string): unknown } }) | null;
      const map = el?.__map;
      if (!map?.getLayer) return;
      if (!map.getLayer("track")) w.__gap = (w.__gap ?? 0) + 1;
    }, 50);
  });
}

// Number of samples in which the track was missing. Must be zero.
async function sampledTrackGap(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __gap?: number; __sampler?: number };
    if (w.__sampler) window.clearInterval(w.__sampler);
    return w.__gap ?? 0;
  });
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
  // Coverage "returning" is served locally. Letting the real CDN answer would
  // put a third party inside a suite that runs zero retries by design.
  const STYLE = {
    version: 8,
    sources: {
      demo: { type: "raster", tiles: ["http://localhost/{z}/{x}/{y}.png"] },
    },
    layers: [{ id: "bg", type: "background", paint: {} }],
  };
  await page.route("**/*", (route) => {
    const host = new global.URL(route.request().url()).hostname;
    if (host === "localhost" || host === "127.0.0.1") return route.continue();
    if (blocked) return route.abort("internetdisconnected");
    if (/styles?\//.test(route.request().url())) {
      return route.fulfill({ json: STYLE });
    }
    return route.abort("internetdisconnected");
  });

  await page.goto(URL);
  await openTrack(page);
  await expect
    .poll(async () => (await mapState(page)).track, { timeout: 15_000 })
    .toBe(true);
  expect((await mapState(page)).basemapSources).toBe(0);

  // No reload, no interaction, no connectivity event — just coverage back.
  await startTrackSampler(page);
  blocked = false;
  await expect
    .poll(async () => (await mapState(page)).basemapSources, {
      timeout: 45_000,
    })
    .toBeGreaterThan(0);
  // And the track was never absent while that happened. Polling for it to
  // come BACK would hide the bug this pins: a style swap drops every
  // runtime-added layer, and restoring a geojson source costs a worker parse,
  // so the track blinked out for about a second — reported from the device.
  // transformStyle now carries it into the incoming style instead.
  expect(await sampledTrackGap(page)).toBe(0);
});

// Reported from device: the FIRST offline map drew fine, every one after it
// was blank — and stayed blank even back online.
//
// MapKit is the default backend, and Apple's loader reuses an existing script
// tag found by data-callback. After a failed load that tag remains in the head
// with its error event already fired, so the next call awaits listeners that
// can never fire and hangs. createBackend awaits it, so the catch never runs
// and the MapLibre fallback never happens: no map at all, for the life of the
// page. Deliberately uses the DEFAULT backend, since forcing maplibre skips the
// loader entirely and cannot see this.
test("every offline map draws, not just the first", async ({ page }) => {
  test.setTimeout(90_000);
  await cutMapNetwork(page);
  await page.goto("/?e2e=0");
  await openTrack(page);
  await expect
    .poll(async () => (await mapState(page)).track, { timeout: 20_000 })
    .toBe(true);

  for (let entry = 2; entry <= 3; entry++) {
    await page.goBack();
    await page.getByRole("heading", { name: "Tomahawk Test Flight" }).click();
    await expect(page.getByTestId("map-container")).toBeVisible();
    await expect
      .poll(async () => (await mapState(page)).track, { timeout: 25_000 })
      .toBe(true);
  }
});
