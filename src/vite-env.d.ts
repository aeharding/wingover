/// <reference types="vite/client" />

// Injected at build time by Vite's `define` from package.json's `version`.
declare const __APP_VERSION__: string;

// The 8-char commit SHA of the release build, from CI (see vite.config.ts).
// Empty string for local dev builds.
declare const __APP_GIT_SHA__: string;
