import { describe, expect, it } from "vitest";
import {
  endingPresentationData,
  endingTally,
  type EndingGame,
} from "../src/components/endingPresentationData";
import { scoreAdjustments } from "../shared/scoring";

const names = { mom: "Elizabeth", aunt: "Rita" };
const base: EndingGame = { scores: { mom: 50, aunt: 100 }, winner: "aunt" };

describe("ending presentation", () => {
  it.each([
    ["agreed-end", "You both agreed"],
    ["scoreless", "Six consecutive turns without points"],
    ["timed", "Time is up"],
    ["turn-limit", "Ten turns each"],
    ["target-score", "150 points reached"],
    ["new-game", "new game began"],
  ] as const)("explains %s", (endedReason, text) => {
    expect(
      endingPresentationData({ ...base, endedReason }, names).description,
    ).toContain(text);
  });

  it("identifies the player who went out even when the other player wins", () => {
    const data = endingPresentationData(
      {
        ...base,
        endedReason: "rack-out",
        lastMove: {
          id: "last",
          player: "mom",
          kind: "play",
          placements: [],
          words: ["AT"],
          score: 2,
          at: 1,
        },
        finalScoreAdjustments: scoreAdjustments(
          { mom: 50, aunt: 110 },
          { mom: 0, aunt: 10 },
          "rack-out",
          "mom",
        ),
      },
      names,
    );
    expect(data.description).toContain("Elizabeth used their last tile");
    expect(data.title).toBe("Rita wins!");
    expect(data.players[0]).toMatchObject({
      earned: 50,
      deducted: 0,
      transferred: 10,
      final: 60,
    });
    expect(data.players[1]).toMatchObject({
      earned: 110,
      deducted: 10,
      transferred: 0,
      final: 100,
    });
    expect(data.hasTransfer).toBe(true);
  });

  it("uses recorded earned totals, including bonuses, instead of incomplete history", () => {
    const data = endingPresentationData(
      {
        ...base,
        history: [],
        historyComplete: false,
        finalScoreAdjustments: scoreAdjustments(
          { mom: 125, aunt: 110 },
          { mom: 5, aunt: 10 },
          "agreed-end",
        ),
      },
      names,
    );
    expect(data.players[0]).toMatchObject({
      earned: 125,
      deducted: 5,
      transferred: 0,
      final: 120,
    });
    expect(data.hasTransfer).toBe(false);
    expect(data.description).toContain("No tiles were transferred");
  });

  it("identifies the empty rack when the last move is unavailable", () => {
    const data = endingPresentationData(
      {
        ...base,
        endedReason: "rack-out",
        lastMove: null,
        rackCounts: { mom: 0, aunt: 3 },
        bagCount: 0,
      },
      names,
    );
    expect(data.description).toContain("Elizabeth used their last tile");
    expect(data.title).toBe("Rita wins!");
  });

  it("uses the recorded transfer recipient when rack counts and last move are unavailable", () => {
    const data = endingPresentationData(
      {
        ...base,
        endedReason: "rack-out",
        lastMove: null,
        finalScoreAdjustments: scoreAdjustments(
          { mom: 50, aunt: 110 },
          { mom: 0, aunt: 10 },
          "rack-out",
          "mom",
        ),
      },
      names,
    );
    expect(data.description).toContain("Elizabeth used their last tile");
    expect(data.title).toBe("Rita wins!");
  });

  it("does not invent adjustments for older games", () => {
    const data = endingPresentationData(
      { ...base, endedReason: "scoreless" },
      names,
    );
    expect(data.hasBreakdown).toBe(false);
    expect(data.players[0]).toMatchObject({
      final: 50,
      earned: undefined,
      deducted: undefined,
    });
    expect(data.description).not.toContain("deducted");
  });

  it("celebrates a tie without choosing a winner", () => {
    expect(
      endingPresentationData({ ...base, winner: "tie" }, names).title,
    ).toBe("An even match — a tie!");
  });

  it("counts each adjustment once and settles on the authoritative final", () => {
    expect(endingTally(125, 5, 10, 130, 0)).toBe(0);
    expect(endingTally(125, 5, 10, 130, 1400)).toBe(125);
    expect(endingTally(125, 5, 10, 130, 1900)).toBe(125);
    expect(endingTally(125, 5, 10, 130, 2399)).toBe(125);
    expect(endingTally(125, 5, 10, 130, 2400)).toBe(125);
    expect(endingTally(125, 5, 10, 130, 3500)).toBe(120);
    expect(endingTally(125, 5, 10, 130, 4400)).toBe(130);
    expect(endingTally(125, 5, 10, 130, 4800)).toBe(130);
    expect(endingTally(2, 10, 0, -8, 4800)).toBe(-8);
  });
});
