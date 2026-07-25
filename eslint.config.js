// @ts-check

import commentsPlugin from "@eslint-community/eslint-plugin-eslint-comments";
import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import perfectionistPlugin from "eslint-plugin-perfectionist";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

import maxUseState from "./eslint-rules/max-usestate.js";

// ─── The seams, as restriction entries ──────────────────────────────────
//
// Doctrine boundaries are directory boundaries, and they hold because they
// are mechanical (STEERING.md). Each entry below is one seam, carrying the
// doctrine that owns it; the scoped blocks further down compose them.
//
// Two things to know before editing:
//
//  1. Flat-config rule entries REPLACE the base layer rather than merging
//     with it, so every scope must list EVERY restriction it wants. That is
//     what `restrict()` is for — a spread instead of a copy-paste that
//     silently drifts out of sync.
//  2. Inline eslint-disable is banned repo-wide (eslint-comments/no-use), so
//     an exception is never a comment at the call site: it is an `ignores`
//     line here, reviewable in one place, next to the rule it weakens.

/** @typedef {{ name: string, importNames?: string[], message: string }} RestrictedPath */
/** @typedef {{ group?: string[], regex?: string, allowTypeImports?: boolean, message: string }} RestrictedPattern */

/** @type {RestrictedPath} */
const NO_MANUAL_MEMO = {
  name: "react",
  importNames: ["useCallback", "useMemo"],
  message:
    "The React Compiler memoizes automatically. For one-time instantiation use useState(() => ...).",
};

/** @type {RestrictedPattern} */
const NO_REACT = {
  group: ["react", "react-dom", "react-dom/*", "@ionic/*"],
  message: "Headless world: React/Ionic live in src/ui/ only (STEERING.md).",
};

/** @type {RestrictedPattern} */
const NO_IONIC = {
  group: ["@ionic/*"],
  message:
    "Flight UI never imports Ionic; wrap at the shell seam (src/ui/pages/FlyFrame.tsx).",
};

/** @type {RestrictedPattern} */
const NO_UI = {
  group: ["**/ui", "**/ui/**"],
  message:
    "The headless world never imports the UI: business wiring lives in headless modules, React only renders derived state (STEERING.md).",
};

/** @type {RestrictedPattern} */
const ENGINE_PUBLIC_ONLY = {
  regex: "(^|/)engine/(?!index$|types$|platform$|session$|currentPosition$)",
  message:
    "src/engine's public surface is index, types, platform, session, currentPosition. real/wal/core/*Source are internals: the engine is reached through one injected CoreClient (ARCHITECTURE.md).",
};

/** @type {RestrictedPattern} */
const SYNC_PUBLIC_ONLY = {
  group: [
    "**/sync/providers/*",
    "**/sync/store/*",
    "**/sync/replicate",
    "**/sync/types",
  ],
  message:
    "src/sync is reached through its barrel; providers, credential store and replication are private. One code path, not two that happen to agree (STEERING.md).",
};

/** @type {RestrictedPattern} */
const NO_MAP_BACKEND = {
  regex: "^(maplibre-gl|apple-mapkit|@apple/mapkit-loader)$",
  allowTypeImports: true,
  message:
    "Consumers speak MapView only; backends live in src/ui/map/maplibre and src/ui/map/mapkit (src/ui/map/types.ts).",
};

/** @type {RestrictedPattern} */
const NO_POUCHDB = {
  group: ["pouchdb*"],
  message:
    "The store is owned by src/storage (and sync/replicate.ts); nobody else opens a database (STEERING.md, Source of truth).",
};

/** @type {RestrictedPattern} */
const NO_PLATFORM = {
  group: ["./platform", "**/engine/platform"],
  message:
    "It never switches on the platform: sources declare capabilities and the engine adapts (ARCHITECTURE.md). Platform choice lives in the selection modules only.",
};

/** @type {RestrictedPattern} */
const NO_TAURI = {
  group: ["@tauri-apps/*"],
  message:
    "Native IPC belongs to the shim modules (nativeSource, currentPosition, sync/store/keychain, sync/providers/apple, ui/download, ui/externalLinks), never to engine logic (ARCHITECTURE.md).",
};

/** @type {RestrictedPattern} */
const ENGINE_SOURCES_PRIVATE = {
  group: ["./core", "./nativeSource", "./gpxSource", "./simulatorSource"],
  message:
    "Source selection happens in exactly one place, src/engine/index.ts: one interface, a web implementation, a native implementation (ARCHITECTURE.md).",
};

