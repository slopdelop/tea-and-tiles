import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

type Rect = { x: number; y: number; width: number; height: number };
export type RecallSource = {
  tile: { id: string; letter: string; value: number };
  from: Rect;
};
type Flight = RecallSource & { to: Rect; delay: number };
type Batch = {
  id: number;
  context: string;
  startedAt: number;
  sources: RecallSource[];
  flights: Flight[] | null;
};

/** Local visual only: the caller clears its private draft in the same event. */
export function useRecallAnimation(context: string, reduced: boolean | null) {
  const [batch, setBatch] = useState<Batch | null>(null);
  const sequence = useRef(0);
  const activeBatch = batch?.context === context && !reduced ? batch : null;
  const active = !!activeBatch;
  const cancel = useCallback(() => setBatch(null), []);

  const begin = (sources: RecallSource[]) => {
    if (reduced || !sources.length) return;
    setBatch({
      id: ++sequence.current,
      context,
      startedAt: performance.now(),
      sources,
      flights: null,
    });
  };

  useLayoutEffect(() => {
    if (!batch) return;
    if (batch.context !== context || reduced) {
      setBatch(null);
      return;
    }
    if (batch.flights) return;
    const slots = [
      ...document.querySelectorAll<HTMLElement>("[data-rack-tile-id]"),
    ];
    const flights = batch.sources.flatMap((source, index): Flight[] => {
      const destination = slots.find(
        (slot) => slot.dataset.rackTileId === source.tile.id,
      );
      if (!destination) return [];
      const rect = destination.getBoundingClientRect();
      if (!rect.width || !rect.height) return [];
      return [
        {
          ...source,
          to: {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          },
          delay: index * 0.025,
        },
      ];
    });
    setBatch(flights.length ? { ...batch, flights } : null);
  }, [batch, context, reduced]);

  useEffect(() => {
    if (!activeBatch) return;
    const onVisibility = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener("scroll", cancel, true);
    window.addEventListener("resize", cancel);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", onVisibility);
    // A lost animation callback must never leave invisible tiles or locked controls.
    const timeout = window.setTimeout(
      cancel,
      Math.max(0, 580 - (performance.now() - activeBatch.startedAt)),
    );
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("scroll", cancel, true);
      window.removeEventListener("resize", cancel);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [activeBatch?.id, cancel]);

  const finish = (id: number, tileId: string) => {
    setBatch((current) => {
      if (!current || current.id !== id || !current.flights) return current;
      const flights = current.flights.filter(
        (flight) => flight.tile.id !== tileId,
      );
      return flights.length ? { ...current, flights } : null;
    });
  };
  return {
    active,
    id: activeBatch?.id,
    flights: activeBatch?.flights ?? [],
    hiddenIds: new Set(
      (activeBatch?.flights ?? activeBatch?.sources ?? []).map(
        (source) => source.tile.id,
      ),
    ),
    begin,
    finish,
  };
}
