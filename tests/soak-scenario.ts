import { expect, type Page, type TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";
import type { Game, Placement } from "../shared/engine";
import { findSoakMove } from "./soak-bot";
type SharedGame = Omit<Game, "racks" | "bag">;
const cell = (page: Page, row: number, col: number) =>
  page.getByTestId(`board-cell-${row}-${col}`);
export async function runSoak({
  page,
  aunt,
  info,
  dictionary,
  readGame,
  readPublicGame,
  onCommitted,
  environment,
  clock,
}: {
  page: Page;
  aunt: Page;
  info: TestInfo;
  dictionary: Set<string>;
  readGame: () => Promise<Game>;
  readPublicGame: () => Promise<SharedGame>;
  onCommitted?: (
    before: Game,
    placements: Placement[] | null,
    saved: SharedGame,
  ) => Promise<void>;
  environment: string;
  clock?: () => { serverOffsetMs: number; uncertaintyMs: number } | null;
}) {
  const turnLimit = Number(process.env.SOAK_TURNS || 60);
  const views = { mom: page, aunt };
  const results: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const networkEvents: Record<string, unknown>[] = [];
  for (const view of [page, aunt]) {
    view.on("pageerror", (error) => errors.push(error.message));
    view.on("requestfailed", (request) =>
      networkEvents.push({
        at: Date.now(),
        player: view === page ? "mom" : "aunt",
        url: request.url().split("?")[0],
        error: request.failure()?.errorText,
      }),
    );
    if (process.env.SOAK_CPU_RATE) {
      const session = await view.context().newCDPSession(view);
      await session.send("Emulation.setCPUThrottlingRate", {
        rate: Number(process.env.SOAK_CPU_RATE),
      });
    }
  }
  try {
    for (let turn = 0; turn < turnLimit; turn++) {
      const game = await readGame();
      if (game.status === "finished") break;
      const sender = views[game.turn],
        receiver = views[game.turn === "mom" ? "aunt" : "mom"];
      for (const view of [sender, receiver])
        await expect(view.getByTestId("move-celebration")).toHaveCount(0, {
          timeout: 60_000,
        });
      const placements = findSoakMove(game, dictionary);
      if (placements) {
        for (const placement of placements) {
          await sender.getByTestId(`rack-tile-${placement.tileId}`).tap();
          await cell(sender, placement.row, placement.col).tap();
          if (placement.letter)
            await sender.getByTestId(`blank-${placement.letter}`).tap();
        }
        await expect(sender.getByTestId("play-word")).toBeEnabled();
      } else {
        await sender.getByTestId("pass-turn").click();
        await expect(sender.getByTestId("confirm-pass")).toBeEnabled();
      }
      const count = Object.keys(game.board).length + (placements?.length || 0);
      // Observe DOM arrival independently of Playwright's polling cadence. This
      // measures board presentation, not the SDK's internal receipt timestamp.
      if (placements)
        await receiver.evaluate((expected) => {
          const board = document.querySelector('[data-testid="game-board"]')!;
          board.removeAttribute("data-soak-arrived-at");
          const observer = new MutationObserver(() => {
            if (board.querySelectorAll(".has-committed").length !== expected)
              return;
            board.setAttribute("data-soak-arrived-at", String(Date.now()));
            observer.disconnect();
          });
          observer.observe(board, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["class"],
          });
        }, count);
      const submittedAt = Date.now();
      let acknowledgedAt: number | null = null;
      const acknowledgement = sender
        .waitForResponse(
          (response) =>
            response.url().includes("/submitCommand") &&
            response.request().method() === "POST",
          { timeout: 60_000 },
        )
        .then(async (response) => {
          acknowledgedAt = Date.now();
          expect(response.ok()).toBe(true);
          const body = await response.json();
          expect(body.error).toBeUndefined();
        });
      await sender
        .getByTestId(placements ? "play-word" : "confirm-pass")
        .click();
      await acknowledgement;
      const saved = await readPublicGame();
      expect(saved.revision).toBe(game.revision + 1);
      await onCommitted?.(game, placements, saved);
      if (placements) {
        await expect(receiver.getByTestId("game-board")).toHaveAttribute(
          "data-soak-arrived-at",
          /\d+/,
          { timeout: 60_000 },
        );
        for (const placement of placements) {
          const tile = game.racks[game.turn].find(
            (tile) => tile.id === placement.tileId,
          )!;
          await expect(
            cell(receiver, placement.row, placement.col).locator(
              ".tile-letter",
            ),
          ).toHaveText(placement.letter || tile.letter);
        }
      } else if (saved.status === "active") {
        await expect(receiver.getByTestId("turn-status")).toContainText(
          "Your turn",
          { timeout: 60_000 },
        );
      }
      const arrivedAt = placements
        ? Number(
            await receiver
              .getByTestId("game-board")
              .getAttribute("data-soak-arrived-at"),
          )
        : null;
      const calibration = clock
        ? clock()
        : { serverOffsetMs: 0, uncertaintyMs: 0 };
      const sample = {
        revision: saved.revision,
        player: game.turn,
        kind: placements ? "play" : "pass",
        words: saved.lastMove!.words,
        boardTiles: count,
        submittedAt,
        acknowledgedAt,
        arrivedAt,
        submitToBoardMs: arrivedAt === null ? null : arrivedAt - submittedAt,
        acknowledgementToBoardMs:
          arrivedAt === null ? null : arrivedAt - acknowledgedAt!,
        clockUncertaintyMs: calibration?.uncertaintyMs ?? null,
        submitToAcknowledgementMs: acknowledgedAt! - submittedAt,
        moveTimestampToBoardMs:
          arrivedAt === null || !calibration
            ? null
            : arrivedAt + calibration.serverOffsetMs - saved.lastMove!.at,
      };
      results.push(sample);
      console.log("SOAK", JSON.stringify(sample));
      await info.attach(`turn-${saved.revision}`, {
        body: JSON.stringify(sample),
        contentType: "application/json",
      });
      if (placements && saved.status === "active") {
        await Promise.all(
          [sender, receiver].map(async (view) => {
            await expect(view.getByTestId("move-celebration")).toBeVisible({
              timeout: 15_000,
            });
            await expect(view.getByTestId("move-celebration")).toHaveCount(0, {
              timeout: 60_000,
            });
          }),
        );
      }
    }
    expect(errors).toEqual([]);
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.filter(
        (result) =>
          Number(result.acknowledgementToBoardMs) > 8_000 ||
          (result.moveTimestampToBoardMs !== null &&
            Number(result.moveTimestampToBoardMs) -
              Number(result.clockUncertaintyMs) >
              8_000),
      ),
    ).toEqual([]);
  } finally {
    const report = JSON.stringify(
      {
        environment: environment,
        cpuRate: Number(process.env.SOAK_CPU_RATE || 1),
        results,
        errors,
        networkEvents,
      },
      null,
      2,
    );
    writeFileSync(info.outputPath("soak-results.json"), report);
    await info.attach("soak-results", {
      body: report,
      contentType: "application/json",
    });
    await page.screenshot({ path: info.outputPath("soak-elizabeth.png") });
    await aunt.screenshot({ path: info.outputPath("soak-rita.png") });
  }
}
