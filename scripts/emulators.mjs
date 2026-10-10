import { existsSync, readdirSync } from "node:fs";
import { resolve, delimiter } from "node:path";
import { spawn } from "node:child_process";
const javaRoot = resolve(".tools/java");
const env = { ...process.env };
env.FUNCTIONS_DISCOVERY_TIMEOUT ||= "60";
if (existsSync(javaRoot)) {
  const folder = readdirSync(javaRoot).find((name) =>
    existsSync(
      resolve(
        javaRoot,
        name,
        "bin",
        process.platform === "win32" ? "java.exe" : "java",
      ),
    ),
  );
  if (folder) {
    env.JAVA_HOME = resolve(javaRoot, folder);
    const pathKey =
      Object.keys(env).find((name) => name.toLowerCase() === "path") || "PATH";
    env[pathKey] =
      resolve(env.JAVA_HOME, "bin") + delimiter + (env[pathKey] || "");
  }
}
const test = process.argv.includes("--test");
if (test) env.FIREBASE_TEST_PROJECT_ID = "demo-tea-and-tiles-tests";
const args = test
  ? [
      "emulators:exec",
      "--project",
      "demo-tea-and-tiles-tests",
      "--only",
      "auth,firestore,functions",
      "npm run test:backend && npm run test:e2e",
    ]
  : [
      "emulators:start",
      "--project",
      "demo-tea-and-tiles",
      "--only",
      "auth,firestore,functions",
      "--import",
      ".emulator-data",
      "--export-on-exit",
      ".emulator-data",
    ];
const child = spawn(
  process.execPath,
  [resolve("node_modules/firebase-tools/lib/bin/firebase.js"), ...args],
  { stdio: "inherit", env },
);
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
