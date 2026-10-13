import {
  MOVE_DIAGNOSTICS,
  type DiagnosticEvent,
  type DiagnosticEventName,
  type DiagnosticReply,
  type MoveDiagnosticReport,
} from "../../shared/move-diagnostics";

type Snapshot = {
  id: string;
  revision: number;
  lastMove: { id: string; player: string; at: number } | null;
};
type Options = {
  now: () => number;
  wall: () => number;
  visible: () => boolean;
  online: () => boolean;
  clock: () => Promise<DiagnosticReply>;
  upload: (report: MoveDiagnosticReport) => Promise<DiagnosticReply>;
  schedule: (callback: () => void, ms: number) => unknown;
  cancel: (timer: unknown) => void;
  loadBudget: () => { day: string; count: number } | null;
  saveBudget: (value: { day: string; count: number }) => void;
  metadata: Pick<
    MoveDiagnosticReport,
    | "version"
    | "buildTime"
    | "viewport"
    | "browser"
    | "standalone"
    | "transport"
    | "longTaskSupport"
  >;
};
/** Bounded, passive recorder. Neither telemetry errors nor clock requests change game state. */
export function createMoveDiagnostics(options: Options) {
  let disposed = false,
    disabled = false;
  let clock: { server: number; midpoint: number; uncertainty: number } | null =
    null;
  let clockRequest: Promise<void> | null = null;
  let lastClockAttempt = -Infinity;
  let visibilityGeneration = 0;
  let visibleSince = options.visible() ? options.now() : Infinity;
  let lastTick = options.now();
  const events: DiagnosticEvent[] = [];
  const snapshots = new Map<string, { revision: number; subscribed: number }>();
  const moves = new Map<
    string,
    {
      snapshot: Snapshot;
      received: number;
      visibleSince: number;
      subscribed: number;
      fromCache: boolean;
      displayed?: number;
    }
  >();
  const submissions = new Map<
    string,
    { gameId: string; revision: number; started: number }
  >();
  const reported = new Set<string>();
  const timers = new Set<unknown>();
  let budget = options.loadBudget();
  function record(
    name: DiagnosticEventName,
    fields: Omit<DiagnosticEvent, "name" | "ms"> = {},
  ) {
    if (disposed || disabled) return;
    const present = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );
    events.push({ name, ms: Math.round(options.now()), ...present });
    if (events.length > MOVE_DIAGNOSTICS.bufferSize) events.shift();
  }
  function later(callback: () => void, ms: number) {
    const timer = options.schedule(() => {
      timers.delete(timer);
      if (!disposed && !disabled) callback();
    }, ms);
    timers.add(timer);
  }
  function report(
    reason: MoveDiagnosticReport["reason"],
    gameId: string,
    moveId: string,
    revision: number,
    delayMs: number,
    uncertaintyMs = 0,
    serverMoveAt?: number,
  ) {
    const key = `${gameId}:${moveId}`;
    if (disposed || disabled || reported.has(key)) return;
    const day = new Date(options.wall()).toISOString().slice(0, 10);
    if (budget?.day !== day) budget = { day, count: 0 };
    if (budget.count >= MOVE_DIAGNOSTICS.dailyReports) return;
    reported.add(key);
    if (reported.size > 100) reported.delete(reported.values().next().value!);
    budget.count++;
    options.saveBudget(budget);
    const payload: MoveDiagnosticReport = {
      id:
        globalThis.crypto?.randomUUID?.() ||
        `diagnostic-${options.wall()}-${Math.random().toString(36).slice(2)}`,
      reason,
      gameId,
      moveId,
      revision,
      ...options.metadata,
      delayMs: Math.round(delayMs),
      uncertaintyMs: Math.round(uncertaintyMs),
      clockAgeMs: clock ? Math.round(options.now() - clock.midpoint) : -1,
      ...(serverMoveAt === undefined ? {} : { serverMoveAt }),
      events: events.slice(),
    };
    // The adapter persists failed uploads; this controller never retries a move.
    void Promise.resolve()
      .then(() => options.upload(payload))
      .then((reply) => {
        if (!reply.enabled) disabled = true;
      })
      .catch(() => {});
  }
  function assessMove(key: string) {
    const move = moves.get(key);
    if (!move || move.fromCache || !clock || !move.snapshot.lastMove) return;
    const age = move.received - clock.midpoint;
    if (Math.abs(age) > MOVE_DIAGNOSTICS.clockMaxAgeMs) return;
    const acceptedAt = move.snapshot.lastMove.at;
    const earliest =
      clock.server +
      Math.max(move.visibleSince, move.subscribed) -
      clock.midpoint;
    // Old moves delivered on opening/resuming are ordinary catch-up, not a stall.
    if (acceptedAt < earliest - clock.uncertainty) return;
    const delay = clock.server + age - acceptedAt;
    if (delay - clock.uncertainty >= MOVE_DIAGNOSTICS.deliveryMs)
      report(
        "delivery-delay",
        move.snapshot.id,
        move.snapshot.lastMove.id,
        move.snapshot.revision,
        delay,
        clock.uncertainty,
        acceptedAt,
      );
  }
  async function calibrate() {
    if (disposed || disabled || !options.visible() || !options.online()) return;
    if (clockRequest) return clockRequest;
    if (
      clock &&
      options.now() - clock.midpoint < MOVE_DIAGNOSTICS.clockMaxAgeMs
    )
      return;
    if (options.now() - lastClockAttempt < 120_000) return;
    lastClockAttempt = options.now();
    clockRequest = (async () => {
      // A cold-start sample can be imprecise. One warm follow-up improves it.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!options.visible() || !options.online()) break;
        const start = options.now();
        const generation = visibilityGeneration;
        try {
          const reply = await options.clock();
          if (disposed) return;
          if (!reply.enabled) {
            disabled = true;
            return;
          }
          const end = options.now();
          if (generation !== visibilityGeneration) continue;
          if (!Number.isFinite(reply.serverNow)) return;
          const next = {
            server: reply.serverNow,
            midpoint: (start + end) / 2,
            uncertainty: (end - start) / 2,
          };
          if (
            !clock ||
            end - clock.midpoint >= MOVE_DIAGNOSTICS.clockMaxAgeMs ||
            next.uncertainty < clock.uncertainty
          )
            clock = next;
          record("clock", { value: Math.round(end - start) });
          if (end - start <= 2000) break;
        } catch (failure) {
          const code = (failure as { code?: unknown } | null)?.code;
          record("clock-error", {
            detail: typeof code === "string" ? code.slice(0, 100) : "unknown",
          });
          if (attempt === 0 && options.visible() && options.online()) continue;
          break;
        }
      }
      for (const key of moves.keys()) assessMove(key);
    })().finally(() => {
      clockRequest = null;
    });
    return clockRequest;
  }
  return {
    record,
    calibrate,
    listenerStart(gameId: string) {
      snapshots.set(gameId, { revision: -1, subscribed: options.now() });
      if (snapshots.size > 12) snapshots.delete(snapshots.keys().next().value!);
      record("listener-start", { gameId });
    },
    snapshot(snapshot: Snapshot, fromCache: boolean) {
      const previous = snapshots.get(snapshot.id);
      record("snapshot", {
        gameId: snapshot.id,
        revision: snapshot.revision,
        moveId: snapshot.lastMove?.id,
        detail: fromCache ? "cache" : "server",
      });
      if (!previous) return;
      snapshots.set(snapshot.id, {
        ...previous,
        revision: Math.max(previous.revision, snapshot.revision),
      });
      if (!snapshot.lastMove || snapshot.revision < previous.revision) return;
      const key = `${snapshot.id}:${snapshot.lastMove.id}`;
      const existing = moves.get(key);
      if (existing && !(existing.fromCache && !fromCache)) return;
      moves.set(key, {
        snapshot,
        received: options.now(),
        visibleSince,
        subscribed: previous.subscribed,
        fromCache,
        ...(existing?.displayed === undefined
          ? {}
          : { displayed: existing.displayed }),
      });
      if (moves.size > 12) moves.delete(moves.keys().next().value!);
      // Collect the board frame / scoring context before uploading a late delivery.
      later(() => assessMove(key), 3500);
      if (!fromCache) void calibrate();
    },
    displayed(gameId: string, revision: number) {
      record("board-frame", { gameId, revision });
      for (const move of moves.values()) {
        if (
          move.snapshot.id !== gameId ||
          move.snapshot.revision !== revision ||
          move.displayed !== undefined
        )
          continue;
        move.displayed = options.now();
        const lag = move.displayed - move.received;
        if (
          lag >= MOVE_DIAGNOSTICS.displayMs &&
          move.visibleSince !== Infinity &&
          options.visible() &&
          move.received >= visibleSince
        )
          report(
            "display-delay",
            gameId,
            move.snapshot.lastMove!.id,
            revision,
            lag,
          );
      }
    },
    submitStart(gameId: string, moveId: string, revision: number) {
      submissions.set(moveId, { gameId, revision, started: options.now() });
      record("submit-start", { gameId, moveId, revision });
      later(() => {
        const pending = submissions.get(moveId);
        if (pending && options.visible() && pending.started >= visibleSince)
          report(
            "submission-delay",
            gameId,
            moveId,
            revision,
            options.now() - pending.started,
          );
      }, MOVE_DIAGNOSTICS.submissionMs + 2000);
    },
    submitEnd(moveId: string, error?: string) {
      const started = submissions.get(moveId);
      submissions.delete(moveId);
      record(error ? "submit-error" : "submit-reply", {
        moveId,
        detail: error,
        value: started
          ? Math.round(options.now() - started.started)
          : undefined,
      });
      if (
        started &&
        options.now() - started.started >= MOVE_DIAGNOSTICS.submissionMs &&
        started.started >= visibleSince
      )
        report(
          "submission-delay",
          started.gameId,
          moveId,
          started.revision,
          options.now() - started.started,
        );
    },
    visibility() {
      visibilityGeneration++;
      record(options.visible() ? "foreground" : "background");
      for (const key of moves.keys()) assessMove(key);
      moves.clear();
      visibleSince = options.visible() ? options.now() : Infinity;
      lastTick = options.now();
      if (options.visible()) {
        // Some older WebKit clocks pause during suspension. Re-anchor after resume.
        clock = null;
        lastClockAttempt = -Infinity;
        void calibrate();
      }
    },
    tick() {
      const gap = options.now() - lastTick;
      lastTick = options.now();
      if (options.visible() && gap > 2500)
        record("timer-gap", { value: Math.round(gap) });
    },
    dispose() {
      for (const key of moves.keys()) assessMove(key);
      disposed = true;
      for (const timer of timers) options.cancel(timer);
      timers.clear();
    },
  };
}
