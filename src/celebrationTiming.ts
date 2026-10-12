// Accepted moves get a readable celebration, then a short visual handoff.
// These presentation delays never delay sending the move to the server.
export const CELEBRATION_HOLD_MS = 4500;
export const EXCHANGE_NOTICE_MS = 1800;
export const HANDOFF_MS = 200;
export const BOARD_ARRIVAL_MS = 850;
export const REDUCED_BOARD_ARRIVAL_MS = 120;
export function boardArrivalDuration(reduced = false) {
  return reduced ? REDUCED_BOARD_ARRIVAL_MS : BOARD_ARRIVAL_MS;
}
export function movePresentationDuration(
  move: MoveRecord | null | undefined,
  reduced = false,
) {
  return (
    celebrationDuration(move, reduced) +
    (move?.kind === "play" ? boardArrivalDuration(reduced) : 0)
  );
}
export const NEXT_TURN_DELAY_MS =
  BOARD_ARRIVAL_MS + CELEBRATION_HOLD_MS + HANDOFF_MS;

export function celebrationDuration(
  move: MoveRecord | null | undefined,
  reduced = false,
) {
  if (move?.kind === "exchange") return EXCHANGE_NOTICE_MS;
  return move?.breakdown && !reduced
    ? buildScoreTimeline(move.breakdown).durationMs
    : CELEBRATION_HOLD_MS;
}

export function handoffDelay(
  readyAt: number,
  now: number,
  activeCelebration: boolean,
): number {
  return Math.max(0, readyAt - now, activeCelebration ? HANDOFF_MS : 0);
}
import type { MoveRecord } from "../shared/engine";
import { buildScoreTimeline } from "./scoreTimeline";
