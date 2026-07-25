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
import simpleJsxGuard from "./eslint-rules/simple-jsx-guard.js";

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
  regex: "(^|/)engine/(?!index$|types$|session$)",
  message:
    "src/engine's public surface is index, types, session. real/wal/core/*Source are internals: the engine is reached through one injected CoreClient (ARCHITECTURE.md). isTauri and getCurrentPosition live in src/platform.",
};

// src/platform is the engine's second reader of the native permission rule:
// Center-on-me and the watch judge one PermissionStatus the same way or they
// drift, which is how the one-shot lost its Precise Location handling.
/** @type {RestrictedPattern} */
const ENGINE_PUBLIC_ONLY_PLUS_REFUSAL = {
  regex: "(^|/)engine/(?!index$|types$|session$|nativeSource$)",
  message:
    "src/platform may additionally read nativeSource's permissionRefusal (ONE refusal rule for the watch and for Center-on-me). Everything else under src/engine stays internal (ARCHITECTURE.md).",
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
  // Regex, not a glob: minimatch does not treat a leading `..` as a path
  // segment, so "../platform" slips past "**/platform".
  regex: "(^|/)platform$",
  message:
    "It never switches on the platform: sources declare capabilities and the engine adapts (ARCHITECTURE.md). Platform choice lives in src/platform and the selection modules only.",
};

/** @type {RestrictedPattern} */
const NO_TAURI = {
  group: ["@tauri-apps/*"],
  message:
    "Native IPC belongs to the shim modules (nativeSource, platform/currentPosition, sync/store/keychain, sync/providers/apple, ui/download, ui/externalLinks), never to engine logic (ARCHITECTURE.md).",
};

/** @type {RestrictedPattern} */
const ENGINE_SOURCES_PRIVATE = {
  group: [
    "./core",
    "./nativeSource",
    "./gpxSource",
    "./simulatorSource",
    "./webSource",
  ],
  message:
    "Source selection happens in exactly one place, src/engine/index.ts: one interface, a web implementation, a native implementation (ARCHITECTURE.md).",
};

// src/engine's platform-aware edge: the source-SELECTION modules, and only
// those. index.ts picks the CoreClient; nativeSource.ts is the native one.
// Everything else under src/engine is platform-blind. The seam itself
// (isTauri) and the one-shot Center-on-me selector moved out to
// src/platform, so this list is as short as the doctrine says it should be.
const ENGINE_PLATFORM_AWARE = [
  "src/engine/index.ts",
  "src/engine/nativeSource.ts",
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
    "No location.reload() in app code: instance-swap and notify instead (AGENTS.md).",
};

// no-restricted-imports only sees `import` statements, so every seam above
// has a second door: `await import("react")` is the same dependency with
// none of the enforcement. These close it for the headless scopes, mirroring
// exactly the static ban each scope already carries.
//
// Known residue, deliberately un-lintable: an aliased indirection defeats a
// syntactic rule (`const d = Date; d.now()`, `globalThis["Date"]`,
// `import(someVariable)`), and so does a string built at runtime. The rules
// exist to make the seam the obvious path and a crossing loud in review, not
// to be a sandbox — a determined bypass is a code-review finding, and the
// three genuinely unmechanizable questions are asked instead of linted
// (docs/ENGINE-AUDIT.md, "Not lintable").
//
// The unicode escapes below are path separators. esquery reads a selector's
// regex literal as everything up to the next slash, escaped or not, so a
// literal "/" cannot appear in one: it arrives as an escape the RegExp
// constructor resolves instead.
const NO_DYNAMIC_REACT = {
  selector:
    "ImportExpression[source.value=/^(react|react-dom(\\u002F.*)?|@ionic\\u002F.*)$/]",
  message:
    "Headless world: React/Ionic live in src/ui/ only (STEERING.md). A dynamic import is the same dependency.",
};

const NO_DYNAMIC_TAURI = {
  selector: "ImportExpression[source.value=/^@tauri-apps\\u002F/]",
  message:
    "Native IPC belongs to the shim modules, never to headless logic (ARCHITECTURE.md). A dynamic import is the same dependency.",
};

