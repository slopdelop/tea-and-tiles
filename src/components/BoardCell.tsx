import { memo, type CSSProperties, type PointerEvent } from "react";
import { motion } from "motion/react";
import { premiumAt } from "../../shared/engine";
import type { DragTile } from "./useTileDrag";

const premiumNames = {
  TW: "Triple word",
  DW: "Double word",
  TL: "Triple letter",
  DL: "Double letter",
};

export const BOARD_CELLS = Array.from({ length: 225 }, (_, index) => {
  const row = Math.floor(index / 15);
  const col = index % 15;
  return { row, col, key: `${row},${col}`, premium: premiumAt(row, col) };
});

type BoardCellProps = {
  row: number;
  col: number;
  premium: ReturnType<typeof premiumAt>;
  tile: DragTile | null;
  committed: boolean;
  tentative: boolean;
  openingCentre: boolean;
  selected: boolean;
  selectedSquare: boolean;
  latest: boolean;
  fresh: boolean;
  fading: boolean;
  draftWord: boolean;
  draftPulseKey?: string;
  invalid: boolean;
  describedBy?: string;
  arriving: boolean;
  arrivalIndex: number;
  dragSource: boolean;
  settlingTarget: boolean;
  canEdit: boolean;
  hoverEnabled: boolean;
  onTap: (row: number, col: number) => void;
  onStartDrag: (event: PointerEvent<HTMLElement>, tile: DragTile) => void;
};

// Each cell receives its own visual flags, rather than the whole drag/session.
// Landing feedback is owned by useTileDrag, without rerendering cells.
export const BoardCell = memo(function BoardCell({
  row,
  col,
  premium,
  tile,
  committed,
  tentative,
  openingCentre,
  selected,
  selectedSquare,
  latest,
  fresh,
  fading,
  draftWord,
  draftPulseKey,
  invalid,
  describedBy,
  arriving,
  arrivalIndex,
  dragSource,
  settlingTarget,
  canEdit,
  hoverEnabled,
  onTap,
  onStartDrag,
}: BoardCellProps) {
  const label = tile
    ? `${tile.letter}, ${tile.value} points${tentative ? ", tentative" : ""}`
    : row === 7 && col === 7
      ? "Centre star, double word"
      : premium
        ? premiumNames[premium]
        : "Empty";
  return (
    <button
      data-testid={`board-cell-${row}-${col}`}
      data-drop-row={row}
      data-drop-col={col}
      data-draft-word={draftWord || undefined}
      className={`square ${premium?.toLowerCase() || ""} ${openingCentre ? "opening-centre" : ""} ${tentative ? "has-tentative" : ""} ${committed ? "has-committed" : ""} ${selectedSquare ? "selected-square" : ""} ${latest && committed ? "latest-square" : ""} ${fading && committed ? "fresh-play-square" : ""}`}
      data-latest-play={
        latest && committed ? (fresh ? "fresh" : "settled") : undefined
      }
      data-highlight-phase={
        latest && committed
          ? fading
            ? "fading"
            : fresh
              ? "held"
              : "settled"
          : undefined
      }
      aria-label={`Row ${row + 1}, column ${col + 1}: ${label}`}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onClick={() => onTap(row, col)}
      disabled={!canEdit || committed}
    >
      {tile ? (
        <motion.span
          className={`tile board-tile ${arriving ? "arriving-play-tile" : ""} ${tentative ? "tentative" : ""} ${draftWord ? "draft-word-tile" : ""} ${invalid ? "invalid-arrangement" : ""} ${tentative && canEdit ? "draggable-tile" : ""} ${dragSource ? "drag-source" : ""} ${settlingTarget ? "settling-target" : ""} ${latest && committed ? "latest-play-tile" : ""} ${fresh && committed ? "held-play-tile" : ""} ${fading && committed ? "fresh-play-tile" : ""}`}
          style={
            arriving
              ? ({
                  "--arrival-delay": `${Math.min(300, arrivalIndex * 45)}ms`,
                } as CSSProperties)
              : undefined
          }
          key={tile.id}
          onPointerDown={
            tentative ? (event) => onStartDrag(event, tile) : undefined
          }
          onDragStart={(event) => event.preventDefault()}
          initial={
            tentative && !settlingTarget ? { scale: 0.86, y: -5 } : false
          }
          animate={{ scale: 1, y: selected ? -3 : 0 }}
          whileHover={
            hoverEnabled
              ? {
                  boxShadow:
                    "inset 0 0 0 2px var(--tile-hover, #7a8b63), 0 3px 5px #514d3529",
                }
              : undefined
          }
          transition={{ type: "spring", stiffness: 450, damping: 23 }}
        >
          {draftWord && (
            <span
              key={draftPulseKey}
              className="draft-word-pulse"
              data-testid="draft-word-pulse"
              aria-hidden="true"
            />
          )}
          <span
            className={`tile-letter ${tile.letter === "?" ? "blank-symbol" : ""}`}
            data-letter={tile.letter}
          >
            {tile.letter === "?" ? "✧" : tile.letter}
          </span>
          <small>{tile.value}</small>
          {tile.value === 0 && <i className="blank-mark" />}
        </motion.span>
      ) : row === 7 && col === 7 ? (
        <svg className="centre-star" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m12 2.5 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9Z" />
        </svg>
      ) : premium ? (
        <span className="premium-label">{premium}</span>
      ) : null}
    </button>
  );
});
