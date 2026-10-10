import { describe, expect, it } from "vitest";
import { readSignInLink } from "../src/signInLink";

describe("private sign-in links", () => {
  it("preserves leading zeros and maps names to player identity", () => {
    expect(readSignInLink("#player=Elizabeth&code=000123")).toEqual({
      player: "mom",
      code: "000123",
    });
    expect(readSignInLink("#player=Rita&code=123456")).toEqual({
      player: "aunt",
      code: "123456",
    });
  });
  it("rejects unknown players and malformed codes", () => {
    for (const hash of [
      "#player=Else&code=123456",
      "#player=Rita&code=12345",
      "#player=Rita&code=1234567",
      "#player=Rita&code=abcdef",
      "#setup=orchid",
    ]) {
      expect(readSignInLink(hash)).toBeNull();
    }
  });
});
