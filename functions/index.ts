import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { WORD_FAILURE_BUCKET } from "./setup-words.js";
import { callablePolicy } from "./callable-policy.js";
import {
  applyCommand,
  createGame,
  RuleError,
  previewMove,
  type Command,
  type CommandResult,
  type Game,
  type Slot,
  type WinCondition,
} from "../shared/engine.js";
import type { WordRequest, HouseWord } from "../shared/dictionary.js";
import type { NewGameRequest, NewGameResponse, TimedGameResult } from "../shared/game-request.js";

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
  if (!isWord && !/^(?:[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}|[A-F0-9]{32})$/.test(code))
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
    if (knownSlot && record.consumedUid === uid && binding.data()?.slot === record.slot && player?.data()?.uid === uid)
      return { slot: record.slot as Slot };
    const shared = sharedAttempt?.data();
    const sharedWindow = shared && now - shared.windowStart < 60 * 60 * 1000;
    const sharedCount = sharedWindow ? Number(shared.count) : 0;
    // Gate before looking at validity: bypassing this for a correct guess would
    // allow unlimited guesses after the quota was exhausted.
    if (count >= 10 || (isWord && sharedCount >= 10)) {
      const waits = [
        ...(count >= 10 ? [prior!.windowStart + 60 * 60 * 1000 - now] : []),
        ...(isWord && sharedCount >= 10 ? [shared!.windowStart + 60 * 60 * 1000 - now] : []),
      ];
      return { error: "resource-exhausted" as const, retryAfterSeconds: Math.max(1, Math.ceil(Math.max(...waits) / 1000)) };
    }
    tx.set(attemptRef, {
      windowStart: sameWindow ? prior.windowStart : now,
      count: count + 1,
    });
    if (
      !knownSlot || !(record.expiresAt > now) ||
      record.consumedUid ||
      !player?.exists
    ) {
      if (isWord) tx.set(db.doc(WORD_FAILURE_BUCKET), { windowStart: sharedWindow ? shared.windowStart : now, count: sharedCount + 1 });
      return { error: "permission-denied" as const };
    }
    const slot = record.slot as Slot;
    if (binding.exists && binding.data()?.slot !== slot) {
      if (isWord) tx.set(db.doc(WORD_FAILURE_BUCKET), { windowStart: sharedWindow ? shared.windowStart : now, count: sharedCount + 1 });
      return { error: "failed-precondition" as const };
    }
    const oldUid = player.data()?.uid;
    if (oldUid && oldUid !== uid) tx.delete(db.doc(`bindings/${oldUid}`));
    tx.set(bindingRef, { slot });
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
      outcome.error === "resource-exhausted" ? { rule: "rate-limit", retryAfterSeconds: outcome.retryAfterSeconds } : undefined,
    );
  return { slot: outcome.slot! };
}

async function requireMember(tx: FirebaseFirestore.Transaction, uid: string): Promise<Slot> {
  const binding = await tx.get(db.doc(`bindings/${uid}`));
  const slot = binding.data()?.slot as Slot;
  if (!slots.includes(slot)) throw new HttpsError("permission-denied", "This device is not connected to a player.");
  const [player, pair] = await tx.getAll(db.doc(`players/${slot}`), db.doc("pairs/family"));
  if (player.data()?.uid !== uid) throw new HttpsError("permission-denied", "This device has been replaced. Please use a new invitation.");
  if (!pair.exists) throw new HttpsError("failed-precondition", "The family game has not been prepared yet.");
  return slot;
}

function normalizeWord(value: unknown): string {
  if (typeof value !== "string" || value.length > 100) throw new HttpsError("invalid-argument", "Enter a word of two to fifteen letters.");
  const word = value.trim();
  if (!/^[A-Za-z]{2,15}$/.test(word)) throw new HttpsError("invalid-argument", "Use two to fifteen English letters, without spaces or punctuation.");
  return word.toUpperCase();
}

