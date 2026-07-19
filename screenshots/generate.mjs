import { spawn } from "child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import net from "net";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const require = createRequire("/home/aeharding/wingover/package.json");
const { chromium, webkit } = require("@playwright/test");
// Chromium by default: MapKit JS (Apple satellite) does NOT initialize in
// Playwright's WebKit build (window.mapkit stays undefined), and satellite is
// the whole point. Chromium uses the real embedded SF Pro OTFs, so device font
// fidelity is identical. ENGINE=webkit is kept only for non-map experiments.
const ENGINE = process.env.ENGINE === "webkit" ? webkit : chromium;
const HERE = dirname(fileURLToPath(import.meta.url));
const FRAME = "file://" + join(HERE, "frame.html");
const FRAME_DUO = "file://" + join(HERE, "frame-duo.html");
const PORT = 5173;
const BASE = `http://localhost:${PORT}`;
// Framed store shots are written straight into fastlane's folder (deliver
// groups by image DIMENSIONS and orders alphabetically, so the device prefix +
// leading shot number gives the right per-device order). The raw, un-framed
// captures go to out/raw for the web/README images (see web-optimize.mjs).
const FASTLANE = join(HERE, "..", "fastlane", "screenshots", "en-US");
const PREFIX = "iphone";

// ── devices ───────────────────────────────────────────────────────────
// out: exact App Store pixels. logical/dsf: the compose canvas (logical *
// dsf = out). app*: the viewport the real app is captured in. u: logical
// width / 100, so the template's var(--u) math scales phone<->iPad.
const DEVICES = {
  "iphone-6.9": {
    out: [1320, 2868], logical: [440, 956], dsf: 3,
    appVp: [393, 852], appDsf: 3, screenAr: "393 / 852", u: 4.4,
  },
};

// ── seed data ─────────────────────────────────────────────────────────
// Real GPX tracks parsed to the app's Fix[] shape (deriving speed/course/climb
// the way the engine does), seeded straight into the app's PouchDB via its own
// saveFlight — so the logbook/detail/map shots show authentic flights.
// Despike a position-derived series: median (±7) removes GPS jitter spikes,
// then a light mean (±5) smooths. Real 1 Hz GPS position can jump 30-55 m in a
// single second near the ground (multipath), which naive d/dt turns into
// impossible 100+ mph readings; on-device the app shows CLLocation's smooth
// doppler speed, and this reproduces that. Mean is preserved (~unchanged avg).
function smooth(a) {
  const med = a.map((_, i) => {
    const s = a.slice(Math.max(0, i - 7), i + 8).sort((x, y) => x - y);
    return s[s.length >> 1];
  });
  return med.map((_, i) => {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - 5); k <= Math.min(med.length - 1, i + 5); k++) { s += med[k]; n++; }
    return s / n;
  });
}

function toFixes(pts) {
  const R = 6371000, rad = Math.PI / 180;
  const der = pts.map((p, i) => {
    const prev = pts[i - 1];
    let speed = 0, course = 0, climbRate = 0;
    if (prev && p.t && prev.t) {
      const dt = (p.t - prev.t) / 1000 || 1;
      const dLat = (p.lat - prev.lat) * rad, dLon = (p.lon - prev.lon) * rad;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(prev.lat * rad) * Math.cos(p.lat * rad) * Math.sin(dLon / 2) ** 2;
      speed = (2 * R * Math.asin(Math.min(1, Math.sqrt(a)))) / dt;
      const y = Math.sin(dLon) * Math.cos(p.lat * rad);
      const x = Math.cos(prev.lat * rad) * Math.sin(p.lat * rad) - Math.sin(prev.lat * rad) * Math.cos(p.lat * rad) * Math.cos(dLon);
      course = (Math.atan2(y, x) / rad + 360) % 360;
      climbRate = (p.alt - prev.alt) / dt;
    }
    return { speed, course, climbRate };
  });
  const speed = smooth(der.map((d) => d.speed)); // stats read fix.speed directly
  return pts.map((p, i) => ({
    timestamp: p.t, latitude: p.lat, longitude: p.lon, altitude: p.alt,
    speed: speed[i], course: der[i].course, climbRate: der[i].climbRate,
    horizontalAccuracy: 5, verticalAccuracy: 5,
  }));
}

