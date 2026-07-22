import { expect, test } from "@playwright/test";

type Page = import("@playwright/test").Page;

async function openImportedFlight(page: Page) {
  await page.goto("/?map-style=blank");
  await page.locator("#tab-button-logbook").click();
  await page.getByTestId("logbook-options").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import GPX files" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles("e2e/fixtures/flight.gpx");
  await page.getByRole("heading", { name: "Tomahawk Test Flight" }).click();
  await expect(page.getByText("Max altitude")).toBeVisible();
}

// The aircraft glyph rides the HOST map (the fullscreen detail map).
function aircraftDisplay(page: Page) {
  return page
    .getByTestId("flight-detail-map-fullroot")
    .getByTestId("map-container")
    .evaluate(
      (el) =>
        (el as HTMLElement & { __display?: { lng: number; lat: number } })
          .__display ?? null,
    );
}

async function sliderFraction(page: Page) {
  const barogram = page.getByTestId("barogram");
  const now = Number(await barogram.getAttribute("aria-valuenow"));
  const max = Number(await barogram.getAttribute("aria-valuemax"));
  return now / max;
}

test("the fullscreen play button opens the pane playing; scrub and speed follow", async ({
  page,
}) => {
  await openImportedFlight(page);

  // Replay lives behind Expand: no pill on the preview, just the map.
  await expect(page.getByTestId("replay-dock")).toBeHidden();
  await page.getByTestId("map-expand").click();
  await expect(page.getByTestId("flight-detail-map-fullroot")).toBeVisible();
  await page.getByTestId("replay-start").click();
  await expect(page.getByTestId("replay-dock")).toBeVisible();

  // Opened playing: the short fixture plays through and holds at the end.
  await expect.poll(() => sliderFraction(page)).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("replay-play")).toHaveAttribute(
    "aria-label",
    "Replay again",
  );
  const atEnd = await aircraftDisplay(page);
  expect(atEnd).not.toBeNull();

  // Scrub back to mid-flight: the aircraft follows the playhead.
  const box = (await page.getByTestId("barogram").boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.5, y);
  await page.mouse.down();
  await page.mouse.up();
  const mid = await sliderFraction(page);
  expect(mid).toBeGreaterThan(0.3);
  expect(mid).toBeLessThan(0.7);
  const midAt = await aircraftDisplay(page);
  expect(midAt!.lng !== atEnd!.lng || midAt!.lat !== atEnd!.lat).toBe(true);

  // Speed control cycles the ?mock-speed vocabulary.
  await expect(page.getByTestId("replay-speed")).toHaveText("30×");
  await page.getByTestId("replay-speed").click();
  await expect(page.getByTestId("replay-speed")).toHaveText("60×");

  // Shrink: back to the intact detail page, dock gone.
  await page.getByTestId("map-shrink").click();
  await expect(page.getByTestId("flight-detail-map-fullroot")).toBeHidden();
  await expect(page.getByTestId("replay-dock")).toBeHidden();
  await expect(page.getByText("Max altitude")).toBeVisible();
});

