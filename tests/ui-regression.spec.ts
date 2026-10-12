import {
  test,
  expect,
  type Page,
  type Locator,
  type CDPSession,
  type Browser,
} from "@playwright/test";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createCredential } from "../functions/player-login";
import { debugEndingGame } from "../src/debugScenarios";
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
const packageInfo = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
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
  "blue-ink",
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
    "playerCredentials",
    "loginAttempts",
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

async function openInvitationForm(page: Page) {
  if (!(await page.getByTestId("setup-code").isVisible()))
    await page.getByTestId("welcome-join").click();
  await expect(page.getByTestId("setup-code")).toBeVisible();
}
async function enroll(page: Page, expectedRackCount = 7) {
  await page.goto("/");
  await openInvitationForm(page);
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
    await openInvitationForm(aunt);
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
async function authoritativeState() {
  const snapshots = await Promise.all([
    db.doc("games/ui-table").get(),
    db.doc("games/ui-table/racks/mom").get(),
    db.doc("games/ui-table/racks/aunt").get(),
    db.doc("games/ui-table/private/state").get(),
    db.collection("games/ui-table/commands").get(),
  ]);
  return snapshots.map((snapshot) =>
    "docs" in snapshot
      ? snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
      : snapshot.data(),
  );
}

async function expectControlInsideViewport(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  const box = (await control.boundingBox())!;
  const size = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(-0.5);
  expect(box.y).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height + 0.5);
}
const rack = (page: Page, letter: string, index = 0) =>
  page.getByTestId(
    `rack-tile-${tiles.filter((tile) => tile.letter === letter)[index].id}`,
  );
const cell = (page: Page, row: number, col: number) =>
  page.getByTestId(`board-cell-${row}-${col}`);

type ObservedScore = {
  phase: string;
  word: number;
  tile: number | null;
  score: number | null;
  at: number;
};
async function observeScoreSteps(page: Page) {
  await page.evaluate(() => {
    const records: {
      phase: string;
      word: number;
      tile: number | null;
      score: number | null;
      at: number;
    }[] = [];
    const overlaps: number[] = [];
    (
      window as unknown as { observedScoreSteps: typeof records }
    ).observedScoreSteps = records;
    (window as unknown as { scoreTurnOverlaps: number[] }).scoreTurnOverlaps =
      overlaps;
    let previous = "";
    const sample = () => {
      const score = document.querySelector<HTMLElement>(
        '[data-testid="move-celebration"] [data-testid="score-breakdown"]',
      );
      if (score) {
        const counter = score.querySelector('[data-testid="running-score"]');
        const record = {
          phase: score.dataset.scorePhase || "",
          word: Number(score.dataset.wordIndex || 0),
          tile:
            score.dataset.tileIndex === undefined
              ? null
              : Number(score.dataset.tileIndex),
          score: counter ? Number(counter.textContent) : null,
          at: performance.now(),
        };
        const key = `${record.phase}:${record.word}:${record.tile}:${record.score}`;
        if (key !== previous) {
          records.push(record);
          previous = key;
        }
        const visible = (element: Element) => {
          for (
            let node: Element | null = element;
            node;
            node = node.parentElement
          )
            if (Number(getComputedStyle(node).opacity) <= 0.05) return false;
          return true;
        };
        const announcement = document.querySelector(
          '[data-testid="turn-announcement"]',
        );
        if (announcement && visible(score) && visible(announcement))
          overlaps.push(performance.now());
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}
async function rememberScoreCard(scope: Locator, words: number, tiles: number) {
  const counts = await scope.evaluate((element) => {
    const selectors = [".scored-word", ".score-letter", ".score-equation"];
    const references = selectors.map((selector) => [
      ...element.querySelectorAll(selector),
    ]);
    const state = {
      references,
      selectors,
      replaced: false,
      observer: null as MutationObserver | null,
    };
    state.observer = new MutationObserver(() => {
      state.replaced ||= selectors.some((selector, index) => {
        const current = [...element.querySelectorAll(selector)];
        return (
          current.length !== references[index].length ||
          current.some((node, i) => node !== references[index][i])
        );
      });
    });
    state.observer.observe(element, { childList: true, subtree: true });
    (element as Element & { scoreIdentity: typeof state }).scoreIdentity =
      state;
    return references.map((nodes) => nodes.length);
  });
  expect(counts).toEqual([words, tiles, words]);
}
async function expectSameScoreCard(scope: Locator) {
  const stable = await scope.evaluate((element) => {
    const state = (
      element as Element & {
        scoreIdentity: {
          references: Element[][];
          selectors: string[];
          replaced: boolean;
        };
      }
    ).scoreIdentity;
    return (
      !!state &&
      !state.replaced &&
      state.selectors.every((selector, index) => {
        const current = [...element.querySelectorAll(selector)];
        return (
          current.length === state.references[index].length &&
          current.every(
            (node, i) =>
              node === state.references[index][i] && node.isConnected,
          )
        );
      })
    );
  });
  expect(stable).toBe(true);
}

const observedScores = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { observedScoreSteps: ObservedScore[] })
        .observedScoreSteps,
  );
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
  // The enlarged board can have cells larger than unchanged rack tiles.
  // The dragged tile is sized to its destination square.
  expect(Math.abs(ghost.width - square.width * 1.1)).toBeLessThan(1);
  expect(Math.abs(ghost.height - square.width * 1.1)).toBeLessThan(1);
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
    expect(
      await destination.evaluate((element) =>
        parseFloat(getComputedStyle(element).outlineWidth),
      ),
    ).toBeGreaterThanOrEqual(2);
    await expect(destination).toHaveCSS("outline-style", "solid");
    await expect(page.getByTestId("landing-preview")).toHaveCount(0);
    await expect(destination.locator(".board-tile")).toHaveCount(0);
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
  await expect(
    page.locator(".player-details small:not(.player-presence)"),
  ).toHaveCount(0);
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
    expect(board!.width).toBeGreaterThan(height - 140);
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
  await expect(page.getByTestId("app-version")).toContainText(
    `Version ${packageInfo.version} · local`,
  );
  await expect(page.getByTestId("build-time")).toHaveAttribute(
    "datetime",
    /^\d{4}-\d{2}-\d{2}T/,
  );
  await expect(page.getByTestId("build-time")).toHaveText(
    /\d{4}.*\d{1,2}:\d{2} [AP]M P[DS]T/,
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.setViewportSize({ width: 820, height: 1180 });
  await expect(page.locator(".brand")).toBeVisible();
});

test("tablet fit survives short browser toolbars and foreground restore while Help scrolls independently", async ({
  page,
}, info) => {
  await enroll(page);
  await expect(page.getByTestId("turn-announcement")).toBeHidden();
  await rack(page, "A").tap();
  await cell(page, 0, 1).tap();
  await rack(page, "T").tap();
  await cell(page, 0, 2).tap();
  await expect(page.getByTestId("word-check")).toHaveAttribute(
    "data-state",
    "recognized",
  );
  const before = await authoritativeState();
  const gestures = await page.getByTestId("game-board").evaluate((node) => {
    const first = new Touch({
      identifier: 1,
      target: node,
      clientX: 100,
      clientY: 100,
    });
    const second = new Touch({
      identifier: 2,
      target: node,
      clientX: 160,
      clientY: 100,
    });
    const pinch = new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [first, second],
    });
    node.dispatchEvent(pinch);
    const single = new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [first],
    });
    node.dispatchEvent(single);
    return { pinch: pinch.defaultPrevented, single: single.defaultPrevented };
  });
  expect(gestures).toEqual({ pinch: true, single: false });
  for (const [width, height] of [
    [820, 1180],
    [1024, 768],
    [1024, 720],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.locator(".tablet-viewport-fit")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => Math.abs(scrollY)))
      .toBeLessThan(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    for (const control of [
      page.getByTestId("game-board"),
      page.getByTestId("tile-rack"),
      page.getByTestId("play-word"),
      page.getByTestId("help-settings"),
    ])
      await expectControlInsideViewport(page, control);
    await page.screenshot({
      path: info.outputPath(`tablet-fit-${width}x${height}.png`),
      fullPage: false,
    });

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.setViewportSize({ width, height: height - 60 });
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pageshow"));
      window.dispatchEvent(new Event("focus"));
    });
    await expectControlInsideViewport(page, page.getByTestId("tile-rack"));
    await expectControlInsideViewport(page, page.getByTestId("play-word"));
    await expect(cell(page, 0, 1)).toHaveClass(/has-tentative/);
    await expect(cell(page, 0, 2)).toHaveClass(/has-tentative/);
  }
  await page.setViewportSize({ width: 1024, height: 720 });
  const panel = page.locator(".game-sidebar");
  await page.getByTestId("move-preview").evaluate((node) => {
    (node as HTMLElement).style.minHeight = "1100px";
  });
  await expect(page.locator("html")).toHaveClass(/tablet-page-fitted/);
  await expect(panel).toHaveCSS("overflow-y", "auto");
  expect(
    await panel.evaluate((node) => node.scrollHeight > node.clientHeight),
  ).toBe(true);
  await page.getByTestId("play-word").scrollIntoViewIfNeeded();
  await expectControlInsideViewport(page, page.getByTestId("play-word"));
  expect(await panel.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await expect(page.getByTestId("game-board")).toHaveCSS("user-select", "none");
  await page.getByTestId("move-preview").evaluate((node) => {
    (node as HTMLElement).style.removeProperty("min-height");
  });
  await page.setViewportSize({ width: 1024, height: 500 });
  await page.getByTestId("help-settings").click();
  const help = page.getByRole("dialog", { name: "Help & settings" });
  await expect(help).toHaveCSS("opacity", "1");
  await expectControlInsideViewport(page, help);
  const content = help.locator(".modal-content");
  expect(
    await content.evaluate((node) => node.scrollHeight > node.clientHeight),
  ).toBe(true);
  const background = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  await page.getByTestId("theme-midnight").scrollIntoViewIfNeeded();
  await expectControlInsideViewport(page, page.getByTestId("theme-midnight"));
  expect(await content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(
    background,
  );
  await expectControlInsideViewport(
    page,
    help.getByRole("button", { name: "Close dialog" }),
  );
  await page.screenshot({
    path: info.outputPath("tablet-short-viewport-help.png"),
    fullPage: false,
  });
  await help.getByRole("button", { name: "Close dialog" }).click();
  await page.setViewportSize({ width: 820, height: 1180 });
  await expectControlInsideViewport(page, page.getByTestId("play-word"));
  expect(await authoritativeState()).toEqual(before);
});

for (const offTurn of [false, true]) {
  test(`tap selected board tile then holder returns only that tile${offTurn ? " off turn" : ""}`, async ({
    page,
  }) => {
    if (offTurn) await db.doc("games/ui-table").update({ turn: "aunt" });
    await enroll(page);
    await expect(page.getByTestId("turn-announcement")).toBeHidden();
    const before = await authoritativeState();
    await rack(page, "A").tap();
    await cell(page, 0, 1).tap();
    await rack(page, "T").tap();
    await cell(page, 0, 2).tap();
    await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(
      5,
    );
    await cell(page, 0, 2).tap();
    await page.getByTestId("tile-rack").tap({ position: { x: 5, y: 5 } });
    await expect(cell(page, 0, 2)).not.toHaveClass(/has-tentative/);
    await expect(cell(page, 0, 1)).toHaveClass(/has-tentative/);
    await expect(rack(page, "T")).toBeVisible();
    await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(
      6,
    );
    // Let the return animation finish before another interaction.
    await expect(page.getByTestId("recall-tiles")).toBeEnabled();
    await cell(page, 0, 1).tap();
    // A rack tile still selects itself rather than returning the board tile.
    await rack(page, "T").tap();
    await expect(cell(page, 0, 1)).toHaveClass(/has-tentative/);
    await expect(rack(page, "T")).toHaveAttribute("aria-pressed", "true");
    await cell(page, 0, 1).tap();
    await page.getByTestId("tile-rack").focus();
    await page.keyboard.press("Enter");
    await expect(cell(page, 0, 1)).not.toHaveClass(/has-tentative/);
    await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(
      7,
    );
    expect(await authoritativeState()).toEqual(before);
  });
}