/** A proposal records consent intent only; no game, rack or turn is changed. */
export async function requestHouseWord(uidInput: string | undefined, data: unknown): Promise<{ id: string }> {
  const uid = uidRequired(uidInput);
  const d = object(data);
  onlyKeys(d, ["word"]);
  const word = normalizeWord(d.word);
  return db.runTransaction(async tx => {
    const slot = await requireMember(tx, uid);
    if (dictionary.has(word)) throw new HttpsError("failed-precondition", `${word} is already in our dictionary.`);
    const id = `${slot}-${word}`;
    const ref = db.doc(`pairs/family/wordRequests/${id}`);
    const [saved, approved] = await tx.getAll(ref, db.doc(`pairs/family/houseWords/${word}`));
    const existing = saved.data() as WordRequest | undefined;
    if (existing?.status === "pending" || existing?.status === "accepted") return { id };
    if (approved.exists) throw new HttpsError("failed-precondition", `${word} is already accepted in your house dictionary.`);
    const request: WordRequest = { id, word, requestedBy: slot, status: "pending", requestedAt: Math.max(Date.now(), (existing?.requestedAt ?? 0) + 1) };
    // Replacement clears an earlier decline's response fields.
    tx.set(ref, request);
    return { id };
  });
}

export async function respondHouseWord(uidInput: string | undefined, data: unknown): Promise<{ status: "accepted" | "declined" }> {
  const uid = uidRequired(uidInput);
  const d = object(data);
  onlyKeys(d, ["requestId", "approve", "expectedRequestedAt"]);
  if (typeof d.requestId !== "string" || !/^(mom|aunt)-[A-Z]{2,15}$/.test(d.requestId) || typeof d.approve !== "boolean")
    throw new HttpsError("invalid-argument", "Choose whether to accept this word request.");
  if (!Number.isSafeInteger(d.expectedRequestedAt) || (d.expectedRequestedAt as number) <= 0)
    throw new HttpsError("invalid-argument", "Please reload the game before answering this word request.");
  const requestId = d.requestId;
  const approve = d.approve;
  const expectedRequestedAt = d.expectedRequestedAt;
  return db.runTransaction(async tx => {
    const slot = await requireMember(tx, uid);
    const ref = db.doc(`pairs/family/wordRequests/${requestId}`);
    const saved = await tx.get(ref);
    if (!saved.exists) throw new HttpsError("not-found", "This word request no longer exists.");
    const request = saved.data() as WordRequest;
    if (!slots.includes(request.requestedBy) || request.id !== requestId || requestId !== `${request.requestedBy}-${request.word}`)
      throw new HttpsError("internal", "The saved word request is incomplete. Please contact the administrator.");
    if (request.requestedBy === slot) throw new HttpsError("permission-denied", "Your opponent must decide whether to accept your word.");
    if (request.requestedAt !== expectedRequestedAt)
      throw new HttpsError("failed-precondition", "This word has been requested again. Please review the new request before answering.");
    const status = approve ? "accepted" as const : "declined" as const;
    if (request.status !== "pending") {
      if (request.status === status) return { status };
      throw new HttpsError("failed-precondition", "This request has already received a different answer.");
    }
    const houseRef = db.doc(`pairs/family/houseWords/${request.word}`);
    const house = await tx.get(houseRef);
    const at = Date.now();
    tx.update(ref, { status, respondedBy: slot, respondedAt: at });
    if (approve && !house.exists) {
      const accepted: HouseWord = { word: request.word, requestedBy: request.requestedBy, approvedBy: slot, approvedAt: at };
      tx.create(houseRef, accepted);
    }
    return { status };
  });
}

