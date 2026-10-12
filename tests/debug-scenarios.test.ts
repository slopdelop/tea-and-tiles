import { describe, expect, it } from "vitest";
import {
  debugEndingGame,
  debugMove,
  debugMoveBoard,
  type DebugEndingReason,
  type DebugMoveKind,
} from "../src/debugScenarios";
import { previewSummary } from "../src/components/gameSummaryData";

const reasons: DebugEndingReason[] = [
  "rack-out",
  "scoreless",
  "agreed-end",
  "timed",
  "turn-limit",
  "target-score",
];

describe("isolated local preview scenarios", () => {
  it("accounts for each ending and winner, including rack-out transfer and ties", () => {
    for (const reason of reasons) {
      for (const winner of ["mom", "aunt", "tie"] as const) {
        const game = debugEndingGame(reason, winner);
        expect(game.endedReason).toBe(reason);
        expect(game.winner).toBe(winner);
        expect(game.status).toBe("finished");
        if (reason === "target-score") {
          expect(
            Math.max(game.scores.mom, game.scores.aunt),
          ).toBeGreaterThanOrEqual(150);
        }
        if (reason === "turn-limit") {
          expect(game.turnsPlayed).toBe(20);
          expect(game.history).toHaveLength(20);
          let consecutiveScoreless = 0;
          for (const [index, move] of game.history!.entries()) {
            expect(move.player).toBe(index % 2 === 0 ? "mom" : "aunt");
            consecutiveScoreless =
              move.score === 0 ? consecutiveScoreless + 1 : 0;
            expect(consecutiveScoreless).toBeLessThan(6);
          }
        }
        if (reason === "scoreless") {
          expect(
            game
              .history!.slice(-6)
              .map((move) => [move.kind, move.player, move.score]),
          ).toEqual([
            ["pass", "mom", 0],
            ["pass", "aunt", 0],
            ["pass", "mom", 0],
            ["pass", "aunt", 0],
            ["pass", "mom", 0],
            ["pass", "aunt", 0],
          ]);
        }
        for (const slot of ["mom", "aunt"] as const) {
          const adjustment = game.finalScoreAdjustments!.players[slot];
          const earned = game
            .history!.filter((move) => move.player === slot)
            .reduce((sum, move) => sum + move.score, 0);
          expect(adjustment.earned).toBe(earned);
          expect(adjustment.final).toBe(
            earned - adjustment.deducted + adjustment.transferred,
          );
          expect(game.scores[slot]).toBe(adjustment.final);
          expect(adjustment.deducted).toBe(
            ["rack-out", "scoreless", "agreed-end"].includes(reason)
              ? adjustment.rackValue
              : 0,
          );
          expect(adjustment.transferred).toBe(
            reason === "rack-out" && slot === "mom" ? 6 : 0,
          );
        }
        expect(
          game.scores.mom === game.scores.aunt
            ? "tie"
            : game.scores.mom > game.scores.aunt
              ? "mom"
              : "aunt",
        ).toBe(winner);
        for (const move of game.history!) {
          expect(move.score).toBe(
            move.wordScores!.reduce((sum, word) => sum + word.score, 0),
          );
        }
        expect(game).not.toHaveProperty("racks");
        expect(game).not.toHaveProperty("bag");
      }
    }
  });

  it("uses engine-calculated per-letter premiums, crossing words and seven-tile bonus", () => {
    for (const kind of ["multiple-words", "high", "bingo"] as DebugMoveKind[]) {
      const move = debugMove(kind);
      expect(move.score).toBe(move.breakdown!.total);
      expect(move.score).toBe(
        move.breakdown!.words.reduce((sum, word) => sum + word.score, 0) +
          move.breakdown!.bingoBonus,
      );
      for (const word of move.breakdown!.words) {
        expect(word.score).toBe(
          word.tiles.reduce((sum, scored) => sum + scored.effectivePoints, 0) *
            word.wordMultiplier,
        );
        for (const scored of word.tiles)
          expect(scored.effectivePoints).toBe(
            scored.faceValue * scored.letterMultiplier,
          );
      }
      expect(Object.keys(debugMoveBoard(kind))).toHaveLength(
        move.placements.length + 1,
      );
    }
    expect(debugMove("multiple-words").words).toEqual(["CAT", "TA"]);
    expect(debugMove("high").score).toBeGreaterThan(100);
    expect(debugMove("bingo").placements).toHaveLength(7);
    expect(debugMove("bingo").breakdown!.bingoBonus).toBe(50);
    const premiums = ["multiple-words", "high", "bingo"].flatMap((kind) =>
      debugMove(kind as DebugMoveKind).breakdown!.words.flatMap((word) =>
        word.tiles.map((scored) => scored.premium),
      ),
    );
    for (const premium of ["DL", "TL", "DW", "TW"])
      expect(premiums).toContain(premium);
  });

  it("creates fresh fixtures without changing the existing summary or subsequent previews", () => {
    const original = structuredClone(previewSummary);
    const first = debugEndingGame("agreed-end");
    first.history![0].score = -999;
    first.finalScoreAdjustments!.players.mom.final = -999;
    expect(debugEndingGame("agreed-end").scores.mom).toBe(121);
    expect(debugEndingGame("agreed-end").history![0].score).toBe(75);
    const move = debugMove("high");
    move.breakdown!.words[0].tiles[0].effectivePoints = -999;
    expect(debugMove("high").breakdown!.words[0].tiles[0].effectivePoints).toBe(
      10,
    );
    expect(previewSummary).toEqual(original);
  });
});
