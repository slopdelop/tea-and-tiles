import type { Game, Slot } from "../../shared/engine";

export type EndingGame = Pick<Game, "scores" | "winner"> &
  Partial<
    Pick<
      Game,
      | "history"
      | "historyComplete"
      | "endedReason"
      | "finalScoreAdjustments"
      | "lastMove"
      | "scorelessTurns"
      | "turnsPlayed"
    >
  > & {
    rackCounts?: Record<Slot, number>;
    bagCount?: number;
  };

export function endingPresentationData(
  game: EndingGame,
  names: Record<Slot, string>,
) {
  const adjustments = game.finalScoreAdjustments?.players;
  const slots = ["mom", "aunt"] as const;
  const out =
    (game.lastMove?.kind === "play" ? game.lastMove.player : undefined) ??
    (game.bagCount === 0 && game.rackCounts
      ? slots.find(
          (slot) =>
            game.rackCounts![slot] === 0 &&
            game.rackCounts![slot === "mom" ? "aunt" : "mom"] > 0,
        )
      : undefined) ??
    (!game.rackCounts && adjustments
      ? slots.find(
          (slot) =>
            adjustments[slot].transferred > 0 &&
            adjustments[slot === "mom" ? "aunt" : "mom"].transferred === 0,
        )
      : undefined);
  const reason =
    game.endedReason ??
    game.finalScoreAdjustments?.reason ??
    (out && game.bagCount === 0 && game.rackCounts?.[out] === 0
      ? "rack-out"
      : (game.scorelessTurns ?? 0) >= 6
        ? "scoreless"
        : undefined);
  const descriptions: Partial<
    Record<NonNullable<Game["endedReason"]>, string>
  > = {
    "agreed-end": "You both agreed to finish with the bag empty.",
    scoreless: "Six consecutive turns without points ended the game.",
    timed: "Time is up. The highest score wins.",
    "turn-limit": "Ten turns each, all played. The highest score wins.",
    "target-score": "150 points reached. The highest score wins.",
    "rack-out": `${out ? names[out] : "A player"} used their last tile with the bag empty.`,
    "new-game": "This game ended when a new game began.",
  };
  let description = (reason && descriptions[reason]) || "The game is complete.";
  if (adjustments && (reason === "agreed-end" || reason === "scoreless")) {
    description += " Each player’s remaining tile values were deducted.";
    if (reason === "agreed-end") description += " No tiles were transferred.";
  } else if (adjustments && reason === "rack-out" && out) {
    description += ` ${names[out === "mom" ? "aunt" : "mom"]}’s remaining tile values were deducted and added to ${names[out]}’s score.`;
  }
  const players = (["mom", "aunt"] as const).map((slot) => ({
    slot,
    name: names[slot],
    earned: adjustments?.[slot].earned,
    deducted: adjustments?.[slot].deducted,
    transferred: adjustments?.[slot].transferred,
    final: adjustments?.[slot].final ?? game.scores[slot],
  }));
  return {
    reason,
    description,
    players,
    hasBreakdown: !!adjustments,
    hasTransfer: players.some((player) => (player.transferred ?? 0) > 0),
    title:
      game.winner === "tie"
        ? "An even match — a tie!"
        : game.winner
          ? `${names[game.winner]} wins!`
          : "Game complete",
  };
}

export const ENDING_TIMING = {
  earnedEnd: 1400,
  adjustmentStart: 2400,
  deductionEnd: 3500,
  transferEnd: 4400,
  finalReveal: 4800,
} as const;

export function endingTally(
  earned: number,
  deducted: number,
  transferred: number,
  final: number,
  elapsed: number,
) {
  const t = ENDING_TIMING;
  if (elapsed < t.earnedEnd)
    return Math.round((earned * Math.max(0, elapsed)) / t.earnedEnd);
  if (elapsed < t.adjustmentStart) return earned;
  if (elapsed < t.deductionEnd)
    return (
      earned -
      Math.round(
        (deducted * (elapsed - t.adjustmentStart)) /
          (t.deductionEnd - t.adjustmentStart),
      )
    );
  if (elapsed < t.transferEnd)
    return (
      earned -
      deducted +
      Math.round(
        (transferred * (elapsed - t.deductionEnd)) /
          (t.transferEnd - t.deductionEnd),
      )
    );
  if (elapsed < t.finalReveal) return earned - deducted + transferred;
  return final;
}
