import type { Page } from "@playwright/test";

/**
 * Pan the live map left (which unsnaps follow), then answer anything the
 * gesture proposed on the way.
 *
 * A mouse-down held past LONG_PRESS_MS IS a long press, and the RUNNER decides
 * how long the hold lasts: run 30509713312 took 466 ms to deliver the first
 * move after mouse.down, the adapter's 500 ms timer fired in that gap, and the
 * map correctly proposed a checkpoint — putting a full-viewport scrim over
 * every control the test was about to click. Moving sooner does not help (the
 * stall is between down() and the next CDP call), and synthesizing the gesture
 * inside the page would dodge the real input pipeline these tests exist to
 * cover (#209). So: let it happen, and dismiss it.
 */
export async function dragToUnsnap(page: Page) {
  const map = (await page.getByTestId("live-map").boundingBox())!;
  const y = map.y + map.height / 2;
  await page.mouse.move(map.x + map.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(map.x + map.width / 2 - 140, y, { steps: 8 });
  await page.mouse.up();

  // The scrim IS Cancel, but its panel stops propagation and sits under the
  // click point, so the button is the reliable answer.
  const proposal = page.getByTestId("waypoint-confirm");
  if (await proposal.count()) {
    await proposal.getByRole("button", { name: "Cancel" }).click();
  }
}
