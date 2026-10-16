import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID, randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import { SETUP_WORDS, WORD_FAILURE_BUCKET } from "../functions/setup-words";
import { createCredential } from "../functions/player-login";
import { multiplayerBackendTests } from "./backend-multiplayer";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import {
  getFirestore,
  Timestamp as AdminTimestamp,
  Transaction,
} from "firebase-admin/firestore";
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
let login: typeof import("../functions/index").login;
let submit: typeof import("../functions/index").submit;
let publicGame: typeof import("../functions/index").publicGame;
let requestHouseWord: typeof import("../functions/index").requestHouseWord;
let respondHouseWord: typeof import("../functions/index").respondHouseWord;
let requestGameRestart: typeof import("../functions/index").requestGameRestart;
let respondGameRestart: typeof import("../functions/index").respondGameRestart;
let finishGameTimer: typeof import("../functions/index").finishGameTimer;
let requestGameEnd: typeof import("../functions/index").requestGameEnd;
let respondGameEnd: typeof import("../functions/index").respondGameEnd;
let receiveMoveDiagnostics: typeof import("../functions/index").receiveMoveDiagnostics;
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
async function captureTransactionReads<T>(action: () => Promise<T>) {
  const single = vi.spyOn(Transaction.prototype, "get");
  const batch = vi.spyOn(Transaction.prototype, "getAll");
  try {
    const result = await action();
    const paths = [...single.mock.calls, ...batch.mock.calls].flatMap((args) =>
      args.flatMap((value) =>
        value &&
        typeof value === "object" &&
        "path" in value &&
        typeof value.path === "string"
          ? [value.path]
          : [],
      ),
    );
    return { result, paths };
  } finally {
    single.mockRestore();
    batch.mockRestore();
  }
}

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
        login,
        submit,
        publicGame,
        requestHouseWord,
        respondHouseWord,
        requestGameRestart,
        respondGameRestart,
        finishGameTimer,
        requestGameEnd,
        respondGameEnd,
        receiveMoveDiagnostics,
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

    multiplayerBackendTests(
      () => env,
      () => ({
        login,
        submit,
        publicGame,
        requestHouseWord,
        respondHouseWord,
        requestGameRestart,
        respondGameRestart,
        requestGameEnd,
        respondGameEnd,
        finishGameTimer,
        receiveMoveDiagnostics,
      }),
    );

    it("authorizes diagnostic clocks without writes and keeps diagnostic budgets private", async () => {
      const db = getFirestore();
      const before = (await db.doc(`games/${game.id}`).get()).data();
      await expect(
        receiveMoveDiagnostics(undefined, { action: "clock" }),
      ).rejects.toMatchObject({ code: "unauthenticated" });
      await expect(
        receiveMoveDiagnostics("unbound", { action: "clock" }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      expect(
        await receiveMoveDiagnostics(uids.mom, { action: "clock" }),
      ).toMatchObject({ enabled: true, accepted: false });
      expect((await db.collection("diagnosticLimits").get()).size).toBe(0);
      expect((await db.doc(`games/${game.id}`).get()).data()).toEqual(before);
      await assertFails(
        getDoc(
          doc(
            env.authenticatedContext(uids.mom).firestore(),
            "diagnosticLimits/anything",
          ),
        ),
      );
    });
    it("deduplicates diagnostic reports and enforces the daily cap across concurrent calls", async () => {
      const report = {
        id: "incident-first",
        reason: "delivery-delay",
        gameId: game.id,
        moveId: "move-test",
        revision: 1,
        version: "local",
        browser: "iPad",
        standalone: true,
        transport: "xhr",
        longTaskSupport: false,
        delayMs: 20000,
        uncertaintyMs: 100,
        clockAgeMs: 1000,
        events: [{ name: "snapshot", ms: 20000, revision: 1 }],
      };
      expect(
        await receiveMoveDiagnostics(uids.mom, { action: "report", report }),
      ).toMatchObject({ accepted: true });
      expect(
        await receiveMoveDiagnostics(uids.mom, { action: "report", report }),
      ).toMatchObject({ accepted: false });
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          receiveMoveDiagnostics(uids.mom, {
            action: "report",
            report: { ...report, id: `incident-${index}` },
          }),
        ),
      );
      expect(results.filter((result) => result.accepted)).toHaveLength(4);
      const limits = await getFirestore().collection("diagnosticLimits").get();
      expect(limits.docs[0].data().ids).toHaveLength(5);
      await expect(
        receiveMoveDiagnostics(uids.mom, {
          action: "report",
          report: { ...report, passphrase: "secret" },
        }),
      ).rejects.toMatchObject({ code: "invalid-argument" });
    }, 20000);
    it("stops diagnostic logging remotely without writes when its kill switch is off", async () => {
      const previous = process.env.TEA_MOVE_DIAGNOSTICS_ENABLED;
      process.env.TEA_MOVE_DIAGNOSTICS_ENABLED = "false";
      try {
        expect(
          await receiveMoveDiagnostics(uids.mom, { action: "clock" }),
        ).toMatchObject({ enabled: false });
        expect(
          (await getFirestore().collection("diagnosticLimits").get()).size,
        ).toBe(0);
      } finally {
        if (previous === undefined)
          delete process.env.TEA_MOVE_DIAGNOSTICS_ENABLED;
        else process.env.TEA_MOVE_DIAGNOSTICS_ENABLED = previous;
      }
    });

    it("signs in the same player on multiple devices while preserving legacy membership and private racks", async () => {
      const db = getFirestore();
      await db.doc("playerCredentials/mom").set({
        ...(await createCredential("maple apple river 7KQ2")),
        enabled: true,
      });
      const before = (await db.doc(`games/${game.id}`).get()).data();
      for (const uid of ["mom-ipad", "mom-iphone"])
        expect(
          await login(uid, {
            playerId: "mom",
            passphrase: "MAPLE-APPLE-RIVER-7kq2",
          }),
        ).toEqual({ playerId: "mom", slot: "mom" });
      expect((await db.doc("players/mom").get()).data()?.uid).toBe(uids.mom);
      for (const uid of [uids.mom, "mom-ipad", "mom-iphone"]) {
        const client = env.authenticatedContext(uid).firestore();
        await assertSucceeds(getDoc(doc(client, `games/${game.id}`)));
        await assertSucceeds(getDoc(doc(client, `games/${game.id}/racks/mom`)));
        await assertFails(getDoc(doc(client, `games/${game.id}/racks/aunt`)));
        await assertFails(getDoc(doc(client, "playerCredentials/mom")));
        await assertFails(getDoc(doc(client, "loginAttempts/mom")));
      }
      expect((await db.doc(`games/${game.id}`).get()).data()).toEqual(before);
      const c = command();
      const result = await submit("mom-ipad", c);
      expect(await submit("mom-ipad", c)).toEqual(result);
      await expect(submit("mom-iphone", c)).rejects.toMatchObject({
        code: "already-exists",
      });
      await assertFails(
        getDoc(
          doc(
            env.authenticatedContext("mom-iphone").firestore(),
            `games/${game.id}/commands/${c.id}`,
          ),
        ),
      );
      await submit(uids.aunt, command("pass", 1));
      await expect(
        submit("mom-iphone", command("pass", 2)),
      ).resolves.toMatchObject({ revision: 3 });
    }, 15000);
    it("requires private credentials and prevents an already bound browser from switching players", async () => {
      const db = getFirestore();
      await db.doc("playerCredentials/mom").set({
        ...(await createCredential("maple apple river 7KQ2")),
        enabled: true,
      });
      await expect(
        login(undefined, {
          playerId: "mom",
          passphrase: "maple apple river 7KQ2",
        }),
      ).rejects.toMatchObject({ code: "unauthenticated" });
      await expect(
        login("unknown", {
          playerId: "mom",
          passphrase: "incorrect passphrase",
        }),
      ).rejects.toMatchObject({
        code: "permission-denied",
        message: "The player or sign-in code is not correct.",
      });
      await expect(
        login("unknown", {
          playerId: "aunt",
          passphrase: "incorrect passphrase",
        }),
      ).rejects.toMatchObject({
        code: "permission-denied",
        message: "The player or sign-in code is not correct.",
      });
      await expect(
        login(uids.aunt, {
          playerId: "mom",
          passphrase: "maple apple river 7KQ2",
        }),
      ).rejects.toMatchObject({ code: "failed-precondition" });
      await expect(
        login("unknown", { playerId: "mom", passphrase: "Elizabeth" }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      expect((await db.doc("bindings/unknown").get()).exists).toBe(false);
    });
    it("limits reusable-login guessing across anonymous identities and reports its cooldown", async () => {
      const db = getFirestore();
      await db.doc("playerCredentials/mom").set({
        ...(await createCredential("000123")),
        enabled: true,
      });
      for (let index = 0; index < 10; index++)
        await expect(
          login(`login-guess-${index}`, {
            playerId: "mom",
            passphrase: "654321",
          }),
        ).rejects.toMatchObject({ code: "permission-denied" });
      await expect(
        login("fresh-login-device", {
          playerId: "mom",
          passphrase: "000123",
        }),
      ).rejects.toMatchObject({
        code: "resource-exhausted",
        details: { rule: "rate-limit", retryAfterSeconds: expect.any(Number) },
      });
      await db
        .doc("loginAttempts/mom")
        .set({ windowStart: Date.now() - 3600001, count: 10 });
      expect(
        await login("fresh-login-device", {
          playerId: "mom",
          passphrase: "000123",
        }),
      ).toEqual({ playerId: "mom", slot: "mom" });
      await db
        .doc("loginAttempts/mom")
        .set({ windowStart: Date.now(), count: 10 });
      expect(
        await login("fresh-login-device", {
          playerId: "mom",
          passphrase: "000123",
        }),
      ).toEqual({ playerId: "mom", slot: "mom" });
    }, 15000);
    it("bounds unknown-name guesses across fresh names and UIDs without throttling known accounts", async () => {
      const db = getFirestore();
      await db
        .doc("playerCredentials/mom")
        .set({ ...(await createCredential("123456")), enabled: true });
      for (let index = 0; index < 10; index++) {
        await expect(
          login(`unknown-name-device-${index}`, {
            playerId: `Nobody ${index}`,
            passphrase: "123456",
          }),
        ).rejects.toMatchObject({ code: "permission-denied" });
      }
      await expect(
        login("unknown-name-eleventh-device", {
          playerId: "Another unknown name",
          passphrase: "123456",
        }),
      ).rejects.toMatchObject({
        code: "resource-exhausted",
        details: { rule: "rate-limit", retryAfterSeconds: expect.any(Number) },
      });
      const attempts = await db.collection("loginAttempts").get();
      expect(attempts.docs.map((record) => record.id)).toEqual([
        "!unknown-names",
      ]);
      expect(attempts.docs[0].data().count).toBe(10);
      expect((await db.collection("enrollmentAttempts").get()).size).toBe(10);
      await expect(
        login("known-id-after-unknown-flood", {
          playerId: "mom",
          passphrase: "123456",
        }),
      ).resolves.toEqual({ playerId: "mom", slot: "mom" });
      await expect(
        login("known-name-after-unknown-flood", {
          playerId: "Elizabeth",
          passphrase: "123456",
        }),
      ).resolves.toEqual({ playerId: "mom", slot: "mom" });
      expect(
        (await db.collection("loginAttempts").get()).docs.map(
          (record) => record.id,
        ),
      ).toEqual(["!unknown-names"]);
    }, 15000);

    it("cannot authenticate an unresolved name through a seeded internal sentinel profile or binding", async () => {
      const db = getFirestore();
      await db
        .doc("players/!unresolved")
        .set({ uid: "sentinel-device", sessionVersion: 0 });
      await db
        .doc("playerCredentials/!unresolved")
        .set({ ...(await createCredential("123456")), enabled: true });
      await expect(
        login("fresh-sentinel-device", {
          playerId: "No such person",
          passphrase: "123456",
        }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      expect(
        (await db.doc("bindings/fresh-sentinel-device").get()).exists,
      ).toBe(false);
      await db
        .doc("bindings/sentinel-device")
        .set({ playerId: "!unresolved", sessionVersion: 0 });
      await db
        .doc("loginAttempts/!unknown-names")
        .set({ windowStart: Date.now(), count: 10 });
      await expect(
        login("sentinel-device", {
          playerId: "Another missing person",
          passphrase: "123456",
        }),
      ).rejects.toMatchObject({ code: "resource-exhausted" });
      await expect(
        login("direct-sentinel-device", {
          playerId: "!unresolved",
          passphrase: "123456",
        }),
      ).rejects.toMatchObject({ code: "resource-exhausted" });
      expect(
        (await db.doc("bindings/direct-sentinel-device").get()).exists,
      ).toBe(false);
    });

    it("keeps reusable sessions connected when a one-use invitation replaces the legacy device", async () => {
      const db = getFirestore();
      await db.doc("playerCredentials/mom").set({
        ...(await createCredential("maple apple river 7KQ2")),
        enabled: true,
      });
      await login("reusable-mom", {
        playerId: "mom",
        passphrase: "maple apple river 7KQ2",
      });
      const code = await codeFor("mom");
      await enroll("replacement-invite-mom", { code });
      expect((await db.doc(`bindings/${uids.mom}`).get()).exists).toBe(false);
      expect(
        (await db.doc("bindings/reusable-mom").get()).data(),
      ).toMatchObject({ slot: "mom", sessionVersion: 0 });
      await assertSucceeds(
        getDoc(
          doc(
            env.authenticatedContext("reusable-mom").firestore(),
            `games/${game.id}/racks/mom`,
          ),
        ),
      );
      await expect(submit("reusable-mom", command())).resolves.toMatchObject({
        revision: 1,
      });
      await expect(submit(uids.mom, command())).rejects.toMatchObject({
        code: "permission-denied",
      });
    });
    it("issues, rotates and explicitly revokes reusable logins without altering the game", async () => {
      const db = getFirestore();
      const runAdmin = (action: string) =>
        execFileSync(
          process.execPath,
          [
            "scripts/admin.mjs",
            action,
            "--player",
            "Elizabeth",
            "--project",
            projectId,
          ],
          { encoding: "utf8", timeout: 15000 },
        );
      const readSecret = (output: string) =>
        output.match(/private passphrase: ([^\r\n]+)/)![1];
      const before = (await db.doc(`games/${game.id}`).get()).data();
      const firstPassphrase = readSecret(runAdmin("issue-login"));
      expect(firstPassphrase).toMatch(
        /^(?:[a-z]{5,7} ){3}[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/,
      );
      const firstCredential = (
        await db.doc("playerCredentials/mom").get()
      ).data()!;
      expect(firstCredential).toMatchObject({
        algorithm: "scrypt-v1",
        enabled: true,
      });
      expect(JSON.stringify(firstCredential)).not.toContain(firstPassphrase);
      await login("login-a", { playerId: "mom", passphrase: firstPassphrase });
      await login("login-b", { playerId: "mom", passphrase: firstPassphrase });
      const secondPassphrase = readSecret(runAdmin("issue-login"));
      const secondCredential = (
        await db.doc("playerCredentials/mom").get()
      ).data()!;
      expect(secondCredential.salt).not.toBe(firstCredential.salt);
      expect(secondCredential.digest).not.toBe(firstCredential.digest);
      expect((await db.doc("bindings/login-a").get()).exists).toBe(true);
      await expect(
        login("fresh-old-password", {
          playerId: "mom",
          passphrase: firstPassphrase,
        }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      await login("login-c", { playerId: "mom", passphrase: secondPassphrase });
      runAdmin("revoke-login");
      for (const uid of [uids.mom, "login-a", "login-b", "login-c"]) {
        expect((await db.doc(`bindings/${uid}`).get()).exists).toBe(false);
        await assertFails(
          getDoc(
            doc(env.authenticatedContext(uid).firestore(), `games/${game.id}`),
          ),
        );
      }
      expect((await db.doc(`bindings/${uids.aunt}`).get()).exists).toBe(true);
      await db.doc("bindings/login-a").set({ slot: "mom", sessionVersion: 0 });
      await assertFails(
        getDoc(
          doc(
            env.authenticatedContext("login-a").firestore(),
            `games/${game.id}`,
          ),
        ),
      );
      await expect(submit("login-a", command())).rejects.toMatchObject({
        code: "permission-denied",
      });
      await expect(
        login("login-a", { playerId: "mom", passphrase: secondPassphrase }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      const freshSecret = readSecret(runAdmin("issue-login"));
      await login("login-a", { playerId: "mom", passphrase: freshSecret });
      expect(
        (await db.doc("bindings/login-a").get()).data()?.sessionVersion,
      ).toBe(1);
      expect((await db.doc(`games/${game.id}`).get()).data()).toEqual(before);
    }, 30000);
    it("accepts leading-zero six-digit codes on multiple devices without replacing existing sessions", async () => {
      const db = getFirestore();
      const credential = {
        ...(await createCredential("000123")),
        enabled: true,
      };
      await db.doc("playerCredentials/mom").set(credential);
      const before = (await db.doc(`games/${game.id}`).get()).data();
      for (const uid of ["pin-ipad", "pin-phone"])
        expect(
          await login(uid, { playerId: "mom", passphrase: " 000123 " }),
        ).toEqual({ playerId: "mom", slot: "mom" });
      expect((await db.doc(`bindings/${uids.mom}`).get()).data()).toEqual({
        slot: "mom",
      });
      expect((await db.doc("playerCredentials/mom").get()).data()).toEqual(
        credential,
      );
      expect((await db.doc(`games/${game.id}`).get()).data()).toEqual(before);
      const client = env.authenticatedContext("pin-phone").firestore();
      await assertSucceeds(getDoc(doc(client, `games/${game.id}/racks/mom`)));
      await assertFails(getDoc(doc(client, `games/${game.id}/racks/aunt`)));
      await assertFails(getDoc(doc(client, "playerCredentials/mom")));
      const c = command();
      const result = await submit("pin-ipad", c);
      expect(await submit("pin-ipad", c)).toEqual(result);
      await submit(uids.aunt, command("pass", 1));
      await expect(
        submit("pin-phone", command("pass", 2)),
      ).resolves.toMatchObject({ revision: 3 });
    }, 15000);
    it("rejects malformed short codes and numeric payloads without granting membership", async () => {
      const db = getFirestore();
      await db
        .doc("playerCredentials/mom")
        .set({ ...(await createCredential("000123")), enabled: true });
      for (const passphrase of [
        "12345",
        "1234567",
        "abcdef",
        123456,
        "１２３４５６",
        "a".repeat(257),
      ])
        await expect(
          login("malformed-pin", { playerId: "mom", passphrase }),
        ).rejects.toMatchObject({ code: "invalid-argument" });
      await expect(
        login("wrong-pin", { playerId: "mom", passphrase: "000124" }),
      ).rejects.toMatchObject({
        code: "permission-denied",
        message: "The player or sign-in code is not correct.",
      });
      expect((await db.doc("bindings/malformed-pin").get()).exists).toBe(false);
      expect((await db.doc("bindings/wrong-pin").get()).exists).toBe(false);
      expect((await db.doc("loginAttempts/mom").get()).data()?.count).toBe(1);
    });
    it("issues private PIN links for both configured names while retaining existing games and devices", async () => {
      const db = getFirestore();
      const previousPassphrase = "maple apple river 7KQ2";
      await db.doc("playerCredentials/mom").set({
        ...(await createCredential(previousPassphrase)),
        enabled: true,
      });
      await login("previous-passphrase-device", {
        playerId: "mom",
        passphrase: previousPassphrase,
      });
      const before = (await db.doc(`games/${game.id}`).get()).data();
      const beforeBindings = (await db.collection("bindings").get()).docs.map(
        (record) => ({ id: record.id, ...record.data() }),
      );
      const beforePrivate = await Promise.all(
        ["racks/mom", "racks/aunt", "private/state"].map(async (path) =>
          (await db.doc(`games/${game.id}/${path}`).get()).data(),
        ),
      );
      await db
        .doc("loginAttempts/mom")
        .set({ windowStart: Date.now(), count: 10 });
      for (const [slot, name] of [
        ["mom", "Elizabeth"],
        ["aunt", "Rita"],
      ] as const) {
        const output = execFileSync(
          process.execPath,
          [
            "scripts/admin.mjs",
            "issue-pin",
            "--player",
            name,
            "--project",
            projectId,
            "--app-url",
            "https://example.test/tea/",
          ],
          { encoding: "utf8", timeout: 15000 },
        );
        const secret = output.match(/private six-digit code: ([^\r\n]+)/)![1];
        expect(secret).toMatch(/^[0-9]{6}$/);
        const link = new URL(output.match(/Sign-in link: ([^\r\n]+)/)![1]);
        expect(link.origin + link.pathname).toBe("https://example.test/tea/");
        expect(link.search).toBe("");
        expect(new URLSearchParams(link.hash.slice(1)).get("player")).toBe(
          slot,
        );
        expect(new URLSearchParams(link.hash.slice(1)).get("name")).toBe(name);
        expect(new URLSearchParams(link.hash.slice(1)).get("code")).toBe(
          secret,
        );
        const credential = (
          await db.doc(`playerCredentials/${slot}`).get()
        ).data()!;
        expect(credential).toMatchObject({
          algorithm: "scrypt-v1",
          enabled: true,
          salt: expect.stringMatching(/^[a-f0-9]{32}$/),
          digest: expect.stringMatching(/^[a-f0-9]{128}$/),
        });
        expect(credential).not.toHaveProperty("code");
        expect(credential).not.toHaveProperty("passphrase");
        expect((await db.doc(`loginAttempts/${slot}`).get()).exists).toBe(
          false,
        );
        expect(
          await login(`new-pin-${slot}`, {
            playerId: slot,
            passphrase: secret,
          }),
        ).toEqual({ playerId: slot, slot });
      }
      for (const record of beforeBindings)
        expect((await db.doc(`bindings/${record.id}`).get()).data()).toEqual(
          Object.fromEntries(
            Object.entries(record).filter(([key]) => key !== "id"),
          ),
        );
      await expect(
        login("fresh-old-passphrase", {
          playerId: "mom",
          passphrase: previousPassphrase,
        }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      await assertSucceeds(
        getDoc(
          doc(
            env.authenticatedContext("previous-passphrase-device").firestore(),
            `games/${game.id}`,
          ),
        ),
      );
      expect((await db.doc(`games/${game.id}`).get()).data()).toEqual(before);
      expect(
        await Promise.all(
          ["racks/mom", "racks/aunt", "private/state"].map(async (path) =>
            (await db.doc(`games/${game.id}/${path}`).get()).data(),
          ),
        ),
      ).toEqual(beforePrivate);
    }, 30000);
    it("allows current members to write their own server-timestamped presence and read both players without touching the game", async () => {
      const db = getFirestore();
      const before = (await db.doc(`games/${game.id}`).get()).data();
      for (const slot of ["mom", "aunt"] as const) {
        const client = env.authenticatedContext(uids[slot]).firestore();
        await assertSucceeds(
          setDoc(doc(client, `pairs/family/presence/${uids[slot]}`), {
            slot,
            lastSeen: serverTimestamp(),
          }),
        );
      }
      await db
        .doc("bindings/presence-second-device")
        .set({ slot: "mom", sessionVersion: 0 });
      await assertSucceeds(
        setDoc(
          doc(
            env.authenticatedContext("presence-second-device").firestore(),
            "pairs/family/presence/presence-second-device",
          ),
          { slot: "mom", lastSeen: serverTimestamp() },
        ),
      );
      const mom = env.authenticatedContext(uids.mom).firestore();
      const records = await assertSucceeds(
        getDocs(collection(mom, "pairs/family/presence")),
      );
      expect(records.docs.map((record) => record.data().slot).sort()).toEqual([
        "aunt",
        "mom",
        "mom",
      ]);
      for (const record of records.docs) {
        expect(Object.keys(record.data()).sort()).toEqual(["lastSeen", "slot"]);
        expect(record.data().lastSeen).toBeInstanceOf(Timestamp);
        expect(record.data().lastSeen.toMillis()).toBeLessThanOrEqual(
          Date.now() + 1000,
        );
        expect(record.data().lastSeen.toMillis()).toBeGreaterThan(
          Date.now() - 15000,
        );
      }
      await assertSucceeds(
        getDoc(doc(mom, `pairs/family/presence/${uids.aunt}`)),
      );
      expect((await db.doc(`games/${game.id}`).get()).data()).toEqual(before);
    });
    it("rejects forged presence identities, timestamps, extra fields, deletions and authoritative client writes", async () => {
      const client = env.authenticatedContext(uids.mom).firestore();
      const own = doc(client, `pairs/family/presence/${uids.mom}`);
      for (const data of [
        { slot: "aunt", lastSeen: serverTimestamp() },
        { slot: "mom", lastSeen: Timestamp.fromMillis(Date.now() + 86400000) },
        { slot: "mom", lastSeen: Timestamp.fromMillis(Date.now() - 1000) },
        { slot: "mom", lastSeen: Date.now() },
        { slot: "mom", lastSeen: serverTimestamp(), online: true },
        { lastSeen: serverTimestamp() },
        { slot: "mom" },
      ])
        await assertFails(setDoc(own, data));
      await assertFails(
        setDoc(doc(client, `pairs/family/presence/${uids.aunt}`), {
          slot: "mom",
          lastSeen: serverTimestamp(),
        }),
      );
      await assertSucceeds(
        setDoc(own, { slot: "mom", lastSeen: serverTimestamp() }),
      );
      await assertFails(deleteDoc(own));
      await assertFails(
        updateDoc(own, { slot: "aunt", lastSeen: serverTimestamp() }),
      );
      await assertFails(
        setDoc(doc(client, `games/${game.id}`), { status: "finished" }),
      );
      await assertFails(
        setDoc(doc(client, `games/${game.id}/racks/mom`), { tiles: [] }),
      );
      await assertFails(
        setDoc(doc(client, "bindings/new-device"), { slot: "mom" }),
      );
    });
    it("enforces the55-second presence update interval and rejects denied updates without changing lastSeen", async () => {
      const db = getFirestore();
      const ref = db.doc(`pairs/family/presence/${uids.mom}`);
      const client = env.authenticatedContext(uids.mom).firestore();
      const own = doc(client, ref.path);
      await assertSucceeds(
        setDoc(own, { slot: "mom", lastSeen: serverTimestamp() }),
      );
      const first = (await ref.get()).data()!;
      await assertFails(
        setDoc(own, { slot: "mom", lastSeen: serverTimestamp() }),
      );
      expect((await ref.get()).data()!.lastSeen.isEqual(first.lastSeen)).toBe(
        true,
      );
      // Seed an earlier server record rather than sleeping for a minute.
      await ref.set({
        slot: "mom",
        lastSeen: AdminTimestamp.fromMillis(Date.now() - 50000),
      });
      await assertFails(updateDoc(own, { lastSeen: serverTimestamp() }));
      await ref.set({
        slot: "mom",
        lastSeen: AdminTimestamp.fromMillis(Date.now() - 55000),
      });
      await assertSucceeds(updateDoc(own, { lastSeen: serverTimestamp() }));
      const accepted = (await ref.get()).data()!;
      expect(accepted.lastSeen.toMillis()).toBeGreaterThan(Date.now() - 15000);
      await assertFails(
        updateDoc(own, { lastSeen: serverTimestamp(), extra: "not allowed" }),
      );
      expect(
        (await ref.get()).data()!.lastSeen.isEqual(accepted.lastSeen),
      ).toBe(true);
    });
    it("denies presence reads and writes to strangers, replaced legacy devices and stale reusable sessions", async () => {
      const db = getFirestore();
      await db.doc(`pairs/family/presence/${uids.mom}`).set({
        slot: "mom",
        lastSeen: AdminTimestamp.fromMillis(Date.now() - 60000),
      });
      await db
        .doc("bindings/stale-session")
        .set({ slot: "mom", sessionVersion: 0 });
      await db
        .doc("players/mom")
        .update({ uid: "replacement", sessionVersion: 1 });
      for (const client of [
        env.unauthenticatedContext().firestore(),
        env.authenticatedContext("stranger").firestore(),
        env.authenticatedContext(uids.mom).firestore(),
        env.authenticatedContext("stale-session").firestore(),
      ]) {
        await assertFails(getDocs(collection(client, "pairs/family/presence")));
        await assertFails(
          getDoc(doc(client, `pairs/family/presence/${uids.mom}`)),
        );
      }
      for (const uid of ["stranger", uids.mom, "stale-session"]) {
        const client = env.authenticatedContext(uid).firestore();
        await assertFails(
          setDoc(doc(client, `pairs/family/presence/${uid}`), {
            slot: "mom",
            lastSeen: serverTimestamp(),
          }),
        );
      }
      const aunt = env.authenticatedContext(uids.aunt).firestore();
      await assertSucceeds(getDocs(collection(aunt, "pairs/family/presence")));
      await assertSucceeds(
        setDoc(doc(aunt, `pairs/family/presence/${uids.aunt}`), {
          slot: "aunt",
          lastSeen: serverTimestamp(),
        }),
      );
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
      expect(await enroll("replacement", { code })).toEqual({
        playerId: "mom",
        slot: "mom",
      });
      expect(await enroll("replacement", { code })).toEqual({
        playerId: "mom",
        slot: "mom",
      });
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
      ).toEqual({ playerId: "mom", slot: "mom" });
      expect(await enroll("short-code-device", { code: "ABCD-2345" })).toEqual({
        playerId: "mom",
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
        playerId: "aunt",
        slot: "aunt",
      });
      expect(await enroll("legacy-device", { code: legacy })).toEqual({
        playerId: "aunt",
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
        playerId: "mom",
        slot: "mom",
      });
      expect(await enroll("word-device", { code: "maple" })).toEqual({
        playerId: "mom",
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
        playerId: "mom",
        slot: "mom",
      });
      expect(
        (await getFirestore().doc(WORD_FAILURE_BUCKET).get()).data()?.count,
      ).toBe(10);
      await getFirestore()
        .doc(WORD_FAILURE_BUCKET)
        .set({ windowStart: Date.now() - 3600001, count: 10 });
      expect(await enroll("new-valid-word-device", { code: "peach" })).toEqual({
        playerId: "aunt",
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
        playerId: "mom",
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
        playerId: "mom",
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
        expect((await db.doc(`players/${slot}`).get()).data()).toMatchObject({
          displayName: slot === "mom" ? "Elizabeth" : "Rita",
          loginName: slot === "mom" ? "elizabeth" : "rita",
        });
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
      const privateRefs = [
        ref.collection("racks").doc("mom"),
        ref.collection("racks").doc("aunt"),
        ref.collection("private").doc("state"),
      ];
      const privateBefore = await db.getAll(...privateRefs);
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
      expect(finished.finalScoreAdjustments).toMatchObject({
        reason: "scoreless",
        players: {
          mom: {
            earned: 0,
            rackValue: deductions.mom,
            deducted: deductions.mom,
            transferred: 0,
            final: -deductions.mom,
          },
          aunt: {
            earned: 0,
            rackValue: deductions.aunt,
            deducted: deductions.aunt,
            transferred: 0,
            final: -deductions.aunt,
          },
        },
      });
      expect(finished.history).toHaveLength(6);
      const privateAfter = await db.getAll(...privateRefs);
      privateAfter.forEach((snapshot, index) => {
        expect(snapshot.data()).toEqual(privateBefore[index].data());
        expect(
          snapshot.updateTime!.isEqual(privateBefore[index].updateTime!),
        ).toBe(true);
      });
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
      const freshRef = db.doc(`games/${result.gameId}`);
      const freshPrivate = await db.getAll(
        freshRef.collection("racks").doc("mom"),
        freshRef.collection("racks").doc("aunt"),
        freshRef.collection("private").doc("state"),
      );
      expect(freshPrivate.map((snapshot) => snapshot.exists)).toEqual([
        true,
        true,
        true,
      ]);
      expect(
        freshPrivate.map((snapshot, index) =>
          index === 2
            ? snapshot.data()!.bag.length
            : snapshot.data()!.tiles.length,
        ),
      ).toEqual([7, 7, 86]);
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
      const untouchedRefs = [
        db.doc(`games/${game.id}/racks/aunt`),
        db.doc(`games/${game.id}/private/state`),
      ];
      const untouchedBefore = await db.getAll(...untouchedRefs);
      const lastTile = {
        ...command("play"),
        placements: [{ tileId: game.racks.mom[0].id, row: 7, col: 8 }],
      };
      const before = Date.now();
      const result = await submit(uids.mom, lastTile);
      expect(result).toMatchObject({ revision: 1, score: 2 });
      const untouchedAfter = await db.getAll(...untouchedRefs);
      untouchedAfter.forEach((snapshot, index) => {
        expect(snapshot.data()).toEqual(untouchedBefore[index].data());
        expect(
          snapshot.updateTime!.isEqual(untouchedBefore[index].updateTime!),
        ).toBe(true);
      });
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
      expect(finished.finalScoreAdjustments).toEqual({
        reason: "rack-out",
        players: {
          mom: {
            earned: 22,
            rackValue: 0,
            deducted: 0,
            transferred: 10,
            final: 32,
          },
          aunt: {
            earned: 25,
            rackValue: 10,
            deducted: 10,
            transferred: 0,
            final: 15,
          },
        },
      });
      expect(finished.lastMove.breakdown).toMatchObject({
        total: 2,
        bingoBonus: 0,
        words: [{ word: "AT", score: 2, wordMultiplier: 1 }],
      });
      expect(finished.history).toHaveLength(1);
      expect(finished.history[0]).toMatchObject({
        id: lastTile.id,
        score: 2,
        wordScores: [{ word: "AT", score: 2 }],
      });
      expect(finished.history[0]).not.toHaveProperty("placements");
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
    it("starts partial compact history for legacy matches without inventing earlier moves or duplicating retries", async () => {
      const db = getFirestore();
      game.revision = 4;
      delete game.history;
      delete game.historyComplete;
      await writeGame(game);
      const first = command("pass", 4);
      const result = await submit(uids.mom, first);
      expect(await submit(uids.mom, first)).toEqual(result);
      await submit(uids.aunt, command("pass", 5));
      const updated = (await db.doc(`games/${game.id}`).get()).data()!;
      expect(updated.historyComplete).toBe(false);
      expect(updated.history).toHaveLength(2);
      expect(
        updated.history.map((move: { player: Slot }) => move.player),
      ).toEqual(["mom", "aunt"]);
      expect(updated.history[0]).toMatchObject({
        id: first.id,
        score: 0,
        words: [],
      });
      expect(updated.history[0]).not.toHaveProperty("placements");
    });
    it("checks global approval before declining a word without changing its house-dictionary entry", async () => {
      const db = getFirestore();
      const request = await requestHouseWord(uids.mom, { word: "MW" });
      const { result, paths } = await captureTransactionReads(() =>
        respondCurrentHouseWord(uids.aunt, {
          requestId: request.id,
          approve: false,
        }),
      );
      expect(result).toEqual({ status: "declined" });
      expect(paths).toContain("houseWords/MW");
      // Binding, profile, pair, request, exact request-game ownership and global approval.
      expect(paths).toHaveLength(6);
      expect(paths).toContain(`games/${game.id}`);
      expect((await db.doc("houseWords/MW").get()).exists).toBe(false);
      expect(
        await respondCurrentHouseWord(uids.aunt, {
          requestId: request.id,
          approve: false,
        }),
      ).toEqual(result);
    });
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
      expect((await db.doc("houseWords/MW").get()).exists).toBe(false);
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
      const accepted = (await db.doc("houseWords/MW").get()).data();
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
      expect((await db.doc("houseWords/MW").get()).data()).toEqual(accepted);
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
        (await getFirestore().doc("houseWords/MW").get()).data(),
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
        await assertSucceeds(getDocs(collection(client, "houseWords")));
        await assertSucceeds(
          getDocs(collection(client, "pairs/family/wordRequests")),
        );
        await assertSucceeds(getDoc(doc(client, "houseWords/MW")));
        await assertFails(
          setDoc(doc(client, "houseWords/ZZ"), {
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
      await assertFails(getDocs(collection(stranger, "houseWords")));
      await assertFails(
        getDoc(doc(stranger, "pairs/family/wordRequests/mom-MW")),
      );
      await getFirestore().doc("players/mom").set({ uid: "replacement-mom" });
      await assertFails(getDocs(collection(mom, "houseWords")));
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
        board: {},
        scores: { mom: 0, aunt: 0 },
        bagCount: 86,
        rackCounts: { mom: 7, aunt: 7 },
        winner: null,
      });
      expect(["mom", "aunt"]).toContain(fresh.turn);
      const [elizabethView, ritaView] = await Promise.all(
        ["mom", "aunt"].map((slot) =>
          getDoc(
            doc(
              env.authenticatedContext(uids[slot as Slot]).firestore(),
              `games/${first.newGameId}`,
            ),
          ),
        ),
      );
      expect(elizabethView.data()?.turn).toBe(fresh.turn);
      expect(ritaView.data()?.turn).toBe(fresh.turn);
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
      expect((await db.doc("houseWords/MW").get()).exists).toBe(true);
      expect(await respondGameRestart(uids.aunt, answer)).toEqual(first);
      expect(
        (await db.doc(`games/${first.newGameId}`).get()).data()?.turn,
      ).toBe(fresh.turn);
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
    it("refills a played rack and advances the bag without rewriting the opponent's private rack", async () => {
      const db = getFirestore();
      await prepareHouseWordRack("CAT");
      const opponentRef = db.doc(`games/${game.id}/racks/aunt`);
      const opponentBefore = await opponentRef.get();
      const used = game.racks.mom.slice(0, 3);
      const play: Command = {
        ...command("play"),
        placements: used.map((tile, index) => ({
          tileId: tile.id,
          row: 7,
          col: 7 + index,
        })),
      };
      const result = await submit(uids.mom, play);
      expect(result).toMatchObject({ revision: 1, score: 10 });
      expect(
        (await db.doc(`games/${game.id}/racks/mom`).get()).data()!.tiles,
      ).toEqual([...game.racks.mom.slice(3), ...game.bag.slice(0, 3)]);
      expect(
        (await db.doc(`games/${game.id}/private/state`).get()).data()!.bag,
      ).toEqual(game.bag.slice(3));
      const opponentAfter = await opponentRef.get();
      expect(opponentAfter.data()).toEqual(opponentBefore.data());
      expect(
        opponentAfter.updateTime!.isEqual(opponentBefore.updateTime!),
      ).toBe(true);
      expect(await submit(uids.mom, play)).toEqual(result);
      expect((await db.doc(`games/${game.id}`).get()).data()).toMatchObject({
        history: [{ id: play.id, words: ["CAT"], score: 10 }],
        rackCounts: { mom: 7, aunt: 7 },
        bagCount: game.bag.length - 3,
      });
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
      const momRef = db.doc(`games/${game.id}/racks/mom`);
      const momBeforeExchange = await momRef.get();
      const exchange = { ...command("exchange", 1), tileIds: [exchangedId] };
      expect(await submit(uids.aunt, exchange)).toMatchObject({
        revision: 2,
        score: 0,
      });
      const rack = (await db.doc(`games/${game.id}/racks/aunt`).get()).data()!
        .tiles;
      const exchangedMove = (await db.doc(`games/${game.id}`).get()).data()!
        .lastMove;
      expect(exchangedMove).toMatchObject({
        exchangedCount: 1,
        placements: [],
        words: [],
      });
      expect(exchangedMove).not.toHaveProperty("tileIds");
      expect(JSON.stringify(exchangedMove)).not.toContain(exchangedId);
      expect(rack).toHaveLength(7);
      expect(rack.some((tile: { id: string }) => tile.id === exchangedId)).toBe(
        false,
      );
      const momAfterExchange = await momRef.get();
      expect(momAfterExchange.data()).toEqual(momBeforeExchange.data());
      expect(
        momAfterExchange.updateTime!.isEqual(momBeforeExchange.updateTime!),
      ).toBe(true);
      const bagAfterExchange = (
        await db.doc(`games/${game.id}/private/state`).get()
      ).data()!.bag;
      expect(bagAfterExchange).toHaveLength(game.bag.length);
      expect(
        bagAfterExchange.some(
          (tile: { id: string }) => tile.id === exchangedId,
        ),
      ).toBe(true);
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
        game.turn = (await db.doc(`games/${game.id}`).get()).data()!.turn;
        for (let revision = 0; revision < 6; revision++)
          await submit(
            uids[
              revision % 2 === 0
                ? game.turn
                : game.turn === "mom"
                  ? "aunt"
                  : "mom"
            ],
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
      game = createGame(result.newGameId!, () => 0.5);
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
    it("reads the membership pair only once in restart, timer and end-game transactions", async () => {
      const db = getFirestore();
      game = createGame(game.id, () => 0.5, "timed");
      await writeGame(game);
      const checkPairRead = async <T>(action: () => Promise<T>) => {
        const { result, paths } = await captureTransactionReads(action);
        expect(paths.filter((path) => path === "pairs/family")).toHaveLength(1);
        return result;
      };
      const proposal = await checkPairRead(() =>
        requestGameRestart(uids.mom, {
          id: randomUUID(),
          gameId: game.id,
        }),
      );
      expect(
        await checkPairRead(() =>
          respondGameRestart(uids.aunt, {
            requestId: proposal.id,
            approve: false,
          }),
        ),
      ).toEqual({ status: "declined" });
      expect(
        await checkPairRead(() =>
          finishGameTimer(uids.mom, {
            gameId: game.id,
          }),
        ),
      ).toMatchObject({ status: "active", revision: 0 });
      game.bag = [];
      await writeGame(game);
      const ending = await checkPairRead(() =>
        requestGameEnd(uids.mom, {
          id: randomUUID(),
          gameId: game.id,
          expectedRevision: 0,
        }),
      );
      expect(
        await checkPairRead(() =>
          respondGameEnd(uids.aunt, {
            requestId: ending.id,
            approve: false,
          }),
        ),
      ).toMatchObject({ status: "declined", gameId: game.id, revision: 0 });
    });
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
    it("accepts bounded online-activity heartbeats and rejects malformed extra activity fields", async () => {
      const client = env.authenticatedContext(uids.mom).firestore();
      const ref = doc(client, `pairs/family/presence/${uids.mom}`);
      await assertSucceeds(
        setDoc(ref, {
          slot: "mom",
          lastSeen: serverTimestamp(),
          onlineSince: serverTimestamp(),
          onlineTrackedFrom: serverTimestamp(),
          onlineIntervals: [],
        }),
      );
      const saved = (
        await getFirestore().doc(`pairs/family/presence/${uids.mom}`).get()
      ).data()!;
      expect(saved.onlineSince.toMillis()).toBe(saved.lastSeen.toMillis());
      // A new UID avoids conflating shape validation with the 55-second throttle.
      await getFirestore().doc("bindings/online-other").set({ slot: "mom" });
      const other = doc(
        env.authenticatedContext("online-other").firestore(),
        "pairs/family/presence/online-other",
      );
      await assertFails(
        setDoc(other, {
          slot: "mom",
          lastSeen: serverTimestamp(),
          onlineIntervals: [],
        }),
      );
      await assertFails(
        setDoc(other, {
          slot: "mom",
          lastSeen: serverTimestamp(),
          onlineSince: serverTimestamp(),
          onlineTrackedFrom: serverTimestamp(),
          onlineIntervals: new Array(257).fill({ start: 1, end: 2 }),
        }),
      );
    });
    it("saves unioned online duration at scoreless, timed and agreed endings without counting an overnight gap", async () => {
      const db = getFirestore(),
        now = Date.now(),
        start = now - 17 * 3600000;
      const setActivity = async () => {
        for (const [id, slot] of [
          ["clock-mom", "mom"],
          ["clock-aunt", "aunt"],
          ["clock-second-device", "mom"],
        ])
          await db.doc(`pairs/family/presence/${id}`).set({
            slot,
            onlineTrackedFrom: AdminTimestamp.fromMillis(start),
            onlineSince: AdminTimestamp.fromMillis(start + 16 * 3600000),
            lastSeen: AdminTimestamp.fromMillis(
              start + 16 * 3600000 + 8 * 60000,
            ),
            onlineIntervals: [{ start, end: start + 15 * 60000 }],
          });
      };
      for (const reason of ["scoreless", "timed", "agreed-end"] as const) {
        game = createGame(
          game.id,
          () => 0.5,
          reason === "timed" ? "timed" : "classic",
          1,
          start,
        );
        game.turn = "mom";
        if (reason === "agreed-end") game.bag = [];
        await writeGame(game);
        await setActivity();
        if (reason === "scoreless") {
          for (let i = 0; i < 6; i++)
            await submit(
              i % 2 === 0 ? uids.mom : uids.aunt,
              command("pass", i),
            );
        } else if (reason === "timed")
          await finishGameTimer(uids.mom, { gameId: game.id });
        else {
          const request = {
            id: randomUUID(),
            gameId: game.id,
            expectedRevision: 0,
          };
          await requestGameEnd(uids.mom, request);
          await respondGameEnd(uids.aunt, {
            requestId: request.id,
            approve: true,
          });
        }
        const ended = (await db.doc(`games/${game.id}`).get()).data()!;
        expect(ended.status).toBe("finished");
        expect(ended.onlineDurationMs).toBe(
          reason === "timed" ? 60000 : 25 * 60000,
        );
        expect(ended.onlineTimeTrackedFrom).toBe(start);
        expect(ended.endedReason).toBe(reason);
        // Use fresh receipts/request IDs for the next ending scenario.
        game.id = randomUUID();
        await db.doc("pairs/family").update({ activeGameId: game.id });
      }
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
    it("requires membership, a current revision and an actually empty bag before requesting an agreed end", async () => {
      const db = getFirestore();
      const request = {
        id: randomUUID(),
        gameId: game.id,
        expectedRevision: 0,
      };
      for (const uid of [undefined, "stranger"])
        await expect(requestGameEnd(uid, request)).rejects.toMatchObject({
          code: uid ? "permission-denied" : "unauthenticated",
        });
      for (const value of [
        { ...request, expectedRevision: -1 },
        { ...request, expectedRevision: 0.5 },
        { ...request, id: "x" },
        { ...request, approve: true },
      ])
        await expect(requestGameEnd(uids.mom, value)).rejects.toMatchObject({
          code: "invalid-argument",
        });
      await expect(requestGameEnd(uids.mom, request)).rejects.toMatchObject({
        code: "failed-precondition",
      });
      await db.doc(`games/${game.id}`).update({ bagCount: 0 });
      await expect(requestGameEnd(uids.mom, request)).rejects.toMatchObject({
        code: "failed-precondition",
      });
      game.bag = [];
      await writeGame(game);
      await expect(
        requestGameEnd(uids.mom, { ...request, expectedRevision: 1 }),
      ).rejects.toMatchObject({ code: "failed-precondition" });
      game.status = "finished";
      await writeGame(game);
      await expect(requestGameEnd(uids.mom, request)).rejects.toMatchObject({
        code: "failed-precondition",
      });
      expect(
        (await db.collection("pairs/family/endGameRequests").get()).size,
      ).toBe(0);
    }, 15000);

    it("keeps one simultaneous empty-bag proposal without changing turns, game or private tiles", async () => {
      const db = getFirestore();
      game.bag = [];
      await writeGame(game);
      const before = (await db.doc(`games/${game.id}`).get()).data();
      const rack = (await db.doc(`games/${game.id}/racks/mom`).get()).data();
      const requests = [uids.mom, uids.aunt].map((uid) =>
        requestGameEnd(uid, {
          id: randomUUID(),
          gameId: game.id,
          expectedRevision: 0,
        }),
      );
      const [one, two] = await Promise.all(requests);
      expect(one).toEqual(two);
      expect(
        (await db.collection("pairs/family/endGameRequests").get()).size,
      ).toBe(1);
      const saved = (
        await db.doc(`pairs/family/endGameRequests/${one.id}`).get()
      ).data()!;
      expect(saved).toMatchObject({
        id: one.id,
        gameId: game.id,
        expectedRevision: 0,
        status: "pending",
        requestedAt: expect.any(Number),
      });
      expect((await db.doc(`games/${game.id}`).get()).data()).toEqual(before);
      expect((await db.doc(`games/${game.id}/racks/mom`).get()).data()).toEqual(
        rack,
      );
      expect(
        (await db.doc(`games/${game.id}/private/state`).get()).data()?.bag,
      ).toEqual([]);
      for (const uid of [uids.mom, uids.aunt])
        await expect(submit(uid, command())).rejects.toMatchObject({
          code: "failed-precondition",
          details: { rule: "end-game-pending" },
        });
      expect(
        (await db.collection(`games/${game.id}/commands`).get()).size,
      ).toBe(0);
    }, 30000);

    it("persists a coalesced UUID result across lost replies and later decline without silently reopening the request", async () => {
      const db = getFirestore();
      game.bag = [];
      await writeGame(game);
      const first = { id: randomUUID(), gameId: game.id, expectedRevision: 0 };
      const simultaneous = { ...first, id: randomUUID() };
      await requestGameEnd(uids.mom, first);
      expect(await requestGameEnd(uids.aunt, simultaneous)).toEqual({
        id: first.id,
      });
      const client = env.authenticatedContext(uids.aunt).firestore();
      await assertFails(
        getDoc(doc(client, `endGameRequestReceipts/${simultaneous.id}`)),
      );
      await assertFails(
        setDoc(doc(client, `endGameRequestReceipts/${simultaneous.id}`), {
          resolvedRequestId: "forged",
        }),
      );
      await respondGameEnd(uids.aunt, { requestId: first.id, approve: false });
      expect(await requestGameEnd(uids.aunt, simultaneous)).toEqual({
        id: first.id,
      });
      expect(
        (await db.collection("pairs/family/endGameRequests").get()).size,
      ).toBe(1);
      expect(
        (await db.doc("pairs/family").get()).data()?.pendingEndGameRequestId,
      ).toBeNull();
      await expect(
        requestGameEnd(uids.aunt, { ...simultaneous, expectedRevision: 1 }),
      ).rejects.toMatchObject({ code: "already-exists" });
      await expect(
        requestGameEnd(uids.mom, simultaneous),
      ).rejects.toMatchObject({ code: "already-exists" });
      await db.doc("pairs/family").update({ activeGameId: "new-table" });
      expect(await requestGameEnd(uids.aunt, simultaneous)).toEqual({
        id: first.id,
      });
    }, 15000);

    it("only the opposing player can decline; repeated old replies never answer a renewed UUID proposal", async () => {
      const db = getFirestore();
      game.bag = [];
      await writeGame(game);
      const before = (await db.doc(`games/${game.id}`).get()).data();
      const request = {
        id: randomUUID(),
        gameId: game.id,
        expectedRevision: 0,
      };
      await requestGameEnd(uids.aunt, request);
      await db.doc("players/aunt").update({ sessionVersion: 0 });
      await db
        .doc("bindings/aunt-second")
        .set({ slot: "aunt", sessionVersion: 0 });
      await expect(
        respondGameEnd("aunt-second", {
          requestId: request.id,
          approve: false,
        }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      const answer = { requestId: request.id, approve: false };
      expect(await respondGameEnd(uids.mom, answer)).toEqual({
        status: "declined",
        gameId: game.id,
        revision: 0,
      });
      expect(await respondGameEnd(uids.mom, answer)).toEqual({
        status: "declined",
        gameId: game.id,
        revision: 0,
      });
      await expect(
        respondGameEnd(uids.mom, { ...answer, approve: true }),
      ).rejects.toMatchObject({ code: "failed-precondition" });
      expect((await db.doc(`games/${game.id}`).get()).data()).toEqual(before);
      const renewed = { ...request, id: randomUUID() };
      await requestGameEnd(uids.aunt, renewed);
      await respondGameEnd(uids.mom, answer);
      expect(
        (
          await db.doc(`pairs/family/endGameRequests/${renewed.id}`).get()
        ).data()?.status,
      ).toBe("pending");
      expect(
        (await db.doc("pairs/family").get()).data()?.pendingEndGameRequestId,
      ).toBe(renewed.id);
      await expect(
        requestGameEnd(uids.aunt, { ...request, expectedRevision: 1 }),
      ).rejects.toMatchObject({ code: "already-exists" });
      await respondGameEnd(uids.mom, { requestId: renewed.id, approve: false });
      await expect(submit(uids.mom, command())).resolves.toMatchObject({
        revision: 1,
      });
    }, 15000);

    it("agreed ending deducts actual racks once with no transfer, preserves history and receipts, and rejects further turns", async () => {
      const db = getFirestore();
      const prior = command();
      const receipt = await submit(uids.mom, prior);
      const current = (await db.doc(`games/${game.id}`).get()).data()!;
      game = {
        ...game,
        ...current,
        bag: [],
        racks: {
          mom: [
            { id: "Q-0", letter: "Q", value: 10 },
            { id: "?-0", letter: "?", value: 0 },
          ],
          aunt: [
            { id: "A-0", letter: "A", value: 1 },
            { id: "T-0", letter: "T", value: 1 },
          ],
        },
        scores: { mom: 20, aunt: 12 },
      };
      await writeGame(game);
      const original = (await db.doc(`games/${game.id}`).get()).data()!;
      const request = {
        id: randomUUID(),
        gameId: game.id,
        expectedRevision: 1,
      };
      expect(await requestGameEnd(uids.mom, request)).toEqual({
        id: request.id,
      });
      expect(await requestGameEnd(uids.mom, request)).toEqual({
        id: request.id,
      });
      expect(await submit(uids.mom, prior)).toEqual(receipt);
      const answer = { requestId: request.id, approve: true };
      const replies = await Promise.all([
        respondGameEnd(uids.aunt, answer),
        respondGameEnd(uids.aunt, answer),
      ]);
      expect(replies).toEqual([
        { status: "accepted", gameId: game.id, revision: 2 },
        { status: "accepted", gameId: game.id, revision: 2 },
      ]);
      const ended = (await db.doc(`games/${game.id}`).get()).data()!;
      expect(ended).toMatchObject({
        status: "finished",
        endedReason: "agreed-end",
        endedAt: expect.any(Number),
        revision: 2,
        winner: "tie",
        scores: { mom: 10, aunt: 10 },
        finalScoreAdjustments: {
          reason: "agreed-end",
          players: {
            mom: {
              earned: 20,
              rackValue: 10,
              deducted: 10,
              transferred: 0,
              final: 10,
            },
            aunt: {
              earned: 12,
              rackValue: 2,
              deducted: 2,
              transferred: 0,
              final: 10,
            },
          },
        },
      });
      for (const field of [
        "board",
        "lastMove",
        "history",
        "turn",
        "turnsPlayed",
        "scorelessTurns",
        "bagCount",
        "rackCounts",
      ])
        expect(ended[field]).toEqual(original[field]);
      expect(
        (await db.doc(`games/${game.id}/racks/mom`).get()).data()?.tiles,
      ).toEqual(game.racks.mom);
      expect(
        (await db.doc(`games/${game.id}/racks/aunt`).get()).data()?.tiles,
      ).toEqual(game.racks.aunt);
      expect(await respondGameEnd(uids.aunt, answer)).toEqual(replies[0]);
      expect(await submit(uids.mom, prior)).toEqual(receipt);
      await expect(submit(uids.aunt, command("pass", 2))).rejects.toMatchObject(
        { code: "failed-precondition" },
      );
      expect(
        (await db.collection(`games/${game.id}/commands`).get()).size,
      ).toBe(1);
      await db.doc("pairs/family").update({ activeGameId: "new-board" });
      expect(await respondGameEnd(uids.aunt, answer)).toEqual(replies[0]);
    }, 30000);

    it("rejects old revisions and replaced games without ending or blocking the current board", async () => {
      const db = getFirestore();
      game.bag = [];
      await writeGame(game);
      const request = {
        id: randomUUID(),
        gameId: game.id,
        expectedRevision: 0,
      };
      await requestGameEnd(uids.aunt, request);
      await db.doc(`games/${game.id}`).update({ revision: 1 });
      await expect(
        respondGameEnd(uids.mom, { requestId: request.id, approve: true }),
      ).rejects.toMatchObject({ code: "failed-precondition" });
      await expect(submit(uids.mom, command("pass", 1))).resolves.toMatchObject(
        { revision: 2 },
      );
      const fresh = { ...request, id: randomUUID(), expectedRevision: 2 };
      await requestGameEnd(uids.mom, fresh);
      await db.doc("pairs/family").update({ activeGameId: "new-board" });
      await expect(
        respondGameEnd(uids.aunt, { requestId: fresh.id, approve: true }),
      ).rejects.toMatchObject({ code: "failed-precondition" });
      expect((await db.doc(`games/${game.id}`).get()).data()).toMatchObject({
        status: "active",
        revision: 2,
      });
    }, 15000);

    it("limits end-game reads to current members and keeps requests and decisions exclusively server writable", async () => {
      const db = getFirestore();
      game.bag = [];
      await writeGame(game);
      const { id } = await requestGameEnd(uids.mom, {
        id: randomUUID(),
        gameId: game.id,
        expectedRevision: 0,
      });
      for (const uid of [uids.mom, uids.aunt]) {
        const client = env.authenticatedContext(uid).firestore();
        await assertSucceeds(
          getDoc(doc(client, `pairs/family/endGameRequests/${id}`)),
        );
        await assertSucceeds(
          getDocs(collection(client, "pairs/family/endGameRequests")),
        );
        await assertFails(
          setDoc(
            doc(client, `pairs/family/endGameRequests/${id}`),
            { status: "accepted" },
            { merge: true },
          ),
        );
        await assertFails(
          deleteDoc(doc(client, `pairs/family/endGameRequests/${id}`)),
        );
      }
      await db.doc("players/aunt").update({ uid: "replacement-aunt" });
      for (const client of [
        env.unauthenticatedContext().firestore(),
        env.authenticatedContext("stranger").firestore(),
        env.authenticatedContext(uids.aunt).firestore(),
      ]) {
        await assertFails(
          getDoc(doc(client, `pairs/family/endGameRequests/${id}`)),
        );
        await assertFails(
          getDocs(collection(client, "pairs/family/endGameRequests")),
        );
      }
      await expect(
        respondGameEnd(uids.aunt, { requestId: id, approve: true }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      await expect(
        requestGameEnd(uids.aunt, {
          id: randomUUID(),
          gameId: game.id,
          expectedRevision: 0,
        }),
      ).rejects.toMatchObject({ code: "permission-denied" });
    }, 15000);

    it("preserves server deadline results when approval arrives after timed expiry", async () => {
      const db = getFirestore();
      game = createGame(game.id, () => 0.5, "timed", 1, Date.now());
      game.bag = [];
      game.scores = { mom: 50, aunt: 30 };
      await writeGame(game);
      const request = {
        id: randomUUID(),
        gameId: game.id,
        expectedRevision: 0,
      };
      await requestGameEnd(uids.mom, request);
      await db.doc(`games/${game.id}`).update({ deadlineAt: Date.now() - 1 });
      expect(
        await respondGameEnd(uids.aunt, {
          requestId: request.id,
          approve: true,
        }),
      ).toMatchObject({ status: "accepted", revision: 1 });
      expect((await db.doc(`games/${game.id}`).get()).data()).toMatchObject({
        status: "finished",
        endedReason: "timed",
        scores: { mom: 50, aunt: 30 },
        finalScoreAdjustments: {
          players: {
            mom: { deducted: 0, transferred: 0 },
            aunt: { deducted: 0, transferred: 0 },
          },
        },
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
