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

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
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
    // and repeat loads are instant. autoUpdate = a new deploy's worker takes
    // over without a prompt. The manifest already lives in public/ (linked
    // from index.html + the landing), so this only adds the worker. Disabled
    // in dev by default, so the dev server and e2e never see it.
    VitePWA({
      registerType: "autoUpdate",
      manifest: false,
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
        // maplibre + Ionic + PouchDB make one big chunk; the 2 MB default
        // would silently drop it from the precache.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Deep links load the SPA shell offline. Only the SPA's OWN routes
        // fall back to index.html; "/" (landing), /privacy and /s/ (share)
        // are Caddy's static pages and must reach the network, not the shell.
        navigateFallback: "/index.html",
        navigateFallbackAllowlist: [/^\/(fly|logbook|plan|settings)(\/|$)/],
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
