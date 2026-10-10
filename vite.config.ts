import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import packageInfo from "./package.json";
import { execFileSync } from "node:child_process";
const { version } = packageInfo;
let revision = "local";
try {
  revision = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
} catch {
  // Source archives can still be built without a Git checkout.
}
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const base = process.env.VITE_BASE_PATH || env.VITE_BASE_PATH || "/";
  if (!base.startsWith("/") || !base.endsWith("/"))
    throw new Error("VITE_BASE_PATH must start and end with /");
  return {
    base,
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(
        `${version} · ${mode === "development" ? "local" : revision}`,
      ),
    },
    server: {
      watch: {
        // Writing browser-test reports must not reload an active local match.
        ignored: ["**/playwright-report/**", "**/test-results/**"],
      },
    },
    plugins: [
      react(),
      VitePWA({
        registerType: "prompt",
        scope: base,
        base,
        includeAssets: ["icons/*.png", "icons/*.svg"],
        manifest: {
          name: "Tea & Tiles",
          short_name: "Tea & Tiles",
          description: "A little word game for two.",
          theme_color: "#f6f0e5",
          background_color: "#f6f0e5",
          display: "standalone",
          start_url: base,
          scope: base,
          icons: [
            { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
            {
              src: "icons/icon-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any maskable",
            },
          ],
        },
        workbox: {
          navigateFallback: "index.html",
          globPatterns: ["**/*.{js,css,html,png,svg,woff2,txt}"],
          runtimeCaching: [],
          cleanupOutdatedCaches: true,
        },
      }),
    ],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (
              id.includes("node_modules/firebase") ||
              id.includes("node_modules/@firebase")
            )
              return "firebase";
            if (
              id.includes("node_modules/motion") ||
              id.includes("node_modules/framer-motion")
            )
              return "motion";
          },
        },
      },
    },
  };
});
