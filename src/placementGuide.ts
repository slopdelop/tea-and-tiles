import type { Board, Placement } from "../shared/engine";

// Draft freely in any order. Full move legality belongs to previewMove and
// server validation; only bounds and occupied squares prevent a local drop.
export function canPlaceDraftTile(
  board: Board,
  placements: Placement[],
  candidate: Pick<Placement, "tileId" | "row" | "col">,
): boolean {
  const { row, col, tileId } = candidate;
  if (
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    row < 0 ||
    row > 14 ||
    col < 0 ||
    col > 14 ||
    board[`${row},${col}`]
  )
    return false;
  const remaining = placements.filter((tile) => tile.tileId !== tileId);
  if (remaining.some((tile) => tile.row === row && tile.col === col))
    return false;
  return true;
}
