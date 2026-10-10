import {
  test,
  expect,
  type Page,
  type Locator,
  type CDPSession,
  type Browser,
} from "@playwright/test";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHash, randomBytes } from "node:crypto";
import {
  applyCommand,
  createGame,
  type Game,
  type Tile,
} from "../shared/engine";

// A separate project AND separate process/ports protect the user's active match.
const projectId = "demo-tea-and-tiles-ui-tests";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8180";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9199";
if (
  process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8180" ||
  process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9199"
)
  throw new Error(
    "UI fixtures require their isolated emulator ports. Refusing all other databases.",
  );
const admin = initializeApp({ projectId }, "isolated-ui-tests");
const db = getFirestore(admin);
let code = "";
let tiles: Tile[] = [];
let expectedBoardKeys = ["0,0"];
let expectedRevision = 0;
let expectedCommandCount = 0;
let fixtureGame: Game;
const themes = [
  "linen",
  "coastal",
  "rose",
  "forest",
  "sunshine",
  "ink",
  "midnight",
  "terracotta",
] as const;
const darkThemes = new Set<string>(["ink", "midnight"]);

test.beforeEach(async () => {
  expectedBoardKeys = ["0,0"];
  expectedRevision = 0;
  expectedCommandCount = 0;
  for (const collection of [
    "games",
    "pairs",
    "players",
    "bindings",
    "setupCodes",
    "enrollmentAttempts",
  ])
    await db.recursiveDelete(db.collection(collection));
  const game = createGame("ui-table", () => 0.42);
  const pool = [...game.bag, ...game.racks.mom, ...game.racks.aunt];
  const pick = (letters: string) =>
    [...letters].map(
      (letter) =>
        pool.splice(
          pool.findIndex((tile) => tile.letter === letter),
          1,
        )[0],
    );
  tiles = pick("MWQAT??");
  game.racks = { mom: tiles, aunt: pick("SENLADU") };
  const committed = pick("R")[0];
  game.board = { "0,0": { ...committed, row: 0, col: 0 } };
  game.bag = pool;
  fixtureGame = game;
  const { racks, bag, ...shared } = game;
  code = "MAPLE";
  const batch = db.batch();
  batch.set(db.doc("pairs/family"), {
    activeGameId: game.id,
    names: { mom: "Elizabeth", aunt: "Rita" },
  });
  batch.set(db.doc("players/mom"), { uid: null });
  batch.set(db.doc("players/aunt"), { uid: null });
  batch.set(db.doc(`games/${game.id}`), {
    ...shared,
    rackCounts: { mom: 7, aunt: 7 },
    bagCount: bag.length,
  });
  batch.set(db.doc(`games/${game.id}/racks/mom`), { tiles: racks.mom });
  batch.set(db.doc(`games/${game.id}/racks/aunt`), { tiles: racks.aunt });
  batch.set(db.doc(`games/${game.id}/private/state`), { bag });
  batch.set(
    db.doc(`setupCodes/${createHash("sha256").update(code).digest("hex")}`),
    { slot: "mom", consumedUid: null, expiresAt: Date.now() + 3_600_000 },
  );
  await batch.commit();
});
test.afterEach(async () => {
  const game = (await db.doc("games/ui-table").get()).data()!;
  expect(game.revision).toBe(expectedRevision);
  expect(Object.keys(game.board).sort()).toEqual(expectedBoardKeys.sort());
  expect((await db.collection("games/ui-table/commands").get()).size).toBe(
    expectedCommandCount,
  );
});
test.afterAll(async () => {
  await deleteApp(admin);
});

async function enroll(page: Page, expectedRackCount = 7) {
  await page.goto("/");
  await page.getByTestId("setup-code").fill(code.toLowerCase());
  await page.getByTestId("enroll-submit").click();
  await expect(page.getByTestId("game-board")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(
    expectedRackCount,
  );
}
async function joinRita(browser: Browser, expectedRackCount = 7) {
  await db
    .doc(`setupCodes/${createHash("sha256").update("PEACH").digest("hex")}`)
    .set({
      slot: "aunt",
      consumedUid: null,
      expiresAt: Date.now() + 3_600_000,
    });
  const auntContext = await browser.newContext({
    baseURL: "http://127.0.0.1:5183",
    hasTouch: true,
    viewport: { width: 820, height: 1180 },
    reducedMotion: "reduce",
  });
  try {
    const aunt = await auntContext.newPage();
    await aunt.goto("/");
    await aunt.getByTestId("setup-code").fill("peach");
    await aunt.getByTestId("enroll-submit").click();
    await expect(aunt.getByTestId("game-board")).toBeVisible({
      timeout: 45_000,
    });
    await expect(aunt.getByTestId("tile-rack").locator("button")).toHaveCount(
      expectedRackCount,
    );
    return { aunt, auntContext };
  } catch (error) {
    await auntContext.close();
    throw error;
  }
}
async function openTableAction(
  page: Page,
  id: "new-game" | "review-words" | "rematch",
) {
  if (id === "review-words") {
    await expect(page.locator(".game-sidebar").getByTestId(id)).toHaveCount(0);
    await page.getByTestId("help-settings").click();
    await expect(
      page.getByRole("dialog", { name: "Help & settings" }),
    ).toBeVisible();
  } else if (id === "new-game") {
    await expect(page.locator(".turn-card").getByTestId(id)).toHaveCount(0);
    await expect(page.locator(".app-header").getByTestId(id)).toBeVisible();
  } else if (id === "rematch") {
    if (!(await page.getByTestId("end-game-popup").isVisible()))
      await page.getByTestId("view-result").click();
    await expect(page.getByTestId("end-game-popup")).toBeVisible();
    await expect(
      page.locator(".game-sidebar").getByTestId("rematch"),
    ).toHaveCount(0);
  }
  await page.getByTestId(id).click();
}
async function inspectFinishedBoard(page: Page) {
  const result = page.getByTestId("end-game-popup");
  await expect(result).toBeVisible();
  await result.getByTestId("inspect-board").click();
  await expect(result).toHaveCount(0);
}
async function expectRequiredDecision(page: Page, dialog: Locator) {
  await expect(
    dialog.getByRole("button", { name: "Close dialog" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Decide later", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5); // Outside the centered dialog, on its backdrop.
  await expect(dialog).toBeVisible();
}
async function writeFixture(next: Game) {
  fixtureGame = next;
  expectedRevision = next.revision;
  expectedBoardKeys = Object.keys(next.board);
  const { racks, bag, ...publicState } = next;
  const batch = db.batch();
  batch.set(db.doc(`games/${next.id}`), {
    ...publicState,
    rackCounts: { mom: racks.mom.length, aunt: racks.aunt.length },
    bagCount: bag.length,
  });
  for (const slot of ["mom", "aunt"] as const)
    batch.set(db.doc(`games/${next.id}/racks/${slot}`), { tiles: racks[slot] });
  batch.set(db.doc(`games/${next.id}/private/state`), { bag });
  await batch.commit();
}
const rack = (page: Page, letter: string, index = 0) =>
  page.getByTestId(
    `rack-tile-${tiles.filter((tile) => tile.letter === letter)[index].id}`,
  );
const cell = (page: Page, row: number, col: number) =>
  page.getByTestId(`board-cell-${row}-${col}`);
async function enterHiddenZoom(page: Page) {
  const entry = page.getByTestId("zoom-board");
  await expect(entry).toBeHidden();
  // The product hides this entry; exercise retained zoom behavior without
  // revealing or pretending this control is user accessible.
  await entry.evaluate((element) => (element as HTMLButtonElement).click());
  await expect(page.getByTestId("whole-board")).toBeVisible();
}
async function point(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function beginMouseDrag(
  page: Page,
  source: Locator,
  destination: Locator,
) {
  const innerTile = source.locator(":scope > .board-tile");
  const activeSource = (await innerTile.count()) ? innerTile : source;
  await activeSource.click({ trial: true }); // Wait for the tile's placement spring to settle.
  const box = (await activeSource.boundingBox())!;
  const tentativeBefore = await page.locator(".has-tentative").count();
  const start = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.35 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const target = await point(destination);
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await expect(page.getByTestId("drag-ghost")).toBeVisible();
  await expect
    .poll(async () => {
      const rect = (await page.getByTestId("drag-ghost").boundingBox())!;
      return Math.max(
        Math.abs(rect.x + rect.width * 0.3 - target.x),
        Math.abs(rect.y + rect.height * 0.35 - target.y),
      );
    })
    .toBeLessThan(2);
  const ghost = (await page.getByTestId("drag-ghost").boundingBox())!;
  const square = (await cell(page, 0, 0).boundingBox())!;
  const rackTiles = page.locator(".rack-tile");
  const rackSize = (await rackTiles.count())
    ? await rackTiles.first().boundingBox()
    : null;
  expect(Math.abs(ghost.width - square.width * 1.1)).toBeLessThan(1);
  expect(Math.abs(ghost.height - square.width * 1.1)).toBeLessThan(1);
  if (rackSize) expect(ghost.width).toBeLessThan(rackSize.width);
  expect(Math.abs(ghost.x - (target.x - ghost.width * 0.3))).toBeLessThan(2);
  expect(Math.abs(ghost.y - (target.y - ghost.height * 0.35))).toBeLessThan(2);
  await expect(page.getByTestId("drag-ghost")).toHaveCSS(
    "pointer-events",
    "none",
  );
  expect(
    await page
      .getByTestId("drag-ghost")
      .evaluate((el) => getComputedStyle(el).boxShadow),
  ).not.toBe("none");
  await expect(page.locator(".has-tentative")).toHaveCount(tentativeBefore);
  if (
    (await page.getByTestId("drag-ghost").getAttribute("class"))
      ?.split(/\s+/)
      .includes("valid-drop") &&
    (await destination.getAttribute("data-drop-row")) !== null
  ) {
    await expect(destination).toHaveClass(/drag-over-square/);
    await expect(destination.getByTestId("landing-preview")).toBeVisible();
  }
}
async function finishDrag(
  page: Page,
  release: () => Promise<void>,
  destination: Locator,
  phase: "settling" | "returning",
  inset = 0,
  destinationAfterRelease = false,
) {
  const beforeRelease = destinationAfterRelease
    ? null
    : (await destination.boundingBox())!;
  await page.evaluate(() => {
    const state = window as unknown as {
      dragMotion: Promise<
        { x: number; y: number; width: number; phase: string }[]
      >;
    };
    state.dragMotion = new Promise((resolve) => {
      const samples: { x: number; y: number; width: number; phase: string }[] =
        [];
      const deadline = performance.now() + 1000;
      const sample = () => {
        const ghost = document.querySelector('[data-testid="settling-ghost"]');
        if (ghost) {
          const rect = ghost.getBoundingClientRect();
          samples.push({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            phase: ghost.getAttribute("data-phase") || "",
          });
        }
        if ((samples.length && !ghost) || performance.now() > deadline)
          resolve(samples);
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  });
  await release();
  await expect(page.getByTestId("drag-ghost")).toBeHidden();
  await expect(page.getByTestId("settling-ghost")).toBeHidden();
  const samples = await page.evaluate(
    () =>
      (
        window as unknown as {
          dragMotion: Promise<
            { x: number; y: number; width: number; phase: string }[]
          >;
        }
      ).dragMotion,
  );
  expect(samples.length).toBeGreaterThan(2);
  expect(samples.every((sample) => sample.phase === phase)).toBe(true);
  if (destinationAfterRelease) {
    await expect(destination).toBeVisible();
    await expect(destination.locator("..")).toHaveCSS("transform", "none");
  }
  const endpoint = beforeRelease || (await destination.boundingBox())!;
  const final = samples.at(-1)!;
  expect(Math.abs(final.x - endpoint.x - inset)).toBeLessThan(3);
  expect(Math.abs(final.y - endpoint.y - inset)).toBeLessThan(3);
  expect(Math.abs(final.width - endpoint.width + inset * 2)).toBeLessThan(3);
  await expect(page.locator(".settling-target")).toHaveCount(0);
}
async function dragMouse(
  page: Page,
  source: Locator,
  destination: Locator,
  returnsTo?: Locator,
) {
  await beginMouseDrag(page, source, destination);
  await finishDrag(
    page,
    () => page.mouse.up(),
    returnsTo || destination,
    returnsTo ? "returning" : "settling",
    returnsTo ? 0 : 2,
  );
}
async function checkTypography(page: Page) {
  const failures = await page.evaluate(() => {
    const bad: string[] = [];
    for (const label of document.querySelectorAll<HTMLElement>(
      ".premium-label",
    )) {
      const square = label.parentElement!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(label);
      const text = range.getBoundingClientRect();
      if (
        text.left < square.left - 0.5 ||
        text.right > square.right + 0.5 ||
        text.top < square.top - 0.5 ||
        text.bottom > square.bottom + 0.5
      )
        bad.push(
          `Premium ${label.textContent}: ${text.width.toFixed(1)}x${text.height.toFixed(1)} in ${square.width.toFixed(1)}x${square.height.toFixed(1)}`,
        );
    }
    for (const tile of document.querySelectorAll<HTMLElement>(
      ".rack-tile, .board-tile",
    )) {
      const letter = tile.querySelector(".tile-letter"),
        value = tile.querySelector("small");
      if (!letter || !value) continue;
      const l = letter.getBoundingClientRect(),
        v = value.getBoundingClientRect();
      if (
        l.left < v.right &&
        l.right > v.left &&
        l.top < v.bottom &&
        l.bottom > v.top
      )
        bad.push(`Letter/value overlap: ${tile.textContent}`);
      const range = document.createRange();
      range.selectNodeContents(value);
      const ink = range.getBoundingClientRect(),
        bounds = tile.getBoundingClientRect();
      if (ink.right > bounds.right + 0.5 || ink.bottom > bounds.bottom + 0.5)
        bad.push(`Score outside tile: ${tile.textContent}`);
    }
    return bad;
  });
  expect(failures).toEqual([]);
}

async function checkTextContrast(page: Page, selector: string) {
  const readings = await page.locator(selector).evaluateAll((elements) => {
    const context = document.createElement("canvas").getContext("2d")!;
    context.canvas.width = context.canvas.height = 1;
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).map(
        (value, index) => (index === 3 ? value / 255 : value),
      );
    };
    const blend = (front: number[], back: number[]) =>
      [0, 1, 2]
        .map((index) => front[index] * front[3] + back[index] * (1 - front[3]))
        .concat(1);
    const backgrounds = (element: Element | null): number[][] => {
      if (!element) return [[255, 255, 255, 1]];
      const style = getComputedStyle(element);
      const gradient = style.backgroundImage.match(
        /rgba?\([^)]*\)|color\(srgb[^)]*\)/g,
      );
      const paints = gradient?.length
        ? gradient.map(rgba)
        : [rgba(style.backgroundColor)];
      if (paints.every((paint) => paint[3] === 1)) return paints;
      return paints.flatMap((paint) =>
        backgrounds(element.parentElement).map((back) => blend(paint, back)),
      );
    };
    const luminance = (color: number[]) =>
      color
        .slice(0, 3)
        .map((value) => value / 255)
        .map((value) =>
          value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
        )
        .reduce(
          (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
          0,
        );
    return elements
      .filter(
        (element) =>
          element.getBoundingClientRect().width && element.textContent?.trim(),
      )
      .map((element) => {
        const foreground = rgba(getComputedStyle(element).color);
        const ratios = backgrounds(element).map((background) => {
          const ink = luminance(blend(foreground, background)),
            paper = luminance(background);
          return (Math.max(ink, paper) + 0.05) / (Math.min(ink, paper) + 0.05);
        });
        return {
          label: `${element.className}: ${element.textContent?.trim().slice(0, 50)}`,
          contrast: Math.min(...ratios),
          // The decorative unassigned-blank star is an icon. Assigned letters
          // and every score value, including zero, retain the text threshold.
          minimum: element.matches(".blank-symbol") ? 3 : 4.5,
        };
      });
  });
  expect(readings.length).toBeGreaterThan(0);
  expect(
    readings.filter((reading) => reading.contrast < reading.minimum),
  ).toEqual([]);
  return readings;
}

test("tablet landscape expands the board to the top and exposes the build version", async ({
  page,
}, info) => {
  await enroll(page);
  await expect(page.getByTestId("turn-announcement")).toBeVisible();
  await expect(page.getByTestId("turn-announcement")).toBeHidden();
  for (const [width, height] of [
    [1024, 768],
    [1180, 820],
    [1366, 1024],
  ]) {
    await page.setViewportSize({ width, height });
    await expect(page.locator(".brand")).toBeHidden();
    const board = await page.locator(".board-frame").boundingBox();
    const hand = await page.locator(".hand-row").boundingBox();
    expect(board!.y).toBeLessThanOrEqual(24);
    expect(board!.width).toBeGreaterThan(height - 190);
    expect(hand!.y + hand!.height).toBeLessThanOrEqual(height);
    await expect(page.getByTestId("help-settings")).toBeVisible();
    await expect(page.getByTestId("new-game")).toBeVisible();
    await expect(page.getByTestId("sidebar-bag-count")).toContainText(
      "tiles in the bag",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`expanded-board-${width}x${height}.png`),
      fullPage: false,
    });
  }
  await page.getByTestId("help-settings").click();
  await expect(page.getByTestId("app-version")).toHaveText(
    /^Version 0\.1\.1 · (?:[a-f0-9]{7}|local)$/,
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.setViewportSize({ width: 820, height: 1180 });
  await expect(page.locator(".brand")).toBeVisible();
});

test("premium labels and tile letters/values fit compact landscape and portrait", async ({
  page,
}, info) => {
  await enroll(page);
  await expect(cell(page, 0, 3).locator(".premium-label")).toHaveText("DL");
  await expect(cell(page, 0, 3)).toHaveAttribute(
    "aria-label",
    /Double letter/i,
  );
  for (const [letter, col] of [
    ["M", 6],
    ["W", 7],
    ["Q", 8],
  ] as const) {
    await rack(page, letter).tap();
    await cell(page, 7, col).tap();
  }
  for (const [width, height] of [
    [1280, 720],
    [1024, 768],
    [820, 1180],
  ]) {
    await page.setViewportSize({ width, height });
    await checkTypography(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`typography-${width}x${height}.png`),
      fullPage: true,
    });
  }
});

test("opening word may start away from the centre star, guides coverage and keeps turn buttons large in every tablet layout", async ({
  page,
}, info) => {
  await writeFixture({
    ...fixtureGame,
    board: {},
    bag: [
      ...fixtureGame.bag,
      ...Object.values(fixtureGame.board).map(
        ({ row: _row, col: _col, ...tile }) => tile,
      ),
    ],
  });
  await enroll(page);
  const hint = page.getByTestId("first-word-hint");
  await expect(page.locator(".move-preview")).toHaveCount(0);
  await expect(hint).toHaveAttribute("data-state", "required");
  await expect(hint).toContainText(
    "Your first word must cover the centre star.",
  );
  await expect(cell(page, 7, 7)).toHaveAccessibleName(
    /Centre star.*double word/i,
  );
  await expect(cell(page, 7, 7)).toHaveClass(/opening-centre/);
  await rack(page, "A").tap();
  await expect(page.locator(".rack-hint")).toContainText("empty square");
  await cell(page, 7, 8).tap(); // Starting at the word's end remains possible.
  await expect(page.locator(".move-preview")).toBeVisible();
  await expect(page.getByTestId("draft-arrangement-error")).toBeVisible();
  await expect(cell(page, 7, 8)).toHaveClass(/has-tentative/);
  await expect(hint).toHaveCount(0);
  await expect(page.getByTestId("draft-arrangement-error")).toHaveCount(1);
  await expect(page.locator(".move-preview")).toHaveClass(/invalid-preview/);
  await expect(page.getByTestId("play-word")).toBeDisabled();
  await rack(page, "T").tap();
  await cell(page, 7, 7).tap(); // TA now covers the star and is a base word.
  await expect(hint).toHaveCount(0);
  await expect(page.getByTestId("draft-arrangement-error")).toHaveCount(0);
  await expect(page.getByTestId("word-check")).toHaveAttribute(
    "data-state",
    "recognized",
  );
  await expect(page.getByTestId("play-word")).toBeEnabled();
  await page.getByTestId("recall-tiles").click();
  await expect(page.locator(".move-preview")).toHaveCount(0);
  await expect(page.getByTestId("draft-arrangement-error")).toHaveCount(0);
  await expect(hint).toHaveAttribute("data-state", "required");
  await expect(page.getByTestId("exchange-tiles")).toBeEnabled();
  await expect(page.getByTestId("pass-turn")).toBeEnabled();
  const checkButtons = async () => {
    for (const id of ["exchange-tiles", "pass-turn"]) {
      const button = page.getByTestId(id);
      await button.scrollIntoViewIfNeeded();
      const measured = await button.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          height: rect.height,
          width: rect.width,
          fits:
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight,
          reachable:
            document
              .elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              )
              ?.closest("button") === element,
        };
      });
      expect(measured.height).toBeGreaterThanOrEqual(44);
      expect(measured.width).toBeGreaterThanOrEqual(96);
      expect(measured.fits).toBe(true);
      expect(measured.reachable).toBe(true);
    }
    const recall = page.getByTestId("recall-tiles");
    const shuffle = page.getByTestId("shuffle-rack");
    await expect(
      recall.locator("xpath=ancestor::*[contains(@class,'hand-row')]"),
    ).toHaveCount(1);
    await expect(
      shuffle.locator("xpath=ancestor::*[contains(@class,'hand-row')]"),
    ).toHaveCount(1);
    const handControls = await page.evaluate(() => {
      return ["recall-tiles", "shuffle-rack"].map((id) => {
        const button = document.querySelector(`[data-testid="${id}"]`)!;
        const bounds = button.getBoundingClientRect();
        return {
          id,
          isButton: button.tagName === "BUTTON",
          outsideRack: !button.closest("[data-drop-rack]"),
          height: bounds.height,
          border: getComputedStyle(button).borderStyle,
        };
      });
    });
    for (const button of handControls) {
      expect(button.isButton).toBe(true);
      expect(button.outsideRack).toBe(true);
      expect(button.height).toBeGreaterThanOrEqual(32);
      expect(button.border).not.toBe("none");
    }
    const recallBox = (await recall.boundingBox())!;
    const shuffleBox = (await shuffle.boundingBox())!;
    expect(Math.abs(recallBox.y - shuffleBox.y)).toBeLessThan(2);
    expect(recallBox.x + recallBox.width).toBeLessThanOrEqual(shuffleBox.x);
  };
  for (const turn of ["mom", "aunt"] as const) {
    if (turn === "aunt") {
      const r = fixtureGame.bag.find((tile) => tile.letter === "R")!;
      await writeFixture({
        ...fixtureGame,
        revision: 1,
        turn,
        board: { "0,0": { ...r, row: 0, col: 0 } },
        bag: fixtureGame.bag.filter((tile) => tile.id !== r.id),
      });
      await expect(cell(page, 0, 0)).toHaveClass(/has-committed/);
      await expect(hint).toHaveCount(0);
      for (const id of ["exchange-tiles", "pass-turn"]) {
        await expect(page.getByTestId(id)).toBeDisabled();
        await expect(page.getByTestId(id)).toHaveAccessibleDescription(
          /Rita.*your turn/i,
        );
      }
    }
    for (const [width, height] of [
      [1280, 720],
      [1024, 768],
      [820, 1180],
    ]) {
      await page.setViewportSize({ width, height });
      await checkButtons();
      if (turn === "mom")
        await page.screenshot({
          path: info.outputPath(`opening-guidance-${width}x${height}.png`),
          fullPage: true,
        });
      await enterHiddenZoom(page);
      await expect(page.getByTestId("whole-board")).toBeVisible();
      await checkButtons();
      if (turn === "mom") {
        await expect(hint).toBeVisible();
        await page.screenshot({
          path: info.outputPath(`opening-guidance-zoom-${width}x${height}.png`),
          fullPage: true,
        });
      }
      await page.getByTestId("whole-board").click();
    }
  }
});

