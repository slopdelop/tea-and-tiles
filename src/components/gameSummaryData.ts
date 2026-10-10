import type { HistoryRecord } from "../../shared/scoring";
import type { Slot } from "../../shared/engine";

export function topWordScores(history: HistoryRecord[], player: Slot) {
  return history
    .filter((move) => move.player === player && move.kind === "play")
    .flatMap((move) => move.wordScores ?? [])
    .map((word, index) => ({ ...word, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3);
}

export const previewSummary = {
  historyComplete: true,
  scores: { mom: 121, aunt: 108 },
  history: [
    {
      id: "preview-1",
      player: "mom",
      kind: "play",
      words: ["QUARTZ"],
      score: 75,
      at: 1,
      wordScores: [{ word: "QUARTZ", score: 75 }],
    },
    {
      id: "preview-2",
      player: "aunt",
      kind: "play",
      words: ["JAZZ"],
      score: 58,
      at: 2,
      wordScores: [{ word: "JAZZ", score: 58 }],
    },
    {
      id: "preview-3",
      player: "mom",
      kind: "play",
      words: ["GARDEN", "AT"],
      score: 34,
      at: 3,
      wordScores: [
        { word: "GARDEN", score: 32 },
        { word: "AT", score: 2 },
      ],
    },
    {
      id: "preview-4",
      player: "aunt",
      kind: "play",
      words: ["QUIET"],
      score: 36,
      at: 4,
      wordScores: [{ word: "QUIET", score: 36 }],
    },
    {
      id: "preview-5",
      player: "mom",
      kind: "play",
      words: ["TEA"],
      score: 18,
      at: 5,
      wordScores: [{ word: "TEA", score: 18 }],
    },
    {
      id: "preview-6",
      player: "aunt",
      kind: "play",
      words: ["TILES"],
      score: 20,
      at: 6,
      wordScores: [{ word: "TILES", score: 20 }],
    },
  ] as HistoryRecord[],
  finalScoreAdjustments: {
    reason: "agreed-end" as const,
    players: {
      mom: {
        earned: 127,
        rackValue: 6,
        deducted: 6,
        transferred: 0,
        final: 121,
      },
      aunt: {
        earned: 114,
        rackValue: 6,
        deducted: 6,
        transferred: 0,
        final: 108,
      },
    },
  },
};