const NO_DYNAMIC_PLATFORM = {
  selector: "ImportExpression[source.value=/(^|\\u002F)platform$/]",
  message:
    "It never switches on the platform: sources declare capabilities and the engine adapts (ARCHITECTURE.md). A dynamic import is the same dependency.",
};

// What a headless scope bans dynamically: React/Ionic and native IPC
// everywhere, the platform seam wherever the static NO_PLATFORM applies.
const NO_DYNAMIC_HEADLESS = [
  NO_DYNAMIC_REACT,
  NO_DYNAMIC_TAURI,
  NO_DYNAMIC_PLATFORM,
];

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
      wingover: {
        rules: {
          "max-usestate": maxUseState,
          "simple-jsx-guard": simpleJsxGuard,
        },
      },
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
    // The platform seam: the ONE layer that may ask where it is running and
    // reach native IPC to act on the answer. Everything else about it is a
    // headless module — no React, no UI, no database — and its window into
    // the engine is the shared permission refusal, nothing more.
    files: ["src/platform/**"],
    rules: {
      "no-restricted-imports": restrict(
        NO_MANUAL_MEMO,
        ENGINE_PUBLIC_ONLY_PLUS_REFUSAL,
        SYNC_PUBLIC_ONLY,
        NO_MAP_BACKEND,
        NO_POUCHDB,
        NO_REACT,
        NO_UI,
      ),
    },
  },
  {
    // No location.reload() in app code. The one sanctioned exception is the
    // web denied-error screen's Reload button: pilot-initiated, pre-flight,
    // WAL-rehydrated (AGENTS.md).
    ignores: ["src/ui/flight/ErrorScreen.tsx"],
    rules: {
      "no-restricted-syntax": ["error", NO_RELOAD],
    },
  },
  {
    // The dynamic-import half of the headless seams, scope by scope, each
    // mirroring the static bans that scope already carries. src/sync is
    // legitimately native, so only its two IPC shims are exempt.
    files: ["src/flight/**", "src/storage/**"],
    rules: {
      "no-restricted-syntax": ["error", NO_RELOAD, ...NO_DYNAMIC_HEADLESS],
    },
  },
  {
    files: ["src/engine/**"],
    ignores: [...ENGINE_PLATFORM_AWARE, "src/engine/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", NO_RELOAD, ...NO_DYNAMIC_HEADLESS],
    },
  },
  {
    files: ["src/sync/**"],
    ignores: ["src/sync/providers/apple.ts", "src/sync/store/keychain.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_RELOAD,
        NO_DYNAMIC_REACT,
        NO_DYNAMIC_TAURI,
      ],
    },
  },
  {
    // The deriving layer reads no clock. format.ts is display formatting,
    // not a decision, and takes `now` as an injectable argument.
    files: ["src/flight/**"],
    ignores: ["src/flight/format.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_RELOAD,
        ...NO_DYNAMIC_HEADLESS,
        ...NO_WALL_CLOCK,
      ],
    },
  },
  {
    // ─── The size ceilings ────────────────────────────────────────────
    //
    // A component may not become the whole app. Both counts SKIP comments
    // and blank lines on purpose: this codebase carries its doctrine in
    // prose next to the code it governs, and a budget that taxes the
    // explanation buys shorter files by deleting the reason for them.
    //
    // The numbers are ceilings set just above today's runner-up, not
    // targets — a ratchet, to be lowered as each file below them is
    // decomposed (see the PR that introduced this). At the time of
    // writing the whole repo passes, and the runner-ups are
    // FlightDetailPage.tsx (471 code lines, one 389-line component) and
    // Barogram.tsx (395-line component).
    //
    // Scoped to components: .ts modules under src/ui (the trace renderer,
    // the map adapters) are pipelines and state machines whose shape is
    // not a screen's, and they answer to the per-function limits instead.
    files: ["src/ui/**/*.tsx"],
    ignores: ["src/ui/**/*.test.tsx"],
    rules: {
      "max-lines": [
        "error",
        { max: 500, skipBlankLines: true, skipComments: true },
      ],
      "max-lines-per-function": [
        "error",
        { max: 400, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
    },
  },
  {
    // Cyclomatic complexity, everywhere but the tests (a table-driven
    // spec's branches are its cases). The "modified" variant counts a
    // whole switch as ONE, which is the point: a switch — including
    // switch (true) — is the house answer to a ternary pile, and a metric
    // that charges per case would push code back toward the thing being
    // replaced. Generous by default-standards (ESLint's default is 20)
    // because in TSX every `?.`, `??` and `&&` guard also scores, so a
    // component's number measures null-safety as much as tangled logic.
    // Same ratchet as above: today's runner-up is useReplayDrawer.tsx (53).
    //
    // no-nested-ternary rides along, repo-wide, for the same reason and
    // with the same exemption. A ternary inside a ternary is the shape the
    // house style exists to prevent: the branches stop lining up with the
    // conditions and the reader has to rebuild the decision from operator
    // precedence. The answer is never a tidier expression — it is a
    // function with early returns, or a switch (switch (true) when the
    // arms are ranges rather than a discriminant). Turned on here it cost
    // 11 sites; all 11 were converted, none suppressed.
    files: ["src/**"],
    ignores: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    rules: {
      complexity: ["error", { max: 55, variant: "modified" }],
      "no-nested-ternary": "error",
    },
  },
  {
    // ─── The flight surface's own budget ──────────────────────────────
    //
    // The flight surface is already this config's strictest scope (see
    // the Ionic-free block above, and STEERING's "Reliability over
    // features: a smaller app that never drops a track beats a bigger one
    // that sometimes does"). It is also where the size rules were earned:
    // FlyPage was 717 lines and complexity 65 before the decomposition
    // that shipped these rules. So the ceilings here are the real budget,
    // and the house ones above are the backstop.
    // Runner-ups on this surface: LiveTrackMap.tsx (274 code lines, a
    // 226-line component) and traceRenderer.ts (complexity 22).
    //
    // Tests exempt, like the two blocks above: a table-driven spec's
    // branches are its cases, and src/engine/real.test.ts is 2000 lines by
    // design. There is no flight test file yet; without this the first one
    // written would be the only spec in the repo held to a 25 complexity.
    files: ["src/ui/flight/**"],
    ignores: ["src/ui/flight/**/*.test.ts", "src/ui/flight/**/*.test.tsx"],
    rules: {
      "max-lines-per-function": [
        "error",
        { max: 250, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      complexity: ["error", { max: 25, variant: "modified" }],
      // `{cond && <X />}` for one named guard; anything composite gets a
      // name or an early-return render function (eslint-rules/
      // simple-jsx-guard.js).
      //
      // STILL SCOPED TO THIS SURFACE, deliberately, now that its former
      // travelling companion no-nested-ternary has gone repo-wide (see the
      // complexity block above). The two are not the same kind of rule. A
      // nested ternary is wrong everywhere and the fix is mechanical, so
      // it graduated. This one draws a taste line — how much logic may sit
      // in a render position — and it costs 21 sites across the ground
      // app (MapCluster ×4, ClipDock ×4, DesktopShell ×4, FlightDetailPage
      // ×3, Barogram ×3, plus SettingsPage, PlanPage, LogbookPage,
      // SyncConnection, MapProviderPage, ConnectFunnel, FlightSeat,
      // LogbookSection). Widening it is a decision to make on its own,
      // against the ground app's own surfaces, not a rider on this PR.
      "wingover/simple-jsx-guard": "error",
    },
  },
  {
    files: ["src/ui/flight/**/*.tsx"],
    ignores: ["src/ui/flight/**/*.test.tsx"],
    rules: {
      "max-lines": [
        "error",
        { max: 300, skipBlankLines: true, skipComments: true },
      ],
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
