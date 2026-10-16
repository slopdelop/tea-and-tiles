import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { randomUUID, createHash, randomInt } from "node:crypto";
import { pathToFileURL } from "node:url";
import { upgradeMultiplayer } from "./upgrade-multiplayer.mjs";

const args = process.argv.slice(2);
const command = args[0];
const option = (key) => {
  const i = args.indexOf(`--${key}`);
  return i < 0 ? undefined : args[i + 1];
};
const projectId = option("project");
if (!projectId || !/^[a-z][a-z0-9-]+$/.test(projectId))
  throw new Error(
    "An explicit --project PROJECT_ID is required. Never rely on a Firebase CLI project selection.",
  );
const cloud = args.includes("--cloud");
const demo = projectId.startsWith("demo-");
if (!demo && !cloud)
  throw new Error(
    "Non-demo projects require --cloud. Review the exact target and billing before running cloud commands.",
  );
if (demo && cloud) throw new Error("Demo projects run only in emulators.");
if (!cloud) {
  process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
} else if (
  process.env.FIRESTORE_EMULATOR_HOST ||
  process.env.FIREBASE_AUTH_EMULATOR_HOST
) {
  throw new Error("Clear emulator environment variables before using --cloud.");
}
initializeApp({
  projectId,
  ...(cloud ? { credential: applicationDefault() } : {}),
});
const db = getFirestore();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const cryptoRandom = () => randomInt(0, 0x100000000) / 0x100000000;
const slots = ["mom", "aunt"];
const defaultNames = { mom: "Elizabeth", aunt: "Rita" };
const appUrl = option("app-url");
if (
  cloud &&
  ["prepare", "issue-code", "issue-pin", "reset"].includes(command) &&
  !appUrl
)
  throw new Error(
    "Cloud setup requires --app-url with this game's actual frontend URL.",
  );
if (appUrl) {
  const parsed = new URL(appUrl);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new Error(
      "--app-url must be an HTTP or HTTPS frontend URL without embedded credentials.",
    );
}
const lifetime = Number(option("hours") || 24);
if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 168)
  throw new Error("--hours must be between 0 and 168.");

