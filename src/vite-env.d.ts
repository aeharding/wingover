/// <reference types="vite/client" />

// Build identity, injected by Vite's `define` (see vite.config.ts for how each
// value is derived and which ring it comes from).

// package.json's `version`, e.g. "0.3.0".
declare const __APP_VERSION__: string;

// The 8-char commit SHA this build was cut from, from CI. Empty when no CI
// stamped it (dev server, hand-rolled `pnpm build`).
declare const __APP_GIT_SHA__: string;

// The CI run number, the same number fastlane stamps into the IPA. Empty
// outside CI.
declare const __APP_BUILD__: string;

// Which release ring this bundle came from. "development" also covers a PR
// image and any local build; the dev server is detected at runtime instead
// (import.meta.env.DEV), since one build config serves dev and preview.
declare const __APP_CHANNEL__: "development" | "beta" | "production";
