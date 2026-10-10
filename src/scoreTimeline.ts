import type { MoveBreakdown } from "../shared/scoring";

export type ScoreStep = {
  at: number;
  duration: number;
  kind:
    | "intro"
    | "letter"
    | "letter-bonus"
    | "word-bonus"
    | "word-total"
    | "bingo"
    | "move-total";
  wordIndex: number;
  tileIndex?: number;
  runningTotal: number;
};

export function buildScoreTimeline(breakdown: MoveBreakdown) {
  const steps: ScoreStep[] = [];
  let at = 0;
  const add = (step: Omit<ScoreStep, "at">) => {
    steps.push({ ...step, at });
    at += step.duration;
  };
  breakdown.words.forEach((word, wordIndex) => {
    let subtotal = 0;
    add({ kind: "intro", wordIndex, runningTotal: 0, duration: 350 });
    word.tiles.forEach((tile, tileIndex) => {
      subtotal += tile.faceValue;
      add({
        kind: "letter",
        wordIndex,
        tileIndex,
        runningTotal: subtotal,
        duration: 450,
      });
      if (tile.letterMultiplier > 1) {
        subtotal += tile.effectivePoints - tile.faceValue;
        add({
          kind: "letter-bonus",
          wordIndex,
          tileIndex,
          runningTotal: subtotal,
          duration: 300,
        });
      }
    });
    if (word.wordMultiplier > 1)
      add({
        kind: "word-bonus",
        wordIndex,
        runningTotal: word.score,
        duration: 800,
      });
    add({
      kind: "word-total",
      wordIndex,
      runningTotal: word.score,
      duration: 850,
    });
  });
  const wordIndex = Math.max(0, breakdown.words.length - 1);
  if (breakdown.bingoBonus > 0)
    add({
      kind: "bingo",
      wordIndex,
      runningTotal: breakdown.total,
      duration: 800,
    });
  add({
    kind: "move-total",
    wordIndex,
    runningTotal: breakdown.total,
    duration: 1400,
  });
  return { steps, durationMs: at };
}
