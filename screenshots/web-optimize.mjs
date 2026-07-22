import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const require = createRequire("/home/aeharding/wingover/package.json");
const { chromium } = require("@playwright/test");

// Build web-tuned images for wingover.app from the UN-framed app captures
// (screenshots/out/raw). Phone shots get the SAME device chrome as the App
// Store frames (Dynamic Island, status bar, home indicator, bezel) baked in on
// a transparent background, at the exact screen aspect so nothing is cropped;
// the desktop split-shell capture is emitted plain for the sync section's
// browser mock. The framed store PNGs in out/<dev> are never touched — fastlane
// uploads those. No sharp/cwebp here, so resize + WebP runs through Chromium.
const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, "out", "raw");
const DEST = join(HERE, "..", "public", "shots");
const FRAME_DEVICE = "file://" + join(HERE, "frame-device.html");
const SCREEN_AR = "393 / 852";
// u matched so the phone (~165u tall) fits the capture viewport; the store
// frames use the same screen-height-in-u, so the chrome proportions line up.
const U = 9;
const QUALITY = 0.82;

// Phone shots → framed device image (transparent PNG → WebP with alpha).
const PHONE_JOBS = [
  { src: "iphone-6.9/1-inflight.png", out: "fly.webp" },
  { src: "iphone-6.9/2-logbook.png", out: "logbook.webp" },
  { src: "iphone-6.9/3-detail-replay-back.png", out: "detail.webp" },
  { src: "iphone-6.9/3-detail-replay-front.png", out: "replay.webp" },
  { src: "iphone-6.9/4-plan.png", out: "plan.webp" },
  { src: "iphone-6.9/6-sync-front.png", out: "sync.webp" },
];
const PHONE_W = 780;
// Desktop split-shell (iPad landscape capture), plain, for the browser mock.
const DESKTOP_JOB = {
  src: "ipad-13/2-logbook.png",
  out: "desktop.webp",
  w: 1600,
};

const dataUri = (p) =>
  "data:image/png;base64," + readFileSync(join(RAW, p)).toString("base64");

// Resize a PNG buffer to width `w` and encode WebP (alpha preserved).
async function encodeWebp(page, pngBuf, w, q) {
  const url = await page.evaluate(
    async ({ b64, w, q }) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const scale = w / img.naturalWidth;
      const c = document.createElement("canvas");
      c.width = Math.round(w);
      c.height = Math.round(img.naturalHeight * scale);
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/webp", q);
    },
    { b64: pngBuf.toString("base64"), w, q },
  );
  return Buffer.from(url.split(",")[1], "base64");
}

async function run() {
  mkdirSync(DEST, { recursive: true });
  const browser = await chromium.launch();
  try {
    const framePage = await browser.newPage({
      viewport: { width: 1400, height: 1800 },
      deviceScaleFactor: 2,
    });
    await framePage.goto(FRAME_DEVICE, { waitUntil: "networkidle" });
    const enc = await browser.newPage();
    for (const job of PHONE_JOBS) {
      await framePage.evaluate((F) => window.__renderDevice(F), {
        u: U,
        screenAr: SCREEN_AR,
        tone: "light",
        shot: dataUri(job.src),
      });
      await framePage.evaluate(() => document.fonts.ready);
      await framePage.waitForTimeout(150);
      const png = await framePage
        .locator(".phone")
        .screenshot({ omitBackground: true });
      const webp = await encodeWebp(enc, png, PHONE_W, QUALITY);
      writeFileSync(join(DEST, job.out), webp);
      console.log(`  ${job.out}  ${(webp.length / 1024).toFixed(0)} KB`);
    }
    const desk = await encodeWebp(
      enc,
      readFileSync(join(RAW, DESKTOP_JOB.src)),
      DESKTOP_JOB.w,
      QUALITY,
    );
    writeFileSync(join(DEST, DESKTOP_JOB.out), desk);
    console.log(`  ${DESKTOP_JOB.out}  ${(desk.length / 1024).toFixed(0)} KB`);
  } finally {
    await browser.close();
  }
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
