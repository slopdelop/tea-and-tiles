import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useMotionValue } from "motion/react";
import { flushSync } from "react-dom";
import { findRackInsertionIndex } from "../rackTarget";

export type DropTarget =
  | { kind: "board"; row: number; col: number }
  | { kind: "rack"; beforeTileId?: string };
export type DragTile = { id: string; letter: string; value: number };
export type RackPreview = {
  /** Original visible order with the dragged tile removed. */
  tileIds: string[];
  insertionIndex: number;
  /** -1 when the tile started on the board rather than in this rack. */
  sourceIndex: number;
  slotPitch: number;
};
type DragOptions = {
  enabled: boolean;
  contextKey: string;
  canDrop: (tileId: string, target: DropTarget) => boolean;
  onDrop: (tileId: string, target: DropTarget) => void;
  getRackTileIds?: () => string[];
};
type DragView = {
  tile: DragTile;
  x: number;
  y: number;
  width: number;
  height: number;
  pointerX: number;
  pointerY: number;
  touch: boolean;
  target: DropTarget | null;
  rackPreview: RackPreview | null;
};
type TileRect = { x: number; y: number; width: number; height: number };
type SettlingTile = {
  id: number;
  tile: DragTile;
  from: TileRect;
  to: TileRect;
  outcome: "placed" | "returned";
  duration: number;
};
type PointerSession = {
  pointerId: number;
  pointerType: string;
  source: HTMLElement;
  sourceAnchor: HTMLElement;
  sourceOffset: TileRect;
  tile: DragTile;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  dragging: boolean;
  viewportScrollX: number;
  rackSlots: { tileId: string; centerX: number }[];
  rackGapCenters: number[];
  rackGeometryCaptured: boolean;
  rackInsertionIndex: number | null;
  rackTileIds: string[];
  slotPitch: number;
};

