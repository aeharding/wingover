import { expect, test } from "@playwright/test";

// The FAA sectional layer, end to end in a browser that cannot decode JXL.
//
// ?vfr= pins a tile template and is read BEFORE the codec gate, so a run
// that pins one is testing the chart path rather than the browser's codec
// list. The template must live on the chart host or on the app's own
// origin — a foreign one is refused — so these serve fixture tiles from
// the dev server and let the offline guard abort everything else.
const TEMPLATE = "/vfr-fixture/{z}/{x}/{y}.png";

// A 1x1 opaque PNG. What is IN the tile does not matter; that one was
// asked for at all is the whole assertion.
const TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test.beforeEach(async ({ page, baseURL }) => {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.includes("/vfr-fixture/")) {
      return route.fulfill({ contentType: "image/png", body: TILE });
    }
    if (baseURL && url.startsWith(baseURL)) return route.continue();
    return route.abort();
  });
});

test("a pinned sectional joins the view cycle and draws", async ({ page }) => {
  const tiles: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/vfr-fixture/")) tiles.push(request.url());
  });

  await page.goto(`/?map-style=blank&vfr=${encodeURIComponent(TEMPLATE)}`);
  await page.getByText("Plan", { exact: true }).click();
  await expect(page.getByTestId("map-container")).toBeVisible();

  // With no MapTiler key the cycle is street + chart, so the first press
  // is the sectional. The button is labelled with the view it goes TO.
  const toggle = page.getByRole("button", { name: "Sectional chart view" });
  await expect(toggle).toBeVisible();
  await toggle.click();

  await expect(() => expect(tiles.length).toBeGreaterThan(0)).toPass({
    timeout: 10_000,
  });
  // Off chart view the layer goes with it, so nothing keeps fetching.
  await page.getByRole("button", { name: "Street view" }).click();
  const settled = tiles.length;
  await page.waitForTimeout(1000);
  expect(tiles.length).toBe(settled);
});

test("the sectional is there in flight, where it is navigated by", async ({
  page,
}) => {
  const tiles: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/vfr-fixture/")) tiles.push(request.url());
  });

  await page.goto(
    `/?mock-speed=40&map-style=blank&vfr=${encodeURIComponent(TEMPLATE)}`,
  );
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });

  const toggle = page.getByRole("button", { name: "Sectional chart view" });
  await expect(toggle).toBeVisible();
  await toggle.click();

  await expect(() => expect(tiles.length).toBeGreaterThan(0)).toPass({
    timeout: 10_000,
  });
});

test("a sectional pinned to a foreign host is refused", async ({ page }) => {
  // Requests TO the foreign host, not the navigation that names it in its
  // query string.
  const foreign: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://evil.example")) {
      foreign.push(request.url());
    }
  });

  const hostile = encodeURIComponent("https://evil.example/{z}/{x}/{y}.png");
  await page.goto(`/?map-style=blank&vfr=${hostile}`);
  await page.getByText("Plan", { exact: true }).click();
  await expect(page.getByTestId("map-container")).toBeVisible();

  // No chart resolved, so the mode never joins the cycle. With no MapTiler
  // key that leaves one view, and a toggle with nothing to toggle to is
  // not rendered at all.
  await expect(
    page.getByRole("button", { name: "Sectional chart view" }),
  ).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(foreign).toEqual([]);
});
