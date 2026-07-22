import { spawn } from "child_process";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { createRequire } from "module";
import net from "net";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const require = createRequire("/home/aeharding/wingover/package.json");
const { chromium } = require("@playwright/test");

function portOpen(port) {
  return new Promise((res) => {
    const s = net.connect(port, "localhost");
    s.on("connect", () => (s.end(), res(true)));
    s.on("error", () => res(false));
  });
}
async function ensureServer() {
  if (await portOpen(5173)) return null;
  console.log("booting dev server…");
  const p = spawn("pnpm", ["dev"], {
    cwd: "/home/aeharding/wingover",
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await portOpen(5173)) return p;
  }
  throw new Error("dev server did not start");
}
const HERE = dirname(fileURLToPath(import.meta.url));
const FRAME = "file://" + join(HERE, "frame-ipad.html");
const BASE = "http://localhost:5173";
const DEV = "ipad-13";
// Framed store shots go straight into fastlane's folder; raw captures go to
// out/raw for the web images (see web-optimize.mjs).
const FASTLANE = join(HERE, "..", "fastlane", "screenshots", "en-US");
const PREFIX = "ipad";

// iPad 13" LANDSCAPE, 2752x2064 store pixels (LOGICAL 1376x1032 * DSF 2). The
// split-shell wants width (in portrait the detail pane is narrower than its
// card padding and the map zooms out); the app is captured at iPad landscape
// points (1376x1032) where the split has room.
const LOGICAL = [1376, 1032];
const DSF = 2;
const APPVP = [1376, 1032];
const SCREEN_AR = "1376 / 1032";
const U = 13.76;
const SF_CSS = join(HERE, "assets", "sf-pro.css");

// Ground (Ionic/desktop-shell) screens: real SF Pro, no faux insets (the iPad
// frame is a uniform bezel, no notch).
const CAPTURE_CSS = `
  :root {
    --ion-safe-area-top: 0px;
    --ion-safe-area-bottom: 0px;
    --ion-font-family: 'SF Pro Text', system-ui, -apple-system, sans-serif;
  }
`;
// Live flight deck: same optical-size split as the phone (Text for labels,
// Display for the big stat numerals); no iPhone safe-area pushes on iPad.
const CAPTURE_CSS_FLIGHT = `
  .fly-content, .fly-content * {
    font-family: 'SF Pro Text', system-ui, -apple-system, sans-serif !important;
  }
  .fly-content .tile .value {
    font-family: 'SF Pro Display', system-ui, -apple-system, sans-serif !important;
  }
`;

