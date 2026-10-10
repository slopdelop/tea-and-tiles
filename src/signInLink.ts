import type { Slot } from "../shared/engine";

export function readSignInLink(
  fragment: string,
): { player: Slot; code: string } | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const name = params.get("player")?.toLowerCase();
  const code = params.get("code") || "";
  const player = name === "elizabeth" ? "mom" : name === "rita" ? "aunt" : null;
  return player && /^\d{6}$/.test(code) ? { player, code } : null;
}
