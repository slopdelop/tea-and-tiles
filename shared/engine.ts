import {
  scoreAdjustments,
  type MoveBreakdown,
  type FinalScoreAdjustments,
  type ScoreTile,
  type HistoryRecord,
} from "./scoring.js";
export type Slot = "mom" | "aunt";
export type WinCondition = "classic" | "turn-limit" | "target-score" | "timed";
export interface Tile {
  id: string;
  letter: string;
  value: number;
}
export interface PlacedTile extends Tile {
  row: number;
  col: number;
}
export interface Placement {
  tileId: string;
  row: number;
  col: number;
  letter?: string;
}
export type Board = Record<string, PlacedTile>;
export interface MoveRecord {
  id: string;
  player: Slot;
  kind: Command["kind"];
  placements: PlacedTile[];
  words: string[];
  score: number;
  at: number;
  breakdown?: MoveBreakdown;
}
export interface Game {
  id: string;
  revision: number;
  board: Board;
  racks: Record<Slot, Tile[]>;
  bag: Tile[];
  scores: Record<Slot, number>;
  turn: Slot;
  status: "active" | "finished";
  scorelessTurns: number;
  lastMove: MoveRecord | null;
  winner: Slot | "tie" | null;
  winCondition?: WinCondition;
  turnsPlayed?: number;
  durationMinutes?: number;
  startedAt?: number;
  deadlineAt?: number;
  endedReason?:
    | "new-game"
    | "turn-limit"
    | "target-score"
    | "timed"
    | "rack-out"
    | "scoreless";
  replacedByGameId?: string;
  replacedAt?: number;
  endedAt?: number;
  history?: HistoryRecord[];
  historyComplete?: boolean;
  finalScoreAdjustments?: FinalScoreAdjustments;
}
export interface Command {
  id: string;
  gameId: string;
  expectedRevision: number;
  kind: "play" | "pass" | "exchange" | "rematch";
  placements?: Placement[];
  tileIds?: string[];
}
export interface CommandResult {
  commandId: string;
  gameId: string;
  revision: number;
  score: number;
}
export class RuleError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuleError";
  }
}
const fail = (code: string, message: string): never => {
  throw new RuleError(code, message);
};
export const key = (row: number, col: number) => `${row},${col}`;
const other = (slot: Slot): Slot => (slot === "mom" ? "aunt" : "mom");
export const DISTRIBUTION: Record<string, [number, number]> = {
  A: [9, 1],
  B: [2, 3],
  C: [2, 3],
  D: [4, 2],
  E: [12, 1],
  F: [2, 4],
  G: [3, 2],
  H: [2, 4],
  I: [9, 1],
  J: [1, 8],
  K: [1, 5],
  L: [4, 1],
  M: [2, 3],
  N: [6, 1],
  O: [8, 1],
  P: [2, 3],
  Q: [1, 10],
  R: [6, 1],
  S: [4, 1],
  T: [6, 1],
  U: [4, 1],
  V: [2, 4],
  W: [2, 4],
  X: [1, 8],
  Y: [2, 4],
  Z: [1, 10],
  "?": [2, 0],
};
const premiums: Record<string, "TW" | "DW" | "TL" | "DL"> = {};
for (const [kind, coords] of Object.entries({
  TW: [
    [0, 0],
    [0, 7],
    [0, 14],
    [7, 0],
    [7, 14],
    [14, 0],
    [14, 7],
    [14, 14],
  ],
  DW: [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [7, 7],
    [10, 10],
    [11, 11],
    [12, 12],
    [13, 13],
    [1, 13],
    [2, 12],
    [3, 11],
    [4, 10],
    [10, 4],
    [11, 3],
    [12, 2],
    [13, 1],
  ],
  TL: [
    [1, 5],
    [1, 9],
    [5, 1],
    [5, 5],
    [5, 9],
    [5, 13],
    [9, 1],
    [9, 5],
    [9, 9],
    [9, 13],
    [13, 5],
    [13, 9],
  ],
  DL: [
    [0, 3],
    [0, 11],
    [2, 6],
    [2, 8],
    [3, 0],
    [3, 7],
    [3, 14],
    [6, 2],
    [6, 6],
    [6, 8],
    [6, 12],
    [7, 3],
    [7, 11],
    [8, 2],
    [8, 6],
    [8, 8],
    [8, 12],
    [11, 0],
    [11, 7],
    [11, 14],
    [12, 6],
    [12, 8],
    [14, 3],
    [14, 11],
  ],
}))
  for (const [r, c] of coords)
    premiums[key(r, c)] = kind as "TW" | "DW" | "TL" | "DL";