/** One outstanding proposal per current game; submitting it never changes play. */
export async function requestGameRestart(uidInput: string | undefined, data: unknown): Promise<{ id: string }> {
  const uid = uidRequired(uidInput);
  const d = object(data);
  onlyKeys(d, ["id", "gameId", "winCondition", "durationMinutes"]);
  if (!validId(d.id) || d.id.length < 8 || !validId(d.gameId))
    throw new HttpsError("invalid-argument", "Choose the current game and a valid request ID.");
  const { id, gameId } = d;
  if (d.winCondition !== undefined && !["classic", "turn-limit", "target-score", "timed"].includes(d.winCondition as string))
    throw new HttpsError("invalid-argument", "Choose Classic, 10 turns each, First to 150, or a timed game.");
  const winCondition = (d.winCondition ?? "classic") as WinCondition;
  if ((winCondition !== "timed" && d.durationMinutes !== undefined) || (winCondition === "timed" && d.durationMinutes !== undefined && (!Number.isInteger(d.durationMinutes) || (d.durationMinutes as number) < 1 || (d.durationMinutes as number) > 1440)))
    throw new HttpsError("invalid-argument", "For a timed game, choose a whole number of minutes from 1 to 1440.");
  const durationMinutes = winCondition === "timed" ? (d.durationMinutes ?? 25) as number : undefined;
  return db.runTransaction(async tx => {
    const slot = await requireMember(tx, uid);
    const pairRef = db.doc("pairs/family");
    const ref = db.doc(`pairs/family/gameRequests/${id}`);
    const [pair, saved, current] = await tx.getAll(pairRef, ref, db.doc(`games/${gameId}`));
    if (saved.exists) {
      const previous = saved.data() as NewGameRequest;
      if (previous.requestedBy !== slot || previous.gameId !== gameId || (previous.winCondition ?? "classic") !== winCondition || (winCondition === "timed" && (previous.durationMinutes ?? 25) !== durationMinutes))
        throw new HttpsError("already-exists", "This request ID was already used for another proposal.");
      return { id };
    }
    if (pair.data()?.activeGameId !== gameId || !current.exists)
      throw new HttpsError("failed-precondition", "A newer game is ready. Please use the current board.");
    if (!["active", "finished"].includes(current.data()?.status))
      throw new HttpsError("failed-precondition", "This saved match is not ready for a new game.");
    const pendingId = pair.data()?.pendingNewGameRequestId;
    if (typeof pendingId === "string") {
      const pending = await tx.get(db.doc(`pairs/family/gameRequests/${pendingId}`));
      const existing = pending.data() as NewGameRequest | undefined;
      if (existing?.status === "pending" && existing.gameId === gameId) return { id: existing.id };
    }
    const request: NewGameRequest = { id, gameId, requestedBy: slot, status: "pending", requestedAt: Date.now(), winCondition, ...(winCondition === "timed" ? { durationMinutes } : {}) };
    tx.create(ref, request);
    tx.update(pairRef, { pendingNewGameRequestId: id });
    return { id };
  });
}

/** Only the other current seat may replace a match; outcomes survive reply loss. */
export async function respondGameRestart(uidInput: string | undefined, data: unknown): Promise<NewGameResponse> {
  const uid = uidRequired(uidInput);
  const d = object(data);
  onlyKeys(d, ["requestId", "approve"]);
  if (!validId(d.requestId) || d.requestId.length < 8 || typeof d.approve !== "boolean")
    throw new HttpsError("invalid-argument", "Choose whether to start the requested new game.");
  const { requestId, approve } = d;
  const newGameId = randomUUID();
  return db.runTransaction(async tx => {
    const slot = await requireMember(tx, uid);
    const pairRef = db.doc("pairs/family");
    const ref = db.doc(`pairs/family/gameRequests/${requestId}`);
    const [pair, saved] = await tx.getAll(pairRef, ref);
    if (!saved.exists) throw new HttpsError("not-found", "This new game request no longer exists.");
    const request = saved.data() as NewGameRequest;
    if (request.id !== requestId || !slots.includes(request.requestedBy) || !validId(request.gameId))
      throw new HttpsError("internal", "The saved new game request is incomplete. Please contact the administrator.");
    if (request.requestedBy === slot)
      throw new HttpsError("permission-denied", "Your opponent must decide whether to start your new game.");
    const status = approve ? "accepted" as const : "declined" as const;
    if (request.status !== "pending") {
      if (request.status !== status) throw new HttpsError("failed-precondition", "This request has already received a different answer.");
      return { status, ...(request.newGameId ? { newGameId: request.newGameId } : {}) };
    }
    if (pair.data()?.activeGameId !== request.gameId || pair.data()?.pendingNewGameRequestId !== requestId)
      throw new HttpsError("failed-precondition", "This request belongs to an older game. Please use the current board.");
    const oldRef = db.doc(`games/${request.gameId}`);
    const old = await tx.get(oldRef);
    if (!old.exists || !["active", "finished"].includes(old.data()?.status))
      throw new HttpsError("failed-precondition", "This saved match is not ready for a new game.");
    const at = Date.now();
    tx.update(ref, { status, respondedBy: slot, respondedAt: at, ...(approve ? { newGameId } : {}) });
    if (!approve) {
      tx.update(pairRef, { pendingNewGameRequestId: null });
      return { status };
    }
    const winCondition = request.winCondition ?? "classic";
    if (!["classic", "turn-limit", "target-score", "timed"].includes(winCondition))
      throw new HttpsError("internal", "The saved new game choice is incomplete. Please contact the administrator.");
    const next = createGame(newGameId, cryptoRandom, winCondition, request.durationMinutes ?? 25, at);
    writeGame(tx, next);
    // Preserve the old board, scores, private tiles and receipts as history.
    // This is an agreed replacement, not a scored win or a rack deduction.
    tx.update(oldRef, {
      replacedByGameId: newGameId,
      replacedAt: at,
      ...(old.data()!.status === "active" ? (timerExpired(old.data()!, at) ? timerFinishFields(old.data()!, at) : { status: "finished", winner: null, revision: old.data()!.revision + 1, endedReason: "new-game", endedAt: at }) : {}),
    });
    tx.update(pairRef, { activeGameId: newGameId, pendingNewGameRequestId: null });
    return { status, newGameId };
  });
}

