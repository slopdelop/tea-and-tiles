import { afterEach, describe, expect, it, vi } from "vitest";
import { installResumeZoomRecovery } from "../src/hooks/resumeZoomRecovery";

function fixture(ios = true, standalone = true) {
  vi.useFakeTimers();
  const original = "width=device-width, initial-scale=1.0, viewport-fit=cover";
  let content: string | null = original;
  const writes: (string | null)[] = [];
  const meta = {
    getAttribute: () => content,
    setAttribute: (_: string, value: string) => {
      content = value;
      writes.push(value);
    },
    removeAttribute: () => {
      content = null;
      writes.push(null);
    },
  };
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    activeElement: null as null | { matches: () => boolean },
    querySelector: () => meta,
  });
  const win = Object.assign(new EventTarget(), {
    navigator: {
      userAgent: ios ? "iPad" : "Chrome",
      platform: ios ? "iPad" : "Linux",
      maxTouchPoints: 5,
    },
    matchMedia: () => ({ matches: standalone }),
    visualViewport: { scale: 1 },
    setTimeout: (fn: () => void, delay: number) => setTimeout(fn, delay),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 16),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
  });
  const settled = vi.fn();
  const stop = installResumeZoomRecovery(
    win as unknown as Window,
    doc as unknown as Document,
    settled,
  );
  const hide = () => {
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  const show = () => {
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  return {
    win,
    doc,
    original,
    writes,
    settled,
    stop,
    hide,
    show,
    content: () => content,
  };
}
afterEach(() => vi.useRealTimers());
describe("installed iOS resume zoom recovery", () => {
  it("repairs a delayed restored zoom and restores the original viewport", () => {
    const f = fixture();
    f.hide();
    f.show();
    vi.advanceTimersByTime(100);
    expect(f.writes).toEqual([]);
    f.win.visualViewport.scale = 1.7;
    vi.advanceTimersByTime(150);
    expect(f.content()).toContain("maximum-scale=1");
    f.win.visualViewport.scale = 1;
    vi.advanceTimersByTime(1500);
    expect(f.content()).toBe(f.original);
    expect(f.writes).toHaveLength(2);
    expect(f.settled).toHaveBeenCalledOnce();
    f.stop();
  });
  it("leaves normal resumes, Safari tabs and other browsers alone", () => {
    for (const args of [
      [true, true],
      [true, false],
      [false, true],
    ]) {
      const f = fixture(...args);
      f.hide();
      if (!args[0] || !args[1]) f.win.visualViewport.scale = 2;
      f.show();
      vi.advanceTimersByTime(2000);
      expect(f.writes).toEqual([]);
      f.stop();
    }
  });
  it("preserves pre-existing zoom and avoids focused-input zoom", () => {
    const f = fixture();
    f.win.visualViewport.scale = 2;
    f.hide();
    f.show();
    vi.advanceTimersByTime(2000);
    expect(f.writes).toEqual([]);
    f.win.visualViewport.scale = 1;
    f.hide();
    f.doc.activeElement = { matches: () => true };
    f.win.visualViewport.scale = 2;
    f.show();
    vi.advanceTimersByTime(2000);
    expect(f.writes).toEqual([]);
    f.stop();
  });
  it("restores constraints on cleanup and cancels pending recovery", () => {
    const f = fixture();
    f.hide();
    f.win.visualViewport.scale = 2;
    f.show();
    vi.advanceTimersByTime(0);
    expect(f.content()).toContain("maximum-scale=1");
    f.stop();
    vi.advanceTimersByTime(2000);
    expect(f.content()).toBe(f.original);
    expect(f.writes).toHaveLength(2);
    expect(f.settled).not.toHaveBeenCalled();
  });
  it("bounds retries if WebKit ignores the scale hint", () => {
    const f = fixture();
    f.hide();
    f.win.visualViewport.scale = 2;
    f.show();
    vi.advanceTimersByTime(2000);
    expect(f.writes).toHaveLength(4);
    expect(f.content()).toBe(f.original);
    f.stop();
  });
});
