import { describe, expect, it } from "vitest";
import { gameDuration, topWordScores } from "../src/components/gameSummaryData";
import type { HistoryRecord } from "../shared/scoring";

describe("game length", () => {
  it.each([
    [0, "Less than a minute"],
    [45, "45 minutes"],
    [60, "1 hour"],
    [125, "2 hours 5 minutes"],
    [1440, "1 day"],
    [3061, "2 days 3 hours 1 minute"],
  ])("formats %i minutes without empty units", (minutes, text) => {
    expect(gameDuration({ onlineDurationMs: minutes * 60_000 })).toEqual({
      label: "Online play time",
      text,
    });
  });
  it("hides wall-clock history for older games and labels partial online tracking honestly", () => {
    expect(
      gameDuration({
        endedAt: 121000,
        historyComplete: true,
        history: [{ at: 1000 } as HistoryRecord],
      }),
    ).toBeNull();
    expect(
      gameDuration({
        startedAt: 1000,
        onlineTimeTrackedFrom: 200000,
        onlineDurationMs: 120000,
      }),
    ).toEqual({ label: "Recorded online time", text: "2 minutes" });
    expect(
      gameDuration({
        endedAt: 121000,
        historyComplete: false,
        history: [{ at: 1000 } as HistoryRecord],
      }),
    ).toBeNull();
  });
  it("does not invent a duration when end/start timestamps are unavailable or invalid", () => {
    expect(gameDuration({ startedAt: 10 })).toBeNull();
    expect(gameDuration({ startedAt: 10, endedAt: 5 })).toBeNull();
    expect(gameDuration({ startedAt: NaN, endedAt: 15 })).toBeNull();
    expect(gameDuration({ onlineDurationMs: -1 })).toBeNull();
    expect(gameDuration({ onlineDurationMs: Infinity })).toBeNull();
  });
});

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
