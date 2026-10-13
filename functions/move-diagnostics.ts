import { HttpsError } from "firebase-functions/v2/https";
import {
  DIAGNOSTIC_EVENTS,
  MOVE_DIAGNOSTICS_ENABLED,
  MOVE_DIAGNOSTICS,
  type MoveDiagnosticReport,
} from "../shared/move-diagnostics.js";

export function diagnosticsEnabled() {
  return (
    MOVE_DIAGNOSTICS_ENABLED &&
    process.env.TEA_MOVE_DIAGNOSTICS_ENABLED !== "false"
  );
}
export function validateDiagnosticReport(input: unknown): MoveDiagnosticReport {
  const reject = () => {
    throw new HttpsError("invalid-argument", "Invalid diagnostic report.");
  };
  if (!input || typeof input !== "object" || Array.isArray(input))
    return reject();
  const raw = input as Record<string, unknown>;
  const keys = [
    "id",
    "reason",
    "gameId",
    "moveId",
    "revision",
    "version",
    "buildTime",
    "viewport",
    "browser",
    "standalone",
    "transport",
    "longTaskSupport",
    "serverMoveAt",
    "delayMs",
    "uncertaintyMs",
    "clockAgeMs",
    "events",
  ];
  if (Object.keys(raw).some((key) => !keys.includes(key))) return reject();
  const id = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
  const number = (value: unknown, min = 0) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= 1e15;
  if (
    !id(raw.id) ||
    !id(raw.gameId) ||
    !id(raw.moveId) ||
    !["delivery-delay", "display-delay", "submission-delay"].includes(
      raw.reason as string,
    ) ||
    !Number.isSafeInteger(raw.revision) ||
    !number(raw.revision) ||
    !number(raw.delayMs) ||
    !number(raw.uncertaintyMs) ||
    !number(raw.clockAgeMs, -1) ||
    (raw.serverMoveAt !== undefined && !number(raw.serverMoveAt)) ||
    typeof raw.standalone !== "boolean" ||
    typeof raw.longTaskSupport !== "boolean"
  )
    return reject();
  for (const key of ["version", "browser", "transport"])
    if (
      typeof raw[key] !== "string" ||
      (raw[key] as string).length > (key === "browser" ? 256 : 100)
    )
      return reject();
  if (
    raw.buildTime !== undefined &&
    (typeof raw.buildTime !== "string" || raw.buildTime.length > 100)
  )
    return reject();
  if (raw.viewport !== undefined) {
    if (
      !raw.viewport ||
      typeof raw.viewport !== "object" ||
      Array.isArray(raw.viewport)
    )
      return reject();
    const viewport = raw.viewport as Record<string, unknown>;
    if (
      Object.keys(viewport).some(
        (key) =>
          !["width", "height", "scale", "pixelRatio", "touchPoints"].includes(
            key,
          ),
      ) ||
      Object.values(viewport).some((value) => !number(value))
    )
      return reject();
  }
  if (
    !Array.isArray(raw.events) ||
    raw.events.length > MOVE_DIAGNOSTICS.bufferSize
  )
    return reject();
  for (const event of raw.events) {
    if (!event || typeof event !== "object" || Array.isArray(event))
      return reject();
    if (
      Object.keys(event).some(
        (key) =>
          ![
            "name",
            "ms",
            "gameId",
            "moveId",
            "revision",
            "value",
            "detail",
          ].includes(key),
      )
    )
      return reject();
    if (
      !DIAGNOSTIC_EVENTS.includes(event.name) ||
      !number(event.ms) ||
      (event.gameId !== undefined && !id(event.gameId)) ||
      (event.moveId !== undefined && !id(event.moveId)) ||
      (event.revision !== undefined && !number(event.revision)) ||
      (event.value !== undefined && !number(event.value, -1)) ||
      (event.detail !== undefined &&
        (typeof event.detail !== "string" || event.detail.length > 100))
    )
      return reject();
  }
  if (JSON.stringify(raw).length > 16000) return reject();
  return raw as unknown as MoveDiagnosticReport;
}
