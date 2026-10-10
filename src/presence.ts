import type { Slot } from "../shared/engine";
export const PRESENCE_HEARTBEAT_MS = 60_000;
export const PRESENCE_FRESH_MS = 120_000;
export type PresenceStatus = "present" | "away" | "unknown";
export type PresenceDevice = { slot: Slot; lastSeen: number };
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
