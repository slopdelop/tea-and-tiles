import {
  DISTRIBUTION,
  key,
  previewMove,
  type Board,
  type Game,
  type MoveRecord,
  type PlacedTile,
  type Slot,
} from "../shared/engine";
import { scoreAdjustments } from "../shared/scoring";
import { previewSummary } from "./components/gameSummaryData";

export type DebugEndingReason = Exclude<
  NonNullable<Game["endedReason"]>,
  "new-game"
>;
export type DebugPublicGame = Omit<Game, "bag" | "racks"> & {
  bagCount: number;
  rackCounts: Record<Slot, number>;
};
export type DebugMoveKind = "normal" | "multiple-words" | "high" | "bingo";

const scenarioTime = Date.UTC(2026, 9, 12, 12);

function tile(letter: string, row: number, col: number): PlacedTile {
  return {
    id: `debug-${row}-${col}-${letter}`,
    letter,
    value: DISTRIBUTION[letter][1],
    row,
    col,
  };
}

/** Real engine scoring, isolated from sessions, storage and Firebase. */
export function debugMove(kind: DebugMoveKind): MoveRecord {
  let board: Board;
  let placed: PlacedTile[];
  if (kind === "normal") {
    board = {};
    placed = [..."HOUSE"].map((letter, i) => tile(letter, 7, 5 + i));
  } else if (kind === "multiple-words") {
    board = { "6,7": tile("T", 6, 7) };
    placed = [..."CAT"].map((letter, i) => tile(letter, 7, 6 + i));
  } else if (kind === "high") {
    board = { "1,0": tile("I", 1, 0) };
    placed = [..."QUARTZ"].map((letter, i) => tile(letter, 0, i));
  } else {
    board = { "0,3": tile("A", 0, 3) };
    placed = [..."GARDENS"].map((letter, i) => tile(letter, 1, 3 + i));
  }
  const result = previewMove(
    { board },
    placed.map(({ row: _row, col: _col, ...rackTile }) => rackTile),
    placed.map(({ id, row, col }) => ({ tileId: id, row, col })),
  );
  return {
    id: `debug-move-${kind}`,
    player: "mom",
    kind: "play",
    at: scenarioTime,
    ...result,
  };
}

/** Complete small scene, including existing letters and the scored placements. */
export function debugMoveBoard(kind: DebugMoveKind): Board {
  const board: Board = {};
  for (const word of debugMove(kind).breakdown!.words) {
    for (const scored of word.tiles) {
      board[key(scored.row, scored.col)] = {
        id: scored.tileId,
        letter: scored.letter,
        value: scored.faceValue,
        row: scored.row,
        col: scored.col,
      };
    }
  }
  return board;
}

/** Fresh independent fixture on every call; never mutates a live game. */
export function debugEndingGame(
  reason: DebugEndingReason,
  winner: Slot | "tie" = "mom",
): DebugPublicGame {
  const history = structuredClone(previewSummary.history);
  const rackValues =
    reason === "rack-out" ? { mom: 0, aunt: 6 } : { mom: 6, aunt: 6 };
  const desiredEarned =
    reason === "rack-out"
      ? winner === "mom"
        ? { mom: 127, aunt: 114 }
        : winner === "aunt"
          ? { mom: 100, aunt: 150 }
          : { mom: 108, aunt: 120 }
      : winner === "mom"
        ? { mom: 127, aunt: 114 }
        : winner === "aunt"
          ? { mom: 114, aunt: 127 }
          : { mom: 114, aunt: 114 };
  if (reason === "target-score") {
    if (winner === "tie") {
      desiredEarned.mom = 150;
      desiredEarned.aunt = 150;
    } else {
      desiredEarned[winner] = 150;
    }
  }
  for (const slot of ["mom", "aunt"] as const) {
    const earned = history
      .filter((move) => move.player === slot)
      .reduce((sum, move) => sum + move.score, 0);
    const first = history.find((move) => move.player === slot)!;
    const delta = desiredEarned[slot] - earned;
    first.score += delta;
    first.wordScores![0].score += delta;
  }
  const pass = (index: number, player: Slot) => ({
    id: `debug-pass-${reason}-${index}`,
    player,
    kind: "pass" as const,
    words: [],
    wordScores: [],
    score: 0,
    at: index + 1,
  });
  if (reason === "scoreless") {
    for (let i = 0; i < 6; i++) {
      history.push(pass(history.length, i % 2 === 0 ? "mom" : "aunt"));
    }
  } else if (reason === "turn-limit") {
    // Spread zero-score turns between plays so the six-scoreless ending
    // would not have fired earlier in this twenty-turn demonstration.
    const plays = history.splice(0);
    let remainingPasses = 20 - plays.length;
    for (const play of plays) {
      const count = Math.min(4, remainingPasses);
      for (let i = 0; i < count; i++) {
        history.push(
          pass(history.length, history.length % 2 === 0 ? "mom" : "aunt"),
        );
      }
      history.push(play);
      remainingPasses -= count;
    }
  }
  history.forEach((move, index) => {
    move.at = index + 1;
  });
  const adjustments = scoreAdjustments(
    desiredEarned,
    rackValues,
    reason,
    reason === "rack-out" ? "mom" : null,
  );
  const board: Board = {};
  for (const [i, letter] of [..."TILES"].entries()) {
    const placed = tile(letter, 7, 5 + i);
    board[key(placed.row, placed.col)] = placed;
  }
  const timed = reason === "timed";
  return {
    id: `debug-ending-${reason}-${winner}`,
    revision: history.length,
    board,
    scores: {
      mom: adjustments.players.mom.final,
      aunt: adjustments.players.aunt.final,
    },
    turn: "aunt",
    status: "finished",
    scorelessTurns: reason === "scoreless" ? 6 : 0,
    lastMove: null,
    winner,
    winCondition: timed
      ? "timed"
      : reason === "turn-limit" || reason === "target-score"
        ? reason
        : "classic",
    turnsPlayed: history.length,
    startedAt: scenarioTime - 25 * 60_000,
    ...(timed ? { durationMinutes: 25, deadlineAt: scenarioTime } : {}),
    endedReason: reason,
    endedAt: scenarioTime,
    history,
    historyComplete: true,
    finalScoreAdjustments: adjustments,
    bagCount: reason === "rack-out" || reason === "agreed-end" ? 0 : 12,
    rackCounts:
      reason === "rack-out" ? { mom: 0, aunt: 3 } : { mom: 3, aunt: 3 },
  };
}
