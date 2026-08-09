import { expect, test } from "@playwright/test";

import { dismissLandingSheet } from "./landingSheet";

// The selection loupe is native iOS UI no browser can show, so what is
// checkable here is the property that suppresses it (theme.css). Worth a test
// on the flight surface in particular: Ionic scopes its own `user-select:
// none` to `html.plt-mobile ion-app`, and a flight sheds ion-app entirely
// (App.tsx), so the flight tree is covered by the root rule or by nothing.
//
// Touch, unlike the rest of the suite: the rule sits behind (pointer:
// coarse), which a Chromium context flips on hasTouch alone.
test.use({ hasTouch: true });

test("a held finger selects no flight readout, and still selects in a field", async ({
  page,
}) => {
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });

  await expect(page.getByTestId("instrument-duration")).toHaveCSS(
    "user-select",
    "none",
  );

  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();

  // The fields the landing sheet raises are the exception: a caret needs a
  // selectable field, and its loupe is the one worth keeping. By role, so
  // this reads the native <input> the rule names rather than its ion-input
  // host, which carries the same aria-label.
  await expect(page.getByRole("textbox", { name: "Flight name" })).toHaveCSS(
    "user-select",
    "text",
    { timeout: 20_000 },
  );
  await dismissLandingSheet(page);
});
