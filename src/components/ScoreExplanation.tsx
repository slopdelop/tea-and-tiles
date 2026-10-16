import { motion, useReducedMotion } from "motion/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { Game, MoveRecord, Slot } from "../../shared/engine";
import type { WordScore } from "../../shared/scoring";
import { buildScoreTimeline } from "../scoreTimeline";
import { CELEBRATION_HOLD_MS } from "../celebrationTiming";
import { gameDuration, topWordScores } from "./gameSummaryData";

function PremiumBadge({ premium }: { premium: "DL" | "TL" | "DW" | "TW" }) {
  const names = {
    DL: "Double letter",
    TL: "Triple letter",
    DW: "Double word",
    TW: "Triple word",
  };
  return (
    <span
      className={`score-premium-badge ${premium.toLowerCase()}`}
      data-testid="score-premium-badge"
      data-premium={premium}
      aria-label={names[premium]}
    >
      {premium}
    </span>
  );
}

function WordPremiums({ word }: { word: WordScore }) {
  return (
    <span className="score-word-premiums" data-testid="score-word-premiums">
      {word.tiles
        .filter((tile) => tile.premium === "DW" || tile.premium === "TW")
        .map((tile) => (
          <PremiumBadge
            key={tile.tileId}
            premium={tile.premium as "DW" | "TW"}
          />
        ))}
    </span>
  );
}

function WordTiles({
  word,
  active,
  counted,
}: {
  word: WordScore;
  active?: number;
  counted?: number;
}) {
  const reduced = useReducedMotion();
  return (
    <div
      className={`scored-word-tiles single-row-word ${word.tiles.length > 7 ? "long-score-word" : ""}`}
      style={{ "--word-length": word.tiles.length } as CSSProperties}
      aria-label={word.word}
    >
      {word.tiles.map((tile, index) => (
        <motion.span
          className={`tile score-letter ${active === index ? "counting-letter" : ""} ${counted !== undefined && index <= counted ? "counted-letter" : ""}`}
          key={`${tile.tileId}:${index}`}
          data-counted={counted !== undefined ? index <= counted : undefined}
          aria-label={`${tile.letter}, ${tile.faceValue} points${tile.letterMultiplier > 1 ? `, ${tile.premium}: ${tile.effectivePoints} points` : ""}`}
          animate={{
            y: active === index && !reduced ? -6 : 0,
            scale: active === index && !reduced ? 1.08 : 1,
          }}
          transition={{ duration: 0.18 }}
        >
          <span className="tile-letter" data-letter={tile.letter}>
            {tile.letter}
          </span>
          <small>{tile.faceValue}</small>
          {tile.letterMultiplier > 1 && (
            <span className="letter-bonus" data-testid="score-letter-premium">
              <PremiumBadge
                premium={tile.letterMultiplier === 3 ? "TL" : "DL"}
              />
            </span>
          )}
        </motion.span>
      ))}
    </div>
  );
}

function WordCalculation({
  word,
  counted = word.tiles.length - 1,
  bonusCounted = counted,
  showWordBonus = true,
  showWordTotal = true,
}: {
  word: WordScore;
  counted?: number;
  bonusCounted?: number;
  showWordBonus?: boolean;
  showWordTotal?: boolean;
}) {
  return (
    <div className="score-equation">
      <span className="score-letter-equation">
        {word.tiles.map((tile, index) => (
          <span
            key={tile.tileId}
            style={{ visibility: index <= counted ? "visible" : "hidden" }}
          >
            {index > 0 && " + "}
            {tile.faceValue}
            {tile.letterMultiplier > 1 && (
              <span
                style={{
                  visibility: index <= bonusCounted ? "visible" : "hidden",
                }}
              >
                ×{tile.letterMultiplier}
              </span>
            )}
          </span>
        ))}
      </span>
      {word.wordMultiplier > 1 && (
        <span
          className="word-bonus"
          data-testid="score-word-premium"
          style={{ visibility: showWordBonus ? "visible" : "hidden" }}
        >
          <WordPremiums word={word} />
          <span>
            Whole word:{" "}
            {word.tiles.reduce((sum, tile) => sum + tile.effectivePoints, 0)} ×{" "}
            {word.wordMultiplier} = {word.score}
          </span>
        </span>
      )}
      <strong style={{ visibility: showWordTotal ? "visible" : "hidden" }}>
        {word.word} = {word.score} points
      </strong>
    </div>
  );
}

