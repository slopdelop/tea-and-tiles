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

export interface EndGameRequest {
  id: string;
  gameId: string;
  expectedRevision: number;
  requestedBy: Slot;
  status: "pending" | "accepted" | "declined";
  requestedAt: number;
  respondedBy?: Slot;
  respondedAt?: number;
  finishedRevision?: number;
}

export interface EndGameResponse {
  status: "accepted" | "declined";
  gameId: string;
  revision: number;
}
