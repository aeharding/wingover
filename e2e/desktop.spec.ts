import { expect, test } from "@playwright/test";

// The suite's default viewport is a phone (playwright.config.ts), which is
// exactly what keeps every other spec on the phone layout. This file opts
// into a laptop-sized window to exercise the rail + split layout.
test.use({ viewport: { width: 1280, height: 800 } });

test("a plain browser hides Fly and lands on the logbook", async ({ page }) => {
  // No ?mock-speed: this is a real browser visitor, not the e2e engine seam.
  await page.goto("/?map-style=blank");
  // The index redirect now carries the query string across (it is ?mock-speed
  // that must survive in general), so the landing URL keeps ?map-style here.
  await expect(page).toHaveURL(/\/logbook(\?|$)/);
  await expect(page.getByTestId("rail-logbook")).toBeVisible();
  await expect(page.getByTestId("rail-fly")).toHaveCount(0);
  // Empty logbook in a browser is the connect funnel, not a dead end.
  await expect(page.getByTestId("funnel-signin")).toBeVisible();
  await expect(page.getByTestId("funnel-import")).toBeVisible();
});

test("the brand logo goes to the landing/marketing page", async ({ page }) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  await expect(page.getByTestId("rail-brand")).toHaveAttribute("href", "/");

  await page.getByTestId("rail-brand").click();

  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/$/);
  await expect(page.getByRole("link", { name: /open app/i })).toBeVisible();
  await expect(page.getByTestId("rail-logbook")).toHaveCount(0);
});

test("the PWA start_url /home resolves to the app home, carrying the query", async ({
  page,
}) => {
  await page.goto("/home?map-style=blank");
  await expect(page).toHaveURL(/\/logbook\?map-style=blank/);
  await expect(page.getByTestId("rail-logbook")).toBeVisible();
});

test("the logbook splits: list stays while the flight shows", async ({
  page,
}) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();

  await page.getByTestId("rail-logbook").click();
  // The pane's totals strip.
  await expect(page.getByText("Airtime")).toBeVisible();

  await page.locator(".flight-row").first().click();
  await expect(page).toHaveURL(/\/logbook\/recorded-/);
  // Split: the list (totals strip) and the detail (stats) share the screen.
  await expect(page.getByText("Airtime")).toBeVisible();
  await expect(page.getByText("Max altitude")).toBeVisible();
  // No back button in the split; the list IS the navigation.
  await expect(page.locator("#root ion-back-button")).toHaveCount(0);
});

test("selection swaps the seat without remounting the list or the map", async ({
  page,
}) => {
  // Two flights, so there is something to flip between.
  await page.goto("/?mock-speed=40&map-style=blank");
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Start Flight" }).click();
    await expect(page.getByTestId("recording")).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Stop flight" }).click();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Start Flight" }),
    ).toBeVisible();
  }

  await page.getByTestId("rail-logbook").click();
  const rows = page.locator(".flight-row");
  await rows.first().click();
  await expect(page).toHaveURL(/\/logbook\/recorded-/);
  const firstUrl = page.url();

  // Tag the live map AND the stats card; if either remounts on selection,
  // its tag dies with it.
  await page
    .locator(".seat-map .map-container")
    .evaluate((el) => el.setAttribute("data-alive", "1"));
  await page
    .locator(".seat-card")
    .evaluate((el) => el.setAttribute("data-alive", "1"));

  await rows.nth(1).click();
  await expect(page).not.toHaveURL(firstUrl);
  // Arrow keys walk the list too: up returns to the first flight.
  await page.keyboard.press("ArrowUp");
  await expect(page).toHaveURL(firstUrl);
  await page.keyboard.press("ArrowDown");
  await expect(page).not.toHaveURL(firstUrl);
  // Same elements, still tagged: the seat swapped data, not DOM.
  await expect(
    page.locator('.seat-map .map-container[data-alive="1"]'),
  ).toBeVisible();
  await expect(page.locator('.seat-card[data-alive="1"]')).toBeVisible();
});

