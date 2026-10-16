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

import {
  mergeOnlineIntervals,
  nextOnlineHeartbeat,
  onlineGameTime,
  readOnlinePresence,
  MAX_ONLINE_INTERVALS,
  ONLINE_LEASE_MS,
  type OnlinePresence,
} from "../shared/online-time";
const onlineStamp = (value: number) => ({ toMillis: () => value });
const device = (
  since: number,
  lastSeen: number,
  intervals: { start: number; end: number }[] = [],
): OnlinePresence => ({ since, lastSeen, trackedFrom: 0, intervals });
describe("online game duration", () => {
  it("excludes an overnight gap and counts overlapping players/devices only once", () => {
    const hour = 3600000;
    expect(
      onlineGameTime(
        [
          device(0, 10 * 60000 - ONLINE_LEASE_MS),
          device(5 * 60000, 15 * 60000 - ONLINE_LEASE_MS),
          device(16 * hour, 16 * hour + 10 * 60000 - ONLINE_LEASE_MS),
        ],
        0,
        17 * hour,
      ),
    ).toEqual({ onlineDurationMs: 25 * 60000, onlineTimeTrackedFrom: 0 });
  });
  it("clips current leases to the actual game start/end and ignores invalid/overlapping ranges", () => {
    expect(
      onlineGameTime(
        [device(1000, 100000, [{ start: 0, end: 70000 }])],
        2000,
        62000,
      ),
    ).toEqual({ onlineDurationMs: 60000, onlineTimeTrackedFrom: 2000 });
    expect(
      mergeOnlineIntervals(
        [
          { start: 10, end: 20 },
          { start: 15, end: 30 },
          { start: NaN, end: 40 },
          { start: 30, end: 29 },
        ],
        0,
        25,
      ),
    ).toEqual([{ start: 10, end: 25 }]);
    expect(onlineGameTime([], 0, 10000)).toEqual({});
  });
  it("retains confirmed server timestamps during a continuous visit and archives an expired visit", () => {
    const previous = device(1000, 61000);
    expect(nextOnlineHeartbeat(previous, 121000)).toMatchObject({
      continuing: true,
      intervals: [],
    });
    expect(nextOnlineHeartbeat(previous, 181000)).toMatchObject({
      continuing: false,
      intervals: [{ start: 1000, end: 181000 }],
    });
    expect(nextOnlineHeartbeat(previous, 1e7, 200000)).toMatchObject({
      continuing: false,
      intervals: [],
    });
    expect(nextOnlineHeartbeat(null, 1000)).toEqual({
      continuing: false,
      intervals: [],
      trackedFrom: null,
    });
  });
  it("reads only valid server-stamped records and bounds accumulated history", () => {
    const data = {
      lastSeen: onlineStamp(60000),
      onlineSince: onlineStamp(0),
      onlineTrackedFrom: onlineStamp(0),
      onlineIntervals: [],
    };
    expect(readOnlinePresence(data)).toEqual(device(0, 60000));
    expect(readOnlinePresence({ lastSeen: onlineStamp(60000) })).toBeNull();
    expect(
      readOnlinePresence({ ...data, onlineSince: onlineStamp(60001) }),
    ).toBeNull();
    expect(
      readOnlinePresence({
        ...data,
        onlineIntervals: new Array(MAX_ONLINE_INTERVALS + 1).fill({
          start: 0,
          end: 1,
        }),
      }),
    ).toBeNull();
    const intervals = Array.from({ length: MAX_ONLINE_INTERVALS }, (_, i) => ({
      start: i * 1000,
      end: i * 1000 + 1,
    }));
    const next = nextOnlineHeartbeat(device(1e6, 1e6, intervals), 2e6);
    expect(next.intervals).toHaveLength(MAX_ONLINE_INTERVALS);
    expect(next.trackedFrom).toBe(1000);
  });
});
