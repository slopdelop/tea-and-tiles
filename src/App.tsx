import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useReducedMotion,
} from "motion/react";
import {
  previewMove,
  RuleError,
  type Command,
  type Placement,
  type Slot,
  type WinCondition,
  type MoveRecord,
  type Board,
} from "../shared/engine";
import { useGameSession } from "./firebase";
import { useTileDrag, type DragTile } from "./components/useTileDrag";
import { BOARD_CELLS, BoardCell } from "./components/BoardCell";
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
import Changelog from "./components/Changelog";
import { readSignInLink } from "./signInLink";
import { GameSummary, ScoreExplanation } from "./components/ScoreExplanation";
import {
  HANDOFF_MS,
  handoffDelay,
  boardArrivalDuration,
  movePresentationDuration,
} from "./celebrationTiming";
import { useTabletViewport } from "./hooks/useTabletViewport";
import { EndingPresentation } from "./components/EndingPresentation";
import { debugEndingGame, debugMove, debugMoveBoard } from "./debugScenarios";
import { SubmissionNotice } from "./components/SubmissionNotice";
import { useSubmissionFeedback } from "./hooks/useSubmissionFeedback";
import { DebugFrameMeter } from "./components/DebugFrameMeter";
import { DragPerformanceLab } from "./components/DragPerformanceLab";
import "./styles.css";

type Dialog =
  | "help"
  | "games"
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
  | "debug-tools"
  | "debug-performance"
  | "debug-end-request"
  | null;