test("Expand keeps the map clean; play opens the pane; stop parks; collapse hides", async ({
  page,
}) => {
  await openImportedFlight(page);

  await page.getByTestId("map-expand").click();
  await expect(page.getByTestId("flight-detail-map-fullroot")).toBeVisible();
  // No pane, no glyph — just the map, plus a floating play button.
  await expect(page.getByTestId("replay-dock")).toBeHidden();
  await expect(page.getByTestId("replay-start")).toBeVisible();

  await page.getByTestId("replay-start").click();
  await expect(page.getByTestId("replay-dock")).toBeVisible();
  await expect(page.getByTestId("replay-start")).toBeHidden();
  await expect.poll(() => aircraftDisplay(page)).not.toBeNull();
  await expect.poll(() => sliderFraction(page)).toBeGreaterThan(0);

  // Stop parks in place: pane stays, rewound to the start.
  await page.getByTestId("replay-stop").click();
  await expect(page.getByTestId("replay-dock")).toBeVisible();
  await expect(page.getByTestId("replay-play")).toHaveAttribute(
    "aria-label",
    "Play",
  );
  expect(await sliderFraction(page)).toBe(0);

  // Space is play/pause even with focus parked on the slider by a scrub.
  await page.getByTestId("replay-speed").click(); // 60x
  await page.getByTestId("replay-speed").click(); // 1x, so pause is catchable
  await page.getByTestId("barogram").click();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("replay-play")).toHaveAttribute(
    "aria-label",
    "Pause",
  );
  await page.keyboard.press("Space");
  await expect(page.getByTestId("replay-play")).toHaveAttribute(
    "aria-label",
    "Play",
  );

  // The drawer pull slides the pane away; the play button returns.
  await page.getByTestId("replay-collapse").click();
  await expect(page.getByTestId("replay-dock")).toBeHidden();
  await expect(page.getByTestId("replay-start")).toBeVisible();
});

