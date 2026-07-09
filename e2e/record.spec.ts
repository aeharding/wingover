import { expect, test } from "@playwright/test";

test("arm, auto-takeoff, reload kill drill, stop, logbook", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto("/?mock-speed=40&map-style=blank&hold-ms=300");
  await page.getByRole("button", { name: "Start Flight" }).click();

  await expect(page.getByTestId("armed")).toBeVisible();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("ion-tab-bar")).toBeHidden();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await expect(page.locator("[data-aircraft-layer='true']")).toBeVisible();
  await expect(page.getByTestId("instrument-duration")).not.toHaveText("0:00");

  await page.getByRole("button", { name: "Track up" }).click();
  await expect(page.getByRole("button", { name: "Track up" })).toHaveAttribute(
    "data-active",
    "true",
  );

  await page.waitForTimeout(1000);
  await page.goto("/?mock-speed=40&map-style=blank&hold-ms=300");

  await expect(page.getByTestId("recording")).toBeVisible();
  await expect(page.getByRole("button", { name: "Track up" })).toHaveAttribute(
    "data-active",
    "true",
  );
  const rehydrated = await page
    .getByTestId("instrument-duration")
    .textContent();
  expect(rehydrated).not.toBe("0:00");
  expect(rehydrated).not.toBeNull();

  const stopButton = page.getByRole("button", { name: /hold to stop/i });
  await stopButton.hover();
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();

  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();
  await expect(page.locator("ion-tab-bar")).toBeVisible();

  await page.getByText("Logbook", { exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Flight / })).toBeVisible();
  await expect(page.getByText(/1 flights/)).toBeVisible();

  // CSS cascade guards: import sorting once put theme.css before Ionic's
  // css and MapView.css before maplibre's, resurfacing the attribution
  // background and a 1px document scrollbar.
  const cascade = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    overflowY: document.documentElement.scrollHeight - window.innerHeight,
    attribBackground: getComputedStyle(
      document.querySelector(".maplibregl-ctrl-attrib")!,
    ).backgroundColor,
  }));
  expect(cascade.overflowX).toBe(0);
  expect(cascade.overflowY).toBe(0);
  expect(cascade.attribBackground).toBe("rgba(0, 0, 0, 0)");

  expect(pageErrors).toEqual([]);
});

test("live map survives a slow-loading style", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await page.route("**/tiles.openfreemap.org/styles/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        version: 8,
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#222" },
          },
        ],
      }),
    });
  });
  await page.route("**/api.maptiler.com/**", (route) => route.abort());

  await page.goto("/?mock-speed=40&hold-ms=300");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-aircraft-layer='true']")).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(1500);
  expect(pageErrors).toEqual([]);
});

test("canceling while acquiring GPS discards the session", async ({ page }) => {
  await page.goto("/?mock-speed=2&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();

  await expect(page.getByTestId("armed")).toBeVisible();
  await expect(page.getByText("Acquiring GPS")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();

  await page.getByText("Logbook", { exact: true }).click();
  await expect(page.getByText("No flights yet.")).toBeVisible();
});

test("interrupting the hold does not stop the recording", async ({ page }) => {
  await page.goto("/?mock-speed=40&map-style=blank&hold-ms=5000");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });

  const stopButton = page.getByRole("button", { name: /hold to stop/i });
  await stopButton.hover();
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();

  await expect(page.getByTestId("recording")).toBeVisible();
});
