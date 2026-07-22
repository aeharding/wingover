// Safe-area inset verification harness (see docs/INSETS.md). Standalone — NOT a
// Playwright spec (won't run in the suite), so run it by hand with the dev
// server up: `node e2e/inset-probe.mjs all` or `... <scenario-key>`.
//
// env(safe-area-inset-*) is 0 in headless Chromium, so a device is simulated by
// injecting the UPSTREAM var --safe-area-inset-* (which Ionic's inheriting
// --ion-safe-area-* derives from) with DISTINCT per-edge values, so any leak is
// unmistakable: TOP=11 RIGHT=22 BOTTOM=33 LEFT=44 (22 on a right edge = correct,
// 44 on a right edge = a left leak, 0 = consumed). It prints each surface's
// resolved padding/position and, for ion-items, the shadow .item-inner /
// .item-native padding — where Ionic actually injects the inset.
import { chromium } from "@playwright/test";

const BASE = "http://localhost:5173";
const INSETS = { top: 11, right: 22, bottom: 33, left: 44 };
const INJECT = `:root{--safe-area-inset-top:${INSETS.top}px;--safe-area-inset-right:${INSETS.right}px;--safe-area-inset-bottom:${INSETS.bottom}px;--safe-area-inset-left:${INSETS.left}px}`;

// The measurement function runs in-page. Returns per-selector geometry plus,
// for ion-items, the shadow .item-inner / .item-native padding (where Ionic
// actually injects --ion-safe-area-*).
const MEASURE = (specs) => {
  const px = (v) => Math.round(parseFloat(v) || 0);
  const one = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const out = {
      pad: [
        px(cs.paddingTop),
        px(cs.paddingRight),
        px(cs.paddingBottom),
        px(cs.paddingLeft),
      ],
      mar: [
        px(cs.marginTop),
        px(cs.marginRight),
        px(cs.marginBottom),
        px(cs.marginLeft),
      ],
      pos: [
        cs.top === "auto" ? "auto" : px(cs.top),
        cs.right === "auto" ? "auto" : px(cs.right),
        cs.bottom === "auto" ? "auto" : px(cs.bottom),
        cs.left === "auto" ? "auto" : px(cs.left),
      ],
      w: px(cs.width),
    };
    const sr = el.shadowRoot;
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
  const res = {};
  for (const [name, sel] of Object.entries(specs)) {
    res[name] = one(document.querySelector(sel));
  }
  return res;
};

const GPX = "screenshots/assets/flight-b.gpx";

async function importFlight(p) {
  const input = await p.$("[data-testid=gpx-input]");
  if (!input) return false;
  await input.setInputFiles(GPX).catch(() => {});
  await p.waitForTimeout(1500);
  return true;
}

