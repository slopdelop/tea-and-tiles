import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "e2e.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || "chrome",
    viewport: { width: 1180, height: 820 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 5173 --strictPort",
    url: "http://127.0.0.1:5173",
    // Always start our explicitly configured demo frontend, never reuse a
    // developer server that might have a different Firebase project selected.
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      VITE_USE_EMULATORS: "true",
      VITE_FIREBASE_PROJECT_ID: "demo-tea-and-tiles-tests",
      VITE_EMULATOR_HOST: "127.0.0.1",
      VITE_FUNCTIONS_REGION: "europe-west2",
    },
  },
});
