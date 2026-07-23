// Safe-area inset ENFORCEMENT (see docs/INSETS.md). This is the CI-run successor
// to the old standalone inset-probe harness: it drives the same ~14
// scenarios, but ASSERTS the inset-derived numbers instead of printing them.
//
// env(safe-area-inset-*) is 0 in headless Chromium, so a device is simulated by
// injecting the UPSTREAM var --safe-area-inset-* (from which Ionic's inheriting
// --ion-safe-area-* derives) with DISTINCT per-edge values, so any leak is
// unmistakable: TOP=11 RIGHT=22 BOTTOM=33 LEFT=44 (22 on a right edge = correct,
// 44 on a right edge = a left leak, 0 = consumed). We read each surface's
// resolved padding/position and, for ion-items, the shadow .item-inner /
// .item-native padding — where Ionic actually injects --ion-safe-area-*.
//
// Every expected number is derived from the docs/INSETS.md verified matrix
// (injected T=11 R=22 B=33 L=44); each assertion carries its formula. Values
// built purely from integer px use exact equality; values that fold a rem-based
// chrome constant (14.4, 41.6, 9.6, 17.6, 51.2 …) round sub-pixel, so those use
// a ±1 tolerance.
import { expect, test } from "@playwright/test";

type Page = import("@playwright/test").Page;

// ── injected device insets ───────────────────────────────────────────────────
const INSETS = { top: 11, right: 22, bottom: 33, left: 44 } as const;
const INJECT = `:root{--safe-area-inset-top:${INSETS.top}px;--safe-area-inset-right:${INSETS.right}px;--safe-area-inset-bottom:${INSETS.bottom}px;--safe-area-inset-left:${INSETS.left}px}`;

// Same recorded flight the harness used, so the seeded geometry matches the
// verified baseline. One import per scenario (each test is its own page).
const GPX = "screenshots/assets/flight-b.gpx";

interface Measured {
  pad: [number, number, number, number]; // [T R B L]
  pos: [number | "auto", number | "auto", number | "auto", number | "auto"]; // [T R B L]
  w: number;
  itemInner?: { padL: number; padR: number };
  itemNative?: { padL: number; padR: number };
  toolbar?: { padL: number; padR: number; padT: number };
}

// Runs in-page. For each selector returns padding/position (+ width) and, for
// ion-items, the shadow .item-inner / .item-native padding and the toolbar
// container padding. Ported verbatim from the old harness's MEASURE.
async function measure(
  page: Page,
  specs: Record<string, string>,
): Promise<Record<string, Measured | null>> {
  return page.evaluate((specsArg): Record<string, Measured | null> => {
    const px = (v: string) => Math.round(parseFloat(v) || 0);
    const one = (el: Element | null): Measured | null => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const out: Measured = {
        pad: [
          px(cs.paddingTop),
          px(cs.paddingRight),
          px(cs.paddingBottom),
          px(cs.paddingLeft),
        ],
        pos: [
          cs.top === "auto" ? "auto" : px(cs.top),
          cs.right === "auto" ? "auto" : px(cs.right),
          cs.bottom === "auto" ? "auto" : px(cs.bottom),
          cs.left === "auto" ? "auto" : px(cs.left),
        ],
        w: px(cs.width),
      };
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) {
        const inner = sr.querySelector(".item-inner");
        const native = sr.querySelector(".item-native");
        const tb = sr.querySelector(".toolbar-container");
        if (inner)
          out.itemInner = {
            padL: px(getComputedStyle(inner).paddingLeft),
            padR: px(getComputedStyle(inner).paddingRight),
          };
        if (native)
          out.itemNative = {
            padL: px(getComputedStyle(native).paddingLeft),
            padR: px(getComputedStyle(native).paddingRight),
          };
        if (tb)
          out.toolbar = {
            padL: px(getComputedStyle(tb).paddingLeft),
            padR: px(getComputedStyle(tb).paddingRight),
            padT: px(getComputedStyle(tb).paddingTop),
          };
      }
      return out;
    };
    const res: Record<string, Measured | null> = {};
    for (const [name, sel] of Object.entries(specsArg)) {
      res[name] = one(document.querySelector(sel));
    }
    return res;
  }, specs);
}

