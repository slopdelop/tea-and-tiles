import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { info, warn } from "firebase-functions/logger";
import {
  diagnosticsEnabled,
  validateDiagnosticReport,
} from "./move-diagnostics.js";
import { MOVE_DIAGNOSTICS } from "../shared/move-diagnostics.js";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { WORD_FAILURE_BUCKET } from "./setup-words.js";
import { callablePolicy } from "./callable-policy.js";
import { validLoginSecret, verifyCredential } from "./player-login.js";
import { scoreAdjustments } from "../shared/scoring.js";
import { onlineGameTime, readOnlinePresence } from "../shared/online-time.js";
import {
  applyCommand,
  createGame,
  RuleError,
  previewMove,
  type Command,
  type CommandResult,
  type Game,
  type Slot,
  type Tile,
  type WinCondition,
} from "../shared/engine.js";
import type { WordRequest, HouseWord } from "../shared/dictionary.js";
import type {
  NewGameRequest,
  NewGameResponse,
  TimedGameResult,
  EndGameRequest,
  EndGameResponse,
} from "../shared/game-request.js";

initializeApp();
const db = getFirestore();
const dictionary = new Set(
  readFileSync(new URL("../shared/words.txt", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((w) => w.trim().toUpperCase())
    .filter(Boolean),
);
const cryptoRandom = () => randomInt(0, 0x100000000) / 0x100000000;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const tileIdPattern = /^[A-Za-z0-9_?-]{1,100}$/;
const slots: Slot[] = ["mom", "aunt"];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpsError("invalid-argument", "Please send a valid command.");
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((k) => !keys.includes(k)))
    throw new HttpsError(
      "invalid-argument",
      "The command contains an unexpected field.",
    );
}
function validId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}
function validTileId(value: unknown): value is string {
  return typeof value === "string" && tileIdPattern.test(value);
}
export function validateCommand(data: unknown): Command {
  const d = object(data);
  onlyKeys(d, [
    "id",
    "gameId",
    "expectedRevision",
    "kind",
    "placements",
    "tileIds",
  ]);
  if (
    !validId(d.id) ||
    d.id.length < 8 ||
    !validId(d.gameId) ||
    !Number.isSafeInteger(d.expectedRevision) ||
    (d.expectedRevision as number) < 0 ||
    typeof d.kind !== "string" ||
    !["play", "pass", "exchange", "rematch"].includes(d.kind)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "The move is incomplete. Please refresh and try again.",
    );
  }
  const command: Command = {
    id: d.id,
    gameId: d.gameId,
    expectedRevision: d.expectedRevision as number,
    kind: d.kind as Command["kind"],
  };
  if (d.kind === "play") {
    if (
      !Array.isArray(d.placements) ||
      d.placements.length < 1 ||
      d.placements.length > 7 ||
      d.tileIds !== undefined
    )
      throw new HttpsError(
        "invalid-argument",
        "Choose between one and seven tiles to play.",
      );
    command.placements = d.placements.map((raw) => {
      const p = object(raw);
      onlyKeys(p, ["tileId", "row", "col", "letter"]);
      if (
        !validTileId(p.tileId) ||
        !Number.isInteger(p.row) ||
        !Number.isInteger(p.col) ||
        (p.row as number) < 0 ||
        (p.row as number) > 14 ||
        (p.col as number) < 0 ||
        (p.col as number) > 14 ||
        (p.letter !== undefined &&
          (typeof p.letter !== "string" || !/^[A-Z]$/.test(p.letter)))
      )
        throw new HttpsError(
          "invalid-argument",
          "Choose a board square and a letter for each blank.",
        );
      return {
        tileId: p.tileId,
        row: p.row as number,
        col: p.col as number,
        ...(p.letter === undefined ? {} : { letter: p.letter as string }),
      };
    });
  } else if (d.kind === "exchange") {
    if (
      !Array.isArray(d.tileIds) ||
      d.tileIds.length < 1 ||
      d.tileIds.length > 7 ||
      !d.tileIds.every(validTileId) ||
      d.placements !== undefined
    )
      throw new HttpsError(
        "invalid-argument",
        "Choose between one and seven tiles to exchange.",
      );
    command.tileIds = d.tileIds;
  } else if (d.placements !== undefined || d.tileIds !== undefined) {
    throw new HttpsError(
      "invalid-argument",
      "This action does not take any tiles.",
    );
  }
  return command;
}
function uidRequired(uid: string | undefined): string {
  if (!uid)
    throw new HttpsError(
      "unauthenticated",
      "Please connect this iPad using your setup code.",
    );
  return uid;
}
export function publicGame(game: Game) {
  const { racks, bag, ...shared } = game;
  return {
    ...shared,
    rackCounts: { mom: racks.mom.length, aunt: racks.aunt.length },
    bagCount: bag.length,
  };
}
function writeGame(tx: FirebaseFirestore.Transaction, game: Game) {
  const ref = db.doc(`games/${game.id}`);
  tx.set(ref, publicGame(game));
  tx.set(ref.collection("racks").doc("mom"), { tiles: game.racks.mom });
  tx.set(ref.collection("racks").doc("aunt"), { tiles: game.racks.aunt });
  tx.set(ref.collection("private").doc("state"), { bag: game.bag });
}
/** Read only at game end; reuse the existing heartbeat writes for activity. */
async function readOnlineGameTime(
  tx: FirebaseFirestore.Transaction,
  game: FirebaseFirestore.DocumentData,
  endedAt: number,
) {
  const presence = await tx.get(db.collection("pairs/family/presence"));
  const devices = presence.docs.flatMap((doc) => {
    const data = doc.data();
    const activity = slots.includes(data.slot)
      ? readOnlinePresence(data)
      : null;
    return activity ? [activity] : [];
  });
  const cutoff =
    game.winCondition === "timed" && Number.isFinite(game.deadlineAt)
      ? Math.min(endedAt, game.deadlineAt)
      : endedAt;
  return onlineGameTime(devices, game.startedAt, cutoff);
}
function sameTiles(before: readonly Tile[], after: readonly Tile[]) {
  return (
    before.length === after.length &&
    before.every(
      (tile, index) =>
        tile.id === after[index].id &&
        tile.letter === after[index].letter &&
        tile.value === after[index].value,
    )
  );
}
/** Preserve private documents that did not change, including their draw order. */
function writeGameChanges(
  tx: FirebaseFirestore.Transaction,
  before: Game,
  after: Game,
) {
  if (before.id !== after.id) {
    writeGame(tx, after);
    return;
  }
  const ref = db.doc(`games/${after.id}`);
  tx.set(ref, publicGame(after));
  for (const slot of slots) {
    if (!sameTiles(before.racks[slot], after.racks[slot]))
      tx.set(ref.collection("racks").doc(slot), { tiles: after.racks[slot] });
  }
  if (!sameTiles(before.bag, after.bag))
    tx.set(ref.collection("private").doc("state"), { bag: after.bag });
}
function currentBinding(
  binding: FirebaseFirestore.DocumentData | undefined,
  player: FirebaseFirestore.DocumentData | undefined,
  uid: string,
) {
  if (!binding || !player) return false;
  const version = player.sessionVersion ?? 0;
  return (
    Number.isSafeInteger(version) &&
    version >= 0 &&
    (binding.sessionVersion === undefined
      ? version === 0 && player.uid === uid
      : binding.sessionVersion === version)
  );
}