test("wooden rack stays the same size as tiles leave and return and bonus legend lives in Help", async ({
  page,
}, info) => {
  await enroll(page);
  await expect(page.getByTestId("turn-announcement")).toBeVisible();
  await expect(page.getByTestId("turn-announcement")).toBeHidden();
  for (const [width, height] of [
    [1024, 768],
    [1366, 1024],
    [1280, 720],
    [820, 1180],
  ]) {
    await page.setViewportSize({ width, height });
    const holder = page.getByTestId("tile-rack");
    const before = (await holder.boundingBox())!;
    const shuffle = (await page.getByTestId("shuffle-rack").boundingBox())!;
    for (const [letter, col] of [
      ["M", 6],
      ["W", 7],
    ] as const) {
      await rack(page, letter).tap();
      await cell(page, 7, col).tap();
    }
    await expect(holder.locator("button")).toHaveCount(5);
    await expect
      .poll(() =>
        holder
          .locator(".rack-visual")
          .evaluateAll((nodes) =>
            nodes.every(
              (node) =>
                Math.abs(
                  node.getBoundingClientRect().left -
                    node.parentElement!.getBoundingClientRect().left,
                ) < 0.5,
            ),
          ),
      )
      .toBe(true);
    const after = (await holder.boundingBox())!;
    expect(Math.abs(after.width - before.width)).toBeLessThan(1);
    expect(Math.abs(after.height - before.height)).toBeLessThan(1);
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    const shuffleAfter = (await page
      .getByTestId("shuffle-rack")
      .boundingBox())!;
    expect(Math.abs(shuffleAfter.x - shuffle.x)).toBeLessThan(1);
    await page.screenshot({
      path: info.outputPath(`fixed-wood-rack-${width}x${height}.png`),
      fullPage: false,
    });
    await page.getByTestId("recall-tiles").tap();
    await expect(holder.locator("button")).toHaveCount(7);
    expect(
      Math.abs((await holder.boundingBox())!.width - before.width),
    ).toBeLessThan(1);
    for (const [index, tile] of tiles.entries()) {
      await page.getByTestId(`rack-tile-${tile.id}`).tap();
      await cell(page, 7, index).tap();
      if (tile.letter === "?") {
        await page.getByTestId("blank-A").tap();
        await expect(page.getByRole("dialog")).toHaveCount(0);
      }
    }
    await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(
      0,
    );
    const emptyRack = (await page.getByTestId("tile-rack").boundingBox())!;
    expect(emptyRack.width).toBeCloseTo(before.width, 0);
    expect(emptyRack.height).toBeCloseTo(before.height, 0);
    await page.screenshot({
      path: info.outputPath(`fixed-wood-rack-empty-${width}x${height}.png`),
      fullPage: false,
    });
    await page.getByTestId("recall-tiles").tap();
    await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(
      7,
    );
  }
  await expect(page.locator(".rack-heading")).toHaveCount(0);
  await expect(page.locator(".app-footer")).toHaveCount(0);
  await writeFixture({ ...fixtureGame, turn: "aunt" });
  await expect(page.getByTestId("turn-status")).toContainText("Rita");
  await expect(
    page.getByText("Your draft stays private until your turn.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByTestId("help-settings").click();
  const help = page.getByRole("dialog", { name: "Help & settings" });
  for (const label of [
    "Double letter",
    "Triple letter",
    "Double word",
    "Triple word",
  ]) {
    await expect(help.getByText(label, { exact: false })).toBeVisible();
  }
});

test("partial hands center gently after release while drag targets stay steady", async ({
  page,
  context,
}, info) => {
  await enroll(page);
  await expect(page.getByTestId("turn-announcement")).toBeHidden();
  const holder = page.getByTestId("tile-rack");
  const slots = holder.locator("[data-rack-tile-id]");
  const centeredError = () =>
    holder.evaluate((element) => {
      const tiles = [
        ...element.querySelectorAll("[data-rack-tile-id] .rack-visual"),
      ];
      if (!tiles.length) return 0;
      const rack = element.getBoundingClientRect();
      const first = tiles[0].getBoundingClientRect();
      const last = tiles.at(-1)!.getBoundingClientRect();
      return Math.abs(
        (first.left + last.right) / 2 - (rack.left + rack.right) / 2,
      );
    });
  const positions = () =>
    slots.evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.getAttribute("data-rack-tile-id"),
        x: node.getBoundingClientRect().left,
      })),
    );
  const holderBefore = (await holder.boundingBox())!;
  await rack(page, "M").tap();
  await cell(page, 7, 6).tap();
  await rack(page, "W").tap();
  await cell(page, 7, 7).tap();
  await expect(slots).toHaveCount(5);
  await expect.poll(centeredError).toBeLessThan(1);
  const before = await positions();
  const session = await context.newCDPSession(page);
  // Returning a board tile reserves a vacancy without shifting the hand beneath the finger.
  const source = await point(cell(page, 7, 6));
  await touch(session, "touchStart", source);
  await touch(session, "touchMove", { x: source.x + 15, y: source.y });
  await expect(page.getByTestId("drag-ghost")).toBeVisible();
  await expect(page.getByTestId("rack-preview-gap")).toBeVisible();
  expect(await positions()).toEqual(before);
  await touch(session, "touchMove", await point(cell(page, 8, 6)));
  expect(await positions()).toEqual(before);
  await touch(session, "touchCancel");
  await expect(page.getByTestId("drag-ghost")).toBeHidden();
  await expect.poll(centeredError).toBeLessThan(1);

  // Capture actual intermediate geometry as a rack tile leaves, not just its final alignment.
  const destination = await point(cell(page, 7, 8));
  await touch(session, "touchStart", await point(rack(page, "Q")));
  await touch(session, "touchMove", destination);
  await expect(page.getByTestId("drag-ghost")).toBeVisible();
  expect(await positions()).toEqual(before);
  await page.evaluate(() => {
    const samples: number[] = [];
    (window as unknown as { centerSamples: number[] }).centerSamples = samples;
    const until = performance.now() + 900;
    function sample() {
      const tile = document.querySelectorAll(
        "[data-rack-tile-id] .rack-visual",
      )[1];
      if (tile) samples.push(tile.getBoundingClientRect().left);
      if (performance.now() < until) requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  await touch(session, "touchEnd");
  await expect(slots).toHaveCount(4);
  await expect.poll(centeredError).toBeLessThan(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { centerSamples: number[] }).centerSamples
            .length,
      ),
    )
    .toBeGreaterThan(15);
  const samples = await page.evaluate(
    () => (window as unknown as { centerSamples: number[] }).centerSamples,
  );
  expect(new Set(samples.map((x) => Math.round(x * 10))).size).toBeGreaterThan(
    4,
  );
  const holderAfter = (await holder.boundingBox())!;
  expect(holderAfter.width).toBeCloseTo(holderBefore.width, 0);
  expect(holderAfter.height).toBeCloseTo(holderBefore.height, 0);
  await page.screenshot({
    path: info.outputPath("centered-four-letter-hand.png"),
    fullPage: false,
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Motion snapshots the OS preference at mount; test the reduced-motion launch path.
  await page.reload();
  await expect(slots).toHaveCount(4);
  await page.getByTestId("recall-tiles").tap();
  await expect(slots).toHaveCount(7);
  await rack(page, "M").tap();
  await cell(page, 7, 6).tap();
  await expect(slots).toHaveCount(6);
  expect(await centeredError()).toBeLessThan(1);
  const sixBefore = await positions();
  const returnSource = await point(cell(page, 7, 6));
  await touch(session, "touchStart", returnSource);
  await touch(session, "touchMove", {
    x: returnSource.x + 15,
    y: returnSource.y,
  });
  await expect(page.getByTestId("rack-preview-gap")).toBeVisible();
  expect(await positions()).toEqual(sixBefore);
  await touch(
    session,
    "touchMove",
    await point(page.getByTestId("rack-preview-gap")),
  );
  await expect(holder).toHaveAttribute("data-rack-insertion-index", "6");
  expect(await positions()).toEqual(sixBefore);
  const gapBounds = (await page
    .getByTestId("rack-insertion-preview")
    .boundingBox())!;
  const woodBounds = (await holder.boundingBox())!;
  expect(gapBounds.x + gapBounds.width).toBeLessThanOrEqual(
    woodBounds.x + woodBounds.width,
  );
  await page.screenshot({
    path: info.outputPath("six-letter-hand-return-end-preview.png"),
    fullPage: false,
  });
  await touch(session, "touchEnd");
  await expect(slots).toHaveCount(7);
  await expect(cell(page, 7, 6)).not.toHaveClass(/has-tentative/);
  expect(await centeredError()).toBeLessThan(1);
});

test("Recall flies placed letters and a blank into their actual centered hand positions", async ({
  page,
}, info) => {
  await enroll(page);
  await expect(page.getByTestId("turn-announcement")).toBeHidden();
  for (const [letter, col] of [
    ["A", 1],
    ["T", 2],
    ["?", 3],
  ] as const) {
    await rack(page, letter).tap();
    await cell(page, 0, col).tap();
    if (letter === "?") await page.getByTestId("blank-Z").tap();
  }
  await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(4);
  const before = await authoritativeState();
  await page.evaluate(() => {
    // Capture after tap scrolling and tile-entry motion, in the same event as Recall.
    window.addEventListener(
      "click",
      () => {
        const sources = [
          ...document.querySelectorAll(".has-tentative .board-tile"),
        ].map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        });
        Object.assign(window, { recallSources: sources });
      },
      { capture: true, once: true },
    );
    const records: Record<
      string,
      {
        from: string | null;
        to: string | null;
        letter: string | null;
        points: { x: number; y: number; width: number; height: number }[];
      }
    > = {};
    Object.assign(window, { recallRecords: records });
    const until = performance.now() + 1800;
    function sample() {
      document
        .querySelectorAll<HTMLElement>('[data-testid="recall-ghost"]')
        .forEach((node) => {
          const id = node.dataset.tileId!;
          const record = (records[id] ||= {
            from: node.getAttribute("data-from"),
            to: node.getAttribute("data-to"),
            letter:
              node.querySelector(".tile-letter")?.getAttribute("data-letter") ??
              null,
            points: [],
          });
          const rect = node.getBoundingClientRect();
          record.points.push({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          });
        });
      if (performance.now() < until) requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  await page.getByTestId("recall-tiles").tap();
  await expect(page.getByTestId("recall-ghost")).toHaveCount(3);
  await expect(page.locator(".has-tentative")).toHaveCount(0);
  await expect(page.getByTestId("shuffle-rack")).toBeDisabled();
  await expect(page.getByTestId("recall-tiles")).toBeDisabled();
  await expect(rack(page, "M")).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("recall-letters-in-flight.png"),
    fullPage: false,
  });
  await expect(page.getByTestId("recall-ghost")).toHaveCount(0);
  await expect(page.locator(".recall-target")).toHaveCount(0);
  await expect(page.getByTestId("shuffle-rack")).toBeEnabled();
  await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(7);
  const records = await page.evaluate(
    () =>
      (
        window as unknown as {
          recallRecords: Record<
            string,
            {
              from: string | null;
              to: string | null;
              letter: string | null;
              points: { x: number; y: number; width: number; height: number }[];
            }
          >;
        }
      ).recallRecords,
  );
  const sources = await page.evaluate(
    () =>
      (
        window as unknown as {
          recallSources: {
            x: number;
            y: number;
            width: number;
            height: number;
          }[];
        }
      ).recallSources,
  );
  expect(Object.keys(records)).toHaveLength(3);
  for (const record of Object.values(records)) {
    const from = JSON.parse(record.from!);
    const to = JSON.parse(record.to!);
    expect(
      sources.some(
        (source) =>
          Math.abs(source.x - from.x) < 1 && Math.abs(source.y - from.y) < 1,
      ),
    ).toBe(true);
    expect(record.points.length).toBeGreaterThan(5);
    expect(
      record.points.some(
        (point) =>
          point.y > Math.min(from.y, to.y) + 10 &&
          point.y < Math.max(from.y, to.y) - 10,
      ),
    ).toBe(true);
  }
  for (const [id, record] of Object.entries(records)) {
    const target = (await page
      .locator(`[data-rack-tile-id="${id}"]`)
      .boundingBox())!;
    const to = JSON.parse(record.to!);
    for (const key of ["x", "y", "width", "height"] as const)
      expect(to[key]).toBeCloseTo(target[key], 0);
  }
  const blank = Object.values(records).find((record) => record.letter === "Z");
  expect(blank).toBeDefined();
  await expect(rack(page, "?")).toHaveAttribute(
    "aria-label",
    /Blank, 0 points/,
  );
  await expect(rack(page, "?").locator(".tile-letter")).toHaveAttribute(
    "data-letter",
    "?",
  );
  expect(await authoritativeState()).toEqual(before);
  await page.screenshot({
    path: info.outputPath("recalled-centered-hand.png"),
    fullPage: false,
  });
});

