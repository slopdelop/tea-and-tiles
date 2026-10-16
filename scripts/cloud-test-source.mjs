import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { resolve, relative } from "node:path";
import { assertCloudTestTarget, cloudTest } from "./cloud-test-project.mjs";

export const releaseRevision = "d71f3869388604acf2ec68c00e972490bbd3e70c";
const sourcePaths = [
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
];
export function cloudSourceSelection(
  environment = process.env,
  workspace = process.cwd(),
) {
  assertCloudTestTarget(cloudTest, environment);
  const mode = environment.TEA_CLOUD_TEST_SOURCE || "release";
  if (!["release", "candidate"].includes(mode))
    throw new Error("TEA_CLOUD_TEST_SOURCE must be release or candidate.");
  return { mode, root: resolve(workspace, `.tools/cloud-test-${mode}`) };
}
function sourceFiles(root) {
  const found = [];
  const visit = (path) => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      if (["node_modules", "lib", "dist", ".git"].includes(item.name)) continue;
      if (item.isSymbolicLink())
        throw new Error("Candidate source cannot contain symbolic links.");
      const file = resolve(path, item.name);
      if (item.isDirectory()) visit(file);
      else if (item.isFile()) found.push(file);
    }
  };
  for (const entry of sourcePaths) {
    const path = resolve(root, entry);
    if (!existsSync(path))
      throw new Error(`Missing cloud candidate source: ${entry}`);
    if (["functions", "shared", "src", "public", "scripts"].includes(entry))
      visit(path);
    else found.push(path);
  }
  return found.sort();
}
function sourceDigest(root) {
  const digest = createHash("sha256");
  for (const path of sourceFiles(root))
    digest
      .update(relative(root, path).replaceAll("\\", "/"))
      .update("\0")
      .update(readFileSync(path))
      .update("\0");
  return digest.digest("hex");
}
export function prepareCandidateSource(
  environment = process.env,
  workspace = process.cwd(),
) {
  const selected = cloudSourceSelection(environment, workspace);
  if (selected.mode !== "candidate")
    throw new Error(
      "Candidate preparation requires TEA_CLOUD_TEST_SOURCE=candidate.",
    );
  const digest = sourceDigest(workspace);
  if (existsSync(selected.root)) {
    const source = readCloudSource(environment, workspace);
    if (source.revision !== `candidate-${digest}`)
      throw new Error(
        "Existing candidate differs from the workspace. Preserve or remove the owned .tools/cloud-test-candidate directory before preparing a new snapshot.",
      );
    return source;
  }
  mkdirSync(selected.root, { recursive: true });
  for (const path of sourceFiles(workspace)) {
    const destination = resolve(selected.root, relative(workspace, path));
    mkdirSync(resolve(destination, ".."), { recursive: true });
    cpSync(path, destination, { dereference: false });
  }
  const source = {
    revision: `candidate-${digest}`,
    mode: "candidate",
    projectId: cloudTest.projectId,
    preparedAt: new Date().toISOString(),
  };
  writeFileSync(
    resolve(selected.root, "cloud-test-source.json"),
    JSON.stringify(source, null, 2),
  );
  return source;
}
export function readCloudSource(
  environment = process.env,
  workspace = process.cwd(),
) {
  const selected = cloudSourceSelection(environment, workspace);
  const source = JSON.parse(
    readFileSync(resolve(selected.root, "cloud-test-source.json"), "utf8"),
  );
  if (
    source.projectId !== cloudTest.projectId ||
    (selected.mode === "release"
      ? source.revision !== releaseRevision
      : source.mode !== "candidate" ||
        source.revision !== `candidate-${sourceDigest(selected.root)}`)
  )
    throw new Error(
      "Cloud test source does not match its selected snapshot and isolated project.",
    );
  return source;
}
