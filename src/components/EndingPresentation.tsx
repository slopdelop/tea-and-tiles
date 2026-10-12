import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import type { Slot } from "../../shared/engine";
import {
  endingPresentationData,
  endingTally,
  type EndingGame,
} from "./endingPresentationData";

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
  const [elapsed, setElapsed] = useState(play ? 0 : 3800);
  const [skipped, setSkipped] = useState(false);
  useEffect(() => {
    if (!play || skipped) {
      setElapsed(3800);
      return;
    }
    const start = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => {
      const next = Math.min(3800, Date.now() - start);
      setElapsed(next);
      if (next === 3800) window.clearInterval(timer);
    }, 60);
    return () => window.clearInterval(timer);
  }, [play, skipped]);
  const done = skipped || !play || elapsed >= 3400;
  const deductsTiles =
    data.players.some((player) => (player.deducted ?? 0) !== 0) ||
    data.reason === "rack-out" ||
    data.reason === "scoreless" ||
    data.reason === "agreed-end";
  const phase = done
    ? "The final scores"
    : elapsed < 1400
      ? "Counting points earned, including bonuses"
      : elapsed < 2500
        ? deductsTiles
          ? "Applying remaining tiles"
          : "No remaining-tile deductions"
        : data.hasTransfer
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
            className={`final-score ${done && game.winner === player.slot ? "winner" : ""}`}
          >
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
                    Points earned <small>including bingo bonuses</small>
                  </dt>
                  <dd>{player.earned}</dd>
                </div>
                <div className={elapsed >= 1400 || done ? "" : "pending"}>
                  <dt>Remaining tiles</dt>
                  <dd>−{player.deducted}</dd>
                </div>
                {data.hasTransfer && (
                  <div className={elapsed >= 2500 || done ? "" : "pending"}>
                    <dt>Partner’s remaining tiles</dt>
                    <dd>+{player.transferred}</dd>
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