test("Recall handles a full empty hand, interruptions, and reduced motion without stranded tiles", async ({
  page,
}, info) => {
  await enroll(page);
  await expect(page.getByTestId("turn-announcement")).toBeHidden();
  for (const [col, tile] of tiles.entries()) {
    await page.getByTestId(`rack-tile-${tile.id}`).tap();
    await cell(page, 7, col).tap();
    if (tile.letter === "?") await page.getByTestId("blank-A").tap();
  }
  await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(0);
  const before = await authoritativeState();
  await page.getByTestId("recall-tiles").tap();
  await expect(page.getByTestId("recall-ghost")).toHaveCount(7);
  await page.screenshot({
    path: info.outputPath("recall-all-seven-letters.png"),
    fullPage: false,
  });
  await expect(page.getByTestId("recall-ghost")).toHaveCount(0);
  await expect(page.locator(".recall-target")).toHaveCount(0);
  await expect(page.getByTestId("shuffle-rack")).toBeEnabled();
  expect(await authoritativeState()).toEqual(before);
  for (const interrupt of ["resize", "revision"] as const) {
    await rack(page, "A").tap();
    await cell(page, 0, 1).tap();
    await page.getByTestId("recall-tiles").tap();
    await expect(page.getByTestId("recall-ghost")).toHaveCount(1);
    if (interrupt === "resize")
      await page.setViewportSize({ width: 1180, height: 820 });
    else
      await writeFixture({
        ...fixtureGame,
        turn: "aunt",
        revision: fixtureGame.revision + 1,
      });
    await expect(page.getByTestId("recall-ghost")).toHaveCount(0);
    await expect(page.locator(".recall-target")).toHaveCount(0);
    await expect(rack(page, "A")).toBeEnabled();
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(7);
  await rack(page, "A").tap();
  await cell(page, 0, 1).tap();
  await page.getByTestId("recall-tiles").tap();
  await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(7);
  await expect(page.getByTestId("recall-ghost")).toHaveCount(0);
  await expect(page.locator(".recall-target")).toHaveCount(0);
  await expect(page.getByTestId("shuffle-rack")).toBeEnabled();
});

test("latest plays stay strong until the actual turn announcement exits, fade for five seconds and do not replay on reload", async ({
  page,
}, info) => {
  await enroll(page);
  await expect(page.getByTestId("turn-announcement")).toBeHidden();
  const a = fixtureGame.racks.mom.find((tile) => tile.letter === "A")!;
  const next = applyCommand(
    fixtureGame,
    "mom",
    {
      id: "fixture-green-own-play",
      gameId: fixtureGame.id,
      expectedRevision: fixtureGame.revision,
      kind: "play",
      placements: [{ tileId: a.id, row: 0, col: 1 }],
    },
    new Set(["RA"]),
    () => 0.42,
  );
  await writeFixture(next);
  const played = cell(page, 0, 1).locator(".board-tile");
  await expect(played).toHaveClass(/latest-play-tile/);
  await expect(played).toHaveClass(/held-play-tile/);
  await expect(
    page.getByText("The latest tiles have a green edge.", { exact: true }),
  ).toHaveCount(0);
  const glow = () =>
    played.evaluate((element) =>
      Number(getComputedStyle(element, "::before").opacity),
    );
  await expect.poll(glow, { intervals: [30, 50, 100] }).toBeGreaterThan(0.2);
  const fresh = await glow();
  const border = await played.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.borderColor,
      width: parseFloat(style.borderWidth),
      type: style.borderStyle,
    };
  });
  expect(border.width).toBeGreaterThanOrEqual(1);
  expect(border.type).toBe("solid");
  expect(border.color).toBe("rgb(85, 130, 96)");
  const letterInk = () =>
    played
      .locator(".tile-letter")
      .evaluate((element) => getComputedStyle(element).color);
  const vividInk = await letterInk();
  expect(
    await played.evaluate(
      (element) => getComputedStyle(element, "::before").backgroundColor,
    ),
  ).toBe("rgba(0, 0, 0, 0)");
  expect(
    await cell(page, 0, 1).evaluate(
      (element) => element.getAnimations().length,
    ),
  ).toBe(0);
  // A deferred announcement must keep the last word vivid, not start a timer
  // merely because a turn was accepted.
  await page.getByTestId("help-settings").click();
  await page.waitForTimeout(5200);
  expect(await glow()).toBeGreaterThan(0.9);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByTestId("turn-announcement")).toBeVisible();
  expect(await glow()).toBeGreaterThan(0.9);
  await page.getByTestId("help-settings").click();
  await expect(page.getByTestId("turn-announcement")).toHaveCount(0);
  await page.waitForTimeout(700);
  expect(await glow()).toBeGreaterThan(0.9);
  expect(
    await cell(page, 0, 1).evaluate(
      (element) => element.getAnimations().length,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByTestId("turn-announcement")).toBeVisible();
  await expect(page.getByTestId("turn-announcement")).toHaveCount(0);
  const fadeStarted = Date.now();
  const scaleAnimation = await cell(page, 0, 1).evaluate((element) => {
    const animations = element.getAnimations();
    return animations.some((animation) => {
      const frames = (animation.effect as KeyframeEffect).getKeyframes();
      return (
        frames.some((frame) => String(frame.transform).includes("1.2")) &&
        frames.some((frame) => String(frame.transform).includes("scale(1)"))
      );
    });
  });
  expect(scaleAnimation).toBe(true);
  await page.screenshot({
    path: info.outputPath("latest-play-fresh-green.png"),
    fullPage: false,
  });
  await expect.poll(glow, { timeout: 6500 }).toBeLessThan(fresh / 2);
  await expect(played).not.toHaveClass(/fresh-play-tile/, { timeout: 6500 });
  expect(Date.now() - fadeStarted).toBeGreaterThanOrEqual(4700);
  const faint = await glow();
  const settledInk = await letterInk();
  expect(settledInk).not.toBe(vividInk);
  expect(faint).toBeGreaterThan(0);
  await expect(played).toHaveClass(/latest-play-tile/);
  await expect(cell(page, 0, 0).locator(".board-tile")).not.toHaveClass(
    /latest-play-tile/,
  );
  await page.screenshot({
    path: info.outputPath("latest-play-faint-green.png"),
    fullPage: false,
  });
  await page.reload();
  await expect(played).toHaveClass(/latest-play-tile/);
  await expect(played).not.toHaveClass(/fresh-play-tile/);
  expect(await letterInk()).toBe(settledInk);
  expect(
    await cell(page, 0, 1).evaluate(
      (element) => element.getAnimations().length,
    ),
  ).toBe(0);

  // The other player's turn gets the same treatment; reduced motion keeps a static marker.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const s = fixtureGame.racks.aunt.find((tile) => tile.letter === "S")!;
  await writeFixture(
    applyCommand(
      fixtureGame,
      "aunt",
      {
        id: "fixture-green-opponent-play",
        gameId: fixtureGame.id,
        expectedRevision: fixtureGame.revision,
        kind: "play",
        placements: [{ tileId: s.id, row: 0, col: 2 }],
      },
      new Set(["RAS"]),
      () => 0.42,
    ),
  );
  const opponent = cell(page, 0, 2).locator(".board-tile");
  await expect(opponent).toHaveClass(/latest-play-tile/);
  await expect(played).not.toHaveClass(/latest-play-tile/);
  expect(
    await cell(page, 0, 2).evaluate(
      (element) => element.getAnimations().length,
    ),
  ).toBe(0);
  for (const theme of themes) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    await page.screenshot({
      path: info.outputPath(`latest-play-${theme}.png`),
      fullPage: false,
    });
  }
  await writeFixture(
    applyCommand(
      fixtureGame,
      "mom",
      {
        id: "fixture-green-next-pass",
        gameId: fixtureGame.id,
        expectedRevision: fixtureGame.revision,
        kind: "pass",
      },
      new Set(),
      () => 0.42,
    ),
  );
  await expect(page.locator(".latest-play-tile")).toHaveCount(0);
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
        fullPage: false,
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
    await openInvitationForm(aunt);
    await aunt.getByTestId("setup-code").fill("peach");
    await aunt.getByTestId("enroll-submit").click();
    await expect(aunt.getByTestId("game-board")).toBeVisible({
      timeout: 45_000,
    });
    await expect(aunt.locator("html")).toHaveAttribute(
      "data-theme",
      "blue-ink",
    );
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
  expect(Math.abs(ghost.width - square.width * 1.35)).toBeLessThan(1);
  expect(Math.abs(ghost.height - square.width * 1.35)).toBeLessThan(1);
  expect(Math.abs(ghost.x + ghost.width / 2 - target.x)).toBeLessThan(2);
  expect(Math.abs(ghost.y + ghost.height / 2 - target.y)).toBeLessThan(2);
  await expect(page.getByTestId("drag-anchor")).toHaveCount(0);
  await expect(cell(page, 7, 7)).toHaveClass(/drag-over-square/);
  expect(
    await cell(page, 7, 7).evaluate((element) =>
      parseFloat(getComputedStyle(element).outlineWidth),
    ),
  ).toBeGreaterThanOrEqual(2);
  await expect(cell(page, 7, 7)).toHaveCSS("outline-style", "solid");
  await expect(page.getByTestId("landing-preview")).toHaveCount(0);
  await expect(cell(page, 7, 7).locator(".board-tile")).toHaveCount(0);
  await expect(cell(page, 7, 7)).not.toHaveClass(/has-tentative/);
  await expect(page.getByTestId("drag-ghost")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.screenshot({
    path: info.outputPath("touch-single-ghost-clear-target.png"),
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
  await expect(cell(page, 7, 7)).toHaveClass(/drag-over-square/);
  await expect(page.getByTestId("landing-preview")).toHaveCount(0);
  await expect(cell(page, 7, 7).locator(".board-tile")).toHaveCount(0);
  await expect(cell(page, 7, 7)).not.toHaveClass(/has-tentative/);
  const ghost = (await page.getByTestId("drag-ghost").boundingBox())!;
  expect(
    Math.abs(
      ghost.width - (await cell(page, 7, 7).boundingBox())!.width * 1.35,
    ),
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
  await expect(cell(page, 7, 8)).toHaveClass(/drag-over-square/);
  await expect(page.getByTestId("landing-preview")).toHaveCount(0);
  await expect(cell(page, 7, 8).locator(".board-tile")).toHaveCount(0);
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
  await expect(cell(page, 0, 2)).toHaveClass(/drag-over-square/);
  await expect(page.getByTestId("landing-preview")).toHaveCount(0);
  await expect(cell(page, 0, 2).locator(".board-tile")).toHaveCount(0);
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
  await expect(page.getByTestId("move-preview")).toHaveClass(
    /dictionary-unrecognized/,
  );
  const unknownFill = await page.getByTestId("move-preview").evaluate((node) =>
    getComputedStyle(node)
      .backgroundColor.match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number),
  );
  expect(unknownFill[0]).toBeGreaterThan(unknownFill[1]);
  await checkTextContrast(
    page,
    '[data-testid="move-preview"] strong, [data-testid="move-preview"] .preview-score',
  );
  const unknownInk = await page.getByTestId("word-check").evaluate((node) =>
    getComputedStyle(node)
      .color.match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number),
  );
  expect(unknownInk[0]).toBeGreaterThan(unknownInk[1]);
  await checkTextContrast(page, '[data-testid="word-check"]');
  await expect(page.locator(".invalid-arrangement")).toHaveCount(0);
  await expect(page.getByTestId("play-word")).toBeDisabled();
  await expect(page.getByTestId("ask-about-word")).toBeEnabled();
  await page.screenshot({
    path: info.outputPath("unrecognized-preview-red.png"),
    fullPage: false,
  });
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
  // Repair the committed cross letter without changing the player's draft.
  // Both AT and TA are now recognized; the same status must switch to green.
  const t = fixtureGame.bag.find((tile) => tile.letter === "T")!;
  const repair = db.batch();
  repair.update(db.doc("games/ui-table"), {
    board: { "6,7": { ...t, row: 6, col: 7 } },
  });
  repair.update(db.doc("games/ui-table/private/state"), {
    bag: [...fixtureGame.bag.filter((tile) => tile.id !== t.id), q],
  });
  await repair.commit();
  await expect(page.getByTestId("word-check")).toHaveAttribute(
    "data-state",
    "recognized",
  );
  await expect(page.getByTestId("move-preview")).toHaveClass(
    /dictionary-recognized/,
  );
  const knownFill = await page.getByTestId("move-preview").evaluate((node) =>
    getComputedStyle(node)
      .backgroundColor.match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number),
  );
  expect(knownFill[1]).toBeGreaterThan(knownFill[0]);
  await checkTextContrast(
    page,
    '[data-testid="move-preview"] strong, [data-testid="move-preview"] .preview-score',
  );
  const knownInk = await page.getByTestId("word-check").evaluate((node) =>
    getComputedStyle(node)
      .color.match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number),
  );
  expect(knownInk[1]).toBeGreaterThan(knownInk[0]);
  await checkTextContrast(page, '[data-testid="word-check"]');
  await expect(cell(page, 7, 7)).toHaveClass(/has-tentative/);
  await expect(cell(page, 7, 8)).toHaveClass(/has-tentative/);
  await page.screenshot({
    path: info.outputPath("recognized-preview-green.png"),
    fullPage: false,
  });
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
    await openInvitationForm(aunt);
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
        if (turn === 4 || turn === 5) {
          for (const target of [page, aunt]) {
            await expect(target.getByTestId("scoreless-notice")).toHaveText(
              turn === 4
                ? "Two more turns without points end this game. A scoring play resets the count."
                : "One more scoreless turn ends this game.",
            );
            await expect(target.getByTestId("pass-turn")).toHaveAccessibleName(
              turn === 5 ? "Pass & end game" : "Pass turn",
            );
          }
          await expect(
            (turn === 4 ? page : aunt).getByTestId("pass-turn"),
          ).toBeEnabled();
        }
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
      const summary = target.getByTestId("game-summary");
      await expect(summary).toBeVisible();
      await expect(
        summary.getByTestId("history-mom").locator("li"),
      ).toHaveCount(1);
      await expect(
        summary.getByTestId("history-mom").locator("li .history-word-scores"),
      ).toHaveText("AT 2 points");
      await expect(
        summary.getByTestId("history-mom").getByLabel("Turn total 2"),
      ).toHaveText("+2");
      await expect(summary.getByTestId("history-aunt")).toContainText(
        "No recorded turns",
      );
      await expect(
        summary.getByTestId("adjustments-mom").locator("dd"),
      ).toHaveText(["22", "0", "0", "+10", "32"]);
      await expect(
        summary.getByTestId("adjustments-aunt").locator("dd"),
      ).toHaveText(["25", "10", "−10", "15"]);
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
      fullPage: false,
    });
    await page.getByTestId("game-summary").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath("rack-out-summary-landscape.png"),
      fullPage: false,
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
    await expect(page.getByTestId("new-game")).toBeVisible();
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

