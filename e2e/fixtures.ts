import { test as base, expect } from "@playwright/test";

// The app-logic e2e run against the fake, network-free map backend
// (src/ui/map/fake) so they never touch MapLibre/MapKit, their tiles, or
// auth. Injected before app code runs so resolveBackend() selects it. Real
// map rendering is verified separately in maplibre.spec.ts.
export const test = base.extend({
  page: async ({ page }, runTest) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("wingover.map", "fake");
      } catch {
        // storage unavailable — resolveBackend falls back on its own
      }
    });
    await runTest(page);
  },
});

export { expect };
