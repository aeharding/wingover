import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

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
    ],
    holdUntilCrawlEnd: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    setupFiles: ["src/test-setup.ts"],
  },
});