test("empty-bag ENDGAME needs both players, preserves a declined game and ranks individual words without debug writes", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120_000);
  const pool = [
    ...fixtureGame.bag,
    ...fixtureGame.racks.mom,
    ...fixtureGame.racks.aunt,
    ...Object.values(fixtureGame.board),
  ];
  const pick = (letter: string) =>
    pool.splice(
      pool.findIndex((tile) => tile.letter === letter),
      1,
    )[0];
  const mom = [pick("Q"), pick("?")];
  const auntRack = [pick("A"), pick("T")];
  const board: Game["board"] = {};
  for (const [index, tile] of pool.entries()) {
    const row = Math.floor(index / 15),
      col = index % 15;
    board[`${row},${col}`] = {
      ...tile,
      letter: tile.letter === "?" ? "Z" : tile.letter,
      row,
      col,
    };
  }
  const history: NonNullable<Game["history"]> = [
    {
      id: "mom-cross",
      player: "mom",
      kind: "play",
      words: ["CAT", "AT"],
      wordScores: [
        { word: "CAT", score: 8 },
        { word: "AT", score: 1 },
      ],
      score: 9,
      at: 1,
    },
    {
      id: "aunt-cross",
      player: "aunt",
      kind: "play",
      words: ["CAT", "AT"],
      wordScores: [
        { word: "CAT", score: 8 },
        { word: "AT", score: 1 },
      ],
      score: 9,
      at: 2,
    },
    {
      id: "mom-quartz",
      player: "mom",
      kind: "play",
      words: ["QUARTZ"],
      wordScores: [{ word: "QUARTZ", score: 75 }],
      score: 75,
      at: 3,
    },
    {
      id: "aunt-dog",
      player: "aunt",
      kind: "play",
      words: ["DOG"],
      wordScores: [{ word: "DOG", score: 12 }],
      score: 12,
      at: 4,
    },
    {
      id: "mom-dog",
      player: "mom",
      kind: "play",
      words: ["DOG"],
      wordScores: [{ word: "DOG", score: 5 }],
      score: 5,
      at: 5,
    },
    {
      id: "aunt-tax",
      player: "aunt",
      kind: "play",
      words: ["TAX"],
      wordScores: [{ word: "TAX", score: 18 }],
      score: 18,
      at: 6,
    },
  ];
  await writeFixture({
    ...fixtureGame,
    board,
    bag: [],
    racks: { mom, aunt: auntRack },
    scores: { mom: 89, aunt: 39 },
    history,
    historyComplete: true,
  });
  tiles = mom;
  await enroll(page, 2);
  const { aunt, auntContext } = await joinRita(browser, 2);
  try {
    await expect(page.getByTestId("turn-announcement")).toBeHidden();
    const before = await authoritativeState();
    await page.getByTestId("help-settings").click();
    await page.getByTestId("debug-enabled").check();
    await page.getByTestId("debug-end-game").click();
    await page.getByTestId("debug-ending-agreed-end").click();
    const debug = page.getByTestId("debug-end-game-popup");
    await expect(debug).toBeVisible();
    await expect(debug).toHaveCSS("opacity", "1");
    await expect(debug.locator('[data-testid="rematch"]:enabled')).toHaveCount(
      0,
    );
    expect(await authoritativeState()).toEqual(before);
    await page.screenshot({
      path: info.outputPath("debug-end-game-local-only.png"),
      fullPage: false,
    });
    await debug.getByRole("button", { name: "Close dialog" }).click();
    if (await page.getByRole("dialog", { name: "Help & settings" }).isVisible())
      await page.getByRole("button", { name: "Close dialog" }).click();

    await page.getByTestId("request-end-game").click();
    await expect(page.getByTestId("end-game-request-popup")).toBeVisible();
    await page.getByTestId("confirm-end-game-request").click();
    const incoming = aunt.getByTestId("incoming-end-game-popup");
    await expectRequiredDecision(aunt, incoming);
    await expect(page.getByTestId("approve-end-game")).toHaveCount(0);
    await expect(page.getByTestId("pass-turn")).toBeDisabled();
    expect(await authoritativeState()).toEqual(before);
    await aunt.reload();
    await expect(incoming).toBeVisible();
    await expect(incoming).toHaveCSS("opacity", "1");
    await aunt.screenshot({
      path: info.outputPath("empty-bag-endgame-consent-portrait.png"),
      fullPage: false,
    });
    await incoming.getByTestId("decline-end-game").click();
    await expect(incoming).toHaveCount(0);
    expect(await authoritativeState()).toEqual(before);
    await expect(page.getByTestId("request-end-game")).toBeEnabled();
    await expect(page.getByTestId("pass-turn")).toBeEnabled();

    // The waiting player may ask too. A fresh request is not a turn or a pass.
    await aunt.getByTestId("request-end-game").click();
    await aunt.getByTestId("confirm-end-game-request").click();
    const elizabethDecision = page.getByTestId("incoming-end-game-popup");
    await expectRequiredDecision(page, elizabethDecision);
    const requests = await db.collection("pairs/family/endGameRequests").get();
    expect(requests.size).toBe(2);
    expect(requests.docs.map((doc) => doc.data().status).sort()).toEqual([
      "declined",
      "pending",
    ]);
    expect(await authoritativeState()).toEqual(before);
    await elizabethDecision.getByTestId("approve-end-game").click();
    expectedRevision = 1;
    for (const target of [page, aunt]) {
      const result = target.getByTestId("end-game-popup");
      await expect(result).toBeVisible();
      await expect(result.getByTestId("result-score-mom")).toHaveText("79");
      await expect(result.getByTestId("result-score-aunt")).toHaveText("37");
      await expect(result.getByTestId("game-ending-reason")).toContainText(
        /agreed|agreement/i,
      );
      await expect(
        result.getByTestId("top-word-scores-mom").locator("li"),
      ).toHaveText([/QUARTZ.*75/, /CAT.*8/, /DOG.*5/]);
      await expect(
        result.getByTestId("top-word-scores-aunt").locator("li"),
      ).toHaveText([/TAX.*18/, /DOG.*12/, /CAT.*8/]);
      await expect(target.getByTestId("turn-announcement")).toHaveCount(0);
      await expect(
        target.locator('button[data-testid="play-word"]:enabled'),
      ).toHaveCount(0);
    }
    const ended = (await db.doc("games/ui-table").get()).data()!;
    expect(ended).toMatchObject({
      status: "finished",
      endedReason: "agreed-end",
      revision: 1,
      winner: "mom",
      scores: { mom: 79, aunt: 37 },
      finalScoreAdjustments: {
        players: {
          mom: { deducted: 10, transferred: 0 },
          aunt: { deducted: 2, transferred: 0 },
        },
      },
    });
    expect(ended.history).toEqual(history);
    expect(ended.board).toEqual(fixtureGame.board);
    expect((await authoritativeState()).slice(1)).toEqual(before.slice(1));
    await page.getByTestId("top-word-scores-mom").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath("agreed-end-top-three-words.png"),
      fullPage: false,
    });
    await aunt.screenshot({
      path: info.outputPath("agreed-end-portrait.png"),
      fullPage: false,
    });
    await page.reload();
    await expect(page.getByTestId("end-game-popup")).toBeVisible();
    expect((await db.doc("games/ui-table").get()).data()).toEqual(ended);
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
  await rack(page, "A").tap();
  await cell(page, 0, 1).tap();
  await expect(cell(page, 0, 1)).toContainText("A");
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
  await page.getByTestId("debug-end-game").click();
  const tools = page.getByTestId("local-debug-popup");
  await tools.getByTestId("debug-winner").selectOption("aunt");
  await tools.getByTestId("debug-ending-rack-out").click();
  const ending = page.getByTestId("debug-end-game-popup");
  await expect(ending.getByTestId("game-ending-reason")).toContainText(
    "Elizabeth used their last tile",
  );
  await expect(ending.locator(".ending-phase")).toHaveText(
    "Counting points earned, including bonuses",
  );
  await expect(ending.getByTestId("result-score-aunt")).toHaveCount(0);
  await expect(ending.locator(".ending-phase")).toHaveText(
    "Applying remaining tiles",
  );
  await expect(ending.locator(".ending-phase")).toHaveText(
    "Adding the remaining tile points",
  );
  await expect(ending.getByTestId("result-score-mom")).toHaveText("106");
  await expect(ending.getByTestId("result-score-aunt")).toHaveText("144");
  await expect(
    ending.getByRole("heading", { name: "Rita wins!" }),
  ).toBeVisible();
  const verdictBox = await ending
    .getByRole("heading", { name: "Rita wins!" })
    .boundingBox();
  const footerBox = await ending.locator(".modal-footer").boundingBox();
  expect(verdictBox).not.toBeNull();
  expect(footerBox).not.toBeNull();
  expect(verdictBox!.y + verdictBox!.height).toBeLessThanOrEqual(footerBox!.y);
  await expect(ending.locator(".ending-ledger dd")).toHaveText([
    "100",
    "−0",
    "+6",
    "150",
    "−6",
    "+0",
  ]);
  await page.screenshot({
    path: info.outputPath("ending-rack-out-rita-wins.png"),
    fullPage: false,
  });
  await ending.getByRole("button", { name: "More previews" }).click();
  for (const [reason, text] of [
    ["agreed-end", "both agreed"],
    ["scoreless", "Six consecutive turns"],
    ["timed", "Time is up"],
    ["turn-limit", "Ten turns each"],
    ["target-score", "150 points reached"],
  ]) {
    await tools.getByTestId(`debug-ending-${reason}`).click();
    await expect(ending.getByTestId("game-ending-reason")).toContainText(text);
    await ending.getByRole("button", { name: "Show final scores" }).click();
    await expect(ending.getByTestId("result-score-aunt")).toHaveText(
      String(
        debugEndingGame(reason as Parameters<typeof debugEndingGame>[0], "aunt")
          .scores.aunt,
      ),
    );
    await ending.getByRole("button", { name: "More previews" }).click();
  }
  await tools.getByTestId("debug-winner").selectOption("tie");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await tools.getByTestId("debug-ending-agreed-end").click();
  await expect(ending.getByTestId("result-score-mom")).toHaveText("108");
  await expect(
    ending.getByRole("button", { name: "Show final scores" }),
  ).toHaveCount(0);
  await expect(
    ending.getByRole("heading", { name: "An even match — a tie!" }),
  ).toBeVisible();
  await ending.getByRole("button", { name: "More previews" }).click();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await tools.getByTestId("debug-end-request").click();
  await expect(page.getByTestId("debug-end-request-popup")).toContainText(
    "Nothing is sent",
  );
  await page.getByTestId("debug-agree-end").click();
  await expect(ending).toBeVisible();
  await ending.getByRole("button", { name: "Back to your game" }).click();
  const boardState = () =>
    page
      .getByTestId("game-board")
      .locator("button")
      .evaluateAll((cells) =>
        cells.map((cell) => ({
          label: cell.getAttribute("aria-label"),
          tentative: cell.classList.contains("has-tentative"),
        })),
      );
  const boardBefore = await boardState();
  for (const kind of ["multiple-words", "high", "bingo"]) {
    await page.getByTestId("local-debug-tools").click();
    await tools.getByTestId(`debug-scene-${kind}`).click();
    await expect(tools).toHaveCount(0);
    await expect(page.getByTestId("debug-board-scoring")).toBeVisible();
    const preview = page.getByTestId("celebration-preview");
    await expect(preview).toHaveAttribute("data-debug", "true");
    await expect(page.getByTestId("play-word")).toBeDisabled();
    if (kind === "multiple-words") {
      await expect(preview.getByTestId("score-word-row")).toHaveCount(2);
      await page.screenshot({
        path: info.outputPath("debug-scoring-on-board.png"),
        fullPage: false,
      });
      await expect(page.getByTestId("debug-board-scoring")).toHaveCount(0, {
        timeout: 20000,
      });
    } else {
      await page.getByTestId("local-debug-tools").click();
      await tools.getByRole("button", { name: "Close dialog" }).click();
    }
    await expect(page.getByTestId("debug-board-scoring")).toHaveCount(0);
    expect(await boardState()).toEqual(boardBefore);
    expect(await authoritativeState()).toEqual(before);
  }
  await page.getByTestId("help-settings").click();
  expect(
    await page.evaluate(() => localStorage.getItem("tea-tiles-debug")),
  ).toBe("true");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.reload();
  await page.getByTestId("help-settings").click();
  await expect(page.getByTestId("debug-enabled")).toBeChecked();
  await page.getByTestId("theme-ink").check();
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.getByTestId("debug-end-game").click();
  await page.getByTestId("debug-ending-agreed-end").click();
  await page.getByRole("button", { name: "Show final scores" }).click();
  await expect(page.getByTestId("result-score-mom")).toBeVisible();
  await page.screenshot({
    path: info.outputPath("ending-dark-portrait.png"),
    fullPage: false,
  });
  await page.getByRole("button", { name: "Back to your game" }).click();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByTestId("help-settings").click();
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

