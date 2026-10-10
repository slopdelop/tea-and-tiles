import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "ui-regression.spec.ts",
  grep: process.env.UI_TEST_GREP
    ? new RegExp(process.env.UI_TEST_GREP)
    : undefined,
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  outputDir: "test-results/ui",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/ui", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:5183",
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || "chrome",
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 5183 --strictPort",
    url: "http://127.0.0.1:5183",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      VITE_USE_EMULATORS: "true",
      VITE_FIREBASE_PROJECT_ID: "demo-tea-and-tiles-ui-tests",
      VITE_EMULATOR_HOST: "127.0.0.1",
      VITE_FUNCTIONS_REGION: "europe-west2",
      VITE_AUTH_EMULATOR_PORT: "9199",
      VITE_FIRESTORE_EMULATOR_PORT: "8180",
      VITE_FUNCTIONS_EMULATOR_PORT: "5101",
    },
  },
});
