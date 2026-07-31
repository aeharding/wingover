import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";

import { expect, test } from "@playwright/test";

// The launch white flash lived in a frame that `pnpm dev` CANNOT produce:
// Vite dev injects CSS as <style> from JS, so there is no stylesheet at first
// paint. A production build instead emits a render-blocking <link> plus a
// DEFERRED entry module, which leaves a real frame where CSS has applied and
// no app JS has run. Every other spec here runs against the dev server and is
// structurally blind to it — that is how the flash shipped.
//
// So this spec serves the built `dist/` straight from disk over route
// interception. No preview server and no extra port: 5173 is already the dev
// server, and a second one would just be another port to collide on.

const DIST = new URL("../dist/", import.meta.url).pathname;

const TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

test.beforeAll(() => {
  // Loud, not skipped: a silently-skipped guard is how this class of bug gets
  // back in. CI always has dist (ci.yml builds before Playwright runs).
  expect(
    existsSync(join(DIST, "index.html")),
    "dist/index.html is missing — run `pnpm build` before this spec",
  ).toBe(true);
});

test("the first painted frame is dark, before any app JS runs", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });

  let entryChunksBlocked = 0;
  await page.route("**/*", async (route) => {
    const { pathname } = new URL(route.request().url());

    // Abort the deferred entry chunk to freeze the page in exactly the state
    // it holds between "stylesheet applied" and "app JS ran" — the window the
    // flash lived in. The PWA registration script is unrelated noise.
    if (/^\/assets\/.*\.js$/.test(pathname)) {
      entryChunksBlocked++;
      return route.abort();
    }
    if (pathname === "/registerSW.js") return route.abort();

    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
    const file = normalize(join(DIST, rel));
    if (!file.startsWith(DIST) || !existsSync(file)) return route.abort();
    return route.fulfill({
      body: readFileSync(file),
      contentType: TYPES[extname(file)] ?? "application/octet-stream",
    });
  });

  await page.goto("https://first-paint.test/");

  const probe = await page.evaluate(() => ({
    htmlClass: document.documentElement.className,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    ionBackground: getComputedStyle(document.documentElement)
      .getPropertyValue("--ion-background-color")
      .trim(),
    rootChildren: document.getElementById("root")?.childElementCount ?? -1,
  }));

  // Assert the SCENARIO before the result: a page that failed to load is also
  // "not white", and would pass this spec while proving nothing.
  expect(entryChunksBlocked, "no entry chunk was intercepted").toBeGreaterThan(
    0,
  );
  expect(probe.ionBackground, "the built stylesheet never applied").not.toBe(
    "",
  );
  expect(
    probe.rootChildren,
    "app JS ran, so this is not the first-paint frame",
  ).toBe(0);

  // The actual invariant. index.html stamps the palette class from a
  // parser-blocking script, and theme.css gives that class the dark
  // background, so the canvas is black before the entry module exists.
  expect(probe.htmlClass).toContain("ion-palette-dark");
  expect(probe.bodyBackground).toBe("rgb(0, 0, 0)");

  // Read it off the composited pixels too, not just computed style: this is
  // the thing the pilot actually sees on launch.
  const shot = await page.screenshot();
  const centre = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const [r, g, b] = ctx.getImageData(
      Math.floor(img.width / 2),
      Math.floor(img.height / 2),
      1,
      1,
    ).data;
    return `rgb(${r}, ${g}, ${b})`;
  }, shot.toString("base64"));
  expect(centre, "the launch frame is not black").toBe("rgb(0, 0, 0)");
});
