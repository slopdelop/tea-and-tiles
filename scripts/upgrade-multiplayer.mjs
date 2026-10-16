import { pathToFileURL } from "node:url";

/** Add identity metadata without rotating credentials, deleting bindings, or touching Auth. */
export async function upgradeMultiplayer(db, { apply = false } = {}) {
  const family = await db.doc("pairs/family").get();
  if (!family.exists)
    throw new Error("Prepare the existing family table before upgrading.");
  const data = family.data();
  if (
    data.seatPlayers &&
    (data.seatPlayers.mom !== "mom" || data.seatPlayers.aunt !== "aunt")
  )
    throw new Error(
      "The family alias has unexpected members; refusing to change it.",
    );
  const changes = [];
  const add = (ref, patch) => {
    if (Object.keys(patch).length) changes.push({ ref, patch });
  };
  for (const id of ["mom", "aunt"]) {
    const ref = db.doc(`players/${id}`);
    const profile = (await ref.get()).data();
    if (!profile)
      throw new Error(
        `Missing existing player ${id}; upgrade must not recreate accounts.`,
      );
    const name =
      profile.displayName ||
      data.names?.[id] ||
      (id === "mom" ? "Elizabeth" : "Rita");
    add(ref, {
      ...(!profile.displayName ? { displayName: name } : {}),
      ...(!profile.loginName ? { loginName: name.trim().toLowerCase() } : {}),
    });
  }
  const [games, bindings, tickets, words, receipts, wordRequests] =
    await Promise.all([
      db.collection("games").get(),
      db.collection("bindings").get(),
      db.collection("setupCodes").get(),
      db.collection("pairs/family/houseWords").get(),
      db.collection("endGameRequestReceipts").get(),
      db.collection("pairs/family/wordRequests").get(),
    ]);
  for (const game of games.docs)
    if (!game.data().pairId) add(game.ref, { pairId: "family" });
  for (const record of [...bindings.docs, ...tickets.docs]) {
    const value = record.data();
    if (!value.playerId && ["mom", "aunt"].includes(value.slot))
      add(record.ref, { playerId: value.slot });
  }
  for (const word of words.docs) {
    const ref = db.doc(`houseWords/${word.id}`);
    if (!(await ref.get()).exists)
      add(ref, { ...word.data(), pairId: "family" });
  }
  for (const receipt of receipts.docs) {
    const ref = db.doc(`pairs/family/endGameRequestReceipts/${receipt.id}`);
    if (!(await ref.get()).exists) add(ref, receipt.data());
  }
  for (const request of wordRequests.docs) {
    if (!request.data().gameId) add(request.ref, { gameId: data.activeGameId });
  }
  const active = games.docs
    .find((game) => game.id === data.activeGameId)
    ?.data();
  if (!active)
    throw new Error(
      "The existing active game is missing; refusing an incomplete upgrade.",
    );
  const pairPatch = {};
  if (data.schemaVersion !== 2) pairPatch.schemaVersion = 2;
  if (!data.memberIds) pairPatch.memberIds = ["mom", "aunt"];
  if (!data.seatPlayers) pairPatch.seatPlayers = { mom: "mom", aunt: "aunt" };
  if (!data.activeGame)
    pairPatch.activeGame = {
      id: active.id,
      status: active.status,
      turn: active.turn,
      scores: active.scores,
      revision: active.revision,
      updatedAt: Date.now(),
    };
  if (!data.actionNeededBy) {
    const actions = {};
    const other = (seat) => (seat === "mom" ? "aunt" : "mom");
    for (const request of wordRequests.docs)
      if (request.data().status === "pending")
        actions[`word-${request.id}`] = other(request.data().requestedBy);
    for (const [field, collection, action] of [
      ["pendingNewGameRequestId", "gameRequests", "newGame"],
      ["pendingEndGameRequestId", "endGameRequests", "endGame"],
    ]) {
      if (!data[field]) continue;
      const request = (
        await family.ref.collection(collection).doc(data[field]).get()
      ).data();
      if (request?.status === "pending")
        actions[action] = other(request.requestedBy);
    }
    pairPatch.actionNeededBy = actions;
  }
  add(family.ref, pairPatch);
  console.log(
    `${apply ? "Apply" : "Dry run"}: ${changes.length} additive document updates. Credentials, Auth users, boards, racks, scores, and receipts are preserved.`,
  );
  for (const { ref, patch } of changes)
    console.log(`${ref.path}: ${Object.keys(patch).join(", ")}`);
  if (apply) {
    // Re-read before each merge so reruns and concurrent migrations cannot replace
    // already-added identity metadata or an active summary maintained by gameplay.
    for (const { ref, patch } of changes)
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(ref);
        const missing = Object.fromEntries(
          Object.entries(patch).filter(
            ([key]) =>
              fresh.data()?.[key] === undefined ||
              (key === "schemaVersion" && fresh.data()?.[key] !== 2),
          ),
        );
        if (Object.keys(missing).length) tx.set(ref, missing, { merge: true });
      });
  }
  return { changes: changes.length, applied: apply };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.argv.splice(2, 0, "upgrade-multiplayer");
  import("./admin.mjs")
    .then(({ run }) => run())
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
