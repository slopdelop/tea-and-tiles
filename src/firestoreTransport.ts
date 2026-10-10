import type { FirestoreSettings } from "firebase/firestore";

type BrowserIdentity = Pick<Navigator, "userAgent" | "maxTouchPoints">;

export function firestoreTransport(
  emulator: boolean,
  browser?: BrowserIdentity,
): FirestoreSettings {
  const ua = browser?.userAgent || "";
  const appleMobile =
    /iPad|iPhone|iPod/i.test(ua) ||
    (/Macintosh/i.test(ua) && (browser?.maxTouchPoints || 0) > 1);
  const safari =
    /Safari/i.test(ua) &&
    !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android/i.test(ua);
  // WebKit can buffer Firestore streaming updates until its next keep-alive.
  // Close each response after data arrives rather than relying on detection.
  // https://github.com/firebase/firebase-js-sdk/issues/9789
  return !emulator && (appleMobile || safari)
    ? { experimentalForceLongPolling: true }
    : { experimentalAutoDetectLongPolling: true };
}
