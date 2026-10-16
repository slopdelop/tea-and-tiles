import { test, expect, type Page } from "@playwright/test";
import { Firestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  cloudSourceSelection,
  readCloudSource,
} from "../scripts/cloud-test-source.mjs";
import {
  assertCloudTestTarget,
  cloudTest,
  cloudTestAccess,
} from "../scripts/cloud-test-project.mjs";
import type { Game } from "../shared/engine";
import { runSoak } from "./soak-scenario";
import { requireCloudTestDeployment } from "../scripts/cloud-test-deployment.mjs";

assertCloudTestTarget();
requireCloudTestDeployment();
if (process.env.TEA_CLOUD_SOAK !== "tea-and-tiles-test")
  throw new Error(
    "Use npm run test:soak:cloud; no implicit cloud test execution.",
  );
let db: Firestore;
test.beforeAll(async () => {
  const { credentials } = await cloudTestAccess();
  // Google Auth supports authorized_user JSON, although Firestore's narrower
  // credential declaration only lists service-account fields. Let Firestore use
  // its own Auth-library version; a separately constructed client can mismatch it.
  db = new Firestore({
    projectId: cloudTest.projectId,
    credentials: credentials as unknown as {
      client_email?: string;
      private_key?: string;
    },
  });
});
const runId = randomUUID();
let gameId = "";
test.afterAll(async () => {
  // Never delete games, users or collections. Release only our own run lease.
  if (gameId)
    await db.runTransaction(async (tx) => {
      const control = db.doc("testControl/cloud-soak");
      const current = await tx.get(control);
      if (current.data()?.runId === runId)
        tx.update(control, { leaseUntil: 0 });
    });
  if (db) await db.terminate();
});

