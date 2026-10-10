import { describe, expect, it } from "vitest";
import { callablePolicy } from "../functions/callable-policy";

describe("callable runtime policy", () => {
  it.each([
    {},
    { FUNCTIONS_EMULATOR: "false" },
    { FUNCTIONS_EMULATOR: "TRUE" },
    { FUNCTIONS_EMULATOR: "1" },
    { FUNCTIONS_EMULATOR: "" },
  ])(
    "requires App Check when the emulator flag is missing or malformed: %j",
    (environment) => {
      expect(callablePolicy(environment)).toEqual({
        region: "europe-west2",
        minInstances: 0,
        maxInstances: 1,
        timeoutSeconds: 30,
        memory: "256MiB",
        enforceAppCheck: true,
      });
    },
  );
  it("permits unattested local emulator calls without raising cloud scaling limits", () => {
    expect(callablePolicy({ FUNCTIONS_EMULATOR: "true" })).toEqual({
      region: "europe-west2",
      minInstances: 0,
      maxInstances: 1,
      timeoutSeconds: 30,
      memory: "256MiB",
      enforceAppCheck: false,
    });
  });
});
