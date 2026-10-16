import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertCloudTestTarget,
  cloudTest,
  cloudTestAccess,
} from "./cloud-test-project.mjs";

assertCloudTestTarget();
const release = "d71f3869388604acf2ec68c00e972490bbd3e70c";
const root = resolve(".tools/cloud-test-release");
const stamp = resolve(root, "cloud-test-source.json");
if (existsSync(root)) {
  if (
    !existsSync(stamp) ||
    JSON.parse(readFileSync(stamp, "utf8")).revision !== release
  )
    throw new Error(
      "Existing cloud-test release directory has an unexpected source. Refusing to overwrite it.",
    );
} else {
  mkdirSync(root, { recursive: true });
  const archive = resolve(".tools/cloud-test-release.tar");
  writeFileSync(
    archive,
    execFileSync(
      "git",
      [
        "archive",
        "--format=tar",
        release,
        "--",
        "functions",
        "shared",
        "src",
        "public",
        "scripts",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "tsconfig.functions.json",
        "vite.config.ts",
        "index.html",
        "firebase.json",
        "firestore.rules",
        "firestore.indexes.json",
      ],
      {
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
    ),
  );
  execFileSync("tar", ["-xf", archive, "-C", root], { windowsHide: true });
  writeFileSync(
    stamp,
    JSON.stringify(
      { revision: release, projectId: cloudTest.projectId },
      null,
      2,
    ),
  );
}
// Older prepared snapshots included the repository's tests. Exclude that owned
// copy so root Vitest file filters cannot discover duplicate archived suites.
const archivedTests = resolve(root, "tests");
if (dirname(archivedTests) !== root)
  throw new Error("Unexpected archived test path.");
if (existsSync(archivedTests)) rmSync(archivedTests, { recursive: true });
const { request } = await cloudTestAccess();
const service = `https://serviceusage.googleapis.com/v1/projects/${cloudTest.projectNumber}/services/firebaseappcheck.googleapis.com`;
if ((await request(service)).state !== "ENABLED") {
  await request(`${service}:enable`, { method: "POST", body: "{}" });
  let enabled = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    if ((await request(service)).state === "ENABLED") {
      enabled = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!enabled)
    throw new Error("App Check API is enabling; retry preparation shortly.");
}
const billing = await request(
  `https://cloudbilling.googleapis.com/v1/projects/${cloudTest.projectId}/billingInfo`,
);
if (!billing.billingEnabled)
  throw new Error(
    "The test project's Blaze billing must be enabled before deployment.",
  );
const database = await request(
  `https://firestore.googleapis.com/v1/projects/${cloudTest.projectId}/databases/(default)`,
);
if (
  database.locationId !== cloudTest.region ||
  database.type !== "FIRESTORE_NATIVE"
)
  throw new Error("Expected a Native Firestore database in europe-west2.");
const tokenPath = resolve(".tools/cloud-test-appcheck.json");
let needsToken = true;
if (existsSync(tokenPath)) {
  const saved = JSON.parse(readFileSync(tokenPath, "utf8"));
  if (
    saved.projectId !== cloudTest.projectId ||
    saved.appId !== cloudTest.appId
  )
    throw new Error(
      "Stored App Check token belongs to a different project/app.",
    );
  needsToken = !saved.token;
  if (needsToken && saved.name) {
    const expectedPrefix = `projects/${cloudTest.projectNumber}/apps/${cloudTest.appId}/debugTokens/`;
    if (!saved.name.startsWith(expectedPrefix))
      throw new Error("Unexpected stored test-token resource.");
    await request(`https://firebaseappcheck.googleapis.com/v1/${saved.name}`, {
      method: "DELETE",
    });
  }
}
if (needsToken) {
  const debugToken = randomUUID();
  const token = await request(
    `https://firebaseappcheck.googleapis.com/v1/projects/${cloudTest.projectNumber}/apps/${cloudTest.appId}/debugTokens`,
    {
      method: "POST",
      body: JSON.stringify({
        displayName: "Private local Chrome soak",
        token: debugToken,
      }),
    },
  );
  writeFileSync(
    tokenPath,
    JSON.stringify(
      {
        projectId: cloudTest.projectId,
        appId: cloudTest.appId,
        name: token.name,
        token: debugToken,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
console.log(
  JSON.stringify({
    projectId: cloudTest.projectId,
    release,
    sourceDirectory: root,
    appCheck:
      "Private debug token saved in ignored .tools directory; enforcement remains enabled",
  }),
);
