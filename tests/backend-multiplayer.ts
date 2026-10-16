import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
  serverTimestamp,
} from "firebase/firestore";
import { getFirestore } from "firebase-admin/firestore";
import { createGame, type Game, type Slot } from "../shared/engine";
import { createCredential } from "../functions/player-login";
import { upgradeMultiplayer } from "../scripts/upgrade-multiplayer.mjs";
import { renamePlayers } from "../scripts/player-profiles.mjs";

type Backend = typeof import("../functions/index");
type Services = Pick<
  Backend,
  | "login"
  | "submit"
  | "publicGame"
  | "requestHouseWord"
  | "respondHouseWord"
  | "requestGameRestart"
  | "respondGameRestart"
  | "requestGameEnd"
  | "respondGameEnd"
  | "finishGameTimer"
  | "receiveMoveDiagnostics"
>;

/** Four independent accounts, with Alice in opposite seats across two tables. */
export function multiplayerBackendTests(
  environment: () => RulesTestEnvironment,
  services: () => Services,
) {
  describe("multiple player identities and isolated tables", () => {
    const players = ["alice", "bob", "carol", "dana"];
    const definitions = {
      "alice-bob": { mom: "alice", aunt: "bob" },
      "carol-alice": { mom: "carol", aunt: "alice" },
      "bob-dana": { mom: "bob", aunt: "dana" },
    };
    let games: Record<string, Game>;
    const uid = (player: string) => `multi-${player}`;
    const client = (player: string) =>
      environment().authenticatedContext(uid(player)).firestore();
    const move = (pairId: string, revision = 0) => ({
      pairId,
      gameId: games[pairId].id,
      id: randomUUID(),
      expectedRevision: revision,
      kind: "pass" as const,
    });
    const diagnostic = (gameId: string) => ({
      id: randomUUID(),
      reason: "delivery-delay",
      gameId,
      moveId: "test-move",
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
    });
    beforeEach(async () => {
      const db = getFirestore();
      games = {};
      const batch = db.batch();
      for (const player of players) {
        batch.set(db.doc(`players/${player}`), {
          displayName: player,
          loginName: player,
          sessionVersion: 0,
        });
        batch.set(db.doc(`bindings/${uid(player)}`), {
          playerId: player,
          sessionVersion: 0,
        });
      }
      for (const [pairId, seatPlayers] of Object.entries(definitions)) {
        const game = createGame(
          randomUUID(),
          () => 0.5,
          "timed",
          25,
          Date.now(),
        );
        games[pairId] = game;
        batch.set(db.doc(`pairs/${pairId}`), {
          schemaVersion: 2,
          memberIds: Object.values(seatPlayers),
          seatPlayers,
          names: seatPlayers,
          activeGameId: game.id,
          activeGame: {
            id: game.id,
            status: game.status,
            turn: game.turn,
            scores: game.scores,
            revision: 0,
            updatedAt: Date.now(),
          },
        });
        batch.set(db.doc(`games/${game.id}`), {
          ...services().publicGame(game),
          pairId,
        });
        for (const slot of ["mom", "aunt"] as Slot[])
          batch.set(db.doc(`games/${game.id}/racks/${slot}`), {
            tiles: game.racks[slot],
          });
        batch.set(db.doc(`games/${game.id}/private/state`), { bag: game.bag });
      }
      await batch.commit();
    });

    it("lists only a player's tables and resolves private racks from each table's seat map", async () => {
      for (const player of players) {
        const own = Object.entries(definitions)
          .filter(([, seats]) => Object.values(seats).includes(player))
          .map(([id]) => id)
          .sort();
        const found = await assertSucceeds(
          getDocs(
            query(
              collection(client(player), "pairs"),
              where("memberIds", "array-contains", player),
            ),
          ),
        );
        expect(found.docs.map((record) => record.id).sort()).toEqual(own);
        await assertFails(getDocs(collection(client(player), "pairs")));
        for (const [pairId, seats] of Object.entries(definitions)) {
          const gameId = games[pairId].id;
          const slot = Object.entries(seats).find(
            ([, id]) => id === player,
          )?.[0];
          for (const path of [`pairs/${pairId}`, `games/${gameId}`]) {
            if (slot) await assertSucceeds(getDoc(doc(client(player), path)));
            else await assertFails(getDoc(doc(client(player), path)));
          }
          for (const rack of ["mom", "aunt"]) {
            const read = getDoc(
              doc(client(player), `games/${gameId}/racks/${rack}`),
            );
            if (rack === slot) await assertSucceeds(read);
            else await assertFails(read);
          }
          await assertFails(
            getDoc(doc(client(player), `games/${gameId}/private/state`)),
          );
          await assertFails(
            setDoc(
              doc(client(player), `pairs/${pairId}`),
              { memberIds: [player] },
              { merge: true },
            ),
          );
        }
      }
    }, 30000);

    it("scopes presence and command receipts to the exact pair and current seat", async () => {
      const alice = client("alice");
      for (const [pairId, slot] of [
        ["alice-bob", "mom"],
        ["carol-alice", "aunt"],
      ]) {
        await assertSucceeds(
          setDoc(doc(alice, `pairs/${pairId}/presence/${uid("alice")}`), {
            slot,
            lastSeen: serverTimestamp(),
          }),
        );
        await assertFails(
          setDoc(doc(alice, `pairs/${pairId}/presence/another-device`), {
            slot,
            lastSeen: serverTimestamp(),
          }),
        );
        await assertFails(
          setDoc(doc(alice, `pairs/${pairId}/presence/${uid("alice")}`), {
            slot: slot === "mom" ? "aunt" : "mom",
            lastSeen: serverTimestamp(),
          }),
        );
      }
      await assertFails(
        setDoc(doc(alice, `pairs/bob-dana/presence/${uid("alice")}`), {
          slot: "mom",
          lastSeen: serverTimestamp(),
        }),
      );
      await assertFails(getDocs(collection(alice, "pairs/bob-dana/presence")));
      const ownMove = move("alice-bob");
      await services().submit(uid("alice"), ownMove);
      await assertSucceeds(
        getDoc(doc(alice, `games/${ownMove.gameId}/commands/${ownMove.id}`)),
      );
      await assertFails(
        getDoc(
          doc(client("bob"), `games/${ownMove.gameId}/commands/${ownMove.id}`),
        ),
      );
      await assertFails(
        getDoc(
          doc(client("dana"), `games/${ownMove.gameId}/commands/${ownMove.id}`),
        ),
      );
      await assertFails(
        getDoc(
          doc(alice, `games/${games["bob-dana"].id}/commands/not-written-yet`),
        ),
      );
    });

    it("projects bounded move metadata and versions word re-requests without extra activity documents", async () => {
      const db = getFirestore(),
        api = services(),
        pairId = "alice-bob";
      const command = move(pairId);
      await api.submit(uid("alice"), command);
      const summary = (await db.doc(`pairs/${pairId}`).get()).data()!;
      expect(summary.activeGame.lastMove).toMatchObject({
        id: command.id,
        player: "mom",
        kind: "pass",
      });
      expect(Object.keys(summary.activeGame.lastMove).sort()).toEqual([
        "at",
        "id",
        "kind",
        "player",
      ]);
      await api.submit(uid("alice"), command);
      expect((await db.doc(`pairs/${pairId}`).get()).data()).toEqual(summary);
      const request = await api.requestHouseWord(uid("alice"), {
        pairId,
        gameId: games[pairId].id,
        word: "QZX",
      });
      const record = (
        await db.doc(`pairs/${pairId}/wordRequests/${request.id}`).get()
      ).data()!;
      const key = `word-${request.id}`;
      expect(
        (await db.doc(`pairs/${pairId}`).get()).data()?.actionVersions[key],
      ).toBe(`${games[pairId].id}:${record.requestedAt}`);
      await api.respondHouseWord(uid("bob"), {
        pairId,
        gameId: games[pairId].id,
        requestId: request.id,
        approve: false,
        expectedRequestedAt: record.requestedAt,
      });
      expect(
        (await db.doc(`pairs/${pairId}`).get()).data()?.actionVersions?.[key],
      ).toBeUndefined();
      await api.requestHouseWord(uid("alice"), {
        pairId,
        gameId: games[pairId].id,
        word: "QZX",
      });
      expect(
        (await db.doc(`pairs/${pairId}`).get()).data()?.actionVersions[key],
      ).not.toBe(`${games[pairId].id}:${record.requestedAt}`);
    });

    it("uses the same account in opposite seats and retries each command only in its original table", async () => {
      const api = services(),
        db = getFirestore();
      const ab = move("alice-bob"),
        ca = move("carol-alice");
      const first = await api.submit(uid("alice"), ab);
      await api.submit(uid("carol"), ca);
      const second = move("carol-alice", 1);
      expect(await api.submit(uid("alice"), second)).toMatchObject({
        revision: 2,
      });
      expect(await api.submit(uid("alice"), ab)).toEqual(first);
      await expect(
        api.submit(uid("alice"), { ...ab, pairId: "carol-alice" }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      await expect(api.submit(uid("bob"), ab)).rejects.toMatchObject({
        code: "already-exists",
      });
      expect(
        (await db.doc(`games/${games["alice-bob"].id}`).get()).data()?.revision,
      ).toBe(1);
      expect(
        (await db.doc(`games/${games["carol-alice"].id}`).get()).data()
          ?.revision,
      ).toBe(2);
      expect(
        (await db.doc(`games/${games["bob-dana"].id}`).get()).data()?.revision,
      ).toBe(0);
      for (const pairId of ["alice-bob", "carol-alice"]) {
        const saved = (await db.doc(`pairs/${pairId}`).get()).data()!;
        expect(saved.activeGame).toMatchObject({
          id: games[pairId].id,
          revision: pairId === "alice-bob" ? 1 : 2,
        });
      }
    });

    it("rejects foreign games before receipt, finished-timer or diagnostic shortcuts can reveal them", async () => {
      const api = services(),
        db = getFirestore();
      const foreignId = games["bob-dana"].id;
      await db
        .doc(`games/${foreignId}`)
        .update({ status: "finished", revision: 42 });
      const before = (await db.doc(`games/${foreignId}`).get()).data();
      for (const pairId of ["alice-bob", "bob-dana"]) {
        const payload = { pairId, gameId: foreignId };
        const attempts = [
          () => api.submit(uid("alice"), { ...move("bob-dana"), pairId }),
          () => api.finishGameTimer(uid("alice"), payload),
          () =>
            api.requestGameRestart(uid("alice"), {
              ...payload,
              id: randomUUID(),
            }),
          () =>
            api.requestGameEnd(uid("alice"), {
              ...payload,
              id: randomUUID(),
              expectedRevision: 42,
            }),
          () =>
            api.receiveMoveDiagnostics(uid("alice"), {
              pairId,
              action: "report",
              report: diagnostic(foreignId),
            }),
        ];
        for (const attempt of attempts)
          await expect(attempt()).rejects.toMatchObject({
            code: "permission-denied",
          });
      }
      await expect(
        api.receiveMoveDiagnostics(uid("alice"), {
          pairId: "bob-dana",
          action: "clock",
        }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      expect((await db.collection("diagnosticLimits").get()).size).toBe(0);
      expect((await db.doc(`games/${foreignId}`).get()).data()).toEqual(before);
    });

    it("keeps proposals, responses and shared words behind the selected table membership", async () => {
      const api = services(),
        db = getFirestore();
      const pairId = "bob-dana",
        gameId = games[pairId].id;
      const word = await api.requestHouseWord(uid("bob"), {
        pairId,
        word: "ZZ",
      });
      const wordPath = `pairs/${pairId}/wordRequests/${word.id}`;
      const requestedAt = (await db.doc(wordPath).get()).data()!.requestedAt;
      const restart = await api.requestGameRestart(uid("bob"), {
        pairId,
        gameId,
        id: randomUUID(),
      });
      await db.doc(`games/${gameId}/private/state`).update({ bag: [] });
      await db.doc(`games/${gameId}`).update({ bagCount: 0 });
      const ending = await api.requestGameEnd(uid("bob"), {
        pairId,
        gameId,
        id: randomUUID(),
        expectedRevision: 0,
      });
      for (const [path, response] of [
        [
          wordPath,
          () =>
            api.respondHouseWord(uid("alice"), {
              pairId,
              requestId: word.id,
              approve: true,
              expectedRequestedAt: requestedAt,
            }),
        ],
        [
          `pairs/${pairId}/gameRequests/${restart.id}`,
          () =>
            api.respondGameRestart(uid("alice"), {
              pairId,
              requestId: restart.id,
              approve: true,
            }),
        ],
        [
          `pairs/${pairId}/endGameRequests/${ending.id}`,
          () =>
            api.respondGameEnd(uid("alice"), {
              pairId,
              requestId: ending.id,
              approve: true,
            }),
        ],
      ] as const) {
        await assertFails(getDoc(doc(client("alice"), path)));
        await assertSucceeds(getDoc(doc(client("dana"), path)));
        await expect(response()).rejects.toMatchObject({
          code: "permission-denied",
        });
        expect((await db.doc(path).get()).data()?.status).toBe("pending");
      }
      await expect(
        api.requestHouseWord(uid("alice"), { pairId, word: "XY" }),
      ).rejects.toMatchObject({ code: "permission-denied" });
      await api.respondHouseWord(uid("dana"), {
        pairId,
        requestId: word.id,
        approve: true,
        expectedRequestedAt: requestedAt,
      });
      await assertSucceeds(getDoc(doc(client("alice"), "houseWords/ZZ")));
    });

    it("shares approval across tables while preserving first consent and idempotent replies to stale proposals", async () => {
      const api = services(),
        db = getFirestore();
      const proposals = await Promise.all([
        api.requestHouseWord(uid("alice"), {
          pairId: "alice-bob",
          word: "QZX",
        }),
        api.requestHouseWord(uid("carol"), {
          pairId: "carol-alice",
          word: "QZX",
        }),
      ]);
      const answer = async (
        pairId: string,
        requestId: string,
        approve: boolean,
      ) => ({
        pairId,
        requestId,
        approve,
        expectedRequestedAt: (
          await db.doc(`pairs/${pairId}/wordRequests/${requestId}`).get()
        ).data()!.requestedAt,
      });
      await api.respondHouseWord(
        uid("bob"),
        await answer("alice-bob", proposals[0].id, true),
      );
      const approved = (await db.doc("houseWords/QZX").get()).data();
      expect(approved).toMatchObject({
        pairId: "alice-bob",
        requestedByPlayerId: "alice",
        approvedByPlayerId: "bob",
      });
      const decline = await answer("carol-alice", proposals[1].id, false);
      expect(await api.respondHouseWord(uid("alice"), decline)).toEqual({
        status: "accepted",
      });
      expect(await api.respondHouseWord(uid("alice"), decline)).toEqual({
        status: "accepted",
      });
      expect((await db.doc("houseWords/QZX").get()).data()).toEqual(approved);
      expect(
        (await db.doc("pairs/carol-alice").get()).data()?.actionNeededBy?.[
          `word-${proposals[1].id}`
        ],
      ).toBeUndefined();
      await assertSucceeds(getDoc(doc(client("dana"), "houseWords/QZX")));
      await expect(
        api.requestHouseWord(uid("dana"), { pairId: "bob-dana", word: "QZX" }),
      ).rejects.toMatchObject({ code: "failed-precondition" });
    });

    it("preserves account credentials and all table seats when signing in on another device", async () => {
      const api = services(),
        db = getFirestore();
      const credential = {
        ...(await createCredential("123456")),
        enabled: true,
      };
      await db.doc("playerCredentials/alice").set(credential);
      const before = await Promise.all(
        Object.keys(definitions).map(async (id) =>
          (await db.doc(`pairs/${id}`).get()).data(),
        ),
      );
      await expect(
        api.login("multi-alice-new-device", {
          playerId: "alice",
          passphrase: "123456",
        }),
      ).resolves.toMatchObject({ playerId: "alice" });
      expect((await db.doc("playerCredentials/alice").get()).data()).toEqual(
        credential,
      );
      expect(
        await Promise.all(
          Object.keys(definitions).map(async (id) =>
            (await db.doc(`pairs/${id}`).get()).data(),
          ),
        ),
      ).toEqual(before);
      const newClient = environment()
        .authenticatedContext("multi-alice-new-device")
        .firestore();
      await assertSucceeds(
        getDoc(doc(newClient, `games/${games["alice-bob"].id}/racks/mom`)),
      );
      await assertSucceeds(
        getDoc(doc(newClient, `games/${games["carol-alice"].id}/racks/aunt`)),
      );
      await assertFails(
        getDoc(doc(newClient, `games/${games["bob-dana"].id}`)),
      );
    });

    it("renames profiles and every table atomically without changing sessions or credentials", async () => {
      const db = getFirestore();
      const credential = {
        ...(await createCredential("123456")),
        enabled: true,
      };
      await db.doc("playerCredentials/alice").set(credential);
      const binding = (await db.doc(`bindings/${uid("alice")}`).get()).data();
      await renamePlayers(db, { alice: "Alicia" });
      expect((await db.doc("players/alice").get()).data()).toMatchObject({
        displayName: "Alicia",
        loginName: "alicia",
        sessionVersion: 0,
      });
      expect((await db.doc("pairs/alice-bob").get()).data()?.names.mom).toBe(
        "Alicia",
      );
      expect((await db.doc("pairs/carol-alice").get()).data()?.names.aunt).toBe(
        "Alicia",
      );
      expect((await db.doc("pairs/bob-dana").get()).data()?.names).toEqual(
        definitions["bob-dana"],
      );
      expect((await db.doc("playerCredentials/alice").get()).data()).toEqual(
        credential,
      );
      expect((await db.doc(`bindings/${uid("alice")}`).get()).data()).toEqual(
        binding,
      );
      await assertSucceeds(
        getDoc(
          doc(client("alice"), `games/${games["carol-alice"].id}/racks/aunt`),
        ),
      );
      await expect(
        services().login("renamed-device", {
          playerId: "Alicia",
          passphrase: "123456",
        }),
      ).resolves.toMatchObject({ playerId: "alice" });
      for (const name of ["Bob", "CAROL", " ", "x".repeat(31)])
        await expect(renamePlayers(db, { alice: name })).rejects.toThrow();
      expect((await db.doc("players/alice").get()).data()?.displayName).toBe(
        "Alicia",
      );
      await expect(
        renamePlayers(db, { alice: "Annie", bob: "Annie" }),
      ).rejects.toThrow();
      expect((await db.doc("players/alice").get()).data()?.displayName).toBe(
        "Alicia",
      );
    });

    it("upgrades legacy identities additively and is idempotent without rotating credentials or changing gameplay", async () => {
      const db = getFirestore();
      const family = (await db.doc("pairs/family").get()).data()!;
      const gameId = family.activeGameId;
      await db
        .doc("playerCredentials/mom")
        .set({ ...(await createCredential("123456")), enabled: true });
      await db
        .doc("pairs/family/houseWords/ZZ")
        .set({ word: "ZZ", approvedAt: 123, approvedBy: "aunt" });
      const preserved = [
        "playerCredentials/mom",
        `games/${gameId}/racks/mom`,
        `games/${gameId}/racks/aunt`,
        `games/${gameId}/private/state`,
        "pairs/family/houseWords/ZZ",
      ];
      const before = await Promise.all(
        preserved.map(async (path) => (await db.doc(path).get()).data()),
      );
      const originalGame = (await db.doc(`games/${gameId}`).get()).data();
      const dry = await upgradeMultiplayer(db);
      expect(dry.changes).toBeGreaterThan(0);
      expect((await db.doc("pairs/family").get()).data()).toEqual(family);
      expect((await db.doc("players/mom").get()).data()).toEqual({
        uid: "test-mom",
      });
      await upgradeMultiplayer(db, { apply: true });
      expect((await db.doc(`games/${gameId}`).get()).data()).toEqual({
        ...originalGame,
        pairId: "family",
      });
      expect((await db.doc("pairs/family").get()).data()).toMatchObject({
        memberIds: ["mom", "aunt"],
        seatPlayers: { mom: "mom", aunt: "aunt" },
        activeGameId: gameId,
      });
      expect((await db.doc("bindings/test-mom").get()).data()).toEqual({
        slot: "mom",
        playerId: "mom",
      });
      expect((await db.doc("houseWords/ZZ").get()).data()?.word).toBe("ZZ");
      expect(
        await Promise.all(
          preserved.map(async (path) => (await db.doc(path).get()).data()),
        ),
      ).toEqual(before);
      expect(await upgradeMultiplayer(db, { apply: true })).toEqual({
        changes: 0,
        applied: true,
      });
      await expect(
        services().login("legacy-after-upgrade", {
          playerId: "Elizabeth",
          passphrase: "123456",
        }),
      ).resolves.toMatchObject({ playerId: "mom" });
      // A remembered device must also work without signing in again.
      const legacyClient = environment()
        .authenticatedContext("test-mom")
        .firestore();
      await assertSucceeds(getDoc(doc(legacyClient, "pairs/family")));
      await assertSucceeds(
        getDocs(
          query(
            collection(legacyClient, "pairs"),
            where("memberIds", "array-contains", "mom"),
          ),
        ),
      );
      await assertSucceeds(
        getDoc(doc(legacyClient, `games/${gameId}/racks/mom`)),
      );
      await assertFails(
        getDoc(doc(legacyClient, `games/${gameId}/racks/aunt`)),
      );
      const starter = originalGame!.turn;
      await expect(
        services().submit(`test-${starter}`, {
          pairId: "family",
          gameId,
          id: randomUUID(),
          kind: "pass",
          expectedRevision: originalGame!.revision,
        }),
      ).resolves.toMatchObject({ revision: originalGame!.revision + 1 });
    });
  });
}