/** Reusable credentials add a private device session; they never replace another. */
export async function login(
  uidInput: string | undefined,
  data: unknown,
): Promise<{ slot: Slot }> {
  const uid = uidRequired(uidInput);
  const d = object(data);
  onlyKeys(d, ["playerId", "passphrase"]);
  if (!slots.includes(d.playerId as Slot) || !validLoginSecret(d.passphrase))
    throw new HttpsError(
      "invalid-argument",
      "Choose your player and enter your private six-digit code or existing passphrase.",
    );
  const slot = d.playerId as Slot,
    passphrase = d.passphrase;
  const outcome = await db.runTransaction(async (tx) => {
    const bindingRef = db.doc(`bindings/${uid}`),
      attemptRef = db.doc(`enrollmentAttempts/${hash(uid)}`),
      sharedRef = db.doc(`loginAttempts/${slot}`);
    const [binding, player, credential, attempt, shared] = await tx.getAll(
      bindingRef,
      db.doc(`players/${slot}`),
      db.doc(`playerCredentials/${slot}`),
      attemptRef,
      sharedRef,
    );
    if (binding.exists && binding.data()?.slot !== slot)
      throw new HttpsError(
        "failed-precondition",
        "This browser is signed in as the other player. Use a different browser or device.",
      );
    const now = Date.now();
    const limits = [attempt, shared].map((snapshot) => {
      const record = snapshot.data();
      const active = record && now - record.windowStart < 3600000;
      return {
        windowStart: active ? record.windowStart : now,
        count: active ? Number(record.count) : 0,
      };
    });
    const alreadyBound =
      binding.data()?.slot === slot &&
      currentBinding(binding.data(), player.data(), uid);
    const exhausted = limits.filter((limit) => limit.count >= 10);
    if (exhausted.length && !alreadyBound)
      return {
        error: "resource-exhausted" as const,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(
            Math.max(
              ...exhausted.map((limit) => limit.windowStart + 3600000 - now),
            ) / 1000,
          ),
        ),
      };
    if (
      !player.exists ||
      !credential.exists ||
      credential.data()?.enabled !== true ||
      !(await verifyCredential(passphrase, credential.data()!))
    ) {
      tx.set(attemptRef, {
        windowStart: limits[0].windowStart,
        count: limits[0].count + 1,
      });
      tx.set(sharedRef, {
        windowStart: limits[1].windowStart,
        count: limits[1].count + 1,
      });
      return { error: "permission-denied" as const };
    }
    if (!alreadyBound)
      tx.set(bindingRef, {
        slot,
        sessionVersion: player.data()!.sessionVersion ?? 0,
        signedInAt: now,
      });
    return { slot };
  });
  if ("error" in outcome)
    throw new HttpsError(
      outcome.error!,
      outcome.error === "resource-exhausted"
        ? "Too many sign-in attempts. Please wait before trying again."
        : "The player or sign-in code is not correct.",
      outcome.error === "resource-exhausted"
        ? { rule: "rate-limit", retryAfterSeconds: outcome.retryAfterSeconds }
        : undefined,
    );
  return { slot };
}

