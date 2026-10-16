import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "cloud-soak.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 30 * 60_000,
  globalTimeout: 32 * 60_000,
  expect: { timeout: 20_000 },
  outputDir: "test-results/cloud-soak",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/cloud-soak", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:5185",
    channel: "chrome",
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/cloud-test-web.mjs",
    url: "http://127.0.0.1:5185",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