// Enable Fly recording (harmless where unused) before navigation, matching the
// harness init script.
async function primeRecording(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("wingover.record", "1");
    } catch {
      /* storage may be unavailable; the scenario just won't reach Fly */
    }
  });
}

// Import the recorded flight via the hidden GPX input (best-effort, like the
// harness: the all-flights map route has no input, and the probe assertions
// there don't need a seeded flight).
async function seedFlight(page: Page) {
  const input = page.getByTestId("gpx-input").first();
  if (await input.count()) {
    await input.setInputFiles(GPX);
    await page.waitForTimeout(1500);
  }
}

// Inject the distinct per-edge insets, then let the map bridge / layout settle.
async function injectInsets(page: Page) {
  await page.addStyleTag({ content: INJECT });
  await page.waitForTimeout(350);
}

function cell(data: Record<string, Measured | null>, key: string): Measured {
  const m = data[key];
  expect(m, `measured surface "${key}" must be present`).not.toBeNull();
  return m as Measured;
}

// ±1 tolerance for values that fold a non-integer (rem-based) chrome constant.
function approx(actual: number | "auto", expected: number) {
  expect(typeof actual, "position/padding must resolve to a number").toBe(
    "number",
  );
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(1);
}

const flightRow = (page: Page) => page.getByTestId("flight-row").first();

// ── DESKTOP (≥992px → DesktopShell, rail owns the LEFT edge) ─────────────────

test.describe("insets · d-logbook (rail + pane + seat, scrub closed)", () => {
  test.use({ viewport: { width: 1200, height: 800 } });

  test("rail/pane/seat inset off the right, left, bottom edges", async ({
    page,
  }) => {
    await primeRecording(page);
    await page.goto("/logbook?map-style=blank");
    await seedFlight(page);
    await expect(flightRow(page)).toBeVisible({ timeout: 10_000 });
    await flightRow(page).click();
    await expect(page.getByTestId("seat-map")).toBeVisible();
    await injectInsets(page);

    const d = await measure(page, {
      rail: '[data-testid="desktop-rail"]',
      paneHeader: '[data-testid="pane-header"]',
      paneScroll: '[data-testid="logbook-pane-scroll"]',
      logbookItem: '[data-testid="logbook-pane-scroll"] ion-item',
      seatProbe: '[data-testid="seat-map"] [data-testid="map-inset-probe"]',
      seatOverlay: '[data-testid="seat-map"] [data-testid="map-overlay"]',
      seatCard: '[data-testid="seat-card"]',
      seatCardItem: '[data-testid="seat-card"] ion-item',
    });

    const rail = cell(d, "rail");
    expect(rail.pad[0]).toBe(21); // top: 10 chrome + 11 injected top
    expect(rail.pad[1]).toBe(0); // right: interior edge, no inset
    expect(rail.pad[2]).toBe(33); // bottom: 33 injected bottom
    expect(rail.pad[3]).toBe(44); // left: 44 injected left (rail owns the edge)
    expect(rail.w).toBe(120); // width: 76 base + 44 left inset

    approx(cell(d, "paneHeader").pad[0], 21); // top: 9.6 chrome + 11 injected top
    expect(cell(d, "paneScroll").pad[2]).toBe(33); // bottom: 33 injected bottom

    const item = cell(d, "logbookItem");
    expect(item.itemInner?.padR).toBe(16); // R: 16 base end + 0 consumed right (no +22 leak)
    expect(item.itemNative?.padL).toBe(16); // L: 16 base start + 0 (rail owns left, no +44 leak)

    const probe = cell(d, "seatProbe");
    expect(probe.pad[0]).toBe(11); // top: 11 injected (device top)
    expect(probe.pad[1]).toBe(22); // right: 22 injected (device right)
    expect(probe.pad[2]).toBe(33); // bottom: 33 injected (scrub closed)
    expect(probe.pad[3]).toBe(0); // left: 0 (rail owns left)

    const overlay = cell(d, "seatOverlay");
    approx(overlay.pos[2], 75); // bottom: 41.6 chrome + 33 injected bottom
    approx(overlay.pos[3], 14); // left: 14.4 chrome + 0 (rail owns left)

    const card = cell(d, "seatCard");
    approx(card.pos[0], 25); // top pos: 14.4 chrome + 11 raw top inset
    approx(card.pos[1], 36); // right pos: 14.4 chrome + 22 raw right inset

    const cardItem = cell(d, "seatCardItem");
    expect(cardItem.itemInner?.padR).toBe(16); // R: 16 base + 0 (card consumed right)
    expect(cardItem.itemNative?.padL).toBe(16); // L: 16 base + 0 (rail owns left)
  });
});