/** Redeeming a replacement code atomically revokes the previous device's membership. */
export async function enroll(
  uidInput: string | undefined,
  data: unknown,
): Promise<{ slot: Slot }> {
  const uid = uidRequired(uidInput);
  const d = object(data);
  onlyKeys(d, ["code"]);
  if (typeof d.code !== "string" || d.code.length > 100)
    throw new HttpsError(
      "invalid-argument",
      "Enter the private setup code you were given.",
    );
  const code = d.code.replace(/[\s-]/g, "").toUpperCase();
  // Familiar words are one-time setup tickets. Previously issued random
  // eight-character and 32-character hexadecimal tickets remain compatible.
  const isWord = /^[A-Z]{5,7}$/.test(code);
  if (
    !isWord &&
    !/^(?:[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}|[A-F0-9]{32})$/.test(code)
  )
    throw new HttpsError(
      "invalid-argument",
      "That setup code is not recognised.",
    );
  // Retain the attempt on failure by returning an outcome instead of throwing in the transaction.
  const outcome = await db.runTransaction(async (tx) => {
    const attemptRef = db.doc(`enrollmentAttempts/${hash(uid)}`);
    const codeRef = db.doc(`setupCodes/${hash(code)}`);
    const bindingRef = db.doc(`bindings/${uid}`);
    const [attempt, setup, binding, sharedAttempt] = await tx.getAll(
      attemptRef,
      codeRef,
      bindingRef,
      ...(isWord ? [db.doc(WORD_FAILURE_BUCKET)] : []),
    );
    const now = Date.now();
    const prior = attempt.data();
    const sameWindow = prior && now - prior.windowStart < 60 * 60 * 1000;
    const count = sameWindow ? Number(prior.count) : 0;
    const record = setup.data();
    const knownSlot = record && slots.includes(record.slot);
    let player: FirebaseFirestore.DocumentSnapshot | undefined;
    if (knownSlot) player = await tx.get(db.doc(`players/${record.slot}`));
    // An already accepted redemption is a receipt, so its bound owner can retry
    // even when failures have exhausted a bucket or the original ticket expired.
    if (
      knownSlot &&
      record.consumedUid === uid &&
      binding.data()?.slot === record.slot &&
      currentBinding(binding.data(), player?.data(), uid)
    )
      return { slot: record.slot as Slot };
    const shared = sharedAttempt?.data();
    const sharedWindow = shared && now - shared.windowStart < 60 * 60 * 1000;
    const sharedCount = sharedWindow ? Number(shared.count) : 0;
    // Gate before looking at validity: bypassing this for a correct guess would
    // allow unlimited guesses after the quota was exhausted.
    if (count >= 10 || (isWord && sharedCount >= 10)) {
      const waits = [
        ...(count >= 10 ? [prior!.windowStart + 60 * 60 * 1000 - now] : []),
        ...(isWord && sharedCount >= 10
          ? [shared!.windowStart + 60 * 60 * 1000 - now]
          : []),
      ];
      return {
        error: "resource-exhausted" as const,
        retryAfterSeconds: Math.max(1, Math.ceil(Math.max(...waits) / 1000)),
      };
    }
    tx.set(attemptRef, {
      windowStart: sameWindow ? prior.windowStart : now,
      count: count + 1,
    });
    if (
      !knownSlot ||
      !(record.expiresAt > now) ||
      record.consumedUid ||
      !player?.exists
    ) {
      if (isWord)
        tx.set(db.doc(WORD_FAILURE_BUCKET), {
          windowStart: sharedWindow ? shared.windowStart : now,
          count: sharedCount + 1,
        });
      return { error: "permission-denied" as const };
    }
    const slot = record.slot as Slot;
    if (binding.exists && binding.data()?.slot !== slot) {
      if (isWord)
        tx.set(db.doc(WORD_FAILURE_BUCKET), {
          windowStart: sharedWindow ? shared.windowStart : now,
          count: sharedCount + 1,
        });
      return { error: "failed-precondition" as const };
    }
    const oldUid = player.data()?.uid;
    if (oldUid && oldUid !== uid) tx.delete(db.doc(`bindings/${oldUid}`));
    tx.set(bindingRef, {
      slot,
      sessionVersion: player.data()?.sessionVersion ?? 0,
    });
    tx.set(player.ref, { uid }, { merge: true });
    tx.update(codeRef, { consumedUid: uid, consumedAt: now });
    return { slot };
  });
  if ("error" in outcome)
    throw new HttpsError(
      outcome.error!,
      outcome.error === "resource-exhausted"
        ? "Too many setup attempts. Please wait before trying again."
        : "That code has expired or has already been used. Ask for a new setup code.",
      outcome.error === "resource-exhausted"
        ? { rule: "rate-limit", retryAfterSeconds: outcome.retryAfterSeconds }
        : undefined,
    );
  return { slot: outcome.slot! };
}

async function requireMember(
  tx: FirebaseFirestore.Transaction,
  uid: string,
): Promise<{ slot: Slot; pair: FirebaseFirestore.DocumentSnapshot }> {
  const binding = await tx.get(db.doc(`bindings/${uid}`));
  const slot = binding.data()?.slot as Slot;
  if (!slots.includes(slot))
    throw new HttpsError(
      "permission-denied",
      "This device is not connected to a player.",
    );
  const [player, pair] = await tx.getAll(
    db.doc(`players/${slot}`),
    db.doc("pairs/family"),
  );
  if (!currentBinding(binding.data(), player.data(), uid))
    throw new HttpsError(
      "permission-denied",
      "This session has been revoked. Please sign in again.",
    );
  if (!pair.exists)
    throw new HttpsError(
      "failed-precondition",
      "The family game has not been prepared yet.",
    );
  return { slot, pair };
}

function normalizeWord(value: unknown): string {
  if (typeof value !== "string" || value.length > 100)
    throw new HttpsError(
      "invalid-argument",
      "Enter a word of two to fifteen letters.",
    );
  const word = value.trim();
  if (!/^[A-Za-z]{2,15}$/.test(word))
    throw new HttpsError(
      "invalid-argument",
      "Use two to fifteen English letters, without spaces or punctuation.",
    );
  return word.toUpperCase();
}

/** A proposal records consent intent only; no game, rack or turn is changed. */
export async function requestHouseWord(
  uidInput: string | undefined,
  data: unknown,
): Promise<{ id: string }> {
  const uid = uidRequired(uidInput);
  const d = object(data);
  onlyKeys(d, ["word"]);
  const word = normalizeWord(d.word);
  return db.runTransaction(async (tx) => {
    const { slot } = await requireMember(tx, uid);
    if (dictionary.has(word))
      throw new HttpsError(
        "failed-precondition",
        `${word} is already in our dictionary.`,
      );
    const id = `${slot}-${word}`;
    const ref = db.doc(`pairs/family/wordRequests/${id}`);
    const [saved, approved] = await tx.getAll(
      ref,
      db.doc(`pairs/family/houseWords/${word}`),
    );
    const existing = saved.data() as WordRequest | undefined;
    if (existing?.status === "pending" || existing?.status === "accepted")
      return { id };
    if (approved.exists)
      throw new HttpsError(
        "failed-precondition",
        `${word} is already accepted in your house dictionary.`,
      );
    const request: WordRequest = {
      id,
      word,
      requestedBy: slot,
      status: "pending",
      requestedAt: Math.max(Date.now(), (existing?.requestedAt ?? 0) + 1),
    };
    // Replacement clears an earlier decline's response fields.
    tx.set(ref, request);
    return { id };
  });
}

