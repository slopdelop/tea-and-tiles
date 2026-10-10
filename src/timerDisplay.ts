/** Keep the long part of a game calm, then count the final minute in seconds. */
export function formatTimeRemaining(secondsRemaining: number): string {
  if (secondsRemaining <= 0) return "Time is up";
  if (secondsRemaining > 60)
    return `${Math.ceil(secondsRemaining / 60)} minutes left`;
  return `${secondsRemaining} ${secondsRemaining === 1 ? "second" : "seconds"} left`;
}
