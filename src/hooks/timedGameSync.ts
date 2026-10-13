export interface TimedSyncResult {
  serverNow: number;
  status: "active" | "finished";
}

interface TimedSyncClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
}

const browserClock: TimedSyncClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Keep server-authoritative expiry while merging a burst of iOS resume events. */
export function createTimedGameSync({
  deadlineAt,
  request,
  online,
  visible,
  paused,
  onClock,
  clock = browserClock,
}: {
  deadlineAt: number;
  request: () => Promise<TimedSyncResult>;
  online: () => boolean;
  visible: () => boolean;
  paused: () => boolean;
  onClock: (offset: number) => void;
  clock?: TimedSyncClock;
}) {
  let stopped = false;
  let finished = false;
  let inFlight = false;
  let retryDelay = 1_000;
  let timeout: unknown;
  let lastSuccessfulSync: number | null = null;
  let lastOffset = 0;

  const cancelTimer = () => {
    if (timeout !== undefined) clock.clearTimeout(timeout);
    timeout = undefined;
  };
  const schedule = (delay: number) => {
    cancelTimer();
    // Deadline and retry callbacks never use the resume coalescing window.
    if (!stopped) timeout = clock.setTimeout(() => void check(), delay);
  };
  const check = async () => {
    if (stopped || finished || inFlight || !online()) return;
    inFlight = true;
    const started = clock.now();
    try {
      const result = await request();
      if (stopped) return;
      const completed = clock.now();
      lastOffset = result.serverNow - (started + completed) / 2;
      lastSuccessfulSync = completed;
      onClock(lastOffset);
      retryDelay = 1_000;
      if (result.status === "active") {
        // A just-early request must not create a hot loop at the deadline.
        schedule(Math.max(1_000, deadlineAt - (completed + lastOffset) + 50));
      } else {
        finished = true;
        cancelTimer();
      }
    } catch {
      lastSuccessfulSync = null;
      if (!stopped && !paused()) {
        schedule(retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      void check();
    },
    resume() {
      if (stopped || finished || inFlight || !visible()) return;
      const now = clock.now();
      const sinceSuccess =
        lastSuccessfulSync === null ? Infinity : now - lastSuccessfulSync;
      if (
        sinceSuccess >= 0 &&
        sinceSuccess < 1_000 &&
        now + lastOffset < deadlineAt
      )
        return;
      retryDelay = 1_000;
      cancelTimer();
      void check();
    },
    dispose() {
      stopped = true;
      cancelTimer();
    },
  };
}