export async function respondHouseWord(
  uidInput: string | undefined,
  data: unknown,
): Promise<{ status: "accepted" | "declined" }> {
  const uid = uidRequired(uidInput);
  const d = object(data);
  onlyKeys(d, ["requestId", "approve", "expectedRequestedAt"]);
  if (
    typeof d.requestId !== "string" ||
    !/^(mom|aunt)-[A-Z]{2,15}$/.test(d.requestId) ||
    typeof d.approve !== "boolean"
  )
    throw new HttpsError(
      "invalid-argument",
      "Choose whether to accept this word request.",
    );
  if (
    !Number.isSafeInteger(d.expectedRequestedAt) ||
    (d.expectedRequestedAt as number) <= 0
  )
    throw new HttpsError(
      "invalid-argument",
      "Please reload the game before answering this word request.",
    );
  const requestId = d.requestId;
  const approve = d.approve;
  const expectedRequestedAt = d.expectedRequestedAt;
  return db.runTransaction(async (tx) => {
    const { slot } = await requireMember(tx, uid);
    const ref = db.doc(`pairs/family/wordRequests/${requestId}`);
    const saved = await tx.get(ref);
    if (!saved.exists)
      throw new HttpsError("not-found", "This word request no longer exists.");
    const request = saved.data() as WordRequest;
    if (
      !slots.includes(request.requestedBy) ||
      request.id !== requestId ||
      requestId !== `${request.requestedBy}-${request.word}`
    )
      throw new HttpsError(
        "internal",
        "The saved word request is incomplete. Please contact the administrator.",
      );
    if (request.requestedBy === slot)
      throw new HttpsError(
        "permission-denied",
        "Your opponent must decide whether to accept your word.",
      );
    if (request.requestedAt !== expectedRequestedAt)
      throw new HttpsError(
        "failed-precondition",
        "This word has been requested again. Please review the new request before answering.",
      );
    const status = approve ? ("accepted" as const) : ("declined" as const);
    if (request.status !== "pending") {
      if (request.status === status) return { status };
      throw new HttpsError(
        "failed-precondition",
        "This request has already received a different answer.",
      );
    }
    const houseRef = db.doc(`pairs/family/houseWords/${request.word}`);
    const house = approve ? await tx.get(houseRef) : null;
    const at = Date.now();
    tx.update(ref, { status, respondedBy: slot, respondedAt: at });
    if (approve && !house?.exists) {
      const accepted: HouseWord = {
        word: request.word,
        requestedBy: request.requestedBy,
        approvedBy: slot,
        approvedAt: at,
      };
      tx.create(houseRef, accepted);
    }
    return { status };
  });
}

/** One outstanding proposal per current game; submitting it never changes play. */
export async function requestGameRestart(
  uidInput: string | undefined,
  data: unknown,
): Promise<{ id: string }> {
  const uid = uidRequired(uidInput);
  const d = object(data);
  onlyKeys(d, ["id", "gameId", "winCondition", "durationMinutes"]);
  if (!validId(d.id) || d.id.length < 8 || !validId(d.gameId))
    throw new HttpsError(
      "invalid-argument",
      "Choose the current game and a valid request ID.",
    );
  const { id, gameId } = d;
  if (
    d.winCondition !== undefined &&
    !["classic", "turn-limit", "target-score", "timed"].includes(
      d.winCondition as string,
    )
  )
    throw new HttpsError(
      "invalid-argument",
      "Choose Classic, 10 turns each, First to 150, or a timed game.",
    );
  const winCondition = (d.winCondition ?? "classic") as WinCondition;
  if (
    (winCondition !== "timed" && d.durationMinutes !== undefined) ||
    (winCondition === "timed" &&
      d.durationMinutes !== undefined &&
      (!Number.isInteger(d.durationMinutes) ||
        (d.durationMinutes as number) < 1 ||
        (d.durationMinutes as number) > 1440))
  )
    throw new HttpsError(
      "invalid-argument",
      "For a timed game, choose a whole number of minutes from 1 to 1440.",
    );
  const durationMinutes =
    winCondition === "timed"
      ? ((d.durationMinutes ?? 25) as number)
      : undefined;
  return db.runTransaction(async (tx) => {
    const { slot, pair } = await requireMember(tx, uid);
    const pairRef = db.doc("pairs/family");
    const ref = db.doc(`pairs/family/gameRequests/${id}`);
    const [saved, current] = await tx.getAll(ref, db.doc(`games/${gameId}`));
    if (saved.exists) {
      const previous = saved.data() as NewGameRequest;
      if (
        previous.requestedBy !== slot ||
        previous.gameId !== gameId ||
        (previous.winCondition ?? "classic") !== winCondition ||
        (winCondition === "timed" &&
          (previous.durationMinutes ?? 25) !== durationMinutes)
      )
        throw new HttpsError(
          "already-exists",
          "This request ID was already used for another proposal.",
        );
      return { id };
    }
    if (pair.data()?.activeGameId !== gameId || !current.exists)
      throw new HttpsError(
        "failed-precondition",
        "A newer game is ready. Please use the current board.",
      );
    if (!["active", "finished"].includes(current.data()?.status))
      throw new HttpsError(
        "failed-precondition",
        "This saved match is not ready for a new game.",
      );
    const pendingId = pair.data()?.pendingNewGameRequestId;
    if (typeof pendingId === "string") {
      const pending = await tx.get(
        db.doc(`pairs/family/gameRequests/${pendingId}`),
      );
      const existing = pending.data() as NewGameRequest | undefined;
      if (existing?.status === "pending" && existing.gameId === gameId)
        return { id: existing.id };
    }
    const request: NewGameRequest = {
      id,
      gameId,
      requestedBy: slot,
      status: "pending",
      requestedAt: Date.now(),
      winCondition,
      ...(winCondition === "timed" ? { durationMinutes } : {}),
    };
    tx.create(ref, request);
    tx.update(pairRef, { pendingNewGameRequestId: id });
    return { id };
  });
}

