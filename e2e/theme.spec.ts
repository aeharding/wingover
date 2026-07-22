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
  await expect(page.getByTestId("map-container")).toHaveAttribute(
    "data-appearance",
    "light",
  );

  // The OS theme flips mid-session: appTheme re-renders and MapCanvas
  // re-creates the backend — no reload involved.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.getByTestId("map-container")).toHaveAttribute(
    "data-appearance",
    "dark",
    { timeout: 10_000 },
  );
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
        getComputedStyle(document.querySelector('[data-testid="armed"] h2')!)
          .color,
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
        tileCyan: style('[data-testid="instrument-agl"]').color,
        chipBg: style('button[aria-label="Track up"]').backgroundColor,
        chipText: style('button[aria-label="Track up"]').color,
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
    page.getByTestId("settings-content").locator('ion-title[size="large"]'),
  ).toHaveText("Settings");
  // The grouped gray lives on the CONTENT (fullscreen, painting under
  // the at-rest transparent toolbar) and the page HOST paints NOTHING:
  // Ionic's large-title transition slides content while page hosts stay
  // parked full-viewport, so an opaque host background covers the
  // entering page's rows for the whole back transition. Regression
  // guard for exactly that.
  const bg = await page.evaluate(() => ({
    host: getComputedStyle(
      document.querySelector('[data-testid="settings-page"]')!,
    ).backgroundColor,
    content: getComputedStyle(
      document.querySelector('[data-testid="settings-content"]')!,
    )
      .getPropertyValue("--background")
      .trim(),
  }));
  expect(bg.host).toBe("rgba(0, 0, 0, 0)");
  expect(bg.content).toBe("#f2f2f7");
});

test("a scheme flip restyles the map IN PLACE: same instance, same camera", async ({
  page,
}) => {
  await page.goto("/plan?map-style=blank");
  const mapEl = page.getByTestId("map-container");
  await expect(mapEl).toBeVisible();

  // The native MapLibre handle (stashed by the adapter). Stamp a probe
  // expando on the instance: if the flip re-created the backend, the
  // successor would not carry it.
  type Handle = HTMLElement & {
    __map?: {
      __probe?: boolean;
      jumpTo(o: { center: [number, number]; zoom: number }): void;
      getCenter(): { lng: number; lat: number };
      getZoom(): number;
    };
  };
  await expect
    .poll(() => mapEl.evaluate((el) => Boolean((el as Handle).__map)))
    .toBe(true);
  await mapEl.evaluate((el) => {
    const m = (el as Handle).__map!;
    m.__probe = true;
    m.jumpTo({ center: [-112.2, 33.9], zoom: 11 });
  });

  // The regression: appearance used to tear the backend down and every
  // page re-framed the fresh map — the pilot's place died with every
  // scheme or street/satellite toggle (satellite forces dark). Appearance
  // is a live restyle now, so the very same instance must survive with
  // its camera untouched.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html(page)).toHaveClass(/ion-palette-dark/);
  await expect(mapEl).toHaveAttribute("data-appearance", "dark");
  const after = await mapEl.evaluate((el) => {
    const m = (el as Handle).__map!;
    const c = m.getCenter();
    return {
      probe: m.__probe === true,
      lng: Number(c.lng.toFixed(4)),
      lat: Number(c.lat.toFixed(4)),
      zoom: Number(m.getZoom().toFixed(2)),
    };
  });
  expect(after).toEqual({ probe: true, lng: -112.2, lat: 33.9, zoom: 11 });
});

test("a provider re-create hands the camera to the successor; pages skip the re-frame", async ({
  page,
}) => {
  // Record a short flight and open its detail map (which frames the
  // track on arrival — the layer that must NOT re-run after a restore).
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();
  await page.getByText("Logbook", { exact: true }).click();
  await page.getByTestId("flight-row").click();
  await expect(page.getByText("Max altitude")).toBeVisible();

  // Wander away from the framed flight (the sim flies near Madison; this
  // is Arizona), stamp the probe, then swap the provider setting — the
  // one path that still re-creates the backend.
  type Handle = HTMLElement & {
    __map?: {
      __probe?: boolean;
      jumpTo(o: { center: [number, number]; zoom: number }): void;
      getCenter(): { lng: number; lat: number };
      getZoom(): number;
    };
  };
  const mapEl = page
    .getByTestId("flight-detail-map")
    .getByTestId("map-container");
  await expect
    .poll(() => mapEl.evaluate((el) => Boolean((el as Handle).__map)))
    .toBe(true);
  await mapEl.evaluate((el) => {
    const m = (el as Handle).__map!;
    m.__probe = true;
    m.jumpTo({ center: [-112.2, 33.9], zoom: 13 });
  });
  await page.evaluate(async () => {
    const specifier = "/src/storage/local.ts";
    const local = (await import(/* @vite-ignore */ specifier)) as {
      setSetting(key: string, value: string): Promise<void>;
    };
    await local.setSetting("mapBackend", "maplibre");
  });

  // A fresh instance (no probe) that inherited the exact camera — and the
  // page skipped its arrival re-frame (a re-frame would fit the track,
  // yanking the camera back to Wisconsin).
  await expect
    .poll(async () =>
      mapEl.evaluate((el) => {
        const m = (el as Handle).__map;
        if (!m) return "recreating";
        const c = m.getCenter();
        return JSON.stringify({
          probe: m.__probe === true,
          lng: Number(c.lng.toFixed(4)),
          lat: Number(c.lat.toFixed(4)),
          zoom: Number(m.getZoom().toFixed(2)),
        });
      }),
    )
    .toBe(JSON.stringify({ probe: false, lng: -112.2, lat: 33.9, zoom: 13 }));
});
