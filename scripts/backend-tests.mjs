import { existsSync, readdirSync } from "node:fs";
import { resolve, delimiter } from "node:path";
import { spawn } from "node:child_process";

// Dedicated ephemeral emulator: never imports or exports ordinary development data.
const env = {
  ...process.env,
  FIREBASE_TEST_PROJECT_ID: "demo-tea-and-tiles-backend-tests",
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
const child = spawn(
  process.execPath,
  [
    resolve("node_modules/firebase-tools/lib/bin/firebase.js"),
    "emulators:exec",
    "--project",
    env.FIREBASE_TEST_PROJECT_ID,
    "--config",
    "firebase.backend-tests.json",
    "--only",
    "firestore",
    "npm run test:backend",
  ],
  { stdio: "inherit", env },
);
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