/** Only the other current seat may replace a match; outcomes survive reply loss. */
export async function respondGameRestart(
  uidInput: string | undefined,
  data: unknown,
): Promise<NewGameResponse> {
  const uid = uidRequired(uidInput);
  const d = object(data);
  onlyKeys(d, ["requestId", "approve"]);
  if (
    !validId(d.requestId) ||
    d.requestId.length < 8 ||
    typeof d.approve !== "boolean"
  )
    throw new HttpsError(
      "invalid-argument",
      "Choose whether to start the requested new game.",
    );
  const { requestId, approve } = d;
  const newGameId = randomUUID();
  return db.runTransaction(async (tx) => {
    const { slot, pair } = await requireMember(tx, uid);
    const pairRef = db.doc("pairs/family");
    const ref = db.doc(`pairs/family/gameRequests/${requestId}`);
    const saved = await tx.get(ref);
    if (!saved.exists)
      throw new HttpsError(
        "not-found",
        "This new game request no longer exists.",
      );
    const request = saved.data() as NewGameRequest;
    if (
      request.id !== requestId ||
      !slots.includes(request.requestedBy) ||
      !validId(request.gameId)
    )
      throw new HttpsError(
        "internal",
        "The saved new game request is incomplete. Please contact the administrator.",
      );
    if (request.requestedBy === slot)
      throw new HttpsError(
        "permission-denied",
        "Your opponent must decide whether to start your new game.",
      );
    const status = approve ? ("accepted" as const) : ("declined" as const);
    if (request.status !== "pending") {
      if (request.status !== status)
        throw new HttpsError(
          "failed-precondition",
          "This request has already received a different answer.",
        );
      return {
        status,
        ...(request.newGameId ? { newGameId: request.newGameId } : {}),
      };
    }
    if (
      pair.data()?.activeGameId !== request.gameId ||
      pair.data()?.pendingNewGameRequestId !== requestId
    )
      throw new HttpsError(
        "failed-precondition",
        "This request belongs to an older game. Please use the current board.",
      );
    const oldRef = db.doc(`games/${request.gameId}`);
    const old = await tx.get(oldRef);
    if (!old.exists || !["active", "finished"].includes(old.data()?.status))
      throw new HttpsError(
        "failed-precondition",
        "This saved match is not ready for a new game.",
      );
    const at = Date.now();
    const expiredFields =
      approve &&
      old.data()!.status === "active" &&
      timerExpired(old.data()!, at)
        ? await timerFinishFields(tx, oldRef, old.data()!, at)
        : null;
    const abandonedAdjustments =
      approve && old.data()!.status === "active" && !expiredFields
        ? await readScoreAdjustments(tx, oldRef, old.data()!, "new-game")
        : null;
    const abandonedTime =
      approve && old.data()!.status === "active" && !expiredFields
        ? await readOnlineGameTime(tx, old.data()!, at)
        : {};
    tx.update(ref, {
      status,
      respondedBy: slot,
      respondedAt: at,
      ...(approve ? { newGameId } : {}),
    });
    if (!approve) {
      tx.update(pairRef, { pendingNewGameRequestId: null });
      return { status };
    }
    const winCondition = request.winCondition ?? "classic";
    if (
      !["classic", "turn-limit", "target-score", "timed"].includes(winCondition)
    )
      throw new HttpsError(
        "internal",
        "The saved new game choice is incomplete. Please contact the administrator.",
      );
    const next = createGame(
      newGameId,
      cryptoRandom,
      winCondition,
      request.durationMinutes ?? 25,
      at,
    );
    writeGame(tx, next);
    // Preserve the old board, scores, private tiles and receipts as history.
    // This is an agreed replacement, not a scored win or a rack deduction.
    tx.update(oldRef, {
      replacedByGameId: newGameId,
      replacedAt: at,
      ...(old.data()!.status === "active"
        ? (expiredFields ?? {
            status: "finished",
            winner: null,
            revision: old.data()!.revision + 1,
            endedReason: "new-game",
            endedAt: at,
            ...abandonedTime,
            finalScoreAdjustments: abandonedAdjustments,
          })
        : {}),
    });
    tx.update(pairRef, {
      activeGameId: newGameId,
      pendingNewGameRequestId: null,
    });
    return { status, newGameId };
  });
}

/** Empty-bag consent pauses accepted turns at exactly the proposed revision. */
export async function requestGameEnd(
  uidInput: string | undefined,
  data: unknown,
): Promise<{ id: string }> {
  const uid = uidRequired(uidInput);
  const d = object(data);
  onlyKeys(d, ["id", "gameId", "expectedRevision"]);
  if (
    !validId(d.id) ||
    d.id.length < 8 ||
    !validId(d.gameId) ||
    !Number.isSafeInteger(d.expectedRevision) ||
    (d.expectedRevision as number) < 0
  )
    throw new HttpsError(
      "invalid-argument",
      "Choose the current board and a valid end-game request.",
    );
  const { id, gameId } = d;
  const expectedRevision = d.expectedRevision as number;
  return db.runTransaction(async (tx) => {
    const { slot, pair } = await requireMember(tx, uid);
    const pairRef = db.doc("pairs/family");
    const ref = db.doc(`pairs/family/endGameRequests/${id}`);
    const retryRef = db.doc(`endGameRequestReceipts/${id}`);
    const [saved, current, secret, retry] = await tx.getAll(
      ref,
      db.doc(`games/${gameId}`),
      db.doc(`games/${gameId}/private/state`),
      retryRef,
    );
    // A simultaneous proposal can be coalesced into someone else's pending
    // UUID. Preserve that result even if its response was lost until after
    // the opponent declined, played another turn, or replaced the table.
    if (retry.exists) {
      const previous = retry.data()!;
      if (
        previous.requestedBy !== slot ||
        previous.gameId !== gameId ||
        previous.expectedRevision !== expectedRevision
      )
        throw new HttpsError(
          "already-exists",
          "This request ID was already used for a different action.",
        );
      if (!validId(previous.resolvedRequestId))
        throw new HttpsError(
          "internal",
          "The saved end-game request receipt is incomplete.",
        );
      return { id: previous.resolvedRequestId };
    }
    if (saved.exists) {
      const previous = saved.data() as EndGameRequest;
      if (
        previous.requestedBy !== slot ||
        previous.gameId !== gameId ||
        previous.expectedRevision !== expectedRevision
      )
        throw new HttpsError(
          "already-exists",
          "This request ID was already used for a different action.",
        );
      return { id };
    }
    if (
      pair.data()?.activeGameId !== gameId ||
      !current.exists ||
      current.data()?.status !== "active" ||
      current.data()?.revision !== expectedRevision
    )
      throw new HttpsError(
        "failed-precondition",
        "The board changed. Please review the current game before asking to end it.",
      );
    if (!secret.exists || !Array.isArray(secret.data()?.bag))
      throw new HttpsError("internal", "The saved game is incomplete.");
    if (current.data()?.bagCount !== 0 || secret.data()!.bag.length !== 0)
      throw new HttpsError(
        "failed-precondition",
        "You can ask to end the game once the bag is empty.",
      );
    if (timerExpired(current.data()!, Date.now()))
      throw new HttpsError(
        "failed-precondition",
        "Time is up. Reconnect to confirm the final score.",
      );
    const pendingId = pair.data()?.pendingEndGameRequestId;
    if (typeof pendingId === "string") {
      const pending = (
        await tx.get(db.doc(`pairs/family/endGameRequests/${pendingId}`))
      ).data() as EndGameRequest | undefined;
      if (
        pending?.status === "pending" &&
        pending.gameId === gameId &&
        pending.expectedRevision === expectedRevision
      ) {
        tx.create(retryRef, {
          requestedBy: slot,
          gameId,
          expectedRevision,
          resolvedRequestId: pending.id,
        });
        return { id: pending.id };
      }
    }
    const request: EndGameRequest = {
      id,
      gameId,
      expectedRevision,
      requestedBy: slot,
      status: "pending",
      requestedAt: Date.now(),
    };
    tx.create(ref, request);
    tx.update(pairRef, { pendingEndGameRequestId: id });
    return { id };
  });
}

