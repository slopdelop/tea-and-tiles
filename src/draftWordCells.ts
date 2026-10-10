import type { Board, Placement } from "../shared/engine";

// Visual word membership deliberately works before move/dictionary validation.
// Follow straight runs through draft letters, not unrelated branches of old words.
export function draftWordCells(
  board: Board,
  placements: Placement[],
): Set<string> {
  const key = (row: number, col: number) => `${row},${col}`;
  const draft = placements.filter(
    ({ row, col }) =>
      Number.isInteger(row) &&
      Number.isInteger(col) &&
      row >= 0 &&
      row < 15 &&
      col >= 0 &&
      col < 15,
  );
  const occupied = new Set([
    ...Object.keys(board),
    ...draft.map(({ row, col }) => key(row, col)),
  ]);
  const result = new Set<string>();
  for (const tile of draft) {
    result.add(key(tile.row, tile.col));
    for (const [dr, dc] of [
      [0, 1],
      [1, 0],
    ]) {
      for (const direction of [-1, 1]) {
        let row = tile.row + dr * direction;
        let col = tile.col + dc * direction;
        while (
          row >= 0 &&
          row < 15 &&
          col >= 0 &&
          col < 15 &&
          occupied.has(key(row, col))
        ) {
          result.add(key(row, col));
          row += dr * direction;
          col += dc * direction;
        }
      }
    }
  }
  return result;
}
