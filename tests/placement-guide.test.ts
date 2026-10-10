import { describe, expect, it } from "vitest";
import {
  createGame,
  previewMove,
  type Board,
  type Placement,
} from "../shared/engine";
import { canPlaceDraftTile } from "../src/placementGuide";
import { draftWordCells } from "../src/draftWordCells";

const placed = (tileId: string, row: number, col: number): Placement => ({
  tileId,
  row,
  col,
});
const oldA: Board = {
  "7,7": { id: "old-a", letter: "A", value: 1, row: 7, col: 7 },
};

describe("private draft word highlighting", () => {
  const boardAt = (...cells: [number, number][]): Board =>
    Object.fromEntries(
      cells.map(([row, col]) => [
        `${row},${col}`,
        { id: `old-${row}-${col}`, letter: "A", value: 1, row, col },
      ]),
    );
  it("includes both main and cross words but does not flood adjacent old branches", () => {
    const board = boardAt(
      [7, 5],
      [7, 6],
      [7, 9],
      [6, 7],
      [8, 7],
      [6, 6],
      [5, 6],
    );
    expect(
      [...draftWordCells(board, [placed("n", 7, 7), placed("o", 7, 8)])].sort(),
    ).toEqual(["6,7", "7,5", "7,6", "7,7", "7,8", "7,9", "8,7"]);
  });
  it("does not bridge a gap, handles disconnected drafts and clears with Recall", () => {
    const board = boardAt([7, 7]);
    expect(
      [...draftWordCells(board, [placed("d", 7, 8), placed("r", 7, 5)])].sort(),
    ).toEqual(["7,5", "7,7", "7,8"]);
    expect(draftWordCells(board, [])).toEqual(new Set());
    expect(
      [
        ...draftWordCells(boardAt([0, 0]), [
          placed("edge", 0, 1),
          placed("invalid", -1, 1),
        ]),
      ].sort(),
    ).toEqual(["0,0", "0,1"]);
  });
});

describe("free draft placement", () => {
  it("allows disconnected, diagonal and gapped draft tiles while preventing collisions", () => {
    const first = placed("d", 7, 8);
    for (const [row, col] of [
      [7, 5],
      [6, 6],
      [0, 0],
      [14, 14],
    ])
      expect(canPlaceDraftTile(oldA, [first], placed("r", row, col))).toBe(
        true,
      );
    expect(canPlaceDraftTile(oldA, [first], placed("r", 7, 7))).toBe(false);
    expect(canPlaceDraftTile(oldA, [first], placed("r", 7, 8))).toBe(false);
    for (const [row, col] of [
      [-1, 0],
      [15, 0],
      [0, -1],
      [0, 15],
      [7.5, 8],
      [NaN, 0],
    ])
      expect(canPlaceDraftTile({}, [], placed("r", row, col))).toBe(false);
  });
  it("lets a tile move away from a completed line and reuse its own square", () => {
    const line = [placed("r", 7, 5), placed("o", 7, 6), placed("d", 7, 8)];
    expect(canPlaceDraftTile(oldA, line, placed("o", 7, 6))).toBe(true);
    expect(canPlaceDraftTile(oldA, line, placed("o", 3, 3))).toBe(true);
    expect(canPlaceDraftTile(oldA, line, placed("o", 7, 5))).toBe(false);
    expect(canPlaceDraftTile(oldA, line, placed("o", 7, 7))).toBe(false);
  });
  it("permits D then R before O, while scoring stays blocked until the gap is filled", () => {
    const game = createGame("free-draft");
    game.board = oldA;
    game.racks.mom = [
      { id: "d", letter: "D", value: 2 },
      { id: "r", letter: "R", value: 1 },
      { id: "o", letter: "O", value: 1 },
    ];
    const draft: Placement[] = [placed("d", 7, 8)];
    const r = placed("r", 7, 5);
    expect(canPlaceDraftTile(game.board, draft, r)).toBe(true);
    draft.push(r);
    expect(() => previewMove(game, game.racks.mom, draft)).toThrow(/gap/);
    const o = placed("o", 7, 6);
    expect(canPlaceDraftTile(game.board, draft, o)).toBe(true);
    draft.push(o);
    expect(
      previewMove(game, game.racks.mom, draft, new Set(["ROAD"])).words,
    ).toEqual(["ROAD"]);
  });
});