export async function respondGameEnd(
  uidInput: string | undefined,
  data: unknown,
): Promise<EndGameResponse> {
  const uid = uidRequired(uidInput);
  const d = object(data);
  onlyKeys(d, ["requestId", "approve"]);
  if (
    !validId(d.requestId) ||
    d.requestId.length < 8 ||
    typeof d.approve !== "boolean"
  )
    throw new HttpsError(
      "invalid-argument",
      "Choose whether to end the requested game.",
    );
  const { requestId, approve } = d;
  return db.runTransaction(async (tx) => {
    const { slot, pair } = await requireMember(tx, uid);
    const ref = db.doc(`pairs/family/endGameRequests/${requestId}`);
    const pairRef = db.doc("pairs/family");
    const saved = await tx.get(ref);
    if (!saved.exists)
      throw new HttpsError(
        "not-found",
        "This end-game request no longer exists.",
      );
    const request = saved.data() as EndGameRequest;
    if (
      request.id !== requestId ||
      !slots.includes(request.requestedBy) ||
      !validId(request.gameId) ||
      !Number.isSafeInteger(request.expectedRevision)
    )
      throw new HttpsError(
        "internal",
        "The saved end-game request is incomplete.",
      );
    if (request.requestedBy === slot)
      throw new HttpsError(
        "permission-denied",
        "Your opponent must decide whether to end the game.",
      );
    const status = approve ? ("accepted" as const) : ("declined" as const);
    if (request.status !== "pending") {
      if (request.status !== status)
        throw new HttpsError(
          "failed-precondition",
          "This request has already received a different answer.",
        );
      return {
        status,
        gameId: request.gameId,
        revision: request.finishedRevision ?? request.expectedRevision,
      };
    }
    const gameRef = db.doc(`games/${request.gameId}`);
    const game = await tx.get(gameRef);
    if (
      pair.data()?.activeGameId !== request.gameId ||
      pair.data()?.pendingEndGameRequestId !== requestId ||
      !game.exists ||
      game.data()?.status !== "active" ||
      game.data()?.revision !== request.expectedRevision
    )
      throw new HttpsError(
        "failed-precondition",
        "This request belongs to an older board. Please review the current game.",
      );
    let at = Date.now();
    let fields: FirebaseFirestore.DocumentData | null = null;
    if (approve) {
      const secret = await tx.get(gameRef.collection("private").doc("state"));
      if (!secret.exists || !Array.isArray(secret.data()?.bag))
        throw new HttpsError("internal", "The saved game is incomplete.");
      if (game.data()?.bagCount !== 0 || secret.data()!.bag.length !== 0)
        throw new HttpsError(
          "failed-precondition",
          "The bag is no longer empty. Please review the current game.",
        );
      let finalScoreAdjustments = await readScoreAdjustments(
        tx,
        gameRef,
        game.data()!,
        "agreed-end",
      );
      // A clock that expires while private racks are read still wins over
      // the voluntary end; timeout never deducts remaining rack points.
      at = Date.now();
      const reason = timerExpired(game.data()!, at) ? "timed" : "agreed-end";
      if (reason === "timed")
        finalScoreAdjustments = scoreAdjustments(
          game.data()!.scores,
          {
            mom: finalScoreAdjustments.players.mom.rackValue,
            aunt: finalScoreAdjustments.players.aunt.rackValue,
          },
          "timed",
        );
      const scores = {
        mom: finalScoreAdjustments.players.mom.final,
        aunt: finalScoreAdjustments.players.aunt.final,
      };
      fields = {
        status: "finished",
        scores,
        revision: game.data()!.revision + 1,
        winner:
          scores.mom === scores.aunt
            ? "tie"
            : scores.mom > scores.aunt
              ? "mom"
              : "aunt",
        endedReason: reason,
        endedAt: at,
        ...(await readOnlineGameTime(tx, game.data()!, at)),
        finalScoreAdjustments,
      };
    }
    const revision = fields?.revision ?? request.expectedRevision;
    tx.update(ref, {
      status,
      respondedBy: slot,
      respondedAt: at,
      ...(approve ? { finishedRevision: revision } : {}),
    });
    tx.update(pairRef, { pendingEndGameRequestId: null });
    if (fields) tx.update(gameRef, fields);
    return { status, gameId: request.gameId, revision };
  });
}

function timerExpired(
  game: FirebaseFirestore.DocumentData,
  now: number,
): boolean {
  if (game.winCondition !== "timed" || game.status !== "active") return false;
  if (!Number.isSafeInteger(game.deadlineAt))
    throw new HttpsError(
      "internal",
      "This game's clock is unavailable. Please contact the administrator.",
    );
  return now >= game.deadlineAt;
}
async function readScoreAdjustments(
  tx: FirebaseFirestore.Transaction,
  ref: FirebaseFirestore.DocumentReference,
  game: FirebaseFirestore.DocumentData,
  reason: "timed" | "new-game" | "agreed-end",
) {
  const [momRack, auntRack] = await tx.getAll(
    ref.collection("racks").doc("mom"),
    ref.collection("racks").doc("aunt"),
  );
  if (!momRack.exists || !auntRack.exists)
    throw new HttpsError("internal", "The saved game is incomplete.");
  const rackValues = {
    mom: momRack
      .data()!
      .tiles.reduce(
        (sum: number, tile: { value: number }) => sum + tile.value,
        0,
      ),
    aunt: auntRack
      .data()!
      .tiles.reduce(
        (sum: number, tile: { value: number }) => sum + tile.value,
        0,
      ),
  };
  return scoreAdjustments(game.scores, rackValues, reason);
}
async function timerFinishFields(
  tx: FirebaseFirestore.Transaction,
  ref: FirebaseFirestore.DocumentReference,
  game: FirebaseFirestore.DocumentData,
  now: number,
) {
  const finalScoreAdjustments = await readScoreAdjustments(
    tx,
    ref,
    game,
    "timed",
  );
  const { mom, aunt } = game.scores;
  return {
    status: "finished" as const,
    winner:
      mom === aunt
        ? ("tie" as const)
        : mom > aunt
          ? ("mom" as const)
          : ("aunt" as const),
    revision: game.revision + 1,
    endedReason: "timed" as const,
    endedAt: now,
    ...(await readOnlineGameTime(tx, game, now)),
    finalScoreAdjustments,
  };
}
interface ExpiredSubmission {
  expired: true;
  gameId: string;
  revision: number;
}
async function finishLateSubmission(
  tx: FirebaseFirestore.Transaction,
  ref: FirebaseFirestore.DocumentReference,
  game: FirebaseFirestore.DocumentData,
  now: number,
  kind: Command["kind"],
): Promise<ExpiredSubmission | null> {
  if (timerExpired(game, now)) {
    const fields = await timerFinishFields(tx, ref, game, now);
    tx.update(ref, fields);
    return { expired: true, gameId: ref.id, revision: fields.revision };
  }
  if (
    game.winCondition === "timed" &&
    game.status === "finished" &&
    game.endedReason === "timed" &&
    kind !== "rematch"
  )
    return { expired: true, gameId: ref.id, revision: game.revision };
  return null;
}

