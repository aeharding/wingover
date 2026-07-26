import { expect, test } from "@playwright/test";

test("diagnostics install, probe, capture and persist", async ({ page }) => {
  const diagLines: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("WINGOVER-DIAG")) diagLines.push(m.text().slice(0, 120));
  });

  await page.goto("/?map=maplibre");
  await page.locator("#tab-button-plan").click().catch(() => {});
  await page.waitForTimeout(2500);

  // 1. on-demand dump works and carries breadcrumbs
  const dump = await page.evaluate(() =>
    (window as unknown as { __wingoverDiag(): unknown }).__wingoverDiag(),
  );
  console.log("DUMP_KEYS", JSON.stringify(Object.keys(dump as object)));
  const snap = (dump as { snapshot: Record<string, unknown> }).snapshot;
  console.log("SNAPSHOT_KEYS", JSON.stringify(Object.keys(snap)));
  console.log("CRUMBS", JSON.stringify(((dump as { crumbs: unknown[] }).crumbs).slice(0, 8)));

  // 2. a real uncaught error is captured AND persisted
  await page.evaluate(() => {
    setTimeout(() => {
      throw new TypeError("diag selftest boom");
    }, 0);
  });
  await page.waitForTimeout(600);

  const saved = await page.evaluate(() => localStorage.getItem("wingover.diag.lastCrash"));
  console.log("PERSISTED", saved ? "yes" : "NO");
  expect(saved).toContain("diag selftest boom");
  expect(diagLines.length).toBeGreaterThan(0);

  // 3. it survives a reload and is surfaced on the next launch
  await page.reload();
  await page.waitForTimeout(1500);
  const replayed = diagLines.some((l) => l.includes("previous crash"));
  console.log("REPLAYED_ON_BOOT", replayed);
  expect(replayed).toBe(true);
});
