import type { Slot } from "./engine.js";

export interface WordRequest {
  id: string;
  word: string;
  requestedBy: Slot;
  status: "pending" | "accepted" | "declined";
  requestedAt: number;
  respondedBy?: Slot;
  respondedAt?: number;
}

export interface HouseWord {
  word: string;
  requestedBy: Slot;
  approvedBy: Slot;
  approvedAt: number;
}

/** The decision belongs to the exact proposal displayed to its recipient. */
export interface WordDecision {
  requestId: string;
  approve: boolean;
  expectedRequestedAt: number;
}
