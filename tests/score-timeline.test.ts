import { describe, expect, it } from "vitest";
import { buildScoreTimeline } from "../src/scoreTimeline";
import { celebrationDuration } from "../src/celebrationTiming";
import type { MoveBreakdown, WordScore } from "../shared/scoring";
import type { MoveRecord } from "../shared/engine";

function word(
  letters: string,
  values: number[],
  score: number,
  multiplier = 1,
): WordScore {
  return {
    word: letters,
    tiles: [...letters].map((letter, index) => ({
      tileId: `tile-${index}`,
      letter,
      faceValue: values[index],
      effectivePoints: values[index],
      letterMultiplier: 1,
      row: 5,
      col: index,
      isNew: true,
      premium: null,
    })),
    wordMultiplier: multiplier,
    score,
  };
}
function breakdown(words: WordScore[], bingoBonus = 0): MoveBreakdown {
  return {
    words,
    bingoBonus,
    total: words.reduce((total, item) => total + item.score, bingoBonus),
  };
}
function move(score: MoveBreakdown): MoveRecord {
  return {
    id: "score-test",
    player: "mom",
    kind: "play",
    placements: [],
    words: score.words.map((item) => item.word),
    score: score.total,
    at: 1,
    breakdown: score,
  };
}

describe("readable authoritative score timeline", () => {
  it("counts DON's face values in order before showing its four-point total", () => {
    const plan = buildScoreTimeline(breakdown([word("DON", [2, 1, 1], 4)]));
    expect(
      plan.steps
        .filter((step) => step.kind === "letter")
        .map((step) => [step.tileIndex, step.runningTotal]),
    ).toEqual([
      [0, 2],
      [1, 3],
      [2, 4],
    ]);
    expect(
      plan.steps.filter((step) => step.kind.includes("bonus")),
    ).toHaveLength(0);
    expect(plan.steps.at(-1)).toMatchObject({
      kind: "move-total",
      runningTotal: 4,
    });
    expect(plan.durationMs).toBeGreaterThanOrEqual(3500);
  });
  it("adds a double-letter increment before multiplying QUARTZ by its triple word", () => {
    const quartz = word("QUARTZ", [10, 1, 1, 1, 1, 10], 75, 3);
    Object.assign(quartz.tiles[2], {
      letterMultiplier: 2,
      effectivePoints: 2,
      premium: "DL",
    });
    quartz.tiles[5].premium = "TW";
    const plan = buildScoreTimeline(breakdown([quartz]));
    expect(
      plan.steps
        .filter((step) => step.tileIndex !== undefined)
        .map((step) => [step.kind, step.tileIndex, step.runningTotal]),
    ).toEqual([
      ["letter", 0, 10],
      ["letter", 1, 11],
      ["letter", 2, 12],
      ["letter-bonus", 2, 13],
      ["letter", 3, 14],
      ["letter", 4, 15],
      ["letter", 5, 25],
    ]);
    const bonus = plan.steps.find((step) => step.kind === "word-bonus")!;
    expect(bonus.runningTotal).toBe(75);
    expect(bonus.at).toBeGreaterThan(
      plan.steps.find((step) => step.kind === "letter-bonus")!.at,
    );
    expect(plan.steps.at(-1)?.runningTotal).toBe(75);
  });
  it("counts crossed words separately then combines their authoritative scores", () => {
    const plan = buildScoreTimeline(
      breakdown([word("CAT", [3, 1, 1], 10, 2), word("AT", [1, 1], 2)]),
    );
    expect(
      plan.steps
        .filter((step) => step.kind === "intro")
        .map((step) => [step.wordIndex, step.runningTotal]),
    ).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(
      plan.steps
        .filter((step) => step.kind === "word-total")
        .map((step) => [step.wordIndex, step.runningTotal]),
    ).toEqual([
      [0, 10],
      [1, 2],
    ]);
    expect(plan.steps.at(-1)).toMatchObject({
      kind: "move-total",
      runningTotal: 12,
    });
  });
  it("keeps an assigned blank at zero and adds the seven-tile bonus only once", () => {
    const plan = buildScoreTimeline(
      breakdown([word("SEATING", [0, 1, 1, 1, 1, 1, 2], 7)], 50),
    );
    expect(
      plan.steps.find((step) => step.kind === "letter" && step.tileIndex === 0)
        ?.runningTotal,
    ).toBe(0);
    expect(plan.steps.filter((step) => step.kind === "bingo")).toEqual([
      expect.objectContaining({ runningTotal: 57 }),
    ]);
    expect(plan.steps.at(-1)?.runningTotal).toBe(57);
  });
  it("ignores an old premium and counts a zero-point blank before combining new word bonuses", () => {
    const scored = word("CAT", [3, 1, 0], 16, 4);
    Object.assign(scored.tiles[0], { isNew: false, premium: "TL" });
    Object.assign(scored.tiles[1], { premium: "DW" });
    Object.assign(scored.tiles[2], { premium: "DW" });
    const input = breakdown([scored]);
    const original = structuredClone(input);
    const plan = buildScoreTimeline(input);
    expect(
      plan.steps.filter((step) => step.kind === "letter-bonus"),
    ).toHaveLength(0);
    expect(
      plan.steps
        .filter((step) => step.kind === "letter")
        .map((step) => step.runningTotal),
    ).toEqual([3, 4, 4]);
    expect(plan.steps.filter((step) => step.kind === "word-bonus")).toEqual([
      expect.objectContaining({ runningTotal: 16 }),
    ]);
    expect(plan.steps.at(-1)).toMatchObject({
      kind: "move-total",
      runningTotal: 16,
    });
    expect(input).toEqual(original);
  });
  it("counts ordinary letters briskly but holds premium explanations and the full final calculation", () => {
    const quartz = word("QUARTZ", [10, 1, 1, 1, 1, 10], 75, 3);
    Object.assign(quartz.tiles[2], {
      premium: "DL",
      letterMultiplier: 2,
      effectivePoints: 2,
    });
    quartz.tiles[5].premium = "TW";
    const plan = buildScoreTimeline(breakdown([quartz]));
    const letters = plan.steps.filter((step) => step.kind === "letter");
    for (const step of letters) expect(step.duration).toBeLessThanOrEqual(350);
    const letterBonus = plan.steps.find(
      (step) => step.kind === "letter-bonus",
    )!;
    const wordBonus = plan.steps.find((step) => step.kind === "word-bonus")!;
    expect(letterBonus.duration).toBeGreaterThanOrEqual(800);
    expect(wordBonus.duration).toBeGreaterThanOrEqual(1000);
    const final = plan.steps.at(-1)!;
    expect(final.kind).toBe("move-total");
    expect(final.duration).toBeGreaterThanOrEqual(3000);
    expect(final.duration).toBeGreaterThan(wordBonus.duration);
    expect(celebrationDuration(move(breakdown([quartz])))).toBe(
      final.at + final.duration,
    );
    const tripleLetter = word("DOG", [2, 1, 2], 18, 2);
    Object.assign(tripleLetter.tiles[0], {
      premium: "TL",
      letterMultiplier: 3,
      effectivePoints: 6,
    });
    tripleLetter.tiles[2].premium = "DW";
    const dog = buildScoreTimeline(breakdown([tripleLetter]));
    expect(
      dog.steps.find((step) => step.kind === "letter-bonus"),
    ).toMatchObject({ runningTotal: 6, duration: expect.any(Number) });
    expect(
      dog.steps.find((step) => step.kind === "letter-bonus")!.duration,
    ).toBeGreaterThanOrEqual(800);
    expect(
      dog.steps.find((step) => step.kind === "word-bonus")!.runningTotal,
    ).toBe(18);
    expect(dog.steps.at(-1)!.runningTotal).toBe(18);
  });
  it("allocates non-overlapping readable beats without changing the server breakdown", () => {
    const score = breakdown([word("DON", [2, 1, 1], 4), word("AT", [1, 1], 2)]);
    const original = structuredClone(score);
    const plan = buildScoreTimeline(score);
    expect(plan.steps[0].at).toBe(0);
    for (let index = 0; index < plan.steps.length; index++) {
      const step = plan.steps[index];
      expect(step.duration).toBeGreaterThanOrEqual(300);
      expect(plan.steps[index + 1]?.at ?? plan.durationMs).toBe(
        step.at + step.duration,
      );
    }
    expect(score).toEqual(original);
  });
  it("keeps multiple-word presentation visible until completion but uses a short static hold for reduced motion", () => {
    const short = move(breakdown([word("DON", [2, 1, 1], 4)]));
    const crossed = move(
      breakdown([word("DON", [2, 1, 1], 4), word("AT", [1, 1], 2)]),
    );
    expect(celebrationDuration(crossed)).toBeGreaterThan(
      celebrationDuration(short),
    );
    expect(celebrationDuration(crossed, true)).toBe(4500);
    expect(celebrationDuration(undefined)).toBe(4500);
  });
});