export const premiumAt = (row: number, col: number) =>
  premiums[key(row, col)] ?? null;
export function shuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export function createGame(
  id: string,
  rng: () => number = Math.random,
  winCondition: WinCondition = "classic",
  durationMinutes = 25,
  now = Date.now(),
): Game {
  if (
    winCondition === "timed" &&
    (!Number.isInteger(durationMinutes) ||
      durationMinutes < 1 ||
      durationMinutes > 1440)
  )
    fail("timed", "Choose a whole number of minutes from 1 to 1440.");
  const tiles: Tile[] = [];
  for (const [letter, [count, value]] of Object.entries(DISTRIBUTION))
    for (let i = 0; i < count; i++)
      tiles.push({ id: `${letter}-${i}`, letter, value });
  const bag = shuffle(tiles, rng);
  return {
    id,
    revision: 0,
    board: {},
    racks: { mom: bag.splice(0, 7), aunt: bag.splice(0, 7) },
    bag,
    scores: { mom: 0, aunt: 0 },
    turn: "mom",
    status: "active",
    scorelessTurns: 0,
    lastMove: null,
    winner: null,
    history: [],
    historyComplete: true,
    winCondition,
    turnsPlayed: 0,
    ...(winCondition === "timed"
      ? {
          durationMinutes,
          startedAt: now,
          deadlineAt: now + durationMinutes * 60000,
        }
      : {}),
  };
}
export function previewMove(
  game: Pick<Game, "board">,
  rack: Tile[],
  input: Placement[],
  dictionary?: Set<string>,
): {
  score: number;
  words: string[];
  placements: PlacedTile[];
  breakdown: MoveBreakdown;
} {
  if (!Array.isArray(input) || input.length < 1 || input.length > 7)
    fail("placement", "Choose between one and seven tiles.");
  const board = game.board;
  const ids = new Set<string>();
  const cells = new Set<string>();
  const placements: PlacedTile[] = [];
  for (const p of input) {
    if (
      !p ||
      !Number.isInteger(p.row) ||
      !Number.isInteger(p.col) ||
      p.row < 0 ||
      p.row > 14 ||
      p.col < 0 ||
      p.col > 14
    )
      fail("placement", "Place tiles inside the board.");
    const k = key(p.row, p.col);
    if (cells.has(k) || board[k])
      fail("placement", "That square already has a tile.");
    if (ids.has(p.tileId)) fail("rack", "A tile can only be played once.");
    const tile =
      rack.find((t) => t.id === p.tileId) ??
      fail("rack", "That tile is no longer in your rack.");
    let letter = tile.letter;
    if (letter === "?") {
      letter = (p.letter ?? "").toUpperCase();
      if (!/^[A-Z]$/.test(letter))
        fail("blank", "Choose a letter for your blank tile.");
    } else if (p.letter && p.letter.toUpperCase() !== letter)
      fail("rack", "A letter tile cannot change its letter.");
    ids.add(tile.id);
    cells.add(k);
    placements.push({ ...tile, letter, row: p.row, col: p.col });
  }
  const sameRow = placements.every((t) => t.row === placements[0].row),
    sameCol = placements.every((t) => t.col === placements[0].col);
  if (!sameRow && !sameCol)
    fail("line", "Place your tiles in one row or column.");
  const next = { ...board };
  for (const tile of placements) next[key(tile.row, tile.col)] = tile;
  if (placements.length > 1) {
    const values = placements.map((t) => (sameRow ? t.col : t.row));
    for (let x = Math.min(...values); x <= Math.max(...values); x++)
      if (
        !next[
          key(sameRow ? placements[0].row : x, sameRow ? x : placements[0].col)
        ]
      )
        fail("gap", "Fill the gap between your tiles.");
  }
  if (Object.keys(board).length === 0) {
    if (!cells.has("7,7"))
      fail("center", "Your first word must cross the centre star.");
  } else if (
    !placements.some((t) =>
      [
        [t.row - 1, t.col],
        [t.row + 1, t.col],
        [t.row, t.col - 1],
        [t.row, t.col + 1],
      ].some(([r, c]) => board[key(r, c)]),
    )
  )
    fail("connection", "Connect your word to a tile already on the board.");
  const sequences: PlacedTile[][] = [];
  const seen = new Set<string>();
  for (const tile of placements)
    for (const [dr, dc] of [
      [0, 1],
      [1, 0],
    ]) {
      let r = tile.row,
        c = tile.col;
      while (next[key(r - dr, c - dc)]) {
        r -= dr;
        c -= dc;
      }
      const seq: PlacedTile[] = [];
      while (next[key(r, c)]) {
        seq.push(next[key(r, c)]);
        r += dr;
        c += dc;
      }
      if (seq.length > 1) {
        const identity = seq.map((t) => key(t.row, t.col)).join("|");
        if (!seen.has(identity)) {
          seen.add(identity);
          sequences.push(seq);
        }
      }
    }
  if (!sequences.length) fail("word", "A word needs at least two letters.");
  const words = sequences.map((seq) => seq.map((t) => t.letter).join(""));
  if (dictionary) {
    const invalid = words.filter((w) => !dictionary.has(w));
    if (invalid.length)
      fail(
        "dictionary",
        `Not in our dictionary: ${invalid.join(", ")}. You can edit your tiles and try again.`,
      );
  }
  let score = 0;
  const scoredWords: MoveBreakdown["words"] = [];
  for (const seq of sequences) {
    let sum = 0,
      mult = 1;
    const scoredTiles: ScoreTile[] = [];
    for (const t of seq) {
      let value = t.value;
      let letterMultiplier = 1;
      const isNew = cells.has(key(t.row, t.col));
      const p = isNew ? premiumAt(t.row, t.col) : null;
      if (isNew) {
        if (p === "DL") letterMultiplier = 2;
        if (p === "TL") letterMultiplier = 3;
        value *= letterMultiplier;
        if (p === "DW") mult *= 2;
        if (p === "TW") mult *= 3;
      }
      sum += value;
      scoredTiles.push({
        tileId: t.id,
        letter: t.letter,
        faceValue: t.value,
        letterMultiplier,
        effectivePoints: value,
        row: t.row,
        col: t.col,
        isNew,
        premium: p,
      });
    }
    score += sum * mult;
    scoredWords.push({
      word: seq.map((t) => t.letter).join(""),
      tiles: scoredTiles,
      wordMultiplier: mult,
      score: sum * mult,
    });
  }
  const bingoBonus = placements.length === 7 ? 50 : 0;
  score += bingoBonus;
  return {
    score,
    words,
    placements,
    breakdown: { words: scoredWords, bingoBonus, total: score },
  };
}
function finish(
  game: Game,
  out: Slot | null,
  reason: NonNullable<Game["endedReason"]>,
  now: number,
  deductRacks = true,
) {
  const rackValues = {
    mom: game.racks.mom.reduce((sum, tile) => sum + tile.value, 0),
    aunt: game.racks.aunt.reduce((sum, tile) => sum + tile.value, 0),
  };
  game.finalScoreAdjustments = scoreAdjustments(
    game.scores,
    rackValues,
    reason,
    deductRacks ? out : null,
  );
  for (const slot of ["mom", "aunt"] as const)
    game.scores[slot] = game.finalScoreAdjustments.players[slot].final;
  game.status = "finished";
  game.endedReason = reason;
  game.endedAt = now;
  game.winner =
    game.scores.mom === game.scores.aunt
      ? "tie"
      : game.scores.mom > game.scores.aunt
        ? "mom"
        : "aunt";
}
export function applyCommand(
  original: Game,
  slot: Slot,
  command: Command,
  dictionary: Set<string>,
  rng: () => number = Math.random,
  now = Date.now(),
): Game {
  if (slot !== "mom" && slot !== "aunt")
    fail("unauthorized", "This device is not part of this game.");
  if (command.gameId !== original.id)
    fail("stale", "This is a different match.");
  if (command.expectedRevision !== original.revision)
    fail("stale", "The game has changed. Please review the latest board.");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(command.id))
    fail("command", "This move needs a valid unique ID.");
  if (command.kind === "rematch") {
    if (original.status !== "finished")
      fail("active", "Finish this match before starting another.");
    const next = createGame(
      original.id,
      rng,
      original.winCondition ?? "classic",
      original.durationMinutes ?? 25,
      now,
    );
    next.revision = original.revision + 1;
    next.lastMove = {
      id: command.id,
      player: slot,
      kind: "rematch",
      placements: [],
      words: [],
      score: 0,
      at: now,
    };
    return next;
  }
  if (original.status !== "active")
    fail("finished", "This match has finished. Start a rematch.");
  if (original.turn !== slot) fail("turn", "It is your opponent’s turn.");
  if (original.winCondition === "timed") {
    if (!Number.isSafeInteger(original.deadlineAt))
      fail(
        "timed",
        "This game's clock is unavailable. Please contact the administrator.",
      );
    if (now >= original.deadlineAt!)
      fail("timed", "Time is up. Please wait for the final scores.");
  }
  const game: Game = structuredClone(original);
  let score = 0,
    words: string[] = [],
    placements: PlacedTile[] = [];
  let breakdown: MoveBreakdown | undefined;
  if (command.kind === "play") {
    const result = previewMove(
      game,
      game.racks[slot],
      command.placements ?? [],
      dictionary,
    );
    ({ score, words, placements } = result);
    breakdown = result.breakdown;
    for (const tile of placements) game.board[key(tile.row, tile.col)] = tile;
    const used = new Set(placements.map((t) => t.id));
    game.racks[slot] = game.racks[slot].filter((t) => !used.has(t.id));
    game.racks[slot].push(...game.bag.splice(0, 7 - game.racks[slot].length));
    game.scores[slot] += score;
  } else if (command.kind === "exchange") {
    const ids = command.tileIds ?? [];
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 7 ||
      new Set(ids).size !== ids.length
    )
      fail("exchange", "Choose the tiles you want to exchange.");
    if (game.bag.length < 7)
      fail(
        "exchange",
        "At least seven tiles must remain in the bag to exchange.",
      );
    const returned = ids.map(
      (id) =>
        game.racks[slot].find((t) => t.id === id) ??
        fail("rack", "That tile is no longer in your rack."),
    );
    game.racks[slot] = game.racks[slot].filter((t) => !ids.includes(t.id));
    game.racks[slot].push(...game.bag.splice(0, returned.length));
    game.bag = shuffle([...game.bag, ...returned], rng);
  } else if (command.kind !== "pass") fail("command", "Unknown move.");
  game.revision++;
  game.turnsPlayed = (original.turnsPlayed ?? original.revision) + 1;
  game.scorelessTurns = score === 0 ? game.scorelessTurns + 1 : 0;
  game.turn = other(slot);
  game.lastMove = {
    id: command.id,
    player: slot,
    kind: command.kind,
    placements,
    words,
    score,
    at: now,
    ...(breakdown ? { breakdown } : {}),
  };
  const compact = (
    move: HistoryRecord & { breakdown?: MoveBreakdown },
  ): HistoryRecord => ({
    id: move.id,
    player: move.player,
    kind: move.kind,
    words: move.words,
    score: move.score,
    at: move.at,
    ...(move.breakdown
      ? {
          wordScores: move.breakdown.words.map((word) => ({
            word: word.word,
            score: word.score,
          })),
          bingoBonus: move.breakdown.bingoBonus,
        }
      : {
          ...(move.wordScores ? { wordScores: move.wordScores } : {}),
          ...(move.bingoBonus !== undefined
            ? { bingoBonus: move.bingoBonus }
            : {}),
        }),
  });
  const history = [
    ...(original.history ?? []).map(compact),
    compact(game.lastMove),
  ];
  game.history = history.slice(-600);
  game.historyComplete =
    (original.historyComplete ?? original.revision === 0) &&
    history.length <= 600;
  // Rack-out remains the standard finish in every mode, including when this
  // accepted move also reaches a score or turn cutoff.
  if (game.bag.length === 0 && game.racks[slot].length === 0)
    finish(game, slot, "rack-out", now);
  else if (game.winCondition === "target-score" && game.scores[slot] >= 150) {
    finish(game, null, "target-score", now, false);
  } else if (game.winCondition === "turn-limit" && game.turnsPlayed >= 20) {
    finish(game, null, "turn-limit", now, false);
  } else if (game.scorelessTurns >= 6) finish(game, null, "scoreless", now);
  return game;
}
