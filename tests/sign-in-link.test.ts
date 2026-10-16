import { describe, expect, it } from "vitest";
import { readSignInLink } from "../src/signInLink";

describe("private sign-in links", () => {
  it("preserves readable names and leading zeros", () => {
    expect(readSignInLink("#player=Elizabeth&code=000123")).toEqual({
      player: "Elizabeth",
      code: "000123",
    });
    expect(readSignInLink("#player=Rita&code=123456")).toEqual({
      player: "Rita",
      code: "123456",
    });
  });
  it("accepts additional private player names without a public directory", () => {
    expect(readSignInLink("#player=Alex%20Smith&code=000123")).toEqual({
      player: "Alex Smith",
      code: "000123",
    });
  });
  it("supports opaque account IDs with a readable prefilled name", () => {
    const id = `player-${"a".repeat(50)}`;
    expect(
      readSignInLink(`#player=${id}&name=Alex%20O%27Brien&code=000123`),
    ).toEqual({
      player: id,
      displayName: "Alex O'Brien",
      code: "000123",
    });
  });
  it("rejects missing names, unsafe names and malformed codes", () => {
    for (const hash of [
      "#player=&code=123456",
      "#player=%3Cscript%3E&code=123456",
      `#player=${"a".repeat(101)}&code=123456`,
      "#player=Rita&code=12345",
      "#player=Rita&code=1234567",
      "#player=Rita&code=abcdef",
      "#setup=orchid",
    ]) {
      expect(readSignInLink(hash)).toBeNull();
    }
  });
});
