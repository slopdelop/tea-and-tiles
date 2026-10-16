import { test } from "vitest";
import assert from "node:assert/strict";
import {
  cloudSourceSelection,
  prepareCandidateSource,
  readCloudSource,
  releaseRevision,
} from "../scripts/cloud-test-source.mjs";
import {
  assertCandidateDeploymentEvidence,
  deploymentEvidencePath,
  requireCloudTestDeployment,
} from "../scripts/cloud-test-deployment.mjs";
import { deployCloudTestCandidate } from "../scripts/deploy-cloud-test-candidate.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import {
  assertCloudTestTarget,
  cloudTest,
} from "../scripts/cloud-test-project.mjs";

test("cloud harness accepts only the dedicated project and app", () => {
  assert.equal(
    assertCloudTestTarget(cloudTest, {}).projectId,
    "tea-and-tiles-test",
  );
  for (const change of [
    { projectId: "tea-and-tiles" },
    { projectNumber: "107923684102" },
    { authDomain: "tea-and-tiles.firebaseapp.com" },
    { apiKey: "another-key" },
    { appId: "another-app" },
    { region: "us-central1" },
  ])
    assert.throws(() => assertCloudTestTarget({ ...cloudTest, ...change }, {}));
});
test("cloud harness rejects emulator connections and conflicting cloud targets", () => {
  for (const environment of [
    { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
    { FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" },
    { FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:9000" },
    { FUNCTIONS_EMULATOR: "true" },
    { GCLOUD_PROJECT: "tea-and-tiles" },
    { GOOGLE_CLOUD_PROJECT: "tea-and-tiles" },
  ])
    assert.throws(() => assertCloudTestTarget(cloudTest, environment));
});

test("cloud candidate source requires explicit selection and retains the project guard", () => {
  assert.equal(cloudSourceSelection({}).mode, "release");
  assert.equal(
    cloudSourceSelection({ TEA_CLOUD_TEST_SOURCE: "candidate" }).mode,
    "candidate",
  );
  assert.throws(() =>
    cloudSourceSelection({ TEA_CLOUD_TEST_SOURCE: "../production" }),
  );
  assert.throws(() =>
    cloudSourceSelection({
      TEA_CLOUD_TEST_SOURCE: "candidate",
      GCLOUD_PROJECT: "tea-and-tiles",
    }),
  );
  assert.throws(() =>
    cloudSourceSelection({
      TEA_CLOUD_TEST_SOURCE: "candidate",
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    }),
  );
});

test("candidate snapshots preserve exact sources and reject changed snapshots or workspaces", () => {
  const temporary = resolve(tmpdir());
  const workspace = mkdtempSync(resolve(temporary, "tea-cloud-source-test-"));
  assert.ok(workspace.startsWith(temporary + sep));
  try {
    for (const directory of [
      "functions",
      "shared",
      "src",
      "public",
      "scripts",
    ]) {
      mkdirSync(resolve(workspace, directory));
      writeFileSync(resolve(workspace, directory, "source.txt"), directory);
    }
    for (const name of [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "tsconfig.functions.json",
      "vite.config.ts",
      "index.html",
      "firebase.json",
      "firestore.rules",
      "firestore.indexes.json",
    ])
      writeFileSync(resolve(workspace, name), name);
    const environment = { TEA_CLOUD_TEST_SOURCE: "candidate" };
    const source = prepareCandidateSource(environment, workspace);
    assert.match(source.revision, /^candidate-[a-f0-9]{64}$/);
    assert.deepEqual(readCloudSource(environment, workspace), source);
    assert.deepEqual(prepareCandidateSource(environment, workspace), source);
    assert.throws(
      () => requireCloudTestDeployment(environment, workspace),
      /requires matching successful/,
    );
    const evidence = {
      projectId: cloudTest.projectId,
      projectNumber: cloudTest.projectNumber,
      appId: cloudTest.appId,
      sourceRevision: source.revision,
      status: "complete",
      functionsApplied: true,
      firestoreRulesApplied: true,
      firestoreIndexesApplied: true,
      deployedAt: new Date().toISOString(),
    };
    writeFileSync(
      deploymentEvidencePath(workspace),
      JSON.stringify({ ...evidence, sourceRevision: "candidate-wrong" }),
    );
    assert.throws(
      () => requireCloudTestDeployment(environment, workspace),
      /requires matching successful/,
    );
    writeFileSync(deploymentEvidencePath(workspace), JSON.stringify(evidence));
    assert.deepEqual(
      requireCloudTestDeployment(environment, workspace),
      source,
    );
    writeFileSync(resolve(workspace, "src/source.txt"), "new candidate");
    assert.throws(
      () => prepareCandidateSource(environment, workspace),
      /differs from the workspace/,
    );
    writeFileSync(
      resolve(workspace, ".tools/cloud-test-candidate/src/source.txt"),
      "tampered",
    );
    assert.throws(
      () => readCloudSource(environment, workspace),
      /does not match/,
    );
  } finally {
    assert.ok(workspace.startsWith(temporary + sep));
    rmSync(workspace, { recursive: true });
  }
});

test("candidate deployment evidence requires the exact revision, target and every applied component", () => {
  const source = {
    mode: "candidate",
    projectId: cloudTest.projectId,
    revision: `candidate-${"a".repeat(64)}`,
  };
  const evidence = {
    projectId: cloudTest.projectId,
    projectNumber: cloudTest.projectNumber,
    appId: cloudTest.appId,
    sourceRevision: source.revision,
    status: "complete",
    functionsApplied: true,
    firestoreRulesApplied: true,
    firestoreIndexesApplied: true,
    deployedAt: "2026-10-16T00:00:00.000Z",
  };
  assert.equal(
    assertCandidateDeploymentEvidence(source, evidence, {}),
    evidence,
  );
  assert.throws(() => assertCandidateDeploymentEvidence(source, null, {}));
  for (const changed of [
    { projectId: "tea-and-tiles" },
    { projectNumber: "107923684102" },
    { appId: "wrong-app" },
    { sourceRevision: releaseRevision },
    { sourceRevision: `candidate-${"b".repeat(64)}` },
    { status: "pending" },
    { status: "failed" },
    { functionsApplied: false },
    { firestoreRulesApplied: false },
    { firestoreIndexesApplied: false },
    { deployedAt: "invalid" },
  ])
    assert.throws(() =>
      assertCandidateDeploymentEvidence(
        source,
        { ...evidence, ...changed },
        {},
      ),
    );
  assert.throws(() =>
    assertCandidateDeploymentEvidence(source, evidence, {
      GCLOUD_PROJECT: "tea-and-tiles",
    }),
  );
});

test("candidate deploy rejects implicit selection and production targets before any work", () => {
  assert.throws(
    () => deployCloudTestCandidate({}),
    /TEA_CLOUD_TEST_SOURCE=candidate/,
  );
  assert.throws(
    () =>
      deployCloudTestCandidate({
        TEA_CLOUD_TEST_SOURCE: "candidate",
        GCLOUD_PROJECT: "tea-and-tiles",
      }),
    /conflicts/,
  );
});

test("baseline release mode retains its fixed source check without candidate evidence", () => {
  const temporary = resolve(tmpdir());
  const workspace = mkdtempSync(resolve(temporary, "tea-cloud-baseline-test-"));
  assert.ok(workspace.startsWith(temporary + sep));
  try {
    const root = resolve(workspace, ".tools/cloud-test-release");
    mkdirSync(root, { recursive: true });
    const source = {
      projectId: cloudTest.projectId,
      revision: releaseRevision,
    };
    writeFileSync(
      resolve(root, "cloud-test-source.json"),
      JSON.stringify(source),
    );
    assert.deepEqual(requireCloudTestDeployment({}, workspace), source);
  } finally {
    assert.ok(workspace.startsWith(temporary + sep));
    rmSync(workspace, { recursive: true });
  }
});
