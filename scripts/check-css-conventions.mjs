#!/usr/bin/env node
/**
 * Enforces the CSS Modules conventions (docs/CSS-MODULES.md) so they hold by
 * CI, not by memory:
 *
 *  1. plain-css     — src/ contains no plain .css except the token layer
 *                     (theme.css). Everything else is *.module.css.
 *  2. global-usage  — :global(...) may only name classes we don't own
 *                     (Ionic/library/app-state, see ALLOWED_GLOBALS) or
 *                     classes imported into this file with @value. Owned
 *                     classes from another module are IMPORTED, never
 *                     hard-coded.
 *  3. value-imports — every `@value x from "./m.module.css"` resolves, and
 *                     m actually declares .x.
 *  4. dts-pairing   — every module has a GENERATED .d.ts (gitignored;
 *                     postinstall/prebuild run tcm) and every .d.ts a
 *                     module — catches generation not running, and
 *                     orphans from renames/deletes.
 *  5. module-used   — every module is imported by some ts/tsx or @value'd
 *                     by another module (dead file detection).
 *
 * Exit 0 clean; exit 1 with a per-violation report otherwise.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SRC = join(ROOT, "src");

// Plain .css files that are ALLOWED to exist (the global token layer).
const PLAIN_CSS_ALLOWLIST = new Set(["src/theme.css"]);

// Classes we legitimately reference but do not own. Exact names or
// prefix patterns (trailing *). Anything else inside :global() must be a
// same-file @value import.
const ALLOWED_GLOBALS = [
  "ion-*", // Ionic utility/state classes (.ion-palette-dark, .ion-page, ...)
  "list-inset", // Ionic stamps it on inset ion-lists
  "item-*", // Ionic item internals (.item-inner, .item-native)
  "toolbar-*", // Ionic toolbar internals
  "maplibregl-*", // MapLibre's own DOM
  "mk-*", // MapKit's own DOM
  "flight-map-full", // app-level body state (FlightSeat toggles it)
  "keyboard-open", // app-level html state (tauri-ionic/keyboard.ts)
  "consume-bottom", // theme.css inset utilities (documented globals)
  "consume-all",
];

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const rel = (p) => relative(ROOT, p);
const files = walk(SRC);
const cssFiles = files.filter(
  (f) => f.endsWith(".css") && !f.endsWith(".d.ts"),
);
const modules = cssFiles.filter((f) => f.endsWith(".module.css"));
const plain = cssFiles.filter((f) => !f.endsWith(".module.css"));
const dts = files.filter((f) => f.endsWith(".module.css.d.ts"));
const sources = files.filter(
  (f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts"),
);

const violations = [];
const allowed = (name) =>
  ALLOWED_GLOBALS.some((a) =>
    a.endsWith("*") ? name.startsWith(a.slice(0, -1)) : name === a,
  );

// ── 1. plain-css ─────────────────────────────────────────────────────────
for (const f of plain) {
  if (!PLAIN_CSS_ALLOWLIST.has(rel(f))) {
    violations.push(
      `${rel(f)}: plain .css is reserved for the token layer (${[...PLAIN_CSS_ALLOWLIST]}); make it a *.module.css`,
    );
  }
}

// ── per-module checks ────────────────────────────────────────────────────
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const valueImportsOf = (text) => {
  // local name -> { original, from } (aliases: `@value x as y` binds y
  // locally while the target declares x).
  const map = new Map();
  for (const m of text.matchAll(
    /@value\s+([\w-]+)(?:\s+as\s+([\w-]+))?\s+from\s+["']([^"']+)["']/g,
  )) {
    map.set(m[2] ?? m[1], { original: m[1], from: m[3] });
  }
  return map;
};

for (const f of modules) {
  const text = stripComments(readFileSync(f, "utf8"));
  const values = valueImportsOf(text);

  // ── 3. value-imports resolve and declare the class ──
  for (const [local, { original, from }] of values) {
    const target = resolve(dirname(f), from);
    if (!existsSync(target)) {
      violations.push(
        `${rel(f)}: @value ${local} from "${from}" — file not found`,
      );
      continue;
    }
    const targetText = stripComments(readFileSync(target, "utf8"));
    // (?![\w-]) not \b: a word boundary sits at a hyphen, so .foo would
    // wrongly match a lone .foo-bar declaration.
    if (!new RegExp(`\\.${original}(?![\\w-])`).test(targetText)) {
      violations.push(
        `${rel(f)}: @value ${original} from "${from}" — ${rel(target)} declares no .${original}`,
      );
    }
  }

  // ── 2. :global discipline ──
  // The switch/block forms (`:global .x`, `:global { ... }`) would bypass
  // the scan below; the convention permits only the function form.
  for (const m of text.matchAll(/:global(?!\()/g)) {
    const line = text.slice(0, m.index).split("\n").length;
    violations.push(
      `${rel(f)}:${line}: bare :global switch/block form — use :global(.x) so the discipline check can see it`,
    );
  }
  for (const m of text.matchAll(/:global\(([^)]+)\)/g)) {
    for (const cls of m[1].matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      const name = cls[1];
      if (!allowed(name) && !values.has(name)) {
        violations.push(
          `${rel(f)}: :global(.${name}) — not an allowed external class and not a same-file @value import. ` +
            `Own it? Import it: @value ${name} from "<its module>". External? Add it to ALLOWED_GLOBALS with a comment.`,
        );
      }
    }
  }

  // ── 4. dts-pairing (module -> d.ts) ──
  if (!existsSync(f + ".d.ts")) {
    violations.push(
      `${rel(f)}: missing generated ${rel(f)}.d.ts — run pnpm generate:csstypes (postinstall does this; did it run?)`,
    );
  }
}

// ── 4. dts-pairing (d.ts -> module) ──
for (const f of dts) {
  const mod = f.replace(/\.d\.ts$/, "");
  if (!existsSync(mod)) {
    violations.push(`${rel(f)}: orphan .d.ts — its module is gone; delete it`);
  }
}

// ── 5. module-used ──
// Resolve REAL import specifiers (ts/tsx `from "..."` with comments stripped,
// plus module @value froms) to absolute paths — basename matching both missed
// same-named modules in different dirs and was fooled by comments.
const stripTsComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const imported = new Set();
for (const s of sources) {
  const text = stripTsComments(readFileSync(s, "utf8"));
  for (const m of text.matchAll(/from\s+["']([^"']+\.module\.css)["']/g)) {
    imported.add(resolve(dirname(s), m[1]));
  }
}
for (const f of modules) {
  const text = stripComments(readFileSync(f, "utf8"));
  for (const m of text.matchAll(/@value[^"']+["']([^"']+)["']/g)) {
    imported.add(resolve(dirname(f), m[1]));
  }
}
for (const f of modules) {
  if (!imported.has(f)) {
    violations.push(
      `${rel(f)}: imported by nothing (no ts/tsx import, no @value) — dead file?`,
    );
  }
}

if (violations.length) {
  console.error(`css-conventions: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error("  ✗ " + v);
  process.exit(1);
}
console.log(
  `css-conventions: OK (${modules.length} modules, ${plain.length} plain allowlisted, ${dts.length} d.ts paired)`,
);
