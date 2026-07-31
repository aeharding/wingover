import { expect, type Page } from "@playwright/test";

/**
 * Dismiss the sheet a finished flight raises (EndedFlightSheet).
 *
 * Not a test convenience: the sheet covers the tab bar, so a pilot has to
 * clear it before touching the shell too. Anything that records a real flight
 * and then navigates needs this, and the assertion that it appeared at all is
 * worth having on every one of those paths — a flight that finishes without
 * announcing itself is the failure this whole screen exists to prevent.
 *
 * Call it BEFORE asserting anything about the shell. A presented ion-modal
 * marks the app root aria-hidden, and getByRole reads the accessibility tree,
 * so `getByRole("button", { name: "Start Flight" })` does not merely find a
 * covered button — it finds nothing. That ordering bug passed locally and
 * failed on CI, where the slower runner let the sheet finish presenting first.
 *
 * Only for flights that SAVED. A discarded or never-launched session raises
 * nothing, and waiting here would just burn the timeout.
 */
export async function dismissLandingSheet(page: Page) {
  const close = page.getByTestId("sheet-close");
  await expect(close).toBeVisible({ timeout: 20_000 });
  await sheetHasFinishedPresenting(page);
  await close.click();
  await expect(close).toBeHidden();
}

/**
 * Resolves once the sheet has stopped moving, which `toBeVisible` does not
 * imply: the button gets a box the moment Ionic drops `overlay-hidden`, one
 * statement before it starts a 500ms translateY(100vh) slide, so it is
 * routinely off the bottom of the viewport when the assertion passes.
 *
 * Playwright's own stability check is not enough. `getBoundingClientRect`
 * reports the position the main thread last computed, which lags a transform
 * animation the compositor is running, and Chromium's
 * `rafCountForStablePosition()` is 1 — two consecutive animation frames, no
 * minimum gap between the samples. CI run 30512846889 called the sliding sheet
 * "visible, enabled and stable" 7.7ms into the slide, from a box the screencast
 * shows was never painted there. The mousedown then landed on the button and
 * the mouseup landed past it, so the browser delivered `click` to a common
 * ancestor instead: React never ran onClose, the modal kept `isOpen`, and the
 * sheet stayed up for the rest of the test.
 *
 * The animations are the signal because they are the thing whose progress is
 * in question. `DocumentOrShadowRoot.getAnimations()` reaches the ones Ionic
 * runs on the modal's shadow tree; `document.getAnimations()` does not see
 * into a shadow tree at all, and neither does `getAnimations({ subtree: true })`
 * on the host.
 *
 * Nothing running, rather than everything finished: on the phone layout the
 * sheet gesture parks a second set of animations on the same elements, held
 * `paused` at the detent for as long as the sheet is up.
 */
async function sheetHasFinishedPresenting(page: Page) {
  await page.waitForFunction(() => {
    const sheet = document
      .querySelector('[data-testid="sheet-close"]')
      ?.closest("ion-modal");
    const transition = sheet?.shadowRoot?.getAnimations() ?? [];
    return (
      transition.length > 0 &&
      transition.every((animation) => animation.playState !== "running")
    );
  });
}
