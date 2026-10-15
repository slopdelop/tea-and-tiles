import { useEffect, useState } from "react";

type Sample = { fps: number; p95: number; longest: number; slow: number };

/** Opt-in local tools only. Samples RAF cadence, not physical input/paint latency. */
export function DebugFrameMeter({
  floating = false,
  close,
}: {
  floating?: boolean;
  close?: () => void;
}) {
  const [sample, setSample] = useState<Sample | null>(null);
  useEffect(() => {
    let frame = 0,
      previous = 0,
      start = 0;
    let intervals: number[] = [];
    const tick = (now: number) => {
      if (document.hidden) return;
      if (previous) intervals.push(now - previous);
      previous = now;
      if (!start) start = now;
      if (now - start >= 1000 && intervals.length) {
        const sorted = [...intervals].sort((a, b) => a - b);
        setSample({
          fps: (intervals.length * 1000) / (now - start),
          p95: sorted[
            Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
          ],
          longest: sorted.at(-1)!,
          slow: intervals.filter((ms) => ms > 25).length,
        });
        intervals = [];
        start = now;
      }
      frame = requestAnimationFrame(tick);
    };
    const visibility = () => {
      cancelAnimationFrame(frame);
      previous = start = 0;
      intervals = [];
      setSample(null);
      if (!document.hidden) frame = requestAnimationFrame(tick);
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  return (
    <aside
      className={`debug-frame-meter ${floating ? "floating" : ""}`}
      data-testid="debug-frame-meter"
    >
      <strong>{sample ? Math.round(sample.fps) : "—"} FPS</strong>
      <span>Frame gap p95: {sample ? sample.p95.toFixed(1) : "—"} ms</span>
      <span>
        Longest: {sample ? sample.longest.toFixed(1) : "—"} ms · over 25 ms:{" "}
        {sample?.slow ?? "—"}
      </span>
      <small>Last second · browser frame timing</small>
      {close && (
        <button className="secondary-button" onClick={close}>
          Hide meter
        </button>
      )}
    </aside>
  );
}
