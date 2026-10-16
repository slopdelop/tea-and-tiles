import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { assertCloudTestTarget, cloudTest } from "./cloud-test-project.mjs";
import { cloudSourceSelection } from "./cloud-test-source.mjs";
import { requireCloudTestDeployment } from "./cloud-test-deployment.mjs";
assertCloudTestTarget();
const { root } = cloudSourceSelection();
requireCloudTestDeployment();
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("VITE_")),
);
Object.assign(env, {
  VITE_USE_EMULATORS: "false",
  VITE_FIREBASE_PROJECT_ID: cloudTest.projectId,
  VITE_FIREBASE_API_KEY: cloudTest.apiKey,
  VITE_FIREBASE_AUTH_DOMAIN: cloudTest.authDomain,
  VITE_FIREBASE_APP_ID: cloudTest.appId,
  VITE_FUNCTIONS_REGION: cloudTest.region,
  // The test injects the official SDK debug provider before initialization.
  // Attestation uses the registered private debug token. This placeholder is not
  // a production reCAPTCHA key; no application source is modified.
  VITE_APP_CHECK_SITE_KEY: "private-cloud-test-debug-provider",
  VITE_BASE_PATH: "/",
});
const vite = resolve("node_modules/vite/bin/vite.js");
const build = spawn(process.execPath, [vite, "build"], {
  cwd: root,
  env,
  stdio: "inherit",
});
build.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
build.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const preview = spawn(
    process.execPath,
    [vite, "preview", "--host", "127.0.0.1", "--port", "5185", "--strictPort"],
    { cwd: root, env, stdio: "inherit" },
  );
  preview.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  preview.on("exit", (code) => process.exit(code ?? 1));
});
