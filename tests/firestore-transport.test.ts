import { describe, expect, it } from "vitest";
import { firestoreTransport } from "../src/firestoreTransport";
import { initializeApp, deleteApp } from "firebase/app";

const browsers = [
  {
    name: "standalone iPad without Safari token",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Mobile/15E148",
    maxTouchPoints: 5,
    forced: true,
  },
  {
    name: "iPad Safari",
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 26_4 like Mac OS X) AppleWebKit/605.1.15 Version/26.4 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
    forced: true,
  },
  {
    name: "desktop-mode iPad",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/26.4 Safari/605.1.15",
    maxTouchPoints: 5,
    forced: true,
  },
  {
    name: "iPhone Chrome",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 CriOS/149 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
    forced: true,
  },
  {
    name: "Mac Safari",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.4 Safari/605.1.15",
    maxTouchPoints: 0,
    forced: true,
  },
  {
    name: "Mac Chrome",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36",
    maxTouchPoints: 0,
    forced: false,
  },
  {
    name: "Windows Edge",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0",
    maxTouchPoints: 0,
    forced: false,
  },
  {
    name: "Android Chrome",
    userAgent:
      "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/149.0.0.0 Mobile Safari/537.36",
    maxTouchPoints: 5,
    forced: false,
  },
];

describe("Firestore browser compatibility", () => {
  it.each(browsers)("selects the cloud transport for $name", (browser) => {
    const settings = firestoreTransport(false, browser);
    expect(settings.experimentalForceLongPolling === true).toBe(browser.forced);
    // Firebase rejects force and auto-detection when both are enabled.
    expect(
      settings.experimentalForceLongPolling &&
        settings.experimentalAutoDetectLongPolling,
    ).toBeFalsy();
  });
  it.each(browsers)("preserves local transport for $name", (browser) => {
    expect(firestoreTransport(true, browser)).toEqual({
      experimentalAutoDetectLongPolling: true,
      ...(browser.forced ? { useFetchStreams: false } : {}),
    });
  });
  it("handles unavailable browser identity", () => {
    expect(firestoreTransport(false)).toEqual({
      experimentalAutoDetectLongPolling: true,
    });
  });
  it.each(browsers)(
    "actually selects the browser SDK transport for $name",
    async (browser) => {
      // Import the browser entry explicitly: Node's default entry has different
      // fetch defaults and would conceal the bug this test is meant to catch.
      const browserEntry = new URL(
        "../node_modules/@firebase/firestore/dist/index.esm.js",
        import.meta.url,
      ).href;
      const { initializeFirestore } = await import(
        /* @vite-ignore */ browserEntry
      );
      for (const emulator of [false, true]) {
        const app = initializeApp(
          { projectId: "demo-transport-test" },
          `${browser.name}-${emulator}`,
        );
        try {
          // Initialization/settings inspection never starts a listener or an RPC.
          const db = initializeFirestore(
            app,
            firestoreTransport(emulator, browser),
          );
          const effective = db._getSettings();
          expect(effective.useFetchStreams).toBe(!browser.forced);
          expect(effective.experimentalForceLongPolling).toBe(
            !emulator && browser.forced,
          );
        } finally {
          await deleteApp(app);
        }
      }
    },
  );
});
