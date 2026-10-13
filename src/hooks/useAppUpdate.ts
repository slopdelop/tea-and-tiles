import { useCallback, useEffect, useRef, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { applyNewGameUpdate } from "./newGameUpdate";
import { sharePendingCheck } from "./sharedCheck";

export function useAppUpdate() {
  const registration = useRef<ServiceWorkerRegistration | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const boundaryCheck = useRef(false);
  const pendingCheck = useRef<Promise<boolean> | null>(null);
  const {
    needRefresh: [available, setAvailable],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, value) {
      registration.current = value;
      setReady(!!value);
    },
    onRegisterError() {
      setError("Could not check for updates. Try again when connected.");
    },
  });
  const check = useCallback(
    () =>
      sharePendingCheck(pendingCheck, async () => {
        const current = registration.current;
        if (!current) {
          setStatus(
            import.meta.env.DEV
              ? "Updates are available on the published app."
              : "The app is getting ready to check for updates.",
          );
          return false;
        }
        setChecking(true);
        setError(null);
        try {
          await current.update();
          const installing = current.installing;
          if (installing)
            await new Promise<void>((resolve) => {
              const finish = () => {
                clearTimeout(timer);
                installing.removeEventListener("statechange", changed);
                resolve();
              };
              const changed = () => {
                if (
                  installing.state === "installed" ||
                  installing.state === "redundant"
                )
                  finish();
              };
              const timer = window.setTimeout(finish, 15000);
              installing.addEventListener("statechange", changed);
              changed();
            });
          if (current.waiting) setAvailable(true);
          setStatus(
            current.waiting
              ? "An update is ready."
              : current.installing
                ? "The update is still downloading. Check again shortly."
                : "You’re up to date.",
          );
          return !!current.waiting;
        } catch {
          setError("Could not check for updates. Try again when connected.");
          return false;
        } finally {
          setChecking(false);
        }
      }),
    [setAvailable],
  );
  useEffect(() => {
    const foreground = () => {
      if (!document.hidden && navigator.onLine) void check();
    };
    const timer = window.setInterval(foreground, 5 * 60 * 1000);
    window.addEventListener("online", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [check]);
  const apply = useCallback(async () => {
    setError(null);
    setApplying(true);
    try {
      await updateServiceWorker(true);
      return true;
    } catch {
      setApplying(false);
      setError("Could not apply the update. Try checking again.");
      return false;
    }
  }, [updateServiceWorker]);
  const applyAtNewGame = useCallback(
    async (safeToReload: () => boolean) => {
      if (boundaryCheck.current) return false;
      boundaryCheck.current = true;
      try {
        return await applyNewGameUpdate(safeToReload, check, apply);
      } finally {
        boundaryCheck.current = false;
      }
    },
    [check, apply],
  );
  return {
    ready,
    available,
    checking,
    applying,
    status,
    error,
    check,
    apply,
    applyAtNewGame,
  };
}
