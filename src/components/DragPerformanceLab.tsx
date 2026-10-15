import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { createPortal } from "react-dom";
import { BOARD_CELLS, BoardCell } from "./BoardCell";
import { useTileDrag, type DragTile } from "./useTileDrag";
import { debugMoveBoard } from "../debugScenarios";
import { DebugFrameMeter } from "./DebugFrameMeter";

/** Local, in-memory visual surface using the production board cells/drag hook. */
export function DragPerformanceLab() {
  const { recentBoard, crowdedBoard, tiles } = useMemo(() => {
    const recentBoard = debugMoveBoard("multiple-words");
    const crowdedBoard = { ...recentBoard };
    for (let i = 0; i < 82; i++) {
      const row = Math.floor(i / 15),
        col = i % 15;
      crowdedBoard[`${row},${col}`] = {
        id: `lab-board-${i}`,
        letter: "TEATILES"[i % 8],
        value: 1,
        row,
        col,
      };
    }
    const tiles: DragTile[] = [..."GARDENS"].map((letter, i) => ({
      id: `lab-rack-${i}`,
      letter,
      value: letter === "G" || letter === "D" ? 2 : 1,
    }));
    return { recentBoard, crowdedBoard, tiles };
  }, []);
  const root = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Record<string, DragTile>>({});
  const [highlight, setHighlight] = useState<"held" | "fading" | "settled">(
    "fading",
  );
  const [replay, setReplay] = useState(0);
  const [dense, setDense] = useState(true);
  const board = dense ? crowdedBoard : recentBoard;
  const remaining = tiles.filter(
    (t) => !Object.values(draft).some((p) => p.id === t.id),
  );
  useEffect(() => {
    setHighlight("held");
    const begin = window.setTimeout(() => setHighlight("fading"), 100);
    const finish = window.setTimeout(() => setHighlight("settled"), 5100);
    return () => {
      clearTimeout(begin);
      clearTimeout(finish);
    };
  }, [replay]);
  const { drag, rackPreview, dragGhostRef, start, settling, finishSettling } =
    useTileDrag({
      root,
      enabled: true,
      contextKey: `lab:${dense}`,
      getRackTileIds: () => remaining.map((t) => t.id),
      canDrop: (_id, target) =>
        target.kind === "rack" || !board[`${target.row},${target.col}`],
      onDrop: (id, target) =>
        setDraft((current) => {
          const next = Object.fromEntries(
            Object.entries(current).filter(([, t]) => t.id !== id),
          );
          if (target.kind === "board")
            next[`${target.row},${target.col}`] = tiles.find(
              (t) => t.id === id,
            )!;
          return next;
        }),
    });
  // Stable callbacks, like the production board, avoid changing every cell.
  const actions = useRef({ start, draft });
  actions.current = { start, draft };
  const beginDrag = useCallback(
    (event: Parameters<typeof start>[0], tile: DragTile) =>
      actions.current.start(event, tile),
    [],
  );
  const recall = useCallback(
    (row: number, col: number) =>
      setDraft((current) => {
        const next = { ...current };
        delete next[`${row},${col}`];
        return next;
      }),
    [],
  );
  return (
    <div
      ref={root}
      className="drag-performance-lab"
      data-testid="drag-performance-lab"
    >
      <p>
        Drag the sample tiles. This board stays on this device and never changes
        your game.
      </p>
      <div className="debug-buttons">
        <button
          className="secondary-button"
          onClick={() => {
            setDense((v) => !v);
            setDraft({});
          }}
        >
          Board: {dense ? "crowded" : "light"}
        </button>
        <button
          className="secondary-button"
          onClick={() => setReplay((v) => v + 1)}
        >
          Replay word highlight
        </button>
        <button className="secondary-button" onClick={() => setDraft({})}>
          Recall sample tiles
        </button>
      </div>
      <DebugFrameMeter />
      <div className="board-frame">
        <div className="board" data-testid="lab-board">
          {BOARD_CELLS.map(({ row, col, key, premium }) => {
            const committed = board[key],
              tile = committed ?? draft[key] ?? null;
            const latest = !!recentBoard[key];
            return (
              <BoardCell
                key={key}
                row={row}
                col={col}
                premium={premium}
                tile={tile}
                committed={!!committed}
                tentative={!!draft[key]}
                openingCentre={false}
                selected={false}
                selectedSquare={false}
                latest={latest}
                fresh={latest && highlight !== "settled"}
                fading={latest && highlight === "fading"}
                draftWord={!!draft[key]}
                invalid={false}
                arriving={false}
                arrivalIndex={-1}
                dragSource={drag?.tile.id === tile?.id}
                settlingTarget={settling?.tile.id === tile?.id}
                canEdit={true}
                hoverEnabled={false}
                onTap={recall}
                onStartDrag={beginDrag}
              />
            );
          })}
        </div>
      </div>
      <div className="rack" data-drop-rack="true" aria-label="Sample tile rack">
        {remaining.map((tile) => (
          <div className="rack-slot" data-rack-tile-id={tile.id} key={tile.id}>
            <button
              className={`tile rack-tile draggable-tile ${drag?.tile.id === tile.id ? "drag-source" : ""}`}
              onPointerDown={(e) => start(e, tile)}
            >
              <span className="tile-letter" data-letter={tile.letter}>
                {tile.letter}
              </span>
              <small>{tile.value}</small>
            </button>
          </div>
        ))}
        {drag && !remaining.some((t) => t.id === drag.tile.id) && (
          <span data-testid="rack-preview-gap" className="rack-slot" />
        )}
      </div>
      <small>
        {rackPreview
          ? "Release to return to the rack."
          : "Tap a placed sample tile to recall it."}
      </small>
      {drag &&
        createPortal(
          <div
            ref={dragGhostRef}
            className="tile drag-ghost"
            data-testid="lab-drag-ghost"
            style={{ left: 0, top: 0, width: drag.width, height: drag.height }}
          >
            <span className="tile-letter" data-letter={drag.tile.letter}>
              {drag.tile.letter}
            </span>
            <small>{drag.tile.value}</small>
          </div>,
          document.body,
        )}
      {settling &&
        createPortal(
          <motion.div
            className="tile drag-ghost settling-ghost"
            aria-hidden="true"
            initial={{
              left: settling.from.x,
              top: settling.from.y,
              width: settling.from.width,
              height: settling.from.height,
            }}
            animate={{
              left: settling.to.x,
              top: settling.to.y,
              width: settling.to.width,
              height: settling.to.height,
            }}
            transition={{ duration: settling.duration }}
            onAnimationComplete={() => finishSettling(settling.id)}
          >
            <span className="tile-letter" data-letter={settling.tile.letter}>
              {settling.tile.letter}
            </span>
            <small>{settling.tile.value}</small>
          </motion.div>,
          document.body,
        )}
    </div>
  );
}