// ── scenarios ──────────────────────────────────────────────────────────────
const scenarios = {
  "d-logbook": {
    vp: { width: 1200, height: 800 },
    url: "/logbook?map-style=blank",
    flight: true,
    async after(p) {
      await p
        .locator('[data-testid="flight-row"]')
        .first()
        .click()
        .catch(() => {});
      await p.waitForTimeout(900);
    },
    specs: {
      rail: ".desktop-rail",
      railBrand: ".rail-brand",
      paneHeader: ".pane-header",
      paneScroll: ".logbook-pane-scroll",
      paneItem: ".logbook-pane ion-item",
      seatMapOverlay: ".seat-map .map-overlay",
      seatProbe: ".seat-map .map-inset-probe",
      seatCard: ".seat-card",
      seatCardItem: ".seat-card ion-item",
    },
  },
  "d-logbook-replay": {
    vp: { width: 1200, height: 800 },
    url: "/logbook?map-style=blank",
    flight: true,
    async after(p) {
      await p
        .locator('[data-testid="flight-row"]')
        .first()
        .click()
        .catch(() => {});
      await p.waitForTimeout(900);
      await p
        .locator('[data-testid="replay-start"]')
        .first()
        .click()
        .catch(() => {});
      await p.waitForTimeout(700);
    },
    specs: {
      seatProbe: ".seat-map .map-inset-probe",
      seatMapOverlay: ".seat-map .map-overlay",
      scrub: '[data-testid="replay-dock"]',
    },
  },
  "d-logbook-full-replay": {
    // Full screen (rail hidden) with the scrub open: the seat reaches the
    // device LEFT edge, so both the map AND the sibling scrub must restore it.
    vp: { width: 1200, height: 800 },
    url: "/logbook?map-style=blank",
    flight: true,
    async after(p) {
      await p
        .locator('[data-testid="flight-row"]')
        .first()
        .click()
        .catch(() => {});
      await p.waitForTimeout(900);
      await p
        .locator('[data-testid="replay-start"]')
        .first()
        .click()
        .catch(() => {});
      await p.waitForTimeout(500);
      await p
        .locator("[data-testid=map-expand]")
        .first()
        .click()
        .catch(() => {});
      await p.waitForTimeout(700);
    },
    specs: {
      seatProbe: ".seat-map .map-inset-probe",
      seatMapOverlay: ".seat-map .map-overlay",
      scrub: '[data-testid="replay-dock"]',
    },
  },
  "d-plan": {
    vp: { width: 1200, height: 800 },
    url: "/plan?map-style=blank",
    specs: {
      planProbe: ".plan-map .map-inset-probe",
      planOverlay: ".plan-map .map-overlay",
      planPane: ".plan-pane",
      planPaneRows: ".plan-pane-rows",
      planPaneEmpty: ".plan-pane-empty",
    },
  },
  "d-settings": {
    vp: { width: 1200, height: 800 },
    url: "/settings?map-style=blank",
    async after(p) {
      await p.waitForTimeout(500);
    },
    specs: {
      firstItem: ".desktop-main ion-item",
      header: ".desktop-main ion-toolbar",
      content: ".desktop-main ion-content",
    },
  },
  "d-allflights": {
    vp: { width: 1200, height: 800 },
    url: "/logbook/map?map-style=blank",
    flight: true,
    async after(p) {
      await p.waitForTimeout(800);
    },
    specs: {
      probe: '[data-testid="all-flights-map"] .map-inset-probe',
      overlay: '[data-testid="all-flights-map"] .map-overlay',
      legend: '[data-testid="composite-legend"]',
      header: ".desktop-main ion-toolbar",
    },
  },
  "m-logbook": {
    vp: { width: 390, height: 844 },
    url: "/logbook?map-style=blank",
    flight: true,
    async after(p) {
      await p.waitForTimeout(600);
    },
    specs: {
      header: "ion-header ion-toolbar",
      content: "ion-content",
      firstItem: "ion-content ion-item",
    },
  },
  "m-logbook-land": {
    vp: { width: 844, height: 390 },
    url: "/logbook?map-style=blank",
    flight: true,
    async after(p) {
      await p.waitForTimeout(600);
    },
    specs: {
      header: "ion-header ion-toolbar",
      content: "ion-content",
      firstItem: "ion-content ion-item",
    },
  },
  "m-detail": {
    vp: { width: 390, height: 844 },
    url: "/logbook?map-style=blank",
    flight: true,
    async after(p) {
      await p
        .locator('[data-testid="flight-row"]')
        .first()
        .click()
        .catch(() => {});
      await p.waitForTimeout(1000);
    },
    specs: {
      header: "ion-header ion-toolbar",
      probe: ".flight-detail-map .map-inset-probe",
      overlay: ".flight-detail-map .map-overlay",
      formItem: "ion-content ion-item",
    },
  },
  "m-detail-full": {
    vp: { width: 844, height: 390 },
    url: "/logbook?map-style=blank",
    flight: true,
    async after(p) {
      await p
        .locator('[data-testid="flight-row"]')
        .first()
        .click()
        .catch(() => {});
      await p.waitForTimeout(1000);
      await p
        .locator("[data-testid=map-expand]")
        .first()
        .click()
        .catch(() => {});
      await p.waitForTimeout(900);
    },
    specs: {
      probe: ".flight-detail-map .map-inset-probe",
      overlay: ".flight-detail-map .map-overlay",
    },
  },
  "m-detail-full-replay": {
    vp: { width: 844, height: 390 },
    url: "/logbook?map-style=blank",
    flight: true,
    async after(p) {
      await p
        .locator('[data-testid="flight-row"]')
        .first()
        .click()
        .catch(() => {});
      await p.waitForTimeout(1000);
      await p
        .locator("[data-testid=map-expand]")
        .first()
        .click()
        .catch(() => {});
      await p.waitForTimeout(900);
      await p
        .locator('[data-testid="replay-start"]')
        .first()
        .click()
        .catch(() => {});
      await p.waitForTimeout(700);
    },
    specs: {
      probe: ".flight-detail-map .map-inset-probe",
      overlay: ".flight-detail-map .map-overlay",
      scrub: '[data-testid="replay-dock"]',
    },
  },
  "m-plan": {
    vp: { width: 844, height: 390 },
    url: "/plan?map-style=blank",
    specs: {
      probe: ".plan-map .map-inset-probe",
      overlay: ".plan-map .map-overlay",
      pill: '[data-testid="plan-distance"]',
    },
  },
  "m-settings": {
    vp: { width: 390, height: 844 },
    url: "/settings?map-style=blank",
    async after(p) {
      await p.waitForTimeout(500);
    },
    specs: {
      header: "ion-header ion-toolbar",
      firstItem: "ion-content ion-item",
    },
  },
  "m-allflights": {
    vp: { width: 844, height: 390 },
    url: "/logbook/map?map-style=blank",
    flight: true,
    async after(p) {
      await p.waitForTimeout(800);
    },
    specs: {
      probe: '[data-testid="all-flights-map"] .map-inset-probe',
      overlay: '[data-testid="all-flights-map"] .map-overlay',
      legend: '[data-testid="composite-legend"]',
      header: "ion-header ion-toolbar",
    },
  },
};