test.describe("insets · d-logbook-replay (windowed, scrub open)", () => {
  test.use({ viewport: { width: 1200, height: 800 } });

  test("scrub-open consumes the seat bottom; dock re-adds right, keeps left", async ({
    page,
  }) => {
    await primeRecording(page);
    await page.goto("/logbook?map-style=blank");
    await seedFlight(page);
    await expect(flightRow(page)).toBeVisible({ timeout: 10_000 });
    await flightRow(page).click();
    await expect(page.getByTestId("seat-map")).toBeVisible();
    await page.getByTestId("replay-start").first().click();
    await expect(page.getByTestId("replay-dock")).toBeVisible();
    await injectInsets(page);

    const d = await measure(page, {
      seatProbe: '[data-testid="seat-map"] [data-testid="map-inset-probe"]',
      seatOverlay: '[data-testid="seat-map"] [data-testid="map-overlay"]',
      scrub: '[data-testid="replay-dock"]',
    });

    const probe = cell(d, "seatProbe");
    expect(probe.pad[0]).toBe(11); // top: 11 injected
    expect(probe.pad[1]).toBe(22); // right: 22 injected
    expect(probe.pad[2]).toBe(0); // bottom: 0 (scrub open owns the bottom)
    expect(probe.pad[3]).toBe(0); // left: 0 (rail owns left, windowed)

    approx(cell(d, "seatOverlay").pos[2], 42); // bottom: 41.6 chrome + 0 (scrub open)
    approx(cell(d, "seatOverlay").pos[3], 14); // left: 14.4 chrome + 0 (rail owns left)

    const scrub = cell(d, "scrub");
    approx(scrub.pad[1], 40); // right gutter: 1.1rem (17.6) base + 22 injected right
    approx(scrub.pad[3], 18); // left gutter: 1.1rem base + 0 (rail owns left)
  });
});

test.describe("insets · d-logbook-full-replay (rail hidden, left re-exposed)", () => {
  test.use({ viewport: { width: 1200, height: 800 } });

  test("full screen restores the LEFT inset to seat AND its sibling scrub", async ({
    page,
  }) => {
    await primeRecording(page);
    await page.goto("/logbook?map-style=blank");
    await seedFlight(page);
    await expect(flightRow(page)).toBeVisible({ timeout: 10_000 });
    await flightRow(page).click();
    await expect(page.getByTestId("seat-map")).toBeVisible();
    await page.getByTestId("replay-start").first().click();
    await expect(page.getByTestId("replay-dock")).toBeVisible();
    await page.getByTestId("map-expand").first().click();
    await page.waitForTimeout(700);
    await injectInsets(page);

    const d = await measure(page, {
      seatProbe: '[data-testid="seat-map"] [data-testid="map-inset-probe"]',
      seatOverlay: '[data-testid="seat-map"] [data-testid="map-overlay"]',
      scrub: '[data-testid="replay-dock"]',
    });

    const probe = cell(d, "seatProbe");
    expect(probe.pad[0]).toBe(11); // top: 11 injected
    expect(probe.pad[1]).toBe(22); // right: 22 injected
    expect(probe.pad[2]).toBe(0); // bottom: 0 (scrub open)
    expect(probe.pad[3]).toBe(44); // left: 44 restored (full screen re-exposes it)

    approx(cell(d, "seatOverlay").pos[2], 42); // bottom: 41.6 chrome + 0 (scrub open)
    approx(cell(d, "seatOverlay").pos[3], 58); // left: 14.4 chrome + 44 (left restored)

    const scrub = cell(d, "scrub");
    approx(scrub.pad[1], 40); // right gutter: 1.1rem base + 22 injected right
    approx(scrub.pad[3], 62); // left gutter: 1.1rem base + 44 restored left
  });
});

