import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("http://localhost:5173")) return route.continue();
    return route.abort();
  });
});

test("tap to drop pins, persist across reload, tap to delete", async ({
  page,
}) => {
  await page.goto("/?map-style=blank");
  await page.getByText("Plan", { exact: true }).click();

  const canvas = page.locator(".map-container");
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(500);

  const box = (await canvas.boundingBox())!;
  for (const [x, y] of [
    [150, 300],
    [250, 400],
  ]) {
    await page.mouse.move(box.x + x, box.y + y);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
  }

  await expect(page.getByTestId("pin-marker")).toHaveCount(2);

  // Two pins connect into an ordered route line.
  const mapContainer = page.locator(".map-container");
  await expect(mapContainer).not.toHaveAttribute("data-route-coords", "");
  const routeBefore = await mapContainer.getAttribute("data-route-coords");
  expect(routeBefore!.split(";")).toHaveLength(2);

  // Two pins → the route distance shows for planning.
  await expect(page.getByTestId("plan-distance")).toContainText("Route:");

  await canvas.click({ position: { x: 60, y: 200 } });
  await expect(page.getByTestId("pin-marker")).toHaveCount(2);

  await page.goto("/?map-style=blank");
  await page.getByText("Plan", { exact: true }).click();
  await expect(page.getByTestId("pin-marker")).toHaveCount(2);

  // The route survives reload in the same order (creation order).
  await expect(mapContainer).toHaveAttribute("data-route-coords", routeBefore!);

  await page.getByTestId("pin-marker").first().click();
  await expect(page.getByTestId("pin-marker")).toHaveCount(1);

  // One pin is no route.
  await expect(mapContainer).toHaveAttribute("data-route-coords", "");
  await expect(page.getByTestId("plan-distance")).toHaveCount(0);

  await page.getByTestId("pin-marker").click();
  await expect(page.getByTestId("pin-marker")).toHaveCount(0);
});

// ── the ground-map compass, driven by REAL rotation gestures ─────────────
// The map must hold whatever rotation the gesture leaves (no snap-back to
// north on release), and the compass must appear rotated, track the bearing,
// and re-north on tap. Programmatic setBearing would skip the whole gesture
// pipeline — the original compass test did exactly that and missed MapKit's
// low-zoom rotation lock — so these drive the pointer/touch paths for real.

function readBearing(page: Page): Promise<number> {
  return page.evaluate(() =>
    (
      document.querySelector(".map-container") as HTMLElement & {
        __map?: { getBearing(): number };
      }
    ).__map!.getBearing(),
  );
}

// Signed smallest angle from north, matching the compass's own math.
function offNorth(bearing: number): number {
  return ((((bearing + 180) % 360) + 360) % 360) - 180;
}

async function openPlanMap(page: Page) {
  await page.goto("/?map-style=blank");
  await page.getByText("Plan", { exact: true }).click();
  const canvas = page.locator(".map-container");
  await expect(canvas).toBeVisible();
  // North-up: no compass.
  await expect(page.getByTestId("map-compass")).toHaveCount(0);
  // The backend resolves async; wait for the adapter to stash the live map.
  await page.waitForFunction(
    () =>
      !!(
        document.querySelector(".map-container") as HTMLElement & {
          __map?: unknown;
        }
      )?.__map,
  );
  const box = (await canvas.boundingBox())!;
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

async function expectCompassMatchesAndRenorths(page: Page) {
  const compass = page.getByTestId("map-compass");
  await expect(compass).toBeVisible();

  // The needle mirrors the live bearing (rotate(-bearing)).
  const held = await readBearing(page);
  const needleDeg = await compass
    .locator("svg")
    .evaluate((el) =>
      Number(/rotate\((-?[\d.]+)deg\)/.exec(el.style.transform)?.[1]),
    );
  expect(Math.abs(offNorth(needleDeg + held))).toBeLessThan(2);

  // Tap: eases back to north and the compass goes away.
  await compass.click();
  await expect.poll(() => readBearing(page)).toBe(0);
  await expect(compass).toHaveCount(0);
}

test("drag-rotating holds the rotation; the compass tracks and re-norths", async ({
  page,
}) => {
  const { cx, cy } = await openPlanMap(page);

  // Right-button drag in an arc around the center — MapLibre's desktop
  // rotate gesture.
  await page.mouse.move(cx + 100, cy);
  await page.mouse.down({ button: "right" });
  for (let i = 1; i <= 12; i++) {
    const a = (i / 12) * (Math.PI / 2);
    await page.mouse.move(cx + 100 * Math.cos(a), cy + 100 * Math.sin(a));
    await page.waitForTimeout(20);
  }
  // Hold still before release so no inertia keeps turning the camera.
  await page.waitForTimeout(200);
  await page.mouse.up({ button: "right" });

  // The rotation STICKS: well past maplibre's 7° north-snap, unchanged after
  // a settle beat.
  await page.waitForTimeout(400);
  const held = await readBearing(page);
  expect(Math.abs(offNorth(held))).toBeGreaterThan(30);
  await page.waitForTimeout(300);
  expect(await readBearing(page)).toBeCloseTo(held, 5);

  await expectCompassMatchesAndRenorths(page);
});

test("a two-finger twist holds the rotation; the compass tracks and re-norths", async ({
  page,
}) => {
  const { cx, cy } = await openPlanMap(page);

  // Two opposed touch points twisting around the center (CDP: the chromium
  // project is the only one configured, so the session is always available).
  const cdp = await page.context().newCDPSession(page);
  const touches = (a: number) =>
    [a, a + Math.PI].map((angle, id) => ({
      x: cx + 80 * Math.cos(angle),
      y: cy + 80 * Math.sin(angle),
      id,
    }));
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: touches(0),
  });
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    const a = (i / steps) * (70 * (Math.PI / 180));
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: touches(a),
    });
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(200);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });

  // Sticks after release (the twist's first ~15° arms maplibre's rotation
  // threshold, so the held angle is well short of 70° — but must be well
  // past the 7° north-snap).
  await page.waitForTimeout(400);
  const held = await readBearing(page);
  expect(Math.abs(offNorth(held))).toBeGreaterThan(20);
  await page.waitForTimeout(300);
  expect(await readBearing(page)).toBeCloseTo(held, 5);

  await expectCompassMatchesAndRenorths(page);
});
