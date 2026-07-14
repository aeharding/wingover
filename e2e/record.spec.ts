import { expect, test } from "@playwright/test";

test("arm, auto-takeoff, reload kill drill, stop, logbook", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();

  await expect(page.getByTestId("armed")).toBeVisible();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("ion-tab-bar")).toBeHidden();
  await expect(page.locator(".map-container")).toBeVisible();
  await expect(page.locator("[data-aircraft-layer='true']")).toBeVisible();
  await expect(page.getByTestId("instrument-duration")).not.toHaveText("0:00");
  // The direction-to-launch arrow renders as the blue location chevron.
  await expect(page.locator(".launch-arrow-svg")).toBeVisible();

  // Style regression guard: the fly page must not scroll — the scrollbar
  // lives in ion-content's shadow DOM inner-scroll, which document-level
  // overflow checks cannot see. (Attribution styling is a MapLibre-render
  // concern, verified in maplibre.spec.ts.)
  const innerScrollOverflowY = await page.evaluate(
    () =>
      getComputedStyle(
        document
          .querySelector("ion-content.fly-content")!
          .shadowRoot!.querySelector(".inner-scroll")!,
      ).overflowY,
  );
  expect(innerScrollOverflowY).toBe("hidden");

  await page.getByRole("button", { name: "Track up" }).click();
  await expect(page.getByRole("button", { name: "Track up" })).toHaveAttribute(
    "data-active",
    "true",
  );

  await page.waitForTimeout(1000);
  await page.goto("/?mock-speed=40&map-style=blank");

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

  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("ion-tab-bar")).toBeVisible();

  await page.getByText("Logbook", { exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Flight / })).toBeVisible();
  await expect(page.getByText(/1 flights/)).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("the idle screen shows the sunset backdrop and starts a flight", async ({
  page,
}) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  const start = page.getByRole("button", { name: "Start Flight" });
  await expect(start).toBeVisible({ timeout: 10_000 });
  // The decorative backdrop renders and does NOT block the CTA
  // (pointer-events: none) — the click still arms a flight.
  await expect(page.locator(".fly-idle-art")).toBeVisible();
  await start.click();
  await expect(page.getByTestId("armed")).toBeVisible();
});