test.describe("insets · d-plan (desktop plan map + pane)", () => {
  test.use({ viewport: { width: 1200, height: 800 } });

  test("plan map keeps top/right/bottom; pane pads its own top/bottom", async ({
    page,
  }) => {
    await primeRecording(page);
    await page.goto("/plan?map-style=blank");
    await expect(page.getByTestId("plan-map")).toBeVisible();
    await injectInsets(page);

    const d = await measure(page, {
      planProbe: '[data-testid="plan-map"] [data-testid="map-inset-probe"]',
      planOverlay: '[data-testid="plan-map"] [data-testid="map-overlay"]',
      planPane: '[data-testid="plan-pane"]',
    });

    const probe = cell(d, "planProbe");
    expect(probe.pad[0]).toBe(11); // top: 11 injected (device top)
    expect(probe.pad[1]).toBe(22); // right: 22 injected
    expect(probe.pad[2]).toBe(33); // bottom: 33 injected (device bottom)
    expect(probe.pad[3]).toBe(0); // left: 0 (rail owns left)

    approx(cell(d, "planOverlay").pos[1], 36); // right: 14.4 chrome + 22 injected right
    approx(cell(d, "planOverlay").pos[2], 47); // bottom: 14.4 chrome + 33 injected bottom

    const pane = cell(d, "planPane");
    expect(pane.pad[0]).toBe(11); // top: 11 injected (pane pads its own top)
    expect(pane.pad[2]).toBe(33); // bottom: 33 injected
  });
});

test.describe("insets · d-settings (centered column consumes right)", () => {
  test.use({ viewport: { width: 1200, height: 800 } });

  test("settings items stay base-16; header keeps top+right, drops left", async ({
    page,
  }) => {
    await primeRecording(page);
    await page.goto("/settings?map-style=blank");
    await expect(
      page.locator('[data-testid="desktop-main"] ion-item').first(),
    ).toBeVisible();
    await injectInsets(page);

    const d = await measure(page, {
      firstItem: '[data-testid="desktop-main"] ion-item',
      header: '[data-testid="desktop-main"] ion-toolbar',
    });

    const item = cell(d, "firstItem");
    expect(item.itemInner?.padR).toBe(16); // R: 16 base + 0 consumed (centered col stepped off the notch)
    expect(item.itemNative?.padL).toBe(16); // L: 16 base + 0 (rail owns left)

    const header = cell(d, "header");
    expect(header.pad[0]).toBe(11); // top: 11 injected
    expect(header.pad[1]).toBe(22); // right: 22 injected (main reaches device right)
    expect(header.pad[3]).toBe(0); // left: 0 (rail owns left)
  });
});

