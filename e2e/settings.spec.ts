import { expect, test } from "@playwright/test";

test("settings page credits OSM map data", async ({ page }) => {
  await page.goto("/settings");
  const osm = page.getByTestId("osm-attribution");
  await expect(osm).toBeVisible();
  await expect(osm).toHaveAttribute(
    "href",
    "https://www.openstreetmap.org/copyright",
  );
  await expect(page.getByText("© MapTiler")).toBeVisible();
});
