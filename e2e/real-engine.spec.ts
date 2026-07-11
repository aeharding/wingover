import { expect, type Page, test } from "@playwright/test";

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
  const errorWatchers = new Map();
  window.__geo.fail = (code) => {
    const error = {
      code,
      message: "stubbed",
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    };
    for (const callback of [...errorWatchers.values()]) callback(error);
  };
  const geolocation = {
    watchPosition(success, error) {
      const id = nextId++;
      watchers.set(id, success);
      if (error) errorWatchers.set(id, error);
      return id;
    },
    clearWatch(id) {
      watchers.delete(id);
      errorWatchers.delete(id);
    },
    getCurrentPosition() {},
  };
  Object.defineProperty(navigator, "geolocation", {
    value: geolocation,
    configurable: true,
  });
  window.__spoken = [];
  if (typeof speechSynthesis !== "undefined") {
    speechSynthesis.speak = (utterance) => {
      window.__spoken.push(utterance.text);
    };
  }
})();`;

const URL = "/?map-style=blank&hold-ms=300";

interface FixSpec {
  speed?: number;
  accuracy?: number;
  altitudeAccuracy?: number;
  latitude?: number;
  longitude?: number;
  heading?: number;
}

function makeEmitter(page: Page) {
  let timestamp = Date.now();
  let latitude = 43.0;
  return async (fixes: FixSpec[]) => {
    const payload = fixes.map((spec) => {
      timestamp += 1000;
      latitude = spec.latitude ?? latitude + (spec.speed ?? 0) / 111_320;
      return {
        timestamp,
        coords: {
          latitude,
          longitude: spec.longitude ?? -89.4,
          altitude: 300,
          accuracy: spec.accuracy ?? 5,
          altitudeAccuracy: spec.altitudeAccuracy ?? 8,
          heading: spec.heading ?? 0,
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
  // Hold until the stop takes effect, not for a guessed duration: the
  // hold timer fires on main-thread time, and a pointerup that beats it
  // (one long task on a slow CI runner) cancels the stop BY DESIGN.
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible({ timeout: 15_000 });
  await page.mouse.up();
  await page.getByText("Logbook", { exact: true }).click();
  await expect(page.getByText(/1 flights/)).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("reload while armed keeps the session and still auto-takes-off", async ({
  page,
}) => {
  await page.addInitScript(GEO_STUB);
  const emit = makeEmitter(page);
  await page.goto(URL);

  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("armed")).toBeVisible();
  await waitForWatch(page);
  await emit([{}, {}, {}]);
  await expect(page.getByText("Waiting for takeoff")).toBeVisible();

  // Kill the webview while armed: the session must survive
  await page.goto(URL);
  await expect(page.getByTestId("armed")).toBeVisible();
  await expect(page.getByText("Waiting for takeoff")).toBeVisible();

  // …and takeoff detection must still work on the rehydrated buffer
  await waitForWatch(page);
  await emit(Array.from({ length: 6 }, () => ({ speed: 6 })));
  await expect(page.getByTestId("recording")).toBeVisible();
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

test("backgrounded landing: a burst-replayed flight finalizes retroactively", async ({
  page,
}) => {
  await page.addInitScript(GEO_STUB);
  const emit = makeEmitter(page);
  await page.goto(URL);
  await armAndFly(page, emit);

  // The phone slept through landing + a long stationary wait; on foreground
  // the whole backlog replays at once. Grace is fix-time, so the engine
  // finalizes retroactively at touchdown with no interaction and no
  // wall-clock wait.
  await emit(Array.from({ length: 50 }, () => ({ speed: 0.3 })));

  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();
  await page.getByText("Logbook", { exact: true }).click();
  await expect(page.getByText(/1 flights/)).toBeVisible();
});

test("permission denied surfaces on the arming screen and clears on fix", async ({
  page,
}) => {
  await page.addInitScript(GEO_STUB);
  const emit = makeEmitter(page);
  await page.goto(URL);

  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("armed")).toBeVisible();
  await waitForWatch(page);

  await page.evaluate(() => {
    (window as unknown as { __geo: { fail: (c: number) => void } }).__geo.fail(
      1,
    );
  });
  await expect(page.getByTestId("gps-error")).toContainText(
    "Location permission denied",
  );

  // A fix arriving clears the banner
  await emit([{}]);
  await expect(page.getByTestId("gps-error")).toBeHidden();
});

test("a pin becomes a spoken waypoint announcement mid-flight", async ({
  page,
}) => {
  await page.addInitScript(GEO_STUB);
  const emit = makeEmitter(page);

  // Drop a pin on the plan page and read back where it landed
  await page.goto("/?map-style=blank");
  await page.getByText("Plan", { exact: true }).click();
  const canvas = page.locator(".maplibregl-canvas");
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(500);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 300);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  const marker = page.getByTestId("pin-marker");
  await expect(marker).toBeVisible();
  const pinLat = Number(await marker.getAttribute("data-lat"));
  const pinLng = Number(await marker.getAttribute("data-lng"));

  // Fly far from the pin, then pass through it
  await page.goto(URL);
  await armAndFly(page, emit);
  await emit([
    { speed: 7, latitude: pinLat - 0.005, longitude: pinLng },
    { speed: 7, latitude: pinLat, longitude: pinLng },
    { speed: 7, latitude: pinLat, longitude: pinLng },
  ]);

  await page.waitForFunction(
    () => (window as unknown as { __spoken: string[] }).__spoken.length > 0,
  );
  const spoken = await page.evaluate(
    () => (window as unknown as { __spoken: string[] }).__spoken,
  );
  expect(spoken).toContain("Waypoint reached");
  // Dwelling inside must not repeat
  expect(spoken.filter((text) => text === "Waypoint reached")).toHaveLength(1);
});

test("track-up toggle rotates the camera immediately, not on a glide", async ({
  page,
}) => {
  await page.addInitScript(GEO_STUB);
  await page.goto(URL);
  const emit = makeEmitter(page);
  await armAndFly(page, emit);

  // Fly a hard east course and wait for the displayed heading to settle.
  await emit(Array.from({ length: 4 }, () => ({ speed: 6, heading: 90 })));
  const readCourse = () =>
    page.evaluate(
      () =>
        (
          document.querySelector(".map-container") as HTMLElement & {
          __display?: { course: number };
        }
        ).__display?.course ?? 0,
    );
  await expect.poll(readCourse, { timeout: 5000 }).toBeGreaterThan(70);

  await page.getByRole("button", { name: "Track up" }).click();

  // A snap, not a chase: the old 800 ms smoothing needed >1 s to cover
  // this 90-degree alignment; the toggle must land within a frame or two.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const container = document.querySelector(
            ".map-container",
          ) as HTMLElement & { __map?: { getBearing(): number } };
          const bearing = container.__map?.getBearing() ?? 0;
          return bearing > 70 && bearing < 110;
        }),
      { timeout: 700 },
    )
    .toBe(true);
});