test("themes stay readable in tablet layouts, persist per device and leave a private draft unchanged", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  await db
    .doc(`setupCodes/${createHash("sha256").update("PEACH").digest("hex")}`)
    .set({
      slot: "aunt",
      consumedUid: null,
      expiresAt: Date.now() + 3_600_000,
    });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await enroll(page);
  await rack(page, "A").tap();
  await cell(page, 0, 1).tap();
  await rack(page, "T").tap();
  await cell(page, 0, 2).tap();
  const chooseTheme = async (view: Page, theme: string) => {
    await view.getByTestId("help-settings").click();
    await view.getByTestId(`theme-${theme}`).check();
    await expect(view.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(view.locator("html")).toHaveCSS(
      "color-scheme",
      darkThemes.has(theme) ? /^dark$/ : /^(normal|light)$/,
    );
    if (view === page) {
      const settings = view.getByRole("dialog", { name: "Help & settings" });
      await expect(settings.getByTestId("facetime-help")).toContainText(
        /FaceTime.*move.*clear area/i,
      );
      await expect(settings).toHaveCSS("opacity", "1");
      await expect(settings).toHaveCSS("transform", "none");
      await expect(settings.locator(".theme-credit")).toHaveCount(0);
      await view.getByTestId(`theme-${theme}`).scrollIntoViewIfNeeded();
      await checkTextContrast(
        view,
        ".theme-options .choice-card strong, .theme-options .choice-card small",
      );
      await view.screenshot({
        path: info.outputPath(`settings-theme-${theme}.png`),
        fullPage: true,
      });
    }
    await view.getByRole("button", { name: "Close dialog" }).click();
    await expect(view.getByRole("dialog")).toHaveCount(0);
  };
  // Check the corrected hand-control cascade before the longer palette tour.
  await chooseTheme(page, "terracotta");
  await checkTextContrast(page, ".hand-action-button:enabled");
  const surfaces = new Set<string>();
  for (const theme of themes) {
    await chooseTheme(page, theme);
    surfaces.add(
      await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      ),
    );
    const contrast = await checkTextContrast(
      page,
      ".primary-button:enabled, .secondary-button:enabled, .hand-action-button:enabled, .rack-hint, .move-preview strong, .move-preview .preview-note, .premium-label, .rack-tile .tile-letter, .rack-tile small, .board-tile .tile-letter, .board-tile small",
    );
    await info.attach(`theme-${theme}-contrast`, {
      body: JSON.stringify(contrast),
      contentType: "application/json",
    });
    for (const [width, height] of [
      [1024, 768],
      [820, 1180],
    ]) {
      await page.setViewportSize({ width, height });
      await checkTypography(page);
      await expect(page.locator(".has-tentative")).toHaveCount(2);
      await expect(page.getByTestId("play-word")).toBeEnabled();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`theme-${theme}-${width}x${height}.png`),
        fullPage: true,
      });
      const reservedSpace = page.locator(".facetime-space");
      const reservedBefore = await reservedSpace.boundingBox();
      expect(reservedBefore).not.toBeNull();
      await expect(reservedSpace).toHaveText("");
      expect(reservedBefore!.height).toBeCloseTo(93, 0);
      await page.getByTestId("recall-tiles").click();
      await expect(page.locator(".move-preview")).toHaveCount(0);
      await expect(page.locator(".rack-hint")).toHaveText(
        "Tap or drag a tile to begin.",
      );
      const reservedAfter = await reservedSpace.boundingBox();
      expect(reservedAfter!.width).toBeCloseTo(reservedBefore!.width, 0);
      expect(reservedAfter!.height).toBeCloseTo(reservedBefore!.height, 0);
      await page.screenshot({
        path: info.outputPath(`declutter-rest-${theme}-${width}x${height}.png`),
        fullPage: true,
      });
      for (const [letter, col] of [
        ["A", 1],
        ["T", 2],
      ] as const) {
        await rack(page, letter).tap();
        await expect(page.locator(".rack-hint")).toContainText("empty square");
        await cell(page, 0, col).tap();
      }
      await expect(page.locator(".move-preview")).toBeVisible();
      await expect(page.getByTestId("play-word")).toBeEnabled();
    }
  }
  expect(surfaces.size).toBe(themes.length);
  await chooseTheme(page, "midnight");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
  await expect(page.locator(".has-tentative")).toHaveCount(2);
  expect(
    await page.evaluate(() => localStorage.getItem("tea-tiles-theme")),
  ).toBe("midnight");
  const auntContext = await browser.newContext({
    baseURL: "http://127.0.0.1:5183",
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
  });
  try {
    const aunt = await auntContext.newPage();
    await aunt.goto("/");
    await aunt.getByTestId("setup-code").fill("peach");
    await aunt.getByTestId("enroll-submit").click();
    await expect(aunt.getByTestId("game-board")).toBeVisible({
      timeout: 45_000,
    });
    await expect(aunt.locator("html")).toHaveAttribute("data-theme", "linen");
    await chooseTheme(aunt, "forest");
    await aunt.reload();
    await expect(aunt.locator("html")).toHaveAttribute("data-theme", "forest");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "midnight",
    );
    await expect(page.locator(".has-tentative")).toHaveCount(2);
    await openTableAction(page, "new-game");
    await page.getByTestId("new-game-mode-turn-limit").check();
    const outgoing = page.getByTestId("new-game-popup");
    await expect(outgoing).toHaveCSS("opacity", "1");
    await expect(outgoing).toHaveCSS("transform", "none");
    await page.screenshot({
      path: info.outputPath("outgoing-game-mode-options.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Close dialog" }).click();
  } finally {
    await auntContext.close();
  }
});

test("fine-pointer hover stays steady and drag follows cursor for move, return, blank and cancellation", async ({
  browser,
}, info) => {
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    hasTouch: false,
  });
  const page = await context.newPage();
  try {
    await enroll(page);
    expect(
      await page.evaluate(
        () => matchMedia("(hover: hover) and (pointer: fine)").matches,
      ),
    ).toBe(true);
    const tile = rack(page, "M");
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await expect(tile).toHaveCSS("opacity", "1");
    await expect(tile).toHaveCSS("transform", "none");
    await expect(tile.locator("..")).toHaveCSS("transform", "none");
    const original = await tile.evaluate(
      (element) => getComputedStyle(element).boxShadow,
    );
    const box = (await tile.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 1);
    const samples = await tile.evaluate(async (element) => {
      const samples: { y: number; shadow: string }[] = [];
      for (let frame = 0; frame < 65; frame++) {
        await new Promise(requestAnimationFrame);
        if (frame > 25)
          samples.push({
            y: element.getBoundingClientRect().y,
            shadow: getComputedStyle(element).boxShadow,
          });
      }
      return samples;
    });
    expect(new Set(samples.map((sample) => sample.shadow)).size).toBe(1);
    expect(samples[0].shadow).not.toBe(original);
    expect(
      Math.max(...samples.map((sample) => sample.y)) -
        Math.min(...samples.map((sample) => sample.y)),
    ).toBeLessThan(0.5);
    await page.screenshot({
      path: info.outputPath("stationary-edge-hover.png"),
      fullPage: true,
    });

    await beginMouseDrag(page, tile, cell(page, 7, 7));
    await expect(cell(page, 7, 7)).not.toHaveClass(/has-tentative/);
    await page.screenshot({
      path: info.outputPath("board-sized-mouse-ghost.png"),
      fullPage: false,
    });
    await finishDrag(
      page,
      () => page.mouse.up(),
      cell(page, 7, 7),
      "settling",
      2,
    );
    await expect(cell(page, 7, 7)).toHaveClass(/has-tentative/);
    await expect(cell(page, 7, 7).locator(".board-tile")).toHaveCSS(
      "opacity",
      "1",
    );
    await dragMouse(page, cell(page, 7, 7), cell(page, 7, 8));
    await expect(cell(page, 7, 7)).not.toHaveClass(/has-tentative/);
    await expect(cell(page, 7, 8)).toContainText("M");
    await cell(page, 7, 8).click();
    await beginMouseDrag(page, cell(page, 7, 8), cell(page, 8, 8));
    await finishDrag(
      page,
      () => page.keyboard.press("Escape"),
      cell(page, 7, 8).locator(".board-tile"),
      "returning",
    );
    await page.mouse.up();
    await expect(cell(page, 7, 8)).toContainText("M");
    await expect(cell(page, 8, 8)).not.toHaveClass(/has-tentative/);
    await dragMouse(page, rack(page, "W"), cell(page, 7, 8), rack(page, "W"));
    await expect(cell(page, 7, 8)).toContainText("M");
    await expect(rack(page, "W")).toBeVisible();
    await dragMouse(page, rack(page, "W"), cell(page, 0, 0), rack(page, "W"));
    await expect(cell(page, 0, 0)).toContainText("R");
    await expect(rack(page, "W")).toBeVisible();
    await beginMouseDrag(page, rack(page, "W"), cell(page, 8, 8));
    await finishDrag(
      page,
      () => page.keyboard.press("Escape"),
      rack(page, "W"),
      "returning",
    );
    await page.mouse.up();
    await expect(cell(page, 8, 8)).not.toHaveClass(/has-tentative/);
    await expect(page.getByTestId("drag-ghost")).toBeHidden();
    await beginMouseDrag(page, cell(page, 7, 8), page.getByTestId("tile-rack"));
    await finishDrag(
      page,
      () => page.mouse.up(),
      rack(page, "M"),
      "settling",
      0,
      true,
    );
    await expect(cell(page, 7, 8)).not.toHaveClass(/has-tentative/);
    await expect(rack(page, "M")).toBeVisible();
    await beginMouseDrag(page, rack(page, "?"), cell(page, 7, 7));
    await page.mouse.up();
    await expect(page.getByTestId("drag-ghost")).toBeHidden();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(cell(page, 7, 7)).not.toHaveClass(/has-tentative/);
    await page.getByTestId("blank-Z").click();
    await expect(cell(page, 7, 7)).toContainText("Z");
    await expect(cell(page, 7, 7)).toHaveAttribute(
      "aria-label",
      /Z, 0 points, tentative/,
    );
    // New deliberate taps immediately after a drag must not become ghost clicks.
    await rack(page, "A").click();
    await cell(page, 7, 8).click();
    await expect(cell(page, 7, 8)).toContainText("A");
    await checkTypography(page);
  } finally {
    await context.close();
  }
});

async function touch(
  session: CDPSession,
  type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
  position?: { x: number; y: number },
) {
  await session.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: position
      ? [{ ...position, id: 1, radiusX: 1, radiusY: 1, force: 1 }]
      : [],
  });
}
test("touch drag follows finger, cancels safely, returns to rack and keeps tap placement", async ({
  page,
  context,
}, info) => {
  await enroll(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const session = await context.newCDPSession(page);
  const source = rack(page, "Q");
  const box = (await source.boundingBox())!;
  const start = { x: box.x + box.width * 0.25, y: box.y + box.height * 0.3 };
  const target = await point(cell(page, 7, 7));
  await touch(session, "touchStart", start);
  await touch(session, "touchMove", target);
  await expect(page.getByTestId("drag-ghost")).toBeVisible();
  const ghost = (await page.getByTestId("drag-ghost").boundingBox())!;
  const square = (await cell(page, 7, 7).boundingBox())!;
  expect(Math.abs(ghost.width - square.width * 1.1)).toBeLessThan(1);
  expect(ghost.width).toBeLessThan(box.width);
  expect(Math.abs(ghost.x + ghost.width / 2 - target.x)).toBeLessThan(2);
  expect(Math.abs(ghost.y + ghost.height - (target.y - 22))).toBeLessThan(2);
  const anchor = (await page.getByTestId("drag-anchor").boundingBox())!;
  expect(Math.abs(anchor.x + anchor.width / 2 - target.x)).toBeLessThan(2);
  expect(Math.abs(anchor.y + anchor.height / 2 - target.y)).toBeLessThan(2);
  await expect(cell(page, 7, 7).getByTestId("landing-preview")).toBeVisible();
  await expect(cell(page, 7, 7)).not.toHaveClass(/has-tentative/);
  await expect(page.getByTestId("drag-ghost")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.screenshot({
    path: info.outputPath("touch-ghost-and-landing-preview.png"),
    fullPage: false,
  });
  await touch(session, "touchCancel");
  await expect(page.getByTestId("drag-ghost")).toBeHidden();
  expect(await page.getByTestId("settling-ghost").count()).toBe(0);
  await expect(cell(page, 7, 7)).not.toHaveClass(/has-tentative/);
  // A real viewport change cancels; held-gesture evidence uses viewport-only
  // screenshots so capturing the gesture does not itself trigger cancellation.
  await touch(session, "touchStart", await point(source));
  await touch(session, "touchMove", await point(cell(page, 7, 7)));
  await expect(page.getByTestId("drag-ghost")).toBeVisible();
  await page.setViewportSize({ width: 1023, height: 768 });
  await expect(page.getByTestId("drag-ghost")).toBeHidden();
  await touch(session, "touchEnd");
  await expect(cell(page, 7, 7)).not.toHaveClass(/has-tentative/);
  await expect(source).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 768 });
  await touch(session, "touchStart", await point(source));
  await touch(session, "touchMove", target);
  await touch(session, "touchEnd");
  expect(await page.getByTestId("settling-ghost").count()).toBe(0);
  await expect(cell(page, 7, 7)).toContainText("Q");
  await expect(cell(page, 7, 7)).toHaveClass(/has-tentative/);
  await touch(session, "touchStart", await point(cell(page, 7, 7)));
  await touch(session, "touchMove", await point(page.getByTestId("tile-rack")));
  await touch(session, "touchEnd");
  await expect(cell(page, 7, 7)).not.toHaveClass(/has-tentative/);
  await expect(source).toBeVisible();
  await rack(page, "T").tap();
  await cell(page, 7, 7).tap();
  await expect(cell(page, 7, 7)).toContainText("T");
  await checkTypography(page);
});

