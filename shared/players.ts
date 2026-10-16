import type { Slot } from "./engine.js";

/** An account identity is independent of its seat at any particular table. */
export type PlayerId = string;
export interface PlayerProfile {
  displayName: string;
  loginName?: string;
  sessionVersion?: number;
}
export interface ActiveGameSummary {
  id: string;
  status: "active" | "finished";
  turn: Slot;
  scores: Record<Slot, number>;
  revision: number;
  updatedAt: number;
}
export interface PairSummary {
  id: string;
  schemaVersion: 2;
  memberIds: PlayerId[];
  seatPlayers: Record<Slot, PlayerId>;
  names: Record<Slot, string>;
  activeGameId: string;
  activeGame?: ActiveGameSummary;
  actionNeededBy?: Record<string, PlayerId>;
  pendingNewGameRequestId?: string | null;
  pendingEndGameRequestId?: string | null;
}
export function seatForPlayer(
  pair: Pick<PairSummary, "seatPlayers">,
  playerId: PlayerId,
): Slot | null {
  return pair.seatPlayers.mom === playerId
    ? "mom"
    : pair.seatPlayers.aunt === playerId
      ? "aunt"
      : null;
}
