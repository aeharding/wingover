import { expect, type Page, test } from "@playwright/test";

// Deliberately the DEFAULT backend, not ?map=maplibre: forcing maplibre skips
// the MapKit loader entirely, which is the thing under test.
const URL = "/?e2e=0";

// Kill the map's network without killing the app's. On device the app is a
// local Tauri bundle, so a dead network must never stop it loading.
async function cutMapNetwork(page: Page) {
  await page.route("**/*", (route) => {
    const host = new global.URL(route.request().url()).hostname;
    const local = host === "localhost" || host === "127.0.0.1";
    return local ? route.continue() : route.abort("internetdisconnected");
  });
}

// A hang leaves NO map object at all: createBackend never returns, so the
// fallback never runs and nothing is handed to the container. That absence is
// the bug's signature. What the map DRAWS is the offline work's business, not
// this fix's.
function mapExists(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="map-container"]') as
      (HTMLElement & { __map?: unknown }) | null;
    return !!el?.__map;
  });
}

async function openTrack(page: Page) {
  await page.locator("#tab-button-logbook").click();
  await page.getByTestId("logbook-options").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import GPX files" }).click();
  await (await chooser).setFiles("e2e/fixtures/flight.gpx");
  await page.getByRole("heading", { name: "Tomahawk Test Flight" }).click();
  await expect(page.getByTestId("map-container")).toBeVisible();
}

// Reported from device: the first offline map drew, every one after it was
// blank, and stayed blank even back online.
//
// Apple's loader finds an existing script tag by data-callback and REUSES it.
// After a failed load that tag remains with its error event already fired, so
// the next call waits on events that can never fire again — it hangs instead of
// rejecting. createBackend awaits it, so the catch never runs and the MapLibre
// fallback never happens: no map at all, for the life of the page.
test("a failed MapKit load does not kill every map after it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await cutMapNetwork(page);
  await page.goto(URL);
  await openTrack(page);
  await expect.poll(() => mapExists(page), { timeout: 20_000 }).toBe(true);

  for (let entry = 2; entry <= 3; entry++) {
    await page.goBack();
    await page.getByRole("heading", { name: "Tomahawk Test Flight" }).click();
    await expect(page.getByTestId("map-container")).toBeVisible();
    await expect.poll(() => mapExists(page), { timeout: 25_000 }).toBe(true);
  }
});