test("a real DON move counts two then three then four in a large centered card", async ({
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
  const d = { ...take("D"), row: 5, col: 5 };
  tiles = [..."ONCLAPE"].map(take);
  await writeFixture({
    ...fixtureGame,
    board: { "5,5": d },
    racks: { mom: tiles, aunt: [..."SENLADU"].map(take) },
    bag: pool,
  });
  await enroll(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "blue-ink");
  for (const [index, letter] of [..."ON"].entries()) {
    await rack(page, letter).tap();
    await cell(page, 5, 6 + index).tap();
  }
  await expect(page.getByTestId("word-check")).toHaveAttribute(
    "data-state",
    "recognized",
  );
  await observeScoreSteps(page);
  expectedRevision = 1;
  expectedCommandCount = 1;
  expectedBoardKeys = [5, 6, 7].map((col) => `5,${col}`);
  await page.getByTestId("play-word").click();
  const score = page
    .getByTestId("move-celebration")
    .getByTestId("score-breakdown");
  await expect(score.locator(".tile-letter")).toHaveText([..."DON"]);
  await expect
    .poll(
      async () =>
        (await observedScores(page)).some(
          (step) => step.tile === 1 && step.score === 3,
        ),
      { intervals: [30] },
    )
    .toBe(true);
  await page.screenshot({
    path: info.outputPath("don-three-running-points.png"),
    fullPage: false,
  });
  await expect(score).toHaveAttribute("data-score-phase", "move-total");
  await expect(score.getByTestId("score-total")).toHaveText(/Move total\s*4$/);
  const observed = await observedScores(page);
  const letters = observed.filter((step) => step.phase === "letter");
  expect(letters.map((step) => [step.tile, step.score])).toEqual([
    [0, 2],
    [1, 3],
    [2, 4],
  ]);
  for (let index = 1; index < letters.length; index++)
    expect(letters[index].at - letters[index - 1].at).toBeGreaterThanOrEqual(
      250,
    );
  await page.screenshot({
    path: info.outputPath("don-four-final-points.png"),
    fullPage: false,
  });
  const game = (await db.doc("games/ui-table").get()).data()!;
  expect(game.lastMove.breakdown.words[0]).toMatchObject({
    word: "DON",
    wordMultiplier: 1,
    score: 4,
  });
  expect(game.scores.mom).toBe(4);
  await expect(page.getByTestId("move-celebration")).toHaveCount(0);
  await expect(page.getByTestId("turn-announcement")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { scoreTurnOverlaps: number[] })
          .scoreTurnOverlaps,
    ),
  ).toEqual([]);
});