function gpxToFixes(file) {
  const xml = readFileSync(join(HERE, "assets", file), "utf8");
  const re = /<trkpt[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
  const pts = [];
  let m;
  while ((m = re.exec(xml))) {
    const ele = /<ele>([-\d.]+)<\/ele>/.exec(m[3]);
    const time = /<time>([^<]+)<\/time>/.exec(m[3]);
    pts.push({ lat: +m[1], lon: +m[2], alt: ele ? +ele[1] : 0, t: time ? Date.parse(time[1]) : null });
  }
  return toFixes(pts);
}

// Clip a GPX to its first `seconds` of track, in memory, so the hero can replay
// a real flight HELD mid-flight without committing a separate pre-clipped file.
// Keeps trkpts within `seconds` of the first fix and preserves the surrounding
// <gpx>/<trkseg> wrapper. (The on-screen timer measures from takeoff, which the
// engine detects a few minutes in, so the clip runs longer than it reads.)
function clipGpx(xml, seconds) {
  const matches = [...xml.matchAll(/<trkpt[\s\S]*?<\/trkpt>/g)];
  if (!matches.length) return xml;
  const t0 = Date.parse(/<time>([^<]+)<\/time>/.exec(matches[0][0])[1]);
  const kept = [];
  for (const m of matches) {
    const tm = /<time>([^<]+)<\/time>/.exec(m[0]);
    const t = tm ? Date.parse(tm[1]) : null;
    if (t != null && (t - t0) / 1000 > seconds) break;
    kept.push(m[0]);
  }
  const last = matches[matches.length - 1];
  return xml.slice(0, matches[0].index) + kept.join("\n      ") + xml.slice(last.index + last[0].length);
}

// A wandering synthetic track near (lng,lat) — the logbook list shows only
// date/duration/distance, so shape isn't scrutinized; it fills the book out.
function synthToFixes(lng, lat, alt, startIso, count) {
  const pts = [];
  let course = 40, la = lat, lo = lng;
  const start = Date.parse(startIso);
  for (let i = 0; i < count; i++) {
    course += Math.sin(i / 8) * 7 + Math.sin(i / 3.3) * 2.4;
    const cr = (course * Math.PI) / 180;
    la += (22 * Math.cos(cr)) / 111320;
    lo += (22 * Math.sin(cr)) / (111320 * Math.cos((la * Math.PI) / 180));
    pts.push({ lat: la, lon: lo, alt: alt + Math.sin(i / 12) * 60 + i * 0.2, t: start + i * 3000 });
  }
  return toFixes(pts);
}

// The logbook, with fun titles + launch sites. flight-a (real) is first so the
// detail shot opens a named, annotated flight.
const SEED_FLIGHTS = [
  { name: "Wing tip touches w/ Paul", launchName: "Oregon, WI",
    notes: "Clear, 4mph from NW, Paul followed on his slow student wing, I had to trim in to do tip touches.",
    fixes: gpxToFixes("flight-a.gpx") },
  // Durations tuned so the typical flight is ~1 hr, with one 2.5-hr XC (~40 mi).
  // synthToFixes: ~20 pts/min (3s cadence). Only the logbook LIST reads these.
  { name: "Driftless, 2 cloud layers", launchName: "Spring Green, WI", notes: "",
    fixes: synthToFixes(-90.06, 43.17, 225, "2025-09-14T22:10:00Z", 1100) }, // ~55 min
  { name: "Golden hour cruise", launchName: "Blue Mounds, WI", notes: "",
    fixes: synthToFixes(-89.83, 43.02, 390, "2025-07-12T23:40:00Z", 980) }, // ~49 min
  { name: "One-tank XC", launchName: "Blue Mounds, WI", notes: "",
    fixes: synthToFixes(-89.84, 43.03, 395, "2025-06-24T19:20:00Z", 3000) }, // 2.5 hr XC
  { name: "First flight of spring", launchName: "Brooklyn, WI", notes: "",
    fixes: synthToFixes(-89.38, 42.85, 300, "2025-03-29T21:00:00Z", 840) }, // ~42 min
  { name: "Engine issues, landed out", launchName: "Sugar River, WI", notes: "",
    fixes: synthToFixes(-89.55, 42.86, 305, "2025-05-18T17:30:00Z", 320) }, // ~16 min, landed out
  { name: "Sunset over the Wisconsin", launchName: "Spring Green, WI", notes: "",
    fixes: synthToFixes(-90.06, 43.17, 225, "2025-08-06T23:55:00Z", 1240) }, // ~62 min
  { name: "Morning glass, smooth as it gets", launchName: "Oregon, WI", notes: "",
    fixes: synthToFixes(-89.40, 42.88, 300, "2025-05-27T11:30:00Z", 1600) }, // ~80 min
].map((f) => ({ ...f, id: `recorded-${f.fixes[0].timestamp}`, startedAt: f.fixes[0].timestamp }));

// A short cross-country route for the Plan + in-flight-plan shots, over open
// Driftless ridge country (kept clear of towns — no overflying congested air).
const SEED_PINS = [
  [-90.33, 43.47], [-90.27, 43.51], [-90.21, 43.49], [-90.15, 43.55],
];

// Seed flights + pins straight into the app's own PouchDB, reusing its
// saveFlight/savePin (correct doc shape + gzipped track attachment). Runs in a
// page already on the app so Vite has served the modules; storage persists
// across the context, so every later shot sees the data.
async function seedData(page) {
  await page.evaluate(async (flights) => {
    const db = await import("/src/storage/db.ts");
    const { computeStats } = await import("/src/flight/stats.ts");
    const local = await import("/src/storage/local.ts");
    await local.setSetting("mapView", "satellite");
    // Clear any stray flights first — a hero/in-flight-plan mock recording
    // persists a flight doc, which would otherwise show as an untitled 9th
    // flight in the curated logbook.
    for (const existing of await db.listFlights()) await db.deleteFlight(existing.id);
    for (const f of flights) {
      await db.saveFlight(
        {
          id: f.id, name: f.name, notes: f.notes, startedAt: f.startedAt,
          stats: computeStats(f.fixes), updatedAt: Date.now(),
          launchAt: [f.fixes[0].longitude, f.fixes[0].latitude], launchName: f.launchName,
        },
        f.fixes,
      );
    }
  }, SEED_FLIGHTS);
}

// Pins are seeded SEPARATELY and only right before the plan shots. A live flight
// reads listPins() as its planned route, so pins present during the hero would
// wrongly flip its nav from "to launch" to "to waypoint" (pointing at a pin far
// away). Seeding after the hero keeps it clean.
async function seedPins(page) {
  await page.evaluate(async (pins) => {
    const db = await import("/src/storage/db.ts");
    const local = await import("/src/storage/local.ts");
    await local.setSetting("mapView", "satellite");
    let i = 0;
    for (const [lng, lat] of pins) {
      await db.savePin({
        id: crypto.randomUUID(), name: `Pin ${i + 1}`, notes: "",
        latitude: lat, longitude: lng,
        createdAt: Date.now() + i * 1000, updatedAt: Date.now() + i * 1000,
      });
      i++;
    }
  }, SEED_PINS);
}

// ── shots ─────────────────────────────────────────────────────────────
// headline: [brackets] mark the gold accent word.
const SHOTS = [
  {
    id: "1-inflight",
    headline: "A flight deck built for the [air].",
    sub: "No account. No telemetry.\nJust flying.",
    tone: "light",
    // Real default backend (Apple Maps / MapKit JS — its token authorizes on
    // localhost), satellite seeded below. A mid-flight CLIP of the real flight
    // (clipGpx), served at /__mock.gpx and replayed then HELD at its final
    // point: deterministic framing, and a stationary aircraft means no
    // follow-drift. 1672s lands on the "24:04 / +1,519 ft" hero moment.
    gpx: "flight-a.gpx",
    clip: 1672,
    url: "/?mock-speed=600&mock-gpx=/__mock.gpx",
    async prep(page) {
      await page.getByRole("button", { name: "Start Flight" }).click();
      await page.getByTestId("recording").waitFor({ timeout: 15000 });
      await page.locator(".map-container").first().waitFor({ timeout: 15000 });
      // Let the whole clipped track replay and the aircraft settle at its
      // final point (compression 300: a ~30min track replays in ~6s).
      await page.waitForTimeout(9000);
      // Aircraft is holding now; drop the follow ring for a clean frame, then
      // let MapKit finish the settled region.
      await page.getByRole("button", { name: "Follow aircraft" }).click();
      await waitForMapIdle(page);
      await page.waitForTimeout(3000);
      await waitForMapIdle(page);
    },
  },
  {
    id: "2-logbook",
    type: "ground",
    headline: "Land. It's already [logged].",
    sub: "Every flight, saved automatically.",
    tone: "light",
    needsFlights: true,
    // mock-speed: canRecord true so the Fly tab shows on every screen, as it
    // always does in the native app.
    url: "/logbook?mock-speed=1",
    async prep(page) {
      await page.locator(".flight-row").first().waitFor({ timeout: 8000 });
      await page.waitForTimeout(500);
    },
  },
  {
    id: "3-detail",
    type: "ground",
    headline: "Every flight, [mapped].",
    sub: "Every climb, turn, and glide.",
    tone: "light",
    needsFlights: true,
    url: `/logbook/${SEED_FLIGHTS[0].id}?mock-speed=1`,
    async prep(page) {
      await page.locator(".map-container").first().waitFor({ timeout: 8000 });
      await page
        .locator('[data-testid="track"], .map-container canvas')
        .first()
        .waitFor({ timeout: 8000 });
      await page.waitForTimeout(6000);
    },
  },
  {
    id: "4-plan",
    type: "ground",
    headline: "Plan the [route].",
    sub: "Your airspace, your waypoints, offline.",
    tone: "light",
    needsPins: true,
    url: "/plan?mock-speed=1",
    async prep(page) {
      await page.locator(".plan-map .map-container").first().waitFor({ timeout: 8000 });
      await page.getByTestId("plan-distance").waitFor({ timeout: 8000 });
      await page.waitForTimeout(6000);
    },
  },
  {
    id: "5-inflight-plan",
    headline: "Fly your [plan].",
    sub: "Steer to every waypoint,\nwith audio callouts.",
    tone: "light",
    needsPins: true,
    // A flight that follows the seeded plan route (route-flight.gpx), clipped
    // mid-route so the remaining waypoints sit ahead of the aircraft: the live
    // map shows the grey plan line + green waypoints under the flown track.
    gpx: "route-flight.gpx",
    url: "/?mock-speed=600&mock-gpx=/__mock.gpx",
    async prep(page) {
      await page.getByRole("button", { name: "Start Flight" }).click();
      await page.getByTestId("recording").waitFor({ timeout: 15000 });
      await page.locator(".map-container").first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(9000);
      await page.getByRole("button", { name: "Follow aircraft" }).click();
      await waitForMapIdle(page);
      await page.waitForTimeout(3000);
      await waitForMapIdle(page);
    },
  },
  {
    id: "6-sync",
    duo: true,
    needsFlights: true, // the back panel is the synced logbook
    headline: "Sync, if you [want] it.",
    sub: "Optional sync, privacy first.\nSelf-hostable, nothing locked.",
    tone: "light",
    panels: [
      {
        key: "back",
        type: "ground",
        url: "/logbook?mock-speed=1",
        async prep(page) {
          await page.locator(".flight-row").first().waitFor({ timeout: 8000 });
          await page.waitForTimeout(400);
        },
      },
      {
        key: "front",
        type: "ground",
        url: "/settings?mock-speed=1",
        async prep(page) {
          await page
            .getByText("Settings", { exact: true })
            .first()
            .waitFor({ timeout: 10000 });
          // Turn sync ON via the app's own fake provider (real replication to
          // the dev CouchDB, same seam as e2e) so the sheet shows the connected
          // "On" state, not the sign-in upsell.
          await page.evaluate(async () => {
            const sync = await import("/src/sync/index.ts");
            await sync.enable(
              sync.fakeProvider({ account: "wingover-shots", entitled: true }),
            );
          });
          await page.waitForTimeout(1800);
          // Render the sheet as the NATIVE iOS app, not the PWA: the app keys a
          // dozen labels off isTauri() (e.g. "Turn off sync" vs "Log out"). Sync
          // is already enabled against the web credential store, so flipping the
          // flag now only changes the sheet's copy, not the data path.
          await page.evaluate(() => {
            window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
          });
          await page.getByTestId("settings-sync").click();
          await page
            .locator('[data-testid="sync-state"]')
            .waitFor({ timeout: 8000 });
          await page.waitForTimeout(900);
        },
      },
    ],
  },
];

const SF_CSS = join(HERE, "assets", "sf-pro.css");

// Save the UN-framed app capture (before it goes into the store frame) so the
// same real UI can be reused on wingover.app (see web-optimize.mjs). The store
// PNGs in out/<dev> stay framed and untouched for fastlane.
function saveRaw(dev, id, buf) {
  const dir = join(HERE, "out", "raw", dev);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.png`), buf);
}

// Capture-only overrides. Chromium reports env(safe-area-inset-*) = 0, so
// simulate the iPhone insets the app would honor on-device:
//   • top: push the instruments down with MARGIN (not padding) so the panel's
//     translucent backing starts BELOW the bar — the strip under the status
//     bar stays pure satellite, no veil.
//   • bottom: lift the controls off the home-indicator edge, and give the
//     MapKit attribution its inset too — the adapter measures the bottom
//     safe area from a hidden fixed probe (height: env(safe-area-inset-bottom));
//     an !important height on it makes MapKit pad the Apple/Legal logo up.
// And render the app UI in real SF Pro (Apple's system font) instead of
// Chromium-on-Linux's default sans. Map labels come from Apple already.
// 54/34 logical px ≈ the Dynamic-Island device insets.
const CAPTURE_CSS_FLIGHT = `
  .instruments { margin-top: 54px !important; padding-top: 0 !important; }
  .flight-controls { bottom: calc(0.9rem + 34px) !important; }
  .zoom-strip { bottom: calc(9.5rem + 34px) !important; }
  div[style*="safe-area-inset-bottom"][style*="visibility"] { height: 34px !important; }
  .fly-content, .fly-content * {
    font-family: 'SF Pro Text', system-ui, -apple-system, sans-serif !important;
  }
  /* iOS optical sizing: small UI (labels) uses SF Pro Text, but the large
     stat numerals cross into SF Pro Display territory (~20pt+), whose strokes
     are lighter than Text at the same weight. Forcing Text everywhere made
     the values read heavier than a real device — use Display for them. */
  .fly-content .tile .value {
    font-family: 'SF Pro Display', system-ui, -apple-system, sans-serif !important;
  }
`;

// Ground (Ionic) screens: no env() safe area in Chromium, so feed Ionic its
// own safe-area vars (the header drops below the status bar, the tab bar lifts
// off the home indicator), and route the whole UI through real SF Pro via
// --ion-font-family. ion-icon keeps its own glyph font.
const CAPTURE_CSS_GROUND = `
  :root {
    --ion-safe-area-top: 54px;
    --ion-safe-area-bottom: 34px;
    --ion-font-family: 'SF Pro Text', system-ui, -apple-system, sans-serif;
  }
`;

async function waitForMapIdle(page) {
  // maplibre exposes __map; MapKit doesn't, so fall back to a tile-canvas
  // heuristic (a settled MapKit surface stops mutating).
  await page
    .waitForFunction(
      () => {
        const c = document.querySelector(".map-container");
        const m = c && c.__map;
        if (m) return m.loaded() && m.areTilesLoaded();
        // MapKit: consider it ready once the map canvas/tiles exist.
        return !!document.querySelector(
          ".map-container canvas, .map-container .mk-tile-loaded, .mk-map-view",
        );
      },
      { timeout: 12000 },
    )
    .catch(() => {});
}

function portOpen(port) {
  return new Promise((res) => {
    const s = net.connect(port, "localhost");
    s.on("connect", () => (s.end(), res(true)));
    s.on("error", () => res(false));
  });
}
async function ensureServer() {
  if (await portOpen(PORT)) return null;
  console.log("booting dev server…");
  const p = spawn("pnpm", ["dev"], { cwd: "/home/aeharding/wingover", stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await portOpen(PORT)) return p;
  }
  throw new Error("dev server did not start");
}

async function run() {
  const only = process.argv[2]; // optional shot id filter
  mkdirSync(FASTLANE, { recursive: true });
  // A full run renders into a STAGING dir and swaps into fastlane only after
  // every shot succeeds, so a mid-run failure (a timeout, MapKit not settling,
  // Ctrl-C) can never leave a partial or half-renamed set for `deliver` to
  // upload — the previous good set stays untouched. A single-shot run updates
  // just that one file in place, leaving its siblings alone.
  const STAGE = join(HERE, "out", `stage-${PREFIX}`);
  const DEST = only ? FASTLANE : STAGE;
  if (!only) {
    rmSync(STAGE, { recursive: true, force: true });
    mkdirSync(STAGE, { recursive: true });
  }
  const server = await ensureServer();
  const browser = await ENGINE.launch();
  try {
    for (const [dev, D] of Object.entries(DEVICES)) {
      // Two capture contexts. Recording shots (mock-gpx: hero, in-flight-plan)
      // are ISOLATED from the curated ground shots — a mock recording persists a
      // WAL that a later page in the same context resumes and finalizes into a
      // stray logbook flight (with a "Flight saved" toast). Separate contexts
      // keep that out of the logbook.
      const newCapCtx = async () => {
        const ctx = await browser.newContext({
          viewport: { width: D.appVp[0], height: D.appVp[1] },
          deviceScaleFactor: D.appDsf,
        });
        // Seed the live-map preference to satellite before the app boots
        // (readLiveViewState() is synchronous localStorage).
        await ctx.addInitScript(() => {
          localStorage.setItem(
            "wingover.live-view",
            JSON.stringify({ mapView: "satellite", follow: true, trackUp: false }),
          );
        });
        return ctx;
      };
      const capCtxGround = await newCapCtx();
      const capCtxFlight = await newCapCtx();
      const comCtx = await browser.newContext({
        viewport: { width: D.logical[0], height: D.logical[1] },
        deviceScaleFactor: D.dsf,
      });
      // Flights + pins are seeded LAZILY, only once we reach a shot that needs
      // them — never before the hero. Flights seed after the hero so its mock
      // recording (a persisted flight doc) is cleared, not shown in the logbook.
      let flightsSeeded = false;
      const pinsSeeded = new Set(); // per-context: pins live in the app's DB
      for (const shot of SHOTS) {
        if (only && shot.id !== only) continue;
        const ctx = shot.gpx ? capCtxFlight : capCtxGround;
        // Flights are curated only in the ground context (never a recording one).
        if (shot.needsFlights && !flightsSeeded) {
          console.log(`[${dev}] seeding flights…`);
          const fp = await capCtxGround.newPage();
          await fp.goto(BASE + "/logbook", { waitUntil: "domcontentloaded" });
          await seedData(fp);
          await fp.close();
          flightsSeeded = true;
        }
        if (shot.needsPins && !pinsSeeded.has(ctx)) {
          console.log(`[${dev}] seeding pins…`);
          const pinPage = await ctx.newPage();
          await pinPage.goto(BASE + "/logbook", { waitUntil: "domcontentloaded" });
          await seedPins(pinPage);
          await pinPage.close();
          pinsSeeded.add(ctx);
        }
        if (shot.duo) {
          // Two raw panel captures composed side-by-side, skewed, in frame-duo.
          console.log(`[${dev}] ${shot.id}: capturing (duo)…`);
          const raws = {};
          for (const panel of shot.panels) {
            const pctx = panel.gpx ? capCtxFlight : capCtxGround;
            const pp = await pctx.newPage();
            await pp.goto(BASE + panel.url, { waitUntil: "domcontentloaded" });
            await pp.addStyleTag({ path: SF_CSS });
            await pp.addStyleTag({
              content:
                panel.type === "ground" ? CAPTURE_CSS_GROUND : CAPTURE_CSS_FLIGHT,
            });
            await panel.prep(pp);
            await pp.evaluate(() => document.fonts.ready);
            raws[panel.key] = await pp.screenshot({ type: "png" });
            saveRaw(dev, `${shot.id}-${panel.key}`, raws[panel.key]);
            await pp.close();
          }
          console.log(`[${dev}] ${shot.id}: composing…`);
          const cpage = await comCtx.newPage();
          await cpage.goto(FRAME_DUO, { waitUntil: "networkidle" });
          await cpage.evaluate((F) => window.__renderDuo(F), {
            headline: shot.headline,
            sub: shot.sub ?? "",
            tone: shot.tone,
            u: D.u,
            screenAr: D.screenAr,
            shotBack: "data:image/png;base64," + raws.back.toString("base64"),
            shotFront: "data:image/png;base64," + raws.front.toString("base64"),
          });
          await cpage.evaluate(() => document.fonts.ready);
          await cpage.waitForTimeout(200);
          const out = join(DEST, `${PREFIX}-${shot.id}.png`);
          await cpage.screenshot({ path: out, type: "png" });
          await cpage.close();
          console.log(`  -> ${out}`);
          continue;
        }
        console.log(`[${dev}] ${shot.id}: capturing…`);
        const page = await ctx.newPage();
        if (shot.gpx) {
          let gpxBody = readFileSync(join(HERE, "assets", shot.gpx), "utf8");
          if (shot.clip) gpxBody = clipGpx(gpxBody, shot.clip);
          // Match by PATHNAME only — a glob like **/__mock.gpx also matches
          // the navigation URL (whose query ends with mock-gpx=/__mock.gpx),
          // which would fulfill the page itself as a downloadable GPX.
          await page.route(
            (url) => url.pathname === "/__mock.gpx",
            (route) =>
              route.fulfill({
                contentType: "application/gpx+xml",
                body: gpxBody,
              }),
          );
        }
        await page.goto(BASE + shot.url, { waitUntil: "domcontentloaded" });
        await page.addStyleTag({ path: SF_CSS });
        await page.addStyleTag({
          content:
            shot.type === "ground" ? CAPTURE_CSS_GROUND : CAPTURE_CSS_FLIGHT,
        });
        await shot.prep(page);
        await page.evaluate(() => document.fonts.ready);
        const raw = await page.screenshot({ type: "png" });
        saveRaw(dev, shot.id, raw);
        await page.close();

        console.log(`[${dev}] ${shot.id}: composing…`);
        const cpage = await comCtx.newPage();
        await cpage.goto(FRAME, { waitUntil: "networkidle" });
        await cpage.evaluate((F) => window.__render(F), {
          headline: shot.headline,
          sub: shot.sub ?? "",
          checks: shot.checks ?? [],
          tone: shot.tone,
          bar: shot.bar ?? "#000",
          u: D.u,
          screenAr: D.screenAr,
          shot: "data:image/png;base64," + raw.toString("base64"),
        });
        await cpage.evaluate(() => document.fonts.ready);
        await cpage.waitForTimeout(200);
        const out = join(DEST, `${PREFIX}-${shot.id}.png`);
        await cpage.screenshot({ path: out, type: "png" });
        await cpage.close();
        console.log(`  -> ${out}`);
      }
      await capCtxGround.close();
      await capCtxFlight.close();
      await comCtx.close();
    }
    // Reached only if every shot rendered. Swap the freshly staged set into
    // fastlane: drop this device's old shots (clears any renamed/removed
    // straggler) and copy the staged ones in.
    if (!only) {
      for (const f of readdirSync(FASTLANE)) {
        if (f.startsWith(`${PREFIX}-`) && f.endsWith(".png")) rmSync(join(FASTLANE, f));
      }
      for (const f of readdirSync(STAGE)) copyFileSync(join(STAGE, f), join(FASTLANE, f));
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
