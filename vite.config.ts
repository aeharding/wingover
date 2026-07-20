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

// The commit this build was cut from, for the settings footer (Voyager-style
// version + sha). Not read from git: the Docker build context excludes .git
// (see .dockerignore), and a dev working copy is not a release. CI passes it
// from the Actions context instead — docker.yml sends github.sha as GIT_SHA for
// a continuous build (:main -> beta.wingover.app) and an empty sha for a version
// tag (-> wingover.app / App Store), so a release footer shows the clean version
// alone. GITHUB_SHA is the same value auto-exported on the direct runner, the
// fallback for the TestFlight build (which only ever builds main). Empty for
// local dev builds. Sliced to 8 chars.
const gitSha = (process.env.GIT_SHA ?? process.env.GITHUB_SHA ?? "").slice(0, 8);

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_GIT_SHA__: JSON.stringify(gitSha),
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
      "@tauri-apps/plugin-geolocation",
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
    include: ["src/**/*.test.ts"],
    environment: "node",
    setupFiles: ["src/test-setup.ts"],
  },
});
