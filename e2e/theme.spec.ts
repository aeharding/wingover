import { expect, test } from "@playwright/test";

// Playwright emulates prefers-color-scheme: light by default; emulateMedia
// flips it live, which is exactly how the OS delivers a theme change.

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
  expect(await rootVar("--ion-color-danger")).toBe("#ff4961");
  expect(await rootVar("--ion-background-color")).toBe("#000000");
});

test("ground map restyles live when the scheme flips", async ({ page }) => {
  await page.goto("/?map-style=blank");
  await page.locator("#tab-button-plan").click();

  // Light scheme -> light basemap (map-light also styles the attribution).
  await expect(page.locator(".map-container")).toHaveClass(/map-light/);

  // The OS theme flips mid-session: useSystemAppearance re-renders and
  // MapCanvas re-creates the backend — no reload involved.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator(".map-container")).not.toHaveClass(/map-light/, {
    timeout: 10_000,
  });
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
  expect(await probes()).toEqual(light);
});

test("settings shows the native large-title header", async ({ page }) => {
  await page.goto("/?map-style=blank");
  await page.locator("#tab-button-settings").click();
  await expect(
    page.locator('.settings-content ion-title[size="large"]'),
  ).toHaveText("Settings");
});
