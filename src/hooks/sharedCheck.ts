/** Manual, foreground and new-game checks share one complete pending check. */
export function sharePendingCheck<T>(
  pending: { current: Promise<T> | null },
  run: () => Promise<T>,
): Promise<T> {
  if (pending.current) return pending.current;
  const promise = Promise.resolve().then(run);
  pending.current = promise;
  const clear = () => {
    if (pending.current === promise) pending.current = null;
  };
  void promise.then(clear, clear);
  return promise;
}
