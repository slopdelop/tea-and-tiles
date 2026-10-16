export function readSignInLink(
  fragment: string,
): { player: string; code: string; displayName?: string } | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const name = params.get("player")?.trim();
  const code = params.get("code") || "";
  // Stable IDs may be longer than human names; legacy name-only links still work.
  const player =
    name &&
    (/^[A-Za-z0-9_-]{1,100}$/.test(name) ||
      /^[\p{L}\p{N} ._'’\-]{1,30}$/u.test(name))
      ? name
      : null;
  if (!player || !/^\d{6}$/.test(code)) return null;
  const displayName = params.get("name")?.trim();
  return {
    player,
    code,
    ...(displayName &&
    displayName.length <= 30 &&
    !/[\u0000-\u001f\u007f]/.test(displayName)
      ? { displayName }
      : {}),
  };
}
