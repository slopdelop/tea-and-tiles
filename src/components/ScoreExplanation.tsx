import { motion, useReducedMotion } from "motion/react";
import type { CSSProperties } from "react";
import type { Game, MoveRecord, Slot } from "../../shared/engine";

export function ScoreExplanation({
  move,
  animated = false,
}: {
  move: MoveRecord;
  animated?: boolean;
}) {
  const reduced = useReducedMotion();
  if (!move.breakdown)
    return (
      <div
        className="score-explanation legacy-score"
        data-testid="score-breakdown"
      >
        <strong>{move.words.join(" · ")}</strong>
        <p>Detailed scoring was not recorded for this earlier turn.</p>
      </div>
    );
  return (
    <div className="score-explanation" data-testid="score-breakdown">
      {move.breakdown.words.map((word, index) => (
        <div className="scored-word" key={`${index}:${word.word}`}>
          <div
            className="scored-word-tiles"
            aria-label={word.word}
            style={{ "--word-length": word.tiles.length } as CSSProperties}
          >
            {word.tiles.map((tile, i) => (
              <motion.span
                className={`tile score-letter ${tile.letterMultiplier > 1 ? "multiplied-letter" : ""}`}
                key={`${tile.tileId}:${i}`}
                aria-label={`${tile.letter}, ${tile.faceValue} points${tile.letterMultiplier > 1 ? `, ${tile.premium}: ${tile.effectivePoints} points` : ""}`}
                initial={animated && !reduced ? { opacity: 0, y: 4 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.18,
                  delay: animated && !reduced ? i * 0.025 + index * 0.07 : 0,
                }}
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
          <motion.p
            className="score-equation"
            initial={animated && !reduced ? { opacity: 0 } : false}
            animate={{ opacity: 1 }}
            transition={{
              delay: animated && !reduced ? 0.55 + index * 0.08 : 0,
            }}
          >
            <span>
              {word.wordMultiplier > 1 ? "(" : ""}
              {word.tiles
                .map((tile) =>
                  tile.letterMultiplier > 1
                    ? `${tile.faceValue}×${tile.letterMultiplier}`
                    : `${tile.effectivePoints}`,
                )
                .join(" + ")}
              {word.wordMultiplier > 1 ? ")" : ""}
            </span>
            {word.wordMultiplier > 1 && (
              <motion.span
                className="word-bonus"
                initial={animated && !reduced ? { opacity: 0 } : false}
                animate={{ opacity: 1 }}
                transition={{
                  delay: animated && !reduced ? 0.9 + index * 0.08 : 0,
                }}
              >
                {" "}
                × {word.wordMultiplier} (
                {word.tiles
                  .filter(
                    (tile) => tile.premium === "DW" || tile.premium === "TW",
                  )
                  .map((tile) => tile.premium)
                  .join(" · ")}
                )
              </motion.span>
            )}
            <motion.b
              initial={animated && !reduced ? { opacity: 0 } : false}
              animate={{ opacity: 1 }}
              transition={{
                delay: animated && !reduced ? 1 + index * 0.08 : 0,
              }}
            >
              {" "}
              = {word.score}
            </motion.b>
          </motion.p>
        </div>
      ))}
      <motion.div
        className="score-total"
        initial={animated && !reduced ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={{ delay: animated && !reduced ? 1.2 : 0 }}
      >
        {move.breakdown.bingoBonus > 0 && (
          <span data-testid="score-bingo">
            Seven tiles +{move.breakdown.bingoBonus}
          </span>
        )}
        <strong>Total {move.breakdown.total}</strong>
      </motion.div>
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