test("explicit zoom keeps actions accessible, drag targets accurate and scroll steady without score bubbles", async ({
  page,
  context,
}, info) => {
  await enroll(page);
  // RAT touches the committed R. Preview only: no turn is sent.
  await rack(page, "A").tap();
  await cell(page, 0, 1).tap();
  await rack(page, "T").tap();
  await cell(page, 0, 2).tap();
  const bubble = page.getByTestId("tentative-score-bubble");
  await expect(bubble).toHaveCount(0);
  await expect(page.getByTestId("word-check")).toHaveAttribute(
    "data-state",
    "recognized",
  );
  await page.screenshot({
    path: info.outputPath("word-preview-top-edge.png"),
    fullPage: true,
  });
  await page.getByTestId("recall-tiles").click();

  // Word feedback remains outside the board at the opposite corner, too.
  const fixture = (await db.doc("games/ui-table").get()).data()!;
  const committed = fixture.board["0,0"];
  expectedBoardKeys = ["14,12"];
  await db
    .doc("games/ui-table")
    .update({ board: { "14,12": { ...committed, row: 14, col: 12 } } });
  await expect(cell(page, 14, 12)).toContainText("R");
  await rack(page, "A").tap();
  await cell(page, 14, 13).tap();
  await rack(page, "T").tap();
  await cell(page, 14, 14).tap();
  await expect(bubble).toHaveCount(0);
  await expect(page.getByTestId("word-check")).toHaveAttribute(
    "data-state",
    "recognized",
  );
  await page.screenshot({
    path: info.outputPath("word-preview-bottom-edge.png"),
    fullPage: true,
  });
  await page.getByTestId("recall-tiles").click();

  const normalWidth = (await cell(page, 7, 7).boundingBox())!.width;
  await enterHiddenZoom(page);
  await expect(page.getByTestId("whole-board")).toBeVisible();
  expect((await cell(page, 7, 7).boundingBox())!.width).toBeGreaterThan(
    normalWidth,
  );
  const viewport = page.getByTestId("board-viewport");
  const centered = await viewport.evaluate((element) => {
    const board = element
      .querySelector('[data-testid="game-board"]')!
      .getBoundingClientRect();
    const frame = element.getBoundingClientRect();
    return {
      available: element.clientWidth,
      width: board.width,
      difference:
        board.left -
        (frame.left +
          element.clientLeft +
          (element.clientWidth - board.width) / 2),
    };
  });
  expect(centered.available).toBeGreaterThan(centered.width);
  expect(Math.abs(centered.difference)).toBeLessThan(2);
  await viewport.evaluate((element) => element.scrollTo({ top: 180, left: 0 }));
  for (const control of [
    page.getByTestId("tile-rack"),
    page.getByTestId("play-word"),
    page.getByTestId("recall-tiles"),
  ]) {
    const bounds = (await control.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(768);
  }
  const target = await point(cell(page, 7, 7));
  const scrollBefore = await viewport.evaluate((element) => ({
    x: element.scrollLeft,
    y: element.scrollTop,
  }));
  const documentBefore = await page.evaluate(() => ({
    x: scrollX,
    y: scrollY,
  }));
  const session = await context.newCDPSession(page);
  await touch(session, "touchStart", await point(rack(page, "W")));
  await touch(session, "touchMove", target);
  await expect(cell(page, 7, 7).getByTestId("landing-preview")).toBeVisible();
  await expect(cell(page, 7, 7)).not.toHaveClass(/has-tentative/);
  const ghost = (await page.getByTestId("drag-ghost").boundingBox())!;
  expect(
    Math.abs(ghost.width - (await cell(page, 7, 7).boundingBox())!.width * 1.1),
  ).toBeLessThan(1);
  await page.mouse.move(target.x, target.y);
  await page.mouse.wheel(0, 140);
  await expect
    .poll(() =>
      viewport.evaluate((element) => ({
        x: element.scrollLeft,
        y: element.scrollTop,
      })),
    )
    .toEqual(scrollBefore);
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(
    documentBefore,
  );
  await page.screenshot({
    path: info.outputPath("zoomed-touch-drag.png"),
    fullPage: false,
  });
  await finishDrag(
    page,
    () => touch(session, "touchEnd"),
    cell(page, 7, 7),
    "settling",
    2,
  );
  await expect(cell(page, 7, 7)).toContainText("W");
  await page.getByTestId("whole-board").click();
  await expect(page.getByTestId("zoom-board")).toBeHidden();
  await expect(cell(page, 7, 7)).toContainText("W");
  expect(
    Math.abs((await cell(page, 7, 7).boundingBox())!.width - normalWidth),
  ).toBeLessThan(1);
  await page.setViewportSize({ width: 820, height: 1180 });
  await enterHiddenZoom(page);
  await viewport.evaluate((element) =>
    element.scrollTo({ top: 100, left: 30 }),
  );
  for (const control of [
    page.getByTestId("tile-rack"),
    page.getByTestId("play-word"),
    page.getByTestId("recall-tiles"),
  ]) {
    const bounds = (await control.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(1180);
  }
  const boardSource = cell(page, 7, 7).locator(".board-tile");
  const sourcePoint = await point(boardSource);
  const portraitTarget = await point(cell(page, 7, 8));
  const portraitScroll = await viewport.evaluate((element) => ({
    x: element.scrollLeft,
    y: element.scrollTop,
  }));
  await touch(session, "touchStart", sourcePoint);
  await touch(session, "touchMove", portraitTarget);
  await expect(cell(page, 7, 8).getByTestId("landing-preview")).toBeVisible();
  expect(
    await viewport.evaluate((element) => ({
      x: element.scrollLeft,
      y: element.scrollTop,
    })),
  ).toEqual(portraitScroll);
  await page.screenshot({
    path: info.outputPath("zoomed-touch-drag-portrait.png"),
    fullPage: false,
  });
  await finishDrag(
    page,
    () => touch(session, "touchCancel"),
    boardSource,
    "returning",
  );
  await expect(cell(page, 7, 7)).toContainText("W");
  await expect(cell(page, 7, 8)).not.toHaveClass(/has-tentative/);
});

test("waiting player can reorder rack by touch and mouse, resume its order and insert a tile returned from the board", async ({
  page,
  context,
}, info) => {
  test.setTimeout(180_000);
  await writeFixture({ ...fixtureGame, turn: "aunt" });
  // Observe React commits without changing the app: pointer coordinates should
  // update the ghost directly while the insertion destination stays the same.
  await page.addInitScript(() => {
    const counts = { commits: 0 };
    const renderers = new Map();
    Object.defineProperty(window, "rackDragCommits", { value: counts });
    Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      value: {
        supportsFiber: true,
        renderers,
        inject(renderer: unknown) {
          const id = renderers.size + 1;
          renderers.set(id, renderer);
          return id;
        },
        onCommitFiberRoot() {
          counts.commits++;
        },
        onCommitFiberUnmount() {},
        onPostCommitFiberRoot() {},
      },
    });
  });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await enroll(page);
  await expect(page.getByTestId("turn-status")).toContainText(
    "Waiting for Rita",
  );
  await rack(page, "A").tap();
  await cell(page, 0, 1).tap();
  await rack(page, "T").tap();
  await cell(page, 0, 2).tap();
  await expect(page.getByTestId("word-check")).toHaveAttribute(
    "data-state",
    "recognized",
  );
  await page.getByTestId("recall-tiles").click();
  await expect(page.locator(".has-tentative")).toHaveCount(0);
  const ids = Object.fromEntries(
    tiles
      .filter((tile) => tile.letter !== "?")
      .map((tile) => [tile.letter, tile.id]),
  );
  const order = () =>
    page
      .getByTestId("tile-rack")
      .locator("[data-rack-tile-id]")
      .evaluateAll((slots) =>
        slots.map((slot) => slot.getAttribute("data-rack-tile-id")!),
      );
  const original = await order();
  const remoteBefore = (await db.doc("games/ui-table/racks/mom").get()).data();
  const session = await context.newCDPSession(page);
  const beforeM = (await rack(page, "M").boundingBox())!;
  let insertionPoint = {
    x: beforeM.x + beforeM.width / 2,
    y: beforeM.y + beforeM.height / 2,
  };
  await touch(session, "touchStart", await point(rack(page, "Q")));
  await touch(session, "touchMove", insertionPoint);
  await expect(page.getByTestId("drag-ghost")).toBeVisible();
  await expect(page.getByTestId("rack-insertion-preview")).toBeVisible();
  insertionPoint = await point(page.getByTestId("rack-insertion-preview"));
  await touch(session, "touchMove", insertionPoint);
  await expect(page.getByTestId("tile-rack")).toHaveAttribute(
    "data-rack-insertion-index",
    "0",
  );
  await expect
    .poll(async () => (await rack(page, "M").boundingBox())!.x - beforeM.x)
    .toBeGreaterThan(beforeM.width * 0.7);
  await expect(
    page.locator(".rack-insert-before, .rack-insert-after"),
  ).toHaveCount(0);
  expect(await order()).toEqual(original);
  await page.evaluate(async () => {
    for (let frame = 0; frame < 5; frame++)
      await new Promise(requestAnimationFrame);
  });
  const initialGhost = (await page.getByTestId("drag-ghost").boundingBox())!;
  const shiftedM = (await rack(page, "M").boundingBox())!;
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { rackDragCommits: { commits: number } })
          .rackDragCommits.commits,
    ),
  ).toBeGreaterThan(0);
  await page.evaluate(() => {
    (
      window as unknown as { rackDragCommits: { commits: number } }
    ).rackDragCommits.commits = 0;
  });
  for (let index = 1; index <= 8; index++) {
    await touch(session, "touchMove", {
      x: insertionPoint.x + index * 0.6,
      y: insertionPoint.y,
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const advancedGhost = (await page.getByTestId("drag-ghost").boundingBox())!;
  expect(advancedGhost.x - initialGhost.x).toBeGreaterThan(3);
  expect(
    Math.abs((await rack(page, "M").boundingBox())!.x - shiftedM.x),
  ).toBeLessThan(1);
  const stableTargetCommits = await page.evaluate(
    () =>
      (window as unknown as { rackDragCommits: { commits: number } })
        .rackDragCommits.commits,
  );
  expect(stableTargetCommits).toBe(0);
  await info.attach("drag-motion-profile", {
    body: JSON.stringify({
      pointerMoves: 8,
      reactCommits: stableTargetCommits,
      ghostAdvancePixels: advancedGhost.x - initialGhost.x,
    }),
    contentType: "application/json",
  });
  await page.screenshot({
    path: info.outputPath("waiting-rack-insertion.png"),
    fullPage: false,
  });
  await touch(session, "touchEnd");
  const touchedOrder = [ids.Q, ...original.filter((id) => id !== ids.Q)];
  await expect.poll(order).toEqual(touchedOrder);
  await expect(page.getByTestId("drag-ghost")).toBeHidden();

  await rack(page, "M").click({ trial: true });
  const mouseSource = await point(rack(page, "M"));
  const beforeW = (await rack(page, "W").boundingBox())!;
  const last = (await page
    .getByTestId("tile-rack")
    .locator(".rack-slot")
    .last()
    .boundingBox())!;
  await page.mouse.move(mouseSource.x, mouseSource.y);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, {
    steps: 8,
  });
  await expect
    .poll(async () => beforeW.x - (await rack(page, "W").boundingBox())!.x)
    .toBeGreaterThan(beforeW.width * 0.7);
  expect(await order()).toEqual(touchedOrder);
  const endGap = await point(page.getByTestId("rack-insertion-preview"));
  await page.mouse.move(endGap.x, endGap.y);
  await expect(page.getByTestId("tile-rack")).toHaveAttribute(
    "data-rack-insertion-index",
    "6",
  );
  await page.mouse.up();
  const mouseOrder = [...touchedOrder.filter((id) => id !== ids.M), ids.M];
  await expect.poll(order).toEqual(mouseOrder);
  await page.reload();
  await expect(page.getByTestId("tile-rack")).toBeVisible();
  await expect.poll(order).toEqual(mouseOrder);
  await rack(page, "Q").focus();
  await page.keyboard.press("Alt+ArrowLeft");
  expect(await order()).toEqual(mouseOrder); // The first tile stays at the boundary.
  await page.keyboard.press("Alt+ArrowRight");
  await expect.poll(order).toEqual([ids.W, ids.Q, ...mouseOrder.slice(2)]);
  await page.keyboard.press("Alt+ArrowLeft");
  await expect.poll(order).toEqual(mouseOrder);

  await rack(page, "W").tap();
  await cell(page, 7, 7).tap();
  await expect(cell(page, 7, 7)).toHaveClass(/has-tentative/);
  const boardStart = await point(cell(page, 7, 7));
  await touch(session, "touchStart", boardStart);
  await touch(session, "touchMove", { x: boardStart.x + 12, y: boardStart.y });
  await expect(page.getByTestId("rack-preview-gap")).toBeVisible();
  const beforeQ = (await page
    .locator(`[data-rack-tile-id="${ids.Q}"]`)
    .boundingBox())!;
  await touch(session, "touchMove", {
    x: beforeQ.x + beforeQ.width / 2,
    y: beforeQ.y + beforeQ.height / 2,
  });
  // Release immediately after movement, without waiting for the queued drag frame.
  await touch(session, "touchEnd");
  const returnedOrder = [ids.W, ...mouseOrder.filter((id) => id !== ids.W)];
  await expect.poll(order).toEqual(returnedOrder);
  await expect(cell(page, 7, 7)).not.toHaveClass(/has-tentative/);
  await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(7);
  await page.reload();
  await expect.poll(order).toEqual(returnedOrder);

  const savedOrder = () =>
    page.evaluate(() => {
      const key = Object.keys(localStorage).find((name) =>
        name.endsWith(":rack-order"),
      );
      return key ? (JSON.parse(localStorage.getItem(key)!) as string[]) : null;
    });
  const resetOrder = async () => {
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage))
        if (key.endsWith(":rack-order")) localStorage.removeItem(key);
    });
    await page.reload();
    await expect.poll(order).toEqual(original);
    await page.evaluate(() => document.fonts.ready);
    await expect
      .poll(() =>
        page
          .locator(".rack-tile")
          .evaluateAll((elements) =>
            elements.every(
              (element) =>
                getComputedStyle(element).opacity === "1" &&
                getComputedStyle(element).transform === "none",
            ),
          ),
      )
      .toBe(true);
  };
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Each finger/cursor targets the displayed vacancy, rather than the letter
  // that happened to occupy that area before neighbors moved. Both grab offsets
  // must use the pointer's position, independently of the lifted ghost.
  for (const scenario of [
    { pointer: "mouse", source: 6, grab: 0.15 },
    { pointer: "mouse", source: 0, grab: 0.85 },
    { pointer: "touch", source: 6, grab: 0.85 },
    { pointer: "touch", source: 0, grab: 0.15 },
  ] as const) {
    await resetOrder();
    const sourceId = original[scenario.source];
    const sourceBox = (await page
      .getByTestId(`rack-tile-${sourceId}`)
      .boundingBox())!;
    const slots = await page
      .getByTestId("tile-rack")
      .locator("[data-rack-tile-id]")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        }),
      );
    const move = async (position: { x: number; y: number }) => {
      if (scenario.pointer === "touch")
        await touch(session, "touchMove", position);
      else await page.mouse.move(position.x, position.y);
    };
    const start = {
      x: sourceBox.x + sourceBox.width * scenario.grab,
      y: sourceBox.y + sourceBox.height / 2,
    };
    if (scenario.pointer === "touch") await touch(session, "touchStart", start);
    else {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
    }
    const opposite = scenario.source === 0 ? 6 : 0;
    const neighborId = original[scenario.source === 0 ? 1 : 0];
    const neighbor = page.getByTestId(`rack-tile-${neighborId}`);
    const neighborStart = (await neighbor.boundingBox())!.x;
    await page.evaluate((id) => {
      const samples: number[] = [];
      Object.assign(window, { rackNeighborSamples: samples });
      let frames = 0;
      const record = () => {
        samples.push(
          document
            .querySelector(`[data-testid="rack-tile-${id}"]`)!
            .getBoundingClientRect().left,
        );
        if (++frames < 30) requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    }, neighborId);
    const storedBefore = await savedOrder();
    await move(slots[opposite]);
    await expect(page.getByTestId("tile-rack")).toHaveAttribute(
      "data-rack-insertion-index",
      String(opposite),
    );
    await expect(page.getByTestId("rack-insertion-preview")).toBeVisible();
    await expect
      .poll(async () =>
        Math.abs(
          (await point(page.getByTestId("rack-insertion-preview"))).x -
            slots[opposite].x,
        ),
      )
      .toBeLessThan(2);
    await expect
      .poll(async () =>
        Math.abs((await neighbor.boundingBox())!.x - neighborStart),
      )
      .toBeGreaterThan(sourceBox.width * 0.7);
    const neighborEnd = (await neighbor.boundingBox())!.x;
    const samples = await page.evaluate(
      () =>
        (window as unknown as { rackNeighborSamples: number[] })
          .rackNeighborSamples,
    );
    expect(
      samples.some(
        (x) =>
          x > Math.min(neighborStart, neighborEnd) + 1 &&
          x < Math.max(neighborStart, neighborEnd) - 1,
      ),
    ).toBe(true);
    if (scenario.pointer === "mouse" && scenario.source === 6)
      await page.screenshot({
        path: info.outputPath("mouse-last-to-first-visible-gap.png"),
        fullPage: false,
      });
    for (const destination of [opposite, scenario.source, 3]) {
      await move(slots[destination]);
      await expect(page.getByTestId("tile-rack")).toHaveAttribute(
        "data-rack-insertion-index",
        String(destination),
      );
      const gap = await point(page.getByTestId("rack-insertion-preview"));
      expect(Math.abs(gap.x - slots[destination].x)).toBeLessThan(2);
      for (let repetition = 0; repetition < 8; repetition++) {
        await move({ x: gap.x + (repetition % 2 ? 0.5 : -0.5), y: gap.y });
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      await expect(page.getByTestId("tile-rack")).toHaveAttribute(
        "data-rack-insertion-index",
        String(destination),
      );
      expect(await order()).toEqual(original);
      expect(await savedOrder()).toEqual(storedBefore);
    }
    if (scenario.pointer === "touch" && scenario.source === 0)
      await page.screenshot({
        path: info.outputPath("touch-first-to-middle-visible-gap.png"),
        fullPage: false,
      });
    const pitch = slots[4].x - slots[3].x;
    const midpoint = (slots[3].x + slots[4].x) / 2;
    const margin = Math.min(6, pitch * 0.12);
    for (const [x, expected] of [
      [midpoint + 1, 3],
      [midpoint + margin + 2, 4],
      [midpoint - 1, 4],
      [midpoint - margin - 2, 3],
    ]) {
      await move({ x, y: slots[3].y });
      await expect(page.getByTestId("tile-rack")).toHaveAttribute(
        "data-rack-insertion-index",
        String(expected),
      );
    }
    // Releasing inside the hysteresis band must use the vacancy still shown.
    await move({ x: midpoint + 1, y: slots[3].y });
    if (scenario.pointer === "touch") await touch(session, "touchEnd");
    else await page.mouse.up();
    const expected = original.filter((id) => id !== sourceId);
    expected.splice(3, 0, sourceId);
    await expect.poll(order).toEqual(expected);
    await expect.poll(savedOrder).toEqual(expected);
  }

  // Returning a board tile reserves its destination slot before hit testing.
  // Check differently compacted trays, including an empty hand and zoom.
  for (const visibleCount of [6, 3, 1, 0]) {
    if (await page.locator(".has-tentative").count()) {
      await expect(page.getByTestId("recall-tiles")).toBeEnabled();
      await page.getByTestId("recall-tiles").click();
      await expect(page.locator(".has-tentative")).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              JSON.parse(
                localStorage.getItem("tea-tiles-draft:ui-table:mom") || "{}",
              ).placements?.length,
          ),
        )
        .toBe(0);
    }
    await resetOrder();
    for (let index = 0; index < 7 - visibleCount; index++) {
      await page.getByTestId(`rack-tile-${original[index]}`).tap();
      await cell(page, 7, 7 + index).tap();
      if (tiles.find((tile) => tile.id === original[index])!.letter === "?") {
        await page.getByTestId("blank-Z").tap();
        await expect(page.getByRole("dialog")).toHaveCount(0);
      }
    }
    await expect(
      page.getByTestId("tile-rack").locator("[data-rack-tile-id]"),
    ).toHaveCount(visibleCount);
    if (visibleCount <= 1) await enterHiddenZoom(page);
    const boardTile = cell(page, 7, 7).locator(".board-tile");
    await boardTile.scrollIntoViewIfNeeded();
    const start = await point(boardTile);
    await touch(session, "touchStart", start);
    if (visibleCount === 0) {
      // Rapid release without an explicit animation-frame wait.
      await touch(
        session,
        "touchMove",
        await point(page.getByTestId("tile-rack")),
      );
      await touch(session, "touchEnd");
    } else {
      await touch(session, "touchMove", { x: start.x + 12, y: start.y });
      await expect(page.getByTestId("rack-preview-gap")).toBeVisible();
      const firstSlot = page
        .getByTestId("tile-rack")
        .locator("[data-rack-tile-id]")
        .first();
      await touch(session, "touchMove", await point(firstSlot));
      await expect(page.getByTestId("tile-rack")).toHaveAttribute(
        "data-rack-insertion-index",
        "0",
      );
      const gap = await point(page.getByTestId("rack-insertion-preview"));
      for (let repeat = 0; repeat < 8; repeat++)
        await touch(session, "touchMove", gap);
      await expect(page.getByTestId("tile-rack")).toHaveAttribute(
        "data-rack-insertion-index",
        "0",
      );
      if (visibleCount === 3)
        await page.screenshot({
          path: info.outputPath("board-to-compact-rack-visible-gap.png"),
          fullPage: false,
        });
      await touch(session, "touchEnd");
    }
    await expect
      .poll(order)
      .toEqual([original[0], ...original.slice(7 - visibleCount)]);
    await expect(cell(page, 7, 7)).not.toHaveClass(/has-tentative/);
    if (visibleCount <= 1) await page.getByTestId("whole-board").click();
  }
  await expect(page.getByTestId("recall-tiles")).toBeEnabled();
  await page.getByTestId("recall-tiles").click();
  for (const action of ["play-word", "pass-turn", "exchange-tiles"])
    await expect(page.getByTestId(action)).toBeDisabled();
  expect((await db.doc("games/ui-table/racks/mom").get()).data()).toEqual(
    remoteBefore,
  );
});

test("shuffle moves tiles through their actual rack positions, saves the settled order and respects reduced motion", async ({
  page,
}, info) => {
  await writeFixture({ ...fixtureGame, turn: "aunt" });
  await enroll(page);
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(async () =>
      page
        .locator(".rack-tile")
        .evaluateAll((elements) =>
          elements.every(
            (element) =>
              getComputedStyle(element).opacity === "1" &&
              getComputedStyle(element).transform === "none",
          ),
        ),
    )
    .toBe(true);
  const animateShuffle = async (randomValue: number, frames: number) =>
    page.evaluate(
      async ({ randomValue, frames }) => {
        Math.random = () => randomValue;
        const sample = () =>
          Array.from(
            document.querySelectorAll<HTMLElement>("[data-rack-tile-id]"),
          ).map((slot) => {
            const tile = slot.querySelector<HTMLElement>(".rack-tile")!;
            return {
              id: slot.dataset.rackTileId!,
              x: tile.getBoundingClientRect().x,
              transform: getComputedStyle(slot).transform,
              visualTransform: getComputedStyle(
                slot.querySelector(".rack-visual") || tile,
              ).transform,
            };
          });
        const before = sample(),
          path = [];
        (
          document.querySelector(
            '[data-testid="shuffle-rack"]',
          ) as HTMLButtonElement
        ).click();
        for (let frame = 0; frame < frames; frame++) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          path.push(sample());
        }
        return { before, path };
      },
      { randomValue, frames },
    );
  const shuffled = await animateShuffle(0, 64);
  const settled = shuffled.path.at(-1)!;
  const moved = settled.filter(
    (tile) =>
      Math.abs(tile.x - shuffled.before.find((old) => old.id === tile.id)!.x) >
      20,
  );
  expect(moved.length).toBeGreaterThan(0);
  expect(
    moved.some((tile) => {
      const start = shuffled.before.find((old) => old.id === tile.id)!.x;
      return shuffled.path.some((frame) => {
        const x = frame.find((item) => item.id === tile.id)!.x;
        return (
          x > Math.min(start, tile.x) + 2 && x < Math.max(start, tile.x) - 2
        );
      });
    }),
  ).toBe(true);
  const settledOrder = settled.map((tile) => tile.id);
  const readOrder = () =>
    page
      .locator("[data-rack-tile-id]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-rack-tile-id")),
      );
  const savedOrder = () =>
    page.evaluate(() =>
      JSON.parse(
        localStorage.getItem(
          Object.keys(localStorage).find((key) => key.endsWith(":rack-order"))!,
        ) || "[]",
      ),
    );
  expect(await savedOrder()).toEqual(settledOrder);
  await info.attach("shuffle-position-path", {
    body: JSON.stringify(shuffled),
    contentType: "application/json",
  });
  await page.screenshot({
    path: info.outputPath("shuffle-settled-waiting-hand.png"),
    fullPage: true,
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect.poll(readOrder).toEqual(settledOrder);
  await expect
    .poll(() =>
      page
        .locator(".rack-visual")
        .evaluateAll((elements) =>
          elements.every(
            (element) => getComputedStyle(element).transform === "none",
          ),
        ),
    )
    .toBe(true);
  const instant = await animateShuffle(0.999999, 2);
  expect(instant.path.at(-1)!.map((tile) => tile.id)).toEqual(
    tiles.map((tile) => tile.id),
  );
  expect(
    instant.path
      .at(-1)!
      .every(
        (tile) => tile.transform === "none" && tile.visualTransform === "none",
      ),
  ).toBe(true);
  expect(await savedOrder()).toEqual(tiles.map((tile) => tile.id));
  expect(
    (await db.doc("games/ui-table/racks/mom").get()).data()!.tiles,
  ).toEqual(tiles);
});