test("canceling while acquiring GPS discards the session", async ({ page }) => {
  await page.goto("/?mock-speed=2&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();

  await expect(page.getByTestId("armed")).toBeVisible();
  await expect(page.getByText("Acquiring GPS")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  // A stray Cancel tap only opens the same end-flight confirm; the
  // discard needs the explicit second tap, so a missed launch can't
  // happen by accident.
  await page
    .locator("ion-alert")
    .getByRole("button", { name: "Stop" })
    .click();

  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();

  await page.getByText("Logbook", { exact: true }).click();
  await expect(page.getByText("No flights yet.")).toBeVisible();
});

test("dismissing the cancel confirmation keeps waiting for takeoff", async ({
  page,
}) => {
  await page.goto("/?mock-speed=2&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();

  await expect(page.getByTestId("armed")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  // Dismiss the confirm — scope to the alert, since the acquiring screen's
  // own button carries the same "Cancel" label.
  await page
    .locator("ion-alert")
    .getByRole("button", { name: "Cancel" })
    .click();

  // The session survives the mistap: still armed, not discarded to idle.
  await expect(page.getByTestId("armed")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).not.toBeVisible();
});

test("canceling the stop confirmation keeps recording", async ({ page }) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();

  await expect(page.getByTestId("recording")).toBeVisible();
  await expect(page.getByTestId("instrument-duration")).not.toHaveText("0:00");
});

test("a two-hour flight lands itself and reaches the logbook hands-free", async ({
  page,
}) => {
  await page.goto("/?mock-speed=6000&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  // The simulated pilot stops in place after two hours of flight; landing
  // detection, the fix-time grace, finalization, and collection all run
  // with zero interaction.
  await expect(page.getByText("Flight saved to logbook")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "Start Flight" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator("ion-tab-bar")).toBeVisible();
});

test("zoom control zooms one-fingered from anywhere without unpinning follow", async ({
  page,
}) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });

  const control = page.getByRole("slider", { name: "Zoom" });
  await expect(control).toBeVisible();
  // Bounds are ground spans, not tile-stack limits: ~30 mi and ~0.35 mi
  // across the screen (both latitude/viewport dependent).
  const valuemin = async () =>
    Number(await control.getAttribute("aria-valuemin"));
  const valuemax = async () =>
    Number(await control.getAttribute("aria-valuemax"));
  const valuenow = async () =>
    Number(await control.getAttribute("aria-valuenow"));
  expect(await valuemin()).toBeGreaterThan(8.5);
  expect(await valuemin()).toBeLessThan(11);
  expect(await valuemax()).toBeGreaterThan(15);
  expect(await valuemax()).toBeLessThan(18);
  const before = await valuenow();

  // The gauge (thumb + end caps) is hidden at rest and appears ONLY while
  // dragging — nothing on the map while flying. Its thumb is positioned by
  // the current zoom via an inline `top` percent.
  await expect(control).not.toHaveClass(/active/);
  const thumbTopPct = async () =>
    parseFloat(
      await page
        .locator(".zoom-gauge-thumb")
        .evaluate((el) => (el as HTMLElement).style.top),
    );
  const thumbBefore = await thumbTopPct();

  // Relative drag: press anywhere in the zone (off-center) and drag DOWN
  // to zoom in. No thumb to hit — the start point does not matter.
  const box = (await control.boundingBox())!;
  // The zone hugs the right edge of the screen (the edge-slide gesture).
  const viewport = page.viewportSize()!;
  expect(box.x + box.width).toBeGreaterThanOrEqual(viewport.width - 1);
  expect(box.width).toBeLessThan(viewport.width * 0.2);
  const downX = box.x + box.width * 0.6;
  await page.mouse.move(downX, box.y + 20);
  await page.mouse.down();
  await expect(control).toHaveClass(/active/); // gauge appears on touch
  await page.mouse.move(downX, box.y + 150, { steps: 8 });
  await page.mouse.up();
  await expect(control).not.toHaveClass(/active/); // hidden again on release

  await expect.poll(valuenow).toBeGreaterThan(before);
  // The thumb rides down toward the fully-in cap as we zoom in.
  expect(await thumbTopPct()).toBeGreaterThan(thumbBefore);
  // Dragging the control is not a map drag: follow must stay pinned.
  await expect(
    page.getByRole("button", { name: "Follow aircraft" }),
  ).toHaveAttribute("data-active", "true");

  // Dragging UP from a fresh grab zooms back out (relative each time).
  const zoomedIn = await valuenow();
  const upX = box.x + box.width * 0.4;
  await page.mouse.move(upX, box.y + box.height - 10);
  await page.mouse.down();
  await page.mouse.move(upX, box.y + box.height - 140, { steps: 8 });
  await page.mouse.up();
  await expect.poll(valuenow).toBeLessThan(zoomedIn);
});

test("edge guards stop an edge swipe from panning, inland drag still pans", async ({
  page,
}) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });

  const follow = page.getByRole("button", { name: "Follow aircraft" });
  await expect(follow).toHaveAttribute("data-active", "true");

  const map = (await page.locator(".live-map").boundingBox())!;
  // A swipe from the very bottom edge lands on the guard, not the map: the
  // map must not pan, so follow stays pinned (the iOS app-switch swipe).
  await page.mouse.move(map.x + map.width / 2, map.y + map.height - 3);
  await page.mouse.down();
  await page.mouse.move(map.x + map.width / 2 - 160, map.y + map.height - 3, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(follow).toHaveAttribute("data-active", "true");

  // A normal inland drag still pans, which unpins follow.
  await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);
  await page.mouse.down();
  await page.mouse.move(map.x + map.width / 2 - 140, map.y + map.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(follow).toHaveAttribute("data-active", "false");
});
