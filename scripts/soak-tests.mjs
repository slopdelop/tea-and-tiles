import { spawn } from "node:child_process";
const turns = Number(process.env.SOAK_TURNS || 60);
if (!Number.isInteger(turns) || turns < 1 || turns > 500)
  throw new Error("SOAK_TURNS must be 1–500.");
const cpuRate = Number(process.env.SOAK_CPU_RATE || 1);
if (!Number.isFinite(cpuRate) || cpuRate < 1 || cpuRate > 20)
  throw new Error("SOAK_CPU_RATE must be between 1 and 20.");
const child = spawn(process.execPath, ["scripts/ui-tests.mjs"], {
  stdio: "inherit",
  env: {
    ...process.env,
    TEA_SOAK_TEST: "true",
    SOAK_TURNS: String(turns),
    UI_TEST_GREP: "automated receive soak",
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
