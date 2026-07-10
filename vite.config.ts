import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Set by `tauri ios dev --host`: the LAN address the phone loads the dev
// server from. Vite must listen on it (and serve HMR over it) or the
// device gets a connection refused.
const tauriDevHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [
    react(),
    babel({
      presets: [reactCompilerPreset()],
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
