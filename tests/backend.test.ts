import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID, randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import { SETUP_WORDS, WORD_FAILURE_BUCKET } from "../functions/setup-words";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, collection, getDocs } from "firebase/firestore";
import { getFirestore } from "firebase-admin/firestore";
import {
  createGame,
  type Game,
  type Slot,
  type Command,
} from "../shared/engine";

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const projectId =
  process.env.FIREBASE_TEST_PROJECT_ID ||
  process.env.TEA_TEST_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  "demo-tea-and-tiles-tests";
if (
  enabled &&
  (!projectId.startsWith("demo-") || projectId === "demo-tea-and-tiles")
)
  throw new Error(
    "Backend tests clear their project data. Use an isolated demo project (for example FIREBASE_TEST_PROJECT_ID=demo-tea-and-tiles-tests), not the live demo game.",
  );
let env: RulesTestEnvironment;
let enroll: typeof import("../functions/index").enroll;
let submit: typeof import("../functions/index").submit;
let publicGame: typeof import("../functions/index").publicGame;
let requestHouseWord: typeof import("../functions/index").requestHouseWord;
let respondHouseWord: typeof import("../functions/index").respondHouseWord;
let requestGameRestart: typeof import("../functions/index").requestGameRestart;
let respondGameRestart: typeof import("../functions/index").respondGameRestart;
let finishGameTimer: typeof import("../functions/index").finishGameTimer;
const codeHash = (code: string) =>
  createHash("sha256").update(code).digest("hex");
const codeAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const newCode = () =>
  Array.from(
    { length: 8 },
    () => codeAlphabet[randomInt(codeAlphabet.length)],
  ).join("");
const uids = { mom: "test-mom", aunt: "test-aunt" };
let game: Game;

async function writeGame(value: Game) {
  const db = getFirestore();
  const batch = db.batch();
  batch.set(db.doc(`games/${value.id}`), publicGame(value));
  for (const slot of ["mom", "aunt"] as Slot[])
    batch.set(db.doc(`games/${value.id}/racks/${slot}`), {
      tiles: value.racks[slot],
    });
  batch.set(db.doc(`games/${value.id}/private/state`), { bag: value.bag });
  await batch.commit();
}
async function codeFor(slot: Slot, extras = {}, code = newCode()) {
  await getFirestore()
    .doc(`setupCodes/${codeHash(code)}`)
    .set({
      slot,
      expiresAt: Date.now() + 86400000,
      consumedUid: null,
      ...extras,
    });
  return code;
}
async function prepareHouseWordRack(
  letters: string,
  board: { letter: string; row: number; col: number }[] = [],
) {
  const inventory = [...game.racks.mom, ...game.racks.aunt, ...game.bag];
  const take = (letter: string) => {
    const index = inventory.findIndex((tile) => tile.letter === letter);
    if (index < 0) throw new Error(`Fixture has no ${letter} tile`);
    return inventory.splice(index, 1)[0];
  };
  game.board = {};
  for (const square of board)
    game.board[`${square.row},${square.col}`] = {
      ...take(square.letter),
      row: square.row,
      col: square.col,
    };
  game.racks.mom = [...letters].map(take);
  game.racks.mom.push(...inventory.splice(0, 7 - game.racks.mom.length));
  game.racks.aunt = inventory.splice(0, 7);
  game.bag = inventory;
  await writeGame(game);
}
const housePlay = (): Command => ({
  ...command("play"),
  placements: game.racks.mom
    .slice(0, 2)
    .map((tile, index) => ({ tileId: tile.id, row: 7, col: 7 + index })),
});
async function approveHouseWord(word: string) {
  const request = await requestHouseWord(uids.mom, { word });
  await respondCurrentHouseWord(uids.aunt, {
    requestId: request.id,
    approve: true,
  });
  return request.id;
}
async function respondCurrentHouseWord(
  uid: string | undefined,
  data: { requestId: string; approve: boolean },
) {
  const validId = /^(mom|aunt)-[A-Z]{2,15}$/.test(data.requestId);
  const record = validId
    ? (
        await getFirestore()
          .doc(`pairs/family/wordRequests/${data.requestId}`)
          .get()
      ).data()
    : undefined;
  return respondHouseWord(uid, {
    ...data,
    expectedRequestedAt: record?.requestedAt ?? 1,
  });
}
const command = (kind: Command["kind"] = "pass", revision = 0): Command => ({
  id: randomUUID(),
  gameId: game.id,
  expectedRevision: revision,
  kind,
});

