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
  await close.click();
  await expect(close).toBeHidden();
}
