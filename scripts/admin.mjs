import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { randomUUID, createHash, randomInt } from "node:crypto";
import { pathToFileURL } from "node:url";

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
if (cloud && ["prepare", "issue-code", "reset"].includes(command) && !appUrl)
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
function addGame(batch, game) {
  const { racks, bag, ...shared } = game;
  const ref = db.doc(`games/${game.id}`);
  batch.set(ref, {
    ...shared,
    rackCounts: { mom: racks.mom.length, aunt: racks.aunt.length },
    bagCount: bag.length,
  });
  for (const slot of slots)
    batch.set(ref.collection("racks").doc(slot), { tiles: racks[slot] });
  batch.set(ref.collection("private").doc("state"), { bag });
}
async function issueCode(slot) {
  if (!slots.includes(slot)) throw new Error("--slot must be mom or aunt.");
  if (!(await db.doc(`players/${slot}`).get()).exists)
    throw new Error("Run prepare first.");
  const pair = (await db.doc("pairs/family").get()).data();
  const playerName = pair?.names?.[slot] || defaultNames[slot];
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
      tx.create(candidateRef, { slot, expiresAt, consumedUid: null });
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
    `Send ${playerName} the private join link, or enter this invitation word inside the installed Home Screen app. It is a one-time setup ticket, not a password. Tapping Join connects this player and replaces her previous device; issuing the word leaves her current device connected.`,
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
      activeGameId: game.id,
      names: {
        mom: option("mom-name") || defaultNames.mom,
        aunt: option("aunt-name") || defaultNames.aunt,
      },
    });
    for (const slot of slots)
      batch.create(db.doc(`players/${slot}`), { uid: null });
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
  batch.update(pair.ref, { activeGameId: game.id });
  await batch.commit();
  console.log(
    `Fixture ${game.id}: ${pair.data().names?.mom || defaultNames.mom} has CATEIOR; ${pair.data().names?.aunt || defaultNames.aunt} has SENLADU.${args.includes("--finish") ? " Game finished for rematch testing." : ""}`,
  );
}

export async function run() {
  console.log(`Target: ${projectId} (${cloud ? "CLOUD" : "local emulators"})`);
  if (command === "prepare") await prepare();
  else if (command === "reset") await reset();
  else if (command === "issue-code") await issueCode(option("slot"));
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
      "Usage: node scripts/admin.mjs prepare|reset|issue-code|fixture|names --project ID [--slot mom|aunt] [--app-url URL] [--cloud]",
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