test("waiting player can prepare and reload a draft; opponent update preserves safe tiles and cancels active dragging", async ({
  page,
  context,
}, info) => {
  await writeFixture({ ...fixtureGame, turn: "aunt" });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await enroll(page);
  await expect(page.getByTestId("turn-status")).toContainText(
    "Waiting for Rita",
  );
  for (const action of ["play-word", "pass-turn", "exchange-tiles"])
    await expect(page.getByTestId(action)).toBeDisabled();
  await expect(rack(page, "A")).toBeEnabled();
  await expect(page.getByTestId("shuffle-rack")).toBeEnabled();
  await page.getByTestId("shuffle-rack").click();
  const rackIds = await page
    .getByTestId("tile-rack")
    .locator("button")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-testid")).sort(),
    );
  expect(rackIds).toEqual(tiles.map((tile) => `rack-tile-${tile.id}`).sort());
  await rack(page, "A").tap();
  await cell(page, 0, 1).tap();
  const session = await context.newCDPSession(page);
  await touch(session, "touchStart", await point(rack(page, "T")));
  await touch(session, "touchMove", await point(cell(page, 0, 2)));
  await expect(cell(page, 0, 2).getByTestId("landing-preview")).toBeVisible();
  await touch(session, "touchEnd");
  await expect(cell(page, 0, 2)).toHaveClass(/has-tentative/);
  await rack(page, "?").tap();
  await cell(page, 0, 3).tap();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByTestId("blank-Z").tap();
  await expect(cell(page, 0, 3)).toHaveAttribute(
    "aria-label",
    /Z, 0 points, tentative/,
  );
  await expect(page.getByTestId("recall-tiles")).toBeEnabled();
  await page.getByTestId("recall-tiles").click();
  await expect(page.locator(".has-tentative")).toHaveCount(0);
  await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(7);

  await rack(page, "A").tap();
  await cell(page, 0, 1).tap();
  await rack(page, "T").tap();
  await cell(page, 0, 2).tap();
  await expect(page.getByTestId("play-word")).toBeDisabled();
  await page.reload();
  await expect(page.getByTestId("turn-status")).toContainText(
    "Waiting for Rita",
  );
  await expect(cell(page, 0, 1)).toHaveClass(/has-tentative/);
  await expect(cell(page, 0, 2)).toHaveClass(/has-tentative/);
  await expect(page.getByTestId("play-word")).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("waiting-prepared-draft.png"),
    fullPage: true,
  });

  // An actual engine-generated opponent move is written only to this isolated fixture.
  // No player command is issued and no local draft is submitted.
  await touch(session, "touchStart", await point(rack(page, "W")));
  await touch(session, "touchMove", await point(cell(page, 0, 3)));
  await expect(page.getByTestId("drag-ghost")).toBeVisible();
  const opponentA = fixtureGame.racks.aunt.find((tile) => tile.letter === "A")!;
  const next = applyCommand(
    fixtureGame,
    "aunt",
    {
      id: "fixture-opponent-play",
      gameId: fixtureGame.id,
      expectedRevision: fixtureGame.revision,
      kind: "play",
      placements: [{ tileId: opponentA.id, row: 0, col: 1 }],
    },
    new Set(["RA"]),
    () => 0.42,
  );
  await writeFixture(next);
  await expect(page.getByTestId("turn-status")).toContainText("Your turn");
  await expect(page.getByTestId("drag-ghost")).toBeHidden();
  await touch(session, "touchEnd");
  await expect(cell(page, 0, 3)).not.toHaveClass(/has-tentative/);
  await expect(rack(page, "W")).toBeVisible();
  await expect(cell(page, 0, 1)).toHaveClass(/has-committed/);
  await expect(rack(page, "A")).toBeVisible();
  await expect(cell(page, 0, 2)).toHaveClass(/has-tentative/);
  await expect(page.locator(".has-tentative")).toHaveCount(1);
  await expect(page.getByTestId("play-word")).toBeEnabled();
  await expect(page.getByTestId("game-notice")).toContainText(
    /kept the tiles that still fit/,
  );
  await page.reload();
  await expect(cell(page, 0, 2)).toHaveClass(/has-tentative/);
  await expect(page.getByTestId("play-word")).toBeEnabled();
});

for (const kind of ["pass", "exchange"] as const) {
  test(`new waiting draft survives reload after historical own ${kind}`, async ({
    page,
  }) => {
    const next = applyCommand(
      fixtureGame,
      "mom",
      {
        id: `fixture-own-${kind}`,
        gameId: fixtureGame.id,
        expectedRevision: fixtureGame.revision,
        kind,
        ...(kind === "exchange" ? { tileIds: [tiles[0].id] } : {}),
      },
      new Set(),
      () => 0.42,
    );
    tiles = next.racks.mom;
    await writeFixture(next);
    await page.setViewportSize({ width: 1024, height: 900 });
    await enroll(page);
    await expect(page.getByTestId("turn-status")).toContainText(
      "Waiting for Rita",
    );
    await rack(page, "A").tap();
    await cell(page, 0, 1).tap();
    await rack(page, "T").tap();
    await cell(page, 0, 2).tap();
    await expect(page.locator(".has-tentative")).toHaveCount(2);
    await page.reload();
    await expect(cell(page, 0, 1)).toHaveClass(/has-tentative/);
    await expect(cell(page, 0, 2)).toHaveClass(/has-tentative/);
    await expect(page.locator(".has-tentative")).toHaveCount(2);
    await expect(page.getByTestId("play-word")).toBeDisabled();
    await expect(page.getByTestId("pass-turn")).toBeDisabled();
    await expect(page.getByTestId("exchange-tiles")).toBeDisabled();
    await expect(page.getByTestId("recall-tiles")).toBeEnabled();
  });
}

test("free draft placement permits diagonal and gapped tiles, repairs by repositioning and keeps compact rack returns safe", async ({
  page,
}, info) => {
  const bag = [...fixtureGame.bag];
  const board = Object.fromEntries(
    [..."CAT"].map((letter, index) => {
      const tile = bag.splice(
        bag.findIndex((candidate) => candidate.letter === letter),
        1,
      )[0];
      return [`7,${6 + index}`, { ...tile, row: 7, col: 6 + index }];
    }),
  );
  bag.push(
    ...Object.values(fixtureGame.board).map(
      ({ row: _row, col: _col, ...tile }) => tile,
    ),
  );
  await writeFixture({ ...fixtureGame, board, bag });
  await page.setViewportSize({ width: 1024, height: 900 });
  await enroll(page);
  await rack(page, "M").tap();
  await cell(page, 7, 5).tap();
  await expect(page.getByTestId("tile-rack").locator(".rack-slot")).toHaveCount(
    6,
  );
  await expect(page.locator(".rack-placeholder")).toHaveCount(0);
  await rack(page, "W").tap();
  const offAxis = await point(cell(page, 6, 4));
  await page.mouse.click(offAxis.x, offAxis.y);
  await expect(cell(page, 6, 4)).toHaveClass(/has-tentative/);
  await expect(page.locator(".board-tile.invalid-arrangement")).toHaveCount(2);
  await expect(page.getByTestId("game-board")).toHaveAttribute(
    "data-draft-error",
    "line",
  );
  await expect(page.getByTestId("play-word")).toBeDisabled();
  await expect(page.locator(".has-committed .invalid-arrangement")).toHaveCount(
    0,
  );
  await page.screenshot({
    path: info.outputPath("free-diagonal-draft.png"),
    fullPage: true,
  });
  await dragMouse(page, cell(page, 6, 4), cell(page, 7, 11));
  await expect(cell(page, 7, 11)).toHaveClass(/has-tentative/);
  await expect(page.getByTestId("game-board")).toHaveAttribute(
    "data-draft-error",
    "gap",
  );
  await expect(page.locator(".move-preview")).toBeVisible();
  await expect(page.getByTestId("draft-arrangement-error")).toBeVisible();
  await expect(page.locator(".board-tile.invalid-arrangement")).toHaveCount(2);
  await page.screenshot({
    path: info.outputPath("free-gapped-draft.png"),
    fullPage: true,
  });
  await dragMouse(page, cell(page, 7, 11), cell(page, 7, 9)); // CAT bridges the two new tiles.
  await expect(cell(page, 7, 9)).toHaveClass(/has-tentative/);
  await expect(page.locator(".board-tile.invalid-arrangement")).toHaveCount(0);
  await expect(page.getByTestId("tile-rack").locator(".rack-slot")).toHaveCount(
    5,
  );
  await rack(page, "Q").tap();
  await beginMouseDrag(page, rack(page, "Q"), cell(page, 7, 7));
  await expect(page.getByTestId("drag-ghost")).toHaveClass(/\binvalid-drop\b/);
  await finishDrag(page, () => page.mouse.up(), rack(page, "Q"), "returning");
  await expect(cell(page, 7, 7)).toHaveClass(/has-committed/);
  await expect(page.locator(".has-tentative")).toHaveCount(2);
  await page.screenshot({
    path: info.outputPath("free-placement-compact-hand.png"),
    fullPage: true,
  });
  await rack(page, "Q").tap();
  for (const [letter, col] of [
    ["Q", 4],
    ["A", 10],
    ["T", 3],
  ] as const) {
    await rack(page, letter).tap();
    await cell(page, 7, col).tap();
  }
  for (const [letter, col] of [
    ["N", 2],
    ["Z", 11],
  ] as const) {
    await rack(page, "?", letter === "N" ? 0 : 1).tap();
    await cell(page, 7, col).tap();
    await page.getByTestId(`blank-${letter}`).tap();
  }
  await expect(page.locator(".has-tentative")).toHaveCount(7);
  const hand = page.getByTestId("tile-rack");
  await expect(hand.locator(".rack-slot")).toHaveCount(0);
  await expect(hand).toHaveClass(/empty-rack/);
  await expect(page.getByTestId("shuffle-rack")).toBeDisabled();
  await expect(hand).toContainText("Return tiles here");
  await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("empty-hand-return-area.png"),
    fullPage: true,
  });
  const boardA = cell(page, 7, 10).locator(".board-tile");
  await beginMouseDrag(page, boardA, page.getByTestId("recall-tiles"));
  await expect(page.getByTestId("drag-ghost")).toHaveClass(/\binvalid-drop\b/);
  await finishDrag(page, () => page.mouse.up(), boardA, "returning");
  await expect(hand.locator(".rack-slot")).toHaveCount(0);
  await expect(cell(page, 7, 10)).toHaveClass(/has-tentative/);
  await beginMouseDrag(page, cell(page, 7, 10), hand);
  await finishDrag(
    page,
    () => page.mouse.up(),
    rack(page, "A"),
    "settling",
    0,
    true,
  );
  await expect(hand.locator(".rack-slot")).toHaveCount(1);
  await expect(rack(page, "A")).toBeVisible();
  await rack(page, "A").tap();
  await cell(page, 4, 10).tap();
  await expect(cell(page, 4, 10)).toHaveClass(/has-tentative/);
  await expect(page.locator(".board-tile.invalid-arrangement")).toHaveCount(7);
  await expect(page.getByTestId("play-word")).toBeDisabled();
  await cell(page, 4, 10).tap();
  await cell(page, 7, 10).tap(); // Repair the missing middle without Recall.
  await expect(page.locator(".board-tile.invalid-arrangement")).toHaveCount(0);
  await expect(hand.locator(".rack-slot")).toHaveCount(0);
  await page.getByTestId("recall-tiles").click();
  await expect(hand.locator(".rack-slot")).toHaveCount(7);
  await expect(page.locator(".has-tentative")).toHaveCount(0);
  await expect(page.locator(".move-preview")).toHaveCount(0);
});

test("a disconnected draft can be freely moved and ROAD is repaired across a committed A without Recall", async ({
  browser,
}, info) => {
  const pool = [
    ...fixtureGame.bag,
    ...fixtureGame.racks.mom,
    ...Object.values(fixtureGame.board).map(
      ({ row: _row, col: _col, ...tile }) => tile,
    ),
  ];
  const pick = (letter: string) =>
    pool.splice(
      pool.findIndex((tile) => tile.letter === letter),
      1,
    )[0];
  tiles = [..."DROMWT?"].map(pick);
  const a = pick("A");
  await writeFixture({
    ...fixtureGame,
    board: { "7,7": { ...a, row: 7, col: 7 } },
    racks: { ...fixtureGame.racks, mom: tiles },
    bag: pool,
  });
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:5183",
    viewport: { width: 1024, height: 900 },
    hasTouch: false,
  });
  const page = await context.newPage();
  try {
    await enroll(page);
    await rack(page, "D").click();
    await cell(page, 7, 8).click();
    await rack(page, "R").click();
    await cell(page, 2, 3).click(); // Disconnected placement is permitted.
    await expect(cell(page, 2, 3)).toHaveClass(/has-tentative/);
    await expect(page.locator(".invalid-arrangement")).toHaveCount(2);
    await expect(page.getByTestId("play-word")).toBeDisabled();
    await cell(page, 2, 3).click();
    await cell(page, 7, 5).click(); // Reposition R before filling the missing O.
    await expect(page.getByTestId("game-board")).toHaveAttribute(
      "data-draft-error",
      "gap",
    );
    for (const [row, col] of [
      [7, 5],
      [7, 8],
    ]) {
      await expect(cell(page, row, col)).toHaveAttribute(
        "aria-invalid",
        "true",
      );
      await expect(cell(page, row, col)).toHaveAttribute(
        "aria-describedby",
        "draft-arrangement-error",
      );
      await expect(cell(page, row, col).locator(".board-tile")).toHaveClass(
        /invalid-arrangement/,
      );
      const border = await cell(page, row, col)
        .locator(".board-tile")
        .evaluate((element) => ({
          color: getComputedStyle(element, "::after").borderColor,
          width: getComputedStyle(element, "::after").borderWidth,
        }));
      expect(border).toEqual({ color: "rgb(157, 61, 60)", width: "2px" });
    }
    await expect(cell(page, 7, 7).locator(".board-tile")).not.toHaveClass(
      /invalid-arrangement/,
    );
    await expect(cell(page, 7, 7)).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("draft-arrangement-error")).toBeVisible();
    const captureRoad = async (state: string) => {
      for (const theme of themes) {
        await page.getByTestId("help-settings").click();
        await page.getByTestId(`theme-${theme}`).check();
        await page.getByRole("button", { name: "Close dialog" }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        if (state === "red") {
          await expect(page.getByTestId("first-word-hint")).toHaveCount(0);
          await expect(page.getByTestId("draft-arrangement-error")).toHaveCount(
            1,
          );
          const hue = await page
            .getByTestId("draft-arrangement-error")
            .evaluate((element) =>
              getComputedStyle(element)
                .color.match(/[\d.]+/g)!
                .slice(0, 3)
                .map(Number),
            );
          expect(hue[0]).toBeGreaterThan(hue[1] * 1.1);
          expect(hue[0]).toBeGreaterThan(hue[2] * 1.05);
          await checkTextContrast(
            page,
            ".move-preview.invalid-preview strong, .move-preview.invalid-preview .arrangement-error",
          );
        }
        if (state === "red" && theme === "rose") {
          await cell(page, 7, 5).click();
          await expect(cell(page, 7, 5)).toHaveClass(/selected-square/);
          const selectedR = cell(page, 7, 5).locator(".board-tile");
          await selectedR.hover();
          expect(
            await page.evaluate(
              () => matchMedia("(hover: hover) and (pointer: fine)").matches,
            ),
          ).toBe(true);
          const borders = await selectedR.evaluate(async (element) => {
            const frames: { color: string; width: string }[] = [];
            for (let frame = 0; frame < 45; frame++) {
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
              const style = getComputedStyle(element, "::after");
              frames.push({
                color: style.borderColor,
                width: style.borderWidth,
              });
            }
            return frames;
          });
          expect(borders).toEqual(
            Array.from({ length: 45 }, () => ({
              color: borders[0].color,
              width: "2px",
            })),
          );
          const borderHue = borders[0].color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number);
          expect(borderHue[0]).toBeGreaterThan(borderHue[1] * 1.1);
          expect(borderHue[0]).toBeGreaterThan(borderHue[2] * 1.05);
          await page.screenshot({
            path: info.outputPath("road-gap-red-selected-hover-rose.png"),
            fullPage: true,
          });
        }
        await page.screenshot({
          path: info.outputPath(`road-gap-${state}-${theme}.png`),
          fullPage: true,
        });
      }
    };
    await captureRoad("red");
    await dragMouse(page, rack(page, "O"), cell(page, 7, 6));
    await expect(page.locator(".has-tentative")).toHaveCount(3);
    await expect(page.locator(".invalid-arrangement")).toHaveCount(0);
    await expect(page.getByTestId("draft-arrangement-error")).toHaveCount(0);
    await expect(page.getByTestId("word-check")).toHaveAttribute(
      "data-state",
      "recognized",
    );
    await expect(page.getByTestId("play-word")).toBeEnabled();
    await expect(cell(page, 7, 5)).toContainText("R");
    await expect(cell(page, 7, 6)).toContainText("O");
    await expect(cell(page, 7, 7)).toContainText("A");
    await expect(cell(page, 7, 8)).toContainText("D");
    await captureRoad("repaired");
    await page.reload();
    await expect(page.locator(".has-tentative")).toHaveCount(3);
    await expect(page.locator(".invalid-arrangement")).toHaveCount(0);
    await expect(page.getByTestId("play-word")).toBeEnabled();
    await page.getByTestId("recall-tiles").click();
    await expect(page.locator(".has-tentative")).toHaveCount(0);
    await expect(
      page.getByTestId("tile-rack").locator(".rack-slot"),
    ).toHaveCount(7);
  } finally {
    await context.close();
  }
});

