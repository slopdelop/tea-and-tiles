/** A game boundary may reload only while it remains safe after the async check. */
export async function applyNewGameUpdate(
  safeToReload: () => boolean,
  checkForWaitingUpdate: () => Promise<boolean>,
  applyWaitingUpdate: () => Promise<boolean>,
): Promise<boolean> {
  if (!safeToReload()) return false;
  const waiting = await checkForWaitingUpdate();
  // The player may have placed a tile or opened a request during the download.
  if (!waiting || !safeToReload()) return false;
  return applyWaitingUpdate();
}
