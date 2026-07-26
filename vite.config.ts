import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

import { fakeAuth } from "./dev/fake-auth-plugin";
import { landingAtRoot } from "./dev/landing-plugin";
import { version } from "./package.json";

// Set by `tauri ios dev --host`: the LAN address the phone loads the dev
// server from. Vite must listen on it (and serve HMR over it) or the
// device gets a connection refused.
const tauriDevHost = process.env.TAURI_DEV_HOST;

// ---- Build identity (Voyager's model: version + build number + the ref the
// build was cut from) -------------------------------------------------------
//
// Three rings, and the settings footer must never let one impersonate another:
//
//   development  a dev server, a hand-rolled `pnpm build`, or a PR image
//   beta         a main build: TestFlight, and :main -> beta.wingover.app
//   production   a build cut from the version tag: :latest -> wingover.app,
//                and the App Store binary promoted from that same tag
//
// Nothing here reads git. The Docker build context excludes .git (see
// .dockerignore) and a working copy is not a release, so CI hands the facts in
// from the Actions context. GITHUB_* are auto-exported on a direct runner, so
// testflight.yml needs no wiring past the BUILD_NUMBER it already gives
// fastlane; a container inherits none of that env, so docker.yml forwards all
// three as build args. Every value is honest or empty: nothing is overloaded
// to mean "release" by omission.
const fullSha = process.env.GIT_SHA ?? process.env.GITHUB_SHA ?? "";
const gitSha = fullSha.slice(0, 8);
const gitRef = process.env.GIT_REF ?? process.env.GITHUB_REF_NAME ?? "";
// The number fastlane stamps into the IPA (`--build-number`), so a TestFlight
// tester can name the exact build from the footer. Same number on the web side:
// both are github.run_number.
const appBuild =
  process.env.BUILD_NUMBER ?? process.env.GITHUB_RUN_NUMBER ?? "";

// Production iff the ref IS the version being built. release-it tags bare
// `0.3.0` (.release-it.json), so `ref === package.json version` is exactly
// Voyager's check; a tag that disagrees with package.json is not a release and
// stays out of the production ring instead of claiming it. Main is the beta
// ring. Everything else (PR image, local build, dev server) is development and
// says so in the footer. The dev SERVER is decided in the component via
// import.meta.env.DEV, which keeps `vite preview` of a local build honest.
const channel =
  gitRef && gitRef === version
    ? "production"
    : gitRef === "main"
      ? "beta"
      : "development";

export default defineConfig({
  // DIAGNOSTIC BRANCH ONLY — do not merge. A minified stack cost a whole
  // investigation round on #185 ("adapter-CZk-FrZQ.js:1:4161" names nothing),
  // so this build keeps function names and ships sourcemaps.
  build: {
    minify: false,
    sourcemap: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_GIT_SHA__: JSON.stringify(gitSha),
    __APP_BUILD__: JSON.stringify(appBuild),
    __APP_CHANNEL__: JSON.stringify(channel),
  },
  plugins: [
    react(),
    babel({
      presets: [reactCompilerPreset()],
    }),
    // Dev/e2e only — serves POST /v1/session against the local dev CouchDB so
    // sync is developable with no Apple, no StoreKit and no Mac. Never built.
    fakeAuth(),
    // Dev/preview parity with Caddy's exact-/ landing route.
    landingAtRoot(),
    // Service worker: precache the app shell so a cold start works offline
    // and repeat loads are instant. registerType "prompt" (paired with a worker
    // that does NOT skipWaiting/clientsClaim, see src/sw.ts) so a new deploy's
    // worker WAITS instead of hijacking an open tab — a hijacked tab still runs
    // the old index.html and would 404 on the old chunk hashes this deploy
    // dropped, breaking the map until a manual refresh. The update lands on the
    // next launch. The manifest already lives in public/ (linked from
    // index.html + the landing), so this only adds the worker. Disabled in dev
    // by default, so the dev server and e2e never see it.
    VitePWA({
      registerType: "prompt",
      manifest: false,
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
        // maplibre + Ionic + PouchDB make one big chunk; the 2 MB default
        // would silently drop it from the precache.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
  optimizeDeps: {
    include: [
      "maplibre-gl",
      "@ionic/react",
      "@ionic/react-router",
      "ionicons/icons",
      "virtua",
      "pouchdb-browser",
      "events",
      "@tauri-apps/api/core",
    ],
    holdUntilCrawlEnd: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    host: tauriDevHost ?? false,
    hmr: tauriDevHost
      ? { protocol: "ws", host: tauriDevHost, port: 5183 }
      : undefined,
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    setupFiles: ["src/test-setup.ts"],
  },
});