test("the list pane resizes by its edge and remembers the width", async ({
  page,
}) => {
  await page.goto("/?map-style=blank");
  const pane = page.locator(".logbook-pane");
  await expect(pane).toBeVisible();
  const before = (await pane.boundingBox())!.width;

  const handle = page.getByTestId("pane-resizer");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 103, box.y + 300, { steps: 5 });
  await page.mouse.up();
  const after = (await pane.boundingBox())!.width;
  expect(Math.round(after - before)).toBe(100);

  // Persisted per device: a fresh load keeps the chosen width.
  await page.reload();
  await expect(pane).toBeVisible();
  expect((await pane.boundingBox())!.width).toBe(after);
});

test("the rail sync chip opens a menu, and the sheet sits behind it", async ({
  page,
}) => {
  await page.goto("/?map-style=blank");
  await page.getByTestId("rail-sync").click();
  // Off: status plus the setup door, and nothing to log out of.
  await expect(page.getByTestId("rail-sync-manage")).toContainText("Log In");
  await expect(page.getByTestId("rail-sync-logout")).toHaveCount(0);
  // Nothing recorded either, so no local data to offer deleting.
  await expect(page.getByTestId("rail-sync-erase")).toHaveCount(0);
  await expect(page.locator("ion-popover")).toContainText("Sync: Off");
  await page.getByTestId("rail-sync-manage").click();
  await expect(page.getByTestId("sync-headline")).toBeVisible();
});

test("sync-off local flights can be erased from the chip menu, in place", async ({
  page,
}) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();

  await page.evaluate(() => document.body.setAttribute("data-no-reload", "1"));
  await page.getByTestId("rail-sync").click();
  await page.getByTestId("rail-sync-erase").click();
  const alert = page.locator("ion-alert:not(.overlay-hidden)");
  await expect(alert).toContainText("nothing is backed up");
  await alert.getByRole("button", { name: "Delete" }).click();

  // The store reset in place: the logbook empties to the funnel, the menu
  // item retires, and the document never reloaded.
  await page.getByTestId("rail-logbook").click();
  await expect(page.getByTestId("funnel-import")).toBeVisible();
  await page.getByTestId("rail-sync").click();
  await expect(page.getByTestId("rail-sync-erase")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute("data-no-reload", "1");
});

test("the plan page grows a pin pane at desktop width", async ({ page }) => {
  await page.goto("/plan?map-style=blank");
  await expect(page.getByTestId("plan-pane")).toBeVisible();
  await expect(page.getByText("Long-press the map")).toBeVisible();
});

