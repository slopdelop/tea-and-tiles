import { existsSync, readdirSync } from "node:fs";
import { resolve, delimiter } from "node:path";
import { spawn } from "node:child_process";

// Deliberately distinct project, config and ports. Never import/export the live
// development data and never invoke the normal E2E's default-project reset.
const env = {
  ...process.env,
  FUNCTIONS_DISCOVERY_TIMEOUT: "60",
  TEA_TEST_PROJECT: "demo-tea-and-tiles-ui-tests",
  FIREBASE_TEST_PROJECT_ID: "demo-tea-and-tiles-ui-tests",
};
const javaRoot = resolve(".tools/java");
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
if (!existsSync("functions/lib/functions/index.js"))
  throw new Error("Build Functions before starting isolated UI tests.");
const args = [
  process.argv.includes("--start") ? "emulators:start" : "emulators:exec",
  "--project",
  "demo-tea-and-tiles-ui-tests",
  "--config",
  "firebase.ui-tests.json",
  "--only",
  "auth,firestore,functions",
];
if (!process.argv.includes("--start"))
  args.push(
    (process.argv.includes("--backend") ? "npm run test:backend && " : "") +
      "npm exec -- playwright test --config playwright.ui.config.ts" +
      (process.env.SOAK_HEADED === "true" ? " --headed" : ""),
  );
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