test.describe("insets · d-allflights (opaque header owns top)", () => {
  test.use({ viewport: { width: 1200, height: 800 } });

  test("all-flights probe drops top to the header, keeps right+bottom", async ({
    page,
  }) => {
    await primeRecording(page);
    await page.goto("/logbook/map?map-style=blank");
    await seedFlight(page);
    await expect(page.getByTestId("all-flights-map")).toBeVisible();
    await injectInsets(page);

    const d = await measure(page, {
      probe: '[data-testid="all-flights-map"] [data-testid="map-inset-probe"]',
      overlay: '[data-testid="all-flights-map"] [data-testid="map-overlay"]',
      legend: '[data-testid="composite-legend"]',
      header: '[data-testid="desktop-main"] ion-toolbar',
    });

    const probe = cell(d, "probe");
    expect(probe.pad[0]).toBe(0); // top: 0 (opaque header owns it)
    expect(probe.pad[1]).toBe(22); // right: 22 injected
    expect(probe.pad[2]).toBe(33); // bottom: 33 injected (device bottom)
    expect(probe.pad[3]).toBe(0); // left: 0 (rail owns left)

    approx(cell(d, "overlay").pos[1], 36); // right: 14.4 chrome + 22 injected right
    approx(cell(d, "overlay").pos[2], 47); // bottom: 14.4 chrome + 33 injected bottom

    approx(cell(d, "legend").pos[3], 14); // left: 14.4 chrome + 0 (rail owns left)

    const header = cell(d, "header");
    expect(header.pad[0]).toBe(11); // top: 11 injected
    expect(header.pad[1]).toBe(22); // right: 22 injected
    expect(header.pad[3]).toBe(0); // left: 0 (rail owns left)
  });
});

// ── MOBILE (<992px → IonTabs; notch on left, tab bar owns bottom) ────────────

test.describe("insets · m-logbook (portrait phone list)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("header + list items inset off the notch (top/right/left)", async ({
    page,
  }) => {
    await primeRecording(page);
    await page.goto("/logbook?map-style=blank");
    await seedFlight(page);
    await expect(page.locator("ion-content ion-item").first()).toBeVisible();
    await injectInsets(page);

    const d = await measure(page, {
      header: "ion-header ion-toolbar",
      firstItem: "ion-content ion-item",
    });

    const header = cell(d, "header");
    expect(header.pad[0]).toBe(11); // top: 11 injected
    expect(header.pad[1]).toBe(22); // right: 22 injected
    expect(header.pad[3]).toBe(44); // left: 44 injected (real device edge)

    const item = cell(d, "firstItem");
    expect(item.itemInner?.padR).toBe(38); // R: 16 base end + 22 injected right
    expect(item.itemNative?.padL).toBe(60); // L: 16 base start + 44 injected left
  });
});

test.describe("insets · m-logbook-land (landscape phone list)", () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test("insets pass through unchanged in landscape", async ({ page }) => {
    await primeRecording(page);
    await page.goto("/logbook?map-style=blank");
    await seedFlight(page);
    await expect(page.locator("ion-content ion-item").first()).toBeVisible();
    await injectInsets(page);

    const d = await measure(page, {
      header: "ion-header ion-toolbar",
      firstItem: "ion-content ion-item",
    });

    const header = cell(d, "header");
    expect(header.pad[0]).toBe(11); // top: 11 injected
    expect(header.pad[1]).toBe(22); // right: 22 injected
    expect(header.pad[3]).toBe(44); // left: 44 injected

    const item = cell(d, "firstItem");
    expect(item.itemInner?.padR).toBe(38); // R: 16 base + 22 injected right
    expect(item.itemNative?.padL).toBe(60); // L: 16 base + 44 injected left
  });
});

