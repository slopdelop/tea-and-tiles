import { describe, expect, it } from "vitest";
import {
  createSubmissionFeedback,
  type SubmissionFeedbackClock,
} from "../src/hooks/useSubmissionFeedback";

function setup() {
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const callbacks: (() => void)[] = [];
  const clock: SubmissionFeedbackClock = {
    setTimeout(callback, delay) {
      const id = ++sequence;
      timers.set(id, { at: now + delay, callback });
      callbacks.push(callback);
      return id;
    },
    clearTimeout(timer) {
      timers.delete(timer as number);
    },
  };
  let state = { commandId: null as string | null, visible: false };
  let notifications = 0;
  const feedback = createSubmissionFeedback(clock, (next) => {
    state = next;
    notifications += 1;
  });
  return {
    feedback,
    callbacks,
    timers,
    state: () => state,
    notifications: () => notifications,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

describe("delayed submission feedback", () => {
  it("never opens for a fast acknowledgement", () => {
    const s = setup();
    s.feedback.setCommand("play-a");
    s.advance(3999);
    expect(s.state().visible).toBe(false);
    s.feedback.setCommand(null);
    s.advance(5000);
    expect(s.state()).toEqual({ commandId: null, visible: false });
    expect(s.timers.size).toBe(0);
  });

  it("opens for a slow acknowledgement and closes as soon as the command clears", () => {
    const s = setup();
    s.feedback.setCommand("play-a");
    s.advance(4000);
    expect(s.state()).toEqual({ commandId: "play-a", visible: true });
    s.feedback.setCommand(null);
    expect(s.state()).toEqual({ commandId: null, visible: false });
  });

  it("starts a fresh delay for a changed command and ignores a stale callback", () => {
    const s = setup();
    s.feedback.setCommand("play-a");
    s.advance(1000);
    s.feedback.setCommand("play-b");
    s.callbacks[0]();
    expect(s.state()).toEqual({ commandId: "play-b", visible: false });
    s.advance(3999);
    expect(s.state().visible).toBe(false);
    s.advance(1);
    expect(s.state()).toEqual({ commandId: "play-b", visible: true });
  });

  it("dismisses the notice without reopening it for the same pending command", () => {
    const s = setup();
    s.feedback.setCommand("play-a");
    s.advance(4000);
    s.feedback.dismiss();
    s.feedback.setCommand("play-a");
    s.advance(5000);
    expect(s.state()).toEqual({ commandId: "play-a", visible: false });
    s.feedback.setCommand("play-b");
    s.advance(4000);
    expect(s.state()).toEqual({ commandId: "play-b", visible: true });
  });

  it("can dismiss before the delay and rejects its cancelled callback", () => {
    const s = setup();
    s.feedback.setCommand("play-a", 2500);
    s.advance(1000);
    s.feedback.dismiss();
    s.callbacks[0]();
    s.feedback.setCommand("play-a", 2500);
    s.advance(5000);
    expect(s.state()).toEqual({ commandId: "play-a", visible: false });
    expect(s.timers.size).toBe(0);
  });

  it("ignores callbacks and further updates after cleanup", () => {
    const s = setup();
    s.feedback.setCommand("play-a");
    const count = s.notifications();
    s.feedback.dispose();
    s.callbacks[0]();
    s.feedback.setCommand("play-b");
    s.feedback.dismiss();
    s.advance(5000);
    expect(s.notifications()).toBe(count);
    expect(s.timers.size).toBe(0);
  });
});