test("a real blank crossing counts each word separately without charging the blank", async ({
  page,
  browser,
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
  const a = { ...take("A"), row: 6, col: 8 };
  tiles = [..."CA?NODE"].map(take);
  await writeFixture({
    ...fixtureGame,
    board: { "6,8": a },
    racks: { mom: tiles, aunt: [..."SENLADU"].map(take) },
    bag: pool,
  });
  await enroll(page);
  const { aunt: other, auntContext: otherContext } = await joinRita(browser);
  await other.emulateMedia({ reducedMotion: "no-preference" });
  try {
    for (const [index, letter] of [..."CA?"].entries()) {
      await rack(page, letter).tap();
      await cell(page, 7, 6 + index).tap();
      if (letter === "?") await page.getByTestId("blank-T").tap();
    }
    await expect(page.getByTestId("word-check")).toHaveAttribute(
      "data-state",
      "recognized",
    );
    await observeScoreSteps(page);
    expectedRevision = 1;
    expectedCommandCount = 1;
    expectedBoardKeys = ["6,8", "7,6", "7,7", "7,8"];
    await page.getByTestId("play-word").click();
    const score = page
      .getByTestId("move-celebration")
      .getByTestId("score-breakdown");
    await rememberScoreCard(score, 2, 5);
    await expect(
      score.locator(".scored-word-tiles").first(),
    ).toHaveAccessibleName("CAT");
    await expect(
      score
        .locator(".scored-word")
        .first()
        .locator('[aria-label="T, 0 points"]'),
    ).toHaveCount(1);
    const skipped = other
      .getByTestId("move-celebration")
      .getByTestId("score-breakdown");
    await rememberScoreCard(skipped, 2, 5);
    await skipped.getByTestId("score-show-total").click();
    await expect(skipped).toHaveAttribute("data-score-phase", "move-total");
    await expect(skipped.getByTestId("running-score")).toHaveText("9");
    await expectSameScoreCard(skipped);
    await other.waitForTimeout(2300);
    await expectSameScoreCard(skipped);
    await expect(skipped.getByTestId("score-total")).toHaveText(
      /Move total\s*9$/,
    );
    await other.screenshot({
      path: info.outputPath("crossword-show-total-same-card.png"),
      fullPage: false,
    });
    await expect
      .poll(
        async () =>
          (await observedScores(page)).some(
            (step) =>
              step.word === 1 && step.phase === "intro" && step.score === 0,
          ),
        { intervals: [30] },
      )
      .toBe(true);
    await expect(
      score.locator(".scored-word-tiles").last(),
    ).toHaveAccessibleName("AT");
    await expect(
      score
        .locator(".scored-word")
        .last()
        .locator('[aria-label="T, 0 points"]'),
    ).toHaveCount(1);
    await expectSameScoreCard(score);
    await page.screenshot({
      path: info.outputPath("crossword-second-page-blank.png"),
      fullPage: false,
    });
    await expect(score).toHaveAttribute("data-score-phase", "move-total");
    await expect(score.getByTestId("score-total")).toHaveText(
      /Move total\s*9$/,
    );
    await expectSameScoreCard(score);
    const recap = score.getByTestId("score-word-list");
    await expect(recap.locator(".scored-word-tiles")).toHaveCount(2);
    await expect(recap.locator('[aria-label="T, 0 points"]')).toHaveCount(2);
    await expect(recap.locator('[data-premium="DW"]')).toHaveCount(1);
    await expect(recap.locator('[data-premium="DL"]')).toHaveCount(0);
    for (const oldA of await recap.locator('[aria-label="A, 1 points"]').all())
      await expect(oldA.getByTestId("score-letter-premium")).toHaveCount(0);
    await expect(recap.locator(".score-equation").first()).toHaveText(
      /3 \+ 1 \+ 0.*Whole word: 4 × 2 = 8.*CAT = 8 points/,
    );
    await expect(recap.locator(".score-equation").last()).toHaveText(
      /1 \+ 0.*AT = 1 points/,
    );
    const records = await observedScores(page);
    expect(
      records
        .filter((step) => step.phase === "word-total")
        .map((step) => [step.word, step.score]),
    ).toEqual([
      [0, 8],
      [1, 1],
    ]);
    expect(
      records
        .filter(
          (step) =>
            step.phase === "letter" && step.tile === 1 && step.word === 1,
        )
        .map((step) => step.score),
    ).toEqual([1]);
    const game = (await db.doc("games/ui-table").get()).data()!;
    expect(
      game.lastMove.breakdown.words.map(
        (word: { word: string; score: number }) => [word.word, word.score],
      ),
    ).toEqual([
      ["CAT", 8],
      ["AT", 1],
    ]);
    expect(game.scores.mom).toBe(9);
    await page.screenshot({
      path: info.outputPath("crossword-nine-final-points.png"),
      fullPage: false,
    });
  } finally {
    await otherContext.close();
  }
});

test("a fifteen-letter accepted word wraps its large faces and adds a single seven-tile bonus", async ({
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
  const board = Object.fromEntries(
    [..."EXTRACUR"].map((letter, col) => [
      `7,${col}`,
      { ...take(letter), row: 7, col },
    ]),
  );
  tiles = [..."RICULAR"].map(take);
  await writeFixture({
    ...fixtureGame,
    board,
    racks: { mom: tiles, aunt: [..."SENLADU"].map(take) },
    bag: pool,
  });
  await enroll(page);
  for (const [index, tile] of tiles.entries()) {
    await page.getByTestId(`rack-tile-${tile.id}`).tap();
    await cell(page, 7, 8 + index).tap();
  }
  await expect(page.getByTestId("word-check")).toHaveAttribute(
    "data-state",
    "recognized",
  );
  await observeScoreSteps(page);
  expectedRevision = 1;
  expectedCommandCount = 1;
  expectedBoardKeys = Array.from({ length: 15 }, (_, col) => `7,${col}`);
  await page.getByTestId("play-word").click();
  const score = page
    .getByTestId("move-celebration")
    .getByTestId("score-breakdown");
  await rememberScoreCard(score, 1, 15);
  await expect(score.locator(".tile-letter")).toHaveText([
    ..."EXTRACURRICULAR",
  ]);
  await expect(page.getByTestId("move-celebration")).toHaveCSS(
    "transform",
    "none",
  );
  const faces = await score.locator(".score-letter").evaluateAll((elements) =>
    elements.map((element) => {
      const r = element.getBoundingClientRect();
      const container = element.parentElement!.getBoundingClientRect();
      return {
        top: r.top,
        left: r.left,
        right: r.right,
        width: (element as HTMLElement).offsetWidth,
        containerLeft: container.left,
        containerRight: container.right,
      };
    }),
  );
  expect(
    new Set(faces.map((face) => Math.round(face.top))).size,
  ).toBeGreaterThan(1);
  for (const face of faces) {
    expect(face.width).toBeGreaterThanOrEqual(48);
    expect(face.left).toBeGreaterThanOrEqual(face.containerLeft);
    expect(face.right).toBeLessThanOrEqual(face.containerRight);
  }
  await page.screenshot({
    path: info.outputPath("fifteen-large-letter-faces.png"),
    fullPage: false,
  });
  await expect(score).toHaveAttribute("data-score-phase", "bingo", {
    timeout: 16000,
  });
  await expect(score.getByTestId("score-bingo")).toHaveText("Seven tiles +50");
  const game = (await db.doc("games/ui-table").get()).data()!;
  expect(game.lastMove.breakdown.bingoBonus).toBe(50);
  expect(game.lastMove.breakdown.words[0].word).toBe("EXTRACURRICULAR");
  expect(game.lastMove.breakdown.total).toBe(
    game.lastMove.breakdown.words[0].score + 50,
  );
  await page.screenshot({
    path: info.outputPath("fifteen-letter-bingo-total.png"),
    fullPage: false,
  });
  await expect(score).toHaveAttribute("data-score-phase", "move-total");
  await expectSameScoreCard(score);
  const recap = score.getByTestId("score-word-list");
  await expect(recap.locator(".tile-letter")).toHaveText([
    ..."EXTRACURRICULAR",
  ]);
  const wordScore = game.lastMove.breakdown.words[0];
  const committedScores = wordScore.tiles.filter(
    (tile: { isNew: boolean }) => !tile.isNew,
  );
  expect(committedScores).toHaveLength(8);
  expect(
    committedScores.every(
      (tile: { premium: string | null; letterMultiplier: number }) =>
        tile.premium === null && tile.letterMultiplier === 1,
    ),
  ).toBe(true);
  const newPremiums = wordScore.tiles
    .filter((tile: { premium: string | null }) => tile.premium !== null)
    .map((tile: { premium: string }) => tile.premium);
  // Real accepted scoring supplies the new premiums; committed col3/7 bonuses are spent.
  await expect(recap.getByTestId("score-premium-badge")).toHaveText(
    newPremiums,
  );
  await expectScoredPointsClear(recap);
  const overflow = await recap.evaluate((element) => ({
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflow: getComputedStyle(element).overflowY,
  }));
  expect(overflow.height).toBeLessThanOrEqual(300);
  expect(overflow.overflow).toBe("auto");
  if (overflow.scrollHeight > overflow.height) {
    await recap.evaluate(
      (element) => (element.scrollTop = element.scrollHeight),
    );
    await expect(recap.locator(".score-equation strong")).toBeInViewport();
  }
  await page.screenshot({
    path: info.outputPath("fifteen-letter-premiums-final-recap.png"),
    fullPage: false,
  });
  expect(
    (await observedScores(page)).filter((step) => step.phase === "bingo"),
  ).toHaveLength(1);
});

test("a private sign-in link prefills the intended player and six-digit code without signing in", async ({
  page,
}) => {
  const before = await authoritativeState();
  await page.goto("/#player=Rita&code=000123");
  await expect(page.getByTestId("login-player")).toHaveValue("aunt");
  await expect(page.getByTestId("login-password")).toHaveValue("000123");
  expect(new URL(page.url()).hash).toBe("");
  await expect(page.getByTestId("game-board")).toHaveCount(0);
  expect(await authoritativeState()).toEqual(before);
});

async function expectScoredPointsClear(scope: Locator) {
  const overlaps = await scope.evaluate((element) => {
    const badges = [
      ...element.querySelectorAll('[data-testid="score-letter-premium"]'),
    ].map((node) => node.getBoundingClientRect());
    const points = [...element.querySelectorAll(".score-letter > small")].map(
      (node) => node.getBoundingClientRect(),
    );
    return badges.flatMap((badge, index) =>
      points
        .filter(
          (point) =>
            Math.min(badge.right, point.right) >
              Math.max(badge.left, point.left) &&
            Math.min(badge.bottom, point.bottom) >
              Math.max(badge.top, point.top),
        )
        .map(() => index),
    );
  });
  expect(overlaps).toEqual([]);
}

test("a real high-scoring right-edge move keeps its celebration and stars inside the board", async ({
  page,
  browser,
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
  const { aunt: recipient, auntContext: recipientContext } =
    await joinRita(browser);
  try {
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
    await observeScoreSteps(page);
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
    await expect(actual).toHaveCSS("transform", "none");
    const progressive = actual.getByTestId("score-breakdown");
    await rememberScoreCard(progressive, 1, 6);
    const reduced = recipient
      .getByTestId("move-celebration")
      .getByTestId("score-breakdown");
    await expect(reduced).toHaveAttribute("data-score-phase", "complete");
    await expect(reduced.locator(".tile-letter")).toHaveText([..."QUARTZ"]);
    await expect(reduced.locator(".score-equation")).toHaveText(
      /10 \+ 1 \+ 1×2 \+ 1 \+ 1 \+ 10.*Whole word: 25 × 3 = 75.*QUARTZ = 75 points/,
    );
    await expect(reduced.getByTestId("score-total")).toHaveText(
      /Move total\s*75$/,
    );
    await expect(reduced.getByTestId("score-premium-badge")).toHaveText([
      "DL",
      "TW",
    ]);
    await expect(
      reduced
        .getByTestId("score-letter-premium")
        .getByTestId("score-premium-badge"),
    ).toHaveAccessibleName("Double letter");
    await expect(reduced.getByTestId("score-word-premium")).toHaveText(
      /TW\s*Whole word: 25 × 3 = 75/,
    );
    await expectScoredPointsClear(reduced);
    await recipient.screenshot({
      path: info.outputPath("quartz-premiums-reduced-portrait.png"),
      fullPage: false,
    });
    await expect(progressive.locator(".tile-letter")).toHaveText([..."QUARTZ"]);
    const dimensions = await actual.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const frame = document
        .querySelector(".board-frame")!
        .getBoundingClientRect();
      const tile = element.querySelector(".score-letter") as HTMLElement;
      const label = element.querySelector(".score-count-beat > span")!;
      return {
        width: rect.width,
        centerX: rect.x + rect.width / 2,
        centerY: rect.y + rect.height / 2,
        frameX: frame.x + frame.width / 2,
        frameY: frame.y + frame.height / 2,
        tileWidth: tile.offsetWidth,
        tileHeight: tile.offsetHeight,
        labelSize: parseFloat(getComputedStyle(label).fontSize),
      };
    });
    expect(dimensions.width).toBeGreaterThanOrEqual(420);
    expect(dimensions.width).toBeLessThanOrEqual(520);
    expect(Math.abs(dimensions.centerX - dimensions.frameX)).toBeLessThan(2);
    expect(Math.abs(dimensions.centerY - dimensions.frameY)).toBeLessThan(2);
    expect(dimensions.tileWidth).toBeGreaterThanOrEqual(48);
    expect(dimensions.tileHeight).toBeGreaterThanOrEqual(48);
    expect(dimensions.labelSize).toBeGreaterThanOrEqual(20);
    const bounds = await actual.evaluate((element) => {
      const rects = [
        element,
        element.querySelector('[data-testid="celebration-starburst"]')!,
      ].map((node) => {
        const r = node.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
      const frame = document
        .querySelector(".board-frame")!
        .getBoundingClientRect();
      return {
        rects,
        frame: {
          left: frame.left,
          right: frame.right,
          top: frame.top,
          bottom: frame.bottom,
        },
      };
    });
    for (const rect of bounds.rects) {
      expect(rect.left).toBeGreaterThanOrEqual(bounds.frame.left);
      expect(rect.right).toBeLessThanOrEqual(bounds.frame.right);
      expect(rect.top).toBeGreaterThanOrEqual(bounds.frame.top);
      expect(rect.bottom).toBeLessThanOrEqual(bounds.frame.bottom);
    }
    await expect
      .poll(
        async () =>
          (await observedScores(page)).some(
            (step) =>
              step.phase === "letter-bonus" &&
              step.tile === 2 &&
              step.score === 13,
          ),
        { intervals: [30], timeout: 8000 },
      )
      .toBe(true);
    await page.screenshot({
      path: info.outputPath("quartz-large-letter-bonus.png"),
      fullPage: false,
    });
    await expect
      .poll(
        async () =>
          (await observedScores(page)).some(
            (step) => step.phase === "word-bonus" && step.score === 75,
          ),
        { intervals: [30] },
      )
      .toBe(true);
    await page.screenshot({
      path: info.outputPath("quartz-triple-word.png"),
      fullPage: false,
    });
    await expect(progressive).toHaveAttribute("data-score-phase", "word-total");
    const countedView = await actual.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      scroll: element.querySelector('[data-testid="score-word-list"]')!
        .scrollTop,
    }));
    await expectSameScoreCard(progressive);
    await expect(progressive).toHaveAttribute("data-score-phase", "move-total");
    await expectSameScoreCard(progressive);
    const finalView = await actual.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      scroll: element.querySelector('[data-testid="score-word-list"]')!
        .scrollTop,
    }));
    expect(Math.abs(finalView.height - countedView.height)).toBeLessThan(0.5);
    expect(Math.abs(finalView.scroll - countedView.scroll)).toBeLessThan(0.5);
    await expect(progressive.getByTestId("score-total")).toHaveText(
      /Move total\s*75$/,
    );
    await page.screenshot({
      path: info.outputPath("actual-high-score-right-edge.png"),
      fullPage: false,
    });
    const recap = progressive.getByTestId("score-word-list");
    await expect(recap.getByTestId("score-premium-badge")).toHaveText([
      "DL",
      "TW",
    ]);
    await expect(recap.locator(".score-equation")).toHaveText(
      /10 \+ 1 \+ 1×2 \+ 1 \+ 1 \+ 10.*Whole word: 25 × 3 = 75.*QUARTZ = 75 points/,
    );
    const badges = await recap
      .getByTestId("score-premium-badge")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            font: parseFloat(getComputedStyle(element).fontSize),
          };
        }),
      );
    for (const badge of badges) {
      expect(badge.width).toBeGreaterThanOrEqual(32);
      expect(badge.height).toBeGreaterThanOrEqual(30);
      expect(badge.font).toBeGreaterThanOrEqual(16);
    }
    await expectScoredPointsClear(recap);
    await page.waitForTimeout(2300);
    await expectSameScoreCard(progressive);
    await expect(progressive).toHaveAttribute("data-score-phase", "move-total");
    await expect(recap.getByTestId("score-premium-badge")).toHaveText([
      "DL",
      "TW",
    ]);
    await expect(recap.getByTestId("score-word-premium")).toHaveText(
      /Whole word: 25 × 3 = 75/,
    );
    await expect(page.getByTestId("turn-announcement")).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("quartz-premiums-readable-final-hold.png"),
      fullPage: false,
    });
    const observed = await observedScores(page);
    expect(
      observed
        .filter(
          (step) =>
            step.phase === "letter" ||
            step.phase === "letter-bonus" ||
            step.phase === "word-bonus",
        )
        .map((step) => [step.phase, step.tile, step.score]),
    ).toEqual([
      ["letter", 0, 10],
      ["letter", 1, 11],
      ["letter", 2, 12],
      ["letter-bonus", 2, 13],
      ["letter", 3, 14],
      ["letter", 4, 15],
      ["letter", 5, 25],
      ["word-bonus", null, 75],
    ]);
    const game = (await db.doc("games/ui-table").get()).data()!;
    expect(game.lastMove.words).toEqual(["QUARTZ"]);
    expect(game.lastMove.score).toBe(75);
    expect(game.scores.mom).toBe(75);
    await expect(page.getByTestId("move-celebration")).toHaveCount(0);
    await expect(recipient.getByTestId("move-celebration")).toHaveCount(0);
    for (const view of [page, recipient]) {
      await view.getByTestId("score-details").click();
      const popup = view.getByTestId("score-details-popup");
      await expect(popup).toBeVisible();
      await expect(popup).toHaveCSS("opacity", "1");
      await expect(popup).toHaveCSS("transform", "none");
      await expect(
        popup.getByTestId("score-breakdown").getByTestId("score-total"),
      ).toHaveText(/Move total\s*75$/);
      await expect(popup.locator(".tile-letter")).toHaveText([..."QUARTZ"]);
      await expect(popup.getByTestId("score-premium-badge")).toHaveText([
        "DL",
        "TW",
      ]);
      await expect(popup.getByTestId("score-word-premium")).toHaveText(
        /Whole word: 25 × 3 = 75/,
      );
      await expectScoredPointsClear(popup);
      if (view === page) {
        await view.screenshot({
          path: info.outputPath("authoritative-score-details.png"),
          fullPage: false,
        });
        await view.evaluate(
          () => (document.documentElement.dataset.theme = "midnight"),
        );
        await view.setViewportSize({ width: 820, height: 1180 });
        await expect(popup).toHaveCSS("opacity", "1");
        await checkTextContrast(
          view,
          '[data-testid="score-details-popup"] .score-equation, [data-testid="score-details-popup"] .tile-letter, [data-testid="score-details-popup"] .score-letter > small',
        );
        await view.screenshot({
          path: info.outputPath(
            "authoritative-score-details-dark-portrait.png",
          ),
          fullPage: false,
        });
      }
      await popup.getByRole("button", { name: "Close dialog" }).click();
    }
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { scoreTurnOverlaps: number[] })
            .scoreTurnOverlaps,
      ),
    ).toEqual([]);
    expect((await db.collection("games/ui-table/commands").get()).size).toBe(1);
    expect((await db.doc("games/ui-table").get()).data()?.history).toHaveLength(
      1,
    );
  } finally {
    await recipientContext.close();
  }
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
    await openInvitationForm(aunt);
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
      await openInvitationForm(aunt);
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
    await openInvitationForm(aunt);
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

