import { describe, expect, it } from "vitest";
import { presenceByPlayer, PRESENCE_FRESH_MS } from "../src/presence";
describe("player presence", () => {
  it("does not label missing/untrusted snapshots as Away", () => {
    expect(presenceByPlayer(null, 200_000)).toEqual({
      mom: "unknown",
      aunt: "unknown",
    });
    expect(presenceByPlayer([], 200_000)).toEqual({
      mom: "away",
      aunt: "away",
    });
  });
  it("expires at two minutes without a server call", () => {
    const devices = [{ slot: "mom" as const, lastSeen: 10_000 }];
    expect(presenceByPlayer(devices, 10_000 + PRESENCE_FRESH_MS - 1).mom).toBe(
      "present",
    );
    expect(presenceByPlayer(devices, 10_000 + PRESENCE_FRESH_MS).mom).toBe(
      "away",
    );
  });
  it("keeps a player present while any of their devices is fresh", () => {
    expect(
      presenceByPlayer(
        [
          { slot: "mom", lastSeen: 0 },
          { slot: "mom", lastSeen: 199_000 },
          { slot: "aunt", lastSeen: 10_000 },
          { slot: "aunt", lastSeen: Number.NaN },
        ],
        200_000,
      ),
    ).toEqual({ mom: "present", aunt: "away" });
  });
});
