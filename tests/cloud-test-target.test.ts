import { test } from "vitest";
import assert from "node:assert/strict";
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
