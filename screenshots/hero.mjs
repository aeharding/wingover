import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const require = createRequire("/home/aeharding/wingover/package.json");
const { chromium } = require("@playwright/test");

// README hero: the literal App Store screenshots laid side by side with a bit
// of transparent space between each, as one WebP with alpha (the gaps show the
// README's own background through).
const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, "..", "fastlane", "screenshots", "en-US");
const FILES = [
  "iphone-1-inflight.png",
  "iphone-2-logbook.png",
  "iphone-3-detail-replay.png",
  "iphone-4-plan.png",
  "iphone-5-inflight-plan.png",
  "iphone-6-sync.png",
];
const OUT_W = 2200; // width of the committed WebP

async function run() {
  const imgs = FILES.map((f) =>
    readFileSync(join(STORE, f)).toString("base64"),
  );
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { background: transparent; }
      .strip { display: inline-flex; gap: 92px; }
      .strip img { height: 1180px; display: block; }
    </style></head><body><div class="strip">` +
    imgs.map((b) => `<img src="data:image/png;base64,${b}">`).join("") +
    `</div></body></html>`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1400 },
      deviceScaleFactor: 2,
    });
    await page.setContent(html, { waitUntil: "networkidle" });
    const png = await page
      .locator(".strip")
      .screenshot({ omitBackground: true });
    // Downscale to a lean WebP (alpha preserved) for the repo.
    const enc = await browser.newPage();
    const url = await enc.evaluate(
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
      { b64: png.toString("base64"), w: OUT_W, q: 0.88 },
    );
    const dir = join(HERE, "..", "design");
    mkdirSync(dir, { recursive: true });
    const out = join(dir, "hero.webp");
    const bytes = Buffer.from(url.split(",")[1], "base64");
    writeFileSync(out, bytes);
    console.log(
      `wrote design/hero.webp  ${(bytes.length / 1024).toFixed(0)} KB`,
    );
  } finally {
    await browser.close();
  }
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