test("the seat's play button slides the replay pane open, playing; stop closes it", async ({
  page,
}) => {
  // Record ~20s of flight (500ms wall at 40x) so replay is available.
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();

  await page.getByTestId("rail-logbook").click();
  await page.locator(".flight-row").first().click();

  // Closed by default: just a floating play button on the seat map.
  await expect(page.getByTestId("replay-dock")).toBeHidden();
  await expect(page.getByTestId("replay-start")).toBeVisible();

  // Open: the pane slides up and playback starts on the SEAT's own map.
  const seatDisplay = () =>
    page
      .locator(".seat-map .map-container")
      .evaluate(
        (el) =>
          (el as HTMLElement & { __display?: { lng: number; lat: number } })
            .__display ?? null,
      );
  await page.getByTestId("replay-start").click();
  await expect(page.getByTestId("replay-dock")).toBeVisible();
  await expect(page.getByTestId("replay-start")).toBeHidden();
  await expect.poll(seatDisplay).not.toBeNull();
  const start = (await seatDisplay())!;
  await expect
    .poll(async () => {
      const at = await seatDisplay();
      return at !== null && (at.lng !== start.lng || at.lat !== start.lat);
    })
    .toBe(true);

  // The fly-page camera controls ride along while open.
  await expect(page.getByTestId("replay-follow")).toBeVisible();
  await page.getByTestId("replay-follow").click();
  await expect(page.getByTestId("replay-follow")).toHaveAttribute(
    "data-active",
    "true",
  );

  // Seat fullscreen keeps the open pane docked.
  await page.getByTestId("map-expand").click();
  await expect(page.getByTestId("replay-dock")).toBeVisible();
  await page.getByTestId("map-expand").click();

  // Stop PARKS the replay in place: the pane stays, playback rewinds to
  // the start, and the aircraft glyph leaves the map.
  await page.getByTestId("replay-stop").click();
  await expect(page.getByTestId("replay-dock")).toBeVisible();
  await expect(page.getByTestId("replay-play")).toHaveAttribute(
    "aria-label",
    "Play",
  );
  await expect(page.getByTestId("replay-time")).toContainText("0:00 /");
  // Parked = no cursors: the graph keeps its shape, the playhead is gone,
  // and the camera locks retire with the glyph (following nothing would
  // pin the zoom anchor to an empty point).
  await expect(page.locator(".barogram-playhead")).toHaveCount(0);
  await expect(page.getByTestId("replay-follow")).toBeHidden();
  await expect(page.getByTestId("replay-trackup")).toBeHidden();

  // Parked, the stop button IS the collapse chevron: pressing it again
  // slides the pane away and the play button returns.
  await expect(page.getByTestId("replay-stop")).toHaveAttribute(
    "aria-label",
    "Hide replay",
  );
  await page.getByTestId("replay-stop").click();
  await expect(page.getByTestId("replay-dock")).toBeHidden();
  await expect(page.getByTestId("replay-start")).toBeVisible();
  await expect(page.getByText("Max altitude")).toBeVisible();
});

test("the open replay pane survives flight switches and reloads", async ({
  page,
}) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Start Flight" }).click();
    await expect(page.getByTestId("recording")).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Stop flight" }).click();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Start Flight" }),
    ).toBeVisible();
  }
  await page.getByTestId("rail-logbook").click();
  await page.locator(".flight-row").first().click();
  await page.getByTestId("replay-start").click();
  await expect(page.getByTestId("replay-dock")).toBeVisible();

  // Arrow to the other flight: the pane stays, rebound to the new track
  // (no close, no re-slide, no play button flashing back) — but PARKED,
  // never auto-playing a flight the pilot didn't press play on.
  const firstUrl = page.url();
  await page.keyboard.press("ArrowDown");
  await expect(page).not.toHaveURL(firstUrl);
  await expect(page.getByTestId("replay-dock")).toBeVisible();
  await expect(page.getByTestId("replay-start")).toBeHidden();
  await expect(page.getByTestId("replay-play")).toHaveAttribute(
    "aria-label",
    "Play",
  );

  // And BACK to the play-button flight: still parked — the original
  // autoplay intent must not re-arm on the round trip (a playing clock
  // under a parked pane is an invisible, contradictory state).
  await page.keyboard.press("ArrowUp");
  await expect(page).toHaveURL(firstUrl);
  await expect(page.getByTestId("replay-play")).toHaveAttribute(
    "aria-label",
    "Play",
  );
  await expect(page.locator(".barogram-playhead")).toHaveCount(0);

  // Speed is a device preference too: bump it before the reload.
  await expect(page.getByTestId("replay-speed")).toHaveText("30×");
  await page.getByTestId("replay-speed").click();
  await expect(page.getByTestId("replay-speed")).toHaveText("60×");

  // A reload brings the pane back already open — paused, not auto-playing,
  // still at the chosen speed.
  await page.reload();
  await expect(page.getByTestId("replay-dock")).toBeVisible();
  await expect(page.getByTestId("replay-play")).toHaveAttribute(
    "aria-label",
    "Play",
  );
  await expect(page.getByTestId("replay-speed")).toHaveText("60×");

  // Collapse forgets the preference: closed now, still closed on reload.
  await page.getByTestId("replay-collapse").click();
  await expect(page.getByTestId("replay-dock")).toBeHidden();
  await page.reload();
  await expect(page.getByTestId("replay-start")).toBeVisible();
  await expect(page.getByTestId("replay-dock")).toBeHidden();

  // Deleting the seated flight moves to its neighbor, not the bare list.
  const urlBefore = page.url();
  await page.getByTestId("detail-options").click();
  await page.getByRole("button", { name: "Delete flight" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).not.toHaveURL(urlBefore);
  await expect(page).toHaveURL(/\/logbook\/recorded-/);
  await expect(page.getByText("Max altitude")).toBeVisible();
});