test("private sign-in adds a remembered device without replacing the original player or changing the game", async ({
  page,
  browser,
}, info) => {
  const password = "maple river sunrise";
  await db.doc("playerCredentials/mom").set({
    ...(await createCredential(password)),
    enabled: true,
    updatedAt: Date.now(),
  });
  await enroll(page);
  const originalUid = (await db.doc("players/mom").get()).data()!.uid;
  const gameBefore = (await db.doc("games/ui-table").get()).data();
  const rackBefore = (await db.doc("games/ui-table/racks/mom").get()).data();
  const extraContext = await browser.newContext({
    baseURL: "http://127.0.0.1:5183",
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
  });
  try {
    const extra = await extraContext.newPage();
    await extra.goto("/");
    await expect(extra.getByTestId("login-player")).toBeVisible();
    await expect(extra.getByTestId("setup-code")).toHaveCount(0);
    await extra.getByTestId("login-player").selectOption("mom");
    await extra.getByTestId("login-password").fill("wrong private phrase");
    await extra.getByTestId("enroll-submit").click();
    await expect(extra.getByRole("alert")).toContainText(
      "player or sign-in code is not correct",
    );
    expect((await db.collection("bindings").get()).size).toBe(1);
    await extra.getByTestId("login-password").fill("MAPLE-RIVER-SUNRISE");
    await extra.getByTestId("enroll-submit").click();
    await expect(extra.getByTestId("game-board")).toBeVisible();
    await expect(extra.getByTestId("turn-status")).toHaveText("Your turn");
    await expect(page.getByTestId("turn-status")).toHaveText("Your turn");
    expect((await db.doc("players/mom").get()).data()!.uid).toBe(originalUid);
    const bindings = await db.collection("bindings").get();
    expect(bindings.size).toBe(2);
    expect(bindings.docs.every((entry) => entry.data().slot === "mom")).toBe(
      true,
    );
    await extra.reload();
    await expect(extra.getByTestId("game-board")).toBeVisible();
    await expect(extra.getByTestId("login-password")).toHaveCount(0);
    expect((await db.collection("bindings").get()).size).toBe(2);
    expect((await db.doc("games/ui-table").get()).data()).toEqual(gameBefore);
    expect((await db.doc("games/ui-table/racks/mom").get()).data()).toEqual(
      rackBefore,
    );
    expect(
      await extra.evaluate(
        (password) =>
          Object.values(localStorage).some((value) => value.includes(password)),
        password,
      ),
    ).toBe(false);
    await extra.screenshot({
      path: info.outputPath("reusable-login-second-device.png"),
      fullPage: true,
    });
  } finally {
    await extraContext.close();
  }
});

test("screen awake handles device refusal and reacquires only while visible without changing the game", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    const state = { allow: false, hidden: false, requests: 0, releases: 0 };
    (window as unknown as { awakeTest: typeof state }).awakeTest = state;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => state.hidden,
    });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        async request(type: string) {
          if (type !== "screen") throw new Error("Unexpected lock type");
          state.requests++;
          if (!state.allow)
            throw new DOMException("Device refused", "NotAllowedError");
          const lock = new EventTarget() as EventTarget & {
            released: boolean;
            release(): Promise<void>;
          };
          lock.released = false;
          lock.release = async () => {
            if (!lock.released) {
              lock.released = true;
              state.releases++;
              lock.dispatchEvent(new Event("release"));
            }
          };
          return lock;
        },
      },
    });
  });
  await enroll(page);
  await page.getByTestId("help-settings").click();
  const toggle = page.getByTestId("keep-screen-awake");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(page.getByTestId("screen-awake-status")).toContainText(
    /couldn’t keep.*awake/i,
  );
  const state = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            awakeTest: { requests: number; releases: number };
          }
        ).awakeTest,
    );
  const refused = await state();
  await page.evaluate(() => {
    (window as unknown as { awakeTest: { allow: boolean } }).awakeTest.allow =
      true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByTestId("screen-awake-status")).toContainText(
    "Screen stays awake",
  );
  expect((await state()).requests).toBeGreaterThan(refused.requests);
  await page.evaluate(() => {
    (window as unknown as { awakeTest: { hidden: boolean } }).awakeTest.hidden =
      true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(async () => (await state()).releases).toBeGreaterThan(0);
  const hiddenRequests = (await state()).requests;
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  expect((await state()).requests).toBe(hiddenRequests);
  await page.evaluate(() => {
    (window as unknown as { awakeTest: { hidden: boolean } }).awakeTest.hidden =
      false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByTestId("screen-awake-status")).toContainText(
    "Screen stays awake",
  );
  await page.getByTestId("check-for-updates").click();
  await expect(page.getByTestId("app-update-status")).toContainText(
    "Updates are available on the published app",
  );
  await page.screenshot({
    path: info.outputPath("device-awake-settings.png"),
    fullPage: false,
  });
  await toggle.uncheck();
  expect(
    await page.evaluate(() => localStorage.getItem("tea-and-tiles:keep-awake")),
  ).toBe("false");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.reload();
  await expect(page.getByTestId("game-board")).toBeVisible();
  await page.getByTestId("help-settings").click();
  await expect(page.getByTestId("keep-screen-awake")).not.toBeChecked();
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
    await openInvitationForm(aunt);
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

test("opponent presence follows foreground heartbeats, expiry, extra devices and offline state without changing the game", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(150_000);
  await enroll(page);
  const { aunt, auntContext } = await joinRita(browser);
  const requests: string[] = [];
  const observe = (target: Page) =>
    target.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes(":5101/"))
        requests.push(request.url());
    });
  try {
    const momUid = (await db.doc("players/mom").get()).data()!.uid as string;
    const auntUid = (await db.doc("players/aunt").get()).data()!.uid as string;
    const ownRef = db.doc(`pairs/family/presence/${momUid}`);
    const otherRef = db.doc(`pairs/family/presence/${auntUid}`);
    const badge = page.getByTestId("player-presence-aunt");
    const recipientBadge = aunt.getByTestId("player-presence-mom");
    await expect(badge).toHaveAttribute("data-state", "present");
    await expect(badge).toHaveText("At the table");
    await expect(recipientBadge).toHaveAttribute("data-state", "present");
    await expect(page.getByTestId("player-presence-mom")).toHaveCount(0);
    await expect(aunt.getByTestId("player-presence-aunt")).toHaveCount(0);
    await expect(page.getByTestId("connection-status")).toHaveCount(0);
    await expect(page.locator(".current-player .player-caption")).toHaveText(
      "Your turn",
    );
    await expect(aunt.locator(".current-player .player-caption")).toHaveText(
      "Their turn",
    );
    const before = await authoritativeState();
    const momInitial = (await ownRef.get()).data()!.lastSeen.toMillis();
    const auntInitial = (await otherRef.get()).data()!.lastSeen.toMillis();
    observe(page);
    observe(aunt);
    await page.screenshot({
      path: info.outputPath("presence-at-table-landscape.png"),
      fullPage: false,
    });
    await aunt.screenshot({
      path: info.outputPath("presence-at-table-portrait.png"),
      fullPage: false,
    });
    await aunt.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Wait a real heartbeat period: a hidden tab must not write, while a visible
    // player continues updating. Advancing fake time would not prove this.
    await page.waitForTimeout(61_000);
    expect((await otherRef.get()).data()!.lastSeen.toMillis()).toBe(
      auntInitial,
    );
    await expect
      .poll(async () => (await ownRef.get()).data()!.lastSeen.toMillis(), {
        timeout: 8000,
      })
      .toBeGreaterThan(momInitial);
    // Start just inside the fresh window. No further snapshot is sent; the
    // five-second local clock must switch this badge to Away after expiry.
    await otherRef.update({
      lastSeen: Timestamp.fromMillis(Date.now() - 118_000),
    });
    await expect(badge).toHaveAttribute("data-state", "present");
    await expect(badge).toHaveAttribute("data-state", "away", {
      timeout: 9000,
    });
    await expect(badge).toHaveText("Away");
    await page.screenshot({
      path: info.outputPath("presence-away-landscape.png"),
      fullPage: false,
    });
    expect(requests).toEqual([]);
    const secondary = db.doc("pairs/family/presence/fixture-extra-aunt-device");
    await secondary.set({ slot: "aunt", lastSeen: Timestamp.now() });
    await expect(badge).toHaveAttribute("data-state", "present");
    await secondary.delete();
    await expect(badge).toHaveAttribute("data-state", "away");
    const staleSeen = (await otherRef.get()).data()!.lastSeen.toMillis();
    await aunt.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect
      .poll(async () => (await otherRef.get()).data()!.lastSeen.toMillis())
      .toBeGreaterThan(staleSeen);
    await expect(badge).toHaveAttribute("data-state", "present");
    await page.context().setOffline(true);
    await expect(page.getByTestId("connection-status")).toHaveText(
      "Reconnecting",
    );
    await expect(badge).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("presence-unknown-offline.png"),
      fullPage: false,
    });
    await page.context().setOffline(false);
    await expect(page.getByTestId("connection-status")).toHaveCount(0);
    await expect(badge).toHaveAttribute("data-state", "present");
    expect(requests).toEqual([]);
    expect(await authoritativeState()).toEqual(before);
  } finally {
    await page.context().setOffline(false);
    await auntContext.close();
  }
});

test("an available update sits beside New game, is keyboard reachable and stays guarded during dragging", async ({
  page,
  context,
}, info) => {
  // Supply only update availability/apply acknowledgement. Parent PWA tests
  // exercise the real waiting worker; this case measures the actual App toolbar.
  await page.route("**/src/hooks/useAppUpdate.ts*", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `export function useAppUpdate() { return { available:true,checking:false,status:"An update is ready.",error:null,check:async()=>{},apply:async()=>{window.updateApplyCount=(window.updateApplyCount||0)+1;} }; }`,
    }),
  );
  await enroll(page);
  const before = await authoritativeState();
  for (const [width, height] of [
    [1024, 768],
    [820, 1180],
  ]) {
    await page.setViewportSize({ width, height });
    const update = page.getByTestId("apply-update");
    const newGame = page.getByTestId("new-game");
    await expect(update).toBeVisible();
    await expect(update).toBeEnabled();
    const geometry = await update.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const action = document.querySelector('[data-testid="new-game"]')!;
      const next = action.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        newRight: next.right,
        newTop: next.top,
        nextSibling: action.nextElementSibling?.getAttribute("data-testid"),
      };
    });
    expect(geometry.nextSibling).toBe("app-update-banner");
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.newRight);
    expect(Math.abs(geometry.top - geometry.newTop)).toBeLessThan(2);
    expect(geometry.height).toBeGreaterThanOrEqual(44);
    expect(geometry.right).toBeLessThanOrEqual(width);
    expect(geometry.bottom).toBeLessThanOrEqual(height);
    await update.focus();
    await expect(update).toBeFocused();
    await page.keyboard.press("Enter");
    await page.screenshot({
      path: info.outputPath(`inline-update-${width}x${height}.png`),
      fullPage: false,
    });
    await expect(newGame).toBeEnabled();
  }
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { updateApplyCount: number }).updateApplyCount,
    ),
  ).toBe(2);
  const session = await context.newCDPSession(page);
  await touch(session, "touchStart", await point(rack(page, "Q")));
  await touch(session, "touchMove", await point(cell(page, 7, 7)));
  await expect(page.getByTestId("drag-ghost")).toBeVisible();
  await expect(page.getByTestId("apply-update")).toBeDisabled();
  await touch(session, "touchCancel");
  await expect(page.getByTestId("drag-ghost")).toHaveCount(0);
  await expect(page.getByTestId("settling-ghost")).toHaveCount(0);
  await expect(page.getByTestId("apply-update")).toBeEnabled();
  expect(await authoritativeState()).toEqual(before);
});

