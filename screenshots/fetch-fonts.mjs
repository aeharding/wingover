import { existsSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Build screenshots/assets/sf-pro.css (embedded @font-face rules) from Apple's
// SF Pro OTFs, downloaded on demand. The generated CSS (~18 MB of proprietary
// Apple fonts) is gitignored, not committed; this reproduces it locally so the
// screenshot pipeline renders in the real system font. Idempotent: skips if the
// CSS already exists (pass --force to refetch).
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "assets", "sf-pro.css");
// Pinned to an immutable commit, not a moving branch: GitHub serves the exact
// blob for this SHA, so the fonts can't silently change or disappear under us.
const REF = "8bfea09aa6f1139479f80358b2e1e5c6dc991a58";
const BASE = `https://raw.githubusercontent.com/sahibjotsaggu/San-Francisco-Pro-Fonts/${REF}/`;

// The exact faces the frames use: SF Pro Text 400–800 (UI + labels) and SF Pro
// Display Heavy (headlines + large stat numerals). `bytes` is asserted after
// download as a cheap integrity check (catches a truncated/mangled fetch or an
// error page served in place of the font).
const FACES = [
  { family: "SF Pro Text", weight: 400, file: "SF-Pro-Text-Regular.otf", bytes: 2230172 },
  { family: "SF Pro Text", weight: 500, file: "SF-Pro-Text-Medium.otf", bytes: 2300344 },
  { family: "SF Pro Text", weight: 600, file: "SF-Pro-Text-Semibold.otf", bytes: 2300840 },
  { family: "SF Pro Text", weight: 700, file: "SF-Pro-Text-Bold.otf", bytes: 2275752 },
  { family: "SF Pro Text", weight: 800, file: "SF-Pro-Text-Heavy.otf", bytes: 2286508 },
  { family: "SF Pro Display", weight: 800, file: "SF-Pro-Display-Heavy.otf", bytes: 2311308 },
];

if (existsSync(OUT) && !process.argv.includes("--force")) {
  console.log("assets/sf-pro.css already present (pass --force to refetch)");
  process.exit(0);
}

const rules = [];
for (const f of FACES) {
  process.stdout.write(`fetching ${f.file}… `);
  const res = await fetch(BASE + f.file);
  if (!res.ok) throw new Error(`${f.file}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== f.bytes) {
    throw new Error(`${f.file}: expected ${f.bytes} bytes, got ${buf.length}`);
  }
  console.log(`${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  rules.push(
    `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};` +
      `src:url(data:font/otf;base64,${buf.toString("base64")}) format('opentype')}`,
  );
}
writeFileSync(OUT, rules.join("\n") + "\n");
console.log(`wrote assets/sf-pro.css (${FACES.length} faces)`);