test("the seat trims a flight from the options sheet", async ({ page }) => {
  // ~360s of sim time in ~1.5s wall: enough recording to clip.
  await page.goto("/?mock-speed=240&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();

  await page.getByTestId("rail-logbook").click();
  await page.locator(".flight-row").first().click();

  // Prime a live player first: open the pane, pause, park the playhead
  // mid-flight. The clip editors must borrow and RETURN this player.
  await page.getByTestId("replay-start").click();
  await expect(page.getByTestId("replay-dock")).toBeVisible();
  await page.getByTestId("replay-play").click(); // pause
  const chart = (await page.getByTestId("barogram").boundingBox())!;
  const y = chart.y + chart.height / 2;
  await page.mouse.move(chart.x + chart.width * 0.5, y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator(".barogram-playhead")).toHaveCount(1);

  // The sheet slides the clip editor open under the seat map, the cut
  // preset from that exact spot.
  await page.getByTestId("detail-options").click();
  await page.getByRole("button", { name: "Trim end" }).click();
  await expect(page.getByTestId("clip-dock")).toBeVisible();
  await expect(page.getByTestId("clip-mark-end")).toBeAttached();

  // Cancel: the borrowed player comes back exactly — same position, and
  // the playhead (the live glyph state) restored, not parked.
  await page.getByTestId("clip-cancel").click();
  await expect(page.getByTestId("clip-dock")).toBeHidden();
  await expect(page.getByTestId("replay-dock")).toBeVisible();
  await expect(page.getByTestId("replay-time")).not.toContainText("0:00 /");
  await expect(page.locator(".barogram-playhead")).toHaveCount(1);

  // Back in: scrub the cut to half so the trim below is deterministic.
  await page.getByTestId("detail-options").click();
  await page.getByRole("button", { name: "Trim end" }).click();
  const total = () =>
    page.getByTestId("barogram").getAttribute("aria-valuemax").then(Number);
  const before = await total();
  await page.mouse.move(chart.x + chart.width * 0.9, y);
  await page.mouse.down();
  await page.mouse.move(chart.x + chart.width * 0.5, y, { steps: 8 });
  await page.mouse.up();

  // The Ionic confirm can retreat before it commits.
  await page.getByTestId("clip-apply").click();
  const alert = page.locator("ion-alert:not(.overlay-hidden)");
  await expect(alert).toContainText("Trim the end?");
  await alert.getByRole("button", { name: "Cancel" }).click();
  await expect(alert).toHaveCount(0);
  await page.getByTestId("clip-apply").click();
  await alert.getByRole("button", { name: "Trim" }).click();

  // Exit into parked playback of the shorter recording; still one flight.
  await expect(page.getByTestId("replay-dock")).toBeVisible();
  await expect.poll(total).toBeLessThan(before - 30);
  await expect(page.locator(".flight-row")).toHaveCount(1);
});

test("the record opt-in shows Fly live, and turning it off hides it", async ({
  page,
}) => {
  await page.goto("/settings?map-style=blank");
  await expect(page.getByTestId("rail-fly")).toHaveCount(0);

  const toggle = page.locator("ion-toggle", {
    hasText: "Record in this browser",
  });
  await toggle.click();
  await page
    .locator("ion-alert")
    .getByRole("button", { name: "Turn on" })
    .click();
  await expect(page.getByTestId("rail-fly")).toBeVisible();

  await toggle.click();
  await expect(page.getByTestId("rail-fly")).toHaveCount(0);
});
