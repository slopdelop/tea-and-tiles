import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
const base = "/tea-and-tiles/";
const env = {
  ...process.env,
  VITE_BASE_PATH: base,
  VITE_USE_EMULATORS: "true",
  VITE_FIREBASE_PROJECT_ID: "demo-tea-and-tiles-ui-tests",
  VITE_EMULATOR_HOST: "127.0.0.1",
  VITE_AUTH_EMULATOR_PORT: "9199",
  VITE_FIRESTORE_EMULATOR_PORT: "8180",
  VITE_FUNCTIONS_EMULATOR_PORT: "5101",
};
const vite = resolve("node_modules/vite/bin/vite.js");
await new Promise((done, fail) => {
  const build = spawn(process.execPath, [vite, "build"], {
    stdio: "inherit",
    env,
  });
  build.on("error", fail);
  build.on("exit", (code) =>
    code === 0 ? done() : fail(new Error(`Build failed: ${code}`)),
  );
});
const preview = spawn(
  process.execPath,
  [
    vite,
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "4173",
    "--strictPort",
    "--base",
    base,
  ],
  { stdio: "inherit", env },
);
let browser;
try {
  const origin = "http://127.0.0.1:4173";
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      ready = (await fetch(origin + base)).ok;
      if (ready) break;
    } catch {}
    await new Promise((done) => setTimeout(done, 250));
  }
  if (!ready) throw new Error("Preview did not start");
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || "chrome",
  });
  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
  });
  const page = await context.newPage();
  const failedAssets = [];
  page.on("response", (response) => {
    if (response.url().startsWith(origin) && response.status() >= 400)
      failedAssets.push(response.url());
  });
  await page.goto(origin + base);
  await expect(page.locator(".brand")).toContainText("Tea");
  const manifest = await (
    await page.request.get(origin + base + "manifest.webmanifest")
  ).json();
  expect(manifest.scope).toBe(base);
  expect(manifest.start_url).toBe(base);
  for (const icon of manifest.icons) {
    const response = await page.request.get(
      new URL(icon.src, origin + base).href,
    );
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("image/png");
  }
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
    )
    .toBe(origin + base + "sw.js");
  expect(
    await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistration())?.scope,
    ),
  ).toBe(origin + base);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  expect(failedAssets).toEqual([]);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator(".brand")).toContainText("Tea");
  const cacheURLs = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) urls.push(request.url);
    }
    return urls;
  });
  expect(cacheURLs.length).toBeGreaterThan(10);
  expect(cacheURLs.every((url) => url.startsWith(origin + base))).toBe(true);
  expect(
    cacheURLs.some((url) => new URL(url).pathname.endsWith(".woff2")),
  ).toBe(true);
  const wordsURL = cacheURLs.find((url) =>
    /\/assets\/words-[^/]+\.txt$/.test(new URL(url).pathname),
  );
  expect(wordsURL).toBeTruthy();
  const offlineWords = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return { ok: response.ok, body: await response.text() };
  }, wordsURL);
  expect(offlineWords.ok).toBe(true);
  expect(offlineWords.body).toMatch(/(^|\r?\n)CAT(\r?\n|$)/);
  expect(offlineWords.body.split(/\s+/).length).toBeGreaterThan(1000);
  expect(
    offlineWords.body.trimStart().toLowerCase().startsWith("<!doctype"),
  ).toBe(false);
  expect(
    cacheURLs.some((url) => /firestore|googleapis|5001|9099/.test(url)),
  ).toBe(false);
  mkdirSync("test-results/pwa", { recursive: true });
  await page.screenshot({
    path: "test-results/pwa/offline-shell.png",
    fullPage: true,
  });
  console.log(
    "PASS: repository subpath, manifest/icons, scoped service worker, local fonts and base word list, static-only cache and offline app shell.",
  );
  await context.close();
} finally {
  if (browser) await browser.close();
  preview.kill();
}