function timerExpired(game: FirebaseFirestore.DocumentData, now: number): boolean {
  if (game.winCondition !== "timed" || game.status !== "active") return false;
  if (!Number.isSafeInteger(game.deadlineAt)) throw new HttpsError("internal", "This game's clock is unavailable. Please contact the administrator.");
  return now >= game.deadlineAt;
}
function timerFinishFields(game: FirebaseFirestore.DocumentData, now: number) {
  const { mom, aunt } = game.scores;
  return { status: "finished" as const, winner: mom === aunt ? "tie" as const : mom > aunt ? "mom" as const : "aunt" as const, revision: game.revision + 1, endedReason: "timed" as const, endedAt: now };
}
interface ExpiredSubmission { expired: true; gameId: string; revision: number }
function finishLateSubmission(tx: FirebaseFirestore.Transaction, ref: FirebaseFirestore.DocumentReference, game: FirebaseFirestore.DocumentData, now: number, kind: Command["kind"]): ExpiredSubmission | null {
  if (timerExpired(game, now)) {
    const fields = timerFinishFields(game, now);
    tx.update(ref, fields);
    return { expired: true, gameId: ref.id, revision: fields.revision };
  }
  if (game.winCondition === "timed" && game.status === "finished" && game.endedReason === "timed" && kind !== "rematch")
    return { expired: true, gameId: ref.id, revision: game.revision };
  return null;
}

