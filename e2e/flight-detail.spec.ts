import { expect, test } from "@playwright/test";

async function recordQuickFlight(page: import("@playwright/test").Page) {
  await page.goto("/?mock-speed=40&map-style=blank");
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();
}

test("flight detail shows stats, exports GPX, and deletes", async ({
  page,
}) => {
  await recordQuickFlight(page);

  await page.getByText("Logbook", { exact: true }).click();
  await page.locator(".flight-row").click();

  await expect(page.getByText("Max altitude")).toBeVisible();
  await expect(page.getByText("Avg speed")).toBeVisible();

  await page.getByTestId("detail-options").click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export GPX" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.gpx$/);
  await expect(
    page.getByRole("button", { name: "Export GPX" }),
  ).not.toBeVisible();

  await page.getByTestId("detail-options").click();
  await page.getByRole("button", { name: "Delete flight" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(page.getByText("No flights yet.")).toBeVisible();
});