test.describe("insets · m-detail (inline preview is boxed)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("inline map probe is fully boxed (all insets 0); form items inset", async ({
    page,
  }) => {
    await primeRecording(page);
    await page.goto("/logbook?map-style=blank");
    await seedFlight(page);
    await expect(flightRow(page)).toBeVisible({ timeout: 10_000 });
    await flightRow(page).click();
    await expect(page.getByTestId("flight-detail-map")).toBeVisible();
    await injectInsets(page);

    const d = await measure(page, {
      header: "ion-header ion-toolbar",
      probe:
        '[data-testid="flight-detail-map"] [data-testid="map-inset-probe"]',
      formItem: "ion-content ion-item",
    });

    const header = cell(d, "header");
    expect(header.pad[0]).toBe(11); // top: 11 injected
    expect(header.pad[1]).toBe(22); // right: 22 injected
    expect(header.pad[3]).toBe(44); // left: 44 injected

    const probe = cell(d, "probe");
    expect(probe.pad).toEqual([0, 0, 0, 0]); // boxed inline preview: no edge reaches it

    const item = cell(d, "formItem");
    expect(item.itemInner?.padR).toBe(38); // R: 16 base + 22 injected right
    expect(item.itemNative?.padL).toBe(60); // L: 16 base + 44 injected left
  });
});

test.describe("insets · m-detail-full (fullscreen detail map, scrub closed)", () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test("fullscreen detail map reaches all four device edges", async ({
    page,
  }) => {
    await primeRecording(page);
    await page.goto("/logbook?map-style=blank");
    await seedFlight(page);
    await expect(flightRow(page)).toBeVisible({ timeout: 10_000 });
    await flightRow(page).click();
    await expect(page.getByTestId("flight-detail-map")).toBeVisible();
    await page.getByTestId("map-expand").first().click();
    await expect(page.getByTestId("flight-detail-map-fullroot")).toBeVisible();
    await injectInsets(page);

    const d = await measure(page, {
      probe:
        '[data-testid="flight-detail-map"] [data-testid="map-inset-probe"]',
      overlay: '[data-testid="flight-detail-map"] [data-testid="map-overlay"]',
    });

    const probe = cell(d, "probe");
    expect(probe.pad[0]).toBe(11); // top: 11 injected
    expect(probe.pad[1]).toBe(22); // right: 22 injected
    expect(probe.pad[2]).toBe(33); // bottom: 33 injected (scrub closed)
    expect(probe.pad[3]).toBe(44); // left: 44 injected

    approx(cell(d, "overlay").pos[1], 36); // right: 14.4 chrome + 22 injected right
    approx(cell(d, "overlay").pos[2], 47); // bottom: 14.4 chrome + 33 injected bottom
  });
});

test.describe("insets · m-detail-full-replay (fullscreen detail, scrub open)", () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test("scrub-open consumes bottom; dock adds right + full left", async ({
    page,
  }) => {
    await primeRecording(page);
    await page.goto("/logbook?map-style=blank");
    await seedFlight(page);
    await expect(flightRow(page)).toBeVisible({ timeout: 10_000 });
    await flightRow(page).click();
    await expect(page.getByTestId("flight-detail-map")).toBeVisible();
    await page.getByTestId("map-expand").first().click();
    await expect(page.getByTestId("flight-detail-map-fullroot")).toBeVisible();
    await page.getByTestId("replay-start").first().click();
    await expect(page.getByTestId("replay-dock")).toBeVisible();
    await injectInsets(page);

    const d = await measure(page, {
      probe:
        '[data-testid="flight-detail-map"] [data-testid="map-inset-probe"]',
      overlay: '[data-testid="flight-detail-map"] [data-testid="map-overlay"]',
      scrub: '[data-testid="replay-dock"]',
    });

    const probe = cell(d, "probe");
    expect(probe.pad[0]).toBe(11); // top: 11 injected
    expect(probe.pad[1]).toBe(22); // right: 22 injected
    expect(probe.pad[2]).toBe(0); // bottom: 0 (scrub open owns it)
    expect(probe.pad[3]).toBe(44); // left: 44 injected

    approx(cell(d, "overlay").pos[1], 36); // right: 14.4 chrome + 22 injected right
    approx(cell(d, "overlay").pos[2], 14); // bottom: 14.4 chrome + 0 (scrub open)

    const scrub = cell(d, "scrub");
    approx(scrub.pad[1], 34); // right gutter: 0.75rem (12) base + 22 injected right
    approx(scrub.pad[3], 56); // left gutter: 0.75rem (12) base + 44 injected left
  });
});

