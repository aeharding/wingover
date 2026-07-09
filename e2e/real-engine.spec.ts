import { expect, test, type Page } from "@playwright/test";

// CDP setGeolocation cannot supply altitude/speed, which the accuracy gate
// and takeoff detection require — stub watchPosition itself so the test
// drives the real engine's actual consumption path.
const GEO_STUB = `(() => {
  const watchers = new Map();
  let nextId = 1;
  window.__geo = {
    emit(coords, timestamp) {
      for (const callback of [...watchers.values()]) {
        callback({ coords, timestamp });
      }
    },
    watcherCount: () => watchers.size,
  };
  const geolocation = {
    watchPosition(success) {
      const id = nextId++;
      watchers.set(id, success);
      return id;
    },
    clearWatch(id) {
      watchers.delete(id);
    },
    getCurrentPosition() {},
  };
  Object.defineProperty(navigator, "geolocation", {
    value: geolocation,
    configurable: true,
  });
})();`;

const URL = "/?engine=real&map-style=blank&hold-ms=300";

interface FixSpec {
  speed?: number;
  accuracy?: number;
  altitudeAccuracy?: number;
}

function makeEmitter(page: Page) {
  let timestamp = Date.now();
  let latitude = 43.0;
  return async (fixes: FixSpec[]) => {
    const payload = fixes.map((spec) => {
      timestamp += 1000;
      latitude += ((spec.speed ?? 0) * 1000) / 111_320 / 1000;
      return {
        timestamp,
        coords: {
          latitude,
          longitude: -89.4,
          altitude: 300,
          accuracy: spec.accuracy ?? 5,
          altitudeAccuracy: spec.altitudeAccuracy ?? 8,
          heading: 0,
          speed: spec.speed ?? 0,
        },
      };
    });
    await page.evaluate((list) => {
      const geo = (
        window as unknown as {
          __geo: { emit: (c: unknown, t: number) => void };
        }
      ).__geo;
      for (const item of list) geo.emit(item.coords, item.timestamp);
    }, payload);
  };
}

async function waitForWatch(page: Page) {
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __geo: { watcherCount: () => number } }
      ).__geo.watcherCount() > 0,
  );
}

async function armAndFly(page: Page, emit: ReturnType<typeof makeEmitter>) {
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("armed")).toBeVisible();
  await waitForWatch(page);
  await emit([{}, {}, {}]);
  await expect(page.getByText("Waiting for takeoff")).toBeVisible();
  await emit(Array.from({ length: 6 }, () => ({ speed: 6 })));
  await expect(page.getByTestId("recording")).toBeVisible();
}

test("real engine: gate, backdated takeoff, reload kill drill, stop", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.addInitScript(GEO_STUB);
  const emit = makeEmitter(page);

  await page.goto(URL);
  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("armed")).toBeVisible();
  await expect(page.getByText("Acquiring GPS")).toBeVisible();
  await waitForWatch(page);

  // Bad accuracy must not arm
  await emit([{ accuracy: 40 }, { accuracy: 40 }, { accuracy: 40 }]);
  await expect(page.getByText("Acquiring GPS")).toBeVisible();

  // Three accurate fixes pass the gate
  await emit([{}, {}, {}]);
  await expect(page.getByText("Waiting for takeoff")).toBeVisible();

  // Slow taxi then sustained flight speed → recording, backdated
  await emit([{ speed: 2 }, { speed: 3 }]);
  await emit([
    { speed: 6 },
    { speed: 6 },
    { speed: 6 },
    { speed: 6 },
    { speed: 6 },
  ]);
  await expect(page.getByTestId("recording")).toBeVisible();
  await expect(page.getByTestId("instrument-duration")).not.toHaveText("0:00");

  // Kill drill: reload mid-recording, rehydrate from the IndexedDB WAL
  await emit([{ speed: 7 }, { speed: 7 }, { speed: 7 }]);
  await page.goto(URL);
  await expect(page.getByTestId("recording")).toBeVisible();
  const rehydrated = await page
    .getByTestId("instrument-duration")
    .textContent();
  expect(rehydrated).not.toBe("0:00");

  // The fresh page must re-establish the watch and keep consuming fixes
  await waitForWatch(page);
  await emit([{ speed: 7 }, { speed: 7 }]);
  await expect(page.locator("[data-aircraft-layer='true']")).toBeVisible();

  const stopButton = page.getByRole("button", { name: /hold to stop/i });
  await stopButton.hover();
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();

  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();
  await page.getByText("Logbook", { exact: true }).click();
  await expect(page.getByText(/1 flights/)).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("landing prompt: dismiss re-arms, stop saves", async ({ page }) => {
  await page.addInitScript(GEO_STUB);
  const emit = makeEmitter(page);
  await page.goto(URL);
  await armAndFly(page, emit);

  await emit(Array.from({ length: 15 }, () => ({ speed: 0.3 })));
  await expect(page.getByTestId("landing-prompt")).toBeVisible();

  await page.getByRole("button", { name: "Still flying" }).click();
  await expect(page.getByTestId("landing-prompt")).toBeHidden();

  // More stationary fixes must not re-prompt until movement resumes
  await emit(Array.from({ length: 5 }, () => ({ speed: 0.3 })));
  await expect(page.getByTestId("landing-prompt")).toBeHidden();

  await emit(Array.from({ length: 5 }, () => ({ speed: 7 })));
  await emit(Array.from({ length: 15 }, () => ({ speed: 0.3 })));
  await expect(page.getByTestId("landing-prompt")).toBeVisible();

  await page.getByRole("button", { name: /Stop & save/ }).click();
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();
  await page.getByText("Logbook", { exact: true }).click();
  await expect(page.getByText(/1 flights/)).toBeVisible();
});

test("landing prompt times out into auto-stop", async ({ page }) => {
  await page.addInitScript(GEO_STUB);
  const emit = makeEmitter(page);
  await page.goto(`${URL}&land-timeout-ms=1200`);
  await armAndFly(page, emit);

  await emit(Array.from({ length: 15 }, () => ({ speed: 0.3 })));
  await expect(page.getByTestId("landing-prompt")).toBeVisible();

  await expect(page.getByRole("button", { name: "Start Flight" })).toBeVisible({
    timeout: 5000,
  });
  await page.getByText("Logbook", { exact: true }).click();
  await expect(page.getByText(/1 flights/)).toBeVisible();
});