async function run(key, browser) {
  const s = scenarios[key];
  if (!s) throw new Error("unknown scenario " + key);
  const ctx = await browser.newContext({ viewport: s.vp });
  const p = await ctx.newPage();
  // enable Fly recording for parity (harmless elsewhere)
  await p.addInitScript(() => {
    try {
      localStorage.setItem("wingover.record", "1");
    } catch {
      /* storage may be unavailable; the scenario just won't reach Fly */
    }
  });
  await p.goto(BASE + s.url, { waitUntil: "networkidle" });
  await p.waitForTimeout(500);
  if (s.flight) await importFlight(p);
  if (s.after) await s.after(p);
  await p.addStyleTag({ content: INJECT });
  await p.waitForTimeout(350);
  const data = await p.evaluate(MEASURE, s.specs);
  await ctx.close();
  return data;
}

const arg = process.argv[2] || "all";
const keys = arg === "all" ? Object.keys(scenarios) : [arg];
const browser = await chromium.launch();
console.log(
  `INSETS  T=${INSETS.top} R=${INSETS.right} B=${INSETS.bottom} L=${INSETS.left}   (pad/pos/mar order = [T R B L])`,
);
for (const k of keys) {
  let data;
  try {
    data = await run(k, browser);
  } catch (e) {
    console.log(`\n### ${k}  ERROR: ${e.message}`);
    continue;
  }
  console.log(`\n### ${k}`);
  for (const [name, m] of Object.entries(data)) {
    if (!m) {
      console.log(`  ${name.padEnd(16)} MISSING`);
      continue;
    }
    let extra = "";
    if (m.itemInner)
      extra += ` itemInner[L${m.itemInner.padL} R${m.itemInner.padR}]`;
    if (m.itemNative)
      extra += ` itemNative[L${m.itemNative.padL} R${m.itemNative.padR}]`;
    if (m.toolbar)
      extra += ` toolbar[L${m.toolbar.padL} R${m.toolbar.padR} T${m.toolbar.padT}]`;
    console.log(
      `  ${name.padEnd(16)} pad[${m.pad.join(" ")}] pos[${m.pos.join(" ")}] mar[${m.mar.join(" ")}] w=${m.w}${extra}`,
    );
  }
}
await browser.close();
