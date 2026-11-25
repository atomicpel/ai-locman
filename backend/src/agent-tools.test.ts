import test from "node:test";
import assert from "node:assert/strict";
import { isSafeGitHubPath } from "./agent-tools.js";

test("accepts normal repository-relative paths", () => {
  for (const path of ["README.md", "src/lib/file.ts", "android/app/build.gradle"]) {
    assert.equal(isSafeGitHubPath(path), true, path);
  }
});

test("rejects absolute, traversal, malformed and platform-specific paths", () => {
  for (const path of [
    "",
    "/etc/passwd",
    "../secret",
    "src/../../secret",
    "src/./file.ts",
    "src//file.ts",
    "C:/Windows/win.ini",
    "C:\\Windows\\win.ini",
    "\\\\server\\share\\file",
    "src\\..\\secret",
    "src/\u0000file.ts",
  ]) {
    assert.equal(isSafeGitHubPath(path), false, JSON.stringify(path));
  }
});
