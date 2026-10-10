/** Only Firebase's exact local-emulator flag may bypass App Check. */
export function callablePolicy(
  environment: { FUNCTIONS_EMULATOR?: string } = process.env,
) {
  return {
    region: "europe-west2",
    minInstances: 0,
    maxInstances: 1,
    timeoutSeconds: 30,
    memory: "256MiB" as const,
    enforceAppCheck: environment.FUNCTIONS_EMULATOR !== "true",
  };
}