describe.skipIf(!enabled)(
  "authoritative backend and Firestore privacy (emulators)",
  () => {
    beforeAll(async () => {
      process.env.GCLOUD_PROJECT = projectId;
      const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(":");
      env = await initializeTestEnvironment({
        projectId,
        firestore: {
          host,
          port: Number(port),
          rules: readFileSync("firestore.rules", "utf8"),
        },
      });
      // Use the emitted production service so its dictionary path matches deployment.
      const modulePath = "../functions/lib/functions/index.js";
      ({
        enroll,
        submit,
        publicGame,
        requestHouseWord,
        respondHouseWord,
        requestGameRestart,
        respondGameRestart,
        finishGameTimer,
      } = await import(/* @vite-ignore */ modulePath));
    });
    beforeEach(async () => {
      await env.clearFirestore();
      game = createGame(randomUUID(), () => 0.5);
      await writeGame(game);
      const db = getFirestore();
      await db.doc("pairs/family").set({
        activeGameId: game.id,
        names: { mom: "Elizabeth", aunt: "Rita" },
      });
      for (const slot of ["mom", "aunt"] as Slot[]) {
        await db.doc(`players/${slot}`).set({ uid: uids[slot] });
        await db.doc(`bindings/${uids[slot]}`).set({ slot });
      }
    });
    afterAll(async () => {
      await env?.cleanup();
    });

    it("authenticates membership, turn and revision before mutating state", async () => {
      await expect(submit(undefined, command())).rejects.toMatchObject({
        code: "unauthenticated",
      });
      await expect(submit("stranger", command())).rejects.toMatchObject({
        code: "permission-denied",
      });
      await expect(submit(uids.aunt, command())).rejects.toMatchObject({
        code: "failed-precondition",
      });
      await expect(submit(uids.mom, command("pass", 99))).rejects.toMatchObject(
        { code: "failed-precondition" },
      );
      expect(
        (await getFirestore().doc(`games/${game.id}`).get()).data()?.revision,
      ).toBe(0);
    });
    it("replays a concurrent duplicate once, even after the turn and revision advance", async () => {
      const c = command();
      const results = await Promise.all([
        submit(uids.mom, c),
        submit(uids.mom, c),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect(results[0].revision).toBe(1);
      expect(await submit(uids.mom, c)).toEqual(results[0]);
      expect(
        (await getFirestore().doc(`games/${game.id}`).get()).data()?.revision,
      ).toBe(1);
      await expect(
        submit(uids.mom, { ...c, expectedRevision: 1 }),
      ).rejects.toMatchObject({ code: "already-exists" });
      await expect(submit(uids.aunt, c)).rejects.toMatchObject({
        code: "already-exists",
      });
    });
    it("rejects forged rack tiles and invalid words without taking a turn", async () => {
      const c = {
        ...command("play"),
        placements: [{ tileId: "forged", row: 7, col: 7 }],
      };
      await expect(submit(uids.mom, c)).rejects.toMatchObject({
        code: "failed-precondition",
      });
      const all = [...game.racks.mom, ...game.racks.aunt, ...game.bag];
      game.racks.mom = ["C", "X", "T"].map(
        (letter) =>
          all.splice(
            all.findIndex((tile) => tile.letter === letter),
            1,
          )[0],
      );
      game.racks.aunt = all.splice(0, 7);
      game.bag = all;
      await writeGame(game);
      await expect(
        submit(uids.mom, {
          ...command("play"),
          placements: game.racks.mom.map((tile, index) => ({
            tileId: tile.id,
            row: 7,
            col: 6 + index,
          })),
        }),
      ).rejects.toMatchObject({ code: "failed-precondition" });
      expect(
        (await getFirestore().doc(`games/${game.id}`).get()).data()?.revision,
      ).toBe(0);
      expect(
        (await getFirestore().doc(`games/${game.id}/racks/mom`).get()).data()
          ?.tiles,
      ).toEqual(game.racks.mom);
    });
    it("rejects malformed payloads and path injection", async () => {
      await expect(
        submit(uids.mom, { ...command(), gameId: "../private" }),
      ).rejects.toMatchObject({ code: "invalid-argument" });
      await expect(
        submit(uids.mom, { ...command(), score: 100 }),
      ).rejects.toMatchObject({ code: "invalid-argument" });
      await expect(
        submit(uids.mom, {
          ...command("play"),
          placements: [{ tileId: "x", row: -1, col: 7 }],
        }),
      ).rejects.toMatchObject({ code: "invalid-argument" });
    });
    it("accepts zero-value blanks through the callable payload validator", async () => {
      const inventory = [...game.racks.mom, ...game.racks.aunt, ...game.bag];
      const take = (letter: string) =>
        inventory.splice(
          inventory.findIndex((tile) => tile.letter === letter),
          1,
        )[0];
      game.racks.mom = [
        take("C"),
        take("?"),
        take("T"),
        ...inventory.splice(0, 4),
      ];
      game.racks.aunt = inventory.splice(0, 7);
      game.bag = inventory;
      await writeGame(game);
      const placements = game.racks.mom.slice(0, 3).map((tile, index) => ({
        tileId: tile.id,
        row: 7,
        col: 6 + index,
        ...(tile.letter === "?" ? { letter: "A" } : {}),
      }));
      const result = await submit(uids.mom, { ...command("play"), placements });
      expect(result.score).toBe(8);
      const saved = (
        await getFirestore().doc(`games/${game.id}`).get()
      ).data()!;
      expect(saved.board["7,7"]).toMatchObject({ letter: "A", value: 0 });
    });
    it("redeems single-use expiring credentials and revokes a replaced device", async () => {
      const code = await codeFor("mom");
      expect(await enroll("replacement", { code })).toEqual({ slot: "mom" });
      expect(await enroll("replacement", { code })).toEqual({ slot: "mom" });
      await expect(enroll("third-device", { code })).rejects.toMatchObject({
        code: "permission-denied",
      });
      await expect(submit(uids.mom, command())).rejects.toMatchObject({
        code: "permission-denied",
      });
      await expect(submit("replacement", command())).resolves.toMatchObject({
        revision: 1,
      });
      const expired = await codeFor("aunt", { expiresAt: Date.now() - 1 });
      await expect(
        enroll("late-device", { code: expired }),
      ).rejects.toMatchObject({ code: "permission-denied" });
    });
    it("normalizes short codes with lowercase, spaces and the readable hyphen", async () => {
      const code = await codeFor("mom", {}, "ABCD2345");
      const record = getFirestore().doc(`setupCodes/${codeHash(code)}`);
      expect((await record.get()).data()).not.toHaveProperty("code");
      expect(
        await enroll("short-code-device", { code: "  abcd - 2345  " }),
      ).toEqual({ slot: "mom" });
      expect(await enroll("short-code-device", { code: "ABCD-2345" })).toEqual({
        slot: "mom",
      });
      expect((await record.get()).data()?.consumedUid).toBe(
        "short-code-device",
      );
      await expect(
        enroll("another-short-device", { code }),
      ).rejects.toMatchObject({ code: "permission-denied" });
    });
    it("rejects malformed short codes before attempting enrollment", async () => {
      for (const code of [
        "ABCDEFGI",
        "ABCDEFG0",
        "12345678",
        "ABCD234",
        "ABCDEFGHJ",
        "ABCD_2345",
        "ABCD/2345",
        "pear",
        "orange!",
      ])
        await expect(
          enroll("invalid-code-device", { code }),
        ).rejects.toMatchObject({ code: "invalid-argument" });
      expect((await getFirestore().doc("players/mom").get()).data()?.uid).toBe(
        uids.mom,
      );
    });
    it("continues to redeem previously issued 32-character hexadecimal codes", async () => {
      const legacy = randomBytes(16).toString("hex").toUpperCase();
      await codeFor("aunt", {}, legacy);
      const grouped = legacy
        .toLowerCase()
        .match(/.{1,4}/g)!
        .join("-");
      expect(await enroll("legacy-device", { code: grouped })).toEqual({
        slot: "aunt",
      });
      expect(await enroll("legacy-device", { code: legacy })).toEqual({
        slot: "aunt",
      });
      await expect(
        enroll("legacy-replay-device", { code: legacy }),
      ).rejects.toMatchObject({ code: "permission-denied" });
    });
    it("offers 256 distinct familiar invitation words of five to seven letters", () => {
      expect(SETUP_WORDS).toHaveLength(256);
      expect(new Set(SETUP_WORDS).size).toBe(256);
      expect(SETUP_WORDS.every((word) => /^[A-Z]{5,7}$/.test(word))).toBe(true);
      expect(SETUP_WORDS).toEqual(
        expect.arrayContaining(["MAPLE", "PEACH", "APPLE"]),
      );
    });
    it("redeems a case-insensitive word once, expires unused words, and preserves the match", async () => {
      const before = (
        await getFirestore().doc(`games/${game.id}`).get()
      ).data();
      await codeFor("mom", {}, "MAPLE");
      expect(await enroll("word-device", { code: "  ma p-le " })).toEqual({
        slot: "mom",
      });
      expect(await enroll("word-device", { code: "maple" })).toEqual({
        slot: "mom",
      });
      await expect(
        enroll("word-stranger", { code: "maple" }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      await codeFor("aunt", { expiresAt: Date.now() - 1 }, "PEACH");
      await expect(
        enroll("expired-word-device", { code: "peach" }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      expect(
        (await getFirestore().doc(`games/${game.id}`).get()).data(),
      ).toEqual(before);
      expect(
        (await getFirestore().doc("pairs/family").get()).data()?.activeGameId,
      ).toBe(game.id);
    });
    it("limits word guessing across fresh anonymous identities, while owner retries remain idempotent", async () => {
      await codeFor("mom", {}, "MAPLE");
      await codeFor("aunt", {}, "PEACH");
      await enroll("accepted-word-device", { code: "maple" });
      expect((await getFirestore().doc(WORD_FAILURE_BUCKET).get()).exists).toBe(
        false,
      );
      for (let index = 0; index < 10; index++)
        await expect(
          enroll(`fresh-guess-${index}`, { code: "missing" }),
        ).rejects.toMatchObject({ code: "permission-denied" });
      await expect(
        enroll("eleventh-fresh-guess", { code: "missing" }),
      ).rejects.toMatchObject({ code: "resource-exhausted" });
      await expect(
        enroll("new-valid-word-device", { code: "peach" }),
      ).rejects.toMatchObject({ code: "resource-exhausted" });
      const attempt = getFirestore().doc(
        `enrollmentAttempts/${codeHash("accepted-word-device")}`,
      );
      await attempt.set({ windowStart: Date.now(), count: 10 });
      expect(await enroll("accepted-word-device", { code: "maple" })).toEqual({
        slot: "mom",
      });
      expect(
        (await getFirestore().doc(WORD_FAILURE_BUCKET).get()).data()?.count,
      ).toBe(10);
      await getFirestore()
        .doc(WORD_FAILURE_BUCKET)
        .set({ windowStart: Date.now() - 3600001, count: 10 });
      expect(await enroll("new-valid-word-device", { code: "peach" })).toEqual({
        slot: "aunt",
      });
    });
    it("reports the remaining enrollment cooldown for the last exhausted bucket without consuming an invitation", async () => {
      const db = getFirestore();
      await codeFor("mom", {}, "MAPLE");
      const started = Date.now();
      const uidBucket = db.doc(
        `enrollmentAttempts/${codeHash("throttled-device")}`,
      );
      await uidBucket.set({
        windowStart: started - 3600000 + 120000,
        count: 10,
      });
      await db
        .doc(WORD_FAILURE_BUCKET)
        .set({ windowStart: started - 3600000 + 300000, count: 10 });
      let failure:
        | { code: string; details: { rule: string; retryAfterSeconds: number } }
        | undefined;
      try {
        await enroll("throttled-device", { code: "maple" });
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure).toMatchObject({
        code: "resource-exhausted",
        details: { rule: "rate-limit" },
      });
      const remaining = failure!.details.retryAfterSeconds;
      expect(Number.isSafeInteger(remaining)).toBe(true);
      expect(remaining).toBeGreaterThanOrEqual(
        Math.ceil((started + 300000 - Date.now()) / 1000),
      );
      expect(remaining).toBeLessThanOrEqual(300);
      expect(remaining).toBeGreaterThan(120);
      expect(
        (await db.doc(`setupCodes/${codeHash("MAPLE")}`).get()).data()
          ?.consumedUid,
      ).toBeNull();
      expect((await uidBucket.get()).data()?.count).toBe(10);
      expect((await db.doc(WORD_FAILURE_BUCKET).get()).data()?.count).toBe(10);
      await db.doc(WORD_FAILURE_BUCKET).delete();
      await expect(
        enroll("throttled-device", { code: "maple" }),
      ).rejects.toMatchObject({
        details: { rule: "rate-limit", retryAfterSeconds: expect.any(Number) },
      });
      await uidBucket.set({ windowStart: Date.now() - 3600001, count: 10 });
      expect(await enroll("throttled-device", { code: "maple" })).toEqual({
        slot: "mom",
      });
    });
    it("does not allow a replaced device to reuse its consumed invitation", async () => {
      await codeFor("mom", {}, "MAPLE");
      await enroll("former-word-device", { code: "maple" });
      await codeFor("mom", {}, "APPLE");
      await enroll("current-word-device", { code: "apple" });
      await expect(
        enroll("former-word-device", { code: "maple" }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      expect((await getFirestore().doc("players/mom").get()).data()?.uid).toBe(
        "current-word-device",
      );
    });
    it("issues distinct word links atomically without reusing history or changing connected devices", async () => {
      const db = getFirestore();
      await codeFor("mom", {}, "MAPLE");
      await codeFor(
        "mom",
        { consumedUid: uids.mom, consumedAt: Date.now() },
        "PEACH",
      );
      await db
        .doc(WORD_FAILURE_BUCKET)
        .set({ windowStart: Date.now(), count: 10 });
      const currentAttempts = db.doc(
        `enrollmentAttempts/${codeHash(uids.mom)}`,
      );
      const unrelatedAttempts = db.doc(
        `enrollmentAttempts/${codeHash("unrelated-device")}`,
      );
      await currentAttempts.set({ windowStart: Date.now(), count: 10 });
      await unrelatedAttempts.set({ windowStart: Date.now(), count: 10 });
      const beforeGame = (await db.doc(`games/${game.id}`).get()).data();
      const beforePlayer = (await db.doc("players/mom").get()).data();
      const beforeBinding = (await db.doc(`bindings/${uids.mom}`).get()).data();
      const names = (await db.doc("pairs/family").get()).data()!.names;
      const issue = (slot: Slot) =>
        execFileSync(
          process.execPath,
          [
            "scripts/admin.mjs",
            "issue-code",
            "--slot",
            slot,
            "--project",
            projectId,
            "--app-url",
            "http://127.0.0.1:5183/",
          ],
          { encoding: "utf8", timeout: 15000 },
        );
      const momOutput = issue("mom");
      const momWord = momOutput.match(/#setup=([a-z]{5,7})/)![1];
      expect(momOutput).toContain(`${names.mom}: ${momWord} (`);
      expect(momOutput).toContain(`#setup=${momWord}`);
      expect(momWord).not.toBe("maple");
      expect(momWord).not.toBe("peach");
      expect(
        (
          await db.doc(`setupCodes/${codeHash(momWord.toUpperCase())}`).get()
        ).data(),
      ).toMatchObject({ slot: "mom", consumedUid: null });
      expect(
        (await db.doc(`setupCodes/${codeHash("MAPLE")}`).get()).data()
          ?.expiresAt,
      ).toBe(0);
      expect(
        (await db.doc(`setupCodes/${codeHash("PEACH")}`).get()).data()
          ?.consumedUid,
      ).toBe(uids.mom);
      expect((await db.doc(WORD_FAILURE_BUCKET).get()).exists).toBe(false);
      expect((await currentAttempts.get()).exists).toBe(false);
      expect((await unrelatedAttempts.get()).data()?.count).toBe(10);
      expect((await db.doc(`games/${game.id}`).get()).data()).toEqual(
        beforeGame,
      );
      expect((await db.doc("players/mom").get()).data()).toEqual(beforePlayer);
      expect((await db.doc(`bindings/${uids.mom}`).get()).data()).toEqual(
        beforeBinding,
      );
      const auntOutput = issue("aunt");
      const auntWord = auntOutput.match(/#setup=([a-z]{5,7})/)![1];
      expect(auntOutput).toContain(`${names.aunt}: ${auntWord} (`);
      expect(auntWord).not.toBe(momWord);
      expect(auntOutput).toContain(`#setup=${auntWord}`);
      expect(await enroll("new-admin-word-device", { code: momWord })).toEqual({
        slot: "mom",
      });
    }, 20000);
    it("repairs default player names through the admin command without touching game or membership", async () => {
      const db = getFirestore();
      await db
        .doc("pairs/family")
        .update({ names: { mom: "Rita", aunt: "Elizabeth" } });
      const before = (await db.doc(`games/${game.id}`).get()).data();
      execFileSync(
        process.execPath,
        ["scripts/admin.mjs", "names", "--project", projectId],
        { encoding: "utf8", timeout: 15000 },
      );
      expect((await db.doc("pairs/family").get()).data()).toMatchObject({
        activeGameId: game.id,
        names: { mom: "Elizabeth", aunt: "Rita" },
      });
      expect((await db.doc(`games/${game.id}`).get()).data()).toEqual(before);
      for (const slot of ["mom", "aunt"] as Slot[]) {
        expect((await db.doc(`players/${slot}`).get()).data()?.uid).toBe(
          uids[slot],
        );
        expect(
          (await db.doc(`bindings/${uids[slot]}`).get()).data()?.slot,
        ).toBe(slot);
      }
    }, 20000);
    it("limits guessing and does not allow a bound device to switch players", async () => {
      const code = await codeFor("aunt");
      await expect(enroll(uids.mom, { code })).rejects.toMatchObject({
        code: "failed-precondition",
      });
      for (let i = 0; i < 10; i++)
        await expect(
          enroll("guessing-device", { code: newCode() }),
        ).rejects.toMatchObject({ code: "permission-denied" });
      await expect(enroll("guessing-device", { code })).rejects.toMatchObject({
        code: "resource-exhausted",
      });
    });
    it("permits shared board and own rack while denying all private data and writes", async () => {
      const mom = env.authenticatedContext(uids.mom).firestore();
      const stranger = env.authenticatedContext("stranger").firestore();
      const anonymous = env.unauthenticatedContext().firestore();
      await assertSucceeds(getDoc(doc(mom, "pairs/family")));
      const board = await assertSucceeds(getDoc(doc(mom, `games/${game.id}`)));
      expect(board.data()).not.toHaveProperty("bag");
      expect(board.data()).not.toHaveProperty("racks");
      await assertSucceeds(getDoc(doc(mom, `games/${game.id}/racks/mom`)));
      await assertFails(getDoc(doc(mom, `games/${game.id}/racks/aunt`)));
      await assertFails(getDoc(doc(mom, `games/${game.id}/private/state`)));
      await assertFails(getDoc(doc(mom, "setupCodes/secret")));
      await assertFails(getDoc(doc(stranger, `games/${game.id}`)));
      await assertFails(getDoc(doc(anonymous, `games/${game.id}`)));
      await assertFails(
        setDoc(doc(mom, `games/${game.id}`), { scores: { mom: 1000 } }),
      );
      await assertFails(setDoc(doc(mom, "bindings/stranger"), { slot: "mom" }));
      await assertFails(getDocs(collection(mom, `games/${game.id}/racks`)));
      const c = command();
      await assertSucceeds(
        getDoc(doc(mom, `games/${game.id}/commands/${c.id}`)),
      );
      await submit(uids.mom, c);
      await assertSucceeds(
        getDoc(doc(mom, `games/${game.id}/commands/${c.id}`)),
      );
      await assertFails(
        getDoc(
          doc(
            env.authenticatedContext(uids.aunt).firestore(),
            `games/${game.id}/commands/${c.id}`,
          ),
        ),
      );
    });
    it("denies a revoked binding access even if a stale binding record survives", async () => {
      await getFirestore().doc("players/mom").set({ uid: "new-mom" });
      const former = env.authenticatedContext(uids.mom).firestore();
      await assertFails(getDoc(doc(former, `games/${game.id}`)));
      await assertFails(getDoc(doc(former, `games/${game.id}/racks/mom`)));
    });
    it("finishes after six passes and creates exactly one rematch on retry", async () => {
      const db = getFirestore();
      const ref = db.doc(`games/${game.id}`);
      const deductions = {
        mom: game.racks.mom.reduce((sum, tile) => sum + tile.value, 0),
        aunt: game.racks.aunt.reduce((sum, tile) => sum + tile.value, 0),
      };
      const finalPass = command("pass", 5);
      const before = Date.now();
      for (let i = 0; i < 6; i++) {
        await submit(
          i % 2 === 0 ? uids.mom : uids.aunt,
          i === 5 ? finalPass : command("pass", i),
        );
        expect((await ref.get()).data()).toMatchObject({
          revision: i + 1,
          scorelessTurns: i + 1,
          status: i === 5 ? "finished" : "active",
        });
      }
      const finished = (await ref.get()).data()!;
      expect(finished).toMatchObject({
        endedReason: "scoreless",
        endedAt: expect.any(Number),
        winner:
          deductions.mom === deductions.aunt
            ? "tie"
            : deductions.mom < deductions.aunt
              ? "mom"
              : "aunt",
        scores: { mom: -deductions.mom, aunt: -deductions.aunt },
      });
      expect(finished.endedAt).toBeGreaterThanOrEqual(before);
      expect(finished.endedAt).toBeLessThanOrEqual(Date.now());
      const replay = await submit(uids.aunt, finalPass);
      expect(replay.revision).toBe(6);
      await expect(submit(uids.mom, command("pass", 6))).rejects.toMatchObject({
        details: { rule: "finished" },
      });
      expect((await ref.get()).data()).toEqual(finished);
      const rematch = command("rematch", 6);
      const result = await submit(uids.aunt, rematch);
      expect(result.gameId).not.toBe(game.id);
      expect(result.revision).toBe(0);
      expect(await submit(uids.aunt, rematch)).toEqual(result);
      expect(
        (await getFirestore().doc("pairs/family").get()).data()?.activeGameId,
      ).toBe(result.gameId);
      expect(
        (await getFirestore().doc(`games/${result.gameId}`).get()).data()
          ?.rackCounts,
      ).toEqual({ mom: 7, aunt: 7 });
      expect(await submit(uids.aunt, finalPass)).toEqual(replay);
      expect((await ref.get()).data()).toEqual(finished);
    }, 15000);
    it("commits an actual last-tile ending once and exposes the final outcome to both bound players", async () => {
      const db = getFirestore();
      await prepareHouseWordRack("T", [{ letter: "A", row: 7, col: 7 }]);
      const inventory = [
        ...game.racks.aunt,
        ...game.bag,
        ...game.racks.mom.slice(1),
      ];
      const q = inventory.find((tile) => tile.letter === "Q")!;
      expect(q).toBeDefined();
      game.racks = { mom: [game.racks.mom[0]], aunt: [q] };
      game.bag = [];
      game.scores = { mom: 20, aunt: 25 };
      await writeGame(game);
      const lastTile = {
        ...command("play"),
        placements: [{ tileId: game.racks.mom[0].id, row: 7, col: 8 }],
      };
      const before = Date.now();
      const result = await submit(uids.mom, lastTile);
      expect(result).toMatchObject({ revision: 1, score: 2 });
      const ref = db.doc(`games/${game.id}`);
      const finished = (await ref.get()).data()!;
      expect(finished).toMatchObject({
        status: "finished",
        endedReason: "rack-out",
        endedAt: expect.any(Number),
        revision: 1,
        winner: "mom",
        scores: { mom: 32, aunt: 15 },
        bagCount: 0,
        rackCounts: { mom: 0, aunt: 1 },
        lastMove: { score: 2, words: ["AT"] },
      });
      expect(finished.endedAt).toBeGreaterThanOrEqual(before);
      expect(finished.endedAt).toBeLessThanOrEqual(Date.now());
      for (const uid of Object.values(uids)) {
        const client = env.authenticatedContext(uid).firestore();
        expect(
          (
            await assertSucceeds(getDoc(doc(client, `games/${game.id}`)))
          ).data(),
        ).toEqual(finished);
      }
      expect(await submit(uids.mom, lastTile)).toEqual(result);
      const rejected = command("pass", 1);
      await expect(submit(uids.aunt, rejected)).rejects.toMatchObject({
        details: { rule: "finished" },
      });
      expect((await ref.get()).data()).toEqual(finished);
      expect((await ref.collection("commands").get()).size).toBe(1);
      expect(
        (await ref.collection("commands").doc(rejected.id).get()).exists,
      ).toBe(false);
      expect(
        (await ref.collection("racks").doc("mom").get()).data()?.tiles,
      ).toEqual([]);
      expect(
        (await ref.collection("racks").doc("aunt").get()).data()?.tiles,
      ).toEqual([q]);
    }, 15000);
    it("validates house proposals and requires the other player to decide", async () => {
      await expect(
        requestHouseWord(undefined, { word: "MW" }),
      ).rejects.toMatchObject({ code: "unauthenticated" });
      await expect(
        requestHouseWord("stranger", { word: "MW" }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      for (const word of [
        "A",
        "A".repeat(16),
        "ICE CREAM",
        "A/B",
        "CAFÉ",
        "ßß",
      ])
        await expect(
          requestHouseWord(uids.mom, { word }),
        ).rejects.toMatchObject({ code: "invalid-argument" });
      await expect(
        requestHouseWord(uids.mom, { word: "CAT" }),
      ).rejects.toMatchObject({
        code: "failed-precondition",
        message: expect.stringContaining("already"),
      });
      await expect(
        respondCurrentHouseWord(uids.aunt, {
          requestId: "../private",
          approve: true,
        }),
      ).rejects.toMatchObject({ code: "invalid-argument" });
      const beforeGame = (
        await getFirestore().doc(`games/${game.id}`).get()
      ).data();
      const requested = await requestHouseWord(uids.mom, { word: " mw " });
      expect(requested.id).toBe("mom-MW");
      const ref = getFirestore().doc("pairs/family/wordRequests/mom-MW");
      const pending = (await ref.get()).data();
      expect(pending).toMatchObject({
        id: "mom-MW",
        word: "MW",
        requestedBy: "mom",
        status: "pending",
      });
      expect(await requestHouseWord(uids.mom, { word: "MW" })).toEqual(
        requested,
      );
      expect((await ref.get()).data()).toEqual(pending);
      await expect(
        respondCurrentHouseWord(uids.mom, {
          requestId: requested.id,
          approve: true,
        }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      await expect(
        respondCurrentHouseWord("stranger", {
          requestId: requested.id,
          approve: true,
        }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      expect(
        (await getFirestore().doc(`games/${game.id}`).get()).data(),
      ).toEqual(beforeGame);
    });
    it("does not let a previous decline retry answer a renewed word request", async () => {
      const db = getFirestore();
      const { id } = await requestHouseWord(uids.mom, { word: "MW" });
      const ref = db.doc(`pairs/family/wordRequests/${id}`);
      // Simulate a server-clock rollback on renewal: the next generation must
      // still advance rather than reusing or going behind the previous token.
      await ref.update({ requestedAt: Date.now() + 60_000 });
      const first = (await ref.get()).data()!;
      const previousAnswer = {
        requestId: id,
        approve: false,
        expectedRequestedAt: first.requestedAt,
      };
      await respondHouseWord(uids.aunt, previousAnswer);
      await requestHouseWord(uids.mom, { word: "MW" });
      const renewed = (await ref.get()).data()!;
      expect(renewed.status).toBe("pending");
      expect(renewed.requestedAt).toBeGreaterThan(first.requestedAt);
      await expect(
        respondHouseWord(uids.aunt, previousAnswer),
      ).rejects.toMatchObject({ code: "failed-precondition" });
      await expect(
        respondHouseWord(uids.aunt, { ...previousAnswer, approve: true }),
      ).rejects.toMatchObject({ code: "failed-precondition" });
      for (const expectedRequestedAt of [
        undefined,
        0,
        -1,
        1.5,
        "123",
        Number.MAX_SAFE_INTEGER + 1,
      ])
        await expect(
          respondHouseWord(uids.aunt, {
            requestId: id,
            approve: false,
            ...(expectedRequestedAt === undefined
              ? {}
              : { expectedRequestedAt }),
          }),
        ).rejects.toMatchObject({ code: "invalid-argument" });
      expect((await ref.get()).data()).toEqual(renewed);
      const currentAnswer = {
        requestId: id,
        approve: true,
        expectedRequestedAt: renewed.requestedAt,
      };
      expect(await respondHouseWord(uids.aunt, currentAnswer)).toEqual({
        status: "accepted",
      });
      expect(await respondHouseWord(uids.aunt, currentAnswer)).toEqual({
        status: "accepted",
      });
    }, 15000);
    it("supports decline, an explicit fresh request, and idempotent consent without altering a turn", async () => {
      const db = getFirestore();
      const before = (await db.doc(`games/${game.id}`).get()).data();
      const { id } = await requestHouseWord(uids.mom, { word: "MW" });
      expect(
        await respondCurrentHouseWord(uids.aunt, {
          requestId: id,
          approve: false,
        }),
      ).toEqual({ status: "declined" });
      expect(
        await respondCurrentHouseWord(uids.aunt, {
          requestId: id,
          approve: false,
        }),
      ).toEqual({ status: "declined" });
      await expect(
        respondCurrentHouseWord(uids.aunt, { requestId: id, approve: true }),
      ).rejects.toMatchObject({ code: "failed-precondition" });
      expect((await db.doc("pairs/family/houseWords/MW").get()).exists).toBe(
        false,
      );
      expect(await requestHouseWord(uids.mom, { word: "mw" })).toEqual({ id });
      const pending = (
        await db.doc(`pairs/family/wordRequests/${id}`).get()
      ).data()!;
      expect(pending.status).toBe("pending");
      expect(pending).not.toHaveProperty("respondedBy");
      expect(pending).not.toHaveProperty("respondedAt");
      const answers = await Promise.all([
        respondCurrentHouseWord(uids.aunt, { requestId: id, approve: true }),
        respondCurrentHouseWord(uids.aunt, { requestId: id, approve: true }),
      ]);
      expect(answers).toEqual([{ status: "accepted" }, { status: "accepted" }]);
      const accepted = (
        await db.doc("pairs/family/houseWords/MW").get()
      ).data();
      expect(accepted).toMatchObject({
        word: "MW",
        requestedBy: "mom",
        approvedBy: "aunt",
      });
      expect(await requestHouseWord(uids.mom, { word: "MW" })).toEqual({ id });
      expect(
        await respondCurrentHouseWord(uids.aunt, {
          requestId: id,
          approve: true,
        }),
      ).toEqual({ status: "accepted" });
      expect((await db.doc("pairs/family/houseWords/MW").get()).data()).toEqual(
        accepted,
      );
      await expect(
        respondCurrentHouseWord(uids.aunt, { requestId: id, approve: false }),
      ).rejects.toMatchObject({ code: "failed-precondition" });
      expect((await db.doc(`games/${game.id}`).get()).data()).toEqual(before);
    }, 15000); // This full consent lifecycle includes concurrent approvals and Firestore retry backoff.
    it("rejects an unknown word with structured details until consent, then saves only a manually submitted turn", async () => {
      await prepareHouseWordRack("MW");
      const play = housePlay();
      await expect(submit(uids.mom, play)).rejects.toMatchObject({
        code: "failed-precondition",
        details: { rule: "dictionary", words: ["MW"] },
      });
      const request = await requestHouseWord(uids.mom, { word: "MW" });
      await expect(submit(uids.mom, play)).rejects.toMatchObject({
        details: { words: ["MW"] },
      });
      await respondCurrentHouseWord(uids.aunt, {
        requestId: request.id,
        approve: true,
      });
      const before = (
        await getFirestore().doc(`games/${game.id}`).get()
      ).data()!;
      expect(before.revision).toBe(0);
      expect(before.board).toEqual({});
      expect(before.turn).toBe("mom");
      const result = await submit(uids.mom, play);
      expect(result).toMatchObject({ revision: 1, score: 14 });
      expect(await submit(uids.mom, play)).toEqual(result);
      expect(
        (await getFirestore().doc(`games/${game.id}`).get()).data()?.lastMove
          .words,
      ).toEqual(["MW"]);
      await expect(submit(uids.mom, command("pass", 1))).rejects.toMatchObject({
        code: "failed-precondition",
      });
    });
    it("checks every main and cross word independently against approved house words", async () => {
      await prepareHouseWordRack("MW", [
        { letter: "Q", row: 6, col: 7 },
        { letter: "X", row: 8, col: 7 },
      ]);
      const play = housePlay();
      await approveHouseWord("MW");
      await expect(submit(uids.mom, play)).rejects.toMatchObject({
        details: { rule: "dictionary", words: ["QMX"] },
      });
      expect(
        (await getFirestore().doc(`games/${game.id}`).get()).data()?.revision,
      ).toBe(0);
      await approveHouseWord("QMX");
      expect(await submit(uids.mom, play)).toMatchObject({
        revision: 1,
        score: 56,
      });
      expect(
        (await getFirestore().doc(`games/${game.id}`).get()).data()?.lastMove
          .words,
      ).toEqual(["MW", "QMX"]);
    });
    it("retains approved house vocabulary through a rematch", async () => {
      await approveHouseWord("MW");
      for (let revision = 0; revision < 6; revision++)
        await submit(
          revision % 2 === 0 ? uids.mom : uids.aunt,
          command("pass", revision),
        );
      const rematch = await submit(uids.aunt, command("rematch", 6));
      expect(
        (await getFirestore().doc("pairs/family/houseWords/MW").get()).data(),
      ).toMatchObject({ word: "MW", requestedBy: "mom", approvedBy: "aunt" });
      game = createGame(rematch.gameId, () => 0.5);
      await prepareHouseWordRack("MW");
      expect(await submit(uids.mom, housePlay())).toMatchObject({
        gameId: rematch.gameId,
        revision: 1,
        score: 14,
      });
    });
    it("restricts dictionary reads to current members and all dictionary writes to the server", async () => {
      await approveHouseWord("MW");
      const mom = env.authenticatedContext(uids.mom).firestore();
      const aunt = env.authenticatedContext(uids.aunt).firestore();
      const stranger = env.authenticatedContext("stranger").firestore();
      for (const client of [mom, aunt]) {
        await assertSucceeds(
          getDocs(collection(client, "pairs/family/houseWords")),
        );
        await assertSucceeds(
          getDocs(collection(client, "pairs/family/wordRequests")),
        );
        await assertSucceeds(getDoc(doc(client, "pairs/family/houseWords/MW")));
        await assertFails(
          setDoc(doc(client, "pairs/family/houseWords/ZZ"), {
            word: "ZZ",
            requestedBy: "mom",
            approvedBy: "aunt",
            approvedAt: Date.now(),
          }),
        );
        await assertFails(
          setDoc(
            doc(client, "pairs/family/wordRequests/mom-MW"),
            { status: "accepted" },
            { merge: true },
          ),
        );
      }
      await assertFails(
        getDocs(collection(stranger, "pairs/family/houseWords")),
      );
      await assertFails(
        getDoc(doc(stranger, "pairs/family/wordRequests/mom-MW")),
      );
      await getFirestore().doc("players/mom").set({ uid: "replacement-mom" });
      await assertFails(getDocs(collection(mom, "pairs/family/houseWords")));
      await assertFails(getDoc(doc(mom, "pairs/family/wordRequests/mom-MW")));
      await expect(
        requestHouseWord(uids.mom, { word: "QMX" }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      await expect(
        respondCurrentHouseWord(uids.mom, {
          requestId: "mom-MW",
          approve: true,
        }),
      ).rejects.toMatchObject({ code: "permission-denied" });
    });
    it("records a validated new-game proposal without changing either player's game or private tiles", async () => {
      const db = getFirestore();
      const refs = [
        db.doc(`games/${game.id}`),
        db.doc(`games/${game.id}/racks/mom`),
        db.doc(`games/${game.id}/racks/aunt`),
        db.doc(`games/${game.id}/private/state`),
      ];
      const before = (await db.getAll(...refs)).map((s) => s.data());
      await expect(
        requestGameRestart(undefined, { id: randomUUID(), gameId: game.id }),
      ).rejects.toMatchObject({ code: "unauthenticated" });
      await expect(
        requestGameRestart("stranger", { id: randomUUID(), gameId: game.id }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      for (const data of [
        { id: "short", gameId: game.id },
        { id: randomUUID(), gameId: "bad/path" },
        { id: randomUUID(), gameId: game.id, approve: true },
      ])
        await expect(requestGameRestart(uids.mom, data)).rejects.toMatchObject({
          code: "invalid-argument",
        });
      const data = { id: randomUUID(), gameId: game.id };
      expect(await requestGameRestart(uids.mom, data)).toEqual({ id: data.id });
      const saved = (
        await db.doc(`pairs/family/gameRequests/${data.id}`).get()
      ).data();
      expect(saved).toMatchObject({
        ...data,
        requestedBy: "mom",
        status: "pending",
      });
      expect(await requestGameRestart(uids.mom, data)).toEqual({ id: data.id });
      expect(
        (await db.doc(`pairs/family/gameRequests/${data.id}`).get()).data(),
      ).toEqual(saved);
      expect((await db.getAll(...refs)).map((s) => s.data())).toEqual(before);
      await expect(requestGameRestart(uids.aunt, data)).rejects.toMatchObject({
        code: "already-exists",
      });
    });
    it("requires the other player's answer and keeps declined proposal retries separate from a fresh request", async () => {
      const db = getFirestore();
      const before = (await db.doc(`games/${game.id}`).get()).data();
      const first = { id: randomUUID(), gameId: game.id };
      await requestGameRestart(uids.mom, first);
      await expect(
        respondGameRestart(uids.mom, { requestId: first.id, approve: true }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      expect(
        await respondGameRestart(uids.aunt, {
          requestId: first.id,
          approve: false,
        }),
      ).toEqual({ status: "declined" });
      expect(
        await respondGameRestart(uids.aunt, {
          requestId: first.id,
          approve: false,
        }),
      ).toEqual({ status: "declined" });
      await expect(
        respondGameRestart(uids.aunt, { requestId: first.id, approve: true }),
      ).rejects.toMatchObject({ code: "failed-precondition" });
      expect(await requestGameRestart(uids.mom, first)).toEqual({
        id: first.id,
      });
      const next = { id: randomUUID(), gameId: game.id };
      await requestGameRestart(uids.mom, next);
      await respondGameRestart(uids.aunt, {
        requestId: first.id,
        approve: false,
      });
      expect(
        (await db.doc(`pairs/family/gameRequests/${next.id}`).get()).data()
          ?.status,
      ).toBe("pending");
      expect(
        (await db.doc("pairs/family").get()).data()?.pendingNewGameRequestId,
      ).toBe(next.id);
      expect((await db.doc(`games/${game.id}`).get()).data()).toEqual(before);
      expect((await db.collection("games").get()).size).toBe(1);
    }, 15000);
    it("creates exactly one fresh private game on concurrent approval and preserves old receipts and house words", async () => {
      const db = getFirestore();
      await approveHouseWord("MW");
      const pass = command();
      const receipt = await submit(uids.mom, pass);
      const oldRef = db.doc(`games/${game.id}`);
      const old = (await oldRef.get()).data()!;
      const oldPrivateRefs = [
        oldRef.collection("racks").doc("mom"),
        oldRef.collection("racks").doc("aunt"),
        oldRef.collection("private").doc("state"),
      ];
      const oldPrivate = (await db.getAll(...oldPrivateRefs)).map((s) =>
        s.data(),
      );
      const proposal = { id: randomUUID(), gameId: game.id };
      await requestGameRestart(uids.mom, proposal);
      const answer = { requestId: proposal.id, approve: true };
      const [first, second] = await Promise.all([
        respondGameRestart(uids.aunt, answer),
        respondGameRestart(uids.aunt, answer),
      ]);
      expect(second).toEqual(first);
      expect(first).toMatchObject({ status: "accepted" });
      expect(first.newGameId).not.toBe(game.id);
      expect((await db.collection("games").get()).size).toBe(2);
      expect((await db.doc("pairs/family").get()).data()).toMatchObject({
        activeGameId: first.newGameId,
        pendingNewGameRequestId: null,
      });
      expect((await oldRef.get()).data()).toMatchObject({
        ...old,
        status: "finished",
        winner: null,
        revision: old.revision + 1,
        endedReason: "new-game",
        replacedByGameId: first.newGameId,
      });
      expect((await db.getAll(...oldPrivateRefs)).map((s) => s.data())).toEqual(
        oldPrivate,
      );
      const fresh = (await db.doc(`games/${first.newGameId}`).get()).data()!;
      expect(fresh).toMatchObject({
        revision: 0,
        status: "active",
        turn: "mom",
        board: {},
        scores: { mom: 0, aunt: 0 },
        bagCount: 86,
        rackCounts: { mom: 7, aunt: 7 },
        winner: null,
      });
      const tiles = (
        await db.getAll(
          db.doc(`games/${first.newGameId}/racks/mom`),
          db.doc(`games/${first.newGameId}/racks/aunt`),
          db.doc(`games/${first.newGameId}/private/state`),
        )
      ).map((s) => s.data()!);
      expect(
        new Set(
          [...tiles[0].tiles, ...tiles[1].tiles, ...tiles[2].bag].map(
            (tile) => tile.id,
          ),
        ).size,
      ).toBe(100);
      expect((await db.doc("pairs/family/houseWords/MW").get()).exists).toBe(
        true,
      );
      expect(await respondGameRestart(uids.aunt, answer)).toEqual(first);
      expect(await requestGameRestart(uids.mom, proposal)).toEqual({
        id: proposal.id,
      });
      expect(await submit(uids.mom, pass)).toEqual(receipt);
      await expect(submit(uids.aunt, command("pass", 1))).rejects.toMatchObject(
        { code: "failed-precondition" },
      );
      await expect(
        respondGameRestart(uids.aunt, { ...answer, approve: false }),
      ).rejects.toMatchObject({ code: "failed-precondition" });
    }, 30000); // Concurrent approvals deliberately exercise transaction lock/retry backoff plus receipt/history checks.
    it("serializes simultaneous requests without interpreting a second proposal as approval", async () => {
      const db = getFirestore();
      const proposals = ["mom", "aunt"].map(() => ({
        id: randomUUID(),
        gameId: game.id,
      }));
      const results = await Promise.all([
        requestGameRestart(uids.mom, proposals[0]),
        requestGameRestart(uids.aunt, proposals[1]),
      ]);
      expect(results[0]).toEqual(results[1]);
      const requests = await db.collection("pairs/family/gameRequests").get();
      expect(requests.size).toBe(1);
      expect(requests.docs[0].data().status).toBe("pending");
      expect((await db.collection("games").get()).size).toBe(1);
      expect((await db.doc(`games/${game.id}`).get()).data()?.revision).toBe(0);
    }, 15000);
    it("serializes an in-flight turn with new-game approval without leaking it onto the fresh board", async () => {
      const db = getFirestore();
      const proposal = { id: randomUUID(), gameId: game.id };
      await requestGameRestart(uids.aunt, proposal);
      const pass = command();
      const [turn, approval] = await Promise.allSettled([
        submit(uids.mom, pass),
        respondGameRestart(uids.mom, { requestId: proposal.id, approve: true }),
      ]);
      expect(approval.status).toBe("fulfilled");
      const freshId = (await db.doc("pairs/family").get()).data()!.activeGameId;
      expect((await db.doc(`games/${freshId}`).get()).data()).toMatchObject({
        revision: 0,
        lastMove: null,
        scores: { mom: 0, aunt: 0 },
        board: {},
      });
      const old = (await db.doc(`games/${game.id}`).get()).data()!;
      expect(old.status).toBe("finished");
      if (turn.status === "fulfilled") {
        expect(old.revision).toBe(2);
        expect(await submit(uids.mom, pass)).toEqual(turn.value);
      } else {
        expect(turn.reason).toMatchObject({ code: "failed-precondition" });
        expect(old.revision).toBe(1);
        expect(
          (await db.doc(`games/${game.id}/commands/${pass.id}`).get()).exists,
        ).toBe(false);
      }
    }, 15000);
    it("rejects stale proposals after a finished-match rematch and preserves completed request outcomes", async () => {
      const db = getFirestore();
      const proposal = { id: randomUUID(), gameId: game.id };
      await requestGameRestart(uids.mom, proposal);
      for (let revision = 0; revision < 6; revision++)
        await submit(
          revision % 2 === 0 ? uids.mom : uids.aunt,
          command("pass", revision),
        );
      const rematch = await submit(uids.aunt, command("rematch", 6));
      expect((await db.doc("pairs/family").get()).data()).toMatchObject({
        activeGameId: rematch.gameId,
        pendingNewGameRequestId: null,
      });
      await expect(
        respondGameRestart(uids.aunt, {
          requestId: proposal.id,
          approve: true,
        }),
      ).rejects.toMatchObject({ code: "failed-precondition" });
      await expect(
        requestGameRestart(uids.mom, { id: randomUUID(), gameId: game.id }),
      ).rejects.toMatchObject({ code: "failed-precondition" });
      expect((await db.collection("games").get()).size).toBe(2);
    }, 15000);
    it("requires consent for a completed match's next game while preserving its final result", async () => {
      const db = getFirestore();
      for (let revision = 0; revision < 6; revision++)
        await submit(
          revision % 2 === 0 ? uids.mom : uids.aunt,
          command("pass", revision),
        );
      const oldRef = db.doc(`games/${game.id}`);
      const completed = (await oldRef.get()).data()!;
      expect(completed.status).toBe("finished");
      const proposal = { id: randomUUID(), gameId: game.id };
      await requestGameRestart(uids.mom, proposal);
      expect((await oldRef.get()).data()).toEqual(completed);
      await expect(
        respondGameRestart(uids.mom, { requestId: proposal.id, approve: true }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      const result = await respondGameRestart(uids.aunt, {
        requestId: proposal.id,
        approve: true,
      });
      const archived = (await oldRef.get()).data()!;
      expect(archived).toMatchObject({
        ...completed,
        replacedByGameId: result.newGameId,
      });
      expect(archived).toMatchObject({
        endedReason: "scoreless",
        endedAt: completed.endedAt,
      });
      expect((await db.doc("pairs/family").get()).data()?.activeGameId).toBe(
        result.newGameId,
      );
      expect(
        await respondGameRestart(uids.aunt, {
          requestId: proposal.id,
          approve: true,
        }),
      ).toEqual(result);
    }, 15000);
    it("still accepts a pending request when ordinary turns finish that match before the answer", async () => {
      const db = getFirestore();
      const proposal = { id: randomUUID(), gameId: game.id };
      await requestGameRestart(uids.aunt, proposal);
      for (let revision = 0; revision < 6; revision++)
        await submit(
          revision % 2 === 0 ? uids.mom : uids.aunt,
          command("pass", revision),
        );
      const oldRef = db.doc(`games/${game.id}`);
      const completed = (await oldRef.get()).data()!;
      const result = await respondGameRestart(uids.mom, {
        requestId: proposal.id,
        approve: true,
      });
      expect((await oldRef.get()).data()).toMatchObject({
        ...completed,
        replacedByGameId: result.newGameId,
      });
      expect((await db.collection("games").get()).size).toBe(2);
    }, 15000);
    it("protects new-game requests against client writes, strangers and replaced devices", async () => {
      const db = getFirestore();
      const proposal = { id: randomUUID(), gameId: game.id };
      await requestGameRestart(uids.mom, proposal);
      const path = `pairs/family/gameRequests/${proposal.id}`;
      for (const uid of Object.values(uids)) {
        const client = env.authenticatedContext(uid).firestore();
        await assertSucceeds(
          getDocs(collection(client, "pairs/family/gameRequests")),
        );
        await assertSucceeds(getDoc(doc(client, path)));
        await assertFails(
          setDoc(doc(client, path), { status: "accepted" }, { merge: true }),
        );
      }
      const stranger = env.authenticatedContext("stranger").firestore();
      await assertFails(
        getDocs(collection(stranger, "pairs/family/gameRequests")),
      );
      await expect(
        respondGameRestart("stranger", {
          requestId: proposal.id,
          approve: true,
        }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      await db.doc("players/aunt").set({ uid: "replacement-aunt" });
      const oldClient = env.authenticatedContext(uids.aunt).firestore();
      await assertFails(getDoc(doc(oldClient, path)));
      await expect(
        respondGameRestart(uids.aunt, {
          requestId: proposal.id,
          approve: true,
        }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      await expect(
        requestGameRestart(uids.aunt, { id: randomUUID(), gameId: game.id }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      expect((await db.doc("pairs/family").get()).data()?.activeGameId).toBe(
        game.id,
      );
    });
    it("allows own-turn pass and exchange without a board word and rejects only the documented bag and turn restrictions", async () => {
      const db = getFirestore();
      const pass = command();
      expect(await submit(uids.mom, pass)).toMatchObject({
        revision: 1,
        score: 0,
      });
      expect(
        (await db.doc(`games/${game.id}/racks/mom`).get()).data()?.tiles,
      ).toEqual(game.racks.mom);
      const exchangedId = game.racks.aunt[0].id;
      const exchange = { ...command("exchange", 1), tileIds: [exchangedId] };
      expect(await submit(uids.aunt, exchange)).toMatchObject({
        revision: 2,
        score: 0,
      });
      const rack = (await db.doc(`games/${game.id}/racks/aunt`).get()).data()!
        .tiles;
      expect(rack).toHaveLength(7);
      expect(rack.some((tile: { id: string }) => tile.id === exchangedId)).toBe(
        false,
      );
      expect((await db.doc(`games/${game.id}`).get()).data()).toMatchObject({
        turn: "mom",
        board: {},
        scores: { mom: 0, aunt: 0 },
        bagCount: 86,
      });
      await expect(submit(uids.aunt, command("pass", 2))).rejects.toMatchObject(
        { details: { rule: "turn" } },
      );
      await db
        .doc(`games/${game.id}/private/state`)
        .update({ bag: game.bag.slice(0, 6) });
      await expect(
        submit(uids.mom, {
          ...command("exchange", 2),
          tileIds: [game.racks.mom[0].id],
        }),
      ).rejects.toMatchObject({ details: { rule: "exchange" } });
      expect(await submit(uids.mom, command("pass", 2))).toMatchObject({
        revision: 3,
        score: 0,
      });
    });
    it("validates and freezes the requested win condition including duplicate and simultaneous proposals", async () => {
      const db = getFirestore();
      for (const choice of ["first-to-150", "", null, 150, { mode: "classic" }])
        await expect(
          requestGameRestart(uids.mom, {
            id: randomUUID(),
            gameId: game.id,
            winCondition: choice,
          }),
        ).rejects.toMatchObject({ code: "invalid-argument" });
      const proposal = {
        id: randomUUID(),
        gameId: game.id,
        winCondition: "turn-limit",
      };
      await requestGameRestart(uids.mom, proposal);
      expect(await requestGameRestart(uids.mom, proposal)).toEqual({
        id: proposal.id,
      });
      await expect(
        requestGameRestart(uids.mom, {
          ...proposal,
          winCondition: "target-score",
        }),
      ).rejects.toMatchObject({ code: "already-exists" });
      expect(
        await requestGameRestart(uids.aunt, {
          id: randomUUID(),
          gameId: game.id,
          winCondition: "target-score",
        }),
      ).toEqual({ id: proposal.id });
      expect(
        (await db.doc(`pairs/family/gameRequests/${proposal.id}`).get()).data(),
      ).toMatchObject({
        requestedBy: "mom",
        winCondition: "turn-limit",
        status: "pending",
      });
      const result = await respondGameRestart(uids.aunt, {
        requestId: proposal.id,
        approve: true,
      });
      expect(
        (await db.doc(`games/${result.newGameId}`).get()).data(),
      ).toMatchObject({
        winCondition: "turn-limit",
        turnsPlayed: 0,
        revision: 0,
      });
    });
    it("consents to both optional modes and retains each mode through the legacy rematch API", async () => {
      const db = getFirestore();
      for (const winCondition of ["turn-limit", "target-score"] as const) {
        const proposal = { id: randomUUID(), gameId: game.id, winCondition };
        await requestGameRestart(uids.mom, proposal);
        const result = await respondGameRestart(uids.aunt, {
          requestId: proposal.id,
          approve: true,
        });
        expect(
          (await db.doc(`games/${result.newGameId}`).get()).data(),
        ).toMatchObject({ winCondition, turnsPlayed: 0, revision: 0 });
        game = createGame(result.newGameId!, () => 0.5, winCondition);
        for (let revision = 0; revision < 6; revision++)
          await submit(
            revision % 2 === 0 ? uids.mom : uids.aunt,
            command("pass", revision),
          );
        const rematch = await submit(uids.aunt, command("rematch", 6));
        expect(
          (await db.doc(`games/${rematch.gameId}`).get()).data(),
        ).toMatchObject({
          winCondition,
          turnsPlayed: 0,
          revision: 0,
          status: "active",
        });
        game = createGame(rematch.gameId, () => 0.5, winCondition);
      }
    }, 15000);
    it("treats a legacy request with no mode as classic and cannot change the agreed mode through a turn payload", async () => {
      const db = getFirestore();
      const proposal = { id: randomUUID(), gameId: game.id };
      await requestGameRestart(uids.mom, proposal);
      const savedRef = db.doc(`pairs/family/gameRequests/${proposal.id}`);
      const { winCondition: _legacyMode, ...legacy } = (
        await savedRef.get()
      ).data()!;
      await savedRef.set(legacy);
      expect(await requestGameRestart(uids.mom, proposal)).toEqual({
        id: proposal.id,
      });
      const result = await respondGameRestart(uids.aunt, {
        requestId: proposal.id,
        approve: true,
      });
      game = createGame(result.newGameId!);
      expect((await db.doc(`games/${game.id}`).get()).data()).toMatchObject({
        winCondition: "classic",
        turnsPlayed: 0,
      });
      await expect(
        submit(uids.mom, { ...command(), winCondition: "target-score" }),
      ).rejects.toMatchObject({ code: "invalid-argument" });
      expect((await db.doc(`games/${game.id}`).get()).data()?.turnsPlayed).toBe(
        0,
      );
    });
    it("authoritatively ends an agreed turn-limit game at20 without deductions or duplicate counting", async () => {
      const db = getFirestore();
      game.winCondition = "turn-limit";
      game.turnsPlayed = 19;
      game.scores = { mom: 24, aunt: 31 };
      await writeGame(game);
      const pass = command();
      const result = await submit(uids.mom, pass);
      expect(await submit(uids.mom, pass)).toEqual(result);
      expect((await db.doc(`games/${game.id}`).get()).data()).toMatchObject({
        turnsPlayed: 20,
        endedReason: "turn-limit",
        scores: { mom: 24, aunt: 31 },
        status: "finished",
        winner: "aunt",
      });
      await expect(submit(uids.aunt, command("pass", 1))).rejects.toMatchObject(
        { details: { rule: "finished" } },
      );
    });
    it("authoritatively finishes at150 on a scoring move without rack deduction or duplicate scoring", async () => {
      const db = getFirestore();
      await approveHouseWord("MW");
      await prepareHouseWordRack("MW");
      game.winCondition = "target-score";
      game.scores = { mom: 136, aunt: 145 };
      await writeGame(game);
      const play = housePlay();
      const result = await submit(uids.mom, play);
      expect(await submit(uids.mom, play)).toEqual(result);
      expect((await db.doc(`games/${game.id}`).get()).data()).toMatchObject({
        turnsPlayed: 1,
        endedReason: "target-score",
        scores: { mom: 150, aunt: 145 },
        status: "finished",
        winner: "mom",
      });
    });
    it("validates immutable timed durations and begins the agreed clock on approval rather than proposal", async () => {
      const db = getFirestore();
      for (const durationMinutes of [0, -1, 1.5, 1441, "25", null])
        await expect(
          requestGameRestart(uids.mom, {
            id: randomUUID(),
            gameId: game.id,
            winCondition: "timed",
            durationMinutes,
          }),
        ).rejects.toMatchObject({ code: "invalid-argument" });
      await expect(
        requestGameRestart(uids.mom, {
          id: randomUUID(),
          gameId: game.id,
          durationMinutes: 25,
        }),
      ).rejects.toMatchObject({ code: "invalid-argument" });
      for (const durationMinutes of [undefined, 7]) {
        const before = (await db.doc(`games/${game.id}`).get()).data();
        const proposal = {
          id: randomUUID(),
          gameId: game.id,
          winCondition: "timed",
          ...(durationMinutes === undefined ? {} : { durationMinutes }),
        };
        await requestGameRestart(uids.mom, proposal);
        const saved = (
          await db.doc(`pairs/family/gameRequests/${proposal.id}`).get()
        ).data()!;
        expect(saved).toMatchObject({
          winCondition: "timed",
          durationMinutes: durationMinutes ?? 25,
        });
        expect(saved).not.toHaveProperty("startedAt");
        expect((await db.doc(`games/${game.id}`).get()).data()).toEqual(before);
        await expect(
          requestGameRestart(uids.mom, { ...proposal, durationMinutes: 8 }),
        ).rejects.toMatchObject({ code: "already-exists" });
        const beforeApproval = Date.now();
        const result = await respondGameRestart(uids.aunt, {
          requestId: proposal.id,
          approve: true,
        });
        const afterApproval = Date.now();
        const fresh = (await db.doc(`games/${result.newGameId}`).get()).data()!;
        expect(fresh).toMatchObject({
          winCondition: "timed",
          durationMinutes: durationMinutes ?? 25,
          status: "active",
          revision: 0,
        });
        expect(fresh.startedAt).toBeGreaterThanOrEqual(beforeApproval);
        expect(fresh.startedAt).toBeLessThanOrEqual(afterApproval);
        expect(fresh.deadlineAt).toBe(
          fresh.startedAt + (durationMinutes ?? 25) * 60000,
        );
        game = createGame(
          result.newGameId!,
          () => 0.5,
          "timed",
          durationMinutes ?? 25,
        );
      }
    }, 15000);
    it("uses server time for an early timer call and leaves every game field untouched", async () => {
      const db = getFirestore();
      game = createGame(game.id, () => 0.5, "timed");
      await writeGame(game);
      const before = (await db.doc(`games/${game.id}`).get()).data();
      const start = Date.now();
      const result = await finishGameTimer(uids.aunt, { gameId: game.id });
      expect(result).toMatchObject({
        gameId: game.id,
        revision: 0,
        status: "active",
      });
      expect(result.serverNow).toBeGreaterThanOrEqual(start);
      expect(result.serverNow).toBeLessThanOrEqual(Date.now());
      expect((await db.doc(`games/${game.id}`).get()).data()).toEqual(before);
      await expect(
        finishGameTimer(uids.mom, {
          gameId: game.id,
          serverNow: game.deadlineAt! + 1,
        }),
      ).rejects.toMatchObject({ code: "invalid-argument" });
    });
    it("finishes an expired timer once under concurrent calls without rack deductions or a duplicate revision", async () => {
      const db = getFirestore();
      game = createGame(game.id, () => 0.5, "timed", 25, Date.now() - 1600000);
      game.scores = { mom: 42, aunt: 42 };
      await writeGame(game);
      const privateRefs = [
        db.doc(`games/${game.id}/racks/mom`),
        db.doc(`games/${game.id}/racks/aunt`),
        db.doc(`games/${game.id}/private/state`),
      ];
      const before = (await db.getAll(...privateRefs)).map((s) => s.data());
      const results = await Promise.all([
        finishGameTimer(uids.mom, { gameId: game.id }),
        finishGameTimer(uids.aunt, { gameId: game.id }),
      ]);
      for (const result of results)
        expect(result).toMatchObject({
          gameId: game.id,
          revision: 1,
          status: "finished",
        });
      const ended = (await db.doc(`games/${game.id}`).get()).data();
      expect(ended).toMatchObject({
        status: "finished",
        endedReason: "timed",
        winner: "tie",
        revision: 1,
        turnsPlayed: 0,
        lastMove: null,
        scores: { mom: 42, aunt: 42 },
      });
      expect(
        await finishGameTimer(uids.mom, { gameId: game.id }),
      ).toMatchObject({ revision: 1, status: "finished" });
      expect((await db.doc(`games/${game.id}`).get()).data()).toEqual(ended);
      expect((await db.getAll(...privateRefs)).map((s) => s.data())).toEqual(
        before,
      );
      expect(
        (await db.collection(`games/${game.id}/commands`).get()).size,
      ).toBe(0);
    }, 30000);
    it("commits timeout before rejecting late play, pass and exchange without any fabricated command receipt", async () => {
      const db = getFirestore();
      game = createGame(game.id, () => 0.5, "timed", 1, Date.now() - 120000);
      game.scores = { mom: 10, aunt: 30 };
      await writeGame(game);
      const privateRefs = [
        db.doc(`games/${game.id}/racks/mom`),
        db.doc(`games/${game.id}/racks/aunt`),
        db.doc(`games/${game.id}/private/state`),
      ];
      const before = (await db.getAll(...privateRefs)).map((s) => s.data());
      const commands = [
        command("pass"),
        { ...command("exchange"), tileIds: [game.racks.mom[0].id] },
        housePlay(),
      ];
      for (const late of commands) {
        await expect(submit(uids.mom, late)).rejects.toMatchObject({
          code: "failed-precondition",
          details: { rule: "timed", gameId: game.id, revision: 1 },
        });
        expect(
          (await db.doc(`games/${game.id}/commands/${late.id}`).get()).exists,
        ).toBe(false);
      }
      expect((await db.doc(`games/${game.id}`).get()).data()).toMatchObject({
        status: "finished",
        endedReason: "timed",
        winner: "aunt",
        revision: 1,
        turnsPlayed: 0,
        turn: "mom",
        lastMove: null,
        board: {},
        scores: { mom: 10, aunt: 30 },
      });
      expect((await db.getAll(...privateRefs)).map((s) => s.data())).toEqual(
        before,
      );
    });
    it("replays saved receipts before expiry checks and restarts a legacy timed rematch with the same duration", async () => {
      const db = getFirestore();
      game = createGame(game.id, () => 0.5, "timed", 11);
      await writeGame(game);
      const pass = command();
      const receipt = await submit(uids.mom, pass);
      await db.doc(`games/${game.id}`).update({ deadlineAt: Date.now() - 1 });
      expect(await submit(uids.mom, pass)).toEqual(receipt);
      expect((await db.doc(`games/${game.id}`).get()).data()?.status).toBe(
        "active",
      );
      expect(
        await finishGameTimer(uids.aunt, { gameId: game.id }),
      ).toMatchObject({ revision: 2, status: "finished" });
      expect(await submit(uids.mom, pass)).toEqual(receipt);
      const beforeRematch = Date.now();
      const rematch = await submit(uids.aunt, command("rematch", 2));
      const fresh = (await db.doc(`games/${rematch.gameId}`).get()).data()!;
      expect(fresh).toMatchObject({
        winCondition: "timed",
        durationMinutes: 11,
        revision: 0,
        turnsPlayed: 0,
        status: "active",
      });
      expect(fresh.startedAt).toBeGreaterThanOrEqual(beforeRematch);
      expect(fresh.deadlineAt).toBe(fresh.startedAt + 660000);
      expect(await submit(uids.mom, pass)).toEqual(receipt);
    }, 15000);
    it("restricts timer finalization to current members and rejects missing or non-timed games", async () => {
      const db = getFirestore();
      await expect(
        finishGameTimer(uids.mom, { gameId: game.id }),
      ).rejects.toMatchObject({ code: "failed-precondition" });
      await expect(
        finishGameTimer(uids.mom, { gameId: randomUUID() }),
      ).rejects.toMatchObject({ code: "not-found" });
      await expect(
        finishGameTimer(undefined, { gameId: game.id }),
      ).rejects.toMatchObject({ code: "unauthenticated" });
      game = createGame(game.id, () => 0.5, "timed", 1, Date.now() - 120000);
      await writeGame(game);
      await expect(
        finishGameTimer("stranger", { gameId: game.id }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      await db.doc("players/aunt").set({ uid: "replacement-aunt" });
      await expect(
        finishGameTimer(uids.aunt, { gameId: game.id }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      expect((await db.doc(`games/${game.id}`).get()).data()?.status).toBe(
        "active",
      );
    });
    it("preserves an expired old timer's earned outcome when approving a pending new game", async () => {
      const db = getFirestore();
      game = createGame(game.id, () => 0.5, "timed", 1, Date.now() - 120000);
      game.scores = { mom: 91, aunt: 47 };
      await writeGame(game);
      const proposal = {
        id: randomUUID(),
        gameId: game.id,
        winCondition: "timed",
        durationMinutes: 17,
      };
      await requestGameRestart(uids.aunt, proposal);
      const result = await respondGameRestart(uids.mom, {
        requestId: proposal.id,
        approve: true,
      });
      expect((await db.doc(`games/${game.id}`).get()).data()).toMatchObject({
        status: "finished",
        endedReason: "timed",
        winner: "mom",
        scores: { mom: 91, aunt: 47 },
        revision: 1,
        replacedByGameId: result.newGameId,
      });
      expect(
        (await db.doc(`games/${result.newGameId}`).get()).data(),
      ).toMatchObject({
        status: "active",
        winCondition: "timed",
        durationMinutes: 17,
        revision: 0,
      });
    });
    it("uses standard rack-out scoring before extra-mode cutoffs in all chosen modes", async () => {
      const db = getFirestore();
      await approveHouseWord("MW");
      for (const mode of [
        "classic",
        "turn-limit",
        "target-score",
        "timed",
      ] as const) {
        game = createGame(randomUUID(), () => 0.5, mode);
        await prepareHouseWordRack("MW");
        game.racks.mom = game.racks.mom.slice(0, 2);
        game.bag = [];
        game.scores.mom = 136;
        game.turnsPlayed = 19;
        await writeGame(game);
        await db.doc("pairs/family").update({ activeGameId: game.id });
        const deduction = game.racks.aunt.reduce(
          (sum, tile) => sum + tile.value,
          0,
        );
        await submit(uids.mom, housePlay());
        const ended = (await db.doc(`games/${game.id}`).get()).data()!;
        expect(ended).toMatchObject({
          status: "finished",
          scores: { mom: 150 + deduction, aunt: -deduction },
          winner: "mom",
          bagCount: 0,
          rackCounts: { mom: 0, aunt: 7 },
        });
        expect(ended).toMatchObject({
          endedReason: "rack-out",
          endedAt: expect.any(Number),
        });
      }
    }, 15000);
  },
);