/** Clients wake this on expiry/resume; server time alone decides the outcome. */
export async function finishGameTimer(
  uidInput: string | undefined,
  data: unknown,
): Promise<TimedGameResult> {
  const uid = uidRequired(uidInput);
  const d = object(data);
  onlyKeys(d, ["gameId"]);
  if (!validId(d.gameId))
    throw new HttpsError("invalid-argument", "Choose the current timed game.");
  const gameId = d.gameId;
  return db.runTransaction(async (tx) => {
    const { pair } = await requireMember(tx, uid);
    const ref = db.doc(`games/${gameId}`);
    const saved = await tx.get(ref);
    if (!saved.exists)
      throw new HttpsError("not-found", "This timed game no longer exists.");
    const game = saved.data()!;
    if (game.winCondition !== "timed")
      throw new HttpsError(
        "failed-precondition",
        "This game does not use a timer.",
      );
    const serverNow = Date.now();
    if (game.status === "finished")
      return { gameId, revision: game.revision, status: "finished", serverNow };
    if (pair.data()?.activeGameId !== gameId)
      throw new HttpsError(
        "failed-precondition",
        "A newer game is ready. Please use the current board.",
      );
    if (!timerExpired(game, serverNow))
      return { gameId, revision: game.revision, status: "active", serverNow };
    const fields = await timerFinishFields(tx, ref, game, serverNow);
    tx.update(ref, fields);
    return { gameId, revision: fields.revision, status: "finished", serverNow };
  });
}

export async function submit(
  uidInput: string | undefined,
  data: unknown,
): Promise<CommandResult> {
  const uid = uidRequired(uidInput);
  const command = validateCommand(data);
  const payloadHash = hash(JSON.stringify(command));
  const newGameId = randomUUID();
  const serverReceivedAt = Date.now();
  let transactionAttempts = 0;
  let diagnosticSlot: Slot | undefined;
  let replayed = false;
  try {
    const outcome = await db.runTransaction<CommandResult | ExpiredSubmission>(
      async (tx) => {
        transactionAttempts++;
        replayed = false;
        const binding = await tx.get(db.doc(`bindings/${uid}`));
        const slot = binding.data()?.slot as Slot;
        diagnosticSlot = slot;
        if (!slots.includes(slot))
          throw new HttpsError(
            "permission-denied",
            "This device is not connected to a player.",
          );
        const gameRef = db.doc(`games/${command.gameId}`);
        const resultRef = gameRef.collection("commands").doc(command.id);
        const [player, pair, saved, recorded] = await tx.getAll(
          db.doc(`players/${slot}`),
          db.doc("pairs/family"),
          gameRef,
          resultRef,
        );
        if (!currentBinding(binding.data(), player.data(), uid))
          throw new HttpsError(
            "permission-denied",
            "This device has been replaced. Please use a new setup code.",
          );
        // This check deliberately precedes revision, active-game and turn validation.
        if (recorded.exists) {
          replayed = true;
          const previous = recorded.data()!;
          if (previous.uid !== uid || previous.payloadHash !== payloadHash)
            throw new HttpsError(
              "already-exists",
              "This move ID was already used for a different action.",
            );
          return previous.result as CommandResult;
        }
        if (!saved.exists || pair.data()?.activeGameId !== command.gameId)
          throw new HttpsError(
            "failed-precondition",
            "A newer game is ready. Please use the current board.",
          );
        const expiredBeforeReads = await finishLateSubmission(
          tx,
          gameRef,
          saved.data()!,
          Date.now(),
          command.kind,
        );
        if (expiredBeforeReads) return expiredBeforeReads;
        const endRequestId = pair.data()?.pendingEndGameRequestId;
        if (typeof endRequestId === "string") {
          const endRequest = (
            await tx.get(db.doc(`pairs/family/endGameRequests/${endRequestId}`))
          ).data() as EndGameRequest | undefined;
          if (
            saved.data()!.status === "active" &&
            endRequest?.status === "pending" &&
            endRequest.gameId === command.gameId &&
            endRequest.expectedRevision === saved.data()!.revision
          )
            throw new HttpsError(
              "failed-precondition",
              "Please answer the end-game request before playing or passing.",
              { rule: "end-game-pending" },
            );
        }
        const [mom, aunt, secret] = await tx.getAll(
          gameRef.collection("racks").doc("mom"),
          gameRef.collection("racks").doc("aunt"),
          gameRef.collection("private").doc("state"),
        );
        if (!mom.exists || !aunt.exists || !secret.exists)
          throw new HttpsError(
            "internal",
            "The saved game is incomplete. Please contact the administrator.",
          );
        const {
          rackCounts: _counts,
          bagCount: _bagCount,
          ...shared
        } = saved.data()!;
        const game = {
          ...shared,
          racks: { mom: mom.data()!.tiles, aunt: aunt.data()!.tiles },
          bag: secret.data()!.bag,
        } as Game;
        let accepted: Game;
        let serverNow = Date.now();
        const expiredAfterReads = await finishLateSubmission(
          tx,
          gameRef,
          saved.data()!,
          serverNow,
          command.kind,
        );
        if (expiredAfterReads) return expiredAfterReads;
        try {
          accepted = applyCommand(
            game,
            slot,
            command,
            dictionary,
            cryptoRandom,
            serverNow,
          );
        } catch (error) {
          if (
            !(error instanceof RuleError) ||
            error.code !== "dictionary" ||
            command.kind !== "play"
          )
            throw error;
          // The engine already checked revision, turn, ownership and structural
          // legality. Read only the proposed words that need house approval.
          const formed = previewMove(
            game,
            game.racks[slot],
            command.placements!,
          ).words;
          const missing = [
            ...new Set(formed.filter((word) => !dictionary.has(word))),
          ];
          const house = await tx.getAll(
            ...missing.map((word) => db.doc(`pairs/family/houseWords/${word}`)),
          );
          serverNow = Date.now();
          const expiredAfterDictionary = await finishLateSubmission(
            tx,
            gameRef,
            saved.data()!,
            serverNow,
            command.kind,
          );
          if (expiredAfterDictionary) return expiredAfterDictionary;
          const unknown = missing.filter(
            (_word, index) => !house[index].exists,
          );
          if (unknown.length)
            throw new HttpsError(
              "failed-precondition",
              `Not in our dictionary: ${unknown.join(", ")}. You can edit your tiles and try again.`,
              { rule: "dictionary", words: unknown },
            );
          const withHouseWords = new Set(dictionary);
          missing.forEach((word) => withHouseWords.add(word));
          accepted = applyCommand(
            game,
            slot,
            command,
            withHouseWords,
            cryptoRandom,
            serverNow,
          );
        }
        const expiredBeforeCommit = await finishLateSubmission(
          tx,
          gameRef,
          saved.data()!,
          Date.now(),
          command.kind,
        );
        if (expiredBeforeCommit) return expiredBeforeCommit;
        if (accepted.status === "finished" && game.status !== "finished")
          Object.assign(
            accepted,
            await readOnlineGameTime(
              tx,
              saved.data()!,
              accepted.endedAt ?? serverNow,
            ),
          );
        const next =
          command.kind === "rematch"
            ? createGame(
                newGameId,
                cryptoRandom,
                game.winCondition ?? "classic",
                game.durationMinutes ?? 25,
                serverNow,
              )
            : accepted;
        const result: CommandResult = {
          commandId: command.id,
          gameId: next.id,
          revision: next.revision,
          score: command.kind === "play" ? (next.lastMove?.score ?? 0) : 0,
        };
        writeGameChanges(tx, game, next);
        if (command.kind === "rematch")
          tx.update(pair.ref, {
            activeGameId: next.id,
            pendingNewGameRequestId: null,
          });
        tx.create(resultRef, { uid, payloadHash, result });
        return result;
      },
    );
    // Throw only after the expiry write has committed. A rejected late move
    // never receives a command receipt or changes turns, rack tiles or scores.
    if ("expired" in outcome)
      throw new HttpsError(
        "failed-precondition",
        "Time is up. This game has finished.",
        { rule: "timed", gameId: outcome.gameId, revision: outcome.revision },
      );
    if (diagnosticsEnabled())
      try {
        info("Tea & Tiles move accepted", {
          event: "move-accepted",
          gameId: outcome.gameId,
          moveId: command.id,
          revision: outcome.revision,
          player: diagnosticSlot,
          kind: command.kind,
          serverReceivedAt,
          serverCommittedAt: Date.now(),
          durationMs: Date.now() - serverReceivedAt,
          transactionAttempts,
          replayed,
        });
      } catch {
        /* Logging must never change an accepted command's outcome. */
      }
    return outcome;
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    if (error instanceof RuleError)
      throw new HttpsError("failed-precondition", error.message, {
        rule: error.code,
      });
    console.error("Command failed", error);
    throw new HttpsError(
      "internal",
      "Your move could not be confirmed. Please retry the same move.",
    );
  }
}