test("live dictionary checks include unknown crosswords while waiting and preserve the prepared tiles", async ({
  page,
}, info) => {
  const q = tiles.find((tile) => tile.letter === "Q")!;
  const replacement = fixtureGame.bag[0];
  tiles = tiles.map((tile) => (tile.id === q.id ? replacement : tile));
  await writeFixture({
    ...fixtureGame,
    turn: "aunt",
    racks: { ...fixtureGame.racks, mom: tiles },
    bag: [
      ...fixtureGame.bag.slice(1),
      ...Object.values(fixtureGame.board).map(
        ({ row: _row, col: _col, ...tile }) => tile,
      ),
    ],
    board: { "6,7": { ...q, row: 6, col: 7 } },
  });
  await page.setViewportSize({ width: 1024, height: 900 });
  await enroll(page);
  await rack(page, "A").tap();
  await cell(page, 7, 7).tap();
  await rack(page, "T").tap();
  await cell(page, 7, 8).tap();
  await expect(page.getByTestId("word-check")).toHaveAttribute(
    "data-state",
    "unrecognized",
  );
  await expect(page.getByTestId("word-check")).toContainText("QA");
  await expect(page.getByTestId("word-check")).not.toContainText("AT");
  await expect(page.locator(".invalid-arrangement")).toHaveCount(0);
  await expect(page.getByTestId("play-word")).toBeDisabled();
  await expect(page.getByTestId("ask-about-word")).toBeEnabled();
  await page.getByTestId("ask-about-word").click();
  await expect(page.getByTestId("dictionary-popup").locator("li")).toHaveText([
    "QA",
  ]);
  await expect(page.getByTestId("dictionary-popup")).toHaveCSS("opacity", "1");
  await expect(page.getByTestId("dictionary-popup")).toHaveCSS(
    "transform",
    "none",
  );
  await expect(page.locator(".modal-backdrop")).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: info.outputPath("waiting-unknown-crossword.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await page.reload();
  await expect(cell(page, 7, 7)).toHaveClass(/has-tentative/);
  await expect(cell(page, 7, 8)).toHaveClass(/has-tentative/);
  await expect(page.getByTestId("word-check")).toHaveAttribute(
    "data-state",
    "unrecognized",
  );
  await expect(page.getByTestId("tentative-score-bubble")).toHaveCount(0);
});

test("private word consent survives reload and decline, requires the other player, and approval waits for manual play", async ({
  page,
  browser,
}, info) => {
  await writeFixture({
    ...fixtureGame,
    board: {},
    bag: [
      ...fixtureGame.bag,
      ...Object.values(fixtureGame.board).map(
        ({ row: _row, col: _col, ...tile }) => tile,
      ),
    ],
  });
  await db
    .doc(`setupCodes/${createHash("sha256").update("PEACH").digest("hex")}`)
    .set({
      slot: "aunt",
      consumedUid: null,
      expiresAt: Date.now() + 3_600_000,
    });
  await page.setViewportSize({ width: 1024, height: 900 });
  await enroll(page);
  const auntContext = await browser.newContext({
    baseURL: "http://127.0.0.1:5183",
    hasTouch: true,
    viewport: { width: 1024, height: 900 },
  });
  try {
    const aunt = await auntContext.newPage();
    await aunt.goto("/");
    await aunt.getByTestId("setup-code").fill("peach");
    await aunt.getByTestId("enroll-submit").click();
    await expect(aunt.getByTestId("game-board")).toBeVisible({
      timeout: 45_000,
    });
    await rack(page, "M").tap();
    await cell(page, 7, 7).tap();
    await rack(page, "W").tap();
    await cell(page, 7, 8).tap();
    await expect(page.getByTestId("word-check")).toHaveAttribute(
      "data-state",
      "unrecognized",
    );
    await expect(page.getByTestId("word-check")).toContainText("MW");
    await expect(page.locator(".invalid-arrangement")).toHaveCount(0);
    await page.getByTestId("play-word").click();
    await expect(page.getByTestId("dictionary-popup")).toBeVisible();
    await expect(page.getByTestId("request-word")).toHaveText(
      "Ask to add word",
    );
    await expect(page.locator(".has-tentative")).toHaveCount(2);
    await expect(page.getByTestId("dictionary-popup")).toHaveCSS(
      "opacity",
      "1",
    );
    await expect(page.getByTestId("dictionary-popup")).toHaveCSS(
      "transform",
      "none",
    );
    await expect(page.locator(".modal-backdrop")).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: info.outputPath("unknown-word-popup.png"),
      fullPage: true,
    });
    await page.getByTestId("request-word").click();
    const ownRequest = page.getByTestId("word-request-mom-MW");
    const otherRequest = aunt.getByTestId("word-request-mom-MW");
    const incoming = aunt.getByTestId("incoming-word-popup");
    await expect(ownRequest).toHaveClass(/pending/);
    await expect(incoming).toBeVisible();
    await expect(incoming).toHaveAccessibleName("Add MW to your dictionary?");
    await expect(aunt.getByTestId("incoming-approve-word-mom-MW")).toHaveCount(
      1,
    );
    await expect(aunt.getByTestId("incoming-decline-word-mom-MW")).toHaveCount(
      1,
    );
    await expect(aunt.getByTestId("approve-word-mom-MW")).toHaveCount(0);
    expect(
      await aunt.locator("[data-testid]").evaluateAll((elements) => {
        const ids = elements.map((element) =>
          element.getAttribute("data-testid"),
        );
        return ids.filter((id, index) => ids.indexOf(id) !== index);
      }),
    ).toEqual([]);
    await expect(
      incoming.getByTestId("incoming-approve-word-mom-MW"),
    ).toHaveText("Add word");
    await expect(
      incoming.getByTestId("incoming-decline-word-mom-MW"),
    ).toHaveText("Don’t add word");
    await expect(page.getByTestId("approve-word-mom-MW")).toHaveCount(0);
    await expect(page.getByTestId("decline-word-mom-MW")).toHaveCount(0);
    expect((await db.doc("games/ui-table").get()).data()?.revision).toBe(0);
    expect((await db.collection("games/ui-table/commands").get()).size).toBe(0);
    await expect(incoming).toHaveCSS("opacity", "1");
    await expect(incoming).toHaveCSS("transform", "none");
    await aunt.screenshot({
      path: info.outputPath("incoming-word-landscape.png"),
      fullPage: true,
    });
    await expectRequiredDecision(aunt, incoming);
    expect(
      (await db.doc("pairs/family/wordRequests/mom-MW").get()).data()!.status,
    ).toBe("pending");

    await page.reload();
    await aunt.reload();
    await expect(ownRequest).toHaveClass(/pending/);
    await expect(incoming).toBeVisible();
    await expect(page.locator(".has-tentative")).toHaveCount(2);
    await aunt.setViewportSize({ width: 820, height: 1180 });
    await expect(incoming).toHaveCSS("opacity", "1");
    await expect(incoming).toHaveCSS("transform", "none");
    await aunt.screenshot({
      path: info.outputPath("incoming-word-portrait.png"),
      fullPage: true,
    });
    let blockedAnswer = false;
    let oldDecline:
      | { url: string; headers: Record<string, string>; body: string }
      | undefined;
    const firstRequestedAt = (
      await db.doc("pairs/family/wordRequests/mom-MW").get()
    ).data()!.requestedAt;
    await aunt.route("**/respondToWord", async (route) => {
      if (route.request().method() === "POST") {
        const payload = route.request().postDataJSON();
        expect(payload.data.expectedRequestedAt).toBe(firstRequestedAt);
        oldDecline ??= {
          url: route.request().url(),
          headers: route.request().headers(),
          body: route.request().postData()!,
        };
      }
      if (!blockedAnswer && route.request().method() === "POST") {
        blockedAnswer = true;
        await route.abort("failed");
      } else await route.continue();
    });
    await incoming.getByTestId("incoming-decline-word-mom-MW").click();
    await expect.poll(() => blockedAnswer).toBe(true);
    await expect(
      incoming.getByTestId("modal-shared-action-pause"),
    ).toBeVisible();
    await expect(
      incoming.getByTestId("incoming-decline-word-mom-MW"),
    ).toBeDisabled();
    await expectRequiredDecision(aunt, incoming);
    expect(
      (await db.doc("pairs/family/wordRequests/mom-MW").get()).data()!.status,
    ).toBe("pending");
    await incoming.getByTestId("modal-resume-shared-actions").click();
    await expect(
      incoming.getByTestId("incoming-decline-word-mom-MW"),
    ).toBeEnabled();
    await incoming.getByTestId("incoming-decline-word-mom-MW").click();
    await expect(incoming).toBeHidden();
    await expect(ownRequest).toHaveClass(/declined/);
    await expect(page.locator(".has-tentative")).toHaveCount(2);
    await expect(page.getByTestId("word-check")).toHaveAttribute(
      "data-state",
      "unrecognized",
    );
    await ownRequest
      .getByRole("button", { name: "Ask to add again", exact: true })
      .click();
    await aunt.unroute("**/respondToWord");
    await expect(ownRequest).toHaveClass(/pending/);
    await expect
      .poll(
        async () =>
          (await db.doc("pairs/family/wordRequests/mom-MW").get()).data()!
            .requestedAt,
      )
      .toBeGreaterThan(firstRequestedAt);
    const renewed = (
      await db.doc("pairs/family/wordRequests/mom-MW").get()
    ).data()!;
    expect(renewed.requestedAt).toBeGreaterThan(firstRequestedAt);
    expect(oldDecline).toBeDefined();
    const staleReply = await aunt.request.post(oldDecline!.url, {
      headers: oldDecline!.headers,
      data: oldDecline!.body,
    });
    expect((await staleReply.json()).error.status).toBe("FAILED_PRECONDITION");
    expect(
      (await db.doc("pairs/family/wordRequests/mom-MW").get()).data(),
    ).toMatchObject({ status: "pending", requestedAt: renewed.requestedAt });
    expect((await db.doc("pairs/family/houseWords/MW").get()).exists).toBe(
      false,
    );
    let approvedCurrentGeneration = false;
    await aunt.route("**/respondToWord", async (route) => {
      if (
        route.request().method() === "POST" &&
        route.request().postDataJSON().data.requestId === "mom-MW"
      ) {
        expect(route.request().postDataJSON().data.expectedRequestedAt).toBe(
          renewed.requestedAt,
        );
        approvedCurrentGeneration = true;
      }
      await route.continue();
    });
    await expect(incoming).toBeVisible();
    await expect(
      incoming.getByTestId("incoming-approve-word-mom-MW"),
    ).toHaveCount(1);
    await expect(incoming).toHaveCSS("opacity", "1");
    await expect(incoming).toHaveCSS("transform", "none");
    await aunt.screenshot({
      path: info.outputPath("private-word-request.png"),
      fullPage: true,
    });
    await incoming.getByTestId("incoming-approve-word-mom-MW").click();
    await expect.poll(() => approvedCurrentGeneration).toBe(true);
    await expect(incoming).toBeHidden();
    await expect(ownRequest).toHaveClass(/accepted/);
    await expect(page.getByTestId("word-check")).toHaveAttribute(
      "data-state",
      "recognized",
    );
    await expect(page.locator(".has-tentative")).toHaveCount(2);
    expect((await db.doc("games/ui-table").get()).data()?.revision).toBe(0);
    expect((await db.collection("games/ui-table/commands").get()).size).toBe(0);
    await page.reload();
    await expect(page.getByTestId("word-check")).toHaveAttribute(
      "data-state",
      "recognized",
    );
    await expect(page.locator(".has-tentative")).toHaveCount(2);
    await page.screenshot({
      path: info.outputPath("approved-word-ready.png"),
      fullPage: true,
    });

    // A separate unresolved proposal must outlive the next turn, while both
    // accepted and declined feedback from this revision leave the board.
    await db.doc("pairs/family/wordRequests/mom-QZ").set({
      id: "mom-QZ",
      word: "QZ",
      requestedBy: "mom",
      status: "pending",
      requestedAt: Date.now() - 1000,
    });
    await expect(page.getByTestId("word-request-mom-QZ")).toHaveClass(
      /pending/,
    );
    await expect(incoming).toHaveAccessibleName("Add QZ to your dictionary?");
    await incoming.getByTestId("incoming-decline-word-mom-QZ").click();
    await expect(page.getByTestId("word-request-mom-QZ")).toHaveClass(
      /declined/,
    );
    await db.doc("pairs/family/wordRequests/mom-QMX").set({
      id: "mom-QMX",
      word: "QMX",
      requestedBy: "mom",
      status: "pending",
      requestedAt: Date.now(),
    });
    await expect(page.getByTestId("word-request-mom-QMX")).toHaveClass(
      /pending/,
    );
    await expect(incoming).toHaveAccessibleName("Add QMX to your dictionary?");

    expectedRevision = 1;
    expectedBoardKeys = ["7,7", "7,8"];
    expectedCommandCount = 1;
    await page.getByTestId("play-word").click();
    await expect(page.getByTestId("turn-status")).toContainText(
      "Waiting for Rita",
    );
    await expect(aunt.getByTestId("turn-status")).toContainText("Your turn");
    for (const view of [page, aunt]) {
      await expect(cell(view, 7, 7)).toContainText("M");
      await expect(cell(view, 7, 8)).toContainText("W");
      await expect(view.locator(".has-tentative")).toHaveCount(0);
      await expect(view.getByTestId("score-mom")).toContainText("14");
      await expect(view.getByTestId("word-request-mom-MW")).toHaveCount(0);
      await expect(view.getByTestId("word-request-mom-QZ")).toHaveCount(0);
    }
    await expect(page.getByTestId("word-request-mom-QMX")).toHaveClass(
      /pending/,
    );
    await expect(incoming).toHaveAccessibleName("Add QMX to your dictionary?");
    await expectRequiredDecision(aunt, incoming);
    await expect(otherRequest).toHaveCount(0);
    expect(
      (await db.doc("pairs/family/wordRequests/mom-QMX").get()).data()!.status,
    ).toBe("pending");
    await Promise.all([page.reload(), aunt.reload()]);
    await expect(page.getByTestId("word-request-mom-MW")).toHaveCount(0);
    await expect(page.getByTestId("word-request-mom-QZ")).toHaveCount(0);
    await expect(page.getByTestId("word-request-mom-QMX")).toHaveClass(
      /pending/,
    );
    await expect(incoming).toHaveAccessibleName("Add QMX to your dictionary?");
    expect((await db.doc("pairs/family/houseWords/MW").get()).exists).toBe(
      true,
    );
    await openTableAction(page, "review-words");
    await expect(page.getByTestId("review-word-request-mom-MW")).toHaveClass(
      /accepted/,
    );
    await expect(page.getByTestId("review-word-request-mom-QZ")).toHaveClass(
      /declined/,
    );
    await expect(page.locator(".shared-word-count").last()).toContainText(
      "1 shared word",
    );
    await expect(
      page.getByRole("dialog", { name: "Your shared dictionary" }),
    ).toHaveCSS("opacity", "1");
    await expect(
      page.getByRole("dialog", { name: "Your shared dictionary" }),
    ).toHaveCSS("transform", "none");
    await page.screenshot({
      path: info.outputPath("dictionary-history-after-turn.png"),
      fullPage: true,
    });
  } finally {
    await auntContext.close();
  }
});

for (const kind of ["pass", "exchange"] as const) {
  test(`own-turn ${kind} submits and recalls a draft; stale confirmation disables with a reason`, async ({
    page,
    context,
  }, info) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await enroll(page);
    const beforeRack = (await db.doc("games/ui-table/racks/mom").get()).data()!
      .tiles as Tile[];
    const beforeBag = (
      await db.doc("games/ui-table/private/state").get()
    ).data()!.bag as Tile[];
    const exchangedIds = ["M", "W"].map(
      (letter) => tiles.find((tile) => tile.letter === letter)!.id,
    );
    await rack(page, "A").tap();
    await cell(page, 0, 1).tap();
    await rack(page, "T").tap();
    await cell(page, 0, 2).tap();
    await expect(page.locator(".has-tentative")).toHaveCount(2);
    const open = page.getByTestId(
      kind === "pass" ? "pass-turn" : "exchange-tiles",
    );
    const confirm = page.getByTestId(
      kind === "pass" ? "confirm-pass" : "confirm-exchange",
    );
    const dialog = page.getByRole("dialog");
    const selectExchange = async () => {
      await expect(confirm).toBeDisabled();
      await dialog
        .getByRole("button", { name: "Exchange M", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "Exchange W", exact: true })
        .click();
      await expect(confirm).toContainText("2");
    };
    await open.click();
    if (kind === "exchange") await selectExchange();
    await expect(confirm).toBeEnabled();
    await context.setOffline(true);
    await expect(confirm).toBeDisabled();
    await expect(dialog.getByTestId("turn-action-reason")).toContainText(
      "Reconnect",
    );
    expect((await db.collection("games/ui-table/commands").get()).size).toBe(0);
    await context.setOffline(false);
    await expect(confirm).toBeEnabled();

    // An opponent update while the modal is open must make its action honest.
    await writeFixture({ ...fixtureGame, turn: "aunt", revision: 1 });
    await expect(confirm).toBeDisabled();
    await expect(dialog.getByTestId("turn-action-reason")).toBeVisible();
    await expect(dialog.getByTestId("turn-action-reason")).toContainText(
      /turn|Rita/i,
    );
    expect((await db.collection("games/ui-table/commands").get()).size).toBe(0);
    await dialog
      .getByRole("button", {
        name: kind === "pass" ? "Keep thinking" : "Keep my tiles",
        exact: true,
      })
      .click();
    await expect(dialog).toBeHidden();

    await writeFixture({ ...fixtureGame, turn: "mom", revision: 2 });
    await expect(open).toBeEnabled();
    await expect(page.locator(".has-tentative")).toHaveCount(2);
    await open.click();
    if (kind === "exchange") await selectExchange();
    await expect(confirm).toBeEnabled();
    await expect(dialog).toHaveCSS("opacity", "1");
    await expect(dialog).toHaveCSS("transform", "none");
    await page.screenshot({
      path: info.outputPath(`${kind}-confirmation.png`),
      fullPage: true,
    });
    expectedRevision = 3;
    expectedCommandCount = 1;
    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("turn-status")).toContainText(
      "Waiting for Rita",
    );
    await expect(page.locator(".has-tentative")).toHaveCount(0);
    await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(
      7,
    );
    const saved = (await db.doc("games/ui-table").get()).data()!;
    expect(saved).toMatchObject({
      revision: 3,
      turn: "aunt",
      scores: { mom: 0, aunt: 0 },
      scorelessTurns: 1,
      lastMove: { player: "mom", kind },
    });
    const afterRack = (await db.doc("games/ui-table/racks/mom").get()).data()!
      .tiles as Tile[];
    const afterBag = (
      await db.doc("games/ui-table/private/state").get()
    ).data()!.bag as Tile[];
    if (kind === "pass") {
      expect(afterRack).toEqual(beforeRack);
      expect(afterBag).toEqual(beforeBag);
    } else {
      expect(
        afterRack.filter((tile) => exchangedIds.includes(tile.id)),
      ).toEqual([]);
      expect(
        afterRack.filter(
          (tile) => !beforeRack.some((old) => old.id === tile.id),
        ),
      ).toHaveLength(2);
      expect(
        afterRack
          .filter((tile) => beforeRack.some((old) => old.id === tile.id))
          .map((tile) => tile.id)
          .sort(),
      ).toEqual(
        beforeRack
          .filter((tile) => !exchangedIds.includes(tile.id))
          .map((tile) => tile.id)
          .sort(),
      );
      expect(afterBag).toHaveLength(beforeBag.length);
      expect(
        afterBag.filter((tile) => exchangedIds.includes(tile.id)),
      ).toHaveLength(2);
    }
    await page.reload();
    await expect(page.getByTestId("turn-status")).toContainText(
      "Waiting for Rita",
    );
    await expect(page.getByTestId("pass-turn")).toBeDisabled();
    await expect(page.getByTestId("exchange-tiles")).toBeDisabled();
    await expect(page.getByTestId("turn-actions-note")).toBeVisible();
    await expect(page.getByTestId("turn-actions-note")).toContainText(
      /turn|Rita/i,
    );
    await expect(page.getByTestId("pass-turn")).toHaveAccessibleDescription(
      /turn|Rita/i,
    );
    await expect(
      page.getByTestId("exchange-tiles"),
    ).toHaveAccessibleDescription(/turn|Rita/i);
    const shuffle = page.getByTestId("shuffle-rack");
    await expect(shuffle).toBeEnabled();
    await expect(
      page.locator(".hand-row").getByTestId("shuffle-rack"),
    ).toHaveCount(1);
    expect(
      await shuffle.evaluate(
        (button) => button.closest('[data-drop-rack="true"]') === null,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`waiting-hand-after-${kind}.png`),
      fullPage: true,
    });
  });
}

for (const mode of ["turn-limit", "target-score"] as const) {
  test(`${mode} result explains the chosen ending and preserves final scores`, async ({
    page,
  }, info) => {
    const scores =
      mode === "target-score" ? { mom: 150, aunt: 124 } : { mom: 42, aunt: 17 };
    await writeFixture({
      ...fixtureGame,
      status: "finished",
      winner: "mom",
      scores,
      winCondition: mode,
      turnsPlayed: mode === "turn-limit" ? 20 : 5,
      endedReason: mode,
    });
    await enroll(page);
    await expect(page.getByTestId("game-result")).toContainText("Elizabeth");
    await expect(page.getByTestId("score-mom")).toHaveText(String(scores.mom));
    await expect(page.getByTestId("score-aunt")).toHaveText(
      String(scores.aunt),
    );
    await expect(page.getByTestId("game-ending-reason")).toContainText(
      mode === "turn-limit" ? /ten turns|20/i : /150/,
    );
    await expect(page.getByTestId("rematch")).toBeEnabled();
    await page.screenshot({
      path: info.outputPath(`ending-${mode}.png`),
      fullPage: true,
    });
    if (mode === "turn-limit") {
      for (const [index, theme] of themes.entries()) {
        await inspectFinishedBoard(page);
        await page.setViewportSize(
          index % 2
            ? { width: 820, height: 1180 }
            : { width: 1024, height: 900 },
        );
        await page.getByTestId("help-settings").click();
        await page.getByTestId(`theme-${theme}`).check();
        await page
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
        await page.getByTestId("view-result").click();
        const result = page.getByTestId("end-game-popup");
        await expect(result).toHaveCSS("opacity", "1");
        await expect(result).toHaveCSS("transform", "none");
        const rect = (await result.boundingBox())!;
        const viewport = page.viewportSize()!;
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height);
        await checkTextContrast(
          page,
          '[data-testid="end-game-popup"] h2, [data-testid="end-game-popup"] p, [data-testid="end-game-popup"] button',
        );
        await page.screenshot({
          path: info.outputPath(`end-result-${theme}.png`),
          fullPage: false,
        });
      }
    }
  });
}

