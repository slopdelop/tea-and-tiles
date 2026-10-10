/** Midpoint dead band keeps a chosen vacancy stable under finger jitter. */
export function rackTargetHysteresis(centers: readonly number[]): number {
  if (centers.length < 2) return 0;
  const pitch = Math.min(
    ...centers.slice(1).map((center, index) => center - centers[index]),
  );
  return Math.min(6, Math.max(0, pitch * 0.12));
}

/**
 * Centers describe the complete rack's vacancies, including the dragged tile's
 * slot. They must come from stable outer slots, never animated neighboring tiles.
 */
export function findRackInsertionIndex(
  pointerX: number,
  centers: readonly number[],
  previousIndex: number | null = null,
): number {
  if (!centers.length) return 0;
  if (
    previousIndex === null ||
    previousIndex < 0 ||
    previousIndex >= centers.length
  ) {
    let nearest = 0;
    for (let index = 1; index < centers.length; index++) {
      if (
        Math.abs(pointerX - centers[index]) <
        Math.abs(pointerX - centers[nearest])
      )
        nearest = index;
    }
    return nearest;
  }
  const margin = rackTargetHysteresis(centers);
  let index = previousIndex;
  while (
    index < centers.length - 1 &&
    pointerX > (centers[index] + centers[index + 1]) / 2 + margin
  )
    index++;
  while (
    index > 0 &&
    pointerX < (centers[index - 1] + centers[index]) / 2 - margin
  )
    index--;
  return index;
}
