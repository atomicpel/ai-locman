import test from "node:test";
import assert from "node:assert/strict";
import { EXECUTION_LIMITS, isSafeArtifactPath, validateExecutionRequest } from "./execution-policy.js";

const valid = {
  taskId: "3d594650-3436-4a4e-8f9b-9bfe8fcd4a11",
  projectId: "b9f9f6f0-5d8d-4e47-a8ec-8b3c9f3d3b21",
  repository: "atomicpel/ai-locman",
  revision: "0123456789abcdef0123456789abcdef01234567",
  profile: "node_test",
  artifactPaths: ["dist/app.apk", "build/reports"],
};

test("pins immutable revision and maps allowlisted profile", () => {
  const result = validateExecutionRequest(valid);
  assert.equal(result.executable, "npm");
  assert.deepEqual(result.argv, ["test"]);
  assert.equal(result.request.revision, valid.revision);
});
test("rejects shell commands, mutable refs and unknown fields", () => {
  assert.throws(() => validateExecutionRequest({ ...valid, profile: "bash -c id" }));
  assert.throws(() => validateExecutionRequest({ ...valid, revision: "main" }));
  assert.throws(() => validateExecutionRequest({ ...valid, command: "npm test" }));
});
test("rejects malformed repository identifiers", () => {
  for (const repository of ["../evil/repo", "owner/name/extra", "owner/..", "owner/.repo"]) {
    assert.throws(() => validateExecutionRequest({ ...valid, repository }));
  }
});
test("rejects artifact path traversal and absolute paths", () => {
  for (const path of ["../secret", "a/../../secret", "/etc/passwd", "C:/temp/file", "a\\b", "a//b", "a/./b"]) {
    assert.equal(isSafeArtifactPath(path), false, path);
  }
  assert.equal(isSafeArtifactPath("artifacts/debug/app.apk"), true);
});
test("resource limits are fixed server-side constants", () => {
  const result = validateExecutionRequest(valid);
  assert.equal(result.limits, EXECUTION_LIMITS);
  assert.equal(result.limits.wallClockMillis, 900000);
});
