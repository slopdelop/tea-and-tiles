import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useReducedMotion,
} from "motion/react";
import {
  premiumAt,
  previewMove,
  RuleError,
  type Command,
  type Placement,
  type Slot,
  type WinCondition,
  type MoveRecord,
} from "../shared/engine";
import { useGameSession } from "./firebase";
import { useTileDrag } from "./components/useTileDrag";
import {
  useRecallAnimation,
  type RecallSource,
} from "./components/useRecallAnimation";
import { useWordDictionary } from "./hooks/useWordDictionary";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { useScreenAwake } from "./hooks/useScreenAwake";
import { canPlaceDraftTile } from "./placementGuide";
import { draftWordCells } from "./draftWordCells";
import { formatTimeRemaining } from "./timerDisplay";
import AppVersion from "./components/AppVersion";
import { readSignInLink } from "./signInLink";
import { GameSummary, ScoreExplanation } from "./components/ScoreExplanation";
import {
  HANDOFF_MS,
  celebrationDuration,
  handoffDelay,
} from "./celebrationTiming";
import { useTabletViewport } from "./hooks/useTabletViewport";
import { previewSummary } from "./components/gameSummaryData";
import "./styles.css";

type Dialog =
  | "help"
  | "pass"
  | "exchange"
  | "dictionary"
  | "word-requests"
  | "incoming-word"
  | "new-game"
  | "incoming-game"
  | "result"
  | "score-details"
  | "end-game"
  | "incoming-end-game"
  | "debug-result"
  | null;
type Draft = { key: string; revision: number; placements: Placement[] };
const themeChoices = [
  ["linen", "Linen & sage"],
  ["coastal", "Coastal blue"],
  ["rose", "Rose & plum"],
  ["forest", "Forest & wood"],
  ["sunshine", "Blue & sunshine"],
  ["blue-ink", "Blue & ink"],
  ["terracotta", "Terracotta & cream"],
  ["ink", "Ink & gold"],
  ["midnight", "Midnight teal"],
] as const;
type Theme = (typeof themeChoices)[number][0];
type TurnNotice = {
  id: string;
  gameId: string;
  turn: Slot;
  readyAt: number;
  afterPlay: boolean;
  debug?: boolean;
};
function TurnAnnouncement({
  name,
  debug,
  onComplete,
}: {
  name: string;
  debug?: boolean;
  onComplete: () => void;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className="turn-announcement"
      initial={{ opacity: 0, y: reduced ? 0 : 12, scale: reduced ? 1 : 0.97 }}
      animate={{ opacity: [0, 1, 1, 0], y: 0, scale: 1 }}
      onAnimationComplete={onComplete}
      transition={{
        opacity: { duration: 2.2, times: [0, 0.12, 0.8, 1] },
        y: { duration: 0.3, ease: [0.2, 0.8, 0.2, 1] },
        scale: { duration: 0.3, ease: [0.2, 0.8, 0.2, 1] },
      }}
    >
      <span className="turn-announcement-flourish" aria-hidden="true">
        <i />
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M12 2c0 7-3 10-10 10 7 0 10 3 10 10 0-7 3-10 10-10-7 0-10-3-10-10Z" />
        </svg>
        <i />
      </span>
      {debug && <small>Debug preview</small>}
      <strong>{name}’s turn</strong>
    </motion.div>
  );
}
type CelebrationBand = "low" | "medium" | "high" | "bingo";
const celebrationCopy: Record<CelebrationBand, string[]> = {
  low: ["Deftly placed!", "An elegant addition!", "A clever construction!"],
  medium: [
    "Splendid wordplay!",
    "An inspired connection!",
    "Ingeniously played!",
  ],
  high: [
    "A masterful move!",
    "Exquisite wordcraft!",
    "A lexical tour de force!",
  ],
  bingo: [
    "A seven-tile tour de force!",
    "A full hand of brilliance!",
    "A triumphant flourish!",
  ],
};
function Celebration({
  score,
  bingo = false,
  variant = 0,
  debug = false,
  move,
  onComplete,
}: {
  score: number;
  bingo?: boolean;
  variant?: number;
  debug?: boolean;
  move?: MoveRecord;
  onComplete?: () => void;
}) {
  const reduced = useReducedMotion();
  const band: CelebrationBand = bingo
    ? "bingo"
    : score >= 40
      ? "high"
      : score >= 15
        ? "medium"
        : "low";
  return (
    <motion.div
      className={`celebration-card celebration-${band} ${move ? "with-score-detail" : ""}`}
      data-testid={debug ? "celebration-preview" : "move-celebration"}
      data-band={band}
      data-debug={debug || undefined}
      role={debug ? "status" : undefined}
      initial={{ opacity: 0, scale: reduced ? 1 : 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: reduced ? 0 : 0.25 }}
    >
      {(band === "high" || band === "bingo") && (
        <svg
          className="celebration-starburst"
          data-testid="celebration-starburst"
          viewBox="0 0 220 140"
          fill="none"
          aria-hidden="true"
        >
          {[
            [-86, -36],
            [-97, 6],
            [-80, 42],
            [84, -38],
            [98, 7],
            [80, 43],
          ].map(([x, y], index) => (
            <g key={index} transform={`translate(${110 + x} ${70 + y})`}>
              <path
                d="M0 -8V8M-8 0H8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <path
                d="m-4 -4 8 8m-8 0 8-8"
                stroke="currentColor"
                strokeWidth=".8"
              />
            </g>
          ))}
        </svg>
      )}
      {debug && (
        <span className="celebration-debug-label">
          Debug preview · sample points
        </span>
      )}
      <strong>+{score}</strong>
      <span>
        {celebrationCopy[band][variant % celebrationCopy[band].length]}
      </span>
      {bingo && <small>Seven tiles · includes 50 bonus points</small>}
      {move && (
        <ScoreExplanation move={move} animated onComplete={onComplete} />
      )}
    </motion.div>
  );
}
const gameModes: Record<WinCondition, { title: string; description: string }> =
  {
    classic: { title: "Classic", description: "The familiar full game." },
    "turn-limit": {
      title: "10 turns each",
      description: "Highest score after 20 turns.",
    },
    "target-score": {
      title: "First to 150",
      description: "Reach 150 points to win.",
    },
    timed: {
      title: "Timed game",
      description: "A shared countdown, at your pace.",
    },
  };
const premiumNames = {
  TW: "Triple word",
  DW: "Double word",
  TL: "Triple letter",
  DL: "Double letter",
};
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const other = (slot: Slot): Slot => (slot === "mom" ? "aunt" : "mom");
const newId = () => crypto.randomUUID();
function TileLetter({ letter }: { letter: string }) {
  return (
    <span
      className={`tile-letter ${letter === "?" ? "blank-symbol" : ""}`}
      data-letter={letter}
    >
      {letter === "?" ? "✧" : letter}
    </span>
  );
}
function rejectedDictionaryWords(error: unknown): string[] | null {
  const details = (error as { details?: { rule?: string; words?: unknown } })
    ?.details;
  if (details?.rule !== "dictionary") return null;
  return Array.isArray(details.words)
    ? details.words.filter(
        (word): word is string =>
          typeof word === "string" && /^[A-Z]{2,15}$/.test(word),
      )
    : [];
}

// Capture before removing the private fragment. A module constant survives
// React StrictMode's repeated initial render without reading a scrubbed URL.
const invitationFromLink = new URLSearchParams(
  window.location.hash.slice(1),
).get("setup");
const signInFromLink = readSignInLink(window.location.hash);
if (invitationFromLink !== null || signInFromLink !== null) {
  history.replaceState(
    history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}

function readDraft(key: string, revision: number): Omit<Draft, "key"> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    // Older versions stored only an array. Preserve those local placements.
    const saved = Array.isArray(value) ? value : record?.placements;
    return {
      revision:
        Number.isSafeInteger(record?.revision) &&
        (record!.revision as number) >= 0
          ? (record!.revision as number)
          : revision,
      placements: Array.isArray(saved)
        ? saved.filter(
            (p) =>
              p &&
              typeof p.tileId === "string" &&
              Number.isInteger(p.row) &&
              Number.isInteger(p.col) &&
              p.row >= 0 &&
              p.row < 15 &&
              p.col >= 0 &&
              p.col < 15 &&
              (p.letter === undefined || /^[A-Z]$/.test(p.letter)),
          )
        : [],
    };
  } catch {
    return { revision, placements: [] };
  }
}

function TeaMark({ large = false }: { large?: boolean }) {
  return (
    <svg
      className={large ? "tea-mark large" : "tea-mark"}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M23 17c-7-7 8-7 1-14M35 17c-7-7 8-7 1-14"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M14 24h33v15c0 9-7 16-16.5 16S14 48 14 39V24Z"
        fill="currentColor"
      />
      <path
        d="M47 28h5c11 0 10 17-5 17"
        stroke="currentColor"
        strokeWidth="5"
      />
      <path
        d="M10 58h43"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path d="m29 32 7 4-7 4v-8Z" fill="var(--paper)" />
    </svg>
  );
}