/** Clients wake this on expiry/resume; server time alone decides the outcome. */
export async function finishGameTimer(uidInput: string | undefined, data: unknown): Promise<TimedGameResult> {
  const uid = uidRequired(uidInput);
  const d = object(data);
  onlyKeys(d, ["gameId"]);
  if (!validId(d.gameId)) throw new HttpsError("invalid-argument", "Choose the current timed game.");
  const gameId = d.gameId;
  return db.runTransaction(async tx => {
    await requireMember(tx, uid);
    const ref = db.doc(`games/${gameId}`);
    const [pair, saved] = await tx.getAll(db.doc("pairs/family"), ref);
    if (!saved.exists) throw new HttpsError("not-found", "This timed game no longer exists.");
    const game = saved.data()!;
    if (game.winCondition !== "timed") throw new HttpsError("failed-precondition", "This game does not use a timer.");
    const serverNow = Date.now();
    if (game.status === "finished") return { gameId, revision: game.revision, status: "finished", serverNow };
    if (pair.data()?.activeGameId !== gameId) throw new HttpsError("failed-precondition", "A newer game is ready. Please use the current board.");
    if (!timerExpired(game, serverNow)) return { gameId, revision: game.revision, status: "active", serverNow };
    const fields = timerFinishFields(game, serverNow);
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
  try {
    const outcome = await db.runTransaction<CommandResult | ExpiredSubmission>(async (tx) => {
      const binding = await tx.get(db.doc(`bindings/${uid}`));
      const slot = binding.data()?.slot as Slot;
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
      if (player.data()?.uid !== uid)
        throw new HttpsError(
          "permission-denied",
          "This device has been replaced. Please use a new setup code.",
        );
      // This check deliberately precedes revision, active-game and turn validation.
      if (recorded.exists) {
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
      const expiredBeforeReads = finishLateSubmission(tx, gameRef, saved.data()!, Date.now(), command.kind);
      if (expiredBeforeReads) return expiredBeforeReads;
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
      const expiredAfterReads = finishLateSubmission(tx, gameRef, saved.data()!, serverNow, command.kind);
      if (expiredAfterReads) return expiredAfterReads;
      try {
        accepted = applyCommand(game, slot, command, dictionary, cryptoRandom, serverNow);
      } catch (error) {
        if (!(error instanceof RuleError) || error.code !== "dictionary" || command.kind !== "play") throw error;
        // The engine already checked revision, turn, ownership and structural
        // legality. Read only the proposed words that need house approval.
        const formed = previewMove(game, game.racks[slot], command.placements!).words;
        const missing = [...new Set(formed.filter(word => !dictionary.has(word)))];
        const house = await tx.getAll(...missing.map(word => db.doc(`pairs/family/houseWords/${word}`)));
        serverNow = Date.now();
        const expiredAfterDictionary = finishLateSubmission(tx, gameRef, saved.data()!, serverNow, command.kind);
        if (expiredAfterDictionary) return expiredAfterDictionary;
        const unknown = missing.filter((_word, index) => !house[index].exists);
        if (unknown.length) throw new HttpsError("failed-precondition", `Not in our dictionary: ${unknown.join(", ")}. You can edit your tiles and try again.`, { rule: "dictionary", words: unknown });
        const withHouseWords = new Set(dictionary);
        missing.forEach(word => withHouseWords.add(word));
        accepted = applyCommand(game, slot, command, withHouseWords, cryptoRandom, serverNow);
      }
      const expiredBeforeCommit = finishLateSubmission(tx, gameRef, saved.data()!, Date.now(), command.kind);
      if (expiredBeforeCommit) return expiredBeforeCommit;
      const next =
        command.kind === "rematch"
          ? createGame(newGameId, cryptoRandom, game.winCondition ?? "classic", game.durationMinutes ?? 25, serverNow)
          : accepted;
      const result: CommandResult = {
        commandId: command.id,
        gameId: next.id,
        revision: next.revision,
        score: command.kind === "play" ? (next.lastMove?.score ?? 0) : 0,
      };
      writeGame(tx, next);
      if (command.kind === "rematch")
        tx.update(pair.ref, { activeGameId: next.id, pendingNewGameRequestId: null });
      tx.create(resultRef, { uid, payloadHash, result });
      return result;
    });
    // Throw only after the expiry write has committed. A rejected late move
    // never receives a command receipt or changes turns, rack tiles or scores.
    if ("expired" in outcome) throw new HttpsError("failed-precondition", "Time is up. This game has finished.", { rule: "timed", gameId: outcome.gameId, revision: outcome.revision });
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

const options = callablePolicy();
export const enrollPlayer = onCall(options, (request) =>
  enroll(request.auth?.uid, request.data),
);
export const submitCommand = onCall(options, (request) =>
  submit(request.auth?.uid, request.data),
);
export const requestWord = onCall(options, request => requestHouseWord(request.auth?.uid, request.data));
export const respondToWord = onCall(options, request => respondHouseWord(request.auth?.uid, request.data));
export const requestNewGame = onCall(options, request => requestGameRestart(request.auth?.uid, request.data));
export const respondToNewGame = onCall(options, request => respondGameRestart(request.auth?.uid, request.data));
export const finishTimedGame = onCall(options, request => finishGameTimer(request.auth?.uid, request.data));
