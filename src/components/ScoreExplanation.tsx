import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import type { Game, MoveRecord, Slot } from "../../shared/engine";
import type { WordScore } from "../../shared/scoring";
import { buildScoreTimeline } from "../scoreTimeline";
import { CELEBRATION_HOLD_MS } from "../celebrationTiming";

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
    <div className="scored-word-tiles" aria-label={word.word}>
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
            <i className="letter-bonus">{tile.premium}</i>
          )}
        </motion.span>
      ))}
    </div>
  );
}

function WordCalculation({ word }: { word: WordScore }) {
  return (
    <div className="score-equation">
      <span>
        {word.tiles
          .map((tile) =>
            tile.letterMultiplier > 1
              ? `${tile.faceValue}×${tile.letterMultiplier}`
              : `${tile.effectivePoints}`,
          )
          .join(" + ")}
      </span>
      {word.wordMultiplier > 1 && (
        <span className="word-bonus">Word bonus ×{word.wordMultiplier}</span>
      )}
      <strong>
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
  const [showTotal, setShowTotal] = useState(false);
  useEffect(() => {
    if (!animated) return;
    if (!timeline || reduced) {
      const timer = setTimeout(() => onComplete?.(), CELEBRATION_HOLD_MS);
      return () => clearTimeout(timer);
    }
    if (showTotal) {
      const timer = setTimeout(() => onComplete?.(), 1400);
      return () => clearTimeout(timer);
    }
    const timers = timeline.steps.map((step, index) =>
      setTimeout(() => setStepIndex(index), step.at),
    );
    timers.push(setTimeout(() => onComplete?.(), timeline.durationMs));
    return () => timers.forEach(clearTimeout);
  }, [animated, timeline, reduced, showTotal]);
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
  const step =
    timeline.steps[
      showTotal
        ? timeline.steps.length - 1
        : Math.min(stepIndex, timeline.steps.length - 1)
    ];
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
            ? `${word.tiles
                .filter((t) => t.premium === "DW" || t.premium === "TW")
                .map((t) => t.premium)
                .join(" + ")} · word × ${word.wordMultiplier}`
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
      {progressive ? (
        <>
          <div className="score-progress-heading">
            <span>
              {final
                ? "Played words"
                : breakdown.words.length > 1
                  ? `Word ${step.wordIndex + 1} of ${breakdown.words.length}`
                  : "Played word"}
            </span>
            {!final && (
              <button
                type="button"
                data-testid="score-show-total"
                onClick={() => setShowTotal(true)}
              >
                Show total
              </button>
            )}
          </div>
          {!final && word ? (
            <WordTiles
              word={word}
              active={step.tileIndex}
              counted={
                step.tileIndex ??
                (step.kind === "intro" ? -1 : word.tiles.length - 1)
              }
            />
          ) : (
            <div className="score-word-totals">
              {breakdown.words.map((w, i) => (
                <div key={i}>
                  <strong>{w.word}</strong>
                  <span>{w.score} points</span>
                </div>
              ))}
            </div>
          )}
          <div className="score-count-beat">
            <span>{label}</span>
            <motion.strong
              key={`${stepIndex}:${showTotal}`}
              data-testid="running-score"
              initial={{ opacity: 0.65, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.16 }}
            >
              {step.runningTotal}
            </motion.strong>
          </div>
          {final && (
            <div className="score-total" data-testid="score-total">
              {breakdown.bingoBonus > 0 && (
                <span data-testid="score-bingo">
                  Seven tiles +{breakdown.bingoBonus}
                </span>
              )}
              <strong>Total {breakdown.total}</strong>
            </div>
          )}
        </>
      ) : (
        <>
          {breakdown.words.map((w, i) => (
            <div className="scored-word" key={`${i}:${w.word}`}>
              <WordTiles word={w} />
              <WordCalculation word={w} />
            </div>
          ))}
          <div className="score-total" data-testid="score-total">
            {breakdown.bingoBonus > 0 && (
              <span data-testid="score-bingo">
                Seven tiles +{breakdown.bingoBonus}
              </span>
            )}
            <strong>Total {breakdown.total}</strong>
          </div>
        </>
      )}
    </div>
  );
}

type SummaryGame = Pick<
  Game,
  "history" | "historyComplete" | "finalScoreAdjustments" | "scores"
>;
export function GameSummary({
  game,
  names,
}: {
  game: SummaryGame;
  names: Record<Slot, string>;
}) {
  const history = game.history ?? [];
  return (
    <section className="game-summary" data-testid="game-summary">
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
