import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

export const cloudTest = JSON.parse(
  readFileSync(new URL("../cloud-test.config.json", import.meta.url), "utf8"),
);
export function assertCloudTestTarget(
  config = cloudTest,
  environment = process.env,
) {
  if (
    config.projectId !== "tea-and-tiles-test" ||
    config.projectNumber !== "905106894114" ||
    config.appId !== "1:905106894114:web:8cede45ae830ae6b52497b" ||
    config.apiKey !== "AIzaSyA6iSU2AoxnctzRFaY36a7-ncE-24vRHxQ" ||
    config.authDomain !== "tea-and-tiles-test.firebaseapp.com" ||
    config.region !== "europe-west2"
  )
    throw new Error(
      "Cloud tests are restricted to the dedicated tea-and-tiles-test project and app.",
    );
  for (const key of [
    "FIRESTORE_EMULATOR_HOST",
    "FIREBASE_AUTH_EMULATOR_HOST",
    "FIREBASE_DATABASE_EMULATOR_HOST",
    "FUNCTIONS_EMULATOR",
  ])
    if (environment[key]) throw new Error(`Clear ${key} before cloud testing.`);
  if (
    environment.GOOGLE_CLOUD_PROJECT &&
    environment.GOOGLE_CLOUD_PROJECT !== config.projectId
  )
    throw new Error(
      "GOOGLE_CLOUD_PROJECT conflicts with the isolated cloud test target.",
    );
  if (
    environment.GCLOUD_PROJECT &&
    environment.GCLOUD_PROJECT !== config.projectId
  )
    throw new Error(
      "GCLOUD_PROJECT conflicts with the isolated cloud test target.",
    );
  return config;
}
export async function cloudTestAccess() {
  assertCloudTestTarget();
  const require = createRequire(import.meta.url);
  const auth = require("firebase-tools/lib/auth");
  const api = require("firebase-tools/lib/api");
  const account = auth.getProjectDefaultAccount(process.cwd());
  if (!account?.tokens?.refresh_token)
    throw new Error("Firebase CLI login required.");
  const token = await auth.getAccessToken(account.tokens.refresh_token, [
    "https://www.googleapis.com/auth/cloud-platform",
  ]);
  return {
    credentials: {
      type: "authorized_user",
      client_id: api.clientId(),
      client_secret: api.clientSecret(),
      refresh_token: account.tokens.refresh_token,
    },
    async request(url, options = {}) {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "https:" ||
        !parsed.hostname.endsWith(".googleapis.com") ||
        ![cloudTest.projectId, cloudTest.projectNumber].some(
          (id) =>
            parsed.pathname.includes(`/projects/${id}/`) ||
            parsed.pathname.endsWith(`/projects/${id}`),
        )
      )
        throw new Error("Refusing API request outside the cloud test project.");
      const response = await fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          Authorization: `Bearer ${token.access_token}`,
          "Content-Type": "application/json",
        },
      });
      const data = response.status === 204 ? {} : await response.json();
      if (!response.ok)
        throw new Error(
          `${response.status}: ${data.error?.message || "Cloud test API request failed"}`,
        );
      return data;
    },
  };
}