function Icon({
  name,
}: {
  name:
    | "sound"
    | "mute"
    | "help"
    | "shuffle"
    | "recall"
    | "arrow"
    | "close"
    | "check";
}) {
  const paths: Record<typeof name, ReactNode> = {
    sound: (
      <>
        <path d="m11 5-5 4H3v6h3l5 4V5Z" />
        <path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" />
      </>
    ),
    mute: (
      <>
        <path d="m11 5-5 4H3v6h3l5 4V5Z" />
        <path d="m16 9 6 6m0-6-6 6" />
      </>
    ),
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3v.1" />
      </>
    ),
    shuffle: (
      <>
        <path d="M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 3-2 4-4m4-4c1-2 2-4 4-4h3m-4-4 4 4-4 4" />
      </>
    ),
    recall: (
      <>
        <path d="m9 4-6 6 6 6M3 10h11a6 6 0 0 1 0 12" />
      </>
    ),
    arrow: (
      <>
        <path d="M4 12h15m-6-6 6 6-6 6" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function Score({ value, player }: { value: number; player: Slot }) {
  const [display, setDisplay] = useState(value);
  const previous = useRef(value);
  const reduced = useReducedMotion();
  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    if (reduced || from === value) {
      setDisplay(value);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min((now - start) / 550, 1);
      setDisplay(Math.round(from + (value - from) * (1 - (1 - t) ** 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, reduced]);
  return (
    <span
      className="score-number"
      data-testid={`score-${player}`}
      aria-label={`${value} points`}
    >
      {display}
    </span>
  );
}

let pageScrollLocks = 0;
let restorePageScroll: (() => void) | null = null;
function lockPageScroll() {
  if (pageScrollLocks++ === 0) {
    const { style } = document.body;
    const before = {
      overflow: style.overflow,
      position: style.position,
      top: style.top,
      left: style.left,
      width: style.width,
    };
    const x = window.scrollX,
      y = window.scrollY;
    Object.assign(style, {
      overflow: "hidden",
      position: "fixed",
      top: `${-y}px`,
      left: `${-x}px`,
      width: "100%",
    });
    restorePageScroll = () => {
      Object.assign(style, before);
      window.scrollTo(x, y);
    };
  }
  return () => {
    if (--pageScrollLocks === 0) {
      restorePageScroll?.();
      restorePageScroll = null;
    }
  };
}

function Modal({
  title,
  children,
  close,
  testId,
  footer,
  dismissible = true,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  testId?: string;
  footer?: ReactNode;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(close);
  closeRef.current = close;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const unlockPage = lockPageScroll();
    ref.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissibleRef.current) closeRef.current();
      if (event.key === "Tab") {
        const controls = ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
        );
        if (!controls?.length) return;
        const first = controls[0],
          last = controls[controls.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      unlockPage();
      requestAnimationFrame(() => {
        if (!document.querySelector('[role="dialog"]') && before?.isConnected)
          before.focus({ preventScroll: true });
      });
    };
  }, []);
  return createPortal(
    <motion.div
      className="modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={dismissible ? close : undefined}
    >
      <motion.div
        className="modal"
        data-testid={testId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={ref}
        initial={{ opacity: 0, y: 15, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          {dismissible && (
            <button
              className="icon-button modal-close"
              onClick={close}
              aria-label="Close dialog"
            >
              <Icon name="close" />
            </button>
          )}
          <h2 id={titleId}>{title}</h2>
        </header>
        <div className="modal-content">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

export default function App() {
  const session = useGameSession();
  const wordDictionary = useWordDictionary();
  const { game, rack, slot, names, connected, pending } = session;
  const appUpdate = useAppUpdate();
  const screenAwake = useScreenAwake(game?.status === "active" && !!slot);
  const sharedActionsPaused = session.sharedActionsPaused;
  const sharedActionMessage =
    session.sharedActionMessage ||
    "Shared actions are temporarily unavailable. Your tiles are saved here.";
  const latestGameId = useRef(game?.id);
  latestGameId.current = game?.id;
  const gameContext = `${game?.id ?? ""}:${game?.status ?? ""}:${slot ?? ""}`;
  const latestGameContext = useRef(gameContext);
  latestGameContext.current = gameContext;
  const [code, setCode] = useState((invitationFromLink || "").slice(0, 64));
  const [welcomeMode, setWelcomeMode] = useState<"join" | "signin">(
    invitationFromLink ? "join" : "signin",
  );
  const [loginPlayer, setLoginPlayer] = useState<Slot>(
    signInFromLink?.player || "mom",
  );
  const [passphrase, setPassphrase] = useState(signInFromLink?.code || "");
  const [enrolling, setEnrolling] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const latestDialog = useRef(dialog);
  latestDialog.current = dialog;
  const [dictionaryWords, setDictionaryWords] = useState<string[]>([]);
  const [incomingWordId, setIncomingWordId] = useState<string | null>(null);
  const promptedWordRequests = useRef(new Set<string>());
  const observedWordStatuses = useRef(new Map<string, string>());
  const [wordFeedback, setWordFeedback] = useState<Record<string, string>>(
    () => {
      try {
        const saved: unknown = JSON.parse(
          localStorage.getItem("tea-tiles-word-feedback") || "{}",
        );
        return saved && typeof saved === "object" && !Array.isArray(saved)
          ? Object.fromEntries(
              Object.entries(saved).filter(
                ([, value]) => typeof value === "string",
              ),
            )
          : {};
      } catch {
        return {};
      }
    },
  );
  const [wordBusy, setWordBusy] = useState<string | null>(null);
  const [wordError, setWordError] = useState("");
  const wordBusyRef = useRef(false);
  const [newGameBusy, setNewGameBusy] = useState(false);
  const [newGameError, setNewGameError] = useState("");
  const wasSharedActionPaused = useRef(false);
  useEffect(() => {
    if (wasSharedActionPaused.current && !sharedActionsPaused) {
      setMessage("");
      setWordError("");
      setNewGameError("");
    }
    wasSharedActionPaused.current = sharedActionsPaused;
  }, [sharedActionsPaused]);
  const [newGameMode, setNewGameMode] = useState<WinCondition>("classic");
  const [newGameMinutes, setNewGameMinutes] = useState("25");
  const requestedMinutes = Number(newGameMinutes);
  const validDuration =
    Number.isInteger(requestedMinutes) &&
    requestedMinutes >= 1 &&
    requestedMinutes <= 1440;
  const newGameBusyRef = useRef(false);
  const newGameAttempt = useRef<{
    id: string;
    gameId: string;
    winCondition: WinCondition;
    durationMinutes?: number;
  } | null>(null);
  const [sentNewGameRequest, setSentNewGameRequest] = useState<{
    id: string;
    gameId: string;
  } | null>(null);
  const [incomingNewGameId, setIncomingNewGameId] = useState<string | null>(
    null,
  );
  const promptedNewGameRequests = useRef(new Set<string>());
  const incomingNewGameRequest = session.newGameRequests.find(
    (request) =>
      request.id === incomingNewGameId &&
      request.gameId === game?.id &&
      request.status === "pending" &&
      request.requestedBy !== slot,
  );
  const [endGameBusy, setEndGameBusy] = useState(false);
  const [endGameError, setEndGameError] = useState("");
  const endGameBusyRef = useRef(false);
  const endGameAttempt = useRef<{
    id: string;
    gameId: string;
    expectedRevision: number;
  } | null>(null);
  const currentEndRequest = session.endGameRequests.find(
    (request) =>
      game?.status === "active" &&
      request.gameId === game.id &&
      request.expectedRevision === game.revision &&
      request.status === "pending",
  );
  const incomingEndRequest =
    currentEndRequest?.requestedBy !== slot ? currentEndRequest : undefined;
  const latestEndRequest = [...session.endGameRequests]
    .reverse()
    .find(
      (request) =>
        request.gameId === game?.id &&
        request.expectedRevision === game?.revision &&
        request.requestedBy === slot,
    );
  const incomingWordRequest = session.wordRequests.find(
    (request) =>
      request.id === incomingWordId &&
      request.status === "pending" &&
      request.requestedBy !== slot,
  );
  const [blank, setBlank] = useState<{
    tileId: string;
    row: number;
    col: number;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [exchange, setExchange] = useState<string[]>([]);
  const [rackOrder, setRackOrder] = useState<{ key: string; ids: string[] }>({
    key: "",
    ids: [],
  });
  const [sound, setSound] = useState(
    () => localStorage.getItem("tea-tiles-sound") === "true",
  );
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("tea-tiles-theme");
    return themeChoices.some(([id]) => id === saved)
      ? (saved as Theme)
      : "blue-ink";
  });
  const audio = useRef<AudioContext | null>(null);
  const [draft, setDraft] = useState<Draft>({
    key: "",
    revision: 0,
    placements: [],
  });
  const [animatedMove, setAnimatedMove] = useState<string | null>(null);
  const [freshMove, setFreshMove] = useState<string | null>(null);
  const [fadingMove, setFadingMove] = useState<string | null>(null);
  const visibleTurnHighlight = useRef<{
    gameId: string;
    moveId?: string;
  } | null>(null);
  const observedHighlight = useRef<{ gameId: string; moveId?: string } | null>(
    null,
  );
  const centeredRackCount = useRef(0);
  const observedResult = useRef<{
    gameId: string;
    status: string;
    lastMoveId?: string;
  } | null>(null);
  const [queuedResult, setQueuedResult] = useState<{
    gameId: string;
    readyAt: number;
  } | null>(null);
  const observedTurn = useRef<{ gameId: string; turn: Slot } | null>(null);
  const [queuedTurn, setQueuedTurn] = useState<TurnNotice | null>(null);
  const [turnAnnouncement, setTurnAnnouncement] = useState<TurnNotice | null>(
    null,
  );
  const [debugEnabled, setDebugEnabled] = useState(
    () => localStorage.getItem("tea-tiles-debug") === "true",
  );
  const [debugCelebration, setDebugCelebration] = useState<{
    band: CelebrationBand;
    id: number;
  } | null>(null);
  useEffect(() => {
    localStorage.setItem("tea-tiles-debug", String(debugEnabled));
    if (!debugEnabled) setDebugCelebration(null);
  }, [debugEnabled]);
  const [clockNow, setClockNow] = useState(Date.now);
  useEffect(() => {
    if (game?.winCondition !== "timed" || game.status !== "active") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      const now = Date.now();
      setClockNow(now);
      if (!session.timedClockReady || document.hidden) return;
      const remaining =
        (game.deadlineAt || 0) - (now + session.serverTimeOffset);
      if (remaining <= 0) return;
      const unit = remaining > 60_000 ? 60_000 : 1000;
      const untilBoundary =
        remaining - (Math.ceil(remaining / unit) - 1) * unit;
      timer = setTimeout(update, Math.max(50, untilBoundary + 15));
    };
    update();
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [
    game?.id,
    game?.winCondition,
    game?.status,
    game?.deadlineAt,
    session.timedClockReady,
    session.serverTimeOffset,
  ]);
  const secondsRemaining = game?.deadlineAt
    ? Math.max(
        0,
        Math.ceil(
          (game.deadlineAt - (clockNow + session.serverTimeOffset)) / 1000,
        ),
      )
    : 0;
  const timedExpired =
    game?.winCondition === "timed" &&
    session.timedClockReady &&
    secondsRemaining === 0;
  const timerText = formatTimeRemaining(secondsRemaining);
  const observedGame = useRef<{
    id: string;
    revision: number;
    lastMoveId?: string;
  } | null>(null);
  const draftKey = game && slot ? `tea-tiles-draft:${game.id}:${slot}` : "";
  const rackOrderKey = draftKey ? `${draftKey}:rack-order` : "";
  const orderedIds = rackOrder.key === rackOrderKey ? rackOrder.ids : [];
  const placements =
    game?.status === "active" && draft.key === draftKey ? draft.placements : [];
  const draftWordMembers = useMemo(
    () => draftWordCells(game?.board ?? {}, placements),
    [game?.board, placements],
  );
  const draftPulseKey = `${game?.id}:${game?.revision}:${placements.map((p) => `${p.tileId}:${p.row}:${p.col}`).join("|")}`;
  const openingBoard =
    !!game && game.status === "active" && Object.keys(game.board).length === 0;
  const centreCovered = placements.some((p) => p.row === 7 && p.col === 7);
  const yourTurn = !!game && game.turn === slot && game.status === "active";
  const reduced = useReducedMotion();
  const recallAnimation = useRecallAnimation(
    `${gameContext}:${game?.revision}`,
    reduced,
  );
  const canEdit =
    !!game &&
    !!slot &&
    game.status === "active" &&
    !pending &&
    !busy &&
    !timedExpired &&
    !recallAnimation.active;
  const canSubmit =
    yourTurn &&
    !pending &&
    !busy &&
    !wordBusy &&
    !newGameBusy &&
    !endGameBusy &&
    !currentEndRequest &&
    !timedExpired &&
    !sharedActionsPaused &&
    !recallAnimation.active;
  const [finePointer, setFinePointer] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const tabletFits = useTabletViewport(!!game && !!slot && !zoomed);
  const [tabletLandscape, setTabletLandscape] = useState(
    () =>
      matchMedia(
        "(orientation: landscape) and (min-width: 901px) and (max-width: 1440px) and (any-pointer: coarse)",
      ).matches,
  );
  useEffect(() => {
    const media = matchMedia(
      "(orientation: landscape) and (min-width: 901px) and (max-width: 1440px) and (any-pointer: coarse)",
    );
    const update = () => setTabletLandscape(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const compactTable = tabletLandscape && !!game && !!slot;
  const boardViewport = useRef<HTMLDivElement>(null);
  const lockedBoardScroll = useRef<{ left: number; top: number } | null>(null);
  const {
    drag,
    dragX,
    dragY,
    settling,
    finishSettling,
    rackPreview,
    start: startDrag,
  } = useTileDrag({
    enabled: canEdit && !dialog && !blank,
    contextKey: `${draftKey}:${game?.revision}`,
    getRackTileIds: () => visibleRack.map((tile) => tile.id),
    canDrop: (tileId, target) => {
      if (!canEdit || !rack.some((tile) => tile.id === tileId)) return false;
      if (target.kind === "rack") return true;
      return (
        !!game &&
        canPlaceDraftTile(game.board, placements, {
          tileId,
          row: target.row,
          col: target.col,
        })
      );
    },
    onDrop: (tileId, target) => {
      if (!canEdit) return;
      if (target.kind === "rack") {
        reorderRack(tileId, target.beforeTileId);
        if (placements.some((p) => p.tileId === tileId)) {
          edit(placements.filter((p) => p.tileId !== tileId));
        }
        setSelected(null);
        tick();
        return;
      }
      const tile = rack.find((t) => t.id === tileId);
      const previous = placements.find((p) => p.tileId === tileId);
      if (tile?.letter === "?" && !previous?.letter) {
        setBlank({ tileId, row: target.row, col: target.col });
      } else place(tileId, target.row, target.col, previous?.letter);
    },
  });

  const draftPulsePaused = !!drag || !!settling || recallAnimation.active;
  const syncedDraftPulseKey = useRef("");
  useLayoutEffect(() => {
    if (reduced || draftPulsePaused) return;
    const animations = Array.from(
      document.querySelectorAll(".draft-word-tile, .draft-word-pulse"),
    ).flatMap((element) =>
      element
        .getAnimations()
        .filter(
          (animation) =>
            "animationName" in animation &&
            String(animation.animationName).startsWith("draft-word-"),
        ),
    );
    if (!animations.length) return;
    let cancelled = false;
    // New CSS animations can still have a pending start. Wait for every member
    // before assigning one timeline epoch; independent currentTime resets can
    // otherwise put newly connected letters a frame behind existing letters.
    void Promise.all(animations.map((animation) => animation.ready))
      .then(() => {
        if (cancelled || animations.some((a) => a.playState !== "running"))
          return;
        const now = document.timeline.currentTime;
        if (typeof now !== "number") return;
        const scale = animations.find(
          (animation) =>
            "animationName" in animation &&
            animation.animationName === "draft-word-scale",
        );
        const elapsed =
          syncedDraftPulseKey.current === draftPulseKey &&
          typeof scale?.currentTime === "number"
            ? scale.currentTime
            : 0;
        const epoch = now - elapsed;
        animations.forEach((animation) => {
          animation.startTime = epoch;
        });
        syncedDraftPulseKey.current = draftPulseKey;
      })
      .catch(() => {
        // Removing/replacing a draft cancels its pending CSS animations.
      });
    return () => {
      cancelled = true;
    };
  }, [draftPulseKey, draftPulsePaused, reduced]);

  useEffect(() => {
    if (!game || !slot) setZoomed(false);
  }, [game?.id, slot]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.colorScheme =
      theme === "ink" || theme === "midnight" ? "dark" : "light";
    try {
      localStorage.setItem("tea-tiles-theme", theme);
    } catch {
      /* The selected theme still works for this visit. */
    }
  }, [theme]);
  useEffect(() => {
    if (!game || !slot) return;
    const context = `${game.id}:${game.revision}:${slot}`;
    const additions: Record<string, string> = {};
    for (const request of session.wordRequests) {
      if (
        request.status !== "pending" &&
        observedWordStatuses.current.get(request.id) === "pending"
      ) {
        additions[`${request.id}:${request.status}:${request.respondedAt}`] =
          context;
      }
      observedWordStatuses.current.set(request.id, request.status);
    }
    if (Object.keys(additions).length)
      setWordFeedback((previous) => {
        const next = { ...previous, ...additions };
        try {
          localStorage.setItem("tea-tiles-word-feedback", JSON.stringify(next));
        } catch {
          /* Feedback is optional when local storage is unavailable. */
        }
        return next;
      });
  }, [game?.id, game?.revision, slot, session.wordRequests]);
  useEffect(() => {
    setNewGameError("");
    setSentNewGameRequest(null);
    setNewGameMode("classic");
    setNewGameMinutes("25");
    newGameAttempt.current = null;
    if (dialog === "new-game") setDialog(null);
  }, [game?.id]);

  useEffect(() => {
    if (dialog === "incoming-end-game") {
      if (!incomingEndRequest) setDialog(null);
      return;
    }
    if (dialog === "incoming-word") {
      if (!incomingWordRequest) {
        setDialog(null);
        setIncomingWordId(null);
      }
      return;
    }
    if (dialog === "incoming-game") {
      if (!incomingNewGameRequest) {
        setDialog(null);
        setIncomingNewGameId(null);
      }
      return;
    }
    if (
      !game ||
      !slot ||
      (dialog && dialog !== "result") ||
      blank ||
      drag ||
      settling ||
      recallAnimation.active ||
      pending ||
      busy ||
      wordBusy ||
      newGameBusy ||
      endGameBusy
    )
      return;
    if (incomingEndRequest) {
      setEndGameError("");
      setDialog("incoming-end-game");
      return;
    }
    const request = [...session.wordRequests]
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .find(
        (candidate) =>
          candidate.status === "pending" &&
          candidate.requestedBy !== slot &&
          !promptedWordRequests.current.has(
            `${candidate.id}:${candidate.requestedAt}`,
          ),
      );
    if (request) {
      promptedWordRequests.current.add(`${request.id}:${request.requestedAt}`);
      setIncomingWordId(request.id);
      setWordError("");
      setDialog("incoming-word");
      return;
    }
    const gameRequest = [...session.newGameRequests]
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .find(
        (candidate) =>
          candidate.gameId === game.id &&
          candidate.status === "pending" &&
          candidate.requestedBy !== slot &&
          !promptedNewGameRequests.current.has(candidate.id),
      );
    if (gameRequest) {
      promptedNewGameRequests.current.add(gameRequest.id);
      setIncomingNewGameId(gameRequest.id);
      setNewGameError("");
      setDialog("incoming-game");
    }
  }, [
    game?.id,
    slot,
    dialog,
    blank,
    !!drag,
    !!settling,
    recallAnimation.active,
    pending,
    busy,
    wordBusy,
    newGameBusy,
    session.wordRequests,
    session.newGameRequests,
    incomingWordRequest?.id,
    incomingNewGameRequest?.id,
    incomingEndRequest?.id,
    endGameBusy,
  ]);

  useEffect(() => {
    document
      .querySelector<HTMLButtonElement>(
        `[data-testid="${zoomed ? "whole-board" : "shuffle-rack"}"]`,
      )
      ?.focus({ preventScroll: true });
    if (!zoomed) return;
    const unlockPage = lockPageScroll();
    // Zoom is an explicit action. Centre once, before any tile is picked up.
    const viewport = boardViewport.current;
    if (viewport) {
      viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2;
      viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) / 2;
    }
    const keydown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !document.querySelector(
          '[data-testid="drag-ghost"], [data-testid="settling-ghost"]',
        ) &&
        !document.querySelector('[role="dialog"]')
      )
        setZoomed(false);
    };
    window.addEventListener("keydown", keydown);
    return () => {
      unlockPage();
      window.removeEventListener("keydown", keydown);
    };
  }, [zoomed]);

  useEffect(() => {
    const viewport = boardViewport.current;
    lockedBoardScroll.current =
      drag && viewport
        ? { left: viewport.scrollLeft, top: viewport.scrollTop }
        : null;
  }, [!!drag]);

  useEffect(() => {
    const media = matchMedia("(hover: hover) and (pointer: fine)");
    const update = () => setFinePointer(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (draftKey && game)
      setDraft({ key: draftKey, ...readDraft(draftKey, game.revision) });
  }, [draftKey]);
  useEffect(() => {
    // These controls belong to one active table, unlike saved private drafts.
    setSelected(null);
    setBlank(null);
    setExchange([]);
    setDictionaryWords([]);
    setMessage("");
    setBusy(false);
    setDialog((current) =>
      current === "pass" ||
      current === "exchange" ||
      current === "dictionary" ||
      current === "end-game"
        ? null
        : current,
    );
  }, [gameContext]);
  useEffect(() => {
    if (!rackOrderKey) return;
    let ids: string[] = [];
    try {
      const saved: unknown = JSON.parse(
        localStorage.getItem(rackOrderKey) || "[]",
      );
      if (Array.isArray(saved))
        ids = [
          ...new Set(
            saved.filter((id): id is string => typeof id === "string"),
          ),
        ];
    } catch {
      /* An unavailable store keeps the server's initial rack order. */
    }
    setRackOrder({ key: rackOrderKey, ids });
  }, [rackOrderKey]);
  useEffect(() => {
    if (!rackOrder.key) return;
    try {
      localStorage.setItem(rackOrder.key, JSON.stringify(rackOrder.ids));
    } catch {
      /* Rearranging still works if device storage is full. */
    }
  }, [rackOrder]);
  useEffect(() => {
    if (draft.key) {
      try {
        localStorage.setItem(
          draft.key,
          JSON.stringify({
            revision: draft.revision,
            placements: draft.placements,
          }),
        );
      } catch {
        /* A full store does not block play. */
      }
    }
  }, [draft]);
  useEffect(() => {
    if (
      !game ||
      !slot ||
      draft.key !== draftKey ||
      draft.revision > game.revision ||
      session.loading ||
      rack.length !== game.rackCounts[slot]
    )
      return;
    if (
      game.lastMove?.player === slot &&
      ["pass", "exchange"].includes(game.lastMove.kind) &&
      draft.revision < game.revision &&
      draft.placements.length
    ) {
      setDraft({ key: draftKey, revision: game.revision, placements: [] });
      setSelected(null);
      return;
    }
    const valid = draft.placements.filter(
      (p) =>
        rack.some((t) => t.id === p.tileId) && !game.board[`${p.row},${p.col}`],
    );
    const lostTiles = valid.length !== draft.placements.length;
    if (lostTiles || draft.revision !== game.revision) {
      setDraft({ key: draftKey, revision: game.revision, placements: valid });
    }
    if (lostTiles) {
      setSelected(null);
      if (game.lastMove?.player !== slot)
        setMessage(
          "The board has changed. We kept the tiles that still fit; please check your word.",
        );
    }
  }, [
    game?.revision,
    game?.id,
    rack,
    slot,
    draft.key,
    draft.revision,
    draftKey,
    session.loading,
  ]);
  useEffect(() => {
    if (!game) {
      setAnimatedMove(null);
      return;
    }
    const previous = observedGame.current;
    observedGame.current = {
      id: game.id,
      revision: game.revision,
      lastMoveId: game.lastMove?.id,
    };
    if (previous?.id !== game.id) setAnimatedMove(null);
    if (
      previous?.id === game.id &&
      previous.revision !== game.revision &&
      game.lastMove &&
      previous.lastMoveId !== game.lastMove.id
    ) {
      setAnimatedMove(game.lastMove.id);
      const timer = setTimeout(
        () => setAnimatedMove(null),
        celebrationDuration(game.lastMove, !!reduced) + HANDOFF_MS,
      );
      return () => clearTimeout(timer);
    }
  }, [game?.id, game?.revision]);

  useEffect(() => {
    const previous = observedHighlight.current;
    observedHighlight.current = game
      ? { gameId: game.id, moveId: game.lastMove?.id }
      : null;
    setFreshMove(null);
    setFadingMove(null);
    if (
      previous?.gameId === game?.id &&
      previous?.moveId !== game?.lastMove?.id &&
      game?.lastMove?.kind === "play"
    ) {
      setFreshMove(game.lastMove.id);
    }
  }, [game?.id, game?.lastMove?.id, reduced]);

  useEffect(() => {
    if (!game || !slot || game.status !== "active") {
      setQueuedTurn(null);
      setTurnAnnouncement(null);
      return;
    }
    const previous = observedTurn.current;
    if (previous?.gameId === game.id && previous.turn === game.turn) return;
    observedTurn.current = { gameId: game.id, turn: game.turn };
    const afterPlay =
      previous?.gameId === game.id && game.lastMove?.kind === "play";
    setTurnAnnouncement(null);
    setQueuedTurn({
      id: `${game.id}:${game.revision}:${game.turn}`,
      gameId: game.id,
      turn: game.turn,
      readyAt:
        Date.now() +
        (afterPlay
          ? celebrationDuration(game.lastMove, !!reduced) + HANDOFF_MS
          : 0),
      afterPlay,
    });
  }, [game?.id, game?.turn, game?.status, slot]);

  const turnAnnouncementBlocked =
    !!dialog ||
    !!blank ||
    !!drag ||
    !!settling ||
    !!pending ||
    busy ||
    !!wordBusy ||
    newGameBusy;
  useEffect(() => {
    if (turnAnnouncementBlocked) {
      // Resume the actual notice after interaction, keeping its play highlighted.
      if (turnAnnouncement && !turnAnnouncement.debug)
        setQueuedTurn({
          ...turnAnnouncement,
          readyAt: Date.now(),
          afterPlay: false,
        });
      setTurnAnnouncement(null);
      return;
    }
    if (
      !queuedTurn ||
      game?.status !== "active" ||
      queuedTurn.gameId !== game.id ||
      queuedTurn.turn !== game.turn
    )
      return;
    // Capture this handoff window when the queue becomes ready. The effect
    // deliberately does not restart when its own yield clears animatedMove.
    const delay = handoffDelay(
      queuedTurn.readyAt,
      Date.now(),
      queuedTurn.afterPlay && animatedMove === game.lastMove?.id,
    );
    const yieldCelebration = queuedTurn.afterPlay
      ? setTimeout(() => setAnimatedMove(null), Math.max(0, delay - HANDOFF_MS))
      : undefined;
    let timer: ReturnType<typeof setTimeout>;
    const present = () => {
      // AnimatePresence keeps a closing dialog mounted for its exit fade.
      if (document.querySelector('[role="dialog"]')) {
        timer = setTimeout(present, 40);
        return;
      }
      setTurnAnnouncement(queuedTurn);
      setQueuedTurn(null);
    };
    timer = setTimeout(present, delay);
    return () => {
      clearTimeout(timer);
      clearTimeout(yieldCelebration);
    };
  }, [queuedTurn, turnAnnouncementBlocked, game?.id, game?.turn, game?.status]);
  useEffect(() => {
    const visible =
      turnAnnouncement &&
      !turnAnnouncementBlocked &&
      !turnAnnouncement.debug &&
      game?.status === "active" &&
      turnAnnouncement.gameId === game.id &&
      turnAnnouncement.turn === game.turn;
    const previous = visibleTurnHighlight.current;
    visibleTurnHighlight.current = visible
      ? { gameId: game.id, moveId: game.lastMove?.id }
      : null;
    if (
      !visible &&
      !turnAnnouncementBlocked &&
      previous?.gameId === game?.id &&
      previous?.moveId === freshMove
    )
      setFadingMove(freshMove);
  }, [
    turnAnnouncement,
    turnAnnouncementBlocked,
    game?.id,
    game?.turn,
    game?.status,
    freshMove,
  ]);
  useEffect(() => {
    // Finished games have no next-turn notice. An exiting score card starts
    // this fade in onExitComplete; a timer ending without a card starts here.
    if (
      game?.status === "finished" &&
      freshMove === game.lastMove?.id &&
      freshMove &&
      animatedMove !== freshMove &&
      !document.querySelector('[data-testid="move-celebration"]')
    )
      setFadingMove(freshMove);
  }, [game?.status, game?.lastMove?.id, freshMove, animatedMove]);
  useEffect(() => {
    if (!fadingMove) return;
    const timer = setTimeout(
      () => {
        setFreshMove((current) => (current === fadingMove ? null : current));
        setFadingMove(null);
      },
      reduced ? 0 : 5000,
    );
    return () => clearTimeout(timer);
  }, [fadingMove, reduced]);

  useEffect(() => {
    const previous = observedResult.current;
    observedResult.current = game
      ? { gameId: game.id, status: game.status, lastMoveId: game.lastMove?.id }
      : null;
    if (
      !game ||
      game.status !== "finished" ||
      game.endedReason === "new-game"
    ) {
      setQueuedResult(null);
      setDialog((current) => (current === "result" ? null : current));
      return;
    }
    if (previous?.gameId === game.id && previous.status === "finished") return;
    const finalPlay =
      previous?.gameId === game.id &&
      previous.lastMoveId !== game.lastMove?.id &&
      game.lastMove?.kind === "play";
    setQueuedResult({
      gameId: game.id,
      readyAt:
        Date.now() +
        (finalPlay
          ? celebrationDuration(game.lastMove, !!reduced) + HANDOFF_MS
          : 0),
    });
  }, [game?.id, game?.revision, game?.status, game?.endedReason]);

  const hasIncomingDecision =
    !!incomingEndRequest ||
    session.wordRequests.some(
      (request) => request.status === "pending" && request.requestedBy !== slot,
    ) ||
    session.newGameRequests.some(
      (request) =>
        request.gameId === game?.id &&
        request.status === "pending" &&
        request.requestedBy !== slot,
    );
  useEffect(() => {
    if (
      !queuedResult ||
      queuedResult.gameId !== game?.id ||
      game.status !== "finished" ||
      game.endedReason === "new-game" ||
      hasIncomingDecision ||
      dialog ||
      blank ||
      drag ||
      settling ||
      pending ||
      busy ||
      wordBusy ||
      newGameBusy
    )
      return;
    const delay = handoffDelay(
      queuedResult.readyAt,
      Date.now(),
      !!animatedMove,
    );
    const yieldCelebration = setTimeout(
      () => setAnimatedMove(null),
      Math.max(0, delay - HANDOFF_MS),
    );
    let timer: ReturnType<typeof setTimeout>;
    const present = () => {
      if (document.querySelector('[role="dialog"]')) {
        timer = setTimeout(present, 40);
        return;
      }
      setDialog("result");
    };
    timer = setTimeout(present, delay);
    return () => {
      clearTimeout(timer);
      clearTimeout(yieldCelebration);
    };
    // Like the turn handoff, clearing its own celebration must not restart it.
  }, [
    queuedResult,
    game?.id,
    game?.status,
    game?.endedReason,
    hasIncomingDecision,
    dialog,
    !!blank,
    !!drag,
    !!settling,
    pending,
    busy,
    wordBusy,
    newGameBusy,
  ]);

  function tick() {
    if (!sound) return;
    try {
      audio.current ??= new AudioContext();
      const context = audio.current;
      void context.resume();
      const oscillator = context.createOscillator(),
        gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(610, context.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(
        310,
        context.currentTime + 0.055,
      );
      gain.gain.setValueAtTime(0.035, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.07);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.08);
    } catch {
      /* Sound is optional. */
    }
  }
  function edit(next: Placement[]) {
    setDraft({
      key: draftKey,
      revision: Math.max(draft.revision, game?.revision ?? 0),
      placements: next,
    });
    setMessage("");
  }
  function recallTiles() {
    if (!canEdit || !placements.length || drag || settling) return;
    const sources = placements.flatMap((placement): RecallSource[] => {
      const tile = rack.find((candidate) => candidate.id === placement.tileId);
      const element = document.querySelector<HTMLElement>(
        `[data-testid="board-cell-${placement.row}-${placement.col}"] .board-tile`,
      );
      if (!tile || !element) return [];
      const rect = element.getBoundingClientRect();
      return [
        {
          tile: { ...tile, letter: placement.letter || tile.letter },
          from: {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          },
        },
      ];
    });
    recallAnimation.begin(sources);
    edit([]);
    setSelected(null);
    tick();
  }
  function place(tileId: string, row: number, col: number, letter?: string) {
    if (!canEdit || !game || !rack.some((t) => t.id === tileId)) return;
    if (!canPlaceDraftTile(game.board, placements, { tileId, row, col })) {
      setMessage("Choose an empty square on the board.");
      return;
    }
    edit([
      ...placements.filter((p) => p.tileId !== tileId),
      { tileId, row, col, ...(letter ? { letter } : {}) },
    ]);
    setSelected(null);
    tick();
  }
  function tapSquare(row: number, col: number) {
    if (!canEdit || game?.board[`${row},${col}`]) return;
    const existing = placements.find((p) => p.row === row && p.col === col);
    if (existing) {
      if (selected === existing.tileId) {
        edit(placements.filter((p) => p.tileId !== existing.tileId));
        setSelected(null);
      } else setSelected(existing.tileId);
      tick();
      return;
    }
    if (!selected) {
      setMessage("First tap a tile in your rack, then tap a square.");
      return;
    }
    if (
      !game ||
      !canPlaceDraftTile(game.board, placements, { tileId: selected, row, col })
    ) {
      setMessage("Choose an empty square on the board.");
      return;
    }
    const tile = rack.find((t) => t.id === selected),
      previous = placements.find((p) => p.tileId === selected);
    if (tile?.letter === "?" && !previous?.letter) {
      setBlank({ tileId: selected, row, col });
      return;
    }
    place(selected, row, col, previous?.letter);
  }
  async function send(kind: Command["kind"], tileIds?: string[]) {
    if (!game || !slot || busy || pending || sharedActionsPaused) return;
    if (kind !== "rematch" && !canSubmit) return;
    if (!connected) {
      setMessage(
        "Please reconnect before sending your turn. Your tiles are saved here.",
      );
      return;
    }
    if (kind === "play" && unknownWords.length) {
      showDictionary(unknownWords);
      return;
    }
    const submittedContext = gameContext;
    setBusy(true);
    setMessage("");
    setDialog(null);
    try {
      await session.submit({
        id: newId(),
        gameId: game.id,
        expectedRevision: game.revision,
        kind,
        ...(kind === "play" ? { placements } : {}),
        ...(tileIds ? { tileIds } : {}),
      });
      if (latestGameContext.current !== submittedContext) return;
      edit([]);
      setSelected(null);
      setExchange([]);
      tick();
    } catch (error) {
      if (latestGameContext.current !== submittedContext) return;
      const rejectedWords = rejectedDictionaryWords(error);
      if (
        (error as { details?: { rule?: string } })?.details?.rule === "timed"
      ) {
        setMessage("");
      } else if (kind === "play" && rejectedWords !== null) {
        showDictionary(rejectedWords);
      } else {
        setMessage(
          error instanceof Error
            ? error.message
            : "Your move could not be confirmed. Please try again.",
        );
      }
    } finally {
      if (latestGameContext.current === submittedContext) setBusy(false);
    }
  }
  async function retry() {
    if (sharedActionsPaused) return;
    const submittedContext = gameContext;
    setBusy(true);
    setMessage("");
    try {
      await session.retryPending();
    } catch (error) {
      if (latestGameContext.current !== submittedContext) return;
      const rejectedWords = rejectedDictionaryWords(error);
      if ((error as { details?: { rule?: string } })?.details?.rule === "timed")
        setMessage("");
      else if (rejectedWords !== null) showDictionary(rejectedWords);
      else
        setMessage(
          error instanceof Error
            ? error.message
            : "Still reconnecting. Please try again.",
        );
    } finally {
      if (latestGameContext.current === submittedContext) setBusy(false);
    }
  }
  function showDictionary(words: string[]) {
    setDictionaryWords([...new Set(words)]);
    setWordError("");
    setDialog("dictionary");
  }
  async function askForWords(words: string[]) {
    if (!canUseDictionary || wordBusyRef.current || !words.length) return;
    wordBusyRef.current = true;
    setWordBusy("request");
    setWordError("");
    try {
      for (const word of [...new Set(words)]) await session.requestWord(word);
      setDialog(null);
    } catch (error) {
      setWordError(
        error instanceof Error
          ? error.message
          : "The request could not be sent. Please try again.",
      );
    } finally {
      wordBusyRef.current = false;
      setWordBusy(null);
    }
  }
  async function respondToWord(
    id: string,
    approve: boolean,
    expectedRequestedAt: number,
  ) {
    if (!canUseDictionary || wordBusyRef.current) return;
    wordBusyRef.current = true;
    setWordBusy(id);
    setWordError("");
    try {
      await session.respondToWord(id, approve, expectedRequestedAt);
    } catch (error) {
      setWordError(
        error instanceof Error
          ? error.message
          : "Your answer could not be saved. Please try again.",
      );
    } finally {
      wordBusyRef.current = false;
      setWordBusy(null);
    }
  }
  async function requestNewGame() {
    if (
      !game ||
      !canUseNewGame ||
      newGameBusyRef.current ||
      currentGameRequest ||
      waitingForNewGame ||
      (newGameMode === "timed" && !validDuration)
    )
      return;
    newGameBusyRef.current = true;
    setNewGameBusy(true);
    setNewGameError("");
    const previous = newGameAttempt.current;
    const previousResult = session.newGameRequests.find(
      (request) => request.id === previous?.id,
    );
    const attempt =
      previous?.gameId === game.id &&
      (!previousResult || previousResult.status === "pending")
        ? previous
        : {
            id: newId(),
            gameId: game.id,
            winCondition: newGameMode,
            ...(newGameMode === "timed"
              ? { durationMinutes: requestedMinutes }
              : {}),
          };
    newGameAttempt.current = attempt;
    try {
      const result = await session.requestNewGame(attempt);
      if (result.id === attempt.id) setSentNewGameRequest(attempt);
      else {
        // Simultaneous proposals can return the other player's existing request.
        // Let its live record choose the recipient UI, rather than claiming it.
        setSentNewGameRequest(null);
        newGameAttempt.current = null;
      }
      setDialog(null);
    } catch (error) {
      if (latestGameId.current === attempt.gameId)
        setNewGameError(
          error instanceof Error
            ? error.message
            : "The new game request could not be confirmed. Please try again.",
        );
    } finally {
      newGameBusyRef.current = false;
      setNewGameBusy(false);
    }
  }
  async function respondToNewGame(requestId: string, approve: boolean) {
    if (!canUseNewGame || newGameBusyRef.current) return;
    const respondingGameId = game?.id;
    newGameBusyRef.current = true;
    setNewGameBusy(true);
    setNewGameError("");
    try {
      await session.respondToNewGame({ requestId, approve });
    } catch (error) {
      if (latestGameId.current === respondingGameId)
        setNewGameError(
          error instanceof Error
            ? error.message
            : "Your new game decision could not be confirmed. Please try again.",
        );
    } finally {
      newGameBusyRef.current = false;
      setNewGameBusy(false);
    }
  }
  const endGameUnavailable = sharedActionsPaused
    ? sharedActionMessage
    : !connected
      ? "Reconnect to decide whether to end the game."
      : pending || busy || wordBusy || newGameBusy || endGameBusy
        ? "Wait for the current action to finish saving."
        : !session.endGameRequestsReady
          ? session.endGameRequestsError || "Checking end-game requests…"
          : "";
  const canUseEndGame =
    !!slot &&
    game?.status === "active" &&
    game.bagCount === 0 &&
    !endGameUnavailable;
  async function requestEndGame() {
    if (!canUseEndGame || !game || currentEndRequest || endGameBusyRef.current)
      return;
    const attempt =
      endGameAttempt.current?.gameId === game.id &&
      endGameAttempt.current.expectedRevision === game.revision
        ? endGameAttempt.current
        : { id: newId(), gameId: game.id, expectedRevision: game.revision };
    endGameAttempt.current = attempt;
    endGameBusyRef.current = true;
    setEndGameBusy(true);
    setEndGameError("");
    try {
      await session.requestEndGame(attempt);
      if (latestGameId.current === attempt.gameId)
        setDialog((current) => (current === "end-game" ? null : current));
    } catch (error) {
      if (latestGameId.current === attempt.gameId)
        setEndGameError(
          error instanceof Error
            ? error.message
            : "The request could not be confirmed. Try again.",
        );
    } finally {
      endGameBusyRef.current = false;
      setEndGameBusy(false);
    }
  }
  async function respondToEndGame(approve: boolean) {
    if (!canUseEndGame || !incomingEndRequest || endGameBusyRef.current) return;
    const request = incomingEndRequest;
    endGameBusyRef.current = true;
    setEndGameBusy(true);
    setEndGameError("");
    try {
      await session.respondToEndGame({ requestId: request.id, approve });
    } catch (error) {
      if (latestGameId.current === request.gameId)
        setEndGameError(
          error instanceof Error
            ? error.message
            : "Your decision could not be confirmed. Try again.",
        );
    } finally {
      endGameBusyRef.current = false;
      setEndGameBusy(false);
    }
  }
  function shuffle() {
    const ids = rack.map((t) => t.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    setRackOrder({ key: rackOrderKey, ids });
    tick();
  }
  function reorderRack(tileId: string, beforeTileId?: string) {
    const ids = orderedRack
      .map((tile) => tile.id)
      .filter((id) => id !== tileId);
    const index = beforeTileId ? ids.indexOf(beforeTileId) : ids.length;
    ids.splice(index < 0 ? ids.length : index, 0, tileId);
    setRackOrder({ key: rackOrderKey, ids });
  }
  let preview: ReturnType<typeof previewMove> | null = null,
    previewError = "",
    draftErrorCode = "";
  if (game && placements.length) {
    try {
      preview = previewMove(game, rack, placements);
    } catch (error) {
      previewError =
        error instanceof Error ? error.message : "Keep building your word.";
      if (
        error instanceof RuleError &&
        ["line", "gap", "center", "connection", "word"].includes(error.code)
      ) {
        draftErrorCode = error.code;
      }
    }
  }
  const orderedRack = [...rack].sort((a, b) => {
    const ai = orderedIds.indexOf(a.id),
      bi = orderedIds.indexOf(b.id);
    return (
      (ai < 0 ? 100 + rack.indexOf(a) : ai) -
      (bi < 0 ? 100 + rack.indexOf(b) : bi)
    );
  });
  const visibleRack = orderedRack.filter(
    (tile) => !placements.some((placement) => placement.tileId === tile.id),
  );
  // Reserve the returning tile's space once at pickup. Entering and leaving the
  // rack then keeps the tray and its logical drop positions stationary.
  const reserveRackReturn =
    !!drag && !visibleRack.some((tile) => tile.id === drag.tile.id);
  if (!drag) centeredRackCount.current = visibleRack.length;
  const latest = game?.lastMove;
  const emptiedRack =
    game?.bagCount === 0
      ? latest?.kind === "play" && game.rackCounts[latest.player] === 0
        ? latest.player
        : (["mom", "aunt"] as const).find(
            (player) =>
              game.rackCounts[player] === 0 &&
              game.rackCounts[other(player)] > 0,
          )
      : undefined;
  const endingReason =
    game?.endedReason ||
    (emptiedRack
      ? "rack-out"
      : game && game.scorelessTurns >= 6
        ? "scoreless"
        : undefined);
  const endingDescription =
    endingReason === "agreed-end"
      ? "You both agreed to finish with the bag empty. Each player’s remaining tile values were deducted; no tiles were transferred."
      : endingReason === "turn-limit"
        ? "Ten turns each, all played. The highest score wins."
        : endingReason === "target-score"
          ? "150 points reached."
          : endingReason === "timed"
            ? "Time is up. The highest score wins."
            : endingReason === "scoreless"
              ? "Six consecutive turns without points ended the game. Each player’s remaining tile values were deducted."
              : endingReason === "rack-out"
                ? emptiedRack
                  ? `${names[emptiedRack]} used their last tile with the bag empty. ${names[other(emptiedRack)]}’s remaining tile values were deducted and added to ${names[emptiedRack]}’s score.`
                  : "A player used their last tile with the bag empty. The remaining tile values were deducted from their partner and added to their score."
                : "The game is complete. Final scores are shown above.";
  const resultTitle =
    game?.winner === "tie"
      ? "An even match — a tie!"
      : game?.winner
        ? `${names[game.winner]} wins!`
        : "Game complete";
  const houseWords = useMemo(
    () => new Set(session.houseWords.map((entry) => entry.word)),
    [session.houseWords],
  );
  const dictionaryReady =
    !!wordDictionary.dictionary && session.dictionaryReady;
  const previewWordsKey = preview?.words.join("|") || "";
  const unknownWords = useMemo(
    () =>
      dictionaryReady && previewWordsKey
        ? previewWordsKey
            .split("|")
            .filter(
              (word, index, words) =>
                words.indexOf(word) === index &&
                !wordDictionary.dictionary!.has(word) &&
                !houseWords.has(word),
            )
        : [],
    [dictionaryReady, previewWordsKey, wordDictionary.dictionary, houseWords],
  );
  const wordCheckState =
    wordDictionary.error || session.dictionaryError
      ? "unavailable"
      : !dictionaryReady
        ? connected
          ? "checking"
          : "unavailable"
        : unknownWords.length
          ? "unrecognized"
          : "recognized";
  const canUseDictionary =
    !!slot &&
    connected &&
    session.dictionaryReady &&
    !pending &&
    !busy &&
    !wordBusy &&
    !newGameBusy &&
    !endGameBusy &&
    !sharedActionsPaused;
  const popupWords = dictionaryWords.filter((word) => !houseWords.has(word));
  const requestableWords = popupWords.filter(
    (word) =>
      !session.wordRequests.some(
        (request) => request.word === word && request.status === "pending",
      ),
  );
  const partnerName = slot ? names[other(slot)] : "your partner";
  const currentGameRequest = session.newGameRequests.find(
    (request) => request.gameId === game?.id && request.status === "pending",
  );
  const sentGameResult = session.newGameRequests.find(
    (request) => request.id === sentNewGameRequest?.id,
  );
  const waitingForNewGame =
    currentGameRequest?.requestedBy === slot ||
    (!!sentNewGameRequest &&
      sentNewGameRequest.gameId === game?.id &&
      (!sentGameResult || sentGameResult.status === "pending"));
  const newGameUnavailable = currentEndRequest
    ? "Finish the end-game decision before starting a new game."
    : sharedActionsPaused
      ? sharedActionMessage
      : !connected
        ? "Reconnect to request or start a new game."
        : pending || busy
          ? "Wait for your move to finish saving."
          : wordBusy || newGameBusy
            ? "Wait for this decision to finish saving."
            : !session.newGameRequestsReady
              ? session.newGameRequestsError ||
                "Checking for new game requests…"
              : "";
  const canUseNewGame = !!game && !!slot && !newGameUnavailable;
  const uncertainGameRequest =
    !!newGameAttempt.current &&
    !session.newGameRequests.some(
      (request) => request.id === newGameAttempt.current?.id,
    );
  const activeMode = game?.winCondition || "classic";
  const passReachesTurnLimit =
    activeMode === "turn-limit" &&
    (game?.turnsPlayed ?? game?.revision ?? 0) >= 19;
  const pendingWordCount = session.wordRequests.filter(
    (request) => request.status === "pending",
  ).length;
  const turnActionReason = currentEndRequest
    ? "Play is paused while you decide whether to end this game."
    : sharedActionsPaused
      ? sharedActionMessage
      : timedExpired
        ? connected
          ? "Time is up. Confirming the final score…"
          : "Time is up. Reconnect to confirm the final score."
        : !connected
          ? "Reconnect to pass or exchange tiles."
          : pending || busy
            ? "Wait for your move to finish saving."
            : wordBusy || newGameBusy
              ? "Wait for this decision to finish saving."
              : !yourTurn
                ? `${partnerName} is playing. ${game?.bagCount === 0 ? "Pass is" : "Pass and exchange are"} available on your turn.`
                : "";
  const exchangeReason =
    turnActionReason ||
    (game && game.bagCount > 0 && game.bagCount < 7
      ? "Exchanging needs at least 7 tiles in the bag."
      : "");
  const currentWordRequests = session.wordRequests.filter(
    (request) =>
      request.status === "pending" ||
      wordFeedback[`${request.id}:${request.status}:${request.respondedAt}`] ===
        `${game?.id}:${game?.revision}:${slot}`,
  );
  const pauseRecovery = (modal = false) =>
    sharedActionsPaused && session.sharedActionsResumeAt == null ? (
      <button
        type="button"
        className="secondary-button pause-recovery"
        data-testid={
          modal ? "modal-resume-shared-actions" : "resume-shared-actions"
        }
        onClick={() => {
          setMessage("");
          setWordError("");
          setNewGameError("");
          session.resumeSharedActions();
        }}
      >
        Try again
      </button>
    ) : null;
  const pauseNotice = (modal = false) =>
    sharedActionsPaused ? (
      <div
        className="notice shared-action-pause"
        role="status"
        data-testid={
          modal ? "modal-shared-action-pause" : "shared-action-pause"
        }
      >
        <span>{sharedActionMessage}</span>
        {pauseRecovery(modal)}
      </div>
    ) : null;
  const wordRequests = (testPrefix = "", review = false) => (
    <div className="word-request-content">
      {review && !!session.houseWords.length && (
        <p className="shared-word-count">
          {session.houseWords.length} shared{" "}
          {session.houseWords.length === 1 ? "word" : "words"} · saved for your
          next game, too.
        </p>
      )}
      {review && !!session.houseWords.length && (
        <ul className="shared-word-list" aria-label="Approved shared words">
          {[...session.houseWords]
            .sort((a, b) => a.word.localeCompare(b.word))
            .map(({ word }) => (
              <li key={word}>{word}</li>
            ))}
        </ul>
      )}
      <div className="word-request-list" aria-live="polite">
        {[...(review ? session.wordRequests : currentWordRequests)]
          .filter(
            (request) =>
              dialog !== "incoming-word" || request.id !== incomingWordId,
          )
          .sort(
            (a, b) =>
              Number(b.status === "pending") - Number(a.status === "pending"),
          )
          .map((request) => {
            const own = request.requestedBy === slot;
            return (
              <article
                className={`word-request ${request.status}`}
                key={request.id}
                data-testid={`${testPrefix}word-request-${request.id}`}
                data-state={request.status}
              >
                <p>
                  {request.status === "pending" ? (
                    own ? (
                      <>
                        Waiting for {partnerName} to add{" "}
                        <strong>{request.word}</strong>.
                      </>
                    ) : (
                      <>
                        {names[request.requestedBy]} asks to add{" "}
                        <strong>{request.word}</strong> to your dictionary.
                      </>
                    )
                  ) : request.status === "accepted" ? (
                    <>
                      <strong>{request.word}</strong> was added to your shared
                      dictionary.
                    </>
                  ) : own ? (
                    <>
                      {partnerName} chose not to add{" "}
                      <strong>{request.word}</strong>.
                    </>
                  ) : (
                    <>
                      <strong>{request.word}</strong> was not added.
                    </>
                  )}
                </p>
                {request.status === "pending" && !own && (
                  <div className="word-request-actions">
                    <button
                      className="primary-button"
                      data-testid={`${testPrefix}approve-word-${request.id}`}
                      disabled={!canUseDictionary}
                      onClick={() =>
                        void respondToWord(
                          request.id,
                          true,
                          request.requestedAt,
                        )
                      }
                    >
                      {wordBusy === request.id ? "Saving…" : "Add word"}
                    </button>
                    <button
                      className="secondary-button"
                      data-testid={`${testPrefix}decline-word-${request.id}`}
                      disabled={!canUseDictionary}
                      onClick={() =>
                        void respondToWord(
                          request.id,
                          false,
                          request.requestedAt,
                        )
                      }
                    >
                      Don’t add word
                    </button>
                  </div>
                )}
                {request.status === "declined" &&
                  own &&
                  !houseWords.has(request.word) && (
                    <button
                      className="text-button"
                      disabled={!canUseDictionary}
                      onClick={() => void askForWords([request.word])}
                    >
                      Ask to add again
                    </button>
                  )}
              </article>
            );
          })}
      </div>
      {!session.wordRequests.length && !session.houseWords.length && (
        <p className="shared-word-count">
          Words you both allow will appear here.
        </p>
      )}
      {review && pauseNotice(true)}
      {wordError && !sharedActionsPaused && (
        <p className="word-request-error" role="alert">
          {wordError}
        </p>
      )}
      {!connected && (
        <p className="shared-word-count">
          Reconnect to send or answer a request.
        </p>
      )}
    </div>
  );
  const finishScoreCelebration = (moveId: string) => {
    if (latestGameId.current !== game?.id || game?.lastMove?.id !== moveId)
      return;
    setAnimatedMove((current) => (current === moveId ? null : current));
    setQueuedTurn((current) =>
      current?.gameId === game.id
        ? { ...current, readyAt: Date.now() + HANDOFF_MS, afterPlay: false }
        : current,
    );
    setQueuedResult((current) =>
      current?.gameId === game.id
        ? { ...current, readyAt: Date.now() + HANDOFF_MS }
        : current,
    );
  };
  const lastCells = new Set(
    latest?.kind === "play"
      ? latest.placements.map((p) => `${p.row},${p.col}`)
      : [],
  );
  const notice = sharedActionsPaused ? "" : message || session.error;
  const status =
    pending || busy
      ? "Saving your move…"
      : !connected
        ? "Reconnecting…"
        : game?.status === "finished"
          ? game.endedReason === "new-game"
            ? "Starting your new game…"
            : "A lovely game, well played."
          : yourTurn
            ? "Your turn"
            : `Waiting for ${names[game?.turn || "mom"]}`;

  const appHeader = (
    <header
      className={`app-header ${compactTable ? "table-toolbar" : ""}`}
      inert={zoomed}
    >
      {!compactTable && (
        <a className="brand" href="./" aria-label="Tea and Tiles home">
          <TeaMark />
          <span>
            Tea <i>&</i> Tiles
            <small>A LITTLE CLOSER, ONE WORD AT A TIME</small>
          </span>
        </a>
      )}
      <div className="header-actions">
        {(compactTable || !connected) && (
          <div className="table-utility-meta">
            {!connected && (
              <span
                className="connection offline"
                role="status"
                data-testid="connection-status"
              >
                <span aria-hidden="true" />
                Reconnecting
              </span>
            )}
            {compactTable && (
              <span
                className="sidebar-bag-count"
                data-testid="sidebar-bag-count"
              >
                {game?.bagCount} tiles in the bag
              </span>
            )}
          </div>
        )}
        {game && slot && (
          <button
            className="secondary-button header-new-game"
            data-testid="new-game"
            disabled={
              !canUseNewGame || !!currentGameRequest || waitingForNewGame
            }
            title={
              waitingForNewGame
                ? `Waiting for ${partnerName} to agree.`
                : currentGameRequest
                  ? "A new game request is waiting for a decision."
                  : newGameUnavailable ||
                    "Ask your partner to start a new game."
            }
            onClick={() => {
              setNewGameError("");
              setDialog("new-game");
            }}
          >
            New game
          </button>
        )}
        {appUpdate.available && (
          <div
            className="header-update"
            data-testid="app-update-banner"
            role="status"
          >
            <button
              className="secondary-button"
              data-testid="apply-update"
              disabled={
                !!pending ||
                busy ||
                enrolling ||
                !!drag ||
                !!settling ||
                recallAnimation.active ||
                !!wordBusy ||
                newGameBusy ||
                endGameBusy ||
                hasIncomingDecision
              }
              onClick={() => void appUpdate.apply()}
            >
              Update app
            </button>
          </div>
        )}
        <button
          className="icon-button sound-control"
          onClick={() => {
            const next = !sound;
            setSound(next);
            localStorage.setItem("tea-tiles-sound", String(next));
          }}
          aria-label={sound ? "Turn sound off" : "Turn sound on"}
          aria-pressed={sound}
          title={sound ? "Sound on" : "Sound off"}
        >
          <Icon name={sound ? "sound" : "mute"} />
        </button>
        <button
          className="icon-button help-control"
          onClick={() => setDialog("help")}
          aria-label="Help & settings"
          data-testid="help-settings"
        >
          <Icon name="help" />
        </button>
      </div>
    </header>
  );

  return (
    <MotionConfig reducedMotion="user">
      <div
        className={`app-shell ${game && slot ? "active-game" : ""} ${compactTable ? "compact-table" : ""} ${tabletFits ? "tablet-viewport-fit" : ""} ${zoomed ? "board-focus" : ""}`}
      >
        {!compactTable && appHeader}

        {session.loading && !game ? (
          <main className="welcome loading-state">
            <TeaMark large />
            <h1>Putting the kettle on…</h1>
            <p>Opening your saved game.</p>
            <span className="loading-dots" aria-label="Loading">
              <i />
              <i />
              <i />
            </span>
          </main>
        ) : !slot ? (
          <main className="welcome">
            <div className="welcome-art" aria-hidden="true">
              <div className="paper-leaf leaf-one" />
              <div className="paper-leaf leaf-two" />
              <TeaMark large />
              <div className="welcome-tiles">
                {"HELLO".split("").map((letter, i) => (
                  <motion.span
                    key={i}
                    className="tile"
                    initial={{ y: 12, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.08 * i }}
                  >
                    <TileLetter letter={letter} />
                    <small>1</small>
                  </motion.span>
                ))}
              </div>
            </div>
            <p className="eyebrow">YOUR TABLE IS WAITING</p>
            <h1>
              A cup of tea.
              <br />A word with family.
            </h1>
            <p className="welcome-copy">
              A quiet little place to play together,
              <br className="desktop-break" /> whenever you have a moment.
            </p>
            <div className="welcome-modes" aria-label="Open your table">
              <button
                type="button"
                className={welcomeMode === "signin" ? "chosen" : ""}
                aria-pressed={welcomeMode === "signin"}
                data-testid="welcome-signin"
                onClick={() => {
                  setWelcomeMode("signin");
                  setMessage("");
                }}
              >
                Sign in
              </button>
              <button
                type="button"
                className={welcomeMode === "join" ? "chosen" : ""}
                aria-pressed={welcomeMode === "join"}
                data-testid="welcome-join"
                onClick={() => {
                  setWelcomeMode("join");
                  setPassphrase("");
                  setMessage("");
                }}
              >
                Join with invitation
              </button>
            </div>
            <form
              className="enroll-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (sharedActionsPaused || enrolling) return;
                setEnrolling(true);
                setMessage("");
                try {
                  if (welcomeMode === "join") await session.enroll(code.trim());
                  else await session.signInPlayer(loginPlayer, passphrase);
                  setPassphrase("");
                } catch (error) {
                  setMessage(
                    error instanceof Error
                      ? error.message
                      : "We couldn’t open your table. Please check your details and try again.",
                  );
                } finally {
                  setEnrolling(false);
                }
              }}
            >
              {welcomeMode === "join" ? (
                <>
                  <label htmlFor="setup-code">Your invitation word</label>
                  <input
                    id="setup-code"
                    data-testid="setup-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="e.g. maple"
                    maxLength={64}
                    required
                  />
                </>
              ) : (
                <>
                  <label htmlFor="login-player">Your name</label>
                  <select
                    id="login-player"
                    data-testid="login-player"
                    value={loginPlayer}
                    onChange={(event) =>
                      setLoginPlayer(event.target.value as Slot)
                    }
                    autoComplete="username"
                  >
                    <option value="mom">{names.mom}</option>
                    <option value="aunt">{names.aunt}</option>
                  </select>
                  <label htmlFor="login-password">Your private code</label>
                  <input
                    id="login-password"
                    data-testid="login-password"
                    type="password"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    autoComplete="current-password"
                    inputMode="numeric"
                    maxLength={128}
                    required
                  />
                </>
              )}
              <button
                className="primary-button"
                data-testid="enroll-submit"
                disabled={
                  enrolling ||
                  !(welcomeMode === "join" ? code.trim() : passphrase) ||
                  sharedActionsPaused
                }
              >
                {enrolling
                  ? "Finding your seat…"
                  : welcomeMode === "join"
                    ? "Join your table"
                    : "Sign in to your table"}
                <Icon name="arrow" />
              </button>
              <p className="setup-note">
                This device remembers your place at the table.
                <br />
                On iPad, open the Home Screen app before signing in.
              </p>
              {pauseNotice()}
              {notice && (
                <p className="notice error" role="alert">
                  {notice}
                </p>
              )}
            </form>
            <AppVersion />
          </main>
        ) : !game ? (
          <main className="welcome">
            <TeaMark large />
            <h1>Your table is being set.</h1>
            <p>
              {notice ||
                "Waiting for the saved match. Your administrator can finish setting up the pair."}
            </p>
            {pauseNotice()}
          </main>
        ) : (
          <>
            <main className={`game-layout ${zoomed ? "zoomed" : ""}`}>
              <section
                className="play-area"
                aria-label="Game board and your tiles"
              >
                <div className="board-caption">
                  <div className="board-tools">
                    <span>
                      {zoomed
                        ? "Scroll to look around"
                        : `${game.bagCount} tiles in the bag`}
                    </span>
                    <button
                      className="board-zoom-button"
                      hidden={!zoomed}
                      data-testid={zoomed ? "whole-board" : "zoom-board"}
                      disabled={!!drag || !!settling}
                      onClick={() => setZoomed(!zoomed)}
                    >
                      {zoomed ? "Whole board" : "Zoom board"}
                    </button>
                  </div>
                </div>
                <div className="board-frame">
                  <div
                    className={`board-viewport ${drag ? "tile-dragging" : ""}`}
                    data-testid="board-viewport"
                    ref={boardViewport}
                    tabIndex={zoomed ? 0 : undefined}
                    aria-label={
                      zoomed
                        ? "Zoomed board. Scroll or use arrow keys to look around."
                        : undefined
                    }
                    onScroll={(event) => {
                      const locked = lockedBoardScroll.current;
                      if (locked) {
                        event.currentTarget.scrollLeft = locked.left;
                        event.currentTarget.scrollTop = locked.top;
                      }
                    }}
                  >
                    <div
                      className="board"
                      role="group"
                      aria-label="15 by 15 word board"
                      data-testid="game-board"
                      data-draft-error={draftErrorCode || undefined}
                      data-draft-pulse-paused={
                        !!drag || !!settling || recallAnimation.active
                      }
                    >
                      {Array.from({ length: 225 }, (_, index) => {
                        const row = Math.floor(index / 15),
                          col = index % 15,
                          key = `${row},${col}`;
                        const committed = game.board[key],
                          tentative = placements.find(
                            (p) => p.row === row && p.col === col,
                          ),
                          rackTile =
                            tentative &&
                            rack.find((t) => t.id === tentative.tileId);
                        const tile =
                          committed ||
                          (rackTile
                            ? {
                                ...rackTile,
                                letter: tentative?.letter || rackTile.letter,
                              }
                            : null);
                        const premium = premiumAt(row, col),
                          isLatest = lastCells.has(key),
                          isFresh = isLatest && freshMove === latest?.id,
                          isFading = isFresh && fadingMove === latest?.id,
                          isDraftWord = draftWordMembers.has(key);
                        const landing =
                          drag?.target?.kind === "board" &&
                          drag.target.row === row &&
                          drag.target.col === col;
                        const label = tile
                          ? `${tile.letter}, ${tile.value} points${tentative ? ", tentative" : ""}`
                          : row === 7 && col === 7
                            ? "Centre star, double word"
                            : premium
                              ? premiumNames[premium]
                              : "Empty";
                        return (
                          <button
                            key={key}
                            data-testid={`board-cell-${row}-${col}`}
                            data-drop-row={row}
                            data-drop-col={col}
                            data-draft-word={isDraftWord || undefined}
                            className={`square ${premium?.toLowerCase() || ""} ${openingBoard && !tile && row === 7 && col === 7 ? "opening-centre" : ""} ${tentative ? "has-tentative" : ""} ${committed ? "has-committed" : ""} ${selected === tentative?.tileId && tentative ? "selected-square" : ""} ${isLatest && committed ? "latest-square" : ""} ${isFading && committed ? "fresh-play-square" : ""} ${landing ? "drag-over-square" : ""}`}
                            data-latest-play={
                              isLatest && committed
                                ? isFresh
                                  ? "fresh"
                                  : "settled"
                                : undefined
                            }
                            data-highlight-phase={
                              isLatest && committed
                                ? isFading
                                  ? "fading"
                                  : isFresh
                                    ? "held"
                                    : "settled"
                                : undefined
                            }
                            aria-label={`Row ${row + 1}, column ${col + 1}: ${label}`}
                            aria-invalid={
                              tentative && draftErrorCode ? true : undefined
                            }
                            aria-describedby={
                              tentative && draftErrorCode
                                ? "draft-arrangement-error"
                                : openingBoard &&
                                    placements.length === 0 &&
                                    row === 7 &&
                                    col === 7
                                  ? "first-word-hint"
                                  : undefined
                            }
                            onClick={() => tapSquare(row, col)}
                            disabled={!canEdit || !!committed}
                          >
                            {tile ? (
                              <motion.span
                                className={`tile board-tile ${tentative ? "tentative" : ""} ${isDraftWord ? "draft-word-tile" : ""} ${tentative && draftErrorCode ? "invalid-arrangement" : ""} ${tentative && canEdit ? "draggable-tile" : ""} ${drag?.tile.id === tile.id ? "drag-source" : ""} ${settling?.tile.id === tile.id ? "settling-target" : ""} ${isLatest && committed ? "latest-play-tile" : ""} ${isFresh && committed ? "held-play-tile" : ""} ${isFading && committed ? "fresh-play-tile" : ""}`}
                                key={tile.id}
                                onPointerDown={
                                  tentative
                                    ? (event) => startDrag(event, tile)
                                    : undefined
                                }
                                onDragStart={(event) => event.preventDefault()}
                                initial={
                                  tentative && settling?.tile.id !== tile.id
                                    ? { scale: 0.86, y: -5 }
                                    : false
                                }
                                animate={{
                                  scale: 1,
                                  y: selected === tile.id ? -3 : 0,
                                }}
                                whileHover={
                                  tentative && canEdit && finePointer && !drag
                                    ? {
                                        boxShadow:
                                          "inset 0 0 0 2px var(--tile-hover, #7a8b63), 0 3px 5px #514d3529",
                                      }
                                    : undefined
                                }
                                transition={{
                                  type: "spring",
                                  stiffness: 450,
                                  damping: 23,
                                }}
                              >
                                {isDraftWord && (
                                  <span
                                    key={draftPulseKey}
                                    className="draft-word-pulse"
                                    data-testid="draft-word-pulse"
                                    aria-hidden="true"
                                  />
                                )}
                                <TileLetter letter={tile.letter} />
                                <small>{tile.value}</small>
                                {tile.value === 0 && (
                                  <i className="blank-mark" />
                                )}
                              </motion.span>
                            ) : row === 7 && col === 7 ? (
                              <svg
                                className="centre-star"
                                viewBox="0 0 24 24"
                                aria-hidden="true"
                              >
                                <path d="m12 2.5 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9Z" />
                              </svg>
                            ) : premium ? (
                              <span className="premium-label">{premium}</span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <AnimatePresence
                    onExitComplete={() => {
                      if (
                        game?.status === "finished" &&
                        freshMove === game.lastMove?.id
                      )
                        setFadingMove(freshMove);
                    }}
                  >
                    {animatedMove && latest?.kind === "play" && (
                      <motion.div
                        key={animatedMove}
                        className="floating-points"
                        style={{ left: "50%", top: "50%" }}
                        initial={{
                          opacity: 0,
                          x: "-50%",
                          y: "-50%",
                          scale: reduced ? 1 : 0.85,
                        }}
                        animate={{
                          opacity: 1,
                          x: "-50%",
                          y: "-50%",
                          scale: 1,
                        }}
                        transition={{ duration: reduced ? 0 : 0.25 }}
                        exit={{
                          opacity: 0,
                          transition: { duration: reduced ? 0 : 0.16 },
                        }}
                      >
                        <Celebration
                          score={latest.score}
                          bingo={latest.placements.length === 7}
                          variant={game.revision}
                          move={latest}
                          onComplete={() => finishScoreCelebration(latest.id)}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                  {turnAnnouncement &&
                    !turnAnnouncementBlocked &&
                    game.status === "active" &&
                    turnAnnouncement.gameId === game.id &&
                    turnAnnouncement.turn === game.turn && (
                      <div
                        className="turn-announcement-layer"
                        data-testid="turn-announcement"
                        data-turn={turnAnnouncement.turn}
                        data-game-id={turnAnnouncement.gameId}
                        data-debug={turnAnnouncement.debug || undefined}
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                      >
                        <TurnAnnouncement
                          key={turnAnnouncement.id}
                          name={names[turnAnnouncement.turn]}
                          debug={turnAnnouncement.debug}
                          onComplete={() =>
                            setTurnAnnouncement((current) =>
                              current?.id === turnAnnouncement.id
                                ? null
                                : current,
                            )
                          }
                        />
                      </div>
                    )}
                </div>
                <div className="hand-row">
                  <div
                    className={`rack ${!visibleRack.length ? "empty-rack" : ""} ${drag?.target?.kind === "rack" ? "drag-over-rack" : ""}`}
                    aria-label="Your tile rack"
                    data-testid="tile-rack"
                    data-drop-rack="true"
                    data-rack-insertion-index={rackPreview?.insertionIndex}
                  >
                    {(visibleRack.length > 0 || reserveRackReturn) && (
                      <div
                        className="rack-tiles"
                        data-testid="rack-tiles"
                        data-centering-count={centeredRackCount.current}
                        style={
                          {
                            "--rack-centered-count": Math.max(
                              1,
                              centeredRackCount.current,
                            ),
                          } as CSSProperties
                        }
                      >
                        {visibleRack.map((tile, originalIndex) => {
                          const remainingIndex =
                            rackPreview?.tileIds.indexOf(tile.id) ?? -1;
                          const previewIndex =
                            remainingIndex < 0
                              ? originalIndex
                              : remainingIndex +
                                (remainingIndex >= rackPreview!.insertionIndex
                                  ? 1
                                  : 0);
                          const rackOffset = rackPreview
                            ? (previewIndex - originalIndex) *
                              rackPreview.slotPitch
                            : 0;
                          return (
                            <div
                              className="rack-slot"
                              data-rack-tile-id={tile.id}
                              key={tile.id}
                            >
                              {rackPreview?.insertionIndex ===
                                originalIndex && (
                                <span
                                  className="rack-insertion-preview"
                                  data-testid="rack-insertion-preview"
                                  aria-hidden="true"
                                />
                              )}
                              <motion.div
                                className="rack-visual"
                                layout={
                                  !reduced &&
                                  settling?.tile.id !== tile.id &&
                                  !recallAnimation.hiddenIds.has(tile.id)
                                    ? "position"
                                    : false
                                }
                                initial={false}
                                animate={{
                                  x: rackOffset,
                                  opacity:
                                    rackPreview && drag?.tile.id === tile.id
                                      ? 0
                                      : 1,
                                }}
                                transition={{
                                  x: {
                                    duration: reduced || settling ? 0 : 0.16,
                                    ease: [0.2, 0.8, 0.2, 1],
                                  },
                                  opacity: { duration: 0 },
                                  layout: { duration: reduced ? 0 : 0.24 },
                                }}
                              >
                                <motion.button
                                  data-testid={`rack-tile-${tile.id}`}
                                  className={`tile rack-tile ${canEdit ? "draggable-tile" : ""} ${drag?.tile.id === tile.id ? "drag-source" : ""} ${settling?.tile.id === tile.id ? "settling-target" : ""} ${recallAnimation.hiddenIds.has(tile.id) ? "recall-target" : ""} ${selected === tile.id ? "selected-tile" : ""}`}
                                  aria-label={`${tile.letter === "?" ? "Blank" : tile.letter}, ${tile.value} points`}
                                  aria-pressed={selected === tile.id}
                                  disabled={!canEdit}
                                  onPointerDown={(event) =>
                                    startDrag(event, tile)
                                  }
                                  onDragStart={(event) =>
                                    event.preventDefault()
                                  }
                                  onKeyDown={(event) => {
                                    if (
                                      !canEdit ||
                                      !!drag ||
                                      !!settling ||
                                      !event.altKey ||
                                      !["ArrowLeft", "ArrowRight"].includes(
                                        event.key,
                                      )
                                    )
                                      return;
                                    event.preventDefault();
                                    const index = visibleRack.findIndex(
                                      (t) => t.id === tile.id,
                                    );
                                    const destination =
                                      index +
                                      (event.key === "ArrowLeft" ? -1 : 1);
                                    if (
                                      destination < 0 ||
                                      destination >= visibleRack.length
                                    )
                                      return;
                                    reorderRack(
                                      tile.id,
                                      visibleRack[
                                        destination +
                                          (event.key === "ArrowRight" ? 1 : 0)
                                      ]?.id,
                                    );
                                    tick();
                                  }}
                                  onClick={() => {
                                    setSelected(
                                      selected === tile.id ? null : tile.id,
                                    );
                                    setMessage("");
                                    tick();
                                  }}
                                  initial={
                                    settling?.tile.id === tile.id ||
                                    recallAnimation.hiddenIds.has(tile.id)
                                      ? false
                                      : { opacity: 0, y: 10 }
                                  }
                                  animate={{
                                    opacity: 1,
                                    y: selected === tile.id ? -7 : 0,
                                    rotate: selected === tile.id ? -2 : 0,
                                  }}
                                  whileHover={
                                    canEdit && finePointer && !drag
                                      ? {
                                          boxShadow:
                                            "inset 0 0 0 2px var(--tile-hover, #7a8b63), 0 5px 8px #514d3529",
                                        }
                                      : undefined
                                  }
                                  exit={{ opacity: 0 }}
                                  transition={{
                                    type: "spring",
                                    stiffness: 430,
                                    damping: 24,
                                  }}
                                >
                                  <TileLetter letter={tile.letter} />
                                  <small>{tile.value}</small>
                                </motion.button>
                              </motion.div>
                            </div>
                          );
                        })}
                        {reserveRackReturn && (
                          <div
                            className="rack-slot rack-preview-spacer"
                            data-testid="rack-preview-gap"
                            aria-hidden="true"
                          >
                            {rackPreview?.insertionIndex ===
                              visibleRack.length && (
                              <span
                                className="rack-insertion-preview"
                                data-testid="rack-insertion-preview"
                              />
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {!visibleRack.length && !reserveRackReturn && (
                      <span className="empty-rack-hint">
                        {game.status === "finished"
                          ? "Hand empty"
                          : "Return tiles here"}
                      </span>
                    )}
                  </div>
                  <button
                    className="hand-action-button"
                    data-testid="recall-tiles"
                    aria-label="Recall tiles"
                    title="Recall tiles"
                    disabled={
                      !canEdit || !placements.length || !!drag || !!settling
                    }
                    onClick={recallTiles}
                  >
                    <Icon name="recall" />
                    <span>Recall</span>
                  </button>
                  <button
                    onClick={shuffle}
                    className="hand-action-button shuffle-button"
                    data-testid="shuffle-rack"
                    aria-label="Shuffle your tiles"
                    title="Shuffle your tiles"
                    disabled={
                      !canEdit || visibleRack.length < 2 || !!drag || !!settling
                    }
                  >
                    <Icon name="shuffle" />
                    <span>Shuffle</span>
                  </button>
                </div>
                <p className="rack-hint" data-testid="rack-hint">
                  {recallAnimation.active
                    ? "Returning your tiles…"
                    : drag
                      ? "Drop on an empty square or back in your hand."
                      : selected
                        ? placements.some((p) => p.tileId === selected)
                          ? "Choose a square, or tap the tile again to return it."
                          : "Tap an empty square."
                        : canEdit
                          ? placements.length
                            ? "Keep arranging your word."
                            : "Tap or drag a tile to begin."
                          : "Your tiles are saved here."}
                </p>
              </section>

              <aside className="game-sidebar">
                {compactTable && appHeader}
                <section className="scoreboard" aria-label="Scores">
                  {(["mom", "aunt"] as Slot[]).map((player) => (
                    <div
                      key={player}
                      className={`player-score ${game.turn === player && game.status === "active" ? "current-player" : ""}`}
                    >
                      <div className={`avatar ${player}`} aria-hidden="true">
                        {names[player].slice(0, 1)}
                      </div>
                      <div className="player-details">
                        <span>
                          {names[player]}
                          {player !== slot &&
                            session.presenceStatus[player] !== "unknown" && (
                              <small
                                className={`player-presence ${session.presenceStatus[player]}`}
                                data-testid={`player-presence-${player}`}
                                data-state={session.presenceStatus[player]}
                                aria-label={`${names[player]}: ${session.presenceStatus[player] === "present" ? "at the table" : session.presenceStatus[player] === "away" ? "away" : "presence status unknown"}`}
                              >
                                <i aria-hidden="true" />
                                {session.presenceStatus[player] === "present"
                                  ? "At the table"
                                  : session.presenceStatus[player] === "away"
                                    ? "Away"
                                    : "Status unknown"}
                              </small>
                            )}
                        </span>
                        <span className="player-caption">
                          {game.status === "finished"
                            ? "Final score"
                            : game.turn === player
                              ? player === slot
                                ? "Your turn"
                                : "Their turn"
                              : `${game.rackCounts[player]} tiles on the rack`}
                        </span>
                      </div>
                      <Score value={game.scores[player]} player={player} />
                    </div>
                  ))}
                </section>
                <section
                  className={`turn-card ${yourTurn ? "your-turn" : ""}`}
                  aria-label="Turn controls"
                >
                  <div className="turn-heading">
                    <span
                      className={`status-dot ${pending || !connected ? "pulsing" : ""}`}
                    />
                    <h1 data-testid="turn-status">{status}</h1>
                  </div>
                  {game.status === "active" && activeMode !== "classic" && (
                    <div
                      className={`mode-progress ${activeMode === "timed" ? "timed-progress" : ""}`}
                      data-testid="mode-progress"
                    >
                      <span>
                        {activeMode === "timed"
                          ? "Timed game"
                          : gameModes[activeMode].title}
                        {activeMode === "turn-limit"
                          ? ` · ${Math.min(game.turnsPlayed || 0, 20)} of 20 turns played`
                          : activeMode === "target-score"
                            ? " · target 150 points"
                            : ""}
                      </span>
                      {activeMode === "timed" && (
                        <span
                          className={`game-timer ${timedExpired ? "time-up" : ""}`}
                          role="timer"
                          aria-label="Time remaining"
                          aria-live="off"
                          data-testid="game-timer"
                          data-seconds-remaining={
                            session.timedClockReady
                              ? secondsRemaining
                              : undefined
                          }
                        >
                          {!session.timedClockReady
                            ? connected
                              ? "Checking time…"
                              : "Reconnect to check time"
                            : timedExpired
                              ? "Time is up"
                              : timerText}
                        </span>
                      )}
                    </div>
                  )}
                  <p className="turn-description">
                    {pending
                      ? "Please keep this move here until it is confirmed."
                      : game.status === "finished"
                        ? game.endedReason === "new-game"
                          ? "A fresh board is on its way."
                          : "Your final scores are saved. Take a look back over the board."
                        : !connected
                          ? "Your draft is saved here. We’ll reconnect to your game."
                          : yourTurn
                            ? "There’s a good word in there somewhere."
                            : `Prepare a private draft while ${partnerName} plays. Only you can see these tiles.`}
                  </p>
                  {openingBoard && placements.length === 0 && (
                    <p
                      className={`first-word-hint ${centreCovered ? "centre-covered" : ""}`}
                      id="first-word-hint"
                      data-testid="first-word-hint"
                      data-state={centreCovered ? "covered" : "required"}
                      role="status"
                    >
                      <span aria-hidden="true">
                        {centreCovered ? "✓" : "★"}
                      </span>
                      {centreCovered
                        ? "Centre star covered."
                        : "Your first word must cover the centre star."}
                    </p>
                  )}
                  {game.status === "finished" ? (
                    game.endedReason !== "new-game" && (
                      <button
                        className="secondary-button result-reopen"
                        onClick={() =>
                          setQueuedResult({
                            gameId: game.id,
                            readyAt: Date.now(),
                          })
                        }
                        data-testid="view-result"
                      >
                        View final result
                      </button>
                    )
                  ) : (
                    <>
                      {placements.length > 0 && (
                        <div
                          className={`move-preview has-preview ${previewError ? "invalid-preview" : `dictionary-${wordCheckState}`}`}
                          data-testid="move-preview"
                          aria-live="polite"
                        >
                          <div>
                            <span className="eyebrow">
                              {yourTurn ? "YOUR WORD" : "PRIVATE DRAFT"}
                            </span>
                            <strong>
                              {preview
                                ? preview.words.join(" · ")
                                : "Adjust your word"}
                            </strong>
                            {previewError && (
                              <p
                                className="preview-note arrangement-error"
                                id="draft-arrangement-error"
                                data-testid="draft-arrangement-error"
                              >
                                {previewError}
                              </p>
                            )}
                          </div>
                          {preview && (
                            <span className="preview-score">
                              {preview.score}
                              <small>points</small>
                            </span>
                          )}
                        </div>
                      )}
                      {preview && (
                        <div
                          className={`word-check ${wordCheckState}`}
                          data-testid="word-check"
                          data-state={wordCheckState}
                          role="status"
                          aria-live="polite"
                        >
                          <span>
                            {wordCheckState === "recognized"
                              ? connected
                                ? "Words recognized"
                                : "Words recognized · saved dictionary"
                              : wordCheckState === "unrecognized"
                                ? `Not recognized: ${unknownWords.join(", ")}${!connected ? " · saved dictionary" : ""}`
                                : wordCheckState === "checking"
                                  ? "Checking words…"
                                  : "Word check unavailable"}
                          </span>
                          {wordCheckState === "unrecognized" && (
                            <button
                              className="word-check-action"
                              data-testid="ask-about-word"
                              disabled={!canUseDictionary}
                              onClick={() => showDictionary(unknownWords)}
                            >
                              Ask to add{" "}
                              {unknownWords.length === 1 ? "word" : "words"}
                            </button>
                          )}
                          {wordDictionary.error && (
                            <button
                              className="word-check-action"
                              disabled={!connected}
                              onClick={wordDictionary.retry}
                            >
                              Retry word check
                            </button>
                          )}
                        </div>
                      )}
                      <button
                        className="primary-button play-button"
                        data-testid="play-word"
                        disabled={!canSubmit || !connected || !preview}
                        onClick={() => void send("play")}
                      >
                        {busy
                          ? "Saving…"
                          : yourTurn
                            ? "Play word"
                            : `Wait for ${partnerName}`}
                        {preview ? (
                          <span className="button-score">+{preview.score}</span>
                        ) : (
                          <Icon name="arrow" />
                        )}
                      </button>
                      <div className="quiet-actions">
                        <button
                          className={`secondary-button ${game.bagCount === 0 ? "end-game-button" : ""}`}
                          data-testid={
                            game.bagCount === 0
                              ? "request-end-game"
                              : "exchange-tiles"
                          }
                          disabled={
                            game.bagCount === 0
                              ? !canUseEndGame || !!currentEndRequest
                              : !canSubmit || !connected || game.bagCount < 7
                          }
                          aria-describedby={
                            exchangeReason ? "turn-actions-note" : undefined
                          }
                          onClick={() => {
                            if (game.bagCount === 0) {
                              endGameAttempt.current = null;
                              setEndGameError("");
                              setDialog("end-game");
                            } else {
                              setExchange([]);
                              setDialog("exchange");
                            }
                          }}
                        >
                          {game.bagCount === 0 ? "END GAME" : "Exchange tiles"}
                        </button>
                        <button
                          className="secondary-button"
                          data-testid="pass-turn"
                          disabled={!canSubmit || !connected}
                          aria-describedby={
                            turnActionReason ? "turn-actions-note" : undefined
                          }
                          onClick={() => setDialog("pass")}
                        >
                          {game.scorelessTurns === 5 || passReachesTurnLimit
                            ? "Pass & end game"
                            : "Pass turn"}
                        </button>
                      </div>
                      {(currentEndRequest ||
                        latestEndRequest?.status === "declined") && (
                        <p
                          className="end-request-status"
                          data-testid="end-game-request-status"
                          role="status"
                        >
                          {currentEndRequest
                            ? currentEndRequest.requestedBy === slot
                              ? `Waiting for ${partnerName} to decide whether to end the game.`
                              : `${partnerName} has asked to end this game.`
                            : `${partnerName} chose to keep playing.`}
                        </p>
                      )}
                      {game.scorelessTurns >= 4 && !passReachesTurnLimit && (
                        <p
                          className="scoreless-notice"
                          data-testid="scoreless-notice"
                        >
                          {game.scorelessTurns === 5
                            ? "One more scoreless turn ends this game."
                            : "Two more turns without points end this game. A scoring play resets the count."}
                        </p>
                      )}
                      {exchangeReason && (
                        <p
                          className="exchange-note"
                          id="turn-actions-note"
                          data-testid="turn-actions-note"
                        >
                          {exchangeReason}
                        </p>
                      )}
                    </>
                  )}
                  {(waitingForNewGame || currentGameRequest) && (
                    <section
                      className="new-game-control"
                      aria-label="New game request"
                    >
                      <p
                        className="new-game-note"
                        data-testid="new-game-status"
                      >
                        {waitingForNewGame
                          ? `Waiting for ${partnerName} to agree to a new game. You can keep playing this one.`
                          : `${names[currentGameRequest!.requestedBy]} asked to start a new game.`}
                      </p>
                    </section>
                  )}
                  {!!pending && !busy && (
                    <button
                      className="secondary-button retry-button"
                      onClick={() => void retry()}
                      disabled={!connected || sharedActionsPaused}
                      data-testid="retry-pending"
                    >
                      Check & retry saved move
                    </button>
                  )}
                  {pauseNotice()}
                  {notice && (
                    <div
                      className="notice error"
                      role="alert"
                      data-testid="game-notice"
                    >
                      {notice}
                    </div>
                  )}
                </section>
                {currentWordRequests.length > 0 &&
                  dialog !== "word-requests" && (
                    <section
                      className="word-requests"
                      aria-label="Your shared dictionary"
                    >
                      <h2>Your shared dictionary</h2>
                      {wordRequests()}
                    </section>
                  )}
                {latest && (
                  <section className="last-move" aria-label="Last turn">
                    <span className="eyebrow">LAST TIME AT THE TABLE</span>
                    <p>
                      {latest.kind === "play" ? (
                        <>
                          <strong>{names[latest.player]}</strong> played{" "}
                          <strong className="word-name">
                            {latest.words.join(" / ")}
                          </strong>
                          <span className="last-points">+{latest.score}</span>
                        </>
                      ) : latest.kind === "exchange" ? (
                        <>
                          <strong>{names[latest.player]}</strong> exchanged
                          tiles.
                        </>
                      ) : latest.kind === "pass" ? (
                        <>
                          <strong>{names[latest.player]}</strong> passed their
                          turn.
                        </>
                      ) : (
                        "A new game together."
                      )}
                    </p>
                    {latest.kind === "play" && (
                      <>
                        <button
                          className="secondary-button score-details-button"
                          data-testid="score-details"
                          onClick={() => setDialog("score-details")}
                        >
                          Score details
                        </button>
                      </>
                    )}
                  </section>
                )}
                <div
                  className="facetime-space"
                  data-testid="facetime-space"
                  role="region"
                  aria-label="Reserved space for your FaceTime window"
                />
              </aside>
            </main>
          </>
        )}

        {drag && (
          <motion.div
            className={`tile drag-ghost ${drag.target ? "valid-drop" : "invalid-drop"}`}
            data-testid="drag-ghost"
            aria-hidden="true"
            style={{
              left: 0,
              top: 0,
              x: dragX,
              y: dragY,
              width: drag.width,
              height: drag.height,
            }}
          >
            <TileLetter letter={drag.tile.letter} />
            <small>{drag.tile.value}</small>
          </motion.div>
        )}
        {settling && (
          <motion.div
            key={settling.id}
            className="tile drag-ghost settling-ghost"
            data-testid="settling-ghost"
            data-phase={
              settling.outcome === "placed" ? "settling" : "returning"
            }
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
            transition={{
              duration: settling.duration,
              ease: [0.2, 0.8, 0.2, 1],
            }}
            onAnimationComplete={() => finishSettling(settling.id)}
          >
            <TileLetter letter={settling.tile.letter} />
            <small>{settling.tile.value}</small>
          </motion.div>
        )}
        {recallAnimation.flights.map((flight) => (
          <motion.div
            key={`${recallAnimation.id}:${flight.tile.id}`}
            className="tile drag-ghost settling-ghost recall-ghost"
            data-testid="recall-ghost"
            data-tile-id={flight.tile.id}
            data-phase="returning"
            data-from={JSON.stringify(flight.from)}
            data-to={JSON.stringify(flight.to)}
            data-from-x={flight.from.x}
            data-from-y={flight.from.y}
            data-from-width={flight.from.width}
            data-from-height={flight.from.height}
            data-to-x={flight.to.x}
            data-to-y={flight.to.y}
            data-to-width={flight.to.width}
            data-to-height={flight.to.height}
            aria-hidden="true"
            initial={{
              left: flight.from.x,
              top: flight.from.y,
              width: flight.from.width,
              height: flight.from.height,
            }}
            animate={{
              left: flight.to.x,
              top: flight.to.y,
              width: flight.to.width,
              height: flight.to.height,
            }}
            transition={{
              duration: 0.35,
              delay: flight.delay,
              ease: [0.2, 0.8, 0.2, 1],
            }}
            onAnimationComplete={() =>
              recallAnimation.finish(recallAnimation.id!, flight.tile.id)
            }
          >
            <TileLetter letter={flight.tile.letter} />
            <small>{flight.tile.value}</small>
          </motion.div>
        ))}
        <AnimatePresence>
          {dialog === "result" &&
            game?.status === "finished" &&
            game.endedReason !== "new-game" && (
              <Modal
                title={resultTitle}
                testId="end-game-popup"
                close={() => {
                  if (
                    latestDialog.current !== "result" ||
                    latestGameId.current !== game.id
                  )
                    return;
                  setQueuedResult(null);
                  setDialog(null);
                }}
                footer={
                  <div className="dialog-actions">
                    <button
                      className="secondary-button"
                      data-testid="inspect-board"
                      onClick={() => {
                        if (
                          latestDialog.current !== "result" ||
                          latestGameId.current !== game.id
                        )
                          return;
                        setQueuedResult(null);
                        setDialog(null);
                      }}
                    >
                      See the board
                    </button>
                    <button
                      className="primary-button"
                      data-testid="rematch"
                      disabled={
                        !canUseNewGame ||
                        !!currentGameRequest ||
                        waitingForNewGame
                      }
                      onClick={() => {
                        if (
                          latestDialog.current !== "result" ||
                          latestGameId.current !== game.id
                        )
                          return;
                        setQueuedResult(null);
                        setNewGameError("");
                        setDialog("new-game");
                      }}
                    >
                      Play a new game?
                      <Icon name="arrow" />
                    </button>
                  </div>
                }
              >
                <div className="end-game-result" data-testid="game-result">
                  <motion.svg
                    className="result-fanfare"
                    viewBox="0 0 180 80"
                    fill="none"
                    aria-hidden="true"
                    initial={{
                      opacity: 0,
                      scale: reduced ? 1 : 0.82,
                      rotate: reduced ? 0 : -8,
                    }}
                    animate={{ opacity: 1, scale: 1, rotate: 0 }}
                    transition={{
                      duration: reduced ? 0 : 0.65,
                      ease: [0.2, 0.8, 0.2, 1],
                    }}
                  >
                    <path
                      d="M90 9v62M59 40h62M68 18l44 44M68 62l44-44"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <path
                      d="M34 31v18M25 40h18M146 31v18M137 40h18"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                    <circle cx="52" cy="18" r="2" fill="currentColor" />
                    <circle cx="128" cy="62" r="2" fill="currentColor" />
                  </motion.svg>
                  <p className="result-kicker">A game well played, together.</p>
                  <div className="final-scores">
                    {(["mom", "aunt"] as Slot[]).map((player) => (
                      <div
                        key={player}
                        className={`final-score ${game.winner === player ? "winner" : ""}`}
                      >
                        <span>{names[player]}</span>
                        <strong data-testid={`result-score-${player}`}>
                          {game.scores[player]}
                        </strong>
                        <small>points</small>
                      </div>
                    ))}
                  </div>
                  <p
                    className="game-ending-reason"
                    data-testid="game-ending-reason"
                  >
                    {endingDescription}
                  </p>
                </div>
                <GameSummary game={game} names={names} />
                {(waitingForNewGame || currentGameRequest) && (
                  <p className="dictionary-reassurance">
                    Waiting for {partnerName} to agree to a new game.
                  </p>
                )}
                {sharedActionsPaused
                  ? pauseNotice(true)
                  : newGameUnavailable && (
                      <p className="turn-action-reason" role="status">
                        {newGameUnavailable}
                      </p>
                    )}
              </Modal>
            )}
          {(dialog === "end-game" ||
            (dialog === "incoming-end-game" && incomingEndRequest)) && (
            <Modal
              title="Finish this game together?"
              testId={
                dialog === "incoming-end-game"
                  ? "incoming-end-game-popup"
                  : "end-game-request-popup"
              }
              dismissible={dialog !== "incoming-end-game"}
              close={() => setDialog(null)}
              footer={
                <div className="dialog-actions">
                  <button
                    className="secondary-button"
                    data-testid={
                      dialog === "incoming-end-game"
                        ? "decline-end-game"
                        : "cancel-end-game"
                    }
                    disabled={dialog === "incoming-end-game" && !canUseEndGame}
                    onClick={() =>
                      dialog === "incoming-end-game"
                        ? void respondToEndGame(false)
                        : setDialog(null)
                    }
                  >
                    Keep playing
                  </button>
                  <button
                    className="primary-button"
                    data-testid={
                      dialog === "incoming-end-game"
                        ? "approve-end-game"
                        : "confirm-end-game-request"
                    }
                    disabled={
                      !canUseEndGame ||
                      (dialog === "end-game" && !!currentEndRequest)
                    }
                    onClick={() =>
                      dialog === "incoming-end-game"
                        ? void respondToEndGame(true)
                        : void requestEndGame()
                    }
                  >
                    {endGameBusy
                      ? "Saving…"
                      : dialog === "incoming-end-game"
                        ? "Agree & end game"
                        : `Ask ${partnerName}`}
                  </button>
                </div>
              }
            >
              <p>
                {dialog === "incoming-end-game"
                  ? `${partnerName} would like to finish this game.`
                  : "The bag is empty. You can finish now if you both agree, or keep playing your remaining tiles."}
              </p>
              <p className="new-game-warning">
                Each player’s remaining tile values will be deducted from their
                own score. The highest final score wins. No tiles are
                transferred.
              </p>
              {sharedActionsPaused
                ? pauseNotice(true)
                : endGameUnavailable && (
                    <p role="status">{endGameUnavailable}</p>
                  )}
              {endGameError && !sharedActionsPaused && (
                <p className="word-request-error" role="alert">
                  {endGameError}
                </p>
              )}
            </Modal>
          )}
          {dialog === "debug-result" && (
            <Modal
              title="End-game preview"
              testId="debug-end-game-popup"
              close={() => setDialog(null)}
              footer={
                <div className="dialog-actions">
                  <button
                    className="secondary-button"
                    onClick={() => setDialog("help")}
                  >
                    Back to Help
                  </button>
                  <button className="primary-button" disabled>
                    Preview only
                  </button>
                </div>
              }
            >
              <p className="dictionary-reassurance">
                Sample scores only. This preview does not change your game.
              </p>
              <div className="final-scores">
                {(["mom", "aunt"] as const).map((player) => (
                  <div className="final-score" key={player}>
                    <span>{names[player]}</span>
                    <strong>{previewSummary.scores[player]}</strong>
                    <small>points</small>
                  </div>
                ))}
              </div>
              <p>
                You both agreed to finish with the bag empty. Remaining tile
                values were deducted.
              </p>
              <GameSummary game={previewSummary} names={names} />
            </Modal>
          )}
          {dialog === "new-game" && (
            <Modal
              title="Start a new game together?"
              testId="new-game-popup"
              close={() => setDialog(null)}
              footer={
                <div className="dialog-actions">
                  <button
                    className="secondary-button"
                    onClick={() => setDialog(null)}
                  >
                    Keep this game
                  </button>
                  <button
                    className="primary-button"
                    data-testid="request-new-game"
                    disabled={
                      !canUseNewGame ||
                      !!currentGameRequest ||
                      waitingForNewGame ||
                      (newGameMode === "timed" && !validDuration)
                    }
                    onClick={() => void requestNewGame()}
                  >
                    {newGameBusy ? "Sending…" : "Ask to start new game"}
                  </button>
                </div>
              }
            >
              <p>
                Ask {partnerName} to start a new game. Nothing changes until you
                both agree.
              </p>
              <fieldset
                className="game-mode-options"
                disabled={
                  newGameBusy ||
                  uncertainGameRequest ||
                  !!currentGameRequest ||
                  waitingForNewGame
                }
              >
                <legend>Choose your game</legend>
                {(Object.keys(gameModes) as WinCondition[]).map((mode) => (
                  <label
                    className={`choice-card ${newGameMode === mode ? "chosen" : ""}`}
                    key={mode}
                  >
                    <input
                      type="radio"
                      name="new-game-mode"
                      value={mode}
                      checked={newGameMode === mode}
                      onChange={() => setNewGameMode(mode)}
                      data-testid={`new-game-mode-${mode}`}
                    />
                    <span>
                      <strong>{gameModes[mode].title}</strong>
                      <small>{gameModes[mode].description}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              {newGameMode === "timed" && (
                <fieldset
                  className="timed-duration-field"
                  disabled={
                    newGameBusy ||
                    uncertainGameRequest ||
                    !!currentGameRequest ||
                    waitingForNewGame
                  }
                >
                  <label htmlFor="timed-duration">Minutes</label>
                  <input
                    id="timed-duration"
                    data-testid="timed-duration"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="1440"
                    step="1"
                    value={newGameMinutes}
                    onChange={(event) => setNewGameMinutes(event.target.value)}
                    aria-invalid={!validDuration}
                    aria-describedby={
                      !validDuration
                        ? "timed-duration-error"
                        : "timed-duration-note"
                    }
                  />
                  {!validDuration && (
                    <p
                      className="duration-error"
                      id="timed-duration-error"
                      data-testid="timed-duration-error"
                      role="status"
                    >
                      Choose a whole number of minutes from 1 to 1,440.
                    </p>
                  )}
                  <p id="timed-duration-note">
                    The shared clock starts when {partnerName} agrees. It keeps
                    running if you close the app. Highest score wins when time
                    is up.
                  </p>
                </fieldset>
              )}
              <p className="mode-rules-note">
                {newGameMode === "turn-limit" &&
                  "Every play, pass or exchange counts as a turn. "}
                A game can finish sooner when the bag is empty and someone uses
                their last tile, or after six turns with no points. Scores stay
                as played when a turn, point or time limit ends the game.
              </p>
              <p className="new-game-warning">
                {game?.status === "active"
                  ? "Starting fresh ends the current game and replaces the board, tiles and scores."
                  : "You’ll start with a fresh board, new tiles and scores."}{" "}
                Your shared dictionary stays.
              </p>
              {(currentGameRequest || waitingForNewGame) && (
                <p className="dictionary-reassurance">
                  A new game request is already waiting for a reply.
                </p>
              )}
              {sharedActionsPaused
                ? pauseNotice(true)
                : newGameUnavailable && (
                    <p className="turn-action-reason" role="status">
                      {newGameUnavailable}
                    </p>
                  )}
              {newGameError && !sharedActionsPaused && (
                <p className="word-request-error" role="alert">
                  {newGameError}
                </p>
              )}
            </Modal>
          )}
          {dialog === "incoming-game" && incomingNewGameRequest && (
            <Modal
              title={
                game?.status === "finished"
                  ? "Start a new game together?"
                  : "End this game and start fresh?"
              }
              testId="incoming-new-game-popup"
              dismissible={false}
              close={() => setDialog(null)}
              footer={
                <>
                  <div className="dialog-actions">
                    <button
                      className="secondary-button"
                      data-testid="decline-new-game"
                      disabled={!canUseNewGame}
                      onClick={() =>
                        void respondToNewGame(incomingNewGameRequest.id, false)
                      }
                    >
                      Keep this game
                    </button>
                    <button
                      className="primary-button"
                      data-testid="approve-new-game"
                      disabled={!canUseNewGame}
                      onClick={() =>
                        void respondToNewGame(incomingNewGameRequest.id, true)
                      }
                    >
                      {newGameBusy ? "Saving…" : "Start new game"}
                    </button>
                  </div>
                </>
              }
            >
              <p>
                {names[incomingNewGameRequest.requestedBy]} would like to start
                a new game with you.
              </p>
              <div
                className="incoming-game-mode"
                data-testid="incoming-game-mode"
              >
                <strong>
                  {incomingNewGameRequest.winCondition === "timed"
                    ? `${incomingNewGameRequest.durationMinutes || 25}-minute game`
                    : gameModes[
                        incomingNewGameRequest.winCondition || "classic"
                      ].title}
                </strong>
                <p>
                  {incomingNewGameRequest.winCondition === "timed"
                    ? "The clock starts when you agree. It keeps running if you close the app. Highest score wins when time is up."
                    : gameModes[
                        incomingNewGameRequest.winCondition || "classic"
                      ].description}
                </p>
                {(incomingNewGameRequest.winCondition || "classic") !==
                  "classic" && (
                  <small>
                    {incomingNewGameRequest.winCondition === "turn-limit"
                      ? "Plays, passes and exchanges each count as a turn. Scores stay as played after 20 turns."
                      : incomingNewGameRequest.winCondition === "timed"
                        ? "Scores stay as played when the timer ends."
                        : "Scores stay as played when someone reaches 150 points."}{" "}
                    The game can finish sooner when the bag is empty and someone
                    uses their last tile, or after six turns with no points.
                  </small>
                )}
              </div>
              <p className="new-game-warning">
                {game?.status === "active"
                  ? "Starting fresh ends the current game and replaces the board, tiles and scores."
                  : "You’ll start with a fresh board, new tiles and scores."}{" "}
                Your shared dictionary stays.
              </p>
              {sharedActionsPaused
                ? pauseNotice(true)
                : newGameUnavailable && (
                    <p className="turn-action-reason" role="status">
                      {newGameUnavailable}
                    </p>
                  )}
              {newGameError && !sharedActionsPaused && (
                <p className="word-request-error" role="alert">
                  {newGameError}
                </p>
              )}
            </Modal>
          )}
          {dialog === "incoming-word" && incomingWordRequest && (
            <Modal
              title={`Add ${incomingWordRequest.word} to your dictionary?`}
              testId="incoming-word-popup"
              dismissible={false}
              close={() => setDialog(null)}
            >
              <article
                data-testid={`incoming-word-request-${incomingWordRequest.id}`}
                data-state="pending"
              >
                <p>
                  {names[incomingWordRequest.requestedBy]} would like to play{" "}
                  <strong>{incomingWordRequest.word}</strong>. Add it so you can
                  both use it in this and future games?
                </p>
                <p className="dictionary-reassurance">
                  Your tiles stay where you left them. Adding a word does not
                  play a turn.
                </p>
                {pauseNotice(true)}
                {wordError && !sharedActionsPaused && (
                  <p className="word-request-error" role="alert">
                    {wordError}
                  </p>
                )}
                {!connected && (
                  <p className="word-request-error" role="status">
                    Reconnect to add or decline this word. Your draft stays
                    saved.
                  </p>
                )}
                {connected && !session.dictionaryReady && (
                  <p className="dictionary-reassurance" role="status">
                    {session.dictionaryError ||
                      "Checking your shared dictionary…"}
                  </p>
                )}
                {connected && (pending || busy) && (
                  <p className="dictionary-reassurance" role="status">
                    Wait for your move to finish saving before deciding.
                  </p>
                )}
                <div className="dialog-actions">
                  <button
                    className="secondary-button"
                    data-testid={`incoming-decline-word-${incomingWordRequest.id}`}
                    disabled={!canUseDictionary}
                    onClick={() =>
                      void respondToWord(
                        incomingWordRequest.id,
                        false,
                        incomingWordRequest.requestedAt,
                      )
                    }
                  >
                    Don’t add word
                  </button>
                  <button
                    className="primary-button"
                    data-testid={`incoming-approve-word-${incomingWordRequest.id}`}
                    disabled={!canUseDictionary}
                    onClick={() =>
                      void respondToWord(
                        incomingWordRequest.id,
                        true,
                        incomingWordRequest.requestedAt,
                      )
                    }
                  >
                    {wordBusy === incomingWordRequest.id
                      ? "Saving…"
                      : "Add word"}
                  </button>
                </div>
              </article>
            </Modal>
          )}
          {dialog === "dictionary" && (
            <Modal
              title="Word not recognized"
              testId="dictionary-popup"
              close={() => setDialog(null)}
            >
              <div>
                {popupWords.length ? (
                  <>
                    <p>These words aren’t in your dictionary yet:</p>
                    <ul className="dictionary-word-list">
                      {popupWords.map((word) => (
                        <li key={word}>{word}</li>
                      ))}
                    </ul>
                    <p>
                      Ask {partnerName} to add{" "}
                      {popupWords.length === 1 ? "this word" : "these words"} to
                      your shared dictionary. If they agree, you can both use{" "}
                      {popupWords.length === 1 ? "it" : "them"} in this and
                      future games.
                    </p>
                    <p className="dictionary-reassurance">
                      Your tiles stay here. You can play after approval, when
                      it’s your turn.
                    </p>
                    {requestableWords.length < popupWords.length && (
                      <p className="dictionary-reassurance">
                        A request is already waiting for a reply.
                      </p>
                    )}
                  </>
                ) : (
                  <p>
                    {dictionaryWords.length
                      ? "These words are now in your shared dictionary. Return to your tiles and play when you’re ready."
                      : "One or more words were not recognized. Keep editing your tiles to try another word."}
                  </p>
                )}
                {pauseNotice(true)}
                {wordError && !sharedActionsPaused && (
                  <p className="word-request-error" role="alert">
                    {wordError}
                  </p>
                )}
                {!connected && (
                  <p className="dictionary-reassurance">
                    Reconnect to ask {partnerName}.
                  </p>
                )}
                <div className="dialog-actions">
                  <button
                    className="secondary-button"
                    onClick={() => setDialog(null)}
                  >
                    Keep editing
                  </button>
                  {!!popupWords.length && (
                    <button
                      className="primary-button"
                      data-testid="request-word"
                      disabled={!canUseDictionary || !requestableWords.length}
                      onClick={() => void askForWords(requestableWords)}
                    >
                      {wordBusy === "request"
                        ? "Sending…"
                        : `Ask to add ${popupWords.length === 1 ? "word" : "words"}`}
                    </button>
                  )}
                </div>
              </div>
            </Modal>
          )}
          {dialog === "word-requests" && (
            <Modal title="Your shared dictionary" close={() => setDialog(null)}>
              {wordRequests("review-", true)}
            </Modal>
          )}
          {dialog === "score-details" && latest?.kind === "play" && (
            <Modal
              title={`${names[latest.player]}’s word score`}
              close={() => setDialog(null)}
              testId="score-details-popup"
            >
              <ScoreExplanation move={latest} />
            </Modal>
          )}
          {dialog === "help" && (
            <Modal title="Help & settings" close={() => setDialog(null)}>
              {game && (
                <section
                  className="table-actions"
                  aria-labelledby="table-actions-title"
                >
                  <h3 className="help-section-title" id="table-actions-title">
                    Table actions
                  </h3>
                  <div className="dialog-actions">
                    <button
                      className="secondary-button"
                      data-testid="review-words"
                      onClick={() => setDialog("word-requests")}
                    >
                      Shared words
                      {pendingWordCount ? ` (${pendingWordCount})` : ""}
                    </button>
                  </div>
                </section>
              )}

              <section className="device-settings" aria-label="This device">
                <h3 className="help-section-title">This device</h3>
                <label className="debug-toggle">
                  <input
                    type="checkbox"
                    data-testid="keep-screen-awake"
                    checked={screenAwake.enabled}
                    disabled={!screenAwake.supported}
                    onChange={(event) =>
                      void screenAwake.setEnabled(event.target.checked)
                    }
                  />{" "}
                  Keep screen awake
                </label>
                <p className="setup-note" data-testid="screen-awake-status">
                  {!screenAwake.supported
                    ? "This browser does not support keeping the screen awake."
                    : !screenAwake.enabled
                      ? "Off. Your device uses its usual screen timer."
                      : game?.status !== "active"
                        ? "This setting applies while an active game is visible."
                        : screenAwake.status ||
                          "Your device may ask for permission to keep the screen awake."}
                </p>
                <div className="dialog-actions">
                  <button
                    className="secondary-button"
                    data-testid="check-for-updates"
                    disabled={appUpdate.checking}
                    onClick={() => void appUpdate.check()}
                  >
                    {appUpdate.checking ? "Checking…" : "Check for updates"}
                  </button>
                  {appUpdate.available && (
                    <button
                      className="secondary-button"
                      data-testid="help-apply-update"
                      disabled={
                        !!pending ||
                        busy ||
                        enrolling ||
                        !!drag ||
                        !!settling ||
                        recallAnimation.active ||
                        !!wordBusy ||
                        newGameBusy ||
                        endGameBusy ||
                        hasIncomingDecision
                      }
                      onClick={() => void appUpdate.apply()}
                    >
                      Update app
                    </button>
                  )}
                </div>
                <p className="setup-note" data-testid="app-update-status">
                  {appUpdate.error || appUpdate.status}
                </p>
              </section>
              <fieldset className="theme-options">
                <legend>Your table colours</legend>
                <p>
                  Choose a look for this device. Your partner can choose their
                  own.
                </p>
                {themeChoices.map(([value, label]) => (
                  <label
                    className={`choice-card theme-choice ${theme === value ? "chosen" : ""}`}
                    key={value}
                  >
                    <input
                      type="radio"
                      name="table-theme"
                      value={value}
                      checked={theme === value}
                      onChange={() => setTheme(value)}
                      data-testid={`theme-${value}`}
                    />
                    <span
                      className={`theme-swatch swatch-${value}`}
                      aria-hidden="true"
                    >
                      <i />
                      <i />
                      <i />
                    </span>
                    <strong>{label}</strong>
                  </label>
                ))}
              </fieldset>
              <section className="debug-settings">
                <label className="debug-toggle">
                  <input
                    type="checkbox"
                    checked={debugEnabled}
                    onChange={(event) => setDebugEnabled(event.target.checked)}
                    data-testid="debug-enabled"
                  />{" "}
                  Show debug previews on this device
                </label>
                {debugEnabled && (
                  <div className="debug-panel" data-testid="debug-panel">
                    <h3>Celebration previews</h3>
                    <p>
                      Try the effects here. These sample points do not change
                      your game.
                    </p>
                    <button
                      className="secondary-button"
                      data-testid="debug-end-game"
                      onClick={() => setDialog("debug-result")}
                    >
                      Preview final results
                    </button>
                    <div className="debug-buttons">
                      {(["low", "medium", "high", "bingo"] as const).map(
                        (band) => (
                          <button
                            key={band}
                            className="secondary-button"
                            data-testid={`debug-celebration-${band}`}
                            onClick={() =>
                              setDebugCelebration({
                                band,
                                id: (debugCelebration?.id || 0) + 1,
                              })
                            }
                          >
                            {band === "bingo"
                              ? "Seven tiles"
                              : `${band[0].toUpperCase()}${band.slice(1)} score`}
                          </button>
                        ),
                      )}
                    </div>
                    <button
                      className="secondary-button"
                      data-testid="debug-turn-announcement"
                      disabled={!game || game.status !== "active"}
                      onClick={() => {
                        if (!game || game.status !== "active") return;
                        setDialog(null);
                        setQueuedTurn({
                          id: `debug-turn:${Date.now()}`,
                          gameId: game.id,
                          turn: game.turn,
                          readyAt: Date.now(),
                          afterPlay: false,
                          debug: true,
                        });
                      }}
                    >
                      Preview turn announcement
                    </button>
                    <div className="debug-celebration-stage">
                      {debugCelebration && (
                        <Celebration
                          key={debugCelebration.id}
                          debug
                          score={
                            { low: 8, medium: 24, high: 48, bingo: 76 }[
                              debugCelebration.band
                            ]
                          }
                          bingo={debugCelebration.band === "bingo"}
                          variant={debugCelebration.id}
                        />
                      )}
                    </div>
                  </div>
                )}
              </section>
              <h3 className="help-section-title">Playing together</h3>
              <ol className="help-steps">
                <li>
                  <b>Choose a tile.</b> Tap a letter in your rack.
                </li>
                <li>
                  <b>Find its place.</b> Tap an empty square. Your first word
                  crosses the centre star.
                </li>
                <li>
                  <b>Make a word.</b> Place letters in a straight line, joining
                  words already on the board.
                </li>
                <li>
                  <b>Play when you’re ready.</b> We check the words and save the
                  turn for both of you.
                </li>
              </ol>
              <p>
                To move a tentative tile, tap it and then another square. Tap it
                twice to return it to your rack. You can also drag tiles onto
                empty squares or back to the rack. <b>Recall tiles</b> brings
                them all back.
              </p>
              <p>
                Arrange your tiles on any empty squares, in any order. Red
                outlines show a draft that needs adjusting: fill its gaps, line
                up the tiles and connect the word before playing. The first word
                must cover the centre star. While waiting, your draft stays
                private until you play it on your turn.
              </p>
              <p>
                Drag a letter between letters in your hand to arrange them in
                any order, even while waiting. The outlined gap shows where it
                will go. With a keyboard, focus a rack tile and hold Alt while
                pressing the left or right arrow. Your order is saved on this
                device.
              </p>
              <p>
                A blank can be any letter and scores zero. Use all seven tiles
                in one turn for 50 extra points.
              </p>
              <section
                className="bonus-legend"
                data-testid="bonus-legend"
                aria-label="Bonus squares"
              >
                <h3 className="help-section-title">Bonus squares</h3>
                <div>
                  <span>
                    <i className="bonus-dl" /> DL · Double letter
                  </span>
                  <span>
                    <i className="bonus-tl" /> TL · Triple letter
                  </span>
                  <span>
                    <i className="bonus-dw" /> DW · Double word
                  </span>
                  <span>
                    <i className="bonus-tw" /> TW · Triple word
                  </span>
                </div>
              </section>
              <p data-testid="game-ending-help">
                In every mode, using your last tile ends the game only when the
                bag is empty; otherwise, you draw replacement tiles. Your
                partner’s remaining tile values are deducted from their score
                and added to yours.
              </p>
              <p>
                Six consecutive turns without points also end the game: six
                turns total, or three passes each if you both keep passing.
                Passes, exchanges and zero-point words count; a scoring word
                resets the count. Each player’s remaining tile values are
                deducted from their score.
              </p>
              <p>
                You can close the app and come back later. Your game is saved
                after every accepted turn. You need a connection to send a turn.
              </p>
              <p data-testid="facetime-help">
                If you use FaceTime in picture in picture, move its floating
                window into the clear area beside the game controls. That space
                is kept free so you can see each other while playing.
              </p>
              <p data-testid="presence-help">
                The dot beside your partner’s name shows whether they are at the
                table on any device. It updates about once a minute, so Away can
                take up to two minutes to appear. The indicator is hidden when
                their status cannot be checked.
              </p>
              <p>
                <b>New game</b> asks your partner to start fresh. Your current
                board stays until you both agree.
              </p>
              <p>
                Choose Classic, 10 turns each, First to 150, or a timed game. In
                ten-turn games, all 20 plays, passes or exchanges count; the
                highest score wins. Reaching a short-game limit keeps scores as
                played. The usual tile and six-scoreless-turn endings can happen
                sooner.
                {game && (
                  <>
                    {" "}
                    Your current game is <b>{gameModes[activeMode].title}</b>.
                  </>
                )}
              </p>
              <p>
                A timed game starts when your partner agrees, with 25 minutes by
                default or a duration you choose. The clock keeps running while
                the app is closed. When time is up, reconnect to confirm the
                final score; the highest score wins. In every mode, the game can
                finish sooner when the bag is empty and a player uses their last
                tile.
              </p>
              <p>
                Words use our prototype English Speller Database dictionary,
                including UK, Canadian and US spellings. It is not an official
                tournament dictionary. A word check appears beside your score as
                you arrange tiles. If a word isn’t recognized, you can ask each
                other to allow it. Words you both approve stay in your shared
                dictionary for future games.{" "}
                <a
                  className="dictionary-credits"
                  href={`${import.meta.env.BASE_URL}DICTIONARY-LICENSE.txt`}
                  target="_blank"
                  rel="noopener"
                >
                  Word list credits
                </a>
                .
              </p>
              <button
                className="primary-button"
                onClick={() => setDialog(null)}
              >
                Lovely, let’s play
                <Icon name="check" />
              </button>
              <AppVersion />
            </Modal>
          )}
          {dialog === "pass" && (
            <Modal title="Pass this turn?" close={() => setDialog(null)}>
              {game?.scorelessTurns === 5 && (
                <p
                  className="new-game-warning"
                  data-testid="pass-ending-warning"
                >
                  {passReachesTurnLimit
                    ? "Passing now completes ten turns each and ends the game. Scores stay as played; remaining tiles are not deducted."
                    : "Passing now makes six consecutive turns without points and ends the game. Each player’s remaining tile values will be deducted from their score."}
                </p>
              )}
              <p>
                {game?.scorelessTurns !== 5 && (
                  <>
                    Your tiles stay in your rack, and{" "}
                    {slot && names[other(slot)]} can play next.{" "}
                  </>
                )}
                Any tentative tiles will return to your rack.
              </p>
              {turnActionReason && (
                <p
                  className="turn-action-reason"
                  data-testid="turn-action-reason"
                  role="status"
                >
                  {turnActionReason}
                </p>
              )}
              {pauseRecovery(true)}
              <div className="dialog-actions">
                <button
                  className="secondary-button"
                  onClick={() => setDialog(null)}
                >
                  Keep thinking
                </button>
                <button
                  className="primary-button"
                  data-testid="confirm-pass"
                  disabled={!canSubmit || !connected}
                  onClick={() => void send("pass")}
                >
                  Yes, pass turn
                </button>
              </div>
            </Modal>
          )}
          {dialog === "exchange" && (
            <Modal
              title="A fresh handful of letters"
              close={() => setDialog(null)}
            >
              <p>
                Tap the tiles you’d like to swap. Exchanging uses your turn. Any
                tentative word will be recalled.
              </p>
              <div className="exchange-rack">
                {rack.map((tile) => (
                  <button
                    key={tile.id}
                    className={`tile ${exchange.includes(tile.id) ? "selected-tile" : ""}`}
                    aria-pressed={exchange.includes(tile.id)}
                    aria-label={`Exchange ${tile.letter === "?" ? "blank" : tile.letter}`}
                    onClick={() =>
                      setExchange(
                        exchange.includes(tile.id)
                          ? exchange.filter((id) => id !== tile.id)
                          : [...exchange, tile.id],
                      )
                    }
                  >
                    <TileLetter letter={tile.letter} />
                    <small>{tile.value}</small>
                  </button>
                ))}
              </div>
              {exchangeReason && (
                <p
                  className="turn-action-reason"
                  data-testid="turn-action-reason"
                  role="status"
                >
                  {exchangeReason}
                </p>
              )}
              {pauseRecovery(true)}
              <div className="dialog-actions">
                <button
                  className="secondary-button"
                  onClick={() => setDialog(null)}
                >
                  Keep my tiles
                </button>
                <button
                  className="primary-button"
                  disabled={
                    !exchange.length ||
                    !canSubmit ||
                    !connected ||
                    (game?.bagCount ?? 0) < 7
                  }
                  data-testid="confirm-exchange"
                  onClick={() => void send("exchange", exchange)}
                >
                  Exchange {exchange.length || ""}{" "}
                  {exchange.length === 1 ? "tile" : "tiles"}
                </button>
              </div>
            </Modal>
          )}
          {blank && (
            <Modal
              title="What shall this blank be?"
              close={() => setBlank(null)}
            >
              <p>
                Choose a letter. Once played, the blank keeps this letter for
                the rest of the game and scores zero points.
              </p>
              <div className="alphabet">
                {alphabet.map((letter) => (
                  <button
                    className="tile"
                    key={letter}
                    data-testid={`blank-${letter}`}
                    onClick={() => {
                      if (latestGameContext.current !== gameContext) return;
                      place(blank.tileId, blank.row, blank.col, letter);
                      setBlank(null);
                    }}
                  >
                    <TileLetter letter={letter} />
                    <small>0</small>
                  </button>
                ))}
              </div>
            </Modal>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
