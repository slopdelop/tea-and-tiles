import { describe, expect, it } from "vitest";
import {
  presenceByPlayer,
  presenceUpdate,
  PRESENCE_FRESH_MS,
  UNKNOWN_PRESENCE,
} from "../src/presence";
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

  it("keeps the published object stable before a label changes", () => {
    const devices = [{ slot: "mom" as const, lastSeen: 10_000 }];
    const initial = presenceUpdate(devices, 20_000, UNKNOWN_PRESENCE);
    for (const now of [25_000, 30_000, 60_000, 129_999]) {
      const update = presenceUpdate([...devices], now, initial.status);
      expect(update.status).toBe(initial.status);
      expect(update.nextChangeAt).toBe(130_000);
    }
    const expired = presenceUpdate(devices, 130_000, initial.status);
    expect(expired.status).not.toBe(initial.status);
    expect(expired.status).toEqual({ mom: "away", aunt: "away" });
    expect(expired.nextChangeAt).toBeNull();
  });

  it("schedules the newest device's expiry rather than an older device", () => {
    const devices = [
      { slot: "mom" as const, lastSeen: 0 },
      { slot: "mom" as const, lastSeen: 80_000 },
      { slot: "aunt" as const, lastSeen: 100_000 },
      { slot: "aunt" as const, lastSeen: Number.NaN },
    ];
    const first = presenceUpdate(devices, 119_999, UNKNOWN_PRESENCE);
    expect(first.nextChangeAt).toBe(200_000);
    expect(presenceUpdate(devices, 120_000, first.status).status).toBe(
      first.status,
    );
    const next = presenceUpdate(devices, 200_000, first.status);
    expect(next.status).toEqual({ mom: "away", aunt: "present" });
    expect(next.nextChangeAt).toBe(220_000);
  });

  it("restores unknown on cache/offline and reevaluates server observations on wake", () => {
    const devices = [{ slot: "aunt" as const, lastSeen: 10_000 }];
    const first = presenceUpdate(devices, 20_000, UNKNOWN_PRESENCE);
    const offline = presenceUpdate(null, 30_000, first.status);
    expect(offline.status).toEqual(UNKNOWN_PRESENCE);
    expect(offline.nextChangeAt).toBeNull();
    const resumed = presenceUpdate(devices, 150_000, offline.status);
    expect(resumed.status).toEqual({ mom: "away", aunt: "away" });
    expect(resumed.nextChangeAt).toBeNull();
  });

  it("handles a corrected clock without discarding trusted timestamps", () => {
    const devices = [{ slot: "mom" as const, lastSeen: 10_000 }];
    const expired = presenceUpdate(devices, 150_000, UNKNOWN_PRESENCE);
    const corrected = presenceUpdate(devices, 120_000, expired.status);
    expect(corrected.status).toEqual({ mom: "present", aunt: "away" });
    expect(corrected.nextChangeAt).toBe(130_000);
  });
});
