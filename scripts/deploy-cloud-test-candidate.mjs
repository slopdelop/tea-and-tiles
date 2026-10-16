import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { assertCloudTestTarget, cloudTest } from "./cloud-test-project.mjs";
import { cloudSourceSelection, readCloudSource } from "./cloud-test-source.mjs";
import { deploymentEvidencePath } from "./cloud-test-deployment.mjs";

/** Explicit opt-in: only the dedicated cloud test project can be deployed. */
export function deployCloudTestCandidate(
  environment = process.env,
  workspace = process.cwd(),
) {
  assertCloudTestTarget(cloudTest, environment);
  const { mode, root } = cloudSourceSelection(environment, workspace);
  if (mode !== "candidate")
    throw new Error(
      "Set TEA_CLOUD_TEST_SOURCE=candidate before deploying a test candidate.",
    );
  const source = readCloudSource(environment, workspace);
  const evidencePath = deploymentEvidencePath(workspace);
  const evidence = {
    projectId: cloudTest.projectId,
    projectNumber: cloudTest.projectNumber,
    appId: cloudTest.appId,
    sourceRevision: source.revision,
    status: "pending",
    functionsApplied: false,
    firestoreRulesApplied: false,
    firestoreIndexesApplied: false,
  };
  // Invalidate prior evidence before a build/deploy that might fail partway through.
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  try {
    const output = resolve(root, "functions/lib");
    if (
      !output.startsWith(root + sep) ||
      output !== resolve(root, "functions", "lib")
    )
      throw new Error("Unexpected candidate build output path.");
    if (existsSync(output)) rmSync(output, { recursive: true });
    const options = {
      cwd: root,
      env: {
        ...environment,
        GCLOUD_PROJECT: cloudTest.projectId,
        GOOGLE_CLOUD_PROJECT: cloudTest.projectId,
      },
      stdio: "inherit",
      windowsHide: true,
    };
    execFileSync(
      process.execPath,
      [
        resolve(workspace, "node_modules/typescript/bin/tsc"),
        "--project",
        "tsconfig.functions.json",
        "--rootDir",
        ".",
        "--outDir",
        "functions/lib",
      ],
      options,
    );
    mkdirSync(resolve(output, "shared"), { recursive: true });
    for (const file of [
      "words.txt",
      "DICTIONARY-LICENSE.txt",
      "DICTIONARY-SOURCE.json",
    ]) {
      const input = resolve(root, "shared", file);
      if (file !== "DICTIONARY-SOURCE.json" || existsSync(input))
        copyFileSync(input, resolve(output, "shared", file));
    }
    if (!existsSync(resolve(output, "functions/index.js")))
      throw new Error(
        "Candidate Functions build did not emit its entry point.",
      );
    if (
      !readFileSync(resolve(root, "shared/words.txt")).equals(
        readFileSync(resolve(output, "shared/words.txt")),
      )
    )
      throw new Error("Candidate dictionary build differs from its source.");
    readCloudSource(environment, workspace);
    // Fixed paths and no predeploy hooks ensure this deploy uses only this snapshot.
    const config = resolve(root, "cloud-test.firebase.json");
    writeFileSync(
      config,
      JSON.stringify(
        {
          functions: [
            {
              source: "functions",
              codebase: "tea-and-tiles",
              runtime: "nodejs22",
            },
          ],
          firestore: {
            rules: "firestore.rules",
            indexes: "firestore.indexes.json",
          },
        },
        null,
        2,
      ),
    );
    execFileSync(
      process.execPath,
      [
        resolve(workspace, "node_modules/firebase-tools/lib/bin/firebase.js"),
        "deploy",
        "--project",
        "tea-and-tiles-test",
        "--config",
        config,
        "--only",
        "functions:tea-and-tiles,firestore:rules,firestore:indexes",
        "--non-interactive",
      ],
      options,
    );
    readCloudSource(environment, workspace);
    const completed = {
      ...evidence,
      status: "complete",
      functionsApplied: true,
      firestoreRulesApplied: true,
      firestoreIndexesApplied: true,
      deployedAt: new Date().toISOString(),
    };
    writeFileSync(evidencePath, JSON.stringify(completed, null, 2));
    console.log(JSON.stringify(completed));
    return completed;
  } catch (error) {
    writeFileSync(
      evidencePath,
      JSON.stringify({ ...evidence, status: "failed" }, null, 2),
    );
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  deployCloudTestCandidate();