async function engine() {
  try {
    return await import("../functions/lib/shared/engine.js");
  } catch {
    throw new Error("Run npm run build:functions before preparing data.");
  }
}
function gameSummary(game) {
  return {
    id: game.id,
    status: game.status,
    turn: game.turn,
    scores: game.scores,
    revision: game.revision,
    updatedAt: Date.now(),
  };
}
function addGame(batch, game, pairId = "family") {
  const { racks, bag, ...shared } = game;
  const ref = db.doc(`games/${game.id}`);
  batch.set(ref, {
    ...shared,
    pairId,
    rackCounts: { mom: racks.mom.length, aunt: racks.aunt.length },
    bagCount: bag.length,
  });
  for (const slot of slots)
    batch.set(ref.collection("racks").doc(slot), { tiles: racks[slot] });
  batch.set(ref.collection("private").doc("state"), { bag });
}
async function issueCode(slot) {
  if (!slot || !/^[A-Za-z0-9_-]{1,100}$/.test(slot))
    throw new Error("Provide --player with a valid player ID.");
  if (!(await db.doc(`players/${slot}`).get()).exists)
    throw new Error("Run prepare first.");
  const pair = (await db.doc("pairs/family").get()).data();
  const playerName =
    (await db.doc(`players/${slot}`).get()).data()?.displayName ||
    pair?.names?.[slot] ||
    defaultNames[slot] ||
    slot;
  let vocabulary;
  try {
    vocabulary = await import("../functions/lib/functions/setup-words.js");
  } catch {
    throw new Error(
      "Run npm run build:functions before issuing invitation words.",
    );
  }
  const candidates = [...vocabulary.SETUP_WORDS];
  for (let index = candidates.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [candidates[index], candidates[other]] = [
      candidates[other],
      candidates[index],
    ];
  }
  const expiresAt = Date.now() + lifetime * 60 * 60 * 1000;
  let code;
  for (const candidate of candidates) {
    const issued = await db.runTransaction(async (tx) => {
      const candidateRef = db.doc(`setupCodes/${hash(candidate)}`);
      const [existing, player] = await tx.getAll(
        candidateRef,
        db.doc(`players/${slot}`),
      );
      if (existing.exists) return false;
      if (!player.exists) throw new Error("Run prepare first.");
      const previous = await tx.get(
        db.collection("setupCodes").where("slot", "==", slot),
      );
      for (const record of previous.docs) {
        // Retain the hash forever so neither an expired nor a used invitation
        // word can be issued again and revive an old link.
        if (!record.data().consumedUid && record.data().expiresAt > 0)
          tx.update(record.ref, { expiresAt: 0, revokedAt: Date.now() });
      }
      tx.create(candidateRef, {
        playerId: slot,
        slot,
        expiresAt,
        consumedUid: null,
      });
      tx.delete(db.doc(vocabulary.WORD_FAILURE_BUCKET));
      if (player.data()?.uid)
        tx.delete(db.doc(`enrollmentAttempts/${hash(player.data().uid)}`));
      return true;
    });
    if (issued) {
      code = candidate;
      break;
    }
  }
  if (!code)
    throw new Error(
      "All 256 invitation words have been issued. Existing invitations and player devices are unchanged; extend the curated vocabulary before issuing more.",
    );
  const readable = code.toLowerCase();
  console.log(
    `${playerName}: ${readable} (expires ${new Date(expiresAt).toISOString()})`,
  );
  const joinUrl = new URL(
    appUrl || `http://127.0.0.1:${slot === "mom" ? "5173" : "5174"}/`,
  );
  joinUrl.hash = `setup=${readable}`;
  console.log(`Join link: ${joinUrl.href}`);
  console.log(
    `Send ${playerName} the private join link, or enter this invitation word inside the installed Home Screen app. It is a one-time setup ticket, not a password. Tapping Join connects this player and replaces her previous invitation-linked device; reusable sign-in sessions stay connected. Issuing the word leaves all current devices connected.`,
  );
}
async function resolvePlayer() {
  const requested = option("player");
  if (!requested)
    throw new Error("Provide --player with a player ID or display name.");
  const players = await db.collection("players").get();
  const pair = (await db.doc("pairs/family").get()).data();
  const matches = players.docs.filter(
    (player) =>
      player.id === requested ||
      (
        player.data().loginName ||
        player.data().displayName ||
        pair?.names?.[player.id] ||
        ""
      ).toLowerCase() === requested.trim().toLowerCase(),
  );
  if (matches.length !== 1)
    throw new Error(
      "Choose one configured player by ID or unique display name.",
    );
  const player = matches[0];
  return {
    slot: player.id,
    name: player.data().displayName || pair?.names?.[player.id] || player.id,
  };
}
async function issueLogin(numericCode = false) {
  const { slot, name } = await resolvePlayer();
  const player = await db.doc(`players/${slot}`).get();
  if (!player.exists) throw new Error("Run prepare first.");
  const [{ SETUP_WORDS }, { createCredential }] = await Promise.all([
    import("../functions/lib/functions/setup-words.js"),
    import("../functions/lib/functions/player-login.js"),
  ]);
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const passphrase = numericCode
    ? randomInt(1000000).toString().padStart(6, "0")
    : [
        ...Array.from({ length: 3 }, () =>
          SETUP_WORDS[randomInt(SETUP_WORDS.length)].toLowerCase(),
        ),
        Array.from(
          { length: 4 },
          () => alphabet[randomInt(alphabet.length)],
        ).join(""),
      ].join(" ");
  const signInUrl = numericCode
    ? new URL(appUrl || `http://127.0.0.1:${slot === "mom" ? "5173" : "5174"}/`)
    : null;
  if (signInUrl)
    signInUrl.hash = new URLSearchParams({
      player: slot,
      name,
      code: passphrase,
    }).toString();
  const credential = await createCredential(passphrase);
  const batch = db.batch();
  batch.set(db.doc(`playerCredentials/${slot}`), {
    ...credential,
    enabled: true,
    updatedAt: Date.now(),
  });
  batch.delete(db.doc(`loginAttempts/${slot}`));
  if (player.data()?.uid)
    batch.delete(db.doc(`enrollmentAttempts/${hash(player.data().uid)}`));
  await batch.commit();
  console.log(
    `${name} (${slot}) private ${numericCode ? "six-digit code" : "passphrase"}: ${passphrase}`,
  );
  if (signInUrl) console.log(`Sign-in link: ${signInUrl.href}`);
  console.log(
    "Keep this code or passphrase and its link private. It signs in the same player on additional devices and does not expire. Existing signed-in devices stay connected; issuing it again replaces only future sign-in credentials. Use revoke-login to revoke every session for this player.",
  );
}
async function revokeLogin() {
  const { slot, name } = await resolvePlayer();
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`players/${slot}`);
    const player = await tx.get(ref);
    const [bindings, modernBindings] = await Promise.all([
      tx.get(db.collection("bindings").where("slot", "==", slot)),
      tx.get(db.collection("bindings").where("playerId", "==", slot)),
    ]);
    if (!player.exists) throw new Error("Run prepare first.");
    tx.update(ref, { sessionVersion: (player.data().sessionVersion ?? 0) + 1 });
    tx.set(
      db.doc(`playerCredentials/${slot}`),
      { enabled: false, revokedAt: Date.now() },
      { merge: true },
    );
    for (const binding of [...bindings.docs, ...modernBindings.docs])
      tx.delete(binding.ref);
  });
  console.log(
    `${name}'s reusable sign-in is revoked and all her sessions are disconnected. Issue a new login or invitation to reconnect her.`,
  );
}
async function prepare() {
  const pairRef = db.doc("pairs/family");
  if (!(await pairRef.get()).exists) {
    const { createGame } = await engine();
    const game = createGame(randomUUID(), cryptoRandom);
    const batch = db.batch();
    addGame(batch, game);
    batch.create(pairRef, {
      schemaVersion: 2,
      memberIds: ["mom", "aunt"],
      seatPlayers: { mom: "mom", aunt: "aunt" },
      activeGameId: game.id,
      activeGame: gameSummary(game),
      names: {
        mom: option("mom-name") || defaultNames.mom,
        aunt: option("aunt-name") || defaultNames.aunt,
      },
    });
    for (const slot of slots)
      batch.create(db.doc(`players/${slot}`), {
        uid: null,
        displayName: option(`${slot}-name`) || defaultNames[slot],
        loginName: (option(`${slot}-name`) || defaultNames[slot])
          .trim()
          .toLowerCase(),
        sessionVersion: 0,
      });
    await batch.commit();
  }
  for (const slot of slots) await issueCode(slot);
}
async function reset() {
  if (cloud)
    throw new Error(
      "Reset is restricted to emulators. Cloud games must not be deleted with this script.",
    );
  const collections = await db.listCollections();
  for (const collection of collections) await db.recursiveDelete(collection);
  let pageToken;
  do {
    const users = await getAuth().listUsers(1000, pageToken);
    if (users.users.length)
      await getAuth().deleteUsers(users.users.map((user) => user.uid));
    pageToken = users.pageToken;
  } while (pageToken);
  console.log(`Cleared local emulator data for ${projectId}.`);
  await prepare();
}
async function fixture() {
  if (cloud)
    throw new Error("Deterministic fixtures are restricted to emulators.");
  const { createGame } = await engine();
  const pair = await db.doc("pairs/family").get();
  if (!pair.exists) throw new Error("Run prepare first.");
  const game = createGame(randomUUID(), () => 0.5);
  // Select actual tiles from the full inventory, preserving all 100 tile IDs.
  const inventory = [...game.racks.mom, ...game.racks.aunt, ...game.bag];
  const take = (letters) =>
    letters.split("").map((letter) => {
      const index = inventory.findIndex((tile) => tile.letter === letter);
      if (index < 0) throw new Error(`Missing fixture tile ${letter}`);
      return inventory.splice(index, 1)[0];
    });
  game.racks = { mom: take("CATEIOR"), aunt: take("SENLADU") };
  game.bag = inventory;
  if (args.includes("--finish")) {
    game.status = "finished";
    game.scorelessTurns = 6;
    game.scores = { mom: 10, aunt: 8 };
    game.winner = "mom";
  }
  const batch = db.batch();
  addGame(batch, game);
  batch.update(pair.ref, {
    activeGameId: game.id,
    activeGame: gameSummary(game),
  });
  await batch.commit();
  console.log(
    `Fixture ${game.id}: ${pair.data().names?.mom || defaultNames.mom} has CATEIOR; ${pair.data().names?.aunt || defaultNames.aunt} has SENLADU.${args.includes("--finish") ? " Game finished for rematch testing." : ""}`,
  );
}