test("six actual scoreless turns finish on both devices only after the final warned pass, deduct racks and remain final on reload", async ({
  page,
  browser,
}, info) => {
  await writeFixture({ ...fixtureGame, scores: { mom: 50, aunt: 40 } });
  const beforeRackMom = (await db.doc("games/ui-table/racks/mom").get()).data();
  const beforeRackAunt = (
    await db.doc("games/ui-table/racks/aunt").get()
  ).data();
  const beforeBag = (await db.doc("games/ui-table/private/state").get()).data();
  await page.setViewportSize({ width: 1024, height: 900 });
  await enroll(page);
  const { aunt, auntContext } = await joinRita(browser);
  try {
    for (let turn = 1; turn <= 6; turn++) {
      const actor = turn % 2 ? page : aunt;
      await expect(actor.getByTestId("pass-turn")).toBeEnabled();
      await actor.getByTestId("pass-turn").click();
      const dialog = actor.getByRole("dialog", { name: "Pass this turn?" });
      if (turn === 6) {
        await expect(dialog.getByTestId("pass-ending-warning")).toContainText(
          /six consecutive.*ends the game/i,
        );
        await expect(dialog.getByTestId("pass-ending-warning")).toContainText(
          /remaining tile values.*deducted/i,
        );
        await expect(dialog).not.toContainText(/can play next/i);
        await expect(dialog).toHaveCSS("opacity", "1");
        await actor.screenshot({
          path: info.outputPath("sixth-pass-warning-portrait.png"),
          fullPage: true,
        });
      } else
        await expect(dialog.getByTestId("pass-ending-warning")).toHaveCount(0);
      expectedRevision = expectedCommandCount = turn;
      await actor.getByTestId("confirm-pass").click();
      await expect(dialog).toHaveCount(0);
      await expect
        .poll(
          async () => (await db.doc("games/ui-table").get()).data()!.revision,
        )
        .toBe(turn);
      const current = (await db.doc("games/ui-table").get()).data()!;
      if (turn < 6) {
        expect(current).toMatchObject({
          status: "active",
          scorelessTurns: turn,
          scores: { mom: 50, aunt: 40 },
          winner: null,
        });
        expect(current.endedReason).toBeUndefined();
        for (const target of [page, aunt])
          await expect(target.getByTestId("game-result")).toHaveCount(0);
      }
    }
    const ended = (await db.doc("games/ui-table").get()).data()!;
    expect(ended).toMatchObject({
      status: "finished",
      revision: 6,
      scorelessTurns: 6,
      endedReason: "scoreless",
      scores: { mom: 31, aunt: 32 },
      winner: "aunt",
    });
    expect(ended.endedAt).toBe(ended.lastMove.at);
    expect(typeof ended.endedAt).toBe("number");
    for (const target of [page, aunt]) {
      await expect(target.getByTestId("end-game-popup")).toBeVisible();
      await expect(target.getByTestId("game-result")).toContainText("Rita");
      await expect(target.getByTestId("game-ending-reason")).toContainText(
        /six consecutive turns without points/i,
      );
      await expect(target.getByTestId("game-ending-reason")).toContainText(
        /deducted/i,
      );
      await expect(target.getByTestId("score-mom")).toHaveText("31");
      await expect(target.getByTestId("score-aunt")).toHaveText("32");
      for (const action of ["play-word", "pass-turn", "exchange-tiles"])
        await expect(
          target.locator(`button[data-testid="${action}"]:enabled`),
        ).toHaveCount(0);
      await expect(target.getByTestId("turn-announcement")).toHaveCount(0);
      await expect(target.getByTestId("rematch")).toBeEnabled();
      await expect(target.getByTestId("result-score-mom")).toHaveText("31");
      await expect(target.getByTestId("result-score-aunt")).toHaveText("32");
    }
    await aunt.screenshot({
      path: info.outputPath("scoreless-ending-portrait.png"),
      fullPage: true,
    });
    for (const target of [page, aunt]) {
      await target.reload();
      await expect(target.getByTestId("end-game-popup")).toBeVisible();
      await expect(target.getByTestId("game-result")).toContainText("Rita");
      await expect(target.getByTestId("turn-announcement")).toHaveCount(0);
    }
    expect((await db.doc("games/ui-table").get()).data()).toEqual(ended);
    expect((await db.doc("games/ui-table/racks/mom").get()).data()).toEqual(
      beforeRackMom,
    );
    expect((await db.doc("games/ui-table/racks/aunt").get()).data()).toEqual(
      beforeRackAunt,
    );
    expect((await db.doc("games/ui-table/private/state").get()).data()).toEqual(
      beforeBag,
    );
    expect((await db.collection("games/ui-table/commands").get()).size).toBe(6);
  } finally {
    await auntContext.close();
  }
});

test("actual last tile with an empty bag ends both devices, transfers leftover points and preserves the outcome through agreed new game", async ({
  page,
  browser,
}, info) => {
  const last = tiles.find((tile) => tile.letter === "T")!;
  const leftover = tiles.find((tile) => tile.letter === "Q")!;
  const anchor = tiles.find((tile) => tile.letter === "A")!;
  const pool = [
    ...fixtureGame.bag,
    ...fixtureGame.racks.mom,
    ...fixtureGame.racks.aunt,
    ...Object.values(fixtureGame.board),
  ];
  const remoteTiles = pool.filter(
    (tile) => ![last.id, leftover.id, anchor.id].includes(tile.id),
  );
  const board: Game["board"] = { "7,7": { ...anchor, row: 7, col: 7 } };
  // Keep all100 inventory tiles. Earlier board history occupies remote squares;
  // the final AT has no adjacent cross letters and is the only new word.
  for (const [index, tile] of remoteTiles.entries()) {
    const row = Math.floor(index / 15),
      col = index % 15;
    board[`${row},${col}`] = {
      ...tile,
      letter: tile.letter === "?" ? "Z" : tile.letter,
      row,
      col,
    };
  }
  await writeFixture({
    ...fixtureGame,
    board,
    bag: [],
    racks: { mom: [last], aunt: [leftover] },
    scores: { mom: 20, aunt: 25 },
  });
  tiles = [last];
  await page.setViewportSize({ width: 1024, height: 900 });
  await enroll(page, 1);
  const { aunt, auntContext } = await joinRita(browser, 1);
  try {
    await rack(page, "T").tap();
    await cell(page, 7, 8).tap();
    await expect(page.getByTestId("word-check")).toHaveAttribute(
      "data-state",
      "recognized",
    );
    await expect(page.getByTestId("play-word")).toBeEnabled();
    expectedRevision = expectedCommandCount = 1;
    expectedBoardKeys.push("7,8");
    await page.getByTestId("play-word").click();
    // The final accepted word gets its full visible moment before the result.
    await expect(page.getByTestId("move-celebration")).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("move-celebration")).toBeVisible();
    await expect(page.getByTestId("end-game-popup")).toHaveCount(0);
    for (const target of [page, aunt]) {
      await expect(target.getByTestId("end-game-popup")).toBeVisible();
      await expect(target.getByTestId("game-result")).toContainText(
        "Elizabeth",
      );
      await expect(target.getByTestId("game-ending-reason")).toContainText(
        "Elizabeth",
      );
      await expect(target.getByTestId("game-ending-reason")).toContainText(
        /bag.*empty|empty.*bag/i,
      );
      await expect(target.getByTestId("game-result")).not.toContainText(
        "All tiles played",
      );
      await expect(target.getByTestId("score-mom")).toHaveText("32");
      await expect(target.getByTestId("score-aunt")).toHaveText("15");
      await expect(target.getByTestId("result-score-mom")).toHaveText("32");
      await expect(target.getByTestId("result-score-aunt")).toHaveText("15");
      await expect(target.getByTestId("move-celebration")).toHaveCount(0);
      await expect(target.locator(".has-tentative")).toHaveCount(0);
      await expect(target.getByTestId("turn-announcement")).toHaveCount(0);
      for (const action of ["play-word", "pass-turn", "exchange-tiles"])
        await expect(
          target.locator(`button[data-testid="${action}"]:enabled`),
        ).toHaveCount(0);
    }
    await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(
      0,
    );
    await expect(aunt.getByTestId(`rack-tile-${leftover.id}`)).toBeVisible();
    const ended = (await db.doc("games/ui-table").get()).data()!;
    expect(ended).toMatchObject({
      status: "finished",
      revision: 1,
      endedReason: "rack-out",
      winner: "mom",
      scores: { mom: 32, aunt: 15 },
      rackCounts: { mom: 0, aunt: 1 },
      bagCount: 0,
      lastMove: { kind: "play", words: ["AT"], score: 2 },
    });
    expect(ended.endedAt).toBe(ended.lastMove.at);
    await page.screenshot({
      path: info.outputPath("rack-out-ending-landscape.png"),
      fullPage: true,
    });
    for (const target of [page, aunt]) {
      await target.reload();
      await expect(target.getByTestId("end-game-popup")).toBeVisible();
      await expect(target.getByTestId("game-result")).toContainText(
        "Elizabeth",
      );
      await expect(target.getByTestId("turn-announcement")).toHaveCount(0);
    }
    expect((await db.doc("games/ui-table").get()).data()).toEqual(ended);
    await inspectFinishedBoard(page);
    await expect(page.locator(".has-committed")).toHaveCount(99);
    await expect(page.getByTestId("rematch")).toHaveCount(0);
    await page.getByTestId("view-result").click();
    await expect(page.getByTestId("end-game-popup")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("end-game-popup")).toHaveCount(0);
    // A pending required decision takes precedence over the automatic result,
    // then the result resumes after that decision without changing scores.
    await db.doc("pairs/family/wordRequests/mom-MW").set({
      id: "mom-MW",
      word: "MW",
      requestedBy: "mom",
      status: "pending",
      requestedAt: Date.now(),
    });
    const wordDecision = aunt.getByTestId("incoming-word-popup");
    await expect(wordDecision).toBeVisible();
    await expect(aunt.getByTestId("end-game-popup")).toHaveCount(0);
    await expectRequiredDecision(aunt, wordDecision);
    await wordDecision.getByTestId("incoming-decline-word-mom-MW").click();
    await expect(wordDecision).toHaveCount(0);
    await expect(aunt.getByTestId("end-game-popup")).toBeVisible();
    expect((await db.doc("games/ui-table").get()).data()).toEqual(ended);
    await openTableAction(page, "rematch");
    await page.getByTestId("request-new-game").click();
    await expect(aunt.getByTestId("incoming-new-game-popup")).toBeVisible();
    await expect(aunt.getByTestId("end-game-popup")).toHaveCount(0);
    await expectRequiredDecision(
      aunt,
      aunt.getByTestId("incoming-new-game-popup"),
    );
    expect((await db.doc("pairs/family").get()).data()!.activeGameId).toBe(
      "ui-table",
    );
    expect((await db.doc("games/ui-table").get()).data()).toEqual(ended);
    await aunt.getByTestId("approve-new-game").click();
    await expect
      .poll(
        async () => (await db.doc("pairs/family").get()).data()!.activeGameId,
      )
      .not.toBe("ui-table");
    const newId = (await db.doc("pairs/family").get()).data()!.activeGameId;
    for (const target of [page, aunt]) {
      await expect(target.getByTestId("game-result")).toHaveCount(0);
      await expect(target.getByTestId("end-game-popup")).toHaveCount(0);
      await expect(target.locator(".has-committed")).toHaveCount(0);
      await expect(
        target.getByTestId("tile-rack").locator("button"),
      ).toHaveCount(7);
    }
    const archived = (await db.doc("games/ui-table").get()).data()!;
    for (const key of [
      "status",
      "revision",
      "scores",
      "winner",
      "endedReason",
      "endedAt",
      "board",
      "lastMove",
    ])
      expect(archived[key]).toEqual(ended[key]);
    expect(archived.replacedByGameId).toBe(newId);
    expect(
      (await db.doc("games/ui-table/racks/mom").get()).data()!.tiles,
    ).toEqual([]);
    expect(
      (await db.doc("games/ui-table/racks/aunt").get()).data()!.tiles,
    ).toEqual([leftover]);
    expect((await db.doc(`games/${newId}`).get()).data()).toMatchObject({
      status: "active",
      revision: 0,
      scores: { mom: 0, aunt: 0 },
      board: {},
    });
    expect((await db.collection("games/ui-table/commands").get()).size).toBe(1);
  } finally {
    await auntContext.close();
  }
});

test("timer switches from minutes to seconds and local debug celebrations never change the game", async ({
  page,
  browser,
}, info) => {
  const startedAt = Date.now();
  await writeFixture({
    ...fixtureGame,
    winCondition: "timed",
    durationMinutes: 25,
    startedAt,
    deadlineAt: startedAt + 25 * 60_000,
  });
  await enroll(page);
  await expect(page.getByTestId("game-timer")).toHaveText("25 minutes left");
  await db.doc("games/ui-table").update({ deadlineAt: Date.now() + 65_000 });
  await expect(page.getByTestId("game-timer")).toHaveText("2 minutes left");
  await db.doc("games/ui-table").update({ deadlineAt: Date.now() + 59_000 });
  await expect(page.getByTestId("game-timer")).toHaveText(/5\d seconds left/);
  await db
    .doc("games/ui-table")
    .update({ deadlineAt: Date.now() + 25 * 60_000 });
  await expect(page.getByTestId("game-timer")).toHaveText("25 minutes left");
  const authoritativeState = async () => ({
    game: (await db.doc("games/ui-table").get()).data(),
    mom: (await db.doc("games/ui-table/racks/mom").get()).data(),
    aunt: (await db.doc("games/ui-table/racks/aunt").get()).data(),
    bag: (await db.doc("games/ui-table/private/state").get()).data(),
    receipts: (await db.collection("games/ui-table/commands").get()).docs.map(
      (doc) => doc.data(),
    ),
  });
  const before = await authoritativeState();
  await page.getByTestId("help-settings").click();
  await expect(page.getByTestId("debug-enabled")).not.toBeChecked();
  await expect(page.getByTestId("debug-panel")).toHaveCount(0);
  await page.getByTestId("debug-enabled").check();
  for (const [band, score] of [
    ["low", 8],
    ["medium", 24],
    ["high", 48],
    ["bingo", 76],
  ] as const) {
    await page.getByTestId(`debug-celebration-${band}`).click();
    const preview = page.getByTestId("celebration-preview");
    await expect(preview).toHaveAttribute("data-band", band);
    await expect(preview).toHaveAttribute("data-debug", "true");
    await expect(preview).toContainText(`+${score}`);
    await expect(preview).toHaveCSS("opacity", "1");
    await expect(preview).toHaveCSS("transform", "none");
    if (band === "high" || band === "bingo") {
      const stars = preview.getByTestId("celebration-starburst");
      await expect(stars).toBeVisible();
      expect(await stars.locator("path").count()).toBeGreaterThan(0);
      expect(
        await stars.evaluate((element) =>
          parseFloat(getComputedStyle(element).animationDuration),
        ),
      ).toBeGreaterThan(0);
      await preview.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: info.outputPath(`debug-celebration-${band}.png`),
        fullPage: true,
      });
    } else
      await expect(preview.getByTestId("celebration-starburst")).toHaveCount(0);
    expect(await authoritativeState()).toEqual(before);
  }
  expect(
    await page.evaluate(() => localStorage.getItem("tea-tiles-debug")),
  ).toBe("true");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.reload();
  await page.getByTestId("help-settings").click();
  await expect(page.getByTestId("debug-enabled")).toBeChecked();
  const secondDevice = await browser.newContext({
    baseURL: "http://127.0.0.1:5183",
  });
  try {
    const other = await secondDevice.newPage();
    await other.goto("/");
    expect(
      await other.evaluate(() => localStorage.getItem("tea-tiles-debug")),
    ).not.toBe("true");
  } finally {
    await secondDevice.close();
  }
  await page.getByTestId("debug-enabled").uncheck();
  await expect(page.getByTestId("debug-panel")).toHaveCount(0);
  await expect(page.getByTestId("celebration-preview")).toHaveCount(0);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.reload();
  await page.getByTestId("help-settings").click();
  await expect(page.getByTestId("debug-enabled")).not.toBeChecked();
  expect(await authoritativeState()).toEqual(before);
});

test("a real high-scoring right-edge move keeps its celebration and stars inside the board", async ({
  page,
}, info) => {
  const pool = [
    ...fixtureGame.bag,
    ...fixtureGame.racks.mom,
    ...fixtureGame.racks.aunt,
    ...Object.values(fixtureGame.board).map(({ row, col, ...tile }) => tile),
  ];
  const take = (letter: string) =>
    pool.splice(
      pool.findIndex((tile) => tile.letter === letter),
      1,
    )[0];
  const committed = { ...take("Q"), row: 14, col: 9 };
  tiles = [..."UARTZME"].map(take);
  const aunt = [..."SENLADU"].map(take);
  await writeFixture({
    ...fixtureGame,
    board: { "14,9": committed },
    racks: { mom: tiles, aunt },
    bag: pool,
  });
  await enroll(page);
  for (const [index, letter] of [..."UARTZ"].entries()) {
    await rack(page, letter).tap();
    await cell(page, 14, 10 + index).tap();
  }
  await expect(page.getByTestId("word-check")).toHaveAttribute(
    "data-state",
    "recognized",
  );
  await expect(page.getByTestId("play-word")).toBeEnabled();
  expectedRevision = 1;
  expectedCommandCount = 1;
  expectedBoardKeys = [9, 10, 11, 12, 13, 14].map((col) => `14,${col}`);
  await page.getByTestId("play-word").click();
  const actual = page.getByTestId("move-celebration");
  await expect(actual).toBeVisible();
  await expect(actual).toHaveAttribute("data-band", "high");
  await expect(actual.getByTestId("celebration-starburst")).toBeVisible();
  await expect
    .poll(async () =>
      Number(
        await actual
          .locator("..")
          .evaluate((element) => getComputedStyle(element).opacity),
      ),
    )
    .toBeGreaterThan(0.8);
  const bounds = await actual.evaluate((element) => {
    const card = element.getBoundingClientRect();
    const stars = element.querySelector("svg")!.getBoundingClientRect();
    const board = document
      .querySelector('[data-testid="game-board"]')!
      .getBoundingClientRect();
    return {
      card: {
        left: card.left,
        right: card.right,
        top: card.top,
        bottom: card.bottom,
      },
      stars: {
        left: stars.left,
        right: stars.right,
        top: stars.top,
        bottom: stars.bottom,
      },
      board: {
        left: board.left,
        right: board.right,
        top: board.top,
        bottom: board.bottom,
      },
    };
  });
  for (const rect of [bounds.card, bounds.stars]) {
    expect(rect.left).toBeGreaterThanOrEqual(bounds.board.left);
    expect(rect.right).toBeLessThanOrEqual(bounds.board.right);
    expect(rect.top).toBeGreaterThanOrEqual(bounds.board.top);
    expect(rect.bottom).toBeLessThanOrEqual(bounds.board.bottom);
  }
  const game = (await db.doc("games/ui-table").get()).data()!;
  expect(game.lastMove.words).toEqual(["QUARTZ"]);
  expect(game.lastMove.score).toBeGreaterThanOrEqual(40);
  expect(game.scores.mom).toBe(game.lastMove.score);
  await page.screenshot({
    path: info.outputPath("actual-high-score-right-edge.png"),
    fullPage: true,
  });
});

test("timed game duration validates and its request dialog stays centered with reachable controls in every theme", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await enroll(page);
  let expectedDuration = "25";
  for (const theme of themes) {
    await page.getByTestId("help-settings").click();
    await page.getByTestId(`theme-${theme}`).check();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    for (const [width, height] of [
      [1024, 768],
      [820, 1180],
      [1024, 430],
    ]) {
      await page.setViewportSize({ width, height });
      await openTableAction(page, "new-game");
      await page.getByTestId("new-game-mode-timed").check();
      const duration = page.getByTestId("timed-duration");
      await expect(duration).toHaveValue(expectedDuration);
      await expect(duration).toHaveAttribute("min", "1");
      await expect(duration).toHaveAttribute("max", "1440");
      await expect(duration).toHaveAttribute("step", "1");
      if (theme === "linen" && width === 1024 && height === 768) {
        for (const invalid of ["", "0", "1.5", "1441"]) {
          await duration.fill(invalid);
          await expect(page.getByTestId("timed-duration-error")).toBeVisible();
          await expect(page.getByTestId("request-new-game")).toBeDisabled();
        }
        await duration.fill("17");
        expectedDuration = "17";
        await expect(page.getByTestId("timed-duration-error")).toHaveCount(0);
        await expect(page.getByTestId("request-new-game")).toBeEnabled();
      }
      const popup = page.getByTestId("new-game-popup");
      await expect(popup).toHaveCSS("opacity", "1");
      await expect(popup).toHaveCSS("transform", "none");
      await checkTextContrast(
        page,
        '[data-testid="new-game-popup"] .choice-card strong, [data-testid="new-game-popup"] .choice-card small, [data-testid="new-game-popup"] .new-game-warning, [data-testid="new-game-popup"] .timed-duration-field label, [data-testid="new-game-popup"] .primary-button:enabled',
      );
      const layout = await popup.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const content = element.querySelector(".modal-content")!;
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          middleX: rect.left + rect.width / 2,
          middleY: rect.top + rect.height / 2,
          scrolls: content.scrollHeight > content.clientHeight,
          overflow: getComputedStyle(content).overflowY,
          bodyLocked: getComputedStyle(document.body).overflow === "hidden",
        };
      });
      expect(Math.abs(layout.middleX - width / 2)).toBeLessThan(3);
      expect(Math.abs(layout.middleY - height / 2)).toBeLessThan(3);
      expect(layout.left).toBeGreaterThanOrEqual(0);
      expect(layout.right).toBeLessThanOrEqual(width);
      expect(layout.top).toBeGreaterThanOrEqual(0);
      expect(layout.bottom).toBeLessThanOrEqual(height);
      expect(layout.bodyLocked).toBe(true);
      if (height === 430) {
        expect(layout.scrolls).toBe(true);
        expect(["auto", "scroll"]).toContain(layout.overflow);
        await popup.locator(".modal-content").evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
      }
      const submit = page.getByTestId("request-new-game");
      const reachable = await submit.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.top >= 0 &&
          rect.bottom <= innerHeight &&
          document
            .elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            )
            ?.closest("button") === element
        );
      });
      expect(reachable).toBe(true);
      await page.screenshot({
        path: info.outputPath(`timed-dialog-${theme}-${width}x${height}.png`),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Close dialog" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
  }
  expect((await db.collection("pairs/family/gameRequests").get()).size).toBe(0);
});

