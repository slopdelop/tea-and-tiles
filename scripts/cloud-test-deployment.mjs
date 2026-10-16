import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertCloudTestTarget, cloudTest } from "./cloud-test-project.mjs";
import { cloudSourceSelection, readCloudSource } from "./cloud-test-source.mjs";

export function deploymentEvidencePath(workspace = process.cwd()) {
  return resolve(workspace, ".tools/cloud-test-deployment.json");
}

export function assertCandidateDeploymentEvidence(
  source,
  evidence,
  environment = process.env,
) {
  assertCloudTestTarget(cloudTest, environment);
  if (
    !evidence ||
    evidence.status !== "complete" ||
    evidence.projectId !== cloudTest.projectId ||
    evidence.projectNumber !== cloudTest.projectNumber ||
    evidence.appId !== cloudTest.appId ||
    evidence.sourceRevision !== source.revision ||
    source.projectId !== cloudTest.projectId ||
    source.mode !== "candidate" ||
    !/^candidate-[a-f0-9]{64}$/.test(source.revision) ||
    evidence.functionsApplied !== true ||
    evidence.firestoreRulesApplied !== true ||
    evidence.firestoreIndexesApplied !== true ||
    !Number.isFinite(Date.parse(evidence.deployedAt))
  ) {
    throw new Error(
      "Candidate cloud testing requires matching successful Functions, Firestore rules and indexes deployment evidence for tea-and-tiles-test. Run the guarded deploy-cloud-test-candidate.mjs helper first.",
    );
  }
  return evidence;
}

/** Local-only preflight, before credentials, token exchange, browser startup or fixture writes. */
export function requireCloudTestDeployment(
  environment = process.env,
  workspace = process.cwd(),
) {
  const selected = cloudSourceSelection(environment, workspace);
  const source = readCloudSource(environment, workspace);
  if (selected.mode === "release") return source;
  const path = deploymentEvidencePath(workspace);
  const evidence = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : null;
  assertCandidateDeploymentEvidence(source, evidence, environment);
  return source;
}