test("a brighter private draft breathes across complete words and crossings without moving board squares", async ({
  page,
  context,
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
  const board = Object.fromEntries(
    [..."TIN"].map((letter, index) => [
      `6,${7 + index}`,
      { ...take(letter), row: 6, col: 7 + index },
    ]),
  );
  board["7,7"] = { ...take("A"), row: 7, col: 7 };
  tiles = [..."CTEROL?"].map(take);
  await writeFixture({
    ...fixtureGame,
    board,
    racks: { mom: tiles, aunt: [..."SENLADU"].map(take) },
    bag: pool,
  });
  await enroll(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "blue-ink");
  const before = await authoritativeState();
  const luminance = async (tile: Locator) =>
    tile.evaluate((element) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      const colors = getComputedStyle(element).backgroundImage.match(
        /rgba?\([^)]*\)|color\(srgb[^)]*\)/g,
      );
      if (!colors?.length) throw new Error("Tile gradient is not measurable");
      return (
        colors
          .map((color) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data]
              .slice(0, 3)
              .map((value) => value / 255)
              .map((value) =>
                value <= 0.04045
                  ? value / 12.92
                  : ((value + 0.055) / 1.055) ** 2.4,
              )
              .reduce(
                (sum, value, index) =>
                  sum + value * [0.2126, 0.7152, 0.0722][index],
                0,
              );
          })
          .reduce((sum, value) => sum + value, 0) / colors.length
      );
    });
  const handBrightness = await luminance(rack(page, "C"));
  const oldBrightness = await luminance(
    cell(page, 7, 7).locator(".board-tile"),
  );
  for (const [letter, col] of [
    ["C", 6],
    ["T", 8],
  ] as const) {
    await rack(page, letter).tap();
    await cell(page, 7, col).tap();
  }
  await expect(page.getByTestId("word-check")).toHaveAttribute(
    "data-state",
    "recognized",
  );
  const membership = () =>
    page
      .locator('[data-draft-word="true"]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-testid")).sort(),
      );
  await expect
    .poll(membership)
    .toEqual([
      "board-cell-6-8",
      "board-cell-7-6",
      "board-cell-7-7",
      "board-cell-7-8",
    ]);
  expect(
    await luminance(cell(page, 7, 6).locator(".board-tile")),
  ).toBeGreaterThan(Math.max(handBrightness, oldBrightness) + 0.005);
  await expect(page.getByTestId("draft-word-pulse")).toHaveCount(4);
  for (const [row, col] of [
    [6, 8],
    [7, 6],
    [7, 7],
    [7, 8],
  ]) {
    const tile = cell(page, row, col).locator(".board-tile");
    await expect(tile).toHaveCSS("transform", "none");
    const pulse = tile.getByTestId("draft-word-pulse");
    await expect(pulse).toHaveCSS("pointer-events", "none");
    await expect(pulse).toHaveCSS("animation-name", "draft-word-breathe");
    await expect(pulse).toHaveCSS("z-index", "0");
    await expect(tile.locator(".tile-letter")).toHaveCSS("z-index", "1");
    await expect(pulse).toHaveCSS("transform", "none");
    await expect(pulse).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const edge = await pulse.evaluate((element) => {
      const style = getComputedStyle(element, "::after");
      return {
        mask: style.maskImage,
        composite: style.maskComposite,
        padding: parseFloat(style.paddingTop),
        background: style.backgroundImage,
        pointerEvents: style.pointerEvents,
        direction: style.animationDirection,
        repeat: style.backgroundRepeat,
        delay: style.animationDelay,
      };
    });
    expect(edge.mask).toContain("gradient");
    expect(edge.composite).toContain("exclude");
    expect(edge.padding).toBe(2);
    expect(edge.background).toContain("gradient");
    expect(edge.pointerEvents).toBe("none");
    expect(edge.direction).toBe("normal");
    expect(edge.repeat).toBe("no-repeat");
    expect(edge.delay).toBe("0s");
  }
  const readings = await page.evaluate(async () => {
    const members = [
      ...document.querySelectorAll('[data-draft-word="true"] .board-tile'),
    ];
    const samples: {
      opacity: number;
      rects: number[][];
      squares: number[][];
      scales: number[];
      clocks: number[][];
      transforms: string[];
      widths: number[];
    }[] = [];
    const start = performance.now();
    return await new Promise<typeof samples>((resolve) => {
      const rect = (element: Element) => {
        const r = element.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      };
      const frame = () => {
        samples.push({
          opacity: Number(
            getComputedStyle(
              document.querySelector('[data-testid="draft-word-pulse"]')!,
            ).opacity,
          ),
          rects: members.map(rect),
          squares: members.map((element) => rect(element.parentElement!)),
          scales: members.map((element) =>
            Number(getComputedStyle(element).scale),
          ),
          clocks: members.map((element) =>
            element
              .getAnimations()
              .map((animation) => Number(animation.currentTime)),
          ),
          transforms: members.map(
            (element) => getComputedStyle(element).transform,
          ),
          widths: members.map((element) =>
            parseFloat(getComputedStyle(element).width),
          ),
        });
        if (performance.now() - start >= 2800) resolve(samples);
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  });
  await info.attach("pulse-geometry-clocks", {
    body: JSON.stringify(readings),
    contentType: "application/json",
  });
  const opacities = readings.map((frame) => frame.opacity);
  expect(Math.max(...opacities) - Math.min(...opacities)).toBeGreaterThan(0.05);
  const minima = readings[0].rects.map((_, index) =>
    Math.min(...readings.map((frame) => frame.rects[index][2])),
  );
  for (let index = 0; index < minima.length; index++) {
    const maximum = Math.max(...readings.map((frame) => frame.rects[index][2]));
    expect(maximum / minima[index]).toBeGreaterThanOrEqual(1.03);
    expect(maximum / minima[index]).toBeLessThanOrEqual(1.061);
  }
  for (const frame of readings) {
    expect(Math.max(...frame.scales) - Math.min(...frame.scales)).toBeLessThan(
      0.0001,
    );
    const scales = frame.rects.map(
      (rect, index) => rect[2] / frame.widths[index],
    );
    expect(Math.max(...scales) - Math.min(...scales)).toBeLessThan(0.003);
    for (let index = 0; index < frame.rects.length; index++) {
      for (const axis of [0, 1])
        expect(
          Math.abs(
            frame.rects[index][axis] +
              frame.rects[index][axis + 2] / 2 -
              (readings[0].rects[index][axis] +
                readings[0].rects[index][axis + 2] / 2),
          ),
        ).toBeLessThan(0.3);
      for (let axis = 0; axis < 4; axis++)
        expect(
          Math.abs(
            frame.squares[index][axis] - readings[0].squares[index][axis],
          ),
        ).toBeLessThan(0.3);
    }
  }
  const freeze = async (milliseconds: number) =>
    page.evaluate(async (milliseconds) => {
      const animations = [
        ...document.querySelectorAll('[data-draft-word="true"] .board-tile'),
      ]
        .flatMap((element) => element.getAnimations({ subtree: true }))
        .filter(
          (animation) =>
            animation instanceof CSSAnimation &&
            animation.animationName.startsWith("draft-"),
        );
      if (!animations.length)
        throw new Error("No actual draft animations found");
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = milliseconds;
      }
      await new Promise(requestAnimationFrame);
      return document
        .querySelector('[data-draft-word="true"] .board-tile')!
        .getBoundingClientRect().width;
    }, milliseconds);
  const sweep = await page.evaluate(async () => {
    const pulse = document.querySelector('[data-testid="draft-word-pulse"]')!;
    const sheen = pulse
      .getAnimations({ subtree: true })
      .find(
        (animation) =>
          animation instanceof CSSAnimation &&
          animation.animationName === "draft-word-sheen",
      )!;
    const timing = sheen.effect!.getTiming();
    sheen.pause();
    const sample = async (time: number) => {
      sheen.currentTime = time;
      await new Promise(requestAnimationFrame);
      return parseFloat(getComputedStyle(pulse, "::after").backgroundPositionX);
    };
    const duration = Number(timing.duration);
    const start = await sample(0);
    const middle = await sample(duration * 0.125);
    const end = await sample(duration * 0.25);
    const quietMiddle = await sample(duration * 0.5);
    const quietEnd = await sample(duration - 1);
    return { start, middle, end, quietMiddle, quietEnd, duration };
  });
  expect(sweep.start).toBeGreaterThanOrEqual(200);
  expect(sweep.middle).toBeGreaterThan(45);
  expect(sweep.middle).toBeLessThan(55);
  expect(sweep.end).toBeLessThanOrEqual(-100);
  expect(sweep.quietMiddle).toBe(sweep.end);
  expect(sweep.quietEnd).toBe(sweep.end);
  expect(sweep.duration * 0.75).toBeGreaterThanOrEqual(4000);
  const troughWidth = await freeze(0);
  await page.screenshot({
    path: info.outputPath("whole-draft-pulse-trough.png"),
    fullPage: false,
  });
  const seamStart = await cell(page, 7, 7).screenshot();
  await freeze(sweep.duration);
  const seamEnd = await cell(page, 7, 7).screenshot();
  await info.attach("sheen-loop-start", {
    body: seamStart,
    contentType: "image/png",
  });
  await info.attach("sheen-loop-end", {
    body: seamEnd,
    contentType: "image/png",
  });
  expect(seamEnd.equals(seamStart)).toBe(true);
  const peakWidth = await freeze(1200);
  expect(peakWidth / troughWidth).toBeGreaterThanOrEqual(1.03);
  expect(peakWidth / troughWidth).toBeLessThanOrEqual(1.061);
  await page.screenshot({
    path: info.outputPath("whole-draft-pulse-peak.png"),
    fullPage: false,
  });
  // WAAPI playback overrides CSS play-state. Restore native animations via the
  // persisted private draft before verifying drag/settle pause behavior.
  await page.reload();
  await expect
    .poll(membership)
    .toEqual([
      "board-cell-6-8",
      "board-cell-7-6",
      "board-cell-7-7",
      "board-cell-7-8",
    ]);
  await expect(page.getByTestId("draft-word-pulse")).toHaveCount(4);
  for (const tile of await page.locator(".draft-word-tile").all())
    await expect(tile).toHaveCSS("transform", "none");
  await checkTextContrast(
    page,
    ".draft-word-tile > .tile-letter, .draft-word-tile > small",
  );
  await page.screenshot({
    path: info.outputPath("whole-draft-cat-crossing-it.png"),
    fullPage: false,
  });
  const session = await context.newCDPSession(page);
  await touch(
    session,
    "touchStart",
    await point(cell(page, 7, 8).locator(".board-tile")),
  );
  await touch(session, "touchMove", await point(cell(page, 9, 10)));
  await expect(page.getByTestId("drag-ghost")).toBeVisible();
  await expect(page.getByTestId("game-board")).toHaveAttribute(
    "data-draft-pulse-paused",
    "true",
  );
  for (const pulse of await page.getByTestId("draft-word-pulse").all())
    await expect(pulse).toHaveCSS("animation-play-state", "paused");
  const readScales = () =>
    page.locator(".draft-word-tile").evaluateAll((elements) =>
      elements.map((element) => {
        const value = getComputedStyle(element).scale;
        return value === "none" ? 1 : Number(value);
      }),
    );
  const dragScales = await readScales();
  await page.waitForTimeout(250);
  expect(await readScales()).toEqual(dragScales);
  await page.evaluate(() => {
    const frames: Record<string, number[]> = {};
    (
      window as unknown as { settlingPulseScales: Record<string, number[]> }
    ).settlingPulseScales = frames;
    const sample = () => {
      if (document.querySelector('[data-testid="settling-ghost"]')) {
        for (const element of document.querySelectorAll(".draft-word-tile")) {
          const id = element.parentElement!.getAttribute("data-testid")!;
          const value = getComputedStyle(element).scale;
          (frames[id] ??= []).push(value === "none" ? 1 : Number(value));
        }
      }
      if (
        Object.keys(frames).length === 0 ||
        document.querySelector('[data-testid="settling-ghost"]')
      )
        requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await touch(session, "touchEnd");
  await expect(page.getByTestId("settling-ghost")).toHaveCount(0);
  const settlingScales = await page.evaluate(
    () =>
      (
        window as unknown as {
          settlingPulseScales: Record<string, number[]>;
        }
      ).settlingPulseScales,
  );
  expect(Object.keys(settlingScales).length).toBeGreaterThan(0);
  for (const scales of Object.values(settlingScales))
    expect(Math.max(...scales) - Math.min(...scales)).toBeLessThan(0.0001);
  await expect
    .poll(membership)
    .toEqual(["board-cell-7-6", "board-cell-7-7", "board-cell-9-10"]);
  await expect(page.locator(".board-tile.invalid-arrangement")).toHaveCount(2);
  await expect(cell(page, 7, 7).locator(".board-tile")).not.toHaveClass(
    /invalid-arrangement/,
  );
  const red = await cell(page, 9, 10)
    .locator(".board-tile")
    .evaluate((element) => {
      const style = getComputedStyle(element, "::after");
      return {
        border: style.borderColor,
        width: parseFloat(style.borderWidth),
        z: style.zIndex,
      };
    });
  expect(red.border).toBe("rgb(157, 61, 60)");
  expect(red.width).toBeGreaterThanOrEqual(2);
  expect(Number(red.z)).toBeGreaterThan(0);
  await expect(page.getByTestId("play-word")).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("invalid-draft-red-above-pulse.png"),
    fullPage: false,
  });
  await cell(page, 9, 10).tap();
  await cell(page, 7, 8).tap();
  await expect(page.getByTestId("play-word")).toBeEnabled();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByTestId("draft-word-pulse")).toHaveCount(4);
  for (const pulse of await page.getByTestId("draft-word-pulse").all())
    await expect(pulse).toHaveCSS("animation-name", "none");
  for (const tile of await page.locator(".draft-word-tile").all()) {
    await expect(tile).toHaveCSS("animation-name", "none");
    const scale = await tile.evaluate(
      (element) => getComputedStyle(element).scale,
    );
    expect(scale === "none" ? 1 : Number(scale)).toBe(1);
  }
  await page.getByTestId("recall-tiles").tap();
  await expect(page.getByTestId("draft-word-pulse")).toHaveCount(0);
  await expect(page.locator('[data-draft-word="true"]')).toHaveCount(0);
  await expect(page.locator(".has-tentative")).toHaveCount(0);
  await expect(page.getByTestId("tile-rack").locator("button")).toHaveCount(7);
  expect(await authoritativeState()).toEqual(before);
});
