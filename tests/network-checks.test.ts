import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTimedGameSync,
  type TimedSyncResult,
} from "../src/hooks/timedGameSync";
import { sharePendingCheck } from "../src/hooks/sharedCheck";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("shared app-update checks", () => {
  it("shares the whole check across manual, foreground and new-game callers", async () => {
    const response = deferred<boolean>();
    const pending = { current: null as Promise<boolean> | null };
    const update = vi.fn(() => response.promise);
    const manual = sharePendingCheck(pending, update);
    const foreground = sharePendingCheck(pending, update);
    const newGame = sharePendingCheck(pending, update);
    await Promise.resolve();
    expect(update).toHaveBeenCalledOnce();
    expect(foreground).toBe(manual);
    expect(newGame).toBe(manual);
    response.resolve(true);
    expect(await Promise.all([manual, foreground, newGame])).toEqual([
      true,
      true,
      true,
    ]);
    expect(pending.current).toBeNull();
    await sharePendingCheck(pending, update);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("clears a rejected check so the next request can try again", async () => {
    const pending = { current: null as Promise<boolean> | null };
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(false);
    await expect(sharePendingCheck(pending, update)).rejects.toThrow("offline");
    expect(pending.current).toBeNull();
    await expect(sharePendingCheck(pending, update)).resolves.toBe(false);
    expect(update).toHaveBeenCalledTimes(2);
  });
});

describe("timed-game synchronization", () => {
  afterEach(() => vi.useRealTimers());

  function setup(deadlineAt = 60_000) {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let online = true;
    let visible = true;
    let paused = false;
    const request = vi.fn(async (): Promise<TimedSyncResult> => ({
      status: "active",
      serverNow: Date.now(),
    }));
    const onClock = vi.fn();
    const sync = createTimedGameSync({
      deadlineAt,
      request,
      online: () => online,
      visible: () => visible,
      paused: () => paused,
      onClock,
    });
    return {
      sync,
      request,
      onClock,
      setOnline: (value: boolean) => {
        online = value;
      },
      setVisible: (value: boolean) => {
        visible = value;
      },
      setPaused: (value: boolean) => {
        paused = value;
      },
    };
  }

  it("synchronizes immediately, then merges sequential successful resume events", async () => {
    const s = setup();
    s.sync.start();
    expect(s.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_001);
    s.sync.resume(); // visibilitychange
    await vi.advanceTimersByTimeAsync(100);
    s.sync.resume(); // focus, after the previous reply has already arrived
    await vi.advanceTimersByTimeAsync(100);
    s.sync.resume(); // pageshow
    expect(s.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(801);
    s.sync.resume();
    expect(s.request).toHaveBeenCalledTimes(3);
    s.sync.dispose();
  });

  it("does not delay expiry when a resume event follows a just-early reply", async () => {
    const s = setup(500);
    s.sync.start();
    await vi.advanceTimersByTimeAsync(501);
    s.sync.resume();
    expect(s.request).toHaveBeenCalledTimes(2);
    s.sync.dispose();
  });

  it("keeps the deadline callback independent of resume coalescing", async () => {
    const s = setup(2_000);
    s.sync.start();
    await vi.advanceTimersByTimeAsync(1_500);
    s.sync.resume();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.request).toHaveBeenCalledTimes(3);
    s.sync.dispose();
  });

  it("prevents concurrent calls and computes the existing midpoint clock offset", async () => {
    const s = setup();
    const reply = deferred<TimedSyncResult>();
    s.request.mockImplementationOnce(() => reply.promise);
    s.sync.start();
    await vi.advanceTimersByTimeAsync(200);
    s.sync.resume();
    s.sync.resume();
    expect(s.request).toHaveBeenCalledOnce();
    reply.resolve({ status: "active", serverNow: 1_100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.onClock).toHaveBeenCalledWith(1_000);
    s.sync.dispose();
  });

  it("preserves exponential failure backoff without a success cooldown", async () => {
    const s = setup();
    s.request.mockRejectedValue(new Error("lost reply"));
    s.sync.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(s.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(s.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.request).toHaveBeenCalledTimes(3);
    s.request.mockResolvedValue({ status: "active", serverNow: Date.now() });
    s.sync.resume();
    expect(s.request).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(0);
    s.sync.dispose();
  });

  it("does not retry a paused failure", async () => {
    const s = setup();
    s.setPaused(true);
    s.request.mockRejectedValue(new Error("paused"));
    s.sync.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.request).toHaveBeenCalledOnce();
    s.sync.dispose();
  });

  it("checks immediately after a background return beyond the deadline", async () => {
    const s = setup(5_000);
    s.sync.start();
    await vi.advanceTimersByTimeAsync(0);
    s.setVisible(false);
    s.setOnline(false);
    await vi.advanceTimersByTimeAsync(10_000);
    s.sync.resume();
    expect(s.request).toHaveBeenCalledOnce();
    s.setVisible(true);
    s.setOnline(true);
    s.request.mockResolvedValue({ status: "finished", serverNow: Date.now() });
    s.sync.resume();
    await vi.advanceTimersByTimeAsync(0);
    s.sync.resume();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    s.sync.dispose();
  });

  it("resynchronizes if the device clock moves backwards during the cooldown", async () => {
    const s = setup();
    s.sync.start();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(-10_000);
    s.sync.resume();
    expect(s.request).toHaveBeenCalledTimes(2);
    s.sync.dispose();
  });

  it("ignores a late reply and future callbacks after disposal", async () => {
    const s = setup();
    const reply = deferred<TimedSyncResult>();
    s.request.mockImplementationOnce(() => reply.promise);
    s.sync.start();
    s.sync.dispose();
    reply.resolve({ status: "active", serverNow: 0 });
    await vi.advanceTimersByTimeAsync(60_000);
    s.sync.resume();
    expect(s.onClock).not.toHaveBeenCalled();
    expect(s.request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
