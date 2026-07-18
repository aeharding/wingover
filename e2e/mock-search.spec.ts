import { expect, test } from "@playwright/test";

// The simulator is opt-in strictly through the URL: ?mock-speed=N is read
// once, at engine module load, from location.search (src/engine/index.ts).
// The "/" index redirect must therefore carry the query string across to
// /fly, or a full reload (Vite HMR, a manual refresh, a restored tab) lands
// on a bare /fly, rebuilds the engine WITHOUT the mock, and simulated
// recording silently dies. This spec guards that the search survives the
// redirect in BOTH shells: the desktop rail (plain react-router) and the
// phone tab bar (Ionic outlet), which strip it differently.

async function assertMockSurvives(page: import("@playwright/test").Page) {
  // The index redirect must forward the query string, not drop it.
  await page.goto("/?mock-speed=40&map-style=blank");
  await expect(page).toHaveURL(/\/fly\?.*mock-speed=40/);

  // The real teeth: a full reload is the scenario that breaks. If the URL
  // kept the mock, the reloaded engine is the simulator again and a flight
  // records; if it was dropped, the engine is the real GPS source and, in a
  // headless browser with no geolocation, "recording" never arrives.
  await page.reload();
  await expect(page).toHaveURL(/\/fly\?.*mock-speed=40/);
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
}

test.describe("desktop shell (rail, plain react-router)", () => {
  // Above Ionic's lg breakpoint (992px) the app renders DesktopShell.
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the index redirect keeps ?mock-speed across to /fly", async ({
    page,
  }) => {
    await assertMockSurvives(page);
  });
});

test.describe("phone shell (Ionic tab outlet)", () => {
  // The suite default (playwright.config.ts) is a phone, which renders
  // TabShell. Ionic's IonRouterOutlet has its own <Redirect> plumbing, so
  // the phone path needs its own guard.
  test("the index redirect keeps ?mock-speed across to /fly", async ({
    page,
  }) => {
    await assertMockSurvives(page);
  });
});
