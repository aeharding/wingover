import { expect, test } from "@playwright/test";

test("imports GPX flights from the logbook menu", async ({ page }) => {
  await page.goto("/?map-style=blank");
  await page.getByText("Logbook", { exact: true }).click();
  await page.getByTestId("logbook-options").click();

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import GPX files" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles("e2e/fixtures/flight.gpx");

  await expect(page.getByText(/Imported 1 flight/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Tomahawk Test Flight" }),
  ).toBeVisible();

  await page.getByRole("heading", { name: "Tomahawk Test Flight" }).click();
  await expect(page.locator("[data-track-layer='true']")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("launch-marker")).toBeVisible();
  await expect(page.getByText("Max altitude")).toBeVisible();
});