/** Diagnostics have their own path: failure never participates in a game command. */
export async function receiveMoveDiagnostics(
  uidInput: string | undefined,
  input: unknown,
) {
  const uid = uidRequired(uidInput);
  if (!diagnosticsEnabled())
    return { enabled: false, serverNow: Date.now(), accepted: false };
  const data = object(input);
  onlyKeys(data, data.action === "clock" ? ["action"] : ["action", "report"]);
  if (data.action !== "clock" && data.action !== "report")
    throw new HttpsError("invalid-argument", "Invalid diagnostic action.");
  const report =
    data.action === "report" ? validateDiagnosticReport(data.report) : null;
  const result = await db.runTransaction(async (tx) => {
    const { slot } = await requireMember(tx, uid);
    if (!report) return { slot, accepted: false };
    const day = new Date().toISOString().slice(0, 10);
    const limitRef = db.doc(`diagnosticLimits/${hash(uid)}`);
    const [limit, saved] = await tx.getAll(
      limitRef,
      db.doc(`games/${report.gameId}`),
    );
    if (!saved.exists)
      throw new HttpsError("not-found", "Unknown diagnostic game.");
    const ids: string[] =
      limit.data()?.day === day ? limit.data()?.ids || [] : [];
    if (ids.includes(report.id) || ids.length >= MOVE_DIAGNOSTICS.dailyReports)
      return { slot, accepted: false };
    tx.set(limitRef, { day, ids: [...ids, report.id] });
    const game = saved.data()!;
    return {
      slot,
      accepted: true,
      currentRevision: game.revision,
      currentMoveId: game.lastMove?.id ?? null,
    };
  });
  if (report && result.accepted)
    warn("Tea & Tiles move delay", {
      event: "move-delay",
      player: result.slot,
      device: hash(uid).slice(0, 16),
      currentRevision: result.currentRevision,
      currentMoveId: result.currentMoveId,
      serverReportAt: Date.now(),
      report,
    });
  return { enabled: true, serverNow: Date.now(), accepted: result.accepted };
}

const options = callablePolicy();
export const reportMoveDiagnostics = onCall(options, (request) =>
  receiveMoveDiagnostics(request.auth?.uid, request.data),
);
export const enrollPlayer = onCall(options, (request) =>
  enroll(request.auth?.uid, request.data),
);
export const loginPlayer = onCall(options, (request) =>
  login(request.auth?.uid, request.data),
);
export const submitCommand = onCall(options, (request) =>
  submit(request.auth?.uid, request.data),
);
export const requestWord = onCall(options, (request) =>
  requestHouseWord(request.auth?.uid, request.data),
);
export const respondToWord = onCall(options, (request) =>
  respondHouseWord(request.auth?.uid, request.data),
);
export const requestNewGame = onCall(options, (request) =>
  requestGameRestart(request.auth?.uid, request.data),
);
export const respondToNewGame = onCall(options, (request) =>
  respondGameRestart(request.auth?.uid, request.data),
);
export const finishTimedGame = onCall(options, (request) =>
  finishGameTimer(request.auth?.uid, request.data),
);
export const requestEndGame = onCall(options, (request) =>
  requestGameEnd(request.auth?.uid, request.data),
);
export const respondToEndGame = onCall(options, (request) =>
  respondGameEnd(request.auth?.uid, request.data),
);