async function addPlayer(id = option("id"), name = option("name")) {
  if (
    !id ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
    !name?.trim() ||
    name.trim().length > 30
  )
    throw new Error(
      "Provide --id PLAYER_ID and --name DISPLAY_NAME (1-30 characters).",
    );
  name = name.trim();
  const loginName = name.toLowerCase();
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`players/${id}`);
    const [existing, names] = await Promise.all([
      tx.get(ref),
      tx.get(db.collection("players")),
    ]);
    if (existing.exists) {
      if (existing.data().displayName !== name)
        throw new Error(`Player ${id} already exists with a different name.`);
      return;
    }
    const identifiers = [id.toLowerCase(), loginName];
    if (
      names.docs.some(
        (player) =>
          player.id !== id &&
          [
            player.id.toLowerCase(),
            String(player.data().loginName || player.data().displayName || "")
              .trim()
              .toLowerCase(),
          ].some((value) => identifiers.includes(value)),
      )
    )
      throw new Error(
        "Player IDs and display names must be unique across both sign-in identifiers.",
      );
    tx.create(ref, {
      displayName: name,
      loginName,
      sessionVersion: 0,
      uid: null,
      createdAt: Date.now(),
    });
  });
  console.log(`Player ready: ${name} (${id}).`);
}
async function createPair(
  first = option("player-a"),
  second = option("player-b"),
) {
  if (
    !first ||
    !second ||
    first === second ||
    ![first, second].every((id) => /^[A-Za-z0-9_-]{1,100}$/.test(id))
  )
    throw new Error("Provide two distinct IDs with --player-a and --player-b.");
  const memberIds = [first, second].sort();
  const pairId =
    memberIds.join(",") === "aunt,mom"
      ? "family"
      : `pair-${hash(JSON.stringify(memberIds)).slice(0, 40)}`;
  const seats =
    pairId === "family"
      ? { mom: "mom", aunt: "aunt" }
      : { mom: memberIds[0], aunt: memberIds[1] };
  const { createGame } = await engine();
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`pairs/${pairId}`);
    const [existing, mom, aunt] = await tx.getAll(
      ref,
      db.doc(`players/${seats.mom}`),
      db.doc(`players/${seats.aunt}`),
    );
    if (!mom.exists || !aunt.exists)
      throw new Error("Add both player profiles before creating their pair.");
    if (existing.exists) return;
    const game = createGame(randomUUID(), cryptoRandom);
    addGame(tx, game, pairId);
    tx.create(ref, {
      schemaVersion: 2,
      memberIds,
      seatPlayers: seats,
      names: {
        mom: mom.data().displayName || seats.mom,
        aunt: aunt.data().displayName || seats.aunt,
      },
      activeGameId: game.id,
      activeGame: gameSummary(game),
      createdAt: Date.now(),
    });
  });
  console.log(`Pair ready: ${pairId} (${first}, ${second}).`);
  return pairId;
}
async function listPlayers() {
  const [players, pairs] = await Promise.all([
    db.collection("players").get(),
    db.collection("pairs").get(),
  ]);
  for (const player of players.docs)
    console.log(
      `Player ${player.id}: ${player.data().displayName || player.id}`,
    );
  for (const pair of pairs.docs)
    console.log(
      `Pair ${pair.id}: ${(pair.data().memberIds || []).join(", ")} - game ${pair.data().activeGameId}`,
    );
}
async function prepareMultiplayer() {
  if (cloud)
    throw new Error("prepare-multiplayer is restricted to local emulators.");
  if (!(await db.doc("pairs/family").get()).exists) await prepare();
  await upgradeMultiplayer(db, { apply: true });
  for (const [id, name] of [
    ["test-alex", "Alex"],
    ["test-jamie", "Jamie"],
    ["test-sam", "Sam"],
  ]) {
    await addPlayer(id, name);
    await createPair("mom", id);
    const credential = await db.doc(`playerCredentials/${id}`).get();
    if (!credential.exists) {
      const { createCredential } =
        await import("../functions/lib/functions/player-login.js");
      await credential.ref.create({
        ...(await createCredential("246810")),
        enabled: true,
        updatedAt: Date.now(),
      });
      console.log(`LOCAL TEST ONLY: ${name} sign-in code 246810`);
    }
  }
  await createPair("test-alex", "test-jamie");
  await createPair("test-alex", "test-sam");
  await listPlayers();
}