test("agreed timed game counts down on both devices, expires once and prevents late turns without rack deductions", async ({
  page,
  browser,
}, info) => {
  const startedAt = Date.now();
  await writeFixture({
    ...fixtureGame,
    winCondition: "timed",
    durationMinutes: 25,
    startedAt,
    deadlineAt: startedAt + 25 * 60_000,
    scores: { mom: 42, aunt: 17 },
    lastMove: {
      id: "earlier-scoring-move",
      player: "mom",
      kind: "play",
      placements: [Object.values(fixtureGame.board)[0]],
      words: ["RAT"],
      score: 3,
      at: startedAt - 10_000,
    },
  });
  await db
    .doc(`setupCodes/${createHash("sha256").update("PEACH").digest("hex")}`)
    .set({
      slot: "aunt",
      consumedUid: null,
      expiresAt: Date.now() + 3_600_000,
    });
  await enroll(page);
  await rack(page, "A").tap();
  await cell(page, 0, 1).tap();
  await rack(page, "T").tap();
  await cell(page, 0, 2).tap();
  await expect(page.getByTestId("play-word")).toBeEnabled();
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:5183",
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
  });
  try {
    const aunt = await context.newPage();
    await aunt.goto("/");
    await aunt.getByTestId("setup-code").fill("peach");
    await aunt.getByTestId("enroll-submit").click();
    await expect(aunt.getByTestId("game-board")).toBeVisible();
    for (const view of [page, aunt]) {
      await expect(view.getByTestId("game-timer")).toBeVisible();
      await expect
        .poll(async () =>
          Number(
            await view
              .getByTestId("game-timer")
              .getAttribute("data-seconds-remaining"),
          ),
        )
        .toBeGreaterThan(1400);
    }
    const racksBefore = await Promise.all(
      ["mom", "aunt"].map(async (slot) =>
        (await db.doc(`games/ui-table/racks/${slot}`).get()).data(),
      ),
    );
    expectedRevision = 1;
    await expect(page.getByTestId("move-celebration")).toHaveCount(0);
    await db.doc("games/ui-table").update({ deadlineAt: Date.now() + 5000 });
    for (const view of [page, aunt]) {
      await expect(view.getByTestId("game-timer")).toHaveAttribute(
        "data-seconds-remaining",
        /^[1-5]$/,
      );
    }
    await page.screenshot({
      path: info.outputPath("timed-countdown-landscape.png"),
      fullPage: true,
    });
    await Promise.all(
      [page, aunt].map(async (view) => {
        await expect(view.getByTestId("game-result")).toBeVisible({
          timeout: 20_000,
        });
        await expect(view.getByTestId("game-ending-reason")).toContainText(
          "Time is up",
        );
        await expect(view.getByTestId("move-celebration")).toHaveCount(0);
        await expect(view.getByTestId("score-mom")).toHaveText("42");
        await expect(view.getByTestId("score-aunt")).toHaveText("17");
        await expect(view.locator(".has-tentative")).toHaveCount(0);
        await expect(
          view.getByTestId("tile-rack").locator(".rack-slot"),
        ).toHaveCount(7);
        await expect(
          view.locator(
            '[data-testid="play-word"]:enabled, [data-testid="pass-turn"]:enabled, [data-testid="exchange-tiles"]:enabled',
          ),
        ).toHaveCount(0);
      }),
    );
    const finished = (await db.doc("games/ui-table").get()).data()!;
    expect(finished).toMatchObject({
      status: "finished",
      revision: 1,
      winner: "mom",
      endedReason: "timed",
      scores: { mom: 42, aunt: 17 },
      lastMove: { id: "earlier-scoring-move", score: 3 },
    });
    expect(
      await Promise.all(
        ["mom", "aunt"].map(async (slot) =>
          (await db.doc(`games/ui-table/racks/${slot}`).get()).data(),
        ),
      ),
    ).toEqual(racksBefore);
    await aunt.screenshot({
      path: info.outputPath("timed-expired-portrait.png"),
      fullPage: true,
    });
    await page.screenshot({
      path: info.outputPath("timed-expired-landscape.png"),
      fullPage: true,
    });
    await Promise.all([page.reload(), aunt.reload()]);
    for (const view of [page, aunt])
      await expect(view.getByTestId("game-result")).toBeVisible();
    expect((await db.doc("games/ui-table").get()).data()).toEqual(finished);
    expect((await db.collection("games/ui-table/commands").get()).size).toBe(0);
  } finally {
    await context.close();
  }
});

for (const { status, mode, modeName } of [
  { status: "active", mode: "classic", modeName: "Classic" },
  { status: "active", mode: "turn-limit", modeName: "10 turns each" },
  { status: "active", mode: "timed", modeName: "17-minute game" },
  { status: "finished", mode: "target-score", modeName: "First to 150" },
] as const) {
  test(`${status} ${mode} game starts fresh only after the other player agrees; rejection, re-request and reload preserve history`, async ({
    page,
    browser,
  }, info) => {
    if (mode === "classic") {
      const {
        winCondition: _mode,
        turnsPlayed: _turns,
        ...legacyGame
      } = fixtureGame;
      await writeFixture(legacyGame);
    }
    if (status === "finished")
      await writeFixture({
        ...fixtureGame,
        status,
        winner: "mom",
        scores: { mom: 22, aunt: 17 },
        scorelessTurns: 6,
      });
    const houseWord = {
      word: "MW",
      requestedBy: "mom",
      approvedBy: "aunt",
      approvedAt: Date.now(),
    };
    await db.doc("pairs/family/houseWords/MW").set(houseWord);
    await db
      .doc(`setupCodes/${createHash("sha256").update("PEACH").digest("hex")}`)
      .set({
        slot: "aunt",
        consumedUid: null,
        expiresAt: Date.now() + 3_600_000,
      });
    const oldState = async () => ({
      game: (await db.doc("games/ui-table").get()).data(),
      mom: (await db.doc("games/ui-table/racks/mom").get()).data(),
      aunt: (await db.doc("games/ui-table/racks/aunt").get()).data(),
      bag: (await db.doc("games/ui-table/private/state").get()).data(),
    });
    const before = await oldState();
    const unchanged = async () => {
      expect(await oldState()).toEqual(before);
      expect((await db.doc("pairs/family").get()).data()!.activeGameId).toBe(
        "ui-table",
      );
      expect((await db.collection("games").get()).size).toBe(1);
    };
    await page.setViewportSize({ width: 1024, height: 900 });
    await enroll(page);
    if (status === "finished")
      await expect(page.getByTestId("end-game-popup")).toBeVisible();
    if (status === "active") {
      await rack(page, "A").tap();
      await cell(page, 0, 1).tap();
      await rack(page, "T").tap();
      await cell(page, 0, 2).tap();
    }
    const auntContext = await browser.newContext({
      baseURL: "http://127.0.0.1:5183",
      viewport: { width: 820, height: 1180 },
      hasTouch: true,
    });
    try {
      const aunt = await auntContext.newPage();
      await aunt.goto("/");
      await aunt.getByTestId("setup-code").fill("peach");
      await aunt.getByTestId("enroll-submit").click();
      await expect(aunt.getByTestId("game-board")).toBeVisible({
        timeout: 45_000,
      });
      if (mode === "timed") await enterHiddenZoom(aunt);
      const actionId = status === "active" ? "new-game" : "rematch";
      await openTableAction(page, actionId);
      await expect(page.getByTestId("new-game-popup")).toContainText(
        "Nothing changes until you both agree",
      );
      await expect(page.getByTestId("new-game-mode-classic")).toBeChecked();
      if (mode !== "classic")
        await page.getByTestId(`new-game-mode-${mode}`).check();
      if (mode === "timed") {
        await expect(page.getByTestId("timed-duration")).toHaveValue("25");
        await page.getByTestId("timed-duration").fill("17");
      }
      await page.getByTestId("request-new-game").click();
      await expect(page.getByTestId("new-game-status")).toContainText(
        "Waiting for Rita",
      );
      await expect(aunt.getByTestId("incoming-new-game-popup")).toBeVisible();
      await expectRequiredDecision(
        aunt,
        aunt.getByTestId("incoming-new-game-popup"),
      );
      await expect(aunt.getByTestId("incoming-game-mode")).toContainText(
        modeName,
      );
      await expect(page.getByTestId("approve-new-game")).toHaveCount(0);
      await unchanged();
      const firstId = (await db.doc("pairs/family").get()).data()!
        .pendingNewGameRequestId;
      if (mode === "timed") {
        expect(
          (await db.doc(`pairs/family/gameRequests/${firstId}`).get()).data(),
        ).toMatchObject({
          winCondition: "timed",
          durationMinutes: 17,
        });
        await expect(aunt.getByTestId("incoming-game-mode")).toContainText(
          "17",
        );
      }
      await Promise.all([page.reload(), aunt.reload()]);
      await expect(page.getByTestId("new-game-status")).toBeVisible();
      await expect(aunt.getByTestId("incoming-new-game-popup")).toBeVisible();
      if (mode === "timed") {
        await expect(aunt.getByTestId("incoming-game-mode")).toContainText(
          "17",
        );
        expect(
          (await db.doc(`pairs/family/gameRequests/${firstId}`).get()).data()!
            .durationMinutes,
        ).toBe(17);
      }
      if (status === "active")
        await expect(page.locator(".has-tentative")).toHaveCount(2);
      await aunt.getByTestId("decline-new-game").click();
      await expect(aunt.getByTestId("incoming-new-game-popup")).toBeHidden();
      await expect(page.getByTestId("help-settings")).toBeEnabled();
      await unchanged();
      expect(
        (await db.doc(`pairs/family/gameRequests/${firstId}`).get()).data()!
          .status,
      ).toBe("declined");
      if (status === "active")
        await expect(page.locator(".has-tentative")).toHaveCount(2);
      await openTableAction(page, actionId);
      if (mode !== "classic")
        await page.getByTestId(`new-game-mode-${mode}`).check();
      if (mode === "timed") await page.getByTestId("timed-duration").fill("17");
      await page.getByTestId("request-new-game").click();
      await expect(aunt.getByTestId("incoming-new-game-popup")).toBeVisible();
      const secondId = (await db.doc("pairs/family").get()).data()!
        .pendingNewGameRequestId;
      expect(secondId).not.toBe(firstId);
      expect(
        (await db.doc(`pairs/family/gameRequests/${secondId}`).get()).data()!
          .winCondition,
      ).toBe(mode);
      if (mode === "timed") {
        expect(
          (await db.doc(`pairs/family/gameRequests/${secondId}`).get()).data()!
            .durationMinutes,
        ).toBe(17);
        await expect(aunt.getByTestId("incoming-game-mode")).toContainText(
          "17",
        );
      }
      await expect(aunt.getByTestId("incoming-game-mode")).toContainText(
        modeName,
      );
      await unchanged();
      const incoming = aunt.getByTestId("incoming-new-game-popup");
      await expect(incoming).toHaveCSS("opacity", "1");
      await expect(incoming).toHaveCSS("transform", "none");
      await aunt.screenshot({
        path: info.outputPath(`new-game-${status}-${mode}-approval.png`),
        fullPage: true,
      });
      expectedRevision = status === "active" ? 1 : 0;
      let lostApprovalReply = false;
      if (status === "active")
        await aunt.route("**/respondToNewGame", async (route) => {
          if (route.request().method() !== "POST") {
            await route.continue();
            return;
          }
          // Commit through the real callable, then lose its reply only after
          // Firestore has delivered the new board to this recipient.
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          await expect(aunt.locator(".has-committed")).toHaveCount(0);
          await expect(
            aunt.getByTestId("incoming-new-game-popup"),
          ).toBeHidden();
          await route.abort("failed");
          lostApprovalReply = true;
        });
      await aunt.getByTestId("approve-new-game").click();
      await expect
        .poll(
          async () => (await db.doc("pairs/family").get()).data()!.activeGameId,
        )
        .not.toBe("ui-table");
      const newId = (await db.doc("pairs/family").get()).data()!.activeGameId;
      if (status === "active") {
        await expect.poll(() => lostApprovalReply).toBe(true);
        await expect(aunt.getByTestId("help-settings")).toBeEnabled();
        await expect(aunt.locator(".word-request-error")).toHaveCount(0);
        await expect(aunt.getByTestId("end-game-popup")).toHaveCount(0);
        // The canonical replacement already arrived, while losing its reply
        // still pauses future shared requests until the recipient opts in.
        await expect(aunt.getByTestId("resume-shared-actions")).toBeVisible();
        await aunt.getByTestId("resume-shared-actions").click();
      }
      if (mode === "timed") {
        await expect(aunt.locator(".zoomed")).toHaveCount(0);
        await expect(aunt.getByRole("dialog")).toHaveCount(0);
        await expect(aunt.locator("body")).not.toHaveCSS("overflow", "hidden");
        await expect(aunt.locator("body")).not.toHaveCSS("position", "fixed");
      }
      expect((await db.collection("games").get()).size).toBe(2);
      expect(
        (await db.doc(`pairs/family/gameRequests/${secondId}`).get()).data(),
      ).toMatchObject({
        status: "accepted",
        newGameId: newId,
        respondedBy: "aunt",
      });
      const archived = await oldState();
      expect(archived.mom).toEqual(before.mom);
      expect(archived.aunt).toEqual(before.aunt);
      expect(archived.bag).toEqual(before.bag);
      expect(archived.game).toMatchObject({
        board: before.game!.board,
        scores: before.game!.scores,
        winner: status === "finished" ? "mom" : null,
        revision: expectedRevision,
        replacedByGameId: newId,
      });
      expect((await db.doc(`games/${newId}`).get()).data()).toMatchObject({
        board: {},
        revision: 0,
        scores: { mom: 0, aunt: 0 },
        rackCounts: { mom: 7, aunt: 7 },
        status: "active",
        turn: "mom",
        winCondition: mode,
        turnsPlayed: 0,
      });
      if (mode === "timed") {
        const timedGame = (await db.doc(`games/${newId}`).get()).data()!;
        expect(timedGame.durationMinutes).toBe(17);
        expect(timedGame.deadlineAt - timedGame.startedAt).toBe(17 * 60_000);
        expect(timedGame.startedAt).toBeGreaterThan(Date.now() - 30_000);
      }
      await Promise.all([page.reload(), aunt.reload()]);
      for (const view of [page, aunt]) {
        await expect(view.getByTestId("game-board")).toBeVisible();
        await expect(
          view.locator(".has-committed, .has-tentative"),
        ).toHaveCount(0);
        await expect(
          view.getByTestId("tile-rack").locator("button"),
        ).toHaveCount(7);
        await expect(view.getByTestId("score-mom")).toHaveText("0");
        await expect(view.getByTestId("score-aunt")).toHaveText("0");
        if (mode === "classic")
          await expect(view.getByTestId("mode-progress")).toHaveCount(0);
        else
          await expect(view.getByTestId("mode-progress")).toContainText(
            mode === "timed" ? "Timed game" : modeName,
          );
        await openTableAction(view, "review-words");
        await expect(
          view.getByRole("list", { name: "Approved shared words" }),
        ).toContainText("MW");
        await view.getByRole("button", { name: "Close dialog" }).click();
      }
      await expect(page.getByTestId("turn-status")).toContainText("Your turn");
      await expect(aunt.getByTestId("turn-status")).toContainText(
        "Waiting for Elizabeth",
      );
      expect((await db.doc("pairs/family/houseWords/MW").get()).data()).toEqual(
        houseWord,
      );
      expect((await db.collection("games").get()).size).toBe(2);
    } finally {
      await auntContext.close();
    }
  });
}

