export type SharedActionPause = {
  message: string;
  resumeAt: number | null;
};

/** Service failures are not proof that a billing limit was reached. */
export function sharedActionPause(
  error: unknown,
  now: number,
): SharedActionPause | null {
  if (!error || typeof error !== "object") return null;
  const failure = error as {
    code?: string;
    details?: { rule?: string; retryAfterSeconds?: number };
  };
  if (typeof failure.code !== "string") return null;
  if (
    failure.code === "functions/resource-exhausted" &&
    failure.details?.rule === "rate-limit"
  ) {
    const seconds = failure.details.retryAfterSeconds;
    if (
      typeof seconds === "number" &&
      Number.isFinite(seconds) &&
      seconds > 0
    ) {
      return {
        message:
          "There have been too many requests. Please wait before trying again.",
        resumeAt: now + Math.ceil(Math.min(seconds, 86400)) * 1000,
      };
    }
  }
  if (
    failure.code === "functions/unauthenticated" ||
    failure.code?.startsWith("appCheck/") ||
    failure.code?.startsWith("app-check/")
  ) {
    return {
      message: "This device could not be verified. Please try again.",
      resumeAt: null,
    };
  }
  if (
    [
      "functions/resource-exhausted",
      "functions/unavailable",
      "functions/deadline-exceeded",
      "functions/internal",
      "functions/unknown",
      "functions/cancelled",
      "unavailable",
    ].includes(failure.code || "")
  ) {
    return {
      message:
        "The table is temporarily unavailable. Your draft is kept on this device. Please try again later.",
      resumeAt: null,
    };
  }
  return null;
}
