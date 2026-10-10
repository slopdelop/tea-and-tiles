import { describe, expect, it } from "vitest";
import { formatTimeRemaining } from "../src/timerDisplay";

describe("relaxed game timer wording", () => {
  it.each([
    [1500, "25 minutes left"],
    [1499, "25 minutes left"],
    [121, "3 minutes left"],
    [120, "2 minutes left"],
    [61, "2 minutes left"],
    [60, "60 seconds left"],
    [59, "59 seconds left"],
    [1, "1 second left"],
    [0, "Time is up"],
  ])("shows %i remaining seconds as %s", (seconds, label) => {
    expect(formatTimeRemaining(seconds as number)).toBe(label);
  });
});
