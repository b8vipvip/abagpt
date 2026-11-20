import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relativePath) =>
  JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (relativePath) =>
  sha256(readFileSync(path.join(root, relativePath)));

const tag = process.env.GITHUB_REF_NAME ?? "";
const version = process.env.RELEASE_VERSION ?? tag.replace(/^v/, "");
assert.match(tag, /^v\d+\.\d+\.\d+$/, "Release must use a stable vX.Y.Z tag");
assert.equal(tag, "v" + version, "Release tag and version disagree");

const packagePaths = [
  "package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/protocol/package.json",
];
for (const relativePath of packagePaths) {
  assert.equal(readJson(relativePath).version, version, relativePath + " version must match the release tag");
}

const lock = readJson("package-lock.json");
assert.equal(lock.lockfileVersion, 3, "Unexpected npm lockfile version");
for (const [key, relativePath] of [
  ["", "package.json"],
  ["apps/server", "apps/server/package.json"],
  ["apps/web", "apps/web/package.json"],
  ["packages/protocol", "packages/protocol/package.json"],
]) {
  assert.equal(lock.packages[key]?.version, readJson(relativePath).version, "package-lock version mismatch: " + key);
}

const sourceRevision = process.env.GITHUB_SHA ?? "";
assert.match(sourceRevision, /^[a-f0-9]{40}$/, "GITHUB_SHA must be a full commit SHA");
const checkedOutRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
assert.equal(checkedOutRevision, sourceRevision, "Release checkout does not match GITHUB_SHA");

const imageName = process.env.IMAGE_NAME ?? "";
const imageDigest = process.env.IMAGE_DIGEST ?? "";
assert.match(imageName, /^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._-]+$/, "IMAGE_NAME must be a lowercase GHCR image");
assert.match(imageDigest, /^sha256:[a-f0-9]{64}$/, "IMAGE_DIGEST must be a registry sha256 digest");

const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
const baseImage = dockerfile.match(/^ARG NODE_IMAGE=(.+)$/m)?.[1]?.trim();
assert.ok(baseImage?.includes("@sha256:"), "Dockerfile must pin the multi-platform Node base image by digest");

const sourceArtifacts = [
  "SHA256-MANIFEST.json",
  "package-lock.json",
  "openapi.json",
  "openapi.yaml",
  "README.md",
  "CHANGELOG.md",
  "RELEASE-RECOVERY.md",
  "compose.yaml",
  "Dockerfile",
];
const sources = new Map([
  ["openapi.json", "apps/server/dist/openapi.json"],
  ["openapi.yaml", "apps/server/dist/openapi.yaml"],
  ...sourceArtifacts
    .filter((name) => name !== "openapi.json" && name !== "openapi.yaml")
    .map((name) => [name, name]),
]);

const outputDir = path.resolve(root, process.env.RELEASE_ASSETS_DIR ?? "release-assets");
assert.ok(outputDir.startsWith(root + path.sep), "Release assets directory must stay inside the checkout");
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const artifactHashes = {};
for (const [name, source] of sources) {
  const sourcePath = path.join(root, source);
  assert.ok(existsSync(sourcePath), "Missing release asset source: " + source);
  const targetPath = path.join(outputDir, name);
  copyFileSync(sourcePath, targetPath);
  artifactHashes[name] = sha256(readFileSync(targetPath));
}

const metadata = {
  schemaVersion: 1,
  release: {
    version,
    tag,
    sourceRevision,
    repository: process.env.GITHUB_REPOSITORY ?? "b8vipvip/abagpt",
    generatedAt: new Date().toISOString(),
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  },
  runtime: {
    node: process.version,
    npm: execFileSync("npm", ["--version"], { cwd: root, encoding: "utf8" }).trim(),
    requiredNode: readJson("package.json").engines.node,
  },
  dependencies: {
    lockfileVersion: lock.lockfileVersion,
    packageLockSha256: hashFile("package-lock.json"),
  },
  container: {
    image: imageName,
    tags: [imageName + ":" + tag, imageName + ":latest"],
    digest: imageDigest,
    immutableReference: imageName + "@" + imageDigest,
    platforms: ["linux/amd64", "linux/arm64"],
    baseImage,
    dockerfileSha256: hashFile("Dockerfile"),
  },
  artifacts: artifactHashes,
};

writeFileSync(
  path.join(outputDir, "release-metadata.json"),
  JSON.stringify(metadata, null, 2) + "\n",
);
console.log(JSON.stringify({
  version,
  immutableImage: metadata.container.immutableReference,
  assets: [...Object.keys(artifactHashes), "release-metadata.json"],
}, null, 2));