// src/engine's platform-aware edge: the source-SELECTION modules, and only
// those. currentPosition.ts is a second, one-shot PositionSource selector
// (WKWebView cannot serve web geolocation, so Center-on-me goes through the
// plugin under Tauri and navigator.geolocation everywhere else) — selection,
// not engine logic. Everything else under src/engine is platform-blind.
const ENGINE_PLATFORM_AWARE = [
  "src/engine/index.ts",
  "src/engine/platform.ts",
  "src/engine/nativeSource.ts",
  "src/engine/currentPosition.ts",
];

/**
 * @param {(RestrictedPath | RestrictedPattern)[]} entries
 * @returns {import("eslint").Linter.RuleEntry}
 */
function restrict(...entries) {
  return [
    "error",
    {
      paths: entries.filter((entry) => "name" in entry),
      patterns: entries.filter((entry) => !("name" in entry)),
    },
  ];
}

const NO_RELOAD = {
  selector:
    "MemberExpression[property.name='reload'][object.property.name='location'], MemberExpression[property.name='reload'][object.name='location']",
  message:
    "No location.reload() in app code: instance-swap and notify instead (CLAUDE.md).",
};

// "Every flight-semantic decision — arming, takeoff, landing, flight
// finalization — is a pure function of fix timestamps, never of wall-clock
// time" (STEERING.md). A takeoff that happened while the phone was asleep is
// detected and backdated on replay exactly as it would have been live, which
// only holds while the deriving layer reads no clock.
const NO_WALL_CLOCK = [
  {
    selector: "MemberExpression[object.name='Date'][property.name='now']",
    message:
      "Wall-clock read in the derived-state layer: decisions are pure functions of fix timestamps (STEERING.md).",
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message:
      "Wall-clock read in the derived-state layer: decisions are pure functions of fix timestamps (STEERING.md).",
  },
  {
    selector:
      "MemberExpression[object.name='performance'][property.name='now']",
    message:
      "Wall-clock read in the derived-state layer: decisions are pure functions of fix timestamps (STEERING.md).",
  },
];

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  eslintConfigPrettier,
  reactHooks.configs.flat["recommended-latest"],
  {
    plugins: {
      wingover: { rules: { "max-usestate": maxUseState } },
    },
    rules: {
      // >5 useState in one component = state that wants a hook/object.
      "wingover/max-usestate": "error",
      // The base layer: the manual-memoization ban plus the seams that are
      // inert inside the directory they protect (a relative import within
      // src/engine reads "./real", not "engine/real"), so they cost nothing
      // here and cover main.tsx, sw.ts, tauri-ionic, e2e and scripts too.
      "no-restricted-imports": restrict(
        NO_MANUAL_MEMO,
        ENGINE_PUBLIC_ONLY,
        SYNC_PUBLIC_ONLY,
        NO_MAP_BACKEND,
        NO_POUCHDB,
      ),
    },
  },
  {
    // Disabling lint rules inline is banned — fix the code instead.
    plugins: {
      "@eslint-community/eslint-comments": commentsPlugin,
    },
    rules: {
      "@eslint-community/eslint-comments/no-use": "error",
    },
  },
  {
    plugins: {
      perfectionist: perfectionistPlugin,
    },
    rules: {
      "perfectionist/sort-named-imports": [
        "warn",
        { ignoreCase: false, type: "natural", ignoreAlias: false },
      ],
      "perfectionist/sort-imports": [
        "warn",
        {
          newlinesBetween: 1,
          partitionByComment: true,
          type: "natural",
          ignoreCase: false,
          tsconfig: { rootDir: "." },
          // Never sort side-effect imports: CSS cascade order is
          // load-bearing (theme.css must follow Ionic css, MapView.css
          // must follow maplibre-gl.css).
          sortSideEffects: false,
          groups: [
            "builtin",
            "external",
            "internal",
            ["parent", "sibling", "index"],
            "style",
          ],
        },
      ],
    },
  },
  {
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: [
      "e2e/**",
      "screenshots/**",
      "scripts/**",
      "*.config.ts",
      "eslint.config.js",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // The map backends themselves — the only place a backend is named.
    files: ["src/ui/map/maplibre/**", "src/ui/map/mapkit/**"],
    rules: {
      "no-restricted-imports": restrict(
        NO_MANUAL_MEMO,
        ENGINE_PUBLIC_ONLY,
        SYNC_PUBLIC_ONLY,
        NO_POUCHDB,
      ),
    },
  },
  {
    // The flight surface is Ionic-free (STEERING: ultra reliable, battery
    // sensitive; it will one day run with Ionic fully disabled). The one
    // Ionic frame around it lives in src/ui/pages/FlyFrame.tsx.
    files: ["src/ui/flight/**"],
    rules: {
      "no-restricted-imports": restrict(
        NO_MANUAL_MEMO,
        ENGINE_PUBLIC_ONLY,
        SYNC_PUBLIC_ONLY,
        NO_MAP_BACKEND,
        NO_POUCHDB,
        NO_IONIC,
      ),
    },
  },
  {
    // Derived state: pure functions of fix timestamps (ARCHITECTURE.md's
    // class table). No React, no UI, no platform, no native, no database.
    files: ["src/flight/**"],
    rules: {
      "no-restricted-imports": restrict(
        NO_MANUAL_MEMO,
        ENGINE_PUBLIC_ONLY,
        SYNC_PUBLIC_ONLY,
        NO_MAP_BACKEND,
        NO_POUCHDB,
        NO_REACT,
        NO_UI,
        NO_PLATFORM,
        NO_TAURI,
      ),
    },
  },
  {
    // The store. Owns PouchDB; knows nothing about the platform.
    files: ["src/storage/**"],
    rules: {
      "no-restricted-imports": restrict(
        NO_MANUAL_MEMO,
        ENGINE_PUBLIC_ONLY,
        SYNC_PUBLIC_ONLY,
        NO_MAP_BACKEND,
        NO_REACT,
        NO_UI,
        NO_PLATFORM,
        NO_TAURI,
      ),
    },
  },
  {
    // Sync: headless, and legitimately platform-aware (Keychain vs
    // IndexedDB, StoreKit vs web) and database-aware (replicate.ts).
    files: ["src/sync/**"],
    rules: {
      "no-restricted-imports": restrict(
        NO_MANUAL_MEMO,
        ENGINE_PUBLIC_ONLY,
        SYNC_PUBLIC_ONLY,
        NO_MAP_BACKEND,
        NO_REACT,
        NO_UI,
      ),
    },
  },
  {
    // The engine, all of it: the headless world's core.
    files: ["src/engine/**"],
    rules: {
      "no-restricted-imports": restrict(
        NO_MANUAL_MEMO,
        ENGINE_PUBLIC_ONLY,
        SYNC_PUBLIC_ONLY,
        NO_MAP_BACKEND,
        NO_POUCHDB,
        NO_REACT,
        NO_UI,
      ),
    },
  },
  {
    // The engine MINUS its source-selection edge: platform-blind,
    // native-blind, and source-agnostic. Tests are exempt because a test
    // must import its subject (core.test.ts, nativeSource.test.ts).
    files: ["src/engine/**"],
    ignores: [...ENGINE_PLATFORM_AWARE, "src/engine/**/*.test.ts"],
    rules: {
      "no-restricted-imports": restrict(
        NO_MANUAL_MEMO,
        ENGINE_PUBLIC_ONLY,
        SYNC_PUBLIC_ONLY,
        NO_MAP_BACKEND,
        NO_POUCHDB,
        NO_REACT,
        NO_UI,
        NO_PLATFORM,
        NO_TAURI,
        ENGINE_SOURCES_PRIVATE,
      ),
    },
  },
  {
    // No location.reload() in app code. The one sanctioned exception is the
    // web denied-error screen's Reload button: pilot-initiated, pre-flight,
    // WAL-rehydrated (CLAUDE.md).
    ignores: ["src/ui/flight/ErrorScreen.tsx"],
    rules: {
      "no-restricted-syntax": ["error", NO_RELOAD],
    },
  },
  {
    // The deriving layer reads no clock. format.ts is display formatting,
    // not a decision, and takes `now` as an injectable argument.
    files: ["src/flight/**"],
    ignores: ["src/flight/format.ts"],
    rules: {
      "no-restricted-syntax": ["error", NO_RELOAD, ...NO_WALL_CLOCK],
    },
  },
  {
    ignores: [
      "dist/",
      "node_modules/",
      "src-tauri/target/",
      "src-tauri/gen/",
      "playwright-report/",
      "test-results/",
      // Local session scratch (git worktrees, agent state). An embedded
      // worktree carries its own tsconfig, which otherwise breaks the
      // typed-lint root resolution across the whole repo.
      ".claude/",
    ],
  },
);
