import { test, expect, type Page } from "@playwright/test";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHash, randomBytes } from "node:crypto";
import {
  createGame,
  type Game,
  type Slot,
  type Tile,
  type Command,
} from "../shared/engine";

// This suite uses the actual callable Functions, Auth and Firestore emulators.
// No UI-only game implementation or mocked accepted command is used.
const projectId = "demo-tea-and-tiles-tests";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
for (const host of [
  process.env.FIRESTORE_EMULATOR_HOST,
  process.env.FIREBASE_AUTH_EMULATOR_HOST,
]) {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host!))
    throw new Error("E2E fixtures require local emulators");
}
const admin = initializeApp({ projectId }, "playwright-fixtures");
const db = getFirestore(admin);
const codes: Record<Slot, string> = { mom: "", aunt: "" };
let fixture: Game;

async function seedFixture() {
  for (const collection of [
    "pairs",
    "players",
    "bindings",
    "games",
    "setupCodes",
    "enrollmentAttempts",
  ]) {
    await db.recursiveDelete(db.collection(collection));
  }
  fixture = createGame("e2e-table", () => 0.42);
  const allTiles = [
    ...fixture.bag,
    ...fixture.racks.mom,
    ...fixture.racks.aunt,
  ];
  const pick = (letters: string): Tile[] =>
    [...letters].map((letter) => {
      const index = allTiles.findIndex((tile) => tile.letter === letter);
      if (index < 0) throw new Error(`Fixture has no ${letter} tile`);
      return allTiles.splice(index, 1)[0];
    });
  fixture.racks = { mom: pick("CATENOR"), aunt: pick("SADILTU") };
  fixture.bag = allTiles;
  const { bag, racks, ...publicGame } = fixture;
  const batch = db.batch();
  batch.set(db.doc("pairs/family"), {
    activeGameId: fixture.id,
    names: { mom: "Elizabeth", aunt: "Rita" },
  });
  batch.set(db.doc(`games/${fixture.id}`), {
    ...publicGame,
    rackCounts: { mom: 7, aunt: 7 },
    bagCount: bag.length,
  });
  batch.set(db.doc(`games/${fixture.id}/private/state`), { bag });
  for (const slot of ["mom", "aunt"] as const) {
    codes[slot] = randomBytes(16).toString("hex").toUpperCase();
    const hash = createHash("sha256").update(codes[slot]).digest("hex");
    batch.set(db.doc(`setupCodes/${hash}`), {
      slot,
      expiresAt: Date.now() + 60 * 60 * 1000,
      consumedUid: null,
    });
    batch.set(db.doc(`players/${slot}`), { uid: null });
    batch.set(db.doc(`games/${fixture.id}/racks/${slot}`), {
      tiles: racks[slot],
    });
  }
  await batch.commit();
}

async function enroll(page: Page, slot: Slot) {
  await page.goto("/");
  await page.getByTestId("setup-code").fill(codes[slot]);
  await page.getByTestId("enroll-submit").click();
  await expect(page.getByTestId("board-cell-7-7")).toBeVisible({
    timeout: 45_000,
  });
}

async function place(
  page: Page,
  slot: Slot,
  letter: string,
  row: number,
  col: number,
) {
  const tile = fixture.racks[slot].find(
    (candidate) => candidate.letter === letter,
  )!;
  await page.getByTestId(`rack-tile-${tile.id}`).click();
  await page.getByTestId(`board-cell-${row}-${col}`).click();
}

async function expectRevision(revision: number) {
  await expect
    .poll(
      async () => (await db.doc(`games/${fixture.id}`).get()).data()?.revision,
    )
    .toBe(revision);
}

async function assertTabletLayout(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  const play = await page.getByTestId("play-word").boundingBox();
  expect(play?.height).toBeGreaterThanOrEqual(44);
  const board = await page.getByTestId("board-cell-14-14").boundingBox();
  expect(board).not.toBeNull();
  expect(board!.x + board!.width).toBeLessThanOrEqual(
    (await page.viewportSize())!.width,
  );
}

test.beforeAll(seedFixture);
test.afterAll(async () => {
  await deleteApp(admin);
});