// Pointer coordinates and elementFromPoint both use the current viewport, so
// drops remain correct after page scroll or browser zoom. No game state is
// changed until pointerup; capture loss, Escape, blur and invalid drops cancel.
export function useTileDrag(options: DragOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const session = useRef<PointerSession | null>(null);
  const suppressClickUntil = useRef(0);
  const [drag, setDrag] = useState<DragView | null>(null);
  const dragRef = useRef<DragView | null>(null);
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const moveFrame = useRef(0);
  const latestPoint = useRef<{ x: number; y: number } | null>(null);
  const [settling, setSettling] = useState<SettlingTile | null>(null);
  const settlingId = useRef(0);
  const pendingRackSettle = useRef<{
    tile: DragTile;
    from: TileRect;
    contextKey: string;
  } | null>(null);
  const finishSettling = useCallback((id: number) => {
    setSettling((current) => (current?.id === id ? null : current));
  }, []);

  const clear = useCallback(() => {
    cancelAnimationFrame(moveFrame.current);
    moveFrame.current = 0;
    latestPoint.current = null;
    const active = session.current;
    session.current = null;
    if (active?.dragging) suppressClickUntil.current = performance.now() + 500;
    if (active?.source.hasPointerCapture(active.pointerId)) {
      active.source.releasePointerCapture(active.pointerId);
    }
    setDrag(null);
    dragRef.current = null;
  }, []);

  // A compact rack changes size and position on return/reorder. Measure the
  // returned tile after React commits the new rack instead of using an old slot.
  useLayoutEffect(() => {
    const queued = pendingRackSettle.current;
    pendingRackSettle.current = null;
    if (
      !queued ||
      !options.enabled ||
      queued.contextKey !== options.contextKey ||
      document.hidden
    )
      return;
    const destination = document.querySelector<HTMLElement>(
      `[data-drop-rack] [data-rack-tile-id="${queued.tile.id}"]`,
    );
    if (!destination?.isConnected) return;
    const rect = destination.getBoundingClientRect();
    setSettling({
      id: ++settlingId.current,
      tile: queued.tile,
      from: queued.from,
      to: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      outcome: "placed",
      duration: 0.17,
    });
  });

  useEffect(() => {
    const findTarget = (
      x: number,
      y: number,
      tileId: string,
    ): DropTarget | null => {
      const element = document.elementFromPoint(x, y);
      const cell = element?.closest<HTMLElement>(
        "[data-drop-row][data-drop-col]",
      );
      const rack = element?.closest<HTMLElement>("[data-drop-rack]");
      // Each complete outer slot represents one vacancy. Animated neighbors
      // cannot move these boundaries; only viewport scrolling translates them.
      const active = session.current;
      const scrollDelta =
        (active?.viewportScrollX ?? window.scrollX) - window.scrollX;
      const remaining = active?.rackTileIds.filter((id) => id !== tileId) ?? [];
      const insertionIndex =
        rack && !cell && active
          ? findRackInsertionIndex(
              x - scrollDelta,
              active.rackGapCenters,
              active.rackInsertionIndex,
            )
          : null;
      const beforeTileId =
        insertionIndex === null ? undefined : remaining[insertionIndex];
      const target: DropTarget | null = cell
        ? {
            kind: "board",
            row: Number(cell.dataset.dropRow),
            col: Number(cell.dataset.dropCol),
          }
        : rack
          ? {
              kind: "rack",
              ...(beforeTileId ? { beforeTileId } : {}),
            }
          : null;
      const validTarget =
        target && optionsRef.current.canDrop(tileId, target) ? target : null;
      if (active)
        active.rackInsertionIndex =
          validTarget?.kind === "rack" ? insertionIndex : null;
      return validTarget;
    };
    const update = (x: number, y: number) => {
      const active = session.current;
      if (!active?.dragging) return;
      const previous = dragRef.current;
      if (!active.rackGeometryCaptured) {
        // A board return reserves an extra slot. Commit that reservation before
        // measuring, even when pointerup beats the first animation frame. The
        // captured geometry then stays fixed for the entire gesture.
        dragX.set(x - active.offsetX);
        dragY.set(y - active.offsetY);
        pointerX.set(x);
        pointerY.set(y);
        flushSync(() =>
          setDrag({
            tile: active.tile,
            x: x - active.offsetX,
            y: y - active.offsetY,
            width: active.width,
            height: active.height,
            pointerX: x,
            pointerY: y,
            touch: active.pointerType === "touch",
            target: null,
            rackPreview: null,
          }),
        );
        const slots = [
          ...document.querySelectorAll<HTMLElement>(
            '[data-drop-rack] [data-rack-tile-id], [data-drop-rack] [data-testid="rack-preview-gap"]',
          ),
        ].map((slot) => slot.getBoundingClientRect());
        active.rackGapCenters = slots.map((rect) => rect.left + rect.width / 2);
        active.viewportScrollX = window.scrollX;
        if (slots.length > 1)
          active.slotPitch =
            (active.rackGapCenters.at(-1)! - active.rackGapCenters[0]) /
            (slots.length - 1);
        active.rackGeometryCaptured = true;
      }
      const target = findTarget(x, y, active.tile.id);
      const remaining = active.rackTileIds.filter(
        (id) => id !== active.tile.id,
      );
      const beforeIndex =
        target?.kind === "rack" && target.beforeTileId
          ? remaining.indexOf(target.beforeTileId)
          : remaining.length;
      const view: DragView = {
        tile: active.tile,
        x: x - active.offsetX,
        y: y - active.offsetY,
        width: active.width,
        height: active.height,
        pointerX: x,
        pointerY: y,
        touch: active.pointerType === "touch",
        target,
        rackPreview:
          target?.kind === "rack"
            ? {
                tileIds: remaining,
                insertionIndex:
                  beforeIndex < 0 ? remaining.length : beforeIndex,
                sourceIndex: active.rackTileIds.indexOf(active.tile.id),
                slotPitch: active.slotPitch,
              }
            : null,
      };
      dragRef.current = view;
      // Coordinates animate outside React. Rerender only on pickup or when the
      // landing target changes, rather than rebuilding 225 squares per pixel.
      dragX.set(view.x);
      dragY.set(view.y);
      pointerX.set(x);
      pointerY.set(y);
      const a = previous?.target,
        b = view.target;
      const sameTarget =
        a === b ||
        (!!a &&
          !!b &&
          a.kind === b.kind &&
          (a.kind === "board" && b.kind === "board"
            ? a.row === b.row && a.col === b.col
            : a.kind === "rack" &&
              b.kind === "rack" &&
              a.beforeTileId === b.beforeTileId));
      if (!previous || !sameTarget) setDrag(view);
    };
    const move = (event: PointerEvent) => {
      const active = session.current;
      if (!active || event.pointerId !== active.pointerId) return;
      if (!optionsRef.current.enabled) {
        clear();
        return;
      }
      const distance = Math.hypot(
        event.clientX - active.startX,
        event.clientY - active.startY,
      );
      if (
        !active.dragging &&
        distance < (active.pointerType === "touch" ? 8 : 6)
      )
        return;
      active.dragging = true;
      if (event.cancelable) event.preventDefault();
      latestPoint.current = { x: event.clientX, y: event.clientY };
      if (!moveFrame.current)
        moveFrame.current = requestAnimationFrame(() => {
          moveFrame.current = 0;
          const point = latestPoint.current;
          if (point) update(point.x, point.y);
        });
    };
    const settle = (active: PointerSession, target: DropTarget | null) => {
      const view = dragRef.current;
      if (
        !view ||
        !active.dragging ||
        document.hidden ||
        matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        return;
      const rackSlots = [
        ...document.querySelectorAll<HTMLElement>(
          "[data-drop-rack] [data-rack-tile-id]",
        ),
      ];
      const remaining = rackSlots.filter(
        (slot) => slot.dataset.rackTileId !== active.tile.id,
      );
      const rackIndex =
        target?.kind === "rack" && target.beforeTileId
          ? remaining.findIndex(
              (slot) => slot.dataset.rackTileId === target.beforeTileId,
            )
          : remaining.length;
      const destination =
        target?.kind === "board"
          ? document.querySelector<HTMLElement>(
              `[data-drop-row="${target.row}"][data-drop-col="${target.col}"]`,
            )
          : target?.kind === "rack"
            ? rackSlots[Math.max(0, rackIndex)]
            : active.sourceAnchor;
      if (!destination?.isConnected) return;
      const rect = destination.getBoundingClientRect();
      const inset = target?.kind === "board" ? 2 : 0;
      const sourceOffset = target ? null : active.sourceOffset;
      setSettling({
        id: ++settlingId.current,
        tile: active.tile,
        from: { x: view.x, y: view.y, width: view.width, height: view.height },
        to: {
          x: rect.left + (sourceOffset?.x ?? inset),
          y: rect.top + (sourceOffset?.y ?? inset),
          width: sourceOffset?.width ?? rect.width - inset * 2,
          height: sourceOffset?.height ?? rect.height - inset * 2,
        },
        outcome: target ? "placed" : "returned",
        duration: target ? 0.17 : 0.2,
      });
    };
    const returnAndClear = () => {
      const active = session.current;
      if (active) settle(active, null);
      clear();
    };
    const up = (event: PointerEvent) => {
      const active = session.current;
      if (!active || event.pointerId !== active.pointerId) return;
      // Release can arrive before the scheduled frame. Use its exact position
      // for both the final target and the start of the settling animation.
      cancelAnimationFrame(moveFrame.current);
      moveFrame.current = 0;
      if (active.dragging) update(event.clientX, event.clientY);
      const target =
        active.dragging && optionsRef.current.enabled
          ? (dragRef.current?.target ?? null)
          : null;
      const view = dragRef.current;
      if (
        target?.kind === "rack" &&
        view &&
        active.dragging &&
        !document.hidden &&
        !matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        pendingRackSettle.current = {
          tile: active.tile,
          from: {
            x: view.x,
            y: view.y,
            width: view.width,
            height: view.height,
          },
          contextKey: optionsRef.current.contextKey,
        };
      } else settle(active, target);
      clear();
      if (target) optionsRef.current.onDrop(active.tile.id, target);
    };
    const cancel = (event: PointerEvent) => {
      if (
        event.pointerId === session.current?.pointerId &&
        (event.type !== "lostpointercapture" ||
          event.target === session.current.source)
      )
        returnAndClear();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && session.current) {
        event.preventDefault();
        returnAndClear();
      }
    };
    const visibility = () => {
      if (document.hidden) {
        clear();
        setSettling(null);
      }
    };
    const click = (event: MouseEvent) => {
      if (
        event.detail !== 0 &&
        performance.now() < suppressClickUntil.current
      ) {
        suppressClickUntil.current = 0;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    // A fresh pointer press is an intentional new action, never a ghost click.
    const nextPress = () => {
      suppressClickUntil.current = 0;
      setSettling(null);
    };
    const wheel = (event: WheelEvent) => {
      if (session.current?.dragging && event.cancelable) event.preventDefault();
    };
    window.addEventListener("pointerdown", nextPress, true);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("lostpointercapture", cancel);
    window.addEventListener("blur", returnAndClear);
    window.addEventListener("resize", returnAndClear);
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", keydown);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("pointerdown", nextPress, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("blur", returnAndClear);
      window.removeEventListener("resize", returnAndClear);
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", keydown);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("click", click, true);
      const active = session.current;
      session.current = null;
      pendingRackSettle.current = null;
      cancelAnimationFrame(moveFrame.current);
      moveFrame.current = 0;
      latestPoint.current = null;
      if (active?.source.hasPointerCapture(active.pointerId))
        active.source.releasePointerCapture(active.pointerId);
    };
  }, [clear, dragX, dragY, pointerX, pointerY]);

  useEffect(() => {
    clear();
    setSettling(null);
  }, [options.enabled, options.contextKey, clear]);

  function start(event: ReactPointerEvent<HTMLElement>, tile: DragTile) {
    if (
      !optionsRef.current.enabled ||
      session.current ||
      !event.isPrimary ||
      event.button !== 0
    )
      return;
    const source = event.currentTarget,
      rect = source.getBoundingClientRect();
    const sourceAnchor =
      source.closest<HTMLElement>("[data-rack-tile-id]") ?? source;
    const sourceAnchorRect = sourceAnchor.getBoundingClientRect();
    const rackVisual = source.closest<HTMLElement>(".rack-visual");
    const sourceVisualRect = rackVisual?.getBoundingClientRect();
    const rack = document.querySelector<HTMLElement>("[data-drop-rack]");
    const measuredSlots = rack
      ? [...rack.querySelectorAll<HTMLElement>("[data-rack-tile-id]")].map(
          (slot) => ({
            tileId: slot.dataset.rackTileId!,
            rect: slot.getBoundingClientRect(),
          }),
        )
      : [];
    const logicalIds =
      optionsRef.current.getRackTileIds?.() ??
      measuredSlots.map((slot) => slot.tileId);
    const rackSlots = logicalIds.flatMap((tileId) => {
      const slot = measuredSlots.find(
        (candidate) => candidate.tileId === tileId,
      );
      return slot
        ? [{ tileId, centerX: slot.rect.left + slot.rect.width / 2 }]
        : [];
    });
    const gap = rack ? parseFloat(getComputedStyle(rack).columnGap) || 0 : 0;
    const slotPitch =
      rackSlots.length > 1
        ? (rackSlots.at(-1)!.centerX - rackSlots[0].centerX) /
          (rackSlots.length - 1)
        : (measuredSlots[0]?.rect.width ?? rect.width) + gap;
    const boardCell = document.querySelector<HTMLElement>(
      "[data-drop-row][data-drop-col]",
    );
    const size = (boardCell?.getBoundingClientRect().width || rect.width) * 1.1;
    const touch = event.pointerType === "touch";
    source.setPointerCapture(event.pointerId);
    session.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      source,
      sourceAnchor,
      // Ignore a shuffle's still-running parent translation, while keeping a
      // selected tile's own lift/rotation. Cancellation returns to its slot.
      sourceOffset: {
        x: sourceVisualRect
          ? rect.left - sourceVisualRect.left + rackVisual!.offsetLeft
          : rect.left - sourceAnchorRect.left,
        y: sourceVisualRect
          ? rect.top - sourceVisualRect.top + rackVisual!.offsetTop
          : rect.top - sourceAnchorRect.top,
        width: rect.width,
        height: rect.height,
      },
      tile,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: touch
        ? size / 2
        : ((event.clientX - rect.left) / rect.width) * size,
      offsetY: touch
        ? size + 22
        : ((event.clientY - rect.top) / rect.height) * size,
      width: size,
      height: size,
      dragging: false,
      viewportScrollX: window.scrollX,
      rackSlots,
      rackGapCenters: rackSlots.map((slot) => slot.centerX),
      rackGeometryCaptured: logicalIds.includes(tile.id),
      rackInsertionIndex: null,
      rackTileIds: rackSlots.map((slot) => slot.tileId),
      slotPitch,
    };
  }

  return {
    drag,
    rackPreview: drag?.rackPreview ?? null,
    dragX,
    dragY,
    pointerX,
    pointerY,
    settling,
    finishSettling,
    start,
  };
}
