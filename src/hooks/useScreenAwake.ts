import { useCallback, useEffect, useRef, useState } from "react";

const preferenceKey = "tea-and-tiles:keep-awake";
export function useScreenAwake(playing: boolean) {
  const supported = typeof navigator !== "undefined" && "wakeLock" in navigator;
  const [enabled, updateEnabled] = useState(() => {
    try {
      return localStorage.getItem(preferenceKey) === "true";
    } catch {
      return false;
    }
  });
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState("");
  const sentinel = useRef<WakeLockSentinel | null>(null);
  const generation = useRef(0);
  const wanted = useRef(false);
  wanted.current = enabled && playing;
  const release = useCallback(async () => {
    generation.current++;
    const lock = sentinel.current;
    sentinel.current = null;
    setActive(false);
    if (lock && !lock.released) await lock.release().catch(() => {});
  }, []);
  const acquire = useCallback(async () => {
    if (!supported || !wanted.current || document.hidden || sentinel.current)
      return;
    const request = ++generation.current;
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (
        request !== generation.current ||
        !wanted.current ||
        document.hidden
      ) {
        await lock.release();
        return;
      }
      sentinel.current = lock;
      setActive(true);
      setStatus("Screen stays awake while this game is visible.");
      lock.addEventListener("release", () => {
        if (sentinel.current === lock) {
          sentinel.current = null;
          setActive(false);
          setStatus("The device released the screen lock.");
        }
      });
    } catch {
      setStatus(
        "Your device couldn’t keep the screen awake. Low Power Mode may prevent it.",
      );
    }
  }, [supported]);
  useEffect(() => {
    if (enabled && playing) void acquire();
    else void release();
    const visibility = () => {
      if (document.hidden) void release();
      else void acquire();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      void release();
    };
  }, [enabled, playing, acquire, release]);
  const setEnabled = useCallback(
    async (value: boolean) => {
      wanted.current = value && playing;
      updateEnabled(value);
      try {
        localStorage.setItem(preferenceKey, String(value));
      } catch {
        /* Optional preference. */
      }
      // The enabled-state effect requests the lock once after committing the
      // preference. Requesting here too creates competing asynchronous locks.
      if (!value) await release();
      if (!value) setStatus("");
    },
    [playing, release],
  );
  return { enabled, supported, active, status, setEnabled };
}