type Draft = { key: string; revision: number; placements: Placement[] };
// Session-only presentation memory prevents replaying celebrations when merely
// revisiting a table. It is partitioned by project/account/table context.
const announcedTurns = new Set<string>();
const presentedResults = new Set<string>();
const dismissedResults = new Map<string, string>();

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
const EMPTY_PLACEMENTS: Placement[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_BOARD: Board = {};
const EMPTY_DRAFT_CELLS = new Map<
  string,
  { placement: Placement; tile: DragTile | null }
>();
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
let welcomeLinkConsumed = false;
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
  drawer = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  testId?: string;
  footer?: ReactNode;
  dismissible?: boolean;
  drawer?: boolean;
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
      className={`modal-backdrop ${drawer ? "drawer-backdrop" : ""}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={dismissible ? close : undefined}
    >
      <motion.div
        className={`modal ${drawer ? "games-drawer" : ""}`}
        data-testid={testId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={ref}
        initial={
          drawer ? { opacity: 0, x: 40 } : { opacity: 0, y: 15, scale: 0.97 }
        }
        animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
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
  const appUpdate = useAppUpdate();
  const openedAccounts = useRef(new Set<string>());
  const entry = useRef({ key: "", initial: false });
  const key = `${session.playerId || "welcome"}:${session.pairId || "none"}`;
  if (entry.current.key !== key) {
    const initial =
      !!session.playerId &&
      !!session.pairId &&
      !openedAccounts.current.has(session.playerId);
    if (session.playerId && session.pairId)
      openedAccounts.current.add(session.playerId);
    entry.current = { key, initial };
  }
  // Reset private presentation state when leaving an account/table. The update
  // manager stays mounted; table navigation is not a new-round boundary.
  return (
    <TableApp
      key={key}
      session={session}
      appUpdate={appUpdate}
      initialTableEntry={entry.current.initial}
    />
  );
}

function TableApp({
  session,
  appUpdate,
  initialTableEntry,
}: {
  session: ReturnType<typeof useGameSession>;
  appUpdate: ReturnType<typeof useAppUpdate>;
  initialTableEntry: boolean;
}) {
  const [welcomeDefaults] = useState(() => {
    const available = !welcomeLinkConsumed;
    return {
      invitation: available ? invitationFromLink : null,
      name: available
        ? signInFromLink?.displayName || signInFromLink?.player || ""
        : "",
      playerId: available ? signInFromLink?.player || null : null,
      code: available ? signInFromLink?.code || "" : "",
    };
  });
  useEffect(() => {
    welcomeLinkConsumed = true;
  }, []);
  const wordDictionary = useWordDictionary();
  const { game, rack, slot, names, connected, pending } = session;
  useLayoutEffect(() => {
    if (!game) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() =>
        session.noteMoveDisplayed?.(game.id, game.revision),
      );
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [game?.id, game?.revision, session.noteMoveDisplayed]);
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
  const [code, setCode] = useState(
    (welcomeDefaults.invitation || "").slice(0, 64),
  );
  const [welcomeMode, setWelcomeMode] = useState<"join" | "signin">(
    welcomeDefaults.invitation ? "join" : "signin",
  );
  const [loginPlayer, setLoginPlayer] = useState<string>(welcomeDefaults.name);
  const [passphrase, setPassphrase] = useState(welcomeDefaults.code);
  const [linkPlayerId, setLinkPlayerId] = useState(welcomeDefaults.playerId);
  const [enrolling, setEnrolling] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [arrivingMove, setArrivingMove] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [helpPage, setHelpPage] = useState<
    "root" | "play" | "settings" | "dictionary" | "about" | "debug"
  >("root");
  useEffect(() => {
    if (dialog !== "help") return;
    const frame = requestAnimationFrame(() => {
      const heading = document.querySelector<HTMLElement>(".modal h2");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [helpPage]);
  const latestDialog = useRef(dialog);
  latestDialog.current = dialog;
  const [dictionaryWords, setDictionaryWords] = useState<string[]>([]);
  const [incomingWordId, setIncomingWordId] = useState<string | null>(null);
  const promptedWordRequests = useRef(new Set<string>());
  const observedWordStatuses = useRef(new Map<string, string>());
  const [wordFeedback, setWordFeedback] = useState<Record<string, string>>({});
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(
        localStorage.getItem(`tea-tiles-word-feedback:${session.contextKey}`) ||
          "{}",
      );
      setWordFeedback(
        saved && typeof saved === "object" && !Array.isArray(saved)
          ? Object.fromEntries(
              Object.entries(saved).filter(
                ([, value]) => typeof value === "string",
              ),
            )
          : {},
      );
    } catch {
      setWordFeedback({});
    }
  }, [session.contextKey]);
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
  const houseWords = useMemo(
    () => new Set(session.houseWords.map((entry) => entry.word)),
    [session.houseWords],
  );
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
      !houseWords.has(request.word) &&
      request.status === "pending" &&
      request.requestedBy !== slot,
  );
  const [blank, setBlank] = useState<{
    tileId: string;
    row: number;
    col: number;
    replaceDraft?: boolean;
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
    () =>
      import.meta.env.DEV && localStorage.getItem("tea-tiles-debug") === "true",
  );
  const [debugWinner, setDebugWinner] = useState<Slot | "tie">("mom");
  const [debugFrameMeter, setDebugFrameMeter] = useState(false);
  const [debugExchange, setDebugExchange] = useState<
    "notice" | "handoff" | null
  >(null);
  const [debugStarter, setDebugStarter] = useState<Slot | null>(null);
  const [debugUpdating, setDebugUpdating] = useState(false);
  const [resultSeenGame, setResultSeenGameState] = useState<string | null>(
    () => dismissedResults.get(session.contextKey) || null,
  );
  const setResultSeenGame = (id: string | null) => {
    if (id) dismissedResults.set(session.contextKey, id);
    else dismissedResults.delete(session.contextKey);
    setResultSeenGameState(id);
  };
  useEffect(() => {
    setResultSeenGameState(dismissedResults.get(session.contextKey) || null);
  }, [session.contextKey]);
  const [debugEnding, setDebugEnding] = useState<ReturnType<
    typeof debugEndingGame
  > | null>(null);
  const [debugBoardMove, setDebugBoardMove] = useState<{
    move: MoveRecord;
    board: ReturnType<typeof debugMoveBoard>;
  } | null>(null);
  const [debugFinishedBoard, setDebugFinishedBoard] = useState<ReturnType<
    typeof debugEndingGame
  > | null>(null);
  const [debugSubmission, setDebugSubmission] = useState<{
    id: string;
    uncertain: boolean;
  } | null>(null);
  const [debugScoringReady, setDebugScoringReady] = useState<string | null>(
    null,
  );
  const submissionKey =
    debugSubmission?.id ||
    (pending?.kind === "play" && game?.lastMove?.id !== pending.id
      ? pending.id
      : null);
  useEffect(() => {
    if (!debugExchange) return;
    const timer = setTimeout(
      () => {
        if (debugExchange === "notice") setDebugExchange("handoff");
        else {
          setDebugExchange(null);
          setDebugStarter(slot === "mom" ? "aunt" : "mom");
        }
      },
      debugExchange === "notice" ? 1800 : HANDOFF_MS,
    );
    return () => clearTimeout(timer);
  }, [debugExchange, slot]);
  useEffect(() => {
    if (!debugUpdating) return;
    const timer = setTimeout(() => setDebugUpdating(false), 1800);
    return () => clearTimeout(timer);
  }, [debugUpdating]);
  const submissionFeedback = useSubmissionFeedback(submissionKey);
  const submissionNoticeVisible =
    submissionFeedback.visible && !dialog && !hasSubmissionDecision();
  function hasSubmissionDecision() {
    return (
      !!incomingEndRequest ||
      session.wordRequests.some(
        (request) =>
          request.status === "pending" &&
          !houseWords.has(request.word) &&
          request.requestedBy !== slot,
      ) ||
      session.newGameRequests.some(
        (request) =>
          request.gameId === game?.id &&
          request.status === "pending" &&
          request.requestedBy !== slot,
      )
    );
  }
  useEffect(() => {
    setDebugScoringReady(null);
    if (!debugBoardMove) return;
    const timer = setTimeout(
      () => setDebugScoringReady(debugBoardMove.move.id),
      boardArrivalDuration(!!reduced),
    );
    return () => clearTimeout(timer);
  }, [debugBoardMove?.move.id]);
  useEffect(() => {
    if (!debugSubmission || debugSubmission.uncertain) return;
    const timer = setTimeout(() => {
      setDebugSubmission(null);
      setDebugFinishedBoard(null);
      const move = debugMove("normal");
      setDebugBoardMove({
        move: { ...move, id: `preview:${Date.now()}` },
        board: debugMoveBoard("normal"),
      });
    }, 5000);
    return () => clearTimeout(timer);
  }, [debugSubmission?.id]);
  useEffect(() => {
    if (import.meta.env.DEV)
      localStorage.setItem("tea-tiles-debug", String(debugEnabled));
    if (!debugEnabled) {
      setDebugFrameMeter(false);
      setDebugStarter(null);
      setDebugUpdating(false);
      setDebugExchange(null);
      setDebugBoardMove(null);
      setDebugEnding(null);
      setDebugSubmission(null);
      setDebugFinishedBoard(null);
    }
  }, [debugEnabled]);
  useEffect(() => {
    setDebugBoardMove(null);
    setDebugStarter(null);
    setDebugUpdating(false);
    setDebugExchange(null);
    setDebugEnding(null);
    setDebugSubmission(null);
    setDebugFinishedBoard(null);
    setDialog((current) => (current?.startsWith("debug-") ? null : current));
  }, [game?.id, game?.revision]);
  useEffect(() => {
    if (!debugFinishedBoard) return;
    const stop = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDebugFinishedBoard(null);
    };
    window.addEventListener("keydown", stop);
    return () => window.removeEventListener("keydown", stop);
  }, [debugFinishedBoard]);
  useEffect(() => {
    if (!debugBoardMove) return;
    const stop = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDebugBoardMove(null);
    };
    window.addEventListener("keydown", stop);
    return () => window.removeEventListener("keydown", stop);
  }, [debugBoardMove]);
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
  const draftKey =
    game && slot
      ? `tea-tiles-draft:${session.contextKey}:${game.id}:${slot}`
      : "";
  const rackOrderKey = draftKey ? `${draftKey}:rack-order` : "";
  const orderedIds = rackOrder.key === rackOrderKey ? rackOrder.ids : EMPTY_IDS;
  const placements =
    game?.status === "active" && draft.key === draftKey
      ? draft.placements
      : EMPTY_PLACEMENTS;
  const rackById = useMemo(
    () => new Map(rack.map((tile) => [tile.id, tile])),
    [rack],
  );
  const draftWordMembers = useMemo(
    () => draftWordCells(game?.board ?? EMPTY_BOARD, placements),
    [game?.board, placements],
  );
  const draftPulseKey = `${game?.id}:${game?.revision}:${placements.map((p) => `${p.tileId}:${p.row}:${p.col}`).join("|")}`;
  const openingBoard =
    !debugFinishedBoard &&
    !!game &&
    game.status === "active" &&
    Object.keys(game.board).length === 0;
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
    !debugBoardMove &&
    !debugExchange &&
    !debugUpdating &&
    !appUpdate.applying &&
    !debugStarter &&
    !debugFinishedBoard &&
    !debugSubmission &&
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
    !debugBoardMove &&
    !debugExchange &&
    !debugUpdating &&
    !appUpdate.applying &&
    !debugStarter &&
    !debugFinishedBoard &&
    !debugSubmission &&
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
    dragGhostRef,
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
        canPlaceDraftTile(
          game.board,
          placements,
          { tileId, row: target.row, col: target.col },
          true,
        )
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
        setBlank({
          tileId,
          row: target.row,
          col: target.col,
          replaceDraft: true,
        });
      } else place(tileId, target.row, target.col, previous?.letter, true);
    },
  });

  // Stable cell handlers read the latest committed actions. Memoized cells
  // must not retain an earlier rack, selection or turn in an event closure.
  const boardActions = useRef({ tapSquare, startDrag });
  useLayoutEffect(() => {
    boardActions.current = { tapSquare, startDrag };
  });
  const tapBoardCell = useCallback((row: number, col: number) => {
    boardActions.current.tapSquare(row, col);
  }, []);
  const startBoardDrag = useCallback(
    (event: PointerEvent<HTMLElement>, tile: DragTile) => {
      boardActions.current.startDrag(event, tile);
    },
    [],
  );

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
          localStorage.setItem(
            `tea-tiles-word-feedback:${session.contextKey}`,
            JSON.stringify(next),
          );
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
          !houseWords.has(candidate.word) &&
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
    setArrivingMove(null);
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
      const accepted = game.lastMove;
      const arrival =
        accepted.kind === "play" ? boardArrivalDuration(!!reduced) : 0;
      setAnimatedMove(null);
      if (arrival) setArrivingMove(accepted.id);
      const reveal = setTimeout(() => {
        session.noteMovePresentation?.("scoring-start", game.id, accepted.id);
        setArrivingMove(null);
        setAnimatedMove(accepted.id);
      }, arrival);
      const timer = setTimeout(
        () => setAnimatedMove(null),
        movePresentationDuration(game.lastMove, !!reduced) + HANDOFF_MS,
      );
      return () => {
        clearTimeout(reveal);
        clearTimeout(timer);
      };
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
    const noticeKey = `${session.contextKey}:${game.id}:${game.revision}:${game.turn}`;
    if (!previous && announcedTurns.has(noticeKey)) return;
    announcedTurns.add(noticeKey);
    const afterPlay =
      previous?.gameId === game.id &&
      (game.lastMove?.kind === "play" || game.lastMove?.kind === "exchange");
    setTurnAnnouncement(null);
    setQueuedTurn({
      id: `${game.id}:${game.revision}:${game.turn}`,
      gameId: game.id,
      turn: game.turn,
      readyAt:
        Date.now() +
        (afterPlay
          ? movePresentationDuration(game.lastMove, !!reduced) + HANDOFF_MS
          : 0),
      afterPlay,
    });
  }, [game?.id, game?.turn, game?.status, slot]);

  const turnAnnouncementBlocked =
    !!dialog ||
    !!debugExchange ||
    !!debugStarter ||
    debugUpdating ||
    appUpdate.applying ||
    !!debugFinishedBoard ||
    !!debugBoardMove ||
    !!debugSubmission ||
    submissionNoticeVisible ||
    !!blank ||
    !!drag ||
    !!settling ||
    !!pending ||
    busy ||
    !!wordBusy ||
    newGameBusy;
  useEffect(() => {
    if (drag || selected) {
      // Starting to arrange tiles acknowledges this turn; never replay its banner.
      setQueuedTurn(null);
      setTurnAnnouncement(null);
      if (freshMove) setFadingMove(freshMove);
      return;
    }
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
      session.noteMovePresentation?.("turn-banner", game.id, game.lastMove?.id);
      setQueuedTurn(null);
    };
    timer = setTimeout(present, delay);
    return () => {
      clearTimeout(timer);
      clearTimeout(yieldCelebration);
    };
  }, [
    queuedTurn,
    turnAnnouncementBlocked,
    selected,
    game?.id,
    game?.turn,
    game?.status,
  ]);
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
      arrivingMove !== freshMove &&
      animatedMove !== freshMove &&
      !document.querySelector('[data-testid="move-celebration"]')
    )
      setFadingMove(freshMove);
  }, [game?.status, game?.lastMove?.id, freshMove, arrivingMove, animatedMove]);
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
    if (!previous && presentedResults.has(`${session.contextKey}:${game.id}`))
      return;
    const finalPlay =
      previous?.gameId === game.id &&
      previous.lastMoveId !== game.lastMove?.id &&
      (game.lastMove?.kind === "play" || game.lastMove?.kind === "exchange");
    setQueuedResult({
      gameId: game.id,
      readyAt:
        Date.now() +
        (finalPlay
          ? movePresentationDuration(game.lastMove, !!reduced) + HANDOFF_MS
          : 0),
    });
  }, [game?.id, game?.revision, game?.status, game?.endedReason]);

  const hasIncomingDecision =
    !!incomingEndRequest ||
    session.wordRequests.some(
      (request) =>
        request.status === "pending" &&
        !houseWords.has(request.word) &&
        request.requestedBy !== slot,
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
      presentedResults.add(`${session.contextKey}:${game.id}`);
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
  function recallTiles(tileId?: string) {
    if (!canEdit || !placements.length || drag || settling) return;
    const returning = placements.filter((p) => !tileId || p.tileId === tileId);
    if (!returning.length) return;
    const sources = returning.flatMap((placement): RecallSource[] => {
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
    edit(tileId ? placements.filter((p) => p.tileId !== tileId) : []);
    setSelected(null);
    tick();
  }
  function place(
    tileId: string,
    row: number,
    col: number,
    letter?: string,
    replaceDraft = false,
  ) {
    if (!canEdit || !game || !rack.some((t) => t.id === tileId)) return;
    if (
      !canPlaceDraftTile(
        game.board,
        placements,
        { tileId, row, col },
        replaceDraft,
      )
    ) {
      setMessage("Choose an empty square on the board.");
      return;
    }
    edit([
      ...placements.filter(
        (p) =>
          p.tileId !== tileId &&
          (!replaceDraft || p.row !== row || p.col !== col),
      ),
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
  async function retry(resume = false) {
    if (sharedActionsPaused && !resume) return;
    if (resume) session.resumeSharedActions();
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
    if (debugFinishedBoard) {
      setDebugFinishedBoard(null);
      setDialog(null);
      return;
    }
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
  const { preview, previewError, draftErrorCode } = useMemo(() => {
    let preview: ReturnType<typeof previewMove> | null = null;
    let previewError = "";
    let draftErrorCode = "";
    if (game?.board && placements.length) {
      try {
        preview = previewMove({ board: game.board }, rack, placements);
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
    return { preview, previewError, draftErrorCode };
  }, [game?.board, rack, placements]);
  const orderedRack = useMemo(
    () =>
      [...rack].sort((a, b) => {
        const ai = orderedIds.indexOf(a.id);
        const bi = orderedIds.indexOf(b.id);
        return (
          (ai < 0 ? 100 + rack.indexOf(a) : ai) -
          (bi < 0 ? 100 + rack.indexOf(b) : bi)
        );
      }),
    [rack, orderedIds],
  );
  const visibleRack = useMemo(
    () =>
      orderedRack.filter(
        (tile) => !placements.some((placement) => placement.tileId === tile.id),
      ),
    [orderedRack, placements],
  );
  // Reserve the returning tile's space once at pickup. Entering and leaving the
  // rack then keeps the tray and its logical drop positions stationary.
  const reserveRackReturn =
    !!drag && !visibleRack.some((tile) => tile.id === drag.tile.id);
  if (!drag) centeredRackCount.current = visibleRack.length;
  const latest = game?.lastMove;
  const observedUpdateGame = useRef<string | null>(null);
  const [updateBoundary, setUpdateBoundary] = useState<string | null>(null);
  const attemptedUpdateBoundary = useRef<string | null>(null);
  const updateSafety = useRef({ id: game?.id, safe: false });
  updateSafety.current = {
    id: game?.id,
    safe:
      !!game &&
      game.status === "active" &&
      game.revision === 0 &&
      Object.keys(game.board).length === 0 &&
      !!slot &&
      connected &&
      !session.loading &&
      !placements.length &&
      !selected &&
      !drag &&
      !settling &&
      !blank &&
      !pending &&
      !busy &&
      !wordBusy &&
      !newGameBusy &&
      !endGameBusy &&
      !dialog &&
      !debugBoardMove &&
      !debugFinishedBoard &&
      !debugExchange &&
      !debugUpdating &&
      !debugStarter,
  };
  useEffect(() => {
    if (!game) return;
    const previous = observedUpdateGame.current;
    observedUpdateGame.current = game.id;
    if (
      (previous && previous !== game.id) ||
      (!previous && initialTableEntry && game.revision === 0)
    )
      setUpdateBoundary(game.id);
  }, [game?.id]);
  useEffect(() => {
    if (
      !updateBoundary ||
      !appUpdate.ready ||
      appUpdate.checking ||
      appUpdate.applying ||
      attemptedUpdateBoundary.current ===
        `${updateBoundary}:${appUpdate.available}` ||
      !updateSafety.current.safe ||
      updateSafety.current.id !== updateBoundary
    )
      return;
    // A worker found/downloading after the first check gets a fresh safe attempt.
    attemptedUpdateBoundary.current = `${updateBoundary}:${appUpdate.available}`;
    void appUpdate.applyAtNewGame(
      () =>
        updateSafety.current.id === updateBoundary && updateSafety.current.safe,
    );
  }, [
    updateBoundary,
    appUpdate.ready,
    appUpdate.available,
    appUpdate.checking,
    appUpdate.applying,
    game?.id,
    game?.revision,
    dialog,
    busy,
    newGameBusy,
    pending,
    connected,
    session.loading,
    placements.length,
    selected,
    drag,
    settling,
    blank,
    wordBusy,
    endGameBusy,
  ]);
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
    (request) => request.status === "pending" && !houseWords.has(request.word),
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
      (request.status === "pending" && !houseWords.has(request.word)) ||
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
                  {houseWords.has(request.word) ? (
                    <>
                      <strong>{request.word}</strong> is in the family
                      dictionary.
                    </>
                  ) : request.status === "pending" ? (
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
                {request.status === "pending" &&
                  !houseWords.has(request.word) &&
                  !own && (
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
          Words approved at any table appear here for everyone.
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
  const lastCells = useMemo(
    () =>
      new Set(
        latest?.kind === "play"
          ? latest.placements.map((p) => `${p.row},${p.col}`)
          : [],
      ),
    [latest],
  );
  const notice = sharedActionsPaused ? "" : message || session.error;
  const finishedOnBoard = !!debugFinishedBoard || game?.status === "finished";
  const nextGameCue =
    finishedOnBoard &&
    (debugFinishedBoard
      ? resultSeenGame === debugFinishedBoard.id
      : resultSeenGame === game?.id);
  const boardGame = debugFinishedBoard || game;
  const displayBoard = debugBoardMove?.board ?? boardGame?.board ?? EMPTY_BOARD;
  const hideDraft = !!debugBoardMove || !!debugFinishedBoard;
  const draftCells = useMemo(() => {
    if (hideDraft) return EMPTY_DRAFT_CELLS;
    return new Map(
      placements.map((placement) => {
        const rackTile = rackById.get(placement.tileId);
        return [
          `${placement.row},${placement.col}`,
          {
            placement,
            tile: rackTile
              ? {
                  ...rackTile,
                  letter: placement.letter || rackTile.letter,
                }
              : null,
          },
        ];
      }),
    );
  }, [hideDraft, placements, rackById]);
  const arrivalPlacements =
    debugBoardMove?.move.placements ?? latest?.placements;
  const arrivalIndices = useMemo(
    () =>
      new Map(
        arrivalPlacements?.map((placement, index) => [
          `${placement.row},${placement.col}`,
          index,
        ]),
      ),
    [arrivalPlacements],
  );
  const status =
    pending || busy
      ? "Saving your move…"
      : !connected
        ? "Reconnecting…"
        : finishedOnBoard
          ? boardGame?.endedReason === "new-game"
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
                {boardGame?.bagCount} tiles in the bag
              </span>
            )}
          </div>
        )}
        {session.playerId && (
          <button
            className="secondary-button games-control"
            data-testid="open-games"
            disabled={
              !session.canLeaveTable ||
              busy ||
              !!wordBusy ||
              newGameBusy ||
              endGameBusy ||
              hasIncomingDecision ||
              !!drag
            }
            onClick={() => setDialog("games")}
          >
            Games
          </button>
        )}
        {game && slot && (
          <button
            className={`secondary-button header-new-game ${nextGameCue ? "new-game-next-action" : ""}`}
            data-testid="new-game"
            disabled={
              !canUseNewGame ||
              appUpdate.applying ||
              !!currentGameRequest ||
              waitingForNewGame ||
              !!debugBoardMove
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
        {import.meta.env.DEV && debugEnabled && game && (
          <button
            className="secondary-button"
            data-testid="local-debug-tools"
            onClick={() => {
              setDebugBoardMove(null);
              setDebugSubmission(null);
              setDebugFinishedBoard(null);
              setDebugExchange(null);
              setDebugStarter(null);
              setDebugUpdating(false);
              setDialog("debug-tools");
            }}
          >
            {debugBoardMove ||
            debugSubmission ||
            debugFinishedBoard ||
            debugExchange ||
            debugStarter ||
            debugUpdating
              ? "Stop preview"
              : "Debug"}
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
          onClick={() => {
            setHelpPage("root");
            setDialog("help");
          }}
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
      {import.meta.env.DEV &&
        debugEnabled &&
        debugFrameMeter &&
        dialog !== "debug-performance" && (
          <DebugFrameMeter floating close={() => setDebugFrameMeter(false)} />
        )}
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
        ) : !session.playerId ? (
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
                  else
                    await session.signInPlayer(
                      linkPlayerId || loginPlayer,
                      passphrase,
                    );
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
                  <input
                    id="login-player"
                    data-testid="login-player"
                    value={loginPlayer}
                    onChange={(event) => {
                      setLinkPlayerId(null);
                      setLoginPlayer(event.target.value);
                    }}
                    autoComplete="username"
                    autoCapitalize="words"
                    maxLength={64}
                    required
                    placeholder="Your name"
                  />
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
                  !(welcomeMode === "join"
                    ? code.trim()
                    : loginPlayer.trim() && passphrase) ||
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
            <h1>Welcome, {session.displayName}.</h1>
            <p>
              {notice ||
                "There are no games ready yet. Your administrator can set up a table with another player."}
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
                        : `${boardGame?.bagCount} tiles in the bag`}
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
                      data-placement-phase={
                        arrivingMove ||
                        (debugBoardMove &&
                          debugScoringReady !== debugBoardMove.move.id)
                          ? "arriving"
                          : undefined
                      }
                      data-draft-error={draftErrorCode || undefined}
                      data-draft-pulse-paused={
                        !!drag || !!settling || recallAnimation.active
                      }
                    >
                      {BOARD_CELLS.map(({ row, col, key, premium }) => {
                        const committed = displayBoard[key];
                        const draftCell = draftCells.get(key);
                        const tentative = !!draftCell;
                        const tile = committed || draftCell?.tile || null;
                        const isLatest = debugBoardMove
                          ? arrivalIndices.has(key)
                          : lastCells.has(key);
                        const isFresh = isLatest && freshMove === latest?.id;
                        const isFading = isFresh && fadingMove === latest?.id;
                        const isDraftWord = draftWordMembers.has(key);
                        const arrivalIndex = arrivalIndices.get(key) ?? -1;
                        const arriving =
                          arrivalIndex >= 0 &&
                          !!committed &&
                          (debugBoardMove
                            ? debugScoringReady !== debugBoardMove.move.id
                            : arrivingMove === latest?.id);
                        return (
                          <BoardCell
                            key={key}
                            row={row}
                            col={col}
                            premium={premium}
                            tile={tile}
                            committed={!!committed}
                            tentative={tentative}
                            openingCentre={
                              openingBoard && !tile && row === 7 && col === 7
                            }
                            selected={!!tile && selected === tile.id}
                            selectedSquare={
                              tentative &&
                              selected === draftCell.placement.tileId
                            }
                            latest={isLatest}
                            fresh={isFresh}
                            fading={isFading}
                            draftWord={isDraftWord}
                            draftPulseKey={
                              isDraftWord ? draftPulseKey : undefined
                            }
                            invalid={tentative && !!draftErrorCode}
                            describedBy={
                              tentative && draftErrorCode
                                ? "draft-arrangement-error"
                                : openingBoard &&
                                    placements.length === 0 &&
                                    row === 7 &&
                                    col === 7
                                  ? "first-word-hint"
                                  : undefined
                            }
                            arriving={arriving}
                            arrivalIndex={arriving ? arrivalIndex : -1}
                            dragSource={!!tile && drag?.tile.id === tile.id}
                            settlingTarget={
                              !!tile && settling?.tile.id === tile.id
                            }
                            canEdit={canEdit}
                            hoverEnabled={
                              tentative && canEdit && finePointer && !drag
                            }
                            onTap={tapBoardCell}
                            onStartDrag={startBoardDrag}
                          />
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
                    {import.meta.env.DEV &&
                      debugEnabled &&
                      debugBoardMove &&
                      debugScoringReady === debugBoardMove.move.id && (
                        <motion.div
                          key={debugBoardMove.move.id}
                          className="floating-points"
                          style={{
                            left: "50%",
                            top: "50%",
                            x: "-50%",
                            y: "-50%",
                          }}
                          data-testid="debug-board-scoring"
                        >
                          <Celebration
                            debug
                            score={debugBoardMove.move.score}
                            bingo={
                              (debugBoardMove.move.breakdown?.bingoBonus ?? 0) >
                              0
                            }
                            variant={0}
                            move={debugBoardMove.move}
                            onComplete={() => setDebugBoardMove(null)}
                          />
                        </motion.div>
                      )}
                    {(debugExchange === "notice" ||
                      (animatedMove === latest?.id &&
                        latest?.kind === "exchange")) && (
                      <motion.div
                        key={debugExchange ? "debug-exchange" : animatedMove}
                        className="floating-points"
                        style={{ left: "50%", top: "50%" }}
                        initial={{
                          opacity: 0,
                          x: "-50%",
                          y: "-50%",
                          scale: reduced ? 1 : 0.95,
                        }}
                        animate={{ opacity: 1, x: "-50%", y: "-50%", scale: 1 }}
                        exit={{ opacity: 0 }}
                      >
                        <div
                          className="celebration-card exchange-celebration"
                          role="status"
                          data-testid="exchange-notice"
                        >
                          <div className="celebration-message">
                            {names[debugExchange ? slot! : latest!.player]}{" "}
                            exchanged{" "}
                            {debugExchange
                              ? 3
                              : (latest?.exchangedCount ?? "some")}{" "}
                            {!debugExchange && latest?.exchangedCount === 1
                              ? "tile"
                              : "tiles"}
                          </div>
                          <p>A fresh hand, ready for the next turn.</p>
                        </div>
                      </motion.div>
                    )}
                    {animatedMove === latest?.id && latest?.kind === "play" && (
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
                  {debugStarter && (
                    <div
                      className="turn-announcement-layer"
                      data-testid="debug-starter"
                    >
                      <TurnAnnouncement
                        name={names[debugStarter]}
                        debug
                        onComplete={() => setDebugStarter(null)}
                      />
                    </div>
                  )}
                  {(debugUpdating || appUpdate.applying) && (
                    <div
                      className="turn-announcement-layer"
                      data-testid={
                        debugUpdating ? "debug-updating" : "app-updating"
                      }
                    >
                      <div className="celebration-card exchange-celebration">
                        <div className="celebration-message">
                          Updating Tea &amp; Tiles…
                        </div>
                        <p>Getting the latest version for your new game.</p>
                      </div>
                    </div>
                  )}
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
                    className={`rack ${!visibleRack.length ? "empty-rack" : ""} ${rackPreview ? "drag-over-rack" : ""}`}
                    aria-label="Your tile rack"
                    data-testid="tile-rack"
                    data-drop-rack="true"
                    data-rack-insertion-index={rackPreview?.insertionIndex}
                    role="group"
                    tabIndex={
                      selected && placements.some((p) => p.tileId === selected)
                        ? 0
                        : -1
                    }
                    onClick={(event) => {
                      if ((event.target as Element).closest("button")) return;
                      if (selected) recallTiles(selected);
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.target !== event.currentTarget ||
                        !selected ||
                        !["Enter", " "].includes(event.key)
                      )
                        return;
                      event.preventDefault();
                      recallTiles(selected);
                    }}
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
                        {finishedOnBoard ? "Hand empty" : "Return tiles here"}
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
                    onClick={() => recallTiles()}
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
                      className={`player-score ${game.turn === player && !finishedOnBoard && game.status === "active" ? "current-player" : ""}`}
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
                          {finishedOnBoard
                            ? "Final score"
                            : game.turn === player
                              ? player === slot
                                ? "Your turn"
                                : "Their turn"
                              : `${game.rackCounts[player]} tiles on the rack`}
                        </span>
                      </div>
                      <Score
                        value={boardGame!.scores[player]}
                        player={player}
                      />
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
                      : finishedOnBoard
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
                  {finishedOnBoard ? (
                    game.endedReason !== "new-game" && (
                      <button
                        className="secondary-button result-reopen"
                        onClick={() =>
                          debugFinishedBoard
                            ? (setDebugEnding(debugFinishedBoard),
                              setDialog("debug-result"))
                            : setQueuedResult({
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
                      Check my move
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
          <div
            ref={dragGhostRef}
            className="tile drag-ghost"
            data-testid="drag-ghost"
            aria-hidden="true"
            style={{
              left: 0,
              top: 0,
              width: drag.width,
              height: drag.height,
            }}
          >
            <TileLetter letter={drag.tile.letter} />
            <small>{drag.tile.value}</small>
          </div>
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
          {submissionNoticeVisible && (
            <Modal
              title={
                debugSubmission?.uncertain || (!busy && !!pending)
                  ? "Your move is taking a little longer"
                  : "Sending your move"
              }
              testId="slow-submit-popup"
              close={() => {
                submissionFeedback.dismiss();
                if (debugSubmission?.uncertain) setDebugSubmission(null);
              }}
              footer={
                <>
                  {(debugSubmission?.uncertain || (!busy && !!pending)) && (
                    <button
                      className="primary-button"
                      data-testid="submission-try-again"
                      disabled={!debugSubmission && !connected}
                      onClick={() => {
                        if (debugSubmission) {
                          setDebugSubmission({
                            id: `preview:${Date.now()}`,
                            uncertain: false,
                          });
                        } else {
                          void retry(true);
                        }
                      }}
                    >
                      Check my move
                    </button>
                  )}
                  <button
                    className="secondary-button"
                    data-testid="submission-back-to-board"
                    onClick={() => {
                      submissionFeedback.dismiss();
                      if (debugSubmission?.uncertain) setDebugSubmission(null);
                    }}
                  >
                    Back to board
                  </button>
                </>
              }
            >
              <SubmissionNotice
                words={debugSubmission ? ["HOUSE"] : preview?.words}
                uncertain={debugSubmission?.uncertain || (!busy && !!pending)}
              />
            </Modal>
          )}
          {dialog === "result" &&
            game?.status === "finished" &&
            game.endedReason !== "new-game" && (
              <Modal
                title="Game complete"
                testId="end-game-popup"
                close={() => {
                  if (
                    latestDialog.current !== "result" ||
                    latestGameId.current !== game.id
                  )
                    return;
                  setQueuedResult(null);
                  setResultSeenGame(game.id);
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
                        setResultSeenGame(game.id);
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
                        setResultSeenGame(null);
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
                <EndingPresentation game={game} names={names} />
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
          {import.meta.env.DEV && debugEnabled && dialog === "debug-tools" && (
            <Modal
              title="Local preview tools"
              testId="local-debug-popup"
              close={() => setDialog(null)}
            >
              <p>
                Sample scenes on your board. These previews do not save moves or
                send requests.
              </p>
              <h3>Drag performance</h3>
              <p>
                Frame timing helps spot stutters on an iPad. A fast computer can
                hide them; compare with browser CPU throttling too. The meter
                samples animation frames, not finger-to-screen delay.
              </p>
              <div className="debug-buttons">
                <button
                  className="secondary-button"
                  data-testid="debug-show-frame-meter"
                  onClick={() => {
                    setDebugFrameMeter((v) => !v);
                    setDialog(null);
                  }}
                >
                  {debugFrameMeter
                    ? "Hide frame meter"
                    : "Show frame meter on game"}
                </button>
                <button
                  className="secondary-button"
                  data-testid="debug-drag-performance"
                  onClick={() => setDialog("debug-performance")}
                >
                  Crowded-board drag test
                </button>
              </div>
              <h3>Scoring over the board</h3>
              <div className="debug-buttons">
                {(
                  [
                    "normal",
                    "multiple-words",
                    "high",
                    "bingo",
                    "eight-letter",
                    "fifteen-letter",
                  ] as const
                ).map((kind) => (
                  <button
                    key={kind}
                    className="secondary-button"
                    data-testid={`debug-scene-${kind}`}
                    disabled={
                      !game ||
                      !!pending ||
                      busy ||
                      !!drag ||
                      !!settling ||
                      !!animatedMove
                    }
                    onClick={() => {
                      const move = debugMove(kind);
                      setDebugBoardMove({
                        move: { ...move, id: `preview:${Date.now()}` },
                        board: debugMoveBoard(kind),
                      });
                      setDialog(null);
                    }}
                  >
                    {kind === "normal"
                      ? "Single word"
                      : kind === "multiple-words"
                        ? "Multiple words"
                        : kind === "bingo"
                          ? "Seven tiles"
                          : kind === "eight-letter"
                            ? "Eight-letter word"
                            : kind === "fifteen-letter"
                              ? "Fifteen-letter word"
                              : "High score"}
                  </button>
                ))}
              </div>
              <h3>Game endings</h3>
              <button
                className="secondary-button"
                data-testid="debug-random-starter"
                onClick={() => {
                  setDebugStarter(Math.random() < 0.5 ? "mom" : "aunt");
                  setDialog(null);
                }}
              >
                Random starting player
              </button>
              <button
                className="secondary-button"
                data-testid="debug-new-game-update"
                onClick={() => {
                  setDebugUpdating(true);
                  setDialog(null);
                }}
              >
                New-game update
              </button>
              <button
                className="secondary-button"
                data-testid="debug-exchange"
                onClick={() => {
                  setDebugExchange("notice");
                  setDialog(null);
                }}
              >
                Exchange three tiles
              </button>
              <div className="debug-buttons">
                <button
                  className="secondary-button"
                  data-testid="debug-scene-slow-submit"
                  onClick={() => {
                    setDebugSubmission({
                      id: `debug-submit:${Date.now()}`,
                      uncertain: false,
                    });
                    setDialog(null);
                  }}
                >
                  Slow submission
                </button>
                <button
                  className="secondary-button"
                  data-testid="debug-scene-uncertain-submit"
                  onClick={() => {
                    setDebugSubmission({
                      id: `debug-submit:${Date.now()}`,
                      uncertain: true,
                    });
                    setDialog(null);
                  }}
                >
                  Uncertain reply
                </button>
              </div>
              <label>
                Preview outcome{" "}
                <select
                  data-testid="debug-winner"
                  value={debugWinner}
                  onChange={(event) =>
                    setDebugWinner(event.target.value as Slot | "tie")
                  }
                >
                  <option value="mom">{names.mom} wins</option>
                  <option value="aunt">{names.aunt} wins</option>
                  <option value="tie">Tie</option>
                </select>
              </label>
              <div className="debug-buttons">
                <button
                  className="secondary-button"
                  data-testid="debug-scene-game-over"
                  onClick={() => {
                    setDebugFinishedBoard(
                      debugEndingGame("agreed-end", debugWinner),
                    );
                    setDebugBoardMove(null);
                    setDebugSubmission(null);
                    setResultSeenGame(null);
                    setDebugEnding(debugEndingGame("agreed-end", debugWinner));
                    setDialog("debug-result");
                  }}
                >
                  Game over
                </button>
                {(
                  [
                    ["rack-out", "Last tile played"],
                    ["agreed-end", "Mutual decision"],
                    ["scoreless", "Six scoreless turns"],
                    ["timed", "Time is up"],
                    ["turn-limit", "Turn limit"],
                    ["target-score", "Target reached"],
                  ] as const
                ).map(([reason, label]) => (
                  <button
                    className="secondary-button"
                    key={reason}
                    data-testid={`debug-ending-${reason}`}
                    onClick={() => {
                      setDebugEnding(debugEndingGame(reason, debugWinner));
                      setDialog("debug-result");
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                className="secondary-button"
                data-testid="debug-end-request"
                onClick={() => setDialog("debug-end-request")}
              >
                Preview end-game agreement
              </button>
              <button
                className="secondary-button"
                data-testid="debug-turn-announcement"
                disabled={!game || game.status !== "active"}
                onClick={() => {
                  if (!game) return;
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
            </Modal>
          )}
          {import.meta.env.DEV &&
            debugEnabled &&
            dialog === "debug-performance" && (
              <Modal
                title="Drag performance"
                testId="debug-performance-popup"
                close={() => setDialog(null)}
              >
                <DragPerformanceLab />
              </Modal>
            )}
          {import.meta.env.DEV &&
            debugEnabled &&
            dialog === "debug-end-request" && (
              <Modal
                title="Finish this game together?"
                testId="debug-end-request-popup"
                close={() => setDialog(null)}
                footer={
                  <div className="dialog-actions">
                    <button
                      className="secondary-button"
                      onClick={() => setDialog("debug-tools")}
                    >
                      Keep playing
                    </button>
                    <button
                      className="primary-button"
                      data-testid="debug-agree-end"
                      onClick={() => {
                        setDebugEnding(
                          debugEndingGame("agreed-end", debugWinner),
                        );
                        setDialog("debug-result");
                      }}
                    >
                      Agree & end game
                    </button>
                  </div>
                }
              >
                <p>
                  The bag is empty. Agreeing finishes the game and subtracts
                  each player’s remaining tile values.
                </p>
              </Modal>
            )}
          {import.meta.env.DEV && debugEnabled && dialog === "debug-result" && (
            <Modal
              title="Game complete"
              testId="debug-end-game-popup"
              close={() => {
                if (debugFinishedBoard)
                  setResultSeenGame(debugFinishedBoard.id);
                setDialog(null);
              }}
              footer={
                <div className="dialog-actions">
                  <button
                    className="secondary-button"
                    onClick={() => {
                      if (debugFinishedBoard)
                        setResultSeenGame(debugFinishedBoard.id);
                      setDialog(null);
                    }}
                  >
                    See the board
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => {
                      setResultSeenGame(null);
                      setDialog(
                        debugFinishedBoard ? "new-game" : "debug-tools",
                      );
                    }}
                  >
                    Play a new game?
                  </button>
                </div>
              }
            >
              <EndingPresentation
                key={debugEnding?.id}
                game={debugEnding || debugEndingGame("agreed-end")}
                names={names}
              />
              <GameSummary
                game={debugEnding || debugEndingGame("agreed-end")}
                names={names}
              />
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
          {dialog === "games" && (
            <Modal
              title="Your games"
              close={() => setDialog(null)}
              testId="games-drawer"
              drawer
            >
              <p className="setup-note">
                Choose a table. Your tiles stay saved at each one.
              </p>
              <div className="games-list">
                {session.pairs.map((pair) => {
                  const ownSeat =
                    pair.seatPlayers.mom === session.playerId ? "mom" : "aunt";
                  const opponent = pair.names[other(ownSeat)];
                  const selectedPair = pair.id === session.pairId;
                  return (
                    <button
                      key={pair.id}
                      className={`game-choice ${selectedPair ? "chosen" : ""}`}
                      data-testid={`open-pair-${pair.id}`}
                      aria-current={selectedPair ? "page" : undefined}
                      disabled={!session.canLeaveTable}
                      onClick={() => {
                        session.selectPair(pair.id);
                        setDialog(null);
                      }}
                    >
                      <strong>{opponent}</strong>
                      <span>
                        {Object.entries(pair.actionNeededBy || {}).some(
                          ([action, player]) =>
                            player === session.playerId &&
                            (!action.startsWith("word-") ||
                              !houseWords.has(
                                action.split("-").slice(2).join("-"),
                              )),
                        )
                          ? "Your reply is needed"
                          : pair.activeGame?.status === "finished"
                            ? "Game complete"
                            : pair.activeGame?.turn === ownSeat
                              ? "Your turn"
                              : `Waiting for ${opponent}`}
                      </span>
                      {selectedPair && <small>Open now</small>}
                    </button>
                  );
                })}
                {!session.pairs.length && (
                  <p>No tables have been set up yet.</p>
                )}
              </div>
            </Modal>
          )}
          {dialog === "help" && (
            <Modal
              title={
                helpPage === "root"
                  ? "Help & settings"
                  : {
                      play: "How to play",
                      settings: "Colours & device settings",
                      dictionary: "Shared dictionary",
                      about: "About & updates",
                      debug: "Local preview tools",
                    }[helpPage]
              }
              close={() => setDialog(null)}
            >
              {helpPage !== "root" && (
                <button
                  className="secondary-button help-back"
                  onClick={() => setHelpPage("root")}
                >
                  ← Back
                </button>
              )}
              {helpPage === "root" && (
                <>
                  <div className="help-menu">
                    <button
                      className="secondary-button"
                      data-testid="help-play"
                      onClick={() => setHelpPage("play")}
                    >
                      How to play
                    </button>
                    <button
                      className="secondary-button"
                      data-testid="help-settings-page"
                      onClick={() => setHelpPage("settings")}
                    >
                      Colours & device settings
                    </button>
                    <button
                      className="secondary-button"
                      data-testid="help-dictionary"
                      onClick={() => setHelpPage("dictionary")}
                    >
                      Shared dictionary
                      {pendingWordCount ? ` (${pendingWordCount})` : ""}
                    </button>
                    <button
                      className="secondary-button"
                      data-testid="help-about"
                      onClick={() => setHelpPage("about")}
                    >
                      About & updates
                    </button>
                    {import.meta.env.DEV && (
                      <button
                        className="secondary-button"
                        data-testid="help-debug"
                        onClick={() => setHelpPage("debug")}
                      >
                        Local preview tools
                      </button>
                    )}
                  </div>
                  {session.playerId && (
                    <section className="help-account">
                      <p>
                        Signed in as <strong>{session.displayName}</strong>
                      </p>
                      <button
                        className="secondary-button"
                        data-testid="sign-out"
                        disabled={
                          !session.canLeaveTable ||
                          busy ||
                          !!wordBusy ||
                          newGameBusy ||
                          endGameBusy ||
                          hasIncomingDecision
                        }
                        onClick={async () => {
                          setMessage("");
                          try {
                            await session.signOut();
                          } catch (error) {
                            setMessage(
                              error instanceof Error
                                ? error.message
                                : "Please wait for your move to finish saving.",
                            );
                          }
                        }}
                      >
                        Sign out
                      </button>
                      {!session.canLeaveTable && (
                        <p role="status">
                          Please wait for your move to finish saving.
                        </p>
                      )}
                    </section>
                  )}
                </>
              )}
              {helpPage === "settings" && (
                <>
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
                  </section>
                  <fieldset className="theme-options">
                    <legend>Your table colours</legend>
                    <p>
                      Choose a look for this device. Your partner can choose
                      their own.
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
                </>
              )}
              {helpPage === "debug" && (
                <>
                  {import.meta.env.DEV && (
                    <section className="debug-settings">
                      <label className="debug-toggle">
                        <input
                          type="checkbox"
                          checked={debugEnabled}
                          onChange={(event) =>
                            setDebugEnabled(event.target.checked)
                          }
                          data-testid="debug-enabled"
                        />{" "}
                        Enable local preview tools
                      </label>
                      {debugEnabled && (
                        <div className="debug-panel" data-testid="debug-panel">
                          <p>
                            Preview scoring, game endings and turn announcements
                            over the board. Sample data never changes your game.
                          </p>
                          <button
                            className="secondary-button"
                            data-testid="debug-end-game"
                            onClick={() => setDialog("debug-tools")}
                          >
                            Open preview tools
                          </button>
                        </div>
                      )}
                    </section>
                  )}
                </>
              )}
              {helpPage === "play" && (
                <>
                  <h3 className="help-section-title">Playing together</h3>
                  <ol className="help-steps">
                    <li>
                      <b>Choose a tile.</b> Tap a letter in your rack.
                    </li>
                    <li>
                      <b>Find its place.</b> Tap an empty square. Your first
                      word crosses the centre star.
                    </li>
                    <li>
                      <b>Make a word.</b> Place letters in a straight line,
                      joining words already on the board.
                    </li>
                    <li>
                      <b>Play when you’re ready.</b> We check the words and save
                      the turn for both of you.
                    </li>
                  </ol>
                  <p>
                    To move a tentative tile, tap it and then another square.
                    Tap it twice to return it to your rack. You can also drag
                    tiles onto empty squares or back to the rack.{" "}
                    <b>Recall tiles</b> brings them all back.
                  </p>
                  <p>
                    Arrange your tiles on any empty squares, in any order. Red
                    outlines show a draft that needs adjusting: fill its gaps,
                    line up the tiles and connect the word before playing. The
                    first word must cover the centre star. While waiting, your
                    draft stays private until you play it on your turn.
                  </p>
                  <p>
                    Drag a letter between letters in your hand to arrange them
                    in any order, even while waiting. The outlined gap shows
                    where it will go. With a keyboard, focus a rack tile and
                    hold Alt while pressing the left or right arrow. Your order
                    is saved on this device.
                  </p>
                  <p>
                    A blank can be any letter and scores zero. Use all seven
                    tiles in one turn for 50 extra points.
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
                    In every mode, using your last tile ends the game only when
                    the bag is empty; otherwise, you draw replacement tiles.
                    Your partner’s remaining tile values are deducted from their
                    score and added to yours.
                  </p>
                  <p>
                    Six consecutive turns without points also end the game: six
                    turns total, or three passes each if you both keep passing.
                    Passes, exchanges and zero-point words count; a scoring word
                    resets the count. Each player’s remaining tile values are
                    deducted from their score.
                  </p>
                  <p>
                    You can close the app and come back later. Your game is
                    saved after every accepted turn. You need a connection to
                    send a turn.
                  </p>
                  <p data-testid="facetime-help">
                    If you use FaceTime in picture in picture, move its floating
                    window into the clear area beside the game controls. That
                    space is kept free so you can see each other while playing.
                  </p>
                  <p data-testid="presence-help">
                    The dot beside your partner’s name shows whether they are at
                    the table on any device. It updates about once a minute, so
                    Away can take up to two minutes to appear. The indicator is
                    hidden when their status cannot be checked.
                  </p>
                  <p>
                    <b>New game</b> asks your partner to start fresh. Your
                    current board stays until you both agree.
                  </p>
                  <p>
                    Choose Classic, 10 turns each, First to 150, or a timed
                    game. In ten-turn games, all 20 plays, passes or exchanges
                    count; the highest score wins. Reaching a short-game limit
                    keeps scores as played. The usual tile and
                    six-scoreless-turn endings can happen sooner.
                    {game && (
                      <>
                        {" "}
                        Your current game is{" "}
                        <b>{gameModes[activeMode].title}</b>.
                      </>
                    )}
                  </p>
                  <p>
                    A timed game starts when your partner agrees, with 25
                    minutes by default or a duration you choose. The clock keeps
                    running while the app is closed. When time is up, reconnect
                    to confirm the final score; the highest score wins. In every
                    mode, the game can finish sooner when the bag is empty and a
                    player uses their last tile.
                  </p>
                </>
              )}
              {helpPage === "dictionary" && (
                <>
                  <p>
                    Words use our prototype English Speller Database dictionary,
                    including UK, Canadian and US spellings. It is not an
                    official tournament dictionary. A word check appears beside
                    your score as you arrange tiles. If a word isn’t recognized,
                    you can ask each other to allow it. Words approved at any
                    table join the family dictionary for everyone’s future
                    games.{" "}
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
                  {wordRequests("help-", true)}
                </>
              )}
              {helpPage === "about" && (
                <>
                  <p>A quiet game of words with family.</p>
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
                  <AppVersion />
                  <Changelog />
                </>
              )}
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
                      place(
                        blank.tileId,
                        blank.row,
                        blank.col,
                        letter,
                        blank.replaceDraft,
                      );
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