test("two enrolled tablets play, reload, recover an interrupted reply, finish and rematch", async ({
  browser,
}, testInfo) => {
  const momContext = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
  });
  const auntContext = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
    reducedMotion: "reduce",
  });
  const mom = await momContext.newPage();
  const aunt = await auntContext.newPage();
  const timings: { function: string; durationMs: number; status: number }[] =
    [];
  for (const page of [mom, aunt])
    page.on("response", (response) => {
      if (
        !/\/(enrollPlayer|submitCommand)$/.test(response.url()) ||
        response.request().method() !== "POST"
      )
        return;
      void response.finished().then(() => {
        const timing = response.request().timing();
        if (timing.responseEnd >= 0)
          timings.push({
            function: response.url().split("/").pop()!,
            durationMs: Math.round(timing.responseEnd),
            status: response.status(),
          });
      });
    });
  try {
    await Promise.all([enroll(mom, "mom"), enroll(aunt, "aunt")]);
    await place(mom, "mom", "C", 7, 6);
    await place(mom, "mom", "T", 7, 7);
    await place(mom, "mom", "A", 7, 8);
    await mom.reload();
    await expect(mom.getByTestId("board-cell-7-7")).toHaveAttribute(
      "aria-label",
      /T, 1 points, tentative/,
    );
    await mom.getByTestId("play-word").click();
    await expect(mom.getByTestId("game-notice")).toContainText(
      "Not in our dictionary: CTA",
    );
    await expectRevision(0);
    await expect(mom.getByTestId("turn-status")).toHaveText("Your turn");
    await expect(mom.getByTestId("board-cell-7-7")).toHaveClass(
      /has-tentative/,
    );
    await mom.getByTestId("recall-tiles").click();
    await place(mom, "mom", "C", 7, 6);
    await place(mom, "mom", "A", 7, 7);
    await place(mom, "mom", "T", 7, 8);
    await mom.getByTestId("play-word").click();
    await expectRevision(1);
    await expect(aunt.getByTestId("board-cell-7-6")).toContainText("C");
    await expect(aunt.getByTestId("score-mom")).toContainText("10");
    await place(aunt, "aunt", "S", 7, 9);
    await aunt.getByTestId("play-word").click();
    await expectRevision(2);
    await expect(mom.getByTestId("board-cell-7-9")).toContainText("S");
    await expect(mom.getByTestId("score-aunt")).toContainText("6");
    // The scoring class normally animates; reduced motion must disable it.
    await expect(aunt.getByTestId("board-cell-7-9")).toHaveClass(
      /scoring-square/,
    );
    await expect(aunt.getByTestId("board-cell-7-9")).toHaveCSS(
      "animation-name",
      "none",
    );
    await expect(aunt.getByTestId("score-aunt")).toHaveText("6");

    await Promise.all([mom.reload(), aunt.reload()]);
    await expect(mom.getByTestId("board-cell-7-9")).toContainText("S");
    await expect(aunt.getByTestId("board-cell-7-6")).toContainText("C");
    await expect(mom.getByTestId("score-mom")).toContainText("10");
    await assertTabletLayout(mom);
    await mom.screenshot({
      path: testInfo.outputPath("tablet-landscape.png"),
      fullPage: true,
    });
    await mom.setViewportSize({ width: 820, height: 1180 });
    await assertTabletLayout(mom);
    await mom.screenshot({
      path: testInfo.outputPath("tablet-portrait.png"),
      fullPage: true,
    });
    expect(
      await aunt.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);
    await aunt.screenshot({
      path: testInfo.outputPath("tablet-reduced-motion.png"),
      fullPage: true,
    });

    let interruptedCommand: Command | undefined;
    let interruptedAuthorization: string | null = null;
    await mom.route(
      "**/demo-tea-and-tiles-tests/europe-west2/submitCommand",
      async (route) => {
        interruptedCommand = route.request().postDataJSON().data as Command;
        interruptedAuthorization = await route
          .request()
          .headerValue("authorization");
        // The request reaches the real Function; only the response is lost.
        // APIRequestContext fetch remains available while the browser is offline.
        await momContext.setOffline(true);
        await route.fetch();
        await route.abort("failed");
      },
      { times: 1 },
    );
    await mom.getByTestId("pass-turn").click();
    await mom.getByTestId("confirm-pass").click();
    await expectRevision(3);
    expect(interruptedCommand).toBeDefined();
    expect(
      await mom.evaluate(
        (id) => Object.values(localStorage).some((value) => value.includes(id)),
        interruptedCommand!.id,
      ),
    ).toBe(true);
    const original = (
      await db
        .doc(`games/${fixture.id}/commands/${interruptedCommand!.id}`)
        .get()
    ).data();
    expect(original?.result.revision).toBe(3);
    // Explicitly repeat the captured command through the client callable request
    // to prove the same ID returns its original receipt after turn/revision advance.
    const response = await mom.request.post(
      "http://127.0.0.1:5001/demo-tea-and-tiles-tests/europe-west2/submitCommand",
      {
        headers: { Authorization: interruptedAuthorization! },
        data: { data: interruptedCommand! },
      },
    );
    expect(response.ok()).toBe(true);
    const receipt = await response.json();
    expect(receipt.result.revision).toBe(3);
    await expectRevision(3);
    expect((await db.doc(`games/${fixture.id}`).get()).data()?.scores).toEqual({
      mom: 10,
      aunt: 6,
    });
    await momContext.setOffline(false);
    // Receipt listeners can confirm the command before a retry button is tapped.
    // Wait for that canonical reconciliation rather than racing a disappearing button.
    await expect
      .poll(() =>
        mom.evaluate(
          (id) =>
            Object.values(localStorage).some((value) => value.includes(id)),
          interruptedCommand!.id,
        ),
      )
      .toBe(false);
    await expect(aunt.getByTestId("turn-status")).toContainText(/your turn/i);

    for (let revision = 4; revision <= 8; revision++) {
      const player = revision % 2 === 0 ? aunt : mom;
      await player.getByTestId("pass-turn").click();
      await player.getByTestId("confirm-pass").click();
      await expectRevision(revision);
    }
    await expect
      .poll(
        async () => (await db.doc(`games/${fixture.id}`).get()).data()?.status,
      )
      .toBe("finished");
    await expect(mom.getByTestId("end-game-popup")).toBeVisible();
    await expect(aunt.getByTestId("end-game-popup")).toBeVisible();
    await expect(
      mom.locator(".game-sidebar").getByTestId("rematch"),
    ).toHaveCount(0);
    await expect(mom.getByTestId("rematch")).toBeVisible();
    await mom.getByTestId("rematch").click();
    await expect(mom.getByTestId("new-game-popup")).toBeVisible();
    await mom.getByTestId("request-new-game").click();
    await expect(aunt.getByTestId("incoming-new-game-popup")).toBeVisible();
    await expect(aunt.getByTestId("end-game-popup")).toHaveCount(0);
    expect((await db.doc("pairs/family").get()).data()?.activeGameId).toBe(
      fixture.id,
    );
    await aunt.getByTestId("approve-new-game").click();
    await expect
      .poll(
        async () => (await db.doc("pairs/family").get()).data()?.activeGameId,
      )
      .not.toBe(fixture.id);
    await expect(aunt.getByTestId("board-cell-7-6")).not.toContainText("C");
    await expect(mom.getByTestId("end-game-popup")).toHaveCount(0);
    await expect(aunt.getByTestId("end-game-popup")).toHaveCount(0);
    await expect(mom.getByTestId("score-mom")).toHaveText("0");
    await expect(aunt.getByTestId("score-aunt")).toHaveText("0");
    await Promise.all([mom.reload(), aunt.reload()]);
    await expect(mom.getByTestId("board-cell-7-7")).toBeVisible();
    await expect(aunt.getByTestId("board-cell-7-7")).toBeVisible();
  } finally {
    await testInfo.attach("emulator-callable-latencies.json", {
      body: JSON.stringify(timings, null, 2),
      contentType: "application/json",
    });
    console.log(
      "Emulator callable timings (milliseconds):",
      JSON.stringify(timings),
    );
    await Promise.all([momContext.close(), auntContext.close()]);
  }
});
