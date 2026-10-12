import { describe, it, expect } from "vitest";
import { scoreAdjustments } from "../shared/scoring";
import {
  applyCommand,
  createGame,
  previewMove,
  premiumAt,
  type Game,
  type Tile,
  type PlacedTile,
  DISTRIBUTION,
} from "../shared/engine";
const tile = (letter: string, id = letter): Tile => ({
  id,
  letter,
  value: DISTRIBUTION[letter][1],
});
const placed = (
  letter: string,
  row: number,
  col: number,
  value?: number,
): PlacedTile => ({
  ...tile(letter),
  row,
  col,
  ...(value === undefined ? {} : { value }),
});
const dict = new Set([
  "AT",
  "CAT",
  "CATS",
  "TEA",
  "IT",
  "IN",
  "AN",
  "TO",
  "READING",
  "AA",
  "ZA",
]);
const command = (
  g: Game,
  kind: "play" | "pass" | "exchange" | "rematch" = "pass",
) => ({
  id: `command_${g.revision}`,
  gameId: g.id,
  expectedRevision: g.revision,
  kind,
});
describe("rules and scoring", () => {
  it("randomly chooses either starter and retains that authoritative choice throughout a turn", () => {
    for (const [random, starter] of [
      [0.25, "aunt"],
      [0.75, "mom"],
    ] as const) {
      const game = createGame("random-start", () => random);
      expect(game.turn).toBe(starter);
      const saved = structuredClone(game);
      const next = applyCommand(game, starter, command(game), dict);
      expect(next.turn).toBe(starter === "mom" ? "aunt" : "mom");
      expect(game).toEqual(saved);
      game.status = "finished";
      expect(
        applyCommand(game, "mom", command(game, "rematch"), dict, () => random)
          .turn,
      ).toBe(starter);
    }
    expect(
      createGame("fixture", () => 0.25, "classic", 25, 1000, "mom").turn,
    ).toBe("mom");
  });
  it("deducts both racks without transferring points for an agreed empty-bag ending", () => {
    const scores = { mom: 20, aunt: 12 };
    const racks = { mom: 10, aunt: 2 };
    expect(scoreAdjustments(scores, racks, "agreed-end")).toEqual({
      reason: "agreed-end",
      players: {
        mom: {
          earned: 20,
          rackValue: 10,
          deducted: 10,
          transferred: 0,
          final: 10,
        },
        aunt: {
          earned: 12,
          rackValue: 2,
          deducted: 2,
          transferred: 0,
          final: 10,
        },
      },
    });
    expect(
      scoreAdjustments({ mom: 0, aunt: 1 }, { mom: 10, aunt: 0 }, "agreed-end")
        .players.mom.final,
    ).toBe(-10);
    expect(scores).toEqual({ mom: 20, aunt: 12 });
    expect(racks).toEqual({ mom: 10, aunt: 2 });
  });
  it("has 100 unique standard tiles and exactly two blanks", () => {
    const g = createGame("one", () => 0.5);
    const all = [...g.bag, ...g.racks.mom, ...g.racks.aunt];
    expect(all).toHaveLength(100);
    expect(new Set(all.map((t) => t.id)).size).toBe(100);
    expect(all.filter((t) => t.letter === "?")).toHaveLength(2);
    expect(g.bag).toHaveLength(86);
  });
  it("uses standard premiums including centre and symmetric counts", () => {
    expect(premiumAt(7, 7)).toBe("DW");
    expect(premiumAt(0, 0)).toBe("TW");
    const count: Record<string, number> = {};
    for (let r = 0; r < 15; r++)
      for (let c = 0; c < 15; c++) {
        const p = premiumAt(r, c);
        if (p) count[p] = (count[p] ?? 0) + 1;
      }
    expect(count).toEqual({ TW: 8, DW: 17, DL: 24, TL: 12 });
  });
  it("rejects missing centre, bent moves, gaps, occupied cells and reused rack tiles", () => {
    const rack = ["C", "A", "T"].map((x) => tile(x));
    expect(() =>
      previewMove({ board: {} }, rack, [
        { tileId: "A", row: 0, col: 0 },
        { tileId: "T", row: 0, col: 1 },
      ]),
    ).toThrow(/centre/);
    expect(() =>
      previewMove({ board: {} }, rack, [
        { tileId: "C", row: 7, col: 7 },
        { tileId: "A", row: 8, col: 8 },
      ]),
    ).toThrow(/row or column/);
    expect(() =>
      previewMove({ board: {} }, rack, [
        { tileId: "C", row: 7, col: 7 },
        { tileId: "T", row: 7, col: 9 },
      ]),
    ).toThrow(/gap/);
    expect(() =>
      previewMove({ board: {} }, rack, [
        { tileId: "C", row: 7, col: 7 },
        { tileId: "C", row: 7, col: 8 },
      ]),
    ).toThrow(/once/);
  });
  it("scores first word double and does not reuse premium for committed tiles", () => {
    expect(
      previewMove(
        { board: {} },
        ["C", "A", "T"].map((x) => tile(x)),
        ["C", "A", "T"].map((x, i) => ({ tileId: x, row: 7, col: 6 + i })),
        dict,
      ).score,
    ).toBe(10);
    const board = { "7,7": placed("A", 7, 7) };
    expect(
      previewMove(
        { board },
        [tile("T")],
        [{ tileId: "T", row: 7, col: 8 }],
        dict,
      ).score,
    ).toBe(2);
  });
  it("detects all cross words, applying new-square premium to each", () => {
    const board = {
      "6,6": placed("A", 6, 6),
      "6,7": placed("A", 6, 7),
      "8,6": placed("T", 8, 6),
      "8,7": placed("T", 8, 7),
    };
    const p = previewMove(
      { board },
      [tile("C", "c1"), tile("A", "a1")],
      [
        { tileId: "c1", row: 7, col: 6 },
        { tileId: "a1", row: 7, col: 7 },
      ],
    );
    expect(p.words.sort()).toEqual(["ACT", "AAT", "CA"].sort());
    expect(p.score).toBe(5 + 6 + 8);
    expect(() =>
      previewMove(
        { board },
        [tile("C", "c1"), tile("A", "a1")],
        [
          { tileId: "c1", row: 7, col: 6 },
          { tileId: "a1", row: 7, col: 7 },
        ],
        dict,
      ),
    ).toThrow(/ACT/);
  });
  it("selects blank letter and preserves zero score including later word extensions", () => {
    const result = previewMove(
      { board: {} },
      [tile("?"), tile("T")],
      [
        { tileId: "?", row: 7, col: 7, letter: "a" },
        { tileId: "T", row: 7, col: 8 },
      ],
      dict,
    );
    expect(result.score).toBe(2);
    expect(result.placements[0].value).toBe(0);
    expect(() =>
      previewMove(
        { board: {} },
        [tile("?")],
        [{ tileId: "?", row: 7, col: 7 }],
      ),
    ).toThrow(/Choose a letter/);
  });
  it("adds the 50-point bonus for seven tiles", () => {
    const rack = "READING".split("").map((x, i) => tile(x, String(i)));
    const p = previewMove(
      { board: {} },
      rack,
      rack.map((t, i) => ({ tileId: t.id, row: 7, col: 4 + i })),
      dict,
    );
    expect(p.score).toBe(68);
    expect(p.breakdown).toMatchObject({ bingoBonus: 50, total: 68 });
    expect(p.breakdown.words.reduce((sum, word) => sum + word.score, 0)).toBe(
      18,
    );
  });
  it("explains each cross word using only new premiums and keeps assigned blanks worth zero", () => {
    const board = {
      "6,6": placed("A", 6, 6),
      "6,7": placed("A", 6, 7),
      "8,6": placed("T", 8, 6),
      "8,7": placed("T", 8, 7),
    };
    const result = previewMove(
      { board },
      [tile("C", "cross-c"), tile("?", "cross-blank")],
      [
        { tileId: "cross-c", row: 7, col: 6 },
        { tileId: "cross-blank", row: 7, col: 7, letter: "A" },
      ],
    );
    expect(
      result.breakdown.words.map((word) => [
        word.word,
        word.wordMultiplier,
        word.score,
      ]),
    ).toEqual([
      ["CA", 2, 6],
      ["ACT", 1, 5],
      ["AAT", 2, 4],
    ]);
    const blank = result.breakdown.words[0].tiles[1];
    expect(blank).toMatchObject({
      letter: "A",
      faceValue: 0,
      effectivePoints: 0,
      isNew: true,
      premium: "DW",
      letterMultiplier: 1,
    });
    expect(result.breakdown.words[1].tiles[0]).toMatchObject({
      isNew: false,
      premium: null,
    });
    expect(result.breakdown.total).toBe(result.score);
    const triple = previewMove(
      { board: { "1,4": placed("A", 1, 4) } },
      [tile("C"), tile("T")],
      [
        { tileId: "C", row: 1, col: 5 },
        { tileId: "T", row: 1, col: 6 },
      ],
    );
    expect(triple.breakdown.words[0]).toMatchObject({
      word: "ACT",
      wordMultiplier: 1,
      score: 11,
    });
    expect(triple.breakdown.words[0].tiles[1]).toMatchObject({
      faceValue: 3,
      letterMultiplier: 3,
      effectivePoints: 9,
      premium: "TL",
    });
  });
  it("records accepted turns exactly once in order and marks missing legacy or truncated history partial", () => {
    let g = createGame("one", () => 0.5);
    const pass = command(g);
    g = applyCommand(g, "mom", pass, dict);
    g = applyCommand(
      g,
      "aunt",
      { ...command(g, "exchange"), tileIds: [g.racks.aunt[0].id] },
      dict,
    );
    expect(g.history?.map((move) => move.kind)).toEqual(["pass", "exchange"]);
    expect(g.historyComplete).toBe(true);
    delete g.history;
    delete g.historyComplete;
    g = applyCommand(g, "mom", command(g), dict);
    expect(g.history).toHaveLength(1);
    expect(g.historyComplete).toBe(false);
    g.history = Array.from({ length: 600 }, (_, index) => ({
      ...g.lastMove!,
      id: `prior-${index}`,
    }));
    g.historyComplete = true;
    g = applyCommand(g, "aunt", command(g), dict);
    expect(g.history).toHaveLength(600);
    expect(g.history?.[0].id).toBe("prior-1");
    expect(g.history?.at(-1)).toMatchObject({
      id: g.lastMove!.id,
      kind: g.lastMove!.kind,
      score: g.lastMove!.score,
    });
    expect(g.history?.at(-1)).not.toHaveProperty("placements");
    expect(g.historyComplete).toBe(false);
  });
  it("preserves earned totals separately from final rack deductions and transfers", () => {
    const g = createGame("one", () => 0.5);
    g.bag = [];
    g.racks = { mom: [tile("A"), tile("T")], aunt: [tile("Q")] };
    g.scores = { mom: 20, aunt: 25 };
    const ended = applyCommand(
      g,
      "mom",
      {
        ...command(g, "play"),
        placements: [
          { tileId: "A", row: 7, col: 7 },
          { tileId: "T", row: 7, col: 8 },
        ],
      },
      dict,
    );
    expect(ended.finalScoreAdjustments).toEqual({
      reason: "rack-out",
      players: {
        mom: {
          earned: 24,
          rackValue: 0,
          deducted: 0,
          transferred: 10,
          final: 34,
        },
        aunt: {
          earned: 25,
          rackValue: 10,
          deducted: 10,
          transferred: 0,
          final: 15,
        },
      },
    });
    expect(ended.history?.[0].wordScores).toEqual([{ word: "AT", score: 4 }]);
    let stalled = createGame("two", () => 0.5);
    stalled.racks = { mom: [tile("Q")], aunt: [tile("A")] };
    stalled.scores = { mom: 30, aunt: 20 };
    for (let turn = 0; turn < 6; turn++)
      stalled = applyCommand(stalled, stalled.turn, command(stalled), dict);
    expect(stalled.finalScoreAdjustments?.players).toEqual({
      mom: {
        earned: 30,
        rackValue: 10,
        deducted: 10,
        transferred: 0,
        final: 20,
      },
      aunt: {
        earned: 20,
        rackValue: 1,
        deducted: 1,
        transferred: 0,
        final: 19,
      },
    });
    expect(stalled.history).toHaveLength(6);
    const rematch = applyCommand(
      stalled,
      "aunt",
      command(stalled, "rematch"),
      dict,
    );
    expect(rematch.history).toEqual([]);
    expect(rematch.historyComplete).toBe(true);
    expect(rematch.finalScoreAdjustments).toBeUndefined();
  });
  it("keeps600 worst-shaped compact history records below Firestore's document limit", () => {
    const g = createGame("one", () => 0.5);
    const words = Array.from({ length: 14 }, () => "Q".repeat(15));
    const breakdown = {
      total: 999999,
      bingoBonus: 50,
      words: words.map((word) => ({
        word,
        score: 999999,
        wordMultiplier: 27,
        tiles: Array.from({ length: 15 }, (_, col) => ({
          tileId: "Q-0",
          letter: "Q",
          faceValue: 10,
          letterMultiplier: 3,
          effectivePoints: 30,
          row: 0,
          col,
          isNew: true,
          premium: "TL" as const,
        })),
      })),
    };
    const oldMove = {
      id: "x".repeat(100),
      player: "mom" as const,
      kind: "play" as const,
      words,
      score: 999999,
      at: 9999999999999,
      placements: [placed("Q", 0, 0)],
      breakdown,
    };
    g.history = Array.from({ length: 600 }, () => oldMove);
    expect(new TextEncoder().encode(JSON.stringify(g)).length).toBeGreaterThan(
      1048576,
    );
    const next = applyCommand(g, "mom", command(g), dict);
    expect(next.history).toHaveLength(600);
    expect(next.history?.[0].wordScores).toHaveLength(14);
    expect(next.history?.[0]).not.toHaveProperty("breakdown");
    expect(next.history?.[0]).not.toHaveProperty("placements");
    expect(new TextEncoder().encode(JSON.stringify(next)).length).toBeLessThan(
      900000,
    );
  });
  it("rejects disconnected moves and allows filling committed gaps", () => {
    const board = { "7,7": placed("A", 7, 7) };
    expect(() =>
      previewMove(
        { board },
        [tile("A"), tile("T")],
        [
          { tileId: "A", row: 0, col: 0 },
          { tileId: "T", row: 0, col: 1 },
        ],
      ),
    ).toThrow(/Connect/);
    expect(
      previewMove(
        { board },
        [tile("C"), tile("T")],
        [
          { tileId: "C", row: 7, col: 6 },
          { tileId: "T", row: 7, col: 8 },
        ],
        dict,
      ).words,
    ).toEqual(["CAT"]);
  });
  it("rejects stale/out of turn/forged rack moves without mutation", () => {
    const g = createGame("one", () => 0.5);
    expect(() => applyCommand(g, "aunt", command(g), dict)).toThrow(/opponent/);
    expect(() =>
      applyCommand(g, "mom", { ...command(g), expectedRevision: 3 }, dict),
    ).toThrow(/changed/);
    expect(() =>
      applyCommand(
        g,
        "mom",
        {
          ...command(g, "play"),
          placements: [{ tileId: "forged", row: 7, col: 7 }],
        },
        dict,
      ),
    ).toThrow(/rack/);
    expect(g.revision).toBe(0);
  });
  it("exchanges without redrawing returned tiles and preserves accounting", () => {
    const g = createGame("one", () => 0.1, "classic", 25, 1000, "mom");
    const old = g.racks.mom[0];
    const next = applyCommand(
      g,
      "mom",
      { ...command(g, "exchange"), tileIds: [old.id] },
      dict,
      () => 0.2,
    );
    expect(next.racks.mom).toHaveLength(7);
    expect(next.lastMove).toMatchObject({
      exchangedCount: 1,
      placements: [],
      words: [],
    });
    expect(next.lastMove).not.toHaveProperty("tileIds");
    expect(next.racks.mom.some((t) => t.id === old.id)).toBe(false);
    expect(next.bag.some((t) => t.id === old.id)).toBe(true);
    expect([...next.bag, ...next.racks.mom, ...next.racks.aunt]).toHaveLength(
      100,
    );
    g.bag = g.bag.slice(0, 6);
    expect(() =>
      applyCommand(
        g,
        "mom",
        { ...command(g, "exchange"), tileIds: [old.id] },
        dict,
      ),
    ).toThrow(/seven/);
  });
  it("ends after six scoreless turns, adjusts racks and starts a rematch", () => {
    let g = createGame("one", () => 0.5);
    const deductions = {
      mom: g.racks.mom.reduce((s, t) => s + t.value, 0),
      aunt: g.racks.aunt.reduce((s, t) => s + t.value, 0),
    };
    for (let i = 0; i < 6; i++) g = applyCommand(g, g.turn, command(g), dict);
    expect(g.status).toBe("finished");
    expect(g.scores).toEqual({ mom: -deductions.mom, aunt: -deductions.aunt });
    g = applyCommand(g, "aunt", command(g, "rematch"), dict);
    expect(g.status).toBe("active");
    expect(g.revision).toBe(7);
    expect(g.bag).toHaveLength(86);
  });
  it("transfers remaining opponent tiles when a player goes out", () => {
    const g = createGame("one", () => 0.5);
    g.bag = [];
    g.racks = { mom: [tile("A"), tile("T")], aunt: [tile("Q")] };
    const next = applyCommand(
      g,
      "mom",
      {
        ...command(g, "play"),
        placements: [
          { tileId: "A", row: 7, col: 7 },
          { tileId: "T", row: 7, col: 8 },
        ],
      },
      dict,
    );
    expect(next.status).toBe("finished");
    expect(next.scores).toEqual({ mom: 14, aunt: -10 });
    expect(next.winner).toBe("mom");
  });
  it("refills a last rack tile before deciding rack-out, including a partially empty bag", () => {
    for (const mode of [
      "classic",
      "turn-limit",
      "target-score",
      "timed",
    ] as const) {
      for (const remaining of [7, 2, 1]) {
        const g = createGame("one", () => 0.5, mode, 25, 1000);
        g.board = { "7,7": placed("A", 7, 7) };
        g.racks = { mom: [tile("T")], aunt: [tile("Q")] };
        g.bag = Array.from({ length: remaining }, (_, index) =>
          tile("E", `draw-${index}`),
        );
        const next = applyCommand(
          g,
          "mom",
          {
            ...command(g, "play"),
            placements: [{ tileId: "T", row: 7, col: 8 }],
          },
          dict,
          () => 0.5,
          2000,
        );
        expect(next).toMatchObject({
          status: "active",
          winner: null,
          scores: { mom: 2, aunt: 0 },
        });
        expect(next.racks.mom.map((t) => t.id)).toEqual(g.bag.map((t) => t.id));
        expect(next.bag).toHaveLength(0);
        expect(next.endedReason).toBeUndefined();
        expect(next.endedAt).toBeUndefined();
      }
    }
  });
  it("counts passes, exchanges and zero-point plays together, and resets on a scoring play", () => {
    let g = createGame("one", () => 0.5);
    g.board = { "7,7": placed("A", 7, 7, 0) };
    g.racks.mom = [tile("?", "blank-t"), tile("A", "scoring-a")];
    g = applyCommand(g, "mom", command(g), dict);
    expect(g.scorelessTurns).toBe(1);
    g = applyCommand(
      g,
      "aunt",
      { ...command(g, "exchange"), tileIds: [g.racks.aunt[0].id] },
      dict,
    );
    expect(g.scorelessTurns).toBe(2);
    g = applyCommand(
      g,
      "mom",
      {
        ...command(g, "play"),
        placements: [{ tileId: "blank-t", row: 7, col: 8, letter: "T" }],
      },
      dict,
    );
    expect(g).toMatchObject({ scorelessTurns: 3, lastMove: { score: 0 } });
    g = applyCommand(g, "aunt", command(g), dict);
    expect(g).toMatchObject({ scorelessTurns: 4, status: "active" });
    g = applyCommand(
      g,
      "mom",
      {
        ...command(g, "play"),
        placements: [{ tileId: "scoring-a", row: 8, col: 7 }],
      },
      dict,
    );
    expect(g).toMatchObject({
      scorelessTurns: 0,
      status: "active",
      lastMove: { score: 1 },
    });
    g = applyCommand(g, "aunt", command(g), dict);
    expect(g.scorelessTurns).toBe(1);
  });
  it("finishes a zero-point final blank by rack-out before scoreless or extra-mode cutoffs", () => {
    for (const mode of [
      "classic",
      "turn-limit",
      "target-score",
      "timed",
    ] as const) {
      const g = createGame("one", () => 0.5, mode, 25, 1000);
      g.board = { "7,7": placed("A", 7, 7, 0) };
      g.bag = [];
      g.racks = { mom: [tile("?", "last-blank")], aunt: [tile("Q")] };
      g.scores.mom = 150;
      g.turnsPlayed = 19;
      g.scorelessTurns = 5;
      const next = applyCommand(
        g,
        "mom",
        {
          ...command(g, "play"),
          placements: [{ tileId: "last-blank", row: 7, col: 8, letter: "T" }],
        },
        dict,
        () => 0.5,
        2000,
      );
      expect(next).toMatchObject({
        status: "finished",
        endedReason: "rack-out",
        endedAt: 2000,
        scorelessTurns: 6,
        turnsPlayed: 20,
        lastMove: { score: 0 },
        scores: { mom: 160, aunt: -10 },
        winner: "mom",
      });
      expect(next.racks.mom).toHaveLength(0);
      expect(() => applyCommand(next, "aunt", command(next), dict)).toThrow(
        /finished/,
      );
    }
  });
  it("defaults new and legacy games to classic and counts only accepted turns", () => {
    const g = createGame("one", () => 0.5);
    expect(g).toMatchObject({ winCondition: "classic", turnsPlayed: 0 });
    delete g.winCondition;
    delete g.turnsPlayed;
    g.revision = 4;
    expect(() => applyCommand(g, "aunt", command(g), dict)).toThrow(/opponent/);
    const next = applyCommand(g, "mom", command(g), dict);
    expect(next.turnsPlayed).toBe(5);
    expect(g.turnsPlayed).toBeUndefined();
  });
  it("ends after exactly ten alternating turns each, counting both play and pass", () => {
    let g = createGame("one", () => 0.5, "turn-limit");
    const words = new Set([
      ...dict,
      "ATT",
      "ATTT",
      "ATTTT",
      ...Array.from({ length: 7 }, (_, i) => "A".repeat(i + 2)),
    ]);
    let momTurns = 0,
      auntTurns = 0;
    for (let turn = 0; turn < 20; turn++) {
      if (g.turn === "mom") {
        const index = momTurns++;
        g.racks.mom =
          index === 0
            ? [tile("A", "first-a"), tile("T", "first-t")]
            : [tile(index <= 6 ? "A" : "T", `tile-${index}`)];
        const placements =
          index === 0
            ? [
                { tileId: "first-a", row: 7, col: 7 },
                { tileId: "first-t", row: 7, col: 8 },
              ]
            : [
                {
                  tileId: `tile-${index}`,
                  row: index <= 6 ? 7 + index : 7,
                  col: index <= 6 ? 7 : index + 2,
                },
              ];
        g = applyCommand(
          g,
          "mom",
          { ...command(g, "play"), placements },
          words,
        );
      } else {
        auntTurns++;
        g = applyCommand(g, "aunt", command(g), words);
      }
      expect(g.turnsPlayed).toBe(turn + 1);
      expect(g.status).toBe(turn === 19 ? "finished" : "active");
    }
    expect([momTurns, auntTurns]).toEqual([10, 10]);
    expect(g).toMatchObject({ winner: "mom", endedReason: "turn-limit" });
    expect(g.scores.aunt).toBe(0);
  });
  it("counts exchange toward the turn limit and resolves a deadline tie without rack deductions", () => {
    const g = createGame("one", () => 0.5, "turn-limit");
    g.turnsPlayed = 18;
    g.scores = { mom: 42, aunt: 42 };
    const exchanged = applyCommand(
      g,
      "mom",
      { ...command(g, "exchange"), tileIds: [g.racks.mom[0].id] },
      dict,
    );
    expect(exchanged).toMatchObject({ turnsPlayed: 19, status: "active" });
    exchanged.scorelessTurns = 5;
    const finished = applyCommand(exchanged, "aunt", command(exchanged), dict);
    expect(finished).toMatchObject({
      turnsPlayed: 20,
      status: "finished",
      winner: "tie",
      endedReason: "turn-limit",
      scores: { mom: 42, aunt: 42 },
    });
  });
  it("finishes only on reaching 150 and preserves both players' earned scores", () => {
    let g = createGame("one", () => 0.5, "target-score");
    g.racks.mom = [tile("A"), tile("T")];
    g.racks.aunt = [tile("Q")];
    g.scores.mom = 145;
    g = applyCommand(
      g,
      "mom",
      {
        ...command(g, "play"),
        placements: [
          { tileId: "A", row: 7, col: 7 },
          { tileId: "T", row: 7, col: 8 },
        ],
      },
      dict,
    );
    expect(g).toMatchObject({
      status: "active",
      scores: { mom: 149, aunt: 0 },
    });
    g = applyCommand(g, "aunt", command(g), dict);
    g.racks.mom = [tile("S")];
    g = applyCommand(
      g,
      "mom",
      { ...command(g, "play"), placements: [{ tileId: "S", row: 7, col: 9 }] },
      new Set([...dict, "ATS"]),
    );
    expect(g).toMatchObject({
      status: "finished",
      winner: "mom",
      endedReason: "target-score",
      scores: { mom: 152, aunt: 0 },
    });
  });
  it("gives standard rack-out precedence when the same scoring move also reaches a chosen cutoff", () => {
    for (const mode of ["turn-limit", "target-score", "timed"] as const) {
      const g = createGame("one", () => 0.5, mode);
      g.bag = [];
      g.racks = { mom: [tile("A"), tile("T")], aunt: [tile("Q")] };
      g.turnsPlayed = 19;
      g.scores.mom = 146;
      const finished = applyCommand(
        g,
        "mom",
        {
          ...command(g, "play"),
          placements: [
            { tileId: "A", row: 7, col: 7 },
            { tileId: "T", row: 7, col: 8 },
          ],
        },
        dict,
      );
      expect(finished).toMatchObject({
        status: "finished",
        scores: { mom: 160, aunt: -10 },
        winner: "mom",
      });
      expect(finished.endedReason).toBe("rack-out");
      const rematch = applyCommand(
        finished,
        "aunt",
        command(finished, "rematch"),
        dict,
      );
      expect(rematch).toMatchObject({
        winCondition: mode,
        turnsPlayed: 0,
        scores: { mom: 0, aunt: 0 },
        status: "active",
      });
      expect(rematch.endedReason).toBeUndefined();
    }
  });
  it("retains standard rack-out and six-scoreless endings when they happen before the chosen cutoff", () => {
    for (const mode of [
      "classic",
      "turn-limit",
      "target-score",
      "timed",
    ] as const) {
      let stalled = createGame("one", () => 0.5, mode);
      const deductions = {
        mom: stalled.racks.mom.reduce((sum, t) => sum + t.value, 0),
        aunt: stalled.racks.aunt.reduce((sum, t) => sum + t.value, 0),
      };
      const startedAt = Date.now();
      for (let i = 0; i < 6; i++) {
        stalled = applyCommand(
          stalled,
          stalled.turn,
          command(stalled),
          dict,
          () => 0.5,
          startedAt + i,
        );
        expect(stalled.status).toBe(i === 5 ? "finished" : "active");
        expect(stalled.scorelessTurns).toBe(i + 1);
        if (i < 5) expect(stalled.endedAt).toBeUndefined();
      }
      expect(stalled).toMatchObject({
        status: "finished",
        turnsPlayed: 6,
        scores: { mom: -deductions.mom, aunt: -deductions.aunt },
      });
      expect(stalled.endedReason).toBe("scoreless");
      expect(stalled.endedAt).toBe(startedAt + 5);
      const g = createGame("two", () => 0.5, mode);
      g.bag = [];
      g.racks = { mom: [tile("A"), tile("T")], aunt: [tile("Q")] };
      const out = applyCommand(
        g,
        "mom",
        {
          ...command(g, "play"),
          placements: [
            { tileId: "A", row: 7, col: 7 },
            { tileId: "T", row: 7, col: 8 },
          ],
        },
        dict,
      );
      expect(out).toMatchObject({
        status: "finished",
        scores: { mom: 14, aunt: -10 },
        winner: "mom",
      });
      expect(out.endedReason).toBe("rack-out");
    }
  });
  it("creates a timed game with a configurable clock and the25-minute default", () => {
    const defaultGame = createGame(
      "one",
      () => 0.5,
      "timed",
      undefined,
      100000,
    );
    expect(defaultGame).toMatchObject({
      durationMinutes: 25,
      startedAt: 100000,
      deadlineAt: 1600000,
    });
    const custom = createGame("two", () => 0.5, "timed", 7, 100000);
    expect(custom).toMatchObject({
      durationMinutes: 7,
      startedAt: 100000,
      deadlineAt: 520000,
    });
    for (const duration of [0, -1, 1.5, 1441])
      expect(() => createGame("invalid", () => 0.5, "timed", duration)).toThrow(
        /whole number/,
      );
    expect(createGame("classic", () => 0.5)).not.toHaveProperty("deadlineAt");
  });
  it("accepts a timed turn strictly before its deadline and rejects at the exact deadline without mutation", () => {
    const g = createGame("one", () => 0.5, "timed", 1, 100000);
    const before = structuredClone(g);
    expect(() =>
      applyCommand(g, "mom", command(g), dict, () => 0.5, 160000),
    ).toThrow(/Time is up/);
    expect(g).toEqual(before);
    expect(
      applyCommand(g, "mom", command(g), dict, () => 0.5, 159999),
    ).toMatchObject({
      revision: 1,
      turnsPlayed: 1,
      status: "active",
      deadlineAt: 160000,
      lastMove: { at: 159999 },
    });
  });
  it("preserves the timed duration while giving a rematch a fresh clock", () => {
    const g = createGame("one", () => 0.5, "timed", 11, 100000);
    g.status = "finished";
    g.endedReason = "timed";
    const rematch = applyCommand(
      g,
      "aunt",
      command(g, "rematch"),
      dict,
      () => 0.5,
      900000,
    );
    expect(rematch).toMatchObject({
      winCondition: "timed",
      durationMinutes: 11,
      startedAt: 900000,
      deadlineAt: 1560000,
      turnsPlayed: 0,
      status: "active",
    });
    expect(rematch.endedReason).toBeUndefined();
  });
});
