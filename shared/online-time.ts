/** Same two-minute lease used by the online indicator. */
export const ONLINE_LEASE_MS = 120_000;
export const MAX_ONLINE_INTERVALS = 256;
export type OnlineInterval = { start: number; end: number };
export type OnlinePresence = {
  lastSeen: number;
  since: number;
  trackedFrom: number;
  intervals: OnlineInterval[];
};

export function mergeOnlineIntervals(
  input: readonly OnlineInterval[],
  start = 0,
  end = Infinity,
): OnlineInterval[] {
  const sorted = input
    .filter(
      (range) => Number.isFinite(range?.start) && Number.isFinite(range?.end),
    )
    .map((range) => ({
      start: Math.max(start, range.start),
      end: Math.min(end, range.end),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const merged: OnlineInterval[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end)
      last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Confirmed server timestamps bound each lease. Untrusted/legacy data is ignored. */
export function readOnlinePresence(
  data: Record<string, any> | undefined,
): OnlinePresence | null {
  const lastSeen = data?.lastSeen?.toMillis?.();
  const since = data?.onlineSince?.toMillis?.();
  const trackedFrom = data?.onlineTrackedFrom?.toMillis?.();
  if (
    ![lastSeen, since, trackedFrom].every(Number.isFinite) ||
    since > lastSeen ||
    trackedFrom > since ||
    !Array.isArray(data?.onlineIntervals) ||
    data.onlineIntervals.length > MAX_ONLINE_INTERVALS
  )
    return null;
  return {
    lastSeen,
    since,
    trackedFrom,
    intervals: mergeOnlineIntervals(
      data.onlineIntervals,
      trackedFrom,
      lastSeen + ONLINE_LEASE_MS,
    ),
  };
}

/** Extend the current lease or archive it before starting a fresh server-stamped one. */
export function nextOnlineHeartbeat(
  previous: OnlinePresence | null,
  now: number,
  gameStartedAt = 0,
) {
  const continuing =
    !!previous &&
    now >= previous.lastSeen - ONLINE_LEASE_MS &&
    now < previous.lastSeen + ONLINE_LEASE_MS;
  const archived = mergeOnlineIntervals(
    [
      ...(previous?.intervals ?? []),
      ...(!continuing && previous
        ? [{ start: previous.since, end: previous.lastSeen + ONLINE_LEASE_MS }]
        : []),
    ],
    gameStartedAt,
  );
  const intervals = archived.slice(-MAX_ONLINE_INTERVALS);
  return {
    continuing,
    intervals,
    // Extremely long games can discard the oldest episodes without claiming
    // their missing history was measured. Normal pruning drops only older games.
    trackedFrom: previous
      ? Math.max(
          previous.trackedFrom,
          archived.length > MAX_ONLINE_INTERVALS ? intervals[0].start : 0,
        )
      : null,
  };
}

/** Union across players/devices: simultaneous online time counts only once. */
export function onlineGameTime(
  devices: readonly OnlinePresence[],
  startedAt: number | undefined,
  endedAt: number,
) {
  if (!devices.length || !Number.isFinite(endedAt)) return {};
  const from = Math.min(...devices.map((device) => device.trackedFrom));
  const start = Math.max(startedAt ?? from, from);
  if (!Number.isFinite(start) || endedAt < start) return {};
  const intervals = devices.flatMap((device) => [
    ...device.intervals,
    { start: device.since, end: device.lastSeen + ONLINE_LEASE_MS },
  ]);
  const duration = mergeOnlineIntervals(intervals, start, endedAt).reduce(
    (sum, range) => sum + range.end - range.start,
    0,
  );
  return { onlineDurationMs: duration, onlineTimeTrackedFrom: start };
}
