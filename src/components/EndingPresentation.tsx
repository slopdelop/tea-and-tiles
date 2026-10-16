import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import type { Slot } from "../../shared/engine";
import {
  endingPresentationData,
  endingTally,
  ENDING_TIMING,
  type EndingGame,
} from "./endingPresentationData";

function WinnerFireworks() {
  return (
    <div
      className="winner-fireworks"
      aria-hidden="true"
      data-testid="winner-fireworks"
    >
      {[0, 1, 2].map((burst) => (
        <svg
          key={burst}
          className="winner-firework-burst"
          viewBox="0 0 64 64"
          fill="none"
        >
          {Array.from({ length: 8 }, (_, ray) => (
            <g key={ray} transform={`rotate(${ray * 45} 32 32)`}>
              <path
                d="M32 11v8"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <circle cx="32" cy="5" r="1.8" fill="currentColor" />
            </g>
          ))}
          <path
            d="m32 26 1.8 4.2L38 32l-4.2 1.8L32 38l-1.8-4.2L26 32l4.2-1.8Z"
            fill="currentColor"
          />
        </svg>
      ))}
    </div>
  );
}

export function EndingPresentation({
  game,
  names,
  animated = true,
}: {
  game: EndingGame;
  names: Record<Slot, string>;
  animated?: boolean;
}) {
  const reduced = useReducedMotion();
  const data = endingPresentationData(game, names);
  const play = animated && !reduced && data.hasBreakdown;
  const [elapsed, setElapsed] = useState(play ? 0 : ENDING_TIMING.finalReveal);
  const [skipped, setSkipped] = useState(false);
  useEffect(() => {
    if (!play || skipped) {
      setElapsed(ENDING_TIMING.finalReveal);
      return;
    }
    const start = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => {
      const next = Math.min(ENDING_TIMING.finalReveal, Date.now() - start);
      setElapsed(next);
      if (next === ENDING_TIMING.finalReveal) window.clearInterval(timer);
    }, 60);
    return () => window.clearInterval(timer);
  }, [play, skipped]);
  const done = skipped || !play || elapsed >= ENDING_TIMING.finalReveal;
  const deductsTiles =
    data.players.some((player) => (player.deducted ?? 0) !== 0) ||
    data.reason === "rack-out" ||
    data.reason === "scoreless" ||
    data.reason === "agreed-end";
  const phase = done
    ? "The final scores"
    : elapsed < ENDING_TIMING.earnedEnd
      ? "Counting points earned, including bonuses"
      : elapsed < ENDING_TIMING.adjustmentStart
        ? "Points earned"
        : elapsed < ENDING_TIMING.deductionEnd
          ? deductsTiles
            ? "Applying remaining tiles"
            : "No remaining-tile deductions"
          : elapsed < ENDING_TIMING.transferEnd && data.hasTransfer
            ? "Adding the remaining tile points"
            : "Settling the final scores";
  return (
    <section
      className={`end-game-result ending-presentation ${done ? "is-complete" : "is-counting"} ${!animated || reduced ? "ending-static" : ""}`}
      data-testid="game-result"
    >
      <p className="game-ending-reason" data-testid="game-ending-reason">
        {data.description}
      </p>
      <div className="ending-fanfare" aria-hidden="true">
        <svg viewBox="0 0 320 100" fill="none">
          <g
            className="ending-rays"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M160 6v12M117 17l6 11M86 45l12 4M203 17l-6 11M234 45l-12 4M108 75l10-6M212 75l-10-6" />
          </g>
          <path
            className="ending-star"
            d="m160 26 7 19 20 7-20 7-7 19-7-19-20-7 20-7Z"
            fill="currentColor"
          />
          <path
            d="m64 34 3 8 8 3-8 3-3 8-3-8-8-3 8-3ZM254 58l3 8 8 3-8 3-3 8-3-8-8-3 8-3Z"
            fill="currentColor"
            opacity=".55"
          />
          <circle cx="96" cy="18" r="2.5" fill="currentColor" />
          <circle cx="225" cy="87" r="2" fill="currentColor" />
        </svg>
      </div>
      <p className="ending-phase" role="status" aria-live="polite">
        {phase}
      </p>
      <div className="final-scores ending-scorecards">
        {data.players.map((player) => (
          <div
            key={player.slot}
            className={`final-score ${done && game.winner === player.slot ? "winner" : ""} ${done && (game.winner === player.slot || game.winner === "tie") ? "is-celebrating" : ""}`}
          >
            {done && (game.winner === player.slot || game.winner === "tie") && (
              <WinnerFireworks />
            )}
            <span>{player.name}</span>
            {done ? (
              <strong data-testid={`result-score-${player.slot}`}>
                {player.final}
              </strong>
            ) : (
              <strong aria-hidden="true">
                {endingTally(
                  player.earned!,
                  player.deducted!,
                  player.transferred!,
                  player.final,
                  elapsed,
                )}
              </strong>
            )}
            <small>{done ? "final points" : "counting points"}</small>
            {data.hasBreakdown && (
              <dl className="ending-ledger">
                <div>
                  <dt>
                    Points earned <small>including seven-tile bonuses</small>
                  </dt>
                  <dd>{player.earned}</dd>
                </div>
                <div
                  className={
                    elapsed >= ENDING_TIMING.adjustmentStart || done
                      ? ""
                      : "pending"
                  }
                >
                  <dt>Unused tile points</dt>
                  <dd>{player.deducted ? `−${player.deducted}` : "0"}</dd>
                </div>
                {data.hasTransfer && (
                  <div
                    className={
                      elapsed >= ENDING_TIMING.deductionEnd || done
                        ? ""
                        : "pending"
                    }
                  >
                    <dt>Partner’s unused tile points</dt>
                    <dd>
                      {player.transferred ? `+${player.transferred}` : "0"}
                    </dd>
                  </div>
                )}
              </dl>
            )}
          </div>
        ))}
      </div>
      <div className="ending-verdict" aria-live="polite" aria-atomic="true">
        {done ? (
          <>
            <h3>{data.title}</h3>
            <p>A game well played, together.</p>
          </>
        ) : (
          <button
            type="button"
            className="ending-skip"
            onClick={() => setSkipped(true)}
          >
            Show final scores
          </button>
        )}
      </div>
    </section>
  );
}
