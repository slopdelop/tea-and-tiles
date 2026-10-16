/** Rename accounts and their table labels atomically, without changing credentials. */
export async function renamePlayers(db, requested) {
  const updates = new Map(
    Object.entries(requested).map(([id, value]) => {
      const name = typeof value === "string" ? value.trim() : "";
      if (
        !/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
        !name ||
        name.length > 30 ||
        /[\u0000-\u001f\u007f]/.test(name)
      )
        throw new Error(
          "Provide a valid player ID and a name of 1–30 characters.",
        );
      return [id, name];
    }),
  );
  if (!updates.size) throw new Error("Provide at least one new player name.");
  await db.runTransaction(async (tx) => {
    const [players, pairs] = await Promise.all([
      tx.get(db.collection("players")),
      tx.get(db.collection("pairs")),
    ]);
    for (const id of updates.keys())
      if (!players.docs.some((player) => player.id === id))
        throw new Error(`Player ${id} does not exist.`);
    const identifiers = new Map();
    const legacyNames = pairs.docs
      .find((pair) => pair.id === "family")
      ?.data().names;
    for (const player of players.docs) {
      const renamed = updates.get(player.id);
      for (const identifier of [
        player.id,
        renamed ?? player.data().loginName ?? legacyNames?.[player.id],
        renamed ?? player.data().displayName ?? legacyNames?.[player.id],
      ]) {
        if (typeof identifier !== "string" || !identifier.trim()) continue;
        const normalized = identifier.trim().toLowerCase();
        const owner = identifiers.get(normalized);
        if (owner && owner !== player.id)
          throw new Error(
            "Player IDs and display names must be unique across both sign-in identifiers.",
          );
        identifiers.set(normalized, player.id);
      }
    }
    for (const player of players.docs) {
      const name = updates.get(player.id);
      if (name)
        tx.update(player.ref, {
          displayName: name,
          loginName: name.toLowerCase(),
        });
    }
    for (const pair of pairs.docs) {
      const seats =
        pair.data().seatPlayers ||
        (pair.id === "family" ? { mom: "mom", aunt: "aunt" } : {});
      const patch = {};
      for (const [seat, playerId] of Object.entries(seats)) {
        const name = updates.get(playerId);
        if (name) patch[`names.${seat}`] = name;
      }
      if (Object.keys(patch).length) tx.update(pair.ref, patch);
    }
  });
}
