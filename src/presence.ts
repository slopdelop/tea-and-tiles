import type { Slot } from "../shared/engine";
import { ONLINE_LEASE_MS } from "../shared/online-time";
export const PRESENCE_HEARTBEAT_MS = 60_000;
export const PRESENCE_FRESH_MS = ONLINE_LEASE_MS;
export type PresenceStatus = "present" | "away" | "unknown";
export type PresenceDevice = { slot: Slot; lastSeen: number };
export const UNKNOWN_PRESENCE: Record<Slot, PresenceStatus> = {
  mom: "unknown",
  aunt: "unknown",
};
export function presenceByPlayer(
  devices: PresenceDevice[] | null,
  now: number,
): Record<Slot, PresenceStatus> {
  if (!devices) return { mom: "unknown", aunt: "unknown" };
  const result: Record<Slot, PresenceStatus> = { mom: "away", aunt: "away" };
  for (const device of devices) {
    if (
      Number.isFinite(device.lastSeen) &&
      now - device.lastSeen < PRESENCE_FRESH_MS
    )
      result[device.slot] = "present";
  }
  return result;
}

/** A label changes only when the player's newest valid device expires. */
export function presenceUpdate(
  devices: PresenceDevice[] | null,
  now: number,
  previous: Record<Slot, PresenceStatus>,
) {
  const next = presenceByPlayer(devices, now);
  const status =
    next.mom === previous.mom && next.aunt === previous.aunt ? previous : next;
  let nextChangeAt: number | null = null;
  for (const slot of ["mom", "aunt"] as const) {
    if (status[slot] !== "present") continue;
    const latestSeen = Math.max(
      ...(devices ?? [])
        .filter(
          (device) => device.slot === slot && Number.isFinite(device.lastSeen),
        )
        .map((device) => device.lastSeen),
    );
    const expiry = latestSeen + PRESENCE_FRESH_MS;
    nextChangeAt =
      nextChangeAt === null ? expiry : Math.min(nextChangeAt, expiry);
  }
  return { status, nextChangeAt };
}
