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
    files: ["e2e/**", "*.config.ts", "eslint.config.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // The doctrine boundary as a directory boundary (STEERING.md): the
    // headless world must never import React or Ionic.
    files: [
      "src/engine/**",
      "src/flight/**",
      "src/storage/**",
      "src/sync/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react-dom", "react-dom/*", "@ionic/*"],
              message:
                "Headless world: React/Ionic live in src/ui/ only (STEERING.md).",
            },
          ],
        },
      ],
    },
  },
  {
    // The flight surface is Ionic-free (STEERING: ultra reliable, battery
    // sensitive; it will one day run with Ionic fully disabled). The one
    // Ionic frame around it lives in src/ui/pages/FlyPage.tsx.
    files: ["src/ui/flight/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@ionic/*"],
              message:
                "Flight UI never imports Ionic; wrap at the shell seam (src/ui/pages/FlyPage.tsx).",
            },
          ],
        },
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
