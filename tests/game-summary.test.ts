import { describe, expect, it } from "vitest";
import { topWordScores } from "../src/components/gameSummaryData";
import type { HistoryRecord } from "../shared/scoring";

function play(
  player: HistoryRecord["player"],
  wordScores: { word: string; score: number }[],
  score = wordScores.reduce((sum, word) => sum + word.score, 0),
): HistoryRecord {
  return {
    id: `${player}-${wordScores[0]?.word}`,
    player,
    kind: "play",
    words: wordScores.map((word) => word.word),
    wordScores,
    score,
    at: 1,
  };
}

describe("best individual word scores", () => {
  it("ranks crossing words individually, excludes the partner and leaves history unchanged", () => {
    const history = [
      play("mom", [
        { word: "CAT", score: 8 },
        { word: "AT", score: 1 },
      ]),
      play("aunt", [{ word: "JAZZ", score: 58 }]),
      play("mom", [{ word: "DOG", score: 5 }]),
      play("mom", [{ word: "QUARTZ", score: 75 }]),
    ];
    const saved = structuredClone(history);
    expect(
      topWordScores(history, "mom").map(({ word, score }) => ({ word, score })),
    ).toEqual([
      { word: "QUARTZ", score: 75 },
      { word: "CAT", score: 8 },
      { word: "DOG", score: 5 },
    ]);
    expect(history).toEqual(saved);
  });

  it("keeps chronological ties and never credits the seven-tile bonus to a word", () => {
    const history = [
      { ...play("mom", [{ word: "GARDEN", score: 12 }], 62), bingoBonus: 50 },
      play("mom", [
        { word: "TILES", score: 12 },
        { word: "AT", score: 2 },
      ]),
      play("mom", [{ word: "QUIET", score: 12 }]),
    ];
    expect(
      topWordScores(history, "mom").map(({ word, score }) => ({ word, score })),
    ).toEqual([
      { word: "GARDEN", score: 12 },
      { word: "TILES", score: 12 },
      { word: "QUIET", score: 12 },
    ]);
  });

  it("does not invent word scores from legacy turn totals or non-play actions", () => {
    const history: HistoryRecord[] = [
      {
        id: "legacy",
        player: "mom",
        kind: "play",
        words: ["CAT", "AT"],
        score: 90,
        at: 1,
      },
      { ...play("mom", [{ word: "BAD", score: 100 }]), kind: "pass" },
      play("mom", [{ word: "AT", score: 0 }]),
    ];
    expect(
      topWordScores(history, "mom").map(({ word, score }) => ({ word, score })),
    ).toEqual([{ word: "AT", score: 0 }]);
    expect(topWordScores(history, "aunt")).toEqual([]);
  });
});
