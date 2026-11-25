import test from "node:test";
import assert from "node:assert/strict";
import { validateArtifactManifest } from "./artifact-policy.js";

const request = {
  taskId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  repository: "atomicpel/ai-locman",
  revision: "a".repeat(40),
  profile: "node_build",
  artifactPaths: ["dist/app.apk", "reports/test-results.xml", "logs/a.txt", "logs/b.txt", "logs/c.txt", "logs/d.txt"]
};
const artifact = (path: string, bytes = 10) => ({
  path, bytes, sha256: "b".repeat(64), mediaType: "application/octet-stream"
});

test("accepts only requested safe artifacts and returns immutable bounded metadata", () => {
  const result = validateArtifactManifest(request, [artifact("dist/app.apk", 100)]);
  assert.equal(result.totalBytes, 100);
  assert.equal(result.artifacts.length, 1);
  assert.equal(Object.isFrozen(result.artifacts), true);
  assert.equal(Object.isFrozen(result.artifacts[0]), true);
});

test("rejects traversal, unrequested paths, and duplicate artifacts", () => {
  assert.throws(() => validateArtifactManifest(request, [artifact("../secret")]), /unsafe/);
  assert.throws(() => validateArtifactManifest(request, [artifact("private.key")]), /unsafe/);
  assert.throws(() => validateArtifactManifest(request, [artifact("dist/app.apk"), artifact("dist/app.apk")]), /Duplicate/);
});

test("rejects oversized files, manifests, and aggregate size", () => {
  assert.throws(() => validateArtifactManifest(request, [artifact("dist/app.apk", 100 * 1024 * 1024 + 1)]));
  assert.throws(() => validateArtifactManifest(request, [
    artifact("dist/app.apk", 90 * 1024 * 1024),
    artifact("reports/test-results.xml", 90 * 1024 * 1024),
    artifact("logs/a.txt", 90 * 1024 * 1024),
    artifact("logs/b.txt", 90 * 1024 * 1024),
    artifact("logs/c.txt", 90 * 1024 * 1024),
    artifact("logs/d.txt", 90 * 1024 * 1024)
  ]), /total size/);
  assert.throws(() => validateArtifactManifest(request, Array.from({ length: 33 }, (_, i) =>
    artifact(i === 0 ? "dist/app.apk" : "reports/test-results.xml")
  )));
});

test("rejects malformed hashes and metadata fields", () => {
  assert.throws(() => validateArtifactManifest(request, [{ ...artifact("dist/app.apk"), sha256: "nope" }]));
  assert.throws(() => validateArtifactManifest(request, [{ ...artifact("dist/app.apk"), bytes: -1 }]));
  assert.throws(() => validateArtifactManifest(request, [{ ...artifact("dist/app.apk"), extra: true }]));
});
