/** Temporary investigation: change this one switch to false and rebuild both sides. */
export const MOVE_DIAGNOSTICS_ENABLED = true;
export const MOVE_DIAGNOSTICS = {
  deliveryMs: 8000,
  displayMs: 3000,
  submissionMs: 8000,
  dailyReports: 5,
  bufferSize: 60,
  clockMaxAgeMs: 30 * 60_000,
} as const;

export const DIAGNOSTIC_EVENTS = [
  "clock",
  "clock-error",
  "listener-start",
  "listener-stop",
  "listener-error",
  "snapshot",
  "rack-snapshot",
  "board-frame",
  "scoring-start",
  "turn-banner",
  "submit-start",
  "submit-reply",
  "submit-error",
  "receipt",
  "foreground",
  "background",
  "online",
  "offline",
  "timer-gap",
  "long-task",
  "network",
] as const;
export type DiagnosticEventName = (typeof DIAGNOSTIC_EVENTS)[number];
export interface DiagnosticEvent {
  name: DiagnosticEventName;
  ms: number;
  gameId?: string;
  moveId?: string;
  revision?: number;
  value?: number;
  detail?: string;
}
export interface MoveDiagnosticReport {
  id: string;
  reason: "delivery-delay" | "display-delay" | "submission-delay";
  gameId: string;
  moveId: string;
  revision: number;
  version: string;
  buildTime?: string;
  viewport?: {
    width: number;
    height: number;
    scale: number;
    pixelRatio: number;
    touchPoints: number;
  };
  browser: string;
  standalone: boolean;
  transport: string;
  longTaskSupport: boolean;
  serverMoveAt?: number;
  delayMs: number;
  uncertaintyMs: number;
  clockAgeMs: number;
  events: DiagnosticEvent[];
}
export interface DiagnosticReply {
  enabled: boolean;
  serverNow: number;
  accepted?: boolean;
}