// Record a multi-minute flight fast: ~360s of sim time in ~1.5s wall.
async function recordLongFlight(page: Page) {
  await page.goto("/?mock-speed=240&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();
}

function barogramTotal(page: Page) {
  return page
    .getByTestId("barogram")
    .getAttribute("aria-valuemax")
    .then(Number);
}

test("trim rewrites the recording; the cut survives a reload", async ({
  page,
}) => {
  await recordLongFlight(page);
  await page.getByText("Logbook", { exact: true }).click();
  await page.getByTestId("flight-row").click();
  await expect(page.getByText("Max altitude")).toBeVisible();

  // The sheet opens the clip editor straight into the fullscreen pane.
  await page.getByTestId("detail-options").click();
  await page.getByRole("button", { name: "Trim start" }).click();
  await expect(page.getByTestId("flight-detail-map-fullroot")).toBeVisible();
  await expect(page.getByTestId("clip-dock")).toBeVisible();
  const before = await barogramTotal(page);
  expect(before).toBeGreaterThan(120);

  // The scrub IS the control: drag the cut point to ~40% of the flight.
  // The bracket mark rides along and the host slider tracks the cut.
  const chart = (await page.getByTestId("barogram").boundingBox())!;
  const y = chart.y + chart.height / 2;
  await page.mouse.move(chart.x + chart.width * 0.05, y);
  await page.mouse.down();
  await page.mouse.move(chart.x + chart.width * 0.4, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("clip-mark-start")).toBeAttached();
  const nowAfterScrub = Number(
    await page.getByTestId("barogram").getAttribute("aria-valuenow"),
  );
  expect(nowAfterScrub).toBeGreaterThan(0);

  // The bracket itself is directly draggable too (the cursor grab zone
  // rides it): pull the cut further in by grabbing the mark.
  const cursor = (await page.getByTestId("timeline-cursor").boundingBox())!;
  const cy = cursor.y + cursor.height / 2;
  await page.mouse.move(cursor.x + cursor.width / 2, cy);
  await page.mouse.down();
  await page.mouse.move(cursor.x + cursor.width / 2 + chart.width * 0.1, cy, {
    steps: 4,
  });
  await page.mouse.up();
  expect(
    Number(await page.getByTestId("barogram").getAttribute("aria-valuenow")),
  ).toBeGreaterThan(nowAfterScrub);

  // Trim… presents the Ionic confirm ABOVE the fullscreen pane (the
  // fullroot lives inside ion-app's stacking context on purpose) — the
  // click itself proves the alert is not buried under the overlay.
  await page.getByTestId("clip-apply").click();
  const alert = page.locator("ion-alert:not(.overlay-hidden)");
  await expect(alert).toContainText("will be removed from the start");
  await alert.getByRole("button", { name: "Trim" }).click();

  // The pane exits into parked playback of the shorter recording.
  await expect(page.getByTestId("replay-dock")).toBeVisible();
  await expect.poll(() => barogramTotal(page)).toBeLessThan(before - 30);

  // The cut fixes are GONE from storage, not windowed: a fresh load reads
  // the same shorter track.
  await page.reload();
  await expect(page.getByText("Max altitude")).toBeVisible();
  await page.getByTestId("map-expand").click();
  await page.getByTestId("replay-start").click();
  await expect(page.getByTestId("replay-dock")).toBeVisible();
  expect(await barogramTotal(page)).toBeLessThan(before - 30);
});

test("split turns one flight into two", async ({ page }) => {
  await recordLongFlight(page);
  await page.getByText("Logbook", { exact: true }).click();
  await expect(page.getByTestId("flight-row")).toHaveCount(1);
  await page.getByTestId("flight-row").click();
  await expect(page.getByText("Max altitude")).toBeVisible();

  await page.getByTestId("detail-options").click();
  await page.getByRole("button", { name: "Split flight" }).click();
  await expect(page.getByTestId("clip-dock")).toBeVisible();
  // The split knob parks mid-flight; both halves already clear the
  // floor, so Split… is armed as-is.
  await expect(page.getByTestId("clip-mark-point")).toBeAttached();
  await expect(page.getByTestId("clip-preview")).toContainText("+");

  await page.getByTestId("clip-apply").click();
  const alert = page.locator("ion-alert:not(.overlay-hidden)");
  await expect(alert).toContainText("The recording becomes two flights.");
  await alert.getByRole("button", { name: "Split" }).click();
  await expect(page.getByTestId("replay-dock")).toBeVisible();

  // Back out: the logbook now holds both halves.
  await page.getByTestId("map-shrink").click();
  // #root-scoped: Ionic parks a hidden back-button clone on document.body
  // once a large-title page (the fly frame) has rendered, so a bare
  // ion-back-button locator matches two.
  await page.locator("#root ion-back-button").click();
  await expect(page.getByTestId("flight-row")).toHaveCount(2);
});

test("the timeline zooms with the wheel and resets", async ({ page }) => {
  // The 11s fixture is below the minimum zoom window; record ~40s instead.
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();

  await page.getByText("Logbook", { exact: true }).click();
  await page.getByTestId("flight-row").click();
  await expect(page.getByText("Max altitude")).toBeVisible();
  await page.getByTestId("map-expand").click();
  await page.getByTestId("replay-start").click();

  const barogram = page.getByTestId("barogram");
  await expect(barogram).toBeVisible();
  await expect(barogram).toHaveAttribute("data-zoomed", "false");

  const box = (await barogram.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Poll with repeated wheel input: a single event can land in the gap
  // before the (post-paint) wheel listener attaches.
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, -300);
      return barogram.getAttribute("data-zoomed");
    })
    .toBe("true");
  await expect(page.getByTestId("barogram-overview")).toBeVisible();

  // Park playback first: a live playhead advances aria-valuenow on its
  // own, which would muddy the no-scrub assertion below. (The rewind also
  // exercises seek-follow: the zoomed window trails the playhead home.)
  await page.getByTestId("replay-stop").click();
  await expect(page.getByTestId("replay-play")).toHaveAttribute(
    "aria-label",
    "Play",
  );

  // Zoomed, a drag GRABS the timeline: the window pans (the overview
  // slice moves) and the playhead does NOT scrub.
  const overviewWindow = page.getByTestId("barogram-overview-window");
  const windowBefore = await overviewWindow.evaluate((el) => el.style.left);
  const playheadBefore = await barogram.getAttribute("aria-valuenow");
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  expect(await overviewWindow.evaluate((el) => el.style.left)).not.toBe(
    windowBefore,
  );
  expect(await barogram.getAttribute("aria-valuenow")).toBe(playheadBefore);

  await page.getByTestId("timeline-reset").click();
  await expect(barogram).toHaveAttribute("data-zoomed", "false");
});
