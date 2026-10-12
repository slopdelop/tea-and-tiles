import type { FirestoreSettings } from "firebase/firestore";

type BrowserIdentity = Pick<Navigator, "userAgent" | "maxTouchPoints">;
// Firebase's browser SDK accepts this setting, although its public TypeScript
// interface currently omits it. The SDK-level regression test protects this
// compatibility option when dependencies change.
type BrowserFirestoreSettings = FirestoreSettings & {
  useFetchStreams?: boolean;
};

export function firestoreTransport(
  emulator: boolean,
  browser?: BrowserIdentity,
): BrowserFirestoreSettings {
  const ua = browser?.userAgent || "";
  const appleMobile =
    /iPad|iPhone|iPod/i.test(ua) ||
    (/Macintosh/i.test(ua) && (browser?.maxTouchPoints || 0) > 1);
  const safari =
    /Safari/i.test(ua) &&
    !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android/i.test(ua);
  // WebKit can buffer Firestore streaming updates until its next keep-alive.
  // Long polling alone still uses fetch streams by default. Explicitly select
  // XHR on Apple browsers to avoid the affected WebKit streaming reader.
  // https://github.com/firebase/firebase-js-sdk/issues/9789
  const appleBrowser = appleMobile || safari;
  return {
    ...(!emulator && appleBrowser
      ? { experimentalForceLongPolling: true }
      : { experimentalAutoDetectLongPolling: true }),
    ...(appleBrowser ? { useFetchStreams: false } : {}),
  };
}
