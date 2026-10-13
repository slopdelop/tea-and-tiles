import { describe, expect, it } from "vitest";
import { createMoveDiagnostics } from "../src/diagnostics/moveDiagnostics";
import { validateDiagnosticReport } from "../functions/move-diagnostics";
import type { MoveDiagnosticReport } from "../shared/move-diagnostics";
import { createDiagnosticOutbox } from "../src/diagnostics/diagnosticOutbox";

function setup() {
  let now = 1000,
    visible = true,
    online = true,
    calls = 0;
  const base = 1_700_000_000_000;
  const reports: MoveDiagnosticReport[] = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  let sequence = 0;
  let disabled = false,
    failUpload = false,
    clockRtt = 0;
  let failedClocks = 0;
  const recorder = createMoveDiagnostics({
    now: () => now,
    wall: () => base + now + 7 * 86400_000,
    visible: () => visible,
    online: () => online,
    clock: async () => {
      calls++;
      if (failedClocks-- > 0)
        throw Object.assign(new Error("clock failed"), {
          code: "functions/unavailable",
        });
      now += clockRtt;
      return { enabled: !disabled, serverNow: base + now };
    },
    upload: async (report) => {
      if (failUpload) throw new Error("offline logging");
      reports.push(report);
      return { enabled: true, serverNow: base + now };
    },
    schedule: (callback, ms) => {
      const id = ++sequence;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    cancel: (id) => {
      timers.delete(id as number);
    },
    loadBudget: () => null,
    saveBudget: () => {},
    metadata: {
      version: "1.5.1-local",
      browser: "iPad Safari",
      standalone: true,
      transport: "xhr-long-poll",
      longTaskSupport: false,
    },
  });
  const snapshot = (id: string, at: number, revision = 1, cache = false) =>
    recorder.snapshot(
      { id: "game", revision, lastMove: { id, at: base + at, player: "aunt" } },
      cache,
    );
  const advance = async (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers])
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    recorder,
    reports,
    timers,
    snapshot,
    advance,
    base,
    now: () => now,
    calls: () => calls,
    visibility(value: boolean) {
      visible = value;
      recorder.visibility();
    },
    online(value: boolean) {
      online = value;
    },
    disable() {
      disabled = true;
    },
    fail() {
      failUpload = true;
    },
    rtt(value: number) {
      clockRtt = value;
    },
    failClock(count: number) {
      failedClocks = count;
    },
  };
}