export function ScoreExplanation({
  move,
  animated = false,
  onComplete,
}: {
  move: MoveRecord;
  animated?: boolean;
  onComplete?: () => void;
}) {
  const reduced = useReducedMotion();
  const timeline = useMemo(
    () => (move.breakdown ? buildScoreTimeline(move.breakdown) : null),
    // Accepted move IDs are immutable; listener refreshes must not restart counting.
    [move.id],
  );
  const [stepIndex, setStepIndex] = useState(0);
  const wordList = useRef<HTMLDivElement>(null);
  const activeStep =
    timeline?.steps[Math.min(stepIndex, timeline.steps.length - 1)];
  useEffect(() => {
    if (!animated || reduced || !activeStep) return;
    const list = wordList.current;
    const row = list?.querySelector<HTMLElement>(
      `[data-score-word-index="${activeStep.wordIndex}"]`,
    );
    if (!list || !row) return;
    const listTop = list.getBoundingClientRect().top + list.clientTop;
    if (activeStep.kind === "intro")
      list.scrollTo({
        top: list.scrollTop + row.getBoundingClientRect().top - listTop - 8,
        behavior: "smooth",
      });
    if (activeStep.kind === "word-bonus" || activeStep.kind === "word-total") {
      const calculation = row.querySelector<HTMLElement>(".score-equation");
      if (calculation) {
        const bottom =
          list.scrollTop + calculation.getBoundingClientRect().bottom - listTop;
        if (bottom > list.scrollTop + list.clientHeight)
          list.scrollTo({
            top: bottom - list.clientHeight,
            behavior: "smooth",
          });
      }
    }
  }, [activeStep?.wordIndex, activeStep?.kind, animated, reduced]);
  useEffect(() => {
    if (!animated) return;
    if (!timeline || reduced) {
      const timer = setTimeout(() => onComplete?.(), CELEBRATION_HOLD_MS);
      return () => clearTimeout(timer);
    }
    const timers = timeline.steps.map((step, index) =>
      setTimeout(() => setStepIndex(index), step.at),
    );
    timers.push(setTimeout(() => onComplete?.(), timeline.durationMs));
    return () => timers.forEach(clearTimeout);
  }, [animated, timeline, reduced]);
  if (!move.breakdown || !timeline)
    return (
      <div
        className="score-explanation legacy-score"
        data-testid="score-breakdown"
      >
        <strong>{move.words.join(" · ")}</strong>
        <p>Detailed scoring was not recorded for this earlier turn.</p>
      </div>
    );
  const breakdown = move.breakdown;
  const step = timeline.steps[Math.min(stepIndex, timeline.steps.length - 1)];
  const word = breakdown.words[step.wordIndex];
  const final = step.kind === "move-total" || step.kind === "bingo";
  const tile =
    step.tileIndex === undefined ? undefined : word?.tiles[step.tileIndex];
  const progressive = animated && !reduced;
  const label =
    step.kind === "intro"
      ? "Counting the letters"
      : step.kind === "letter"
        ? `${tile?.letter} adds ${tile?.faceValue}`
        : step.kind === "letter-bonus"
          ? `${tile?.premium === "TL" ? "Triple" : "Double"} letter: ${tile?.faceValue} × ${tile?.letterMultiplier}`
          : step.kind === "word-bonus"
            ? `Whole word: ${word.tiles.reduce((sum, t) => sum + t.effectivePoints, 0)} × ${word.wordMultiplier}`
            : step.kind === "word-total"
              ? `${word.word} scores`
              : step.kind === "bingo"
                ? `Seven tiles · bonus +${breakdown.bingoBonus}`
                : "Move total";
  return (
    <div
      className={`score-explanation ${progressive ? "score-progressive" : "score-static"}`}
      data-testid="score-breakdown"
      data-score-phase={progressive ? step.kind : "complete"}
      data-word-index={step.wordIndex}
      data-tile-index={step.tileIndex}
    >
      {progressive && (
        <div className="score-progress-heading">
          <span>
            {breakdown.words.length > 1 ? "Played words" : "Played word"}
          </span>
        </div>
      )}
      <div
        ref={wordList}
        className={`score-word-list ${progressive ? "score-progress-list" : ""}`}
        data-testid="score-word-list"
        data-complete={!progressive || final}
      >
        {breakdown.words.map((w, i) => {
          const complete = !progressive || final || i < step.wordIndex;
          const current = progressive && !final && i === step.wordIndex;
          const counted = complete
            ? w.tiles.length - 1
            : current
              ? (step.tileIndex ??
                (step.kind === "intro" ? -1 : w.tiles.length - 1))
              : -1;
          return (
            <div
              className="scored-word"
              key={`${i}:${w.word}`}
              data-testid="score-word-row"
              data-score-word-index={i}
              data-current={current}
            >
              <WordTiles
                word={w}
                active={current ? step.tileIndex : undefined}
                counted={counted}
              />
              <WordCalculation
                word={w}
                counted={counted}
                bonusCounted={
                  current && step.kind === "letter" ? counted - 1 : counted
                }
                showWordBonus={
                  complete ||
                  (current &&
                    (step.kind === "word-bonus" || step.kind === "word-total"))
                }
                showWordTotal={
                  complete || (current && step.kind === "word-total")
                }
              />
            </div>
          );
        })}
      </div>
      <div
        className={`score-count-beat score-unified-total ${progressive ? "" : "score-static-total"}`}
        data-testid="score-total"
      >
        <span>
          <span>{progressive ? label : "Move total"}</span>
          {breakdown.bingoBonus > 0 && (
            <small
              data-testid="score-bingo"
              style={{
                visibility: !progressive || final ? "visible" : "hidden",
              }}
            >
              Seven tiles +{breakdown.bingoBonus}
            </small>
          )}
        </span>
        <motion.strong
          data-testid="running-score"
          animate={{ opacity: 1 }}
          transition={{ duration: 0.16 }}
        >
          {progressive ? step.runningTotal : breakdown.total}
        </motion.strong>
      </div>
    </div>
  );
}

