import { expect, type Page, test } from "@playwright/test";

// CDP setGeolocation cannot supply altitude/speed, which the accuracy gate
// and takeoff detection require — stub watchPosition itself so the test
// drives the real engine's actual consumption path.
// The Fly tab is Tauri-only in browsers; this override (same pattern as the
// "wingover.map" backend override) shows it for the real-engine drills.
const GEO_STUB = `(() => {
  try { localStorage.setItem("wingover.record", "1"); } catch {}
  const watchers = new Map();
  let nextId = 1;
  window.__geo = {
    emit(coords, timestamp) {
      for (const callback of [...watchers.values()]) {
        callback({ coords, timestamp });
      }
    },
    watcherCount: () => watchers.size,
    // Safari can silently kill a watch while the page is backgrounded
    // (e.g. a Settings trip): callbacks just stop, the page is never
    // told. Drop the watchers without notifying anyone.
    killWatches: () => {
      watchers.clear();
      errorWatchers.clear();
    },
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

// What did this boot put on screen, and in what order? Recorded from
// mutation RECORDS rather than a live DOM scan, so a shell that mounts and
// is torn down inside a single frame still counts — the flicker under test
// is exactly that, and a poll or a visibility check would miss it.
// Installed at document-start (addInitScript), so nothing before the first
// React render escapes it, and it starts empty on every navigation.
//
// Each added subtree is walked in DOM order and every element classified,
// so the returned list is first-sighting order: "ion-app" before the
// "fly-content" nested inside it, and the bare flight surface before a
// shell that arrives in a later commit.
//
// The boot gate's frame is deliberately NOT a kind: it is an empty black
// rectangle, indistinguishable from the launch screen and from index.html's
// pre-paint canvas, so it is not a screen a pilot can be shown by mistake.
// What these lists track is the screens that mean something.
const BOOT_WATCH = `(() => {
  const classify = (el) => {
    if (el.dataset && el.dataset.testid === "fly-content") return "fly-content";
    const tag = el.tagName.toLowerCase();
    if (["ion-app", "ion-tabs", "ion-tab-bar", "ion-router-outlet"].includes(tag)) return tag;
    // The idle homescreen's one action, shell or no shell: the detector for
    // "the flight surface mounted but is showing the ground screen".
    if (tag === "button" && el.textContent.trim() === "Start Flight") return "start-flight";
    return null;
  };
  const seen = [];
  window.__boot = { list: () => [...seen] };
  const scan = (node) => {
    if (!node || node.nodeType !== 1) return;
    for (const el of [node, ...node.querySelectorAll("*")]) {
      const kind = classify(el);
      if (kind !== null && !seen.includes(kind)) seen.push(kind);
    }
  };
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) scan(node);
    }
  }).observe(document, { childList: true, subtree: true });
})();`;

function bootSightings(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __boot: { list: () => string[] } }).__boot.list(),
  );
}

const URL = "/?map-style=blank";

interface FixSpec {
  speed?: number;
  accuracy?: number;
  // null = the source has no altitude solution (reduced accuracy).
  altitudeAccuracy?: number | null;
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
          altitudeAccuracy:
            spec.altitudeAccuracy === undefined ? 8 : spec.altitudeAccuracy,
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

// "recording" on screen is in-memory state: the session write that journals
// the takeoff index is only ENQUEUED at that point (real.ts, enqueueWal).
// Killing the page before it commits rehydrates an armed session, which is a
// race in the DRILL, not in the app — the app is still running and would
// flush it. A relaunch drill has to wait for the WAL to actually hold the
// takeoff, or it is testing its own timing.
async function waitForDurableTakeoff(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const request = indexedDB.open("wingover-wal", 1);
        request.onerror = () => resolve(false);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("meta", "readonly");
          const session = tx.objectStore("meta").get("session");
          tx.oncomplete = () => {
            db.close();
            resolve(
              (session.result as { takeoffIndex?: number | null } | undefined)
                ?.takeoffIndex != null,
            );
          };
          tx.onerror = () => {
            db.close();
            resolve(false);
          };
        };
      }),
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

  await page.getByRole("button", { name: "Stop flight" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start Flight" })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByText("Logbook", { exact: true }).click();
  await expect(page.getByText(/1 flights/)).toBeVisible();
  expect(pageErrors).toEqual([]);
});

// Owner-reported, on device: "Dont flicker to the homescreen before
// relaunching the fly page, if in flight, its disorienting." Why it
// happened, and why the fix is shaped the way it is: src/engine/
// bootGate.ts.
test("mid-flight relaunch never flashes the homescreen", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.addInitScript(BOOT_WATCH);
  await page.addInitScript(GEO_STUB);
  const emit = makeEmitter(page);

  await page.goto(URL);
  await armAndFly(page, emit);
  await emit([{ speed: 7 }, { speed: 7 }]);
  await waitForDurableTakeoff(page);

  // The relaunch. The watcher is reinstalled on this fresh document, so
  // what it records is this boot only.
  await page.goto(URL);
  await expect(page.getByTestId("recording")).toBeVisible();

  // The flight surface, and nothing else, for the whole boot: no shell, no
  // tab bar, no Start button, not for one frame.
  expect(await bootSightings(page)).toEqual(["fly-content"]);

  // And with the shell shed the surface owns its canvas, so the frames
  // before the WAL lands are black rather than the ground app's page (pure
  // white on a light palette).
  expect(
    await page
      .getByTestId("fly-content")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(0, 0, 0)");

  // And the relaunched page is a working recorder, not a frozen picture.
  await waitForWatch(page);
  await emit([{ speed: 7 }, { speed: 7 }]);
  await expect(page.getByTestId("instrument-duration")).not.toHaveText("0:00");
  expect(pageErrors).toEqual([]);
});

// The other direction: an idle launch must still get the nav shell, not a
// black flight surface waiting on a flight that isn't there. Doubles as the
// positive control for the watcher above — every kind it can report shows
// up here, so the empty list in that test means "absent", not "undetected".
test("relaunch while idle still boots straight to the nav shell", async ({
  page,
}) => {
  await page.addInitScript(BOOT_WATCH);
  await page.addInitScript(GEO_STUB);
  await page.goto(URL);
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();

  await page.goto(URL);
  await expect(
    page.getByRole("button", { name: "Start Flight" }),
  ).toBeVisible();
  const seen = await bootSightings(page);
  expect(seen[0]).toBe("ion-app");
  expect(seen).toContain("ion-tab-bar");
  expect(seen).toContain("start-flight");

  // Inside the shell the surface stays a guest: transparent, so the trace
  // backdrop shows through and the idle page themes with the app.
  expect(
    await page
      .getByTestId("fly-content")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgba(0, 0, 0, 0)");
});

// The bounded half of the gate, and the only case where a pilot can still
// see the old flash. A WAL that never answers must not hold the boot frame
// forever: past the deadline the app renders from the current snapshot,
// which pre-hydration is honestly "idle" — exactly what it did before the
// gate existed. Degraded equals the old status quo; never a brick.
test("a WAL that never answers falls back to the shell after the deadline", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.addInitScript(BOOT_WATCH);
  await page.addInitScript(GEO_STUB);
  // The WAL's open request is never answered: no success, no error, no
  // abort. Scoped to that one database, so the rest of the app (settings,
  // logbook, sync) keeps working — a page that failed to boot at all would
  // "pass" this drill while proving nothing.
  await page.addInitScript(`(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (name, version) =>
      name === "wingover-wal"
        ? { onupgradeneeded: null, onsuccess: null, onerror: null }
        : open(name, version);
  })();`);

  await page.goto(URL, { waitUntil: "commit" });
  const startedAt = Date.now();
  const bootFrame = page.getByTestId("boot-frame");
  await expect(bootFrame).toBeVisible({ timeout: 10_000 });
  // Black while it waits, in every scheme: the wait has to be invisible
  // against the launch screen, not a grey card announcing itself.
  expect(
    await bootFrame.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(0, 0, 0)");
  // Budgets sum to less than the 30 s per-test timeout, so a gate that never
  // opens fails on the locator that names it rather than as a bare timeout.
  await expect(page.locator("ion-tab-bar")).toBeVisible({ timeout: 15_000 });
  const waited = Date.now() - startedAt;

  // It waited — this is not a boot that rendered off the pre-hydration
  // snapshot immediately and happened to look right.
  expect(waited).toBeGreaterThan(1500);
  // And what it fell back to is the pre-gate boot, in the pre-gate order.
  const seen = await bootSightings(page);
  expect(seen[0]).toBe("ion-app");
  expect(seen).toContain("ion-tab-bar");
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

  await page
    .getByTestId("landing-prompt")
    .getByRole("button", { name: /Stop/ })
    .click();
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

test("permission denied blocks with the error screen and recovers via reload", async ({
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
    "Location Access Needed",
  );

  // Blocked is absorbing: stray fixes are ignored. Web denied recovers
  // via Reload (browsers only re-prompt on a fresh page load); the WAL
  // rehydrates the session and the watch comes back on boot.
  await emit([{}]);
  await expect(page.getByTestId("gps-error")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try Again" })).toBeHidden();

  await page.getByRole("button", { name: "Reload" }).click();
  await waitForWatch(page);
  await emit([{}]);
  await expect(page.getByTestId("gps-error")).toBeHidden();
  await expect(page.getByTestId("armed")).toBeVisible();
});

test("precise off during a Settings trip surfaces the screen despite a dead watch", async ({
  page,
}) => {
  // Burns the real 12 s sustain window by design (the latch is the thing
  // under test); the default 30 s budget leaves too little margin for CI
  // under the zero-retry policy.
  test.setTimeout(60_000);
  await page.addInitScript(GEO_STUB);
  const emit = makeEmitter(page);
  await page.goto(URL);

  await page.getByRole("button", { name: "Start Flight" }).click();
  await expect(page.getByTestId("armed")).toBeVisible();
  await waitForWatch(page);

  // Mediocre fixes: acquiring, never armed.
  await emit([{ accuracy: 40 }, { accuracy: 40 }]);

  // The Settings trip: Safari silently kills the watch (the engine is
  // never told), the pilot flips Precise off and comes back, which
  // fires visibilitychange. The foreground bounce must revive the
  // watch...
  await page.evaluate(() => {
    (
      window as unknown as { __geo: { killWatches: () => void } }
    ).__geo.killWatches();
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitForWatch(page);

  // ...so the reduced fix reaches the engine, and the wall-clock latch
  // surfaces the screen even though this single fix is all we get.
  await emit([{ accuracy: 13_000, altitudeAccuracy: null }]);
  await expect(page.getByTestId("gps-error")).toContainText(
    "Precise Location Is Off",
    { timeout: 15_000 },
  );
});

test("a pin becomes a spoken waypoint announcement mid-flight", async ({
  page,
}) => {
  await page.addInitScript(GEO_STUB);
  const emit = makeEmitter(page);

  // Drop a pin on the plan page and read back where it landed
  await page.goto("/?map-style=blank");
  await page.getByText("Plan", { exact: true }).click();
  const canvas = page.getByTestId("map-container");
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

test("in-flight nav: planned distance, tap-select and clear a checkpoint", async ({
  page,
}) => {
  await page.addInitScript(GEO_STUB);
  const emit = makeEmitter(page);

  // Two pins on the zoom-3 plan.
  await page.goto(URL);
  await page.getByText("Plan", { exact: true }).click();
  const canvas = page.getByTestId("map-container");
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(500);
  const box = (await canvas.boundingBox())!;
  for (const [x, y] of [
    [120, 160],
    [320, 460],
  ]) {
    await page.mouse.move(box.x + x, box.y + y);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
  }
  const markers = page.getByTestId("pin-marker");
  await expect(markers).toHaveCount(2);
  // First-dropped pin sorts first → it is the first nav target.
  const p1Lat = Number(await markers.nth(0).getAttribute("data-lat"));
  const p1Lng = Number(await markers.nth(0).getAttribute("data-lng"));

  // Idle Fly screen shows the planned-route length.
  await page.getByText("Fly", { exact: true }).click();
  await expect(page.getByTestId("planned-route")).toContainText(
    "Planned route:",
  );

  // Take off: nav targets the next waypoint, but with nothing SELECTED the
  // clear-checkpoint button is not shown (it is not a "remove next" button).
  await armAndFly(page, emit);
  await expect(page.getByText("Distance to waypoint")).toBeVisible();
  await expect(page.getByTestId("remove-waypoint")).toHaveCount(0);

  // Fly to just shy of the first pin so its marker sits on-screen (the ring is
  // 322 m; 0.005° ≈ 556 m, so it is NOT reached).
  await emit([{ speed: 7, latitude: p1Lat - 0.005, longitude: p1Lng }]);

  // Tap the pin → it becomes selected → the clear-checkpoint button appears.
  await page.getByTestId("waypoint-pin").first().click();
  await expect(page.getByTestId("remove-waypoint")).toBeVisible();

  // Clear it → that checkpoint is removed; nav retargets to the second pin and
  // the button hides again (nothing selected).
  await page.getByTestId("remove-waypoint").click();
  await expect(page.getByTestId("remove-waypoint")).toHaveCount(0);
  await expect(page.getByText("Distance to waypoint")).toBeVisible();
});

test("a long-press mid-flight proposes a checkpoint behind a confirm", async ({
  page,
}) => {
  await page.addInitScript(GEO_STUB);
  const emit = makeEmitter(page);
  await page.goto(URL);
  await armAndFly(page, emit);
  // Let the follow camera finish easing onto the first fixes: a zoomstart
  // mid-hold cancels the adapter's press timer (by design — a moving map
  // must not register a stationary press).
  await page.waitForTimeout(1200);

  const map = (await page.getByTestId("live-map").boundingBox())!;
  const longPress = async () => {
    await page.mouse.move(map.x + map.width / 2 + 80, map.y + map.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
  };

  // Cancel path: the scrim is the safe answer — no waypoint appears.
  await longPress();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("waypoint-pin")).toHaveCount(0);

  // Confirm path: Add sets the checkpoint and it becomes the nav target.
  await longPress();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(page.getByTestId("waypoint-pin")).toHaveCount(1);
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
          document.querySelector(
            '[data-testid="map-container"]',
          ) as HTMLElement & {
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
            '[data-testid="map-container"]',
          ) as HTMLElement & { __map?: { getBearing(): number } };
          const bearing = container.__map?.getBearing() ?? 0;
          return bearing > 70 && bearing < 110;
        }),
      { timeout: 700 },
    )
    .toBe(true);
});