test("two players get one nonblocking turn announcement per real change, with quiet edits, reduced motion and no stale finished queue", async ({
  page,
  browser,
}, info) => {
  type SeenTurn = {
    text: string;
    turn: string;
    gameId: string;
    at: number;
    endedAt?: number;
  };
  const observe = async (target: Page, theme: string) =>
    target.addInitScript((themeId) => {
      localStorage.setItem("tea-tiles-theme", themeId);
      const turns: SeenTurn[] = [];
      const overlaps: number[] = [];
      const celebrations: { firstAt: number; lastAt: number }[] = [];
      const sampledCelebrations = new WeakMap<
        Element,
        { firstAt: number; lastAt: number }
      >();
      Object.assign(window, {
        observedTurns: turns,
        turnCelebrationOverlaps: overlaps,
        observedCelebrations: celebrations,
      });
      let previous: Element | null = null;
      const observer = new MutationObserver(() => {
        const banner = document.querySelector(
          '[data-testid="turn-announcement"]',
        );
        if (banner !== previous) {
          if (previous && turns.length) turns.at(-1)!.endedAt = Date.now();
          if (banner)
            turns.push({
              text: banner.textContent!.trim(),
              turn: banner.getAttribute("data-turn")!,
              gameId: banner.getAttribute("data-game-id")!,
              at: Date.now(),
            });
          previous = banner;
        }
      });
      observer.observe(document, { childList: true, subtree: true });
      const effectiveOpacity = (element: Element | null) => {
        let opacity = element ? 1 : 0;
        for (let current = element; current; current = current.parentElement)
          opacity *= Number(getComputedStyle(current).opacity);
        return opacity;
      };
      const sample = () => {
        const celebration = document.querySelector(".floating-points");
        if (celebration && effectiveOpacity(celebration) > 0.05) {
          let observation = sampledCelebrations.get(celebration);
          if (!observation) {
            observation = { firstAt: Date.now(), lastAt: Date.now() };
            sampledCelebrations.set(celebration, observation);
            celebrations.push(observation);
          }
          observation.lastAt = Date.now();
        }
        if (
          effectiveOpacity(document.querySelector(".turn-announcement")) >
            0.05 &&
          effectiveOpacity(document.querySelector(".floating-points")) > 0.05
        )
          overlaps.push(Date.now());
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, theme);
  const turns = (target: Page) =>
    target.evaluate(
      () => (window as unknown as { observedTurns: SeenTurn[] }).observedTurns,
    );
  const banner = (target: Page) => target.getByTestId("turn-announcement");
  const assertBanner = async (
    target: Page,
    turn: "mom" | "aunt",
    gameId = "ui-table",
  ) => {
    await expect(banner(target)).toBeVisible();
    await expect(banner(target)).toHaveAttribute("data-turn", turn);
    await expect(banner(target)).toHaveAttribute("data-game-id", gameId);
    await expect(banner(target)).toContainText(
      turn === "mom" ? "Elizabeth’s turn" : "Rita’s turn",
    );
    await expect(banner(target)).toHaveAttribute("aria-live", "polite");
    await expect(banner(target)).toHaveCSS("pointer-events", "none");
    await expect(banner(target).locator(".turn-announcement")).toHaveCSS(
      "pointer-events",
      "none",
    );
  };
  const pass = async (target: Page) => {
    await target.getByTestId("pass-turn").click();
    await target.getByTestId("confirm-pass").click();
    await expect(target.getByRole("dialog")).toHaveCount(0);
  };
  await db
    .doc(`setupCodes/${createHash("sha256").update("PEACH").digest("hex")}`)
    .set({
      slot: "aunt",
      consumedUid: null,
      expiresAt: Date.now() + 3_600_000,
    });
  await page.setViewportSize({ width: 1024, height: 900 });
  await observe(page, "ink");
  await enroll(page);
  const auntContext = await browser.newContext({
    baseURL: "http://127.0.0.1:5183",
    hasTouch: true,
    viewport: { width: 820, height: 1180 },
    reducedMotion: "reduce",
  });
  try {
    const aunt = await auntContext.newPage();
    await observe(aunt, "coastal");
    await aunt.goto("/");
    await aunt.getByTestId("setup-code").fill("peach");
    await aunt.getByTestId("enroll-submit").click();
    await expect(aunt.getByTestId("game-board")).toBeVisible({
      timeout: 45_000,
    });
    for (const target of [page, aunt]) {
      await expect(banner(target)).toHaveCount(0);
      expect(await turns(target)).toMatchObject([
        { text: "Elizabeth’s turn", turn: "mom", gameId: "ui-table" },
      ]);
    }

    expectedRevision = expectedCommandCount = 1;
    await pass(page);
    await assertBanner(page, "aunt");
    await assertBanner(aunt, "aunt");
    await expect(aunt.locator(".turn-announcement")).toHaveCSS("opacity", "1");
    const reducedFrames = await aunt
      .locator(".turn-announcement")
      .evaluate(async (element) => {
        const rectangles = [];
        for (let frame = 0; frame < 8; frame++) {
          const rect = element.getBoundingClientRect();
          rectangles.push({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          });
          await new Promise(requestAnimationFrame);
        }
        return rectangles;
      });
    for (const key of ["x", "y", "width", "height"] as const)
      expect(
        Math.max(...reducedFrames.map((rect) => rect[key])) -
          Math.min(...reducedFrames.map((rect) => rect[key])),
      ).toBeLessThan(0.5);
    await aunt.screenshot({
      path: info.outputPath("turn-elizabeth-coastal-portrait-reduced.png"),
      fullPage: false,
    });
    // Tap a square underneath the visible central card while waiting.
    await rack(page, "A").tap();
    await cell(page, 7, 7).tap();
    await expect(cell(page, 7, 7)).toHaveClass(/has-tentative/);
    for (const target of [page, aunt]) {
      await expect(banner(target)).toHaveCount(0);
      expect((await turns(target)).map((entry) => entry.turn)).toEqual([
        "mom",
        "aunt",
      ]);
      const shown = (await turns(target))[1];
      expect(shown.endedAt! - shown.at).toBeGreaterThan(1900);
      expect(shown.endedAt! - shown.at).toBeLessThan(3300);
    }
    await db
      .doc("games/ui-table")
      .update({ announcementTestNote: "same-turn metadata" });
    await page.getByTestId("shuffle-rack").click();
    await page.waitForTimeout(700);
    for (const target of [page, aunt])
      expect((await turns(target)).length).toBe(2);

    await enterHiddenZoom(page);
    expectedRevision = expectedCommandCount = 2;
    await pass(aunt);
    await assertBanner(page, "mom");
    await assertBanner(aunt, "mom");
    await expect(page.locator(".turn-announcement")).toHaveCSS("opacity", "1");
    const card = (await page.locator(".turn-announcement").boundingBox())!;
    const board = (await page.locator(".board-frame").boundingBox())!;
    expect(
      Math.abs(card.x + card.width / 2 - board.x - board.width / 2),
    ).toBeLessThan(2);
    expect(
      Math.abs(card.y + card.height / 2 - board.y - board.height / 2),
    ).toBeLessThan(2);
    expect(
      await page.locator(".turn-announcement").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          document
            .elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            )
            ?.closest('[data-testid="turn-announcement"]') === null
        );
      }),
    ).toBe(true);
    await checkTextContrast(page, ".turn-announcement strong");
    await page.screenshot({
      path: info.outputPath("turn-rita-ink-landscape-zoom.png"),
      fullPage: false,
    });
    for (const target of [page, aunt])
      await expect(banner(target)).toHaveCount(0);
    await page.getByTestId("whole-board").click();
    await cell(page, 7, 7).tap();
    await cell(page, 0, 1).tap();
    await rack(page, "T").tap();
    await cell(page, 0, 2).tap();
    await expect(page.getByTestId("word-check")).toHaveAttribute(
      "data-state",
      "recognized",
    );
    expectedRevision = expectedCommandCount = 3;
    expectedBoardKeys = ["0,0", "0,1", "0,2"];
    await page.getByTestId("play-word").click();
    await expect(page.getByTestId("move-celebration")).toBeVisible();
    await page.getByTestId("help-settings").click();
    await expect(
      page.getByRole("dialog", { name: "Help & settings" }),
    ).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("move-celebration")).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await assertBanner(page, "aunt");
    await assertBanner(aunt, "aunt");
    for (const target of [page, aunt]) {
      await expect(banner(target)).toHaveCount(0);
      expect((await turns(target)).map((entry) => entry.turn)).toEqual([
        "mom",
        "aunt",
        "mom",
        "aunt",
      ]);
      expect(
        await target.evaluate(
          () =>
            (window as unknown as { turnCelebrationOverlaps: number[] })
              .turnCelebrationOverlaps,
        ),
      ).toEqual([]);
      const observed = await target.evaluate(
        () =>
          (
            window as unknown as {
              observedCelebrations: { firstAt: number; lastAt: number }[];
            }
          ).observedCelebrations,
      );
      expect(observed).toHaveLength(1);
      expect(observed[0].lastAt - observed[0].firstAt).toBeGreaterThan(1700);
    }

    // A turn received behind Help waits. Finishing the game clears that queue.
    await page.getByTestId("help-settings").click();
    await aunt.getByTestId("exchange-tiles").click();
    for (const letter of ["S", "N"])
      await aunt
        .getByRole("dialog")
        .getByRole("button", { name: `Exchange ${letter}`, exact: true })
        .click();
    expectedRevision = expectedCommandCount = 4;
    await aunt.getByTestId("confirm-exchange").click();
    await expect(page.getByTestId("turn-status")).toContainText("Your turn");
    await assertBanner(aunt, "mom");
    await expect(
      page.getByRole("dialog", { name: "Help & settings" }),
    ).toBeVisible();
    expect((await turns(page)).length).toBe(4);
    await expect(banner(page)).toHaveCount(0);
    expectedRevision = 5;
    await db.doc("games/ui-table").update({
      status: "finished",
      winner: "tie",
      endedReason: "passes",
      revision: 5,
    });
    await expect(aunt.getByTestId("game-result")).toBeVisible();
    await expect(banner(aunt)).toHaveCount(0);
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(page.getByTestId("end-game-popup")).toBeVisible();
    await inspectFinishedBoard(page);
    await page.waitForTimeout(300);
    expect((await turns(page)).length).toBe(4);
    await expect(banner(page)).toHaveCount(0);

    await openTableAction(page, "rematch");
    await page.getByTestId("request-new-game").click();
    await expect(aunt.getByTestId("incoming-new-game-popup")).toBeVisible();
    await aunt.getByTestId("approve-new-game").click();
    await expect
      .poll(
        async () => (await db.doc("pairs/family").get()).data()!.activeGameId,
      )
      .not.toBe("ui-table");
    const newId = (await db.doc("pairs/family").get()).data()!.activeGameId;
    await assertBanner(page, "mom", newId);
    await assertBanner(aunt, "mom", newId);
    for (const target of [page, aunt]) {
      await expect(banner(target)).toHaveCount(0);
      expect(
        (await turns(target)).filter((entry) => entry.gameId === newId),
      ).toHaveLength(1);
      await expect(target.locator(".has-committed")).toHaveCount(0);
    }
    expect((await db.doc(`games/${newId}`).get()).data()).toMatchObject({
      revision: 0,
      turn: "mom",
      status: "active",
      board: {},
    });
    expect((await db.collection(`games/${newId}/commands`).get()).size).toBe(0);
    await info.attach("observed-turns", {
      body: JSON.stringify({
        elizabeth: await turns(page),
        rita: await turns(aunt),
      }),
      contentType: "application/json",
    });
  } finally {
    await auntContext.close();
  }
});

test("shared-action pauses preserve consent and private drafts, respect cooldown and retry an uncertain turn exactly once", async ({
  page,
  browser,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await enroll(page);
  const { aunt, auntContext } = await joinRita(browser);
  try {
    // Create a real proposal and fail only the recipient's first HTTP reply.
    await rack(page, "M").tap();
    await cell(page, 0, 1).tap();
    await rack(page, "W").tap();
    await cell(page, 0, 2).tap();
    await expect(page.getByTestId("word-check")).toHaveAttribute(
      "data-state",
      "unrecognized",
    );
    await page.getByTestId("play-word").click();
    await page.getByTestId("request-word").click();
    const incoming = aunt.getByTestId("incoming-word-popup");
    await expect(incoming).toHaveAccessibleName("Add RMW to your dictionary?");
    let answerAttempts = 0;
    await aunt.route("**/respondToWord", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      answerAttempts++;
      if (answerAttempts === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({
            error: {
              status: "UNAVAILABLE",
              message: "The shared service is temporarily unavailable.",
            },
          }),
        });
      } else await route.continue();
    });
    const approve = incoming.getByTestId("incoming-approve-word-mom-RMW");
    await approve.click();
    await expect(
      incoming.getByTestId("modal-shared-action-pause"),
    ).toBeVisible();
    await expect(approve).toBeDisabled();
    await expect(
      incoming.getByTestId("incoming-decline-word-mom-RMW"),
    ).toBeDisabled();
    await expectRequiredDecision(aunt, incoming);
    await expect(incoming).toHaveCSS("opacity", "1");
    await aunt.screenshot({
      path: info.outputPath("required-consent-service-pause-portrait.png"),
      fullPage: true,
    });
    expect(
      (await db.doc("pairs/family/wordRequests/mom-RMW").get()).data()!.status,
    ).toBe("pending");
    expect((await db.doc("pairs/family/houseWords/RMW").get()).exists).toBe(
      false,
    );
    await incoming.getByTestId("modal-resume-shared-actions").click();
    await expect(approve).toBeEnabled();
    expect(answerAttempts).toBe(1); // Resume never makes the decision for her.
    expect(
      (await db.doc("pairs/family/wordRequests/mom-RMW").get()).data()!.status,
    ).toBe("pending");
    await approve.click();
    await expect(incoming).toBeHidden();
    expect((await db.doc("pairs/family/houseWords/RMW").get()).exists).toBe(
      true,
    );
    await page.getByTestId("recall-tiles").click();
    await expect(page.locator(".has-tentative")).toHaveCount(0);
    await rack(page, "A").tap();
    await cell(page, 0, 1).tap();
    await rack(page, "T").tap();
    await cell(page, 0, 2).tap();
    await expect(page.getByTestId("word-check")).toHaveAttribute(
      "data-state",
      "recognized",
    );
    const before = {
      game: (await db.doc("games/ui-table").get()).data(),
      rack: (await db.doc("games/ui-table/racks/mom").get()).data(),
      bag: (await db.doc("games/ui-table/private/state").get()).data(),
    };
    const unchanged = async () => {
      expect((await db.doc("games/ui-table").get()).data()).toEqual(
        before.game,
      );
      expect((await db.doc("games/ui-table/racks/mom").get()).data()).toEqual(
        before.rack,
      );
      expect(
        (await db.doc("games/ui-table/private/state").get()).data(),
      ).toEqual(before.bag);
      expect((await db.collection("games/ui-table/commands").get()).size).toBe(
        0,
      );
    };
    const attempts: string[] = [];
    await page.route("**/submitCommand", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts.push(route.request().postDataJSON().data.id);
      if (attempts.length <= 2) {
        const quota = attempts.length === 1;
        await route.fulfill({
          status: quota ? 429 : 503,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({
            error: {
              status: quota ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE",
              message: quota
                ? "Please let the table rest for a moment."
                : "The shared service is temporarily unavailable.",
              ...(quota
                ? { details: { rule: "rate-limit", retryAfterSeconds: 5 } }
                : {}),
            },
          }),
        });
      } else await route.continue();
    });
    await page.getByTestId("play-word").click();
    await expect(page.getByTestId("shared-action-pause")).toBeVisible();
    for (const id of ["play-word", "pass-turn", "exchange-tiles", "new-game"])
      await expect(page.getByTestId(id)).toBeDisabled();
    await expect(page.getByTestId("resume-shared-actions")).toHaveCount(0);
    await expect(page.getByTestId("retry-pending")).toHaveCount(0);
    await expect(page.getByTestId("recall-tiles")).toBeEnabled();
    await expect(rack(page, "Q")).toBeEnabled();
    await expect(page.locator(".has-tentative")).toHaveCount(2);
    await unchanged();
    await page.screenshot({
      path: info.outputPath("quota-pause-preserves-draft.png"),
      fullPage: true,
    });
    await expect(page.getByTestId("play-word")).toBeEnabled({
      timeout: 12_000,
    });
    expect(attempts).toHaveLength(1); // Expiration never auto-submits.
    await page.getByTestId("play-word").click();
    await expect(page.getByTestId("resume-shared-actions")).toBeVisible();
    await expect(page.getByTestId("retry-pending")).toBeDisabled();
    await expect(page.locator(".has-tentative")).toHaveCount(2);
    await unchanged();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).not.toBe(attempts[0]);
    await page.getByTestId("resume-shared-actions").click();
    await expect(page.getByTestId("retry-pending")).toBeEnabled();
    await unchanged();
    expect(attempts).toHaveLength(2);
    expectedRevision = expectedCommandCount = 1;
    expectedBoardKeys.push("0,1", "0,2");
    await page.getByTestId("retry-pending").click();
    await expect(page.getByTestId("turn-status")).toContainText(
      "Waiting for Rita",
    );
    expect(attempts).toEqual([attempts[0], attempts[1], attempts[1]]);
    const receipts = await db.collection("games/ui-table/commands").get();
    expect(receipts.docs.map((entry) => entry.id)).toEqual([attempts[1]]);
    expect(
      (await db.doc(`games/ui-table/commands/${attempts[0]}`).get()).exists,
    ).toBe(false);
    await expect(page.getByTestId("turn-announcement")).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("recovered-turn-elizabeth-rita.png"),
      fullPage: true,
    });
    await page.reload();
    await expect(page.getByTestId("turn-status")).toContainText(
      "Waiting for Rita",
    );
    expect((await db.doc("games/ui-table").get()).data()!.revision).toBe(1);
    expect((await db.collection("games/ui-table/commands").get()).size).toBe(1);
  } finally {
    await auntContext.close();
  }
});

test("new-game approval discards an old blank picker and a finished game closes its exchange selection", async ({
  page,
  browser,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await enroll(page);
  const { aunt, auntContext } = await joinRita(browser);
  try {
    // Propose first, leaving the other player free to agree while this player
    // is preparing a private blank. No turn is submitted in either game.
    await openTableAction(page, "new-game");
    await page.getByTestId("request-new-game").click();
    await expect(aunt.getByTestId("incoming-new-game-popup")).toBeVisible();
    await rack(page, "?").tap();
    await cell(page, 7, 7).tap();
    const blankDialog = page.getByRole("dialog", {
      name: "What shall this blank be?",
    });
    await expect(blankDialog).toBeVisible();
    expectedRevision = 1;
    await aunt.getByTestId("approve-new-game").click();
    await expect
      .poll(
        async () => (await db.doc("pairs/family").get()).data()!.activeGameId,
      )
      .not.toBe("ui-table");
    const newId = (await db.doc("pairs/family").get()).data()!.activeGameId;
    await expect(blankDialog).toHaveCount(0);
    await expect(page.locator(".has-committed, .has-tentative")).toHaveCount(0);
    await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(
      7,
    );
    await expect(
      page.getByTestId("tile-rack").locator('[aria-pressed="true"]'),
    ).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("new-game-clears-old-blank-picker.png"),
      fullPage: true,
    });
    await expect(page.getByTestId("exchange-tiles")).toBeEnabled();
    await page.getByTestId("exchange-tiles").click();
    const exchangeDialog = page.getByRole("dialog", {
      name: "A fresh handful of letters",
    });
    await expect(exchangeDialog).toBeVisible();
    await exchangeDialog.locator(".exchange-rack button").nth(0).click();
    await exchangeDialog.locator(".exchange-rack button").nth(1).click();
    await expect(page.getByTestId("confirm-exchange")).toBeEnabled();
    const beforeRack = (await db.doc(`games/${newId}/racks/mom`).get()).data();
    // A terminal listener update must also clear temporary modal state.
    await db.doc(`games/${newId}`).update({
      status: "finished",
      winner: null,
      scorelessTurns: 6,
      endedReason: "scoreless",
      endedAt: Date.now(),
      revision: 1,
    });
    await expect(page.getByTestId("game-result")).toBeVisible();
    await expect(exchangeDialog).toHaveCount(0);
    await expect(page.getByTestId("confirm-exchange")).toHaveCount(0);
    await expect(page.locator(".has-tentative")).toHaveCount(0);
    expect((await db.doc(`games/${newId}/racks/mom`).get()).data()).toEqual(
      beforeRack,
    );
    expect((await db.collection(`games/${newId}/commands`).get()).size).toBe(0);
    await page.screenshot({
      path: info.outputPath("finished-game-clears-exchange.png"),
      fullPage: true,
    });
    await page.reload();
    await expect(page.getByTestId("game-result")).toBeVisible();
    await expect(page.getByTestId("end-game-popup")).toBeVisible();
  } finally {
    await auntContext.close();
  }
});

test("a delayed old-turn reply cannot block or overwrite a fresh game's private draft", async ({
  page,
  browser,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await enroll(page);
  const { aunt, auntContext } = await joinRita(browser);
  let releaseReply!: () => void;
  const heldReply = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  let fetched = false;
  let released = false;
  await page.route("**/submitCommand", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    fetched = true;
    await heldReply;
    await route.fulfill({ response });
    released = true;
  });
  try {
    await openTableAction(page, "new-game");
    await page.getByTestId("request-new-game").click();
    await expect(aunt.getByTestId("incoming-new-game-popup")).toBeVisible();
    await rack(page, "A").tap();
    await cell(page, 0, 1).tap();
    await rack(page, "T").tap();
    await cell(page, 0, 2).tap();
    await expect(page.getByTestId("word-check")).toHaveAttribute(
      "data-state",
      "recognized",
    );
    await page.getByTestId("play-word").click();
    expectedRevision = 1;
    expectedCommandCount = 1;
    expectedBoardKeys.push("0,1", "0,2");
    await expect.poll(() => fetched).toBe(true);
    await expect
      .poll(async () => (await db.doc("games/ui-table").get()).data()!.revision)
      .toBe(1);
    expectedRevision = 2;
    await aunt.getByTestId("approve-new-game").click();
    await expect
      .poll(
        async () => (await db.doc("pairs/family").get()).data()!.activeGameId,
      )
      .not.toBe("ui-table");
    const newId = (await db.doc("pairs/family").get()).data()!.activeGameId;
    const freshRack = (await db.doc(`games/${newId}/racks/mom`).get()).data()!
      .tiles as Tile[];
    const nextTile = freshRack.find((tile) => tile.letter !== "?")!;
    await expect(page.locator(".has-committed, .has-tentative")).toHaveCount(0);
    await expect(page.getByTestId(`rack-tile-${nextTile.id}`)).toBeEnabled();
    await page.getByTestId(`rack-tile-${nextTile.id}`).tap();
    await cell(page, 7, 7).tap();
    await expect(page.locator(".has-tentative")).toHaveCount(1);
    const readDraft = () =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) || "{}"),
        `tea-tiles-draft:${newId}:mom`,
      );
    await expect
      .poll(async () => (await readDraft()).placements?.length)
      .toBe(1);
    const beforeReply = await readDraft();
    expect(beforeReply.revision).toBe(0);
    const browserReply = page.waitForResponse(
      (response) =>
        response.url().endsWith("/submitCommand") &&
        response.request().method() === "POST",
    );
    releaseReply();
    await expect.poll(() => released).toBe(true);
    await (await browserReply).finished();
    // Start after the browser receives the held response, then give its
    // callable continuation and React effects two presentation frames.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.locator(".has-tentative")).toHaveCount(1);
    expect(await readDraft()).toEqual(beforeReply);
    expect((await db.doc(`games/${newId}`).get()).data()).toMatchObject({
      revision: 0,
      board: {},
      scores: { mom: 0, aunt: 0 },
    });
    expect((await db.collection(`games/${newId}/commands`).get()).size).toBe(0);
    expect(
      (await db.doc(`games/${newId}/racks/mom`).get()).data()!.tiles,
    ).toEqual(freshRack);
    await page.screenshot({
      path: info.outputPath("fresh-draft-survives-old-reply.png"),
      fullPage: true,
    });
    await page.reload();
    await expect(page.locator(".has-tentative")).toHaveCount(1);
    expect(await readDraft()).toEqual(beforeReply);
  } finally {
    releaseReply();
    await auntContext.close();
    await page.unroute("**/submitCommand");
  }
});

test("private invitation prefills and scrubs its fragment, joins only explicitly, resumes identity and accepts legacy setup", async ({
  page,
  browser,
}, info) => {
  const formatted = "mApLe";
  await page.goto(`/#setup=${encodeURIComponent(formatted)}`);
  await expect(page.getByTestId("setup-code")).toHaveValue(formatted);
  await expect(page.getByTestId("setup-code")).toHaveAttribute(
    "placeholder",
    "e.g. maple",
  );
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  expect((await db.doc("players/mom").get()).data()?.uid).toBe(null);
  expect((await db.collection("bindings").get()).empty).toBe(true);
  await expect(page.locator(".welcome-tiles > .tile").last()).toHaveCSS(
    "opacity",
    "1",
  );
  await page.screenshot({
    path: info.outputPath("short-code-invitation.png"),
    fullPage: true,
  });
  await page.getByTestId("enroll-submit").click();
  await expect(page.getByTestId("game-board")).toBeVisible({ timeout: 45_000 });
  const uid = (await db.doc("players/mom").get()).data()?.uid;
  expect(typeof uid).toBe("string");
  await page.reload();
  await expect(page.getByTestId("game-board")).toBeVisible();
  await expect(page.getByTestId("setup-code")).toBeHidden();
  expect((await db.doc("players/mom").get()).data()?.uid).toBe(uid);
  const legacy = randomBytes(16).toString("hex").toUpperCase();
  await db
    .doc(`setupCodes/${createHash("sha256").update(legacy).digest("hex")}`)
    .set({
      slot: "aunt",
      consumedUid: null,
      expiresAt: Date.now() + 3_600_000,
    });
  const legacyContext = await browser.newContext();
  try {
    const aunt = await legacyContext.newPage();
    await aunt.goto("/");
    await aunt.getByTestId("setup-code").fill(legacy);
    await aunt.getByTestId("enroll-submit").click();
    await expect(aunt.getByTestId("game-board")).toBeVisible({
      timeout: 45_000,
    });
    await expect(aunt.getByTestId("turn-status")).toContainText(
      "Waiting for Elizabeth",
    );
  } finally {
    await legacyContext.close();
  }
});
