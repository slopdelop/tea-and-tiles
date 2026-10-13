import {
  MOVE_DIAGNOSTICS_ENABLED,
  type DiagnosticReply,
  type MoveDiagnosticReport,
} from "../../shared/move-diagnostics";
import { createMoveDiagnostics } from "./moveDiagnostics";
import { createDiagnosticOutbox } from "./diagnosticOutbox";

export function startBrowserDiagnostics(
  identity: string,
  request: (
    input:
      { action: "clock" } | { action: "report"; report: MoveDiagnosticReport },
  ) => Promise<DiagnosticReply>,
  transport: string,
) {
  if (
    !MOVE_DIAGNOSTICS_ENABLED ||
    import.meta.env.VITE_MOVE_DIAGNOSTICS_ENABLED === "false"
  )
    return null;
  const key = `tea-move-diagnostics-budget:${identity}`;
  const outboxKey = `tea-move-diagnostics-outbox:${identity}`;
  const outbox = createDiagnosticOutbox({
    now: () => performance.now(),
    online: () => navigator.onLine,
    load: () => {
      try {
        const raw = localStorage.getItem(outboxKey);
        if (!raw || raw.length > 80000) return [];
        const reports = JSON.parse(raw);
        return Array.isArray(reports)
          ? reports.filter(
              (report) =>
                typeof report?.id === "string" && Array.isArray(report?.events),
            )
          : [];
      } catch {
        return [];
      }
    },
    save: (reports) => {
      try {
        if (reports.length)
          localStorage.setItem(outboxKey, JSON.stringify(reports));
        else localStorage.removeItem(outboxKey);
      } catch {
        /* Retain the in-memory copy when storage is full. */
      }
    },
    send: (report) => request({ action: "report", report }),
  });
  const supported =
    typeof PerformanceObserver !== "undefined"
      ? PerformanceObserver.supportedEntryTypes || []
      : [];
  const recorder = createMoveDiagnostics({
    now: () => performance.now(),
    wall: () => Date.now(),
    visible: () => !document.hidden,
    online: () => navigator.onLine,
    clock: () => request({ action: "clock" }),
    upload: (report) => outbox.submit(report),
    schedule: (callback, ms) => window.setTimeout(callback, ms),
    cancel: (timer) => window.clearTimeout(timer as number),
    loadBudget: () => {
      try {
        const value = JSON.parse(localStorage.getItem(key) || "null");
        return value &&
          typeof value.day === "string" &&
          Number.isInteger(value.count) &&
          value.count >= 0
          ? value
          : null;
      } catch {
        return null;
      }
    },
    saveBudget: (value) => {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* Server cap remains authoritative. */
      }
    },
    metadata: {
      version: import.meta.env.VITE_APP_VERSION || "local",
      buildTime: import.meta.env.VITE_BUILD_TIME,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scale: window.visualViewport?.scale || 1,
        pixelRatio: window.devicePixelRatio || 1,
        touchPoints: navigator.maxTouchPoints || 0,
      },
      browser: navigator.userAgent.slice(0, 256),
      standalone:
        matchMedia("(display-mode: standalone)").matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true,
      transport,
      longTaskSupport: supported.includes("longtask"),
    },
  });
  const visibility = () => {
    recorder.visibility();
    if (!document.hidden) void outbox.flush();
  };
  const pageshow = (event: PageTransitionEvent) => {
    if (event.persisted) visibility();
  };
  const online = () => {
    recorder.record(navigator.onLine ? "online" : "offline");
    if (navigator.onLine) {
      void recorder.calibrate();
      void outbox.flush();
    }
  };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("online", online);
  window.addEventListener("offline", online);
  window.addEventListener("pageshow", pageshow);
  // Passive sampling only: this never reads Firebase or repairs a connection.
  const tick = window.setInterval(() => recorder.tick(), 1000);
  const observers: PerformanceObserver[] = [];
  for (const type of ["longtask", "resource"]) {
    if (!supported.includes(type)) continue;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (type === "longtask")
            recorder.record("long-task", { value: Math.round(entry.duration) });
          else {
            // No URLs, query strings, tokens or response bodies enter reports.
            const path = new URL(entry.name, location.href).pathname;
            const detail = path.endsWith("/Listen/channel")
              ? "listen"
              : path.endsWith("/submitCommand")
                ? "submit"
                : null;
            if (detail)
              recorder.record("network", {
                detail,
                value: Math.round(entry.duration),
              });
          }
        }
      });
      observer.observe({ type, buffered: false });
      observers.push(observer);
    } catch {
      /* Safari may advertise an unsupported observer type. */
    }
  }
  void recorder.calibrate();
  void outbox.flush();
  return {
    recorder,
    dispose() {
      recorder.dispose();
      clearInterval(tick);
      observers.forEach((observer) => observer.disconnect());
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", online);
      window.removeEventListener("pageshow", pageshow);
    },
  };
}
