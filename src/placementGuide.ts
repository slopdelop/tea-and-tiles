import type { Board, Placement } from "../shared/engine";

// Draft freely in any order. Full move legality belongs to previewMove and
// server validation. Dragging may replace a private draft tile, but never a
// committed tile. Tapping keeps its existing selection behavior.
export function canPlaceDraftTile(
  board: Board,
  placements: Placement[],
  candidate: Pick<Placement, "tileId" | "row" | "col">,
  replaceDraft = false,
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
  if (
    !replaceDraft &&
    remaining.some((tile) => tile.row === row && tile.col === col)
  )
    return false;
  return true;
}