describe("temporary move diagnostics", () => {
  it("uploads nothing for normal moves and uses server time despite a wrong iPad clock", async () => {
    const s = setup();
    await s.recorder.calibrate();
    s.recorder.listenerStart("game");
    s.snapshot("fast", s.now() - 100);
    s.recorder.displayed("game", 1);
    await s.advance(4000);
    expect(s.reports).toHaveLength(0);
    expect(s.calls()).toBe(1);
  });
  it("captures a 20-second delivery delay with network, frame and scoring context once", async () => {
    const s = setup();
    await s.recorder.calibrate();
    s.recorder.listenerStart("game");
    s.recorder.snapshot({ id: "game", revision: 0, lastMove: null }, false);
    const submitted = s.now();
    await s.advance(20_000);
    s.recorder.record("network", { detail: "listen", value: 20000 });
    s.snapshot("slow", submitted);
    s.recorder.displayed("game", 1);
    s.recorder.record("scoring-start", { gameId: "game", moveId: "slow" });
    await s.advance(3500);
    expect(s.reports).toHaveLength(1);
    expect(s.reports[0]).toMatchObject({
      reason: "delivery-delay",
      delayMs: 20000,
      uncertaintyMs: 0,
    });
    expect(s.reports[0].events.map((e) => e.name)).toEqual(
      expect.arrayContaining([
        "network",
        "snapshot",
        "board-frame",
        "scoring-start",
      ]),
    );
    expect(validateDiagnosticReport(s.reports[0])).toEqual(s.reports[0]);
    s.snapshot("slow", submitted);
    await s.advance(5000);
    expect(s.reports).toHaveLength(1);
  });
  it("reports a rendering stall independently of network delivery", async () => {
    const s = setup();
    await s.recorder.calibrate();
    s.recorder.listenerStart("game");
    s.snapshot("render", s.now());
    await s.advance(3100);
    s.recorder.tick();
    s.recorder.displayed("game", 1);
    await s.advance(500);
    expect(s.reports).toHaveLength(1);
    expect(s.reports[0].reason).toBe("display-delay");
    expect(s.reports[0].events.some((e) => e.name === "timer-gap")).toBe(true);
  });
  it("does not mistake old opening or background catch-up moves for delays", async () => {
    const s = setup();
    await s.recorder.calibrate();
    s.recorder.listenerStart("game");
    s.snapshot("old", s.now() - 20000);
    await s.advance(4000);
    s.visibility(false);
    const at = s.now();
    await s.advance(20000);
    s.visibility(true);
    await Promise.resolve();
    s.snapshot("catchup", at, 2);
    await s.advance(4000);
    expect(s.reports).toHaveLength(0);
    expect(s.calls()).toBe(2);
  });
  it("does not report an unconfirmed cache snapshot but assesses the server version", async () => {
    const s = setup();
    await s.recorder.calibrate();
    s.recorder.listenerStart("game");
    const at = s.now();
    await s.advance(20000);
    s.snapshot("cached", at, 1, true);
    await s.advance(3500);
    expect(s.reports).toHaveLength(0);
    s.snapshot("cached", at, 1, false);
    await s.advance(3500);
    expect(s.reports).toHaveLength(1);
  });
  it("uses the conservative clock uncertainty bound and bounds expensive calibration", async () => {
    const s = setup();
    s.rtt(4000);
    await s.recorder.calibrate();
    s.recorder.listenerStart("game");
    const at = s.now();
    await s.advance(6000);
    s.snapshot("uncertain-clock", at);
    await s.advance(3500);
    expect(s.reports).toHaveLength(0);
    expect(s.calls()).toBe(2);
    await s.recorder.calibrate();
    expect(s.calls()).toBe(2);
  });
  it("recovers from one failed calibration with one warm follow-up", async () => {
    const s = setup();
    s.failClock(1);
    await s.recorder.calibrate();
    s.recorder.listenerStart("game");
    const at = s.now();
    await s.advance(20000);
    s.snapshot("after-clock-failure", at);
    await s.advance(3500);
    expect(s.calls()).toBe(2);
    expect(s.reports).toHaveLength(1);
    expect(
      s.reports[0].events.some(
        (event) =>
          event.name === "clock-error" &&
          event.detail === "functions/unavailable",
      ),
    ).toBe(true);
  });
  it("caps reports, keeps only 60 events, and never uploads private data", async () => {
    const s = setup();
    await s.recorder.calibrate();
    for (let i = 0; i < 100; i++) s.recorder.record("online");
    for (let i = 0; i < 8; i++) {
      s.recorder.submitStart("game", `move-${i}`, i);
      await s.advance(9000);
      s.recorder.submitEnd(`move-${i}`);
      await s.advance(1);
    }
    expect(s.reports).toHaveLength(5);
    expect(s.reports.every((r) => r.events.length <= 60)).toBe(true);
    expect(JSON.stringify(s.reports)).not.toMatch(
      /passphrase|rack|token|apiKey/,
    );
  });
  it("obeys the server kill switch and disposes all timers", async () => {
    const s = setup();
    s.disable();
    await s.recorder.calibrate();
    s.recorder.listenerStart("game");
    s.snapshot("disabled", s.now());
    await s.advance(20000);
    s.recorder.displayed("game", 1);
    expect(s.reports).toHaveLength(0);
    s.recorder.dispose();
    expect(s.timers.size).toBe(0);
  });
  it("does not throw or retry when uploading fails", async () => {
    const s = setup();
    s.fail();
    s.recorder.submitStart("game", "failed", 0);
    await s.advance(10000);
    expect(() => s.recorder.submitEnd("failed")).not.toThrow();
    await s.advance(1000);
    expect(s.reports).toHaveLength(0);
  });
  it("captures late delivery if backgrounding happens before its context timer fires", async () => {
    const s = setup();
    await s.recorder.calibrate();
    s.recorder.listenerStart("game");
    const at = s.now();
    await s.advance(20000);
    s.snapshot("before-background", at);
    s.visibility(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(s.reports).toHaveLength(1);
  });
  it("captures a still-pending submission without waiting for an eventual reply", async () => {
    const s = setup();
    s.recorder.submitStart("game", "no-reply", 0);
    await s.advance(10000);
    expect(s.reports).toHaveLength(1);
    expect(s.reports[0].reason).toBe("submission-delay");
    s.recorder.submitEnd("no-reply");
    await s.advance(1000);
    expect(s.reports).toHaveLength(1);
  });
  it("rejects oversized, extra-field, unknown-event and nonfinite reports", () => {
    expect(() => validateDiagnosticReport({ passphrase: "secret" })).toThrow();
    expect(() =>
      validateDiagnosticReport({
        events: Array(100).fill({ name: "snapshot" }),
      }),
    ).toThrow();
  });
});

describe("durable diagnostic upload", () => {
  const report = {
    id: "incident-one",
    events: [],
  } as unknown as MoveDiagnosticReport;
  it("retains a failed upload across recorder restart and reuses its report ID", async () => {
    let stored: MoveDiagnosticReport[] = [],
      failed = true,
      now = 0;
    const ids: string[] = [];
    const options = {
      load: () => stored,
      save: (value: MoveDiagnosticReport[]) => {
        stored = value;
      },
      online: () => true,
      now: () => now,
      send: async (value: MoveDiagnosticReport) => {
        ids.push(value.id);
        if (failed) throw new Error("offline");
        return { enabled: true, serverNow: 0, accepted: false };
      },
    };
    const first = createDiagnosticOutbox(options);
    await expect(first.submit(report)).rejects.toThrow("offline");
    expect(stored).toHaveLength(1);
    await first.flush();
    expect(ids).toHaveLength(1); // cooldown avoids rapid retries
    failed = false;
    now = 61000;
    await createDiagnosticOutbox(options).flush();
    expect(ids).toEqual([report.id, report.id]);
    expect(stored).toHaveLength(0);
  });
  it("queues offline reports and clears the queue when the server disables diagnostics", async () => {
    let stored: MoveDiagnosticReport[] = [],
      online = false;
    const box = createDiagnosticOutbox({
      load: () => [],
      save: (value) => {
        stored = value;
      },
      online: () => online,
      now: () => 0,
      send: async () => ({ enabled: false, serverNow: 0 }),
    });
    await expect(box.submit(report)).rejects.toThrow();
    expect(stored).toHaveLength(1);
    online = true;
    await box.flush();
    expect(stored).toHaveLength(0);
  });
});