test.describe("insets · m-plan (no header, tab bar owns bottom)", () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test("plan probe: device top+right+left, tab bar consumes bottom", async ({
    page,
  }) => {
    await primeRecording(page);
    await page.goto("/plan?map-style=blank");
    await expect(page.getByTestId("plan-map")).toBeVisible();
    await injectInsets(page);

    // The distance pill (plan-distance) has no route in this scenario, so it is
    // deliberately absent and left untested.
    const d = await measure(page, {
      probe: '[data-testid="plan-map"] [data-testid="map-inset-probe"]',
      overlay: '[data-testid="plan-map"] [data-testid="map-overlay"]',
    });

    const probe = cell(d, "probe");
    expect(probe.pad[0]).toBe(11); // top: 11 injected (no header, real device edge)
    expect(probe.pad[1]).toBe(22); // right: 22 injected
    expect(probe.pad[2]).toBe(0); // bottom: 0 (tab bar owns it)
    expect(probe.pad[3]).toBe(44); // left: 44 injected

    approx(cell(d, "overlay").pos[1], 36); // right: 14.4 chrome + 22 injected right
    approx(cell(d, "overlay").pos[2], 14); // bottom: 14.4 chrome + 0 (tab bar consumed)
  });
});

test.describe("insets · m-settings (phone settings list)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("header + settings items inset off the notch", async ({ page }) => {
    await primeRecording(page);
    await page.goto("/settings?map-style=blank");
    await expect(page.locator("ion-content ion-item").first()).toBeVisible();
    await injectInsets(page);

    const d = await measure(page, {
      header: "ion-header ion-toolbar",
      firstItem: "ion-content ion-item",
    });

    const header = cell(d, "header");
    expect(header.pad[0]).toBe(11); // top: 11 injected
    expect(header.pad[1]).toBe(22); // right: 22 injected
    expect(header.pad[3]).toBe(44); // left: 44 injected

    const item = cell(d, "firstItem");
    expect(item.itemInner?.padR).toBe(38); // R: 16 base + 22 injected right
    expect(item.itemNative?.padL).toBe(60); // L: 16 base + 44 injected left
  });
});

test.describe("insets · m-allflights (opaque header + tab bar)", () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test("probe drops top+bottom to header/tab bar; legend clears the notch", async ({
    page,
  }) => {
    await primeRecording(page);
    await page.goto("/logbook/map?map-style=blank");
    await seedFlight(page);
    await expect(page.getByTestId("all-flights-map")).toBeVisible();
    await injectInsets(page);

    const d = await measure(page, {
      probe: '[data-testid="all-flights-map"] [data-testid="map-inset-probe"]',
      overlay: '[data-testid="all-flights-map"] [data-testid="map-overlay"]',
      legend: '[data-testid="composite-legend"]',
      header: "ion-header ion-toolbar",
    });

    const probe = cell(d, "probe");
    expect(probe.pad[0]).toBe(0); // top: 0 (opaque header owns it)
    expect(probe.pad[1]).toBe(22); // right: 22 injected
    expect(probe.pad[2]).toBe(0); // bottom: 0 (tab bar owns it)
    expect(probe.pad[3]).toBe(44); // left: 44 injected

    approx(cell(d, "overlay").pos[1], 36); // right: 14.4 chrome + 22 injected right
    approx(cell(d, "overlay").pos[2], 14); // bottom: 14.4 chrome + 0 (tab bar consumed)

    const legend = cell(d, "legend");
    approx(legend.pos[2], 51); // bottom: 3.2rem (51.2) base + 0 (tab bar consumed)
    approx(legend.pos[3], 58); // left: 14.4 chrome + 44 injected left

    const header = cell(d, "header");
    expect(header.pad[0]).toBe(11); // top: 11 injected
    expect(header.pad[1]).toBe(22); // right: 22 injected
    expect(header.pad[3]).toBe(44); // left: 44 injected
  });
});
