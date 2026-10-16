import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import type { ActivityEvent } from "../gameActivity";
export function GameActivityNotice({
  event,
  text,
  show,
  open,
  dismiss,
  anchor,
}: {
  event: ActivityEvent | null;
  text: string;
  show: boolean;
  open: () => void;
  dismiss: (id: string) => void;
  anchor: RefObject<HTMLElement | null>;
}) {
  const [held, setHeld] = useState(false);
  const [ready, setReady] = useState(false);
  const countdown = useRef({ id: "", remaining: 8000 });
  const card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!event || !show || !ready) return;
    const measure = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(340, innerWidth - 24);
      const left = Math.max(
        12,
        Math.min(rect.right - width, innerWidth - width - 12),
      );
      const top = Math.max(
        12,
        Math.min(
          rect.bottom + 12,
          innerHeight - (card.current?.offsetHeight || 140) - 12,
        ),
      );
      setPosition({
        left,
        top,
        "--activity-arrow-right": `${width - Math.max(20, Math.min(width - 20, rect.left + rect.width / 2 - left))}px`,
      } as CSSProperties);
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [event?.id, show, ready, anchor]);
  useEffect(() => {
    setReady(false);
    setHeld(false);
    if (!show || !event) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      if (
        document.querySelector(
          '[role="dialog"], [data-testid="move-celebration"], [data-testid="turn-announcement"]',
        )
      )
        timer = setTimeout(check, 50);
      else setReady(true);
    };
    check();
    return () => clearTimeout(timer);
  }, [show, event?.id]);
  useEffect(() => {
    if (!event) return;
    if (countdown.current.id !== event.id)
      countdown.current = { id: event.id, remaining: 8000 };
    if (!show || !ready || held) return;
    const start = performance.now();
    const timer = setTimeout(
      () => dismiss(event.id),
      countdown.current.remaining,
    );
    return () => {
      clearTimeout(timer);
      countdown.current.remaining = Math.max(
        0,
        countdown.current.remaining - (performance.now() - start),
      );
    };
  }, [event?.id, show, ready, held, dismiss]);
  if (!event || !show || !ready) return null;
  return createPortal(
    <div
      ref={card}
      style={position}
      className="game-activity-notice"
      data-testid="game-activity-notice"
      data-pair-id={event.pairId}
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocusCapture={() => setHeld(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setHeld(false);
      }}
    >
      <button
        className="activity-open"
        data-testid="open-activity-game"
        onClick={open}
      >
        {text}
        <span>Open game →</span>
      </button>
      <button
        className="activity-dismiss"
        aria-label="Dismiss notification"
        onClick={() => dismiss(event.id)}
      >
        ×
      </button>
    </div>,
    document.body,
  );
}