type SummaryGame = Pick<
  Game,
  | "history"
  | "historyComplete"
  | "finalScoreAdjustments"
  | "scores"
  | "startedAt"
  | "onlineDurationMs"
  | "onlineTimeTrackedFrom"
  | "endedAt"
>;
export function GameSummary({
  game,
  names,
}: {
  game: SummaryGame;
  names: Record<Slot, string>;
}) {
  const history = game.history ?? [];
  const duration = gameDuration(game);
  return (
    <section className="game-summary" data-testid="game-summary">
      {duration && (
        <p className="history-note" data-testid="game-duration">
          {duration.label}: <strong>{duration.text}</strong>
        </p>
      )}
      <h3 className="help-section-title">Best words at the table</h3>
      <div className="top-word-columns">
        {(["mom", "aunt"] as const).map((player) => {
          const words = topWordScores(history, player);
          return (
            <section key={player} data-testid={`top-word-scores-${player}`}>
              <h4>{names[player]}</h4>
              {words.length ? (
                <ol>
                  {words.map((word, index) => (
                    <li key={`${index}:${word.word}`}>
                      <span>{word.word}</span>
                      <strong>
                        {word.score}
                        <small> points</small>
                      </strong>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="history-note">
                  No individual word scores recorded.
                </p>
              )}
            </section>
          );
        })}
      </div>
      <h3 className="help-section-title">The game in words</h3>
      {game.historyComplete !== true && (
        <p className="history-note" data-testid="partial-history">
          Only recorded turns are shown. Earlier turns from this game may be
          missing.
        </p>
      )}
      <div className="player-histories">
        {(["mom", "aunt"] as const).map((player) => {
          const moves = history.filter((move) => move.player === player);
          const adjustment = game.finalScoreAdjustments?.players[player];
          return (
            <section key={player} data-testid={`history-${player}`}>
              <h4>{names[player]}</h4>
              {moves.length ? (
                <ol>
                  {moves.map((move) => (
                    <li key={move.id}>
                      <span className="history-word-scores">
                        {move.kind === "play" ? (
                          move.wordScores?.length ? (
                            <>
                              {move.wordScores.map((word, index) => (
                                <span key={`${index}:${word.word}`}>
                                  {word.word} <small>{word.score} points</small>
                                </span>
                              ))}
                              {!!move.bingoBonus && (
                                <small>Seven tiles +{move.bingoBonus}</small>
                              )}
                            </>
                          ) : (
                            move.words.join(" / ")
                          )
                        ) : move.kind === "pass" ? (
                          "Passed"
                        ) : (
                          "Exchanged tiles"
                        )}
                      </span>
                      <b aria-label={`Turn total ${move.score}`}>
                        {move.score > 0 ? "+" : ""}
                        {move.score}
                      </b>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="history-note">No recorded turns.</p>
              )}
              {adjustment ? (
                <dl
                  className="final-adjustments"
                  data-testid={`adjustments-${player}`}
                >
                  <div>
                    <dt>Earned in play</dt>
                    <dd>{adjustment.earned}</dd>
                  </div>
                  <div>
                    <dt>Tiles left in hand</dt>
                    <dd>{adjustment.rackValue}</dd>
                  </div>
                  <div>
                    <dt>Rack deduction</dt>
                    <dd>
                      {adjustment.deducted ? `−${adjustment.deducted}` : "0"}
                    </dd>
                  </div>
                  {adjustment.transferred > 0 && (
                    <div>
                      <dt>From partner’s rack</dt>
                      <dd>+{adjustment.transferred}</dd>
                    </div>
                  )}
                  <div className="adjusted-total">
                    <dt>Final total</dt>
                    <dd>{adjustment.final}</dd>
                  </div>
                </dl>
              ) : (
                <p className="history-note">
                  Final score: {game.scores[player]}. Rack adjustments were not
                  recorded.
                </p>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
