import type { Game, Slot, Command } from "./engine.js";
export interface HistoryRecord {
  id: string;
  player: Slot;
  kind: Command["kind"];
  words: string[];
  score: number;
  at: number;
  wordScores?: { word: string; score: number }[];
  bingoBonus?: number;
}

export interface ScoreTile {
  tileId: string;
  letter: string;
  faceValue: number;
  letterMultiplier: number;
  effectivePoints: number;
  row: number;
  col: number;
  isNew: boolean;
  /** Only a newly placed tile's premium contributes to this word. */
  premium: "DW" | "TW" | "DL" | "TL" | null;
}
export interface WordScore {
  word: string;
  tiles: ScoreTile[];
  wordMultiplier: number;
  score: number;
}
export interface MoveBreakdown {
  words: WordScore[];
  bingoBonus: number;
  total: number;
}
export interface PlayerScoreAdjustment {
  earned: number;
  rackValue: number;
  deducted: number;
  transferred: number;
  final: number;
}
export interface FinalScoreAdjustments {
  reason: NonNullable<Game["endedReason"]>;
  players: Record<Slot, PlayerScoreAdjustment>;
}
export function scoreAdjustments(
  scores: Record<Slot, number>,
  rackValues: Record<Slot, number>,
  reason: FinalScoreAdjustments["reason"],
  out: Slot | null = null,
): FinalScoreAdjustments {
  const players = {} as FinalScoreAdjustments["players"];
  const deduct = reason === "rack-out" || reason === "scoreless";
  for (const slot of ["mom", "aunt"] as const) {
    const deducted = deduct ? rackValues[slot] : 0;
    const transferred =
      out === slot ? rackValues[slot === "mom" ? "aunt" : "mom"] : 0;
    players[slot] = {
      earned: scores[slot],
      rackValue: rackValues[slot],
      deducted,
      transferred,
      final: scores[slot] - deducted + transferred,
    };
  }
  return { reason, players };
}
