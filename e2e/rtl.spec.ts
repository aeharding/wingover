import { expect, test } from "@playwright/test";

test("projected arrival opens sunset guidance more than thirty minutes before sunset", async ({
  page,
}) => {
  await page.goto(
    "/?mock-gpx=/e2e/fixtures/rtl-early-arrival.gpx&mock-speed=600&map-style=blank",
  );
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });

  const sunset = page.getByTestId("instrument-sunset");
  const arrival = page.getByTestId("instrument-target-arrival-sunset");
  await expect(sunset).toHaveText(/^S−\d{2}$/);
  await expect(arrival).toHaveText(/^S−\d{2}$/);
  const minutesUntilSunset = Number((await sunset.textContent())!.slice(2));
  const arrivalLead = Number((await arrival.textContent())!.slice(2));
  expect(minutesUntilSunset).toBeGreaterThan(30);
  expect(arrivalLead).toBeLessThanOrEqual(30);
  await expect(page.getByTestId("instrument-target-eta")).toHaveCount(0);
});

test("sunset return guidance stays compact without direction bars", async ({
  page,
}) => {
  await page.goto(
    "/?mock-gpx=/e2e/fixtures/rtl-inbound.gpx&mock-speed=600&map-style=blank",
  );
  await page.getByRole("button", { name: "Start Flight" }).click();

  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });
  const sunset = page.getByTestId("instrument-sunset");
  const arrival = page.getByTestId("instrument-target-arrival-sunset");
  const duration = page.getByTestId("instrument-duration");
  await expect(sunset).toHaveText(/^S−\d{2}$/);
  await expect(arrival).toHaveText(/^S[+−]\d{2}$/);
  await expect(page.getByTestId("instrument-target-eta")).toHaveCount(0);
  await expect(page.getByTestId("direction-hint-left")).toHaveCount(0);
  await expect(page.getByTestId("direction-hint-right")).toHaveCount(0);

  const colors = await Promise.all([
    sunset.evaluate((element) => getComputedStyle(element).color),
    arrival.evaluate((element) => getComputedStyle(element).color),
  ]);
  expect(colors[0]).toBe(colors[1]);
  expect(colors[0]).toContain("color(display-p3 1 0.25 0.78)");

  const primaryStats = page.locator("[data-tile-value]");
  await expect(primaryStats).toHaveCount(8);
  const instruments = page.getByTestId("instruments");
  await expect(instruments).toHaveCSS("grid-template-columns", /.+ .+/);
  const portraitColumns = await instruments.evaluate((element) =>
    getComputedStyle(element)
      .gridTemplateColumns.split(" ")
      .map((width) => Number.parseFloat(width)),
  );
  expect(portraitColumns[1]).toBeGreaterThan(portraitColumns[0]);
  for (const value of [sunset, arrival]) {
    expect(
      await value.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }
  const targetDistance = page.getByTestId("instrument-target-distance");
  await targetDistance.evaluate((element) => (element.textContent = "10.3 mi"));
  await duration.evaluate((element) => (element.textContent = "1:10:19"));
  await sunset.evaluate((element) => (element.textContent = "S+04"));
  await arrival.evaluate((element) => (element.textContent = "S+04"));
  for (const value of [duration, sunset, targetDistance, arrival]) {
    expect(
      await value.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }

  const splitValueSizes = async () =>
    Promise.all([
      page
        .getByTestId("instrument-agl")
        .evaluate((element) => getComputedStyle(element).fontSize),
      duration.evaluate((element) => getComputedStyle(element).fontSize),
      sunset.evaluate((element) => getComputedStyle(element).fontSize),
      targetDistance.evaluate((element) => getComputedStyle(element).fontSize),
      arrival.evaluate((element) => getComputedStyle(element).fontSize),
    ]);
  let sizes = await splitValueSizes();
  expect(sizes.slice(1)).toEqual(Array(4).fill(sizes[0]));

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByTestId("direction-hint-left")).toHaveCount(0);
  await expect(page.getByTestId("direction-hint-right")).toHaveCount(0);
  for (const value of [duration, sunset, targetDistance, arrival]) {
    expect(
      await value.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }
  sizes = await splitValueSizes();
  expect(sizes.slice(1)).toEqual(Array(4).fill(sizes[0]));
});

test("split guidance values fit large landscape phones and metric tablets", async ({
  page,
}) => {
  await page.goto("/settings/units?map-style=blank");
  await page.locator("ion-radio", { hasText: "Metric" }).click();
  await page.setViewportSize({ width: 956, height: 440 });
  await page.goto(
    "/?mock-gpx=/e2e/fixtures/rtl-inbound.gpx&mock-speed=600&map-style=blank",
  );
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("recording")).toBeVisible({ timeout: 10_000 });

  const duration = page.getByTestId("instrument-duration");
  const sunset = page.getByTestId("instrument-sunset");
  const distance = page.getByTestId("instrument-target-distance");
  const arrival = page.getByTestId("instrument-target-arrival-sunset");
  await duration.evaluate((element) => (element.textContent = "10:10:19"));
  await sunset.evaluate((element) => {
    const minus = element.querySelector("span")!;
    element.replaceChildren("S", minus, "120");
  });
  await distance.evaluate((element) => (element.textContent = "99.9 km"));
  await arrival.evaluate((element) => (element.textContent = "S+120"));

  const expectValuesToFit = async () => {
    for (const value of [duration, sunset, distance, arrival]) {
      const layout = await value.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        text: element.textContent,
      }));
      expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(
        layout.clientWidth,
      );
    }
  };

  await expectValuesToFit();
  await page.setViewportSize({ width: 768, height: 1024 });
  await expectValuesToFit();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectValuesToFit();
});
