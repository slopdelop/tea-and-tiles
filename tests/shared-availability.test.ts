import { describe, expect, it } from "vitest";
import { sharedActionPause } from "../src/sharedAvailability";

describe("shared action recovery", () => {
  it("uses the server cooldown only for a confirmed rate limit", () => {
    expect(
      sharedActionPause(
        {
          code: "functions/resource-exhausted",
          details: { rule: "rate-limit", retryAfterSeconds: 2.2 },
        },
        1000,
      )?.resumeAt,
    ).toBe(4000);
  });
  it("requires explicit recovery for an unspecified quota failure", () => {
    expect(
      sharedActionPause({ code: "functions/resource-exhausted" }, 1000)
        ?.resumeAt,
    ).toBeNull();
  });
  it("does not invent a cooldown from invalid server details", () => {
    for (const retryAfterSeconds of [0, -1, Infinity, NaN]) {
      expect(
        sharedActionPause(
          {
            code: "functions/resource-exhausted",
            details: { rule: "rate-limit", retryAfterSeconds },
          },
          1000,
        )?.resumeAt,
      ).toBeNull();
    }
  });
  it("preserves dictionary and turn rejections as normal game errors", () => {
    expect(
      sharedActionPause(
        {
          code: "functions/failed-precondition",
          details: { rule: "dictionary" },
        },
        1000,
      ),
    ).toBeNull();
    expect(
      sharedActionPause({ code: "functions/permission-denied" }, 1000),
    ).toBeNull();
  });
  it("explains attestation failures without claiming billing exhaustion", () => {
    expect(
      sharedActionPause({ code: "functions/unauthenticated" }, 1000)?.message,
    ).toContain("verified");
  });
  it("keeps unknown or malformed exceptions from masking the original failure", () => {
    for (const failure of [null, undefined, "offline", { code: 123 }])
      expect(sharedActionPause(failure, 1000)).toBeNull();
  });
});
