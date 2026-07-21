import { expect, test } from "@playwright/test";

// Playwright emulates prefers-color-scheme: light by default. The palette
// is CLASS-driven (appTheme.ts stamps ion-palette-dark on <html> from the
// system scheme OR the global satellite view), so a flip lands one JS
// listener after emulateMedia — assertions on the flipped state poll.

const html = (page: import("@playwright/test").Page) => page.locator("html");

test("classic palette and Ionic base vars follow the system scheme", async ({
  page,
}) => {
  await page.goto("/?map-style=blank");

  const rootVar = (name: string) =>
    page.evaluate(
      (prop) =>
        getComputedStyle(document.documentElement)
          .getPropertyValue(prop)
          .trim(),
      name,
    );

  // Classic (pre-Ionic-8) danger, not the v8 "accessible" recolors.
  expect(await rootVar("--ion-color-danger")).toBe("#eb445a");
  // Ionic never declares the light background/text vars itself; theme.css
  // must, or bare var() consumers (the sync sheet's hero scrim) collapse
  // to transparent. Empty string here = that bug is back.
  expect(await rootVar("--ion-background-color")).toBe("#ffffff");
  expect(await rootVar("--ion-text-color")).toBe("#000000");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html(page)).toHaveClass(/ion-palette-dark/);
  expect(await rootVar("--ion-color-danger")).toBe("#ff4961");
  expect(await rootVar("--ion-background-color")).toBe("#000000");
});

test("ground map restyles live when the scheme flips", async ({ page }) => {
  await page.goto("/?map-style=blank");
  await page.locator("#tab-button-plan").click();

  // Light scheme -> light basemap (map-light also styles the attribution).
  await expect(page.locator(".map-container")).toHaveClass(/map-light/);

  // The OS theme flips mid-session: appTheme re-renders and MapCanvas
  // re-creates the backend — no reload involved.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator(".map-container")).not.toHaveClass(/map-light/, {
    timeout: 10_000,
  });
});

test("satellite forces the dark palette app-wide", async ({ page }) => {
  await page.goto("/?map-style=blank");
  await expect(html(page)).not.toHaveClass(/ion-palette-dark/);

  // The street/satellite choice is ONE global persistent setting; flip it
  // the way any ground map's toggle does and the whole app goes dark —
  // imagery is a dark surface (the Apple Maps behavior).
  const setMapView = (value: string) =>
    page.evaluate(async (view) => {
      const specifier = "/src/storage/local.ts";
      const local = (await import(/* @vite-ignore */ specifier)) as {
        setSetting(key: string, value: string): Promise<void>;
      };
      await local.setSetting("mapView", view as string);
    }, value);

  await setMapView("satellite");
  await expect(html(page)).toHaveClass(/ion-palette-dark/);

  await setMapView("street");
  await expect(html(page)).not.toHaveClass(/ion-palette-dark/);
});

test("the in-flight surface renders identically in both schemes", async ({
  page,
}) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();

  // Armed: the heading owns its color (in light it would otherwise
  // inherit body's black onto the black surface — invisible).
  await expect(page.getByTestId("armed")).toBeVisible();
  const armedColor = () =>
    page.evaluate(
      () =>
        getComputedStyle(document.querySelector(".armed-message h2")!).color,
    );
  expect(await armedColor()).toBe("rgb(255, 255, 255)");

  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });

  // The frozen sunlight design: the bright flight cyan (NOT the deepened
  // light-scheme ground accent — --stat-cyan must be re-declared on the
  // surface, not just its dependency), and dark map chips on the always-
  // light live map.
  const probes = () =>
    page.evaluate(() => {
      const style = (selector: string) =>
        getComputedStyle(document.querySelector(selector)!);
      return {
        tileCyan: style(".tile.cyan .value").color,
        chipBg: style(".fly-content .map-button").backgroundColor,
        chipText: style(".fly-content .map-button").color,
      };
    });

  const light = await probes();
  expect(light.tileCyan).toBe("color(display-p3 0.32 0.8 1)");
  expect(light.chipBg).toBe("rgba(24, 26, 29, 0.9)");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html(page)).toHaveClass(/ion-palette-dark/);
  expect(await probes()).toEqual(light);
});

test("settings shows the large-title header on a grouped page", async ({
  page,
}) => {
  await page.goto("/?map-style=blank");
  await page.locator("#tab-button-settings").click();
  await expect(
    page.locator('.settings-content ion-title[size="large"]'),
  ).toHaveText("Settings");
  // The page ELEMENT paints the grouped gray: with the large-title
  // pattern the toolbar background sits at opacity 0 at rest, so an
  // unpainted page would show body's white through it as a strip.
  const pageBg = await page.evaluate(
    () =>
      getComputedStyle(document.querySelector(".settings-page")!)
        .backgroundColor,
  );
  expect(pageBg).toBe("rgb(242, 242, 247)");
});
