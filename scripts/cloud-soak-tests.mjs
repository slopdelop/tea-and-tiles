import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { assertCloudTestTarget, cloudTest } from "./cloud-test-project.mjs";
import { requireCloudTestDeployment } from "./cloud-test-deployment.mjs";
assertCloudTestTarget();
requireCloudTestDeployment();
const turns = Number(process.env.SOAK_TURNS || 60);
if (!Number.isInteger(turns) || turns < 1 || turns > 100)
  throw new Error("Cloud SOAK_TURNS must be 1–100.");
const cpuRate = Number(process.env.SOAK_CPU_RATE || 1);
if (!Number.isFinite(cpuRate) || cpuRate < 1 || cpuRate > 20)
  throw new Error("SOAK_CPU_RATE must be 1–20.");
const secret = JSON.parse(
  readFileSync(
    new URL("../.tools/cloud-test-appcheck.json", import.meta.url),
    "utf8",
  ),
);
if (
  secret.projectId !== cloudTest.projectId ||
  secret.appId !== cloudTest.appId ||
  !secret.token
)
  throw new Error("Run the guarded preparation script before cloud testing.");
const attestation = await fetch(
  `https://firebaseappcheck.googleapis.com/v1/projects/${cloudTest.projectId}/apps/${cloudTest.appId}:exchangeDebugToken?key=${cloudTest.apiKey}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ debugToken: secret.token }),
  },
);
if (!attestation.ok) {
  const data = await attestation.json();
  throw new Error(
    `Test App Check preflight failed (${attestation.status}): ${data.error?.message || "Check the test project's App Check setup"}`,
  );
}
const args = [
  "node_modules/@playwright/test/cli.js",
  "test",
  "--config",
  "playwright.cloud-soak.config.ts",
];
if (process.env.SOAK_HEADED === "true") args.push("--headed");
const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    TEA_CLOUD_SOAK: "tea-and-tiles-test",
    SOAK_TURNS: String(turns),
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
