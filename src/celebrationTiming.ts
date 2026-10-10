// Accepted moves get a readable celebration, then a short visual handoff.
// These presentation delays never delay sending the move to the server.
export const CELEBRATION_HOLD_MS = 4500;
export const HANDOFF_MS = 200;
export const NEXT_TURN_DELAY_MS = CELEBRATION_HOLD_MS + HANDOFF_MS;

export function handoffDelay(
  readyAt: number,
  now: number,
  activeCelebration: boolean,
): number {
  return Math.max(0, readyAt - now, activeCelebration ? HANDOFF_MS : 0);
}