test("isolated real Firebase back-and-forth", async ({ browser }, info) => {
  const secret = JSON.parse(
    readFileSync(resolve(".tools/cloud-test-appcheck.json"), "utf8"),
  );
  if (
    secret.projectId !== cloudTest.projectId ||
    secret.appId !== cloudTest.appId ||
    !secret.token
  )
    throw new Error("Private test App Check setup is missing or mismatched.");
  const source = readCloudSource();
  const { root } = cloudSourceSelection();
  const { createGame } = await import(
    pathToFileURL(resolve(root, "functions/lib/shared/engine.js")).href
  );
  let seed = 1234567;
  const initial: Game = createGame(
    `soak-${runId}`,
    () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296,
  );
  initial.turn = "mom";
  const codes = {
    mom: randomBytes(16).toString("hex").toUpperCase(),
    aunt: randomBytes(16).toString("hex").toUpperCase(),
  };
  await db.runTransaction(async (tx) => {
    const control = db.doc("testControl/cloud-soak"),
      pair = db.doc("pairs/family");
    const [lock, priorPair, mom, aunt] = await tx.getAll(
      control,
      pair,
      db.doc("players/mom"),
      db.doc("players/aunt"),
    );
    if ((lock.data()?.leaseUntil || 0) > Date.now())
      throw new Error(
        "Another cloud soak owns the test table. Wait for it to finish.",
      );
    if (priorPair.exists && priorPair.data()?.testHarness !== "cloud-soak")
      throw new Error(
        "Refusing to replace an unmarked game table, even in the test project.",
      );
    tx.set(control, {
      runId,
      leaseUntil: Date.now() + 32 * 60_000,
      sourceRevision: source.revision,
    });
    tx.set(pair, {
      schemaVersion: 2,
      memberIds: ["mom", "aunt"],
      seatPlayers: { mom: "mom", aunt: "aunt" },
      activeGameId: initial.id,
      activeGame: {
        id: initial.id,
        status: initial.status,
        turn: initial.turn,
        scores: initial.scores,
        revision: initial.revision,
        updatedAt: Date.now(),
      },
      names: { mom: "Test Elizabeth", aunt: "Test Rita" },
      testHarness: "cloud-soak",
    });
    for (const [slot, previous] of [
      ["mom", mom],
      ["aunt", aunt],
    ] as const) {
      tx.set(db.doc(`players/${slot}`), {
        uid: null,
        displayName: slot === "mom" ? "Test Elizabeth" : "Test Rita",
        loginName: slot === "mom" ? "test elizabeth" : "test rita",
        sessionVersion: (previous.data()?.sessionVersion || 0) + 1,
      });
      const hash = createHash("sha256").update(codes[slot]).digest("hex");
      tx.create(db.doc(`setupCodes/${hash}`), {
        slot,
        consumedUid: null,
        expiresAt: Date.now() + 3_600_000,
      });
    }
    const { racks, bag, ...publicGame } = initial;
    tx.create(db.doc(`games/${initial.id}`), {
      ...publicGame,
      pairId: "family",
      rackCounts: { mom: 7, aunt: 7 },
      bagCount: bag.length,
    });
    for (const slot of ["mom", "aunt"] as const)
      tx.create(db.doc(`games/${initial.id}/racks/${slot}`), {
        tiles: racks[slot],
      });
    tx.create(db.doc(`games/${initial.id}/private/state`), { bag });
  });
  gameId = initial.id;
  const contexts = await Promise.all(
    [0, 1].map(() =>
      browser.newContext({
        baseURL: "http://127.0.0.1:5185",
        hasTouch: true,
        viewport: { width: 1024, height: 768 },
        reducedMotion: "no-preference",
      }),
    ),
  );
  let clock: { serverOffsetMs: number; uncertaintyMs: number } | null = null;
  const enroll = async (page: Page, slot: "mom" | "aunt") => {
    await page.addInitScript((token) => {
      (
        self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }
      ).FIREBASE_APPCHECK_DEBUG_TOKEN = token;
    }, secret.token);
    const requestTimes = new WeakMap<object, number>();
    page.on("request", (request) => {
      if (
        request.url().endsWith("/reportMoveDiagnostics") &&
        request.postDataJSON()?.data?.action === "clock"
      )
        requestTimes.set(request, Date.now());
    });
    page.on("response", async (response) => {
      const start = requestTimes.get(response.request());
      if (!start || !response.ok()) return;
      const end = Date.now();
      const data = await response.json().catch(() => null);
      const serverNow = data?.result?.serverNow ?? data?.data?.serverNow;
      const uncertaintyMs = (end - start) / 2;
      if (
        Number.isFinite(serverNow) &&
        (!clock || uncertaintyMs < clock.uncertaintyMs)
      )
        clock = {
          serverOffsetMs: serverNow - (start + end) / 2,
          uncertaintyMs,
        };
    });
    // Browser-level deny list avoids intercepting/pausing the test's streaming
    // requests or disabling its cache, which would distort this networking test.
    const network = await page.context().newCDPSession(page);
    await network.send("Network.enable");
    await network.send("Network.setBlockedURLs", {
      urls: [
        "*tea-and-tiles.cloudfunctions.net/*",
        "*tea-and-tiles.firebaseapp.com/*",
        "*projects/tea-and-tiles/*",
        "*projects%2Ftea-and-tiles%2F*",
        "*107923684102*",
        "*AIzaSyCYW3ISS9hun5qTLw5LNvRaSOUuT-1ChOM*",
      ],
    });
    await page.goto(`/#setup=${encodeURIComponent(codes[slot])}`);
    await page.getByTestId("setup-code").fill(codes[slot]);
    await page.getByTestId("enroll-submit").click();
    await expect(page.getByTestId("game-board")).toBeVisible({
      timeout: 90_000,
    });
    await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(
      7,
    );
  };
  try {
    const page = await contexts[0].newPage(),
      aunt = await contexts[1].newPage();
    await enroll(page, "mom");
    await enroll(aunt, "aunt");
    const dictionary = new Set(
      readFileSync(resolve(root, "shared/words.txt"), "utf8")
        .trim()
        .split(/\s+/),
    );
    await info.attach("cloud-test-target", {
      body: JSON.stringify({
        projectId: cloudTest.projectId,
        gameId,
        revision: source.revision,
      }),
      contentType: "application/json",
    });
    console.log(
      `CLOUD SOAK target=${cloudTest.projectId} game=${gameId} release=${source.revision}`,
    );
    await runSoak({
      page,
      aunt,
      info,
      dictionary,
      clock: () => clock,
      environment: `real Firebase ${cloudTest.projectId}; source ${source.revision}; Chrome default transport; normal animations`,
      readPublicGame: async () =>
        (await db.doc(`games/${gameId}`).get()).data() as Game,
      readGame: async () => {
        const [shared, mom, aunt, bag] = await db.getAll(
          db.doc(`games/${gameId}`),
          db.doc(`games/${gameId}/racks/mom`),
          db.doc(`games/${gameId}/racks/aunt`),
          db.doc(`games/${gameId}/private/state`),
        );
        return {
          ...shared.data(),
          racks: { mom: mom.data()!.tiles, aunt: aunt.data()!.tiles },
          bag: bag.data()!.bag,
        } as Game;
      },
    });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
