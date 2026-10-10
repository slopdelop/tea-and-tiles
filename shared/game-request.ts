import type { Slot, WinCondition } from "./engine.js";

export interface NewGameRequest {
  id: string;
  gameId: string;
  requestedBy: Slot;
  status: "pending" | "accepted" | "declined";
  requestedAt: number;
  winCondition?: WinCondition;
  durationMinutes?: number;
  respondedBy?: Slot;
  respondedAt?: number;
  newGameId?: string;
}

export interface NewGameResponse {
  status: "accepted" | "declined";
  newGameId?: string;
}

export interface TimedGameResult {
  gameId: string;
  revision: number;
  status: "active" | "finished";
  serverNow: number;
}
