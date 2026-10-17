/** Preview tools never grant permission to change shared game data. */
export function canUseDebugTools(playerId: string | null | undefined) {
  return import.meta.env.DEV || playerId === "justin";
}