export async function run() {
  console.log(`Target: ${projectId} (${cloud ? "CLOUD" : "local emulators"})`);
  if (command === "upgrade-multiplayer")
    await upgradeMultiplayer(db, { apply: args.includes("--apply") });
  else if (command === "prepare-multiplayer") await prepareMultiplayer();
  else if (command === "add-player") await addPlayer();
  else if (command === "create-pair") await createPair();
  else if (command === "list" || command === "list-players")
    await listPlayers();
  else if (command === "prepare") await prepare();
  else if (command === "reset") await reset();
  else if (command === "issue-code")
    await issueCode(option("slot") || (await resolvePlayer()).slot);
  else if (command === "issue-login") await issueLogin();
  else if (command === "issue-pin") await issueLogin(true);
  else if (command === "revoke-login") await revokeLogin();
  else if (command === "fixture") await fixture();
  else if (command === "names") {
    const names = {
      mom: option("mom-name") || defaultNames.mom,
      aunt: option("aunt-name") || defaultNames.aunt,
    };
    if (
      !names.mom ||
      !names.aunt ||
      Object.values(names).some((name) => name.length > 30)
    )
      throw new Error(
        "Provide --mom-name and --aunt-name (1–30 characters each).",
      );
    await db.doc("pairs/family").update({ names });
  } else
    throw new Error(
      "Usage: node scripts/admin.mjs prepare|prepare-multiplayer|upgrade-multiplayer|add-player|create-pair|list|reset|issue-code|issue-login|issue-pin|revoke-login|fixture|names --project ID [--slot mom|aunt] [--player Elizabeth|Rita] [--app-url URL] [--cloud]",
    );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