// Save the UN-framed app capture (for reuse on wingover.app); the framed store
// PNG in out/ipad-13 stays untouched for fastlane.
function saveRaw(id, buf) {
  const dir = join(HERE, "out", "raw", DEV);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.png`), buf);
}

// ── seed helpers ─────────────────────────────────────────────────────────
// median (±7) despike + light mean (±5) smoothing — reproduces the device's
// smooth doppler speed from raw 1 Hz positions (see generate.mjs for detail).
function smooth(a) {
  const med = a.map((_, i) => {
    const s = a.slice(Math.max(0, i - 7), i + 8).sort((x, y) => x - y);
    return s[s.length >> 1];
  });
  return med.map((_, i) => {
    let s = 0,
      n = 0;
    for (
      let k = Math.max(0, i - 5);
      k <= Math.min(med.length - 1, i + 5);
      k++
    ) {
      s += med[k];
      n++;
    }
    return s / n;
  });
}
function toFixes(pts) {
  const R = 6371000,
    rad = Math.PI / 180;
  const der = pts.map((p, i) => {
    const prev = pts[i - 1];
    let speed = 0,
      course = 0,
      climbRate = 0;
    if (prev && p.t && prev.t) {
      const dt = (p.t - prev.t) / 1000 || 1;
      const dLat = (p.lat - prev.lat) * rad,
        dLon = (p.lon - prev.lon) * rad;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(prev.lat * rad) *
          Math.cos(p.lat * rad) *
          Math.sin(dLon / 2) ** 2;
      speed = (2 * R * Math.asin(Math.min(1, Math.sqrt(a)))) / dt;
      const y = Math.sin(dLon) * Math.cos(p.lat * rad);
      const x =
        Math.cos(prev.lat * rad) * Math.sin(p.lat * rad) -
        Math.sin(prev.lat * rad) * Math.cos(p.lat * rad) * Math.cos(dLon);
      course = (Math.atan2(y, x) / rad + 360) % 360;
      climbRate = (p.alt - prev.alt) / dt;
    }
    return { speed, course, climbRate };
  });
  const speed = smooth(der.map((d) => d.speed));
  return pts.map((p, i) => ({
    timestamp: p.t,
    latitude: p.lat,
    longitude: p.lon,
    altitude: p.alt,
    speed: speed[i],
    course: der[i].course,
    climbRate: der[i].climbRate,
    horizontalAccuracy: 5,
    verticalAccuracy: 5,
  }));
}
function gpxToFixes(file) {
  const xml = readFileSync(join(HERE, "assets", file), "utf8");
  const re =
    /<trkpt[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
  const pts = [];
  let m;
  while ((m = re.exec(xml))) {
    const ele = /<ele>([-\d.]+)<\/ele>/.exec(m[3]);
    const time = /<time>([^<]+)<\/time>/.exec(m[3]);
    pts.push({
      lat: +m[1],
      lon: +m[2],
      alt: ele ? +ele[1] : 0,
      t: time ? Date.parse(time[1]) : null,
    });
  }
  return toFixes(pts);
}
// Clip a GPX to its first `seconds` in memory (see generate.mjs) so the hero
// replays a real flight held mid-flight without a committed pre-clipped file.
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
  return (
    xml.slice(0, matches[0].index) +
    kept.join("\n      ") +
    xml.slice(last.index + last[0].length)
  );
}
function synth(lng, lat, alt, startIso, count) {
  const pts = [];
  let course = 40,
    la = lat,
    lo = lng;
  const start = Date.parse(startIso);
  for (let i = 0; i < count; i++) {
    course += Math.sin(i / 8) * 7 + Math.sin(i / 3.3) * 2.4;
    const cr = (course * Math.PI) / 180;
    la += (22 * Math.cos(cr)) / 111320;
    lo += (22 * Math.sin(cr)) / (111320 * Math.cos((la * Math.PI) / 180));
    pts.push({
      lat: la,
      lon: lo,
      alt: alt + Math.sin(i / 12) * 60 + i * 0.2,
      t: start + i * 3000,
    });
  }
  return toFixes(pts);
}

// The detail pane (shot 2) opens FLIGHTS[0]; make it the REAL Oregon flight so
// the split shows an authentic recorded track, not a synthetic line.
const FLIGHTS = [
  {
    name: "Wing tip touches w/ Paul",
    launchName: "Oregon, WI",
    notes:
      "Clear, 4mph from NW, Paul followed on his slow student wing, I had to trim in to do tip touches.",
    fixes: gpxToFixes("flight-a.gpx"),
  },
  {
    name: "One-tank XC",
    launchName: "Blue Mounds, WI",
    notes: "Cloudbase ~5,000, light NW. Full tank down the valley and back.",
    fixes: synth(-89.84, 43.03, 395, "2025-06-24T19:20:00Z", 3000),
  },
  {
    name: "Golden hour cruise",
    launchName: "Blue Mounds, WI",
    notes: "",
    fixes: synth(-89.83, 43.02, 390, "2025-07-12T23:40:00Z", 980),
  },
  {
    name: "First flight of spring",
    launchName: "Brooklyn, WI",
    notes: "",
    fixes: synth(-89.38, 42.85, 300, "2025-03-29T21:00:00Z", 840),
  },
].map((f) => ({
  ...f,
  id: `recorded-${f.fixes[0].timestamp}`,
  startedAt: f.fixes[0].timestamp,
}));
const PINS = [
  [-90.33, 43.47],
  [-90.27, 43.51],
  [-90.21, 43.49],
  [-90.15, 43.55],
];

async function seedFlights(page) {
  await page.evaluate(async (flights) => {
    const db = await import("/src/storage/db.ts");
    const { computeStats } = await import("/src/flight/stats.ts");
    const local = await import("/src/storage/local.ts");
    await local.setSetting("mapView", "satellite");
    for (const existing of await db.listFlights())
      await db.deleteFlight(existing.id);
    for (const f of flights) {
      await db.saveFlight(
        {
          id: f.id,
          name: f.name,
          notes: f.notes,
          startedAt: f.startedAt,
          stats: computeStats(f.fixes),
          updatedAt: Date.now(),
          launchAt: [f.fixes[0].longitude, f.fixes[0].latitude],
          launchName: f.launchName,
        },
        f.fixes,
      );
    }
  }, FLIGHTS);
}
async function seedPins(page) {
  await page.evaluate(async (pins) => {
    const db = await import("/src/storage/db.ts");
    const local = await import("/src/storage/local.ts");
    await local.setSetting("mapView", "satellite");
    let i = 0;
    for (const [lng, lat] of pins) {
      await db.savePin({
        id: crypto.randomUUID(),
        name: `Pin ${i + 1}`,
        notes: "",
        latitude: lat,
        longitude: lng,
        createdAt: Date.now() + i * 1000,
        updatedAt: Date.now() + i * 1000,
      });
      i++;
    }
  }, PINS);
}

async function waitForMapIdle(page) {
  await page
    .waitForFunction(
      () => {
        const c = document.querySelector(".map-container");
        const m = c && c.__map;
        if (m) return m.loaded() && m.areTilesLoaded();
        return !!document.querySelector(
          ".map-container canvas, .map-container .mk-tile-loaded, .mk-map-view",
        );
      },
      { timeout: 12000 },
    )
    .catch(() => {});
}

// ── shots ─────────────────────────────────────────────────────────────────
const SHOTS = [
  {
    // In-flight hero, mirroring the iPhone lead shot: the live flight deck, on
    // the big screen. On iPad width the app renders the desktop split-shell, so
    // this is the flight deck with the rail alongside the full-bleed map.
    id: "1-inflight",
    headline: "A flight deck built for the [air].",
    sub: "Groundspeed, altitude, climb; readable in full sun.",
    flight: true,
    gpx: "flight-a.gpx",
    clip: 1672, // first 1672s of the real flight, held mid-flight
    url: "/fly?mock-speed=600&mock-gpx=/__mock.gpx",
    async prep(page) {
      await page.getByRole("button", { name: "Start Flight" }).click();
      await page.getByTestId("recording").waitFor({ timeout: 15000 });
      await page.locator(".map-container").first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(9000);
      await page
        .getByRole("button", { name: "Follow aircraft" })
        .click()
        .catch(() => {});
      await waitForMapIdle(page);
      await page.waitForTimeout(3000);
      await waitForMapIdle(page);
    },
  },
  {
    id: "2-logbook",
    headline: "Your whole logbook, one [screen].",
    sub: "List, map, replay, and stats, side by side.",
    needsFlights: true,
    url: `/logbook/${FLIGHTS[0].id}?mock-speed=1`,
    async prep(page) {
      await page.locator(".map-container").first().waitFor({ timeout: 10000 });
      // Open the replay pane: the split shows list, map with the aircraft,
      // the altitude graph, and the stats card in one frame.
      await page.getByTestId("replay-start").click();
      await page.getByTestId("replay-dock").waitFor({ timeout: 8000 });
      // The bounds fit ran against the full-height map; walk the selection
      // away and back so both refits run with the pane docked (the pane
      // survives switches) and the track frames inside the SHORTER map.
      const before = page.url();
      await page.keyboard.press("ArrowDown");
      if (page.url() !== before) {
        await page.keyboard.press("ArrowUp");
      } else {
        await page.keyboard.press("ArrowUp");
        await page.keyboard.press("ArrowDown");
      }
      await page.waitForTimeout(800);
      // The return switch arrives PARKED (autoplay never re-arms); the
      // scrub below wakes it paused at a fixed fraction, deterministic.
      // 0.62 on purpose — a different moment than the iPhone replay
      // shot, so the two don't show identical readouts.
      const barogram = await page.getByTestId("barogram").boundingBox();
      await page.mouse.click(
        barogram.x + barogram.width * 0.62,
        barogram.y + barogram.height / 2,
      );
      await waitForMapIdle(page);
      await page.waitForTimeout(7000);
    },
  },
  {
    id: "3-plan",
    headline: "Plan the route on the [big screen].",
    sub: "Your airspace, your waypoints, offline.",
    needsPins: true,
    url: "/plan?mock-speed=1",
    async prep(page) {
      await page.locator(".map-container").first().waitFor({ timeout: 10000 });
      await page.waitForTimeout(7000);
    },
  },
];

async function run() {
  const only = process.argv[2];
  mkdirSync(FASTLANE, { recursive: true });
  // Full run stages then swaps into fastlane only on full success (a mid-run
  // failure leaves the previous set intact); a single-shot run updates that
  // one file in place. Same reasoning as the phone generator.
  const STAGE = join(HERE, "out", `stage-${PREFIX}`);
  const DEST = only ? FASTLANE : STAGE;
  if (!only) {
    rmSync(STAGE, { recursive: true, force: true });
    mkdirSync(STAGE, { recursive: true });
  }
  const server = await ensureServer();
  const browser = await chromium.launch();
  try {
    const newCapCtx = async () => {
      const ctx = await browser.newContext({
        viewport: { width: APPVP[0], height: APPVP[1] },
        deviceScaleFactor: DSF,
        // Dark system scheme, matching generate.mjs (the ground UI is
        // class-driven dark under a dark OS scheme or satellite).
        colorScheme: "dark",
      });
      await ctx.addInitScript(() =>
        localStorage.setItem(
          "wingover.live-view",
          JSON.stringify({
            mapView: "satellite",
            follow: true,
            trackUp: false,
          }),
        ),
      );
      return ctx;
    };
    // Recording shot isolated from ground shots — a mock recording's WAL would
    // otherwise finalize into a stray logbook flight (same reason as the phone).
    const capGround = await newCapCtx();
    const capFlight = await newCapCtx();
    const com = await browser.newContext({
      viewport: { width: LOGICAL[0], height: LOGICAL[1] },
      deviceScaleFactor: DSF,
    });
    let flightsSeeded = false;
    const pinsSeeded = new Set();
    for (const shot of SHOTS) {
      if (only && shot.id !== only) continue;
      const ctx = shot.flight ? capFlight : capGround;
      if (shot.needsFlights && !flightsSeeded) {
        console.log(`[ipad] seeding flights…`);
        const fp = await capGround.newPage();
        await fp.goto(BASE + "/logbook", { waitUntil: "domcontentloaded" });
        await seedFlights(fp);
        await fp.close();
        flightsSeeded = true;
      }
      if (shot.needsPins && !pinsSeeded.has(ctx)) {
        console.log(`[ipad] seeding pins…`);
        const pp = await ctx.newPage();
        await pp.goto(BASE + "/logbook", { waitUntil: "domcontentloaded" });
        await seedPins(pp);
        await pp.close();
        pinsSeeded.add(ctx);
      }
      console.log(`[ipad] ${shot.id}: capturing…`);
      const page = await ctx.newPage();
      if (shot.gpx) {
        let gpxBody = readFileSync(join(HERE, "assets", shot.gpx), "utf8");
        if (shot.clip) gpxBody = clipGpx(gpxBody, shot.clip);
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
        content: shot.flight ? CAPTURE_CSS_FLIGHT : CAPTURE_CSS,
      });
      await shot.prep(page);
      await page.evaluate(() => document.fonts.ready);
      const raw = await page.screenshot({ type: "png" });
      saveRaw(shot.id, raw);
      await page.close();
      const cpage = await com.newPage();
      await cpage.goto(FRAME, { waitUntil: "networkidle" });
      await cpage.evaluate((F) => window.__render(F), {
        headline: shot.headline,
        sub: shot.sub ?? "",
        u: U,
        screenAr: SCREEN_AR,
        shot: "data:image/png;base64," + raw.toString("base64"),
      });
      await cpage.evaluate(() => document.fonts.ready);
      await cpage.waitForTimeout(200);
      const out = join(DEST, `${PREFIX}-${shot.id}.png`);
      await cpage.screenshot({ path: out, type: "png" });
      await cpage.close();
      console.log(`  -> ${out}`);
    }
    // Reached only if every shot rendered: swap the staged set into fastlane.
    if (!only) {
      for (const f of readdirSync(FASTLANE)) {
        if (f.startsWith(`${PREFIX}-`) && f.endsWith(".png"))
          rmSync(join(FASTLANE, f));
      }
      for (const f of readdirSync(STAGE))
        copyFileSync(join(STAGE, f), join(FASTLANE, f));
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
