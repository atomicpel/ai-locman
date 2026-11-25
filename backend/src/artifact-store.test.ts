import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { LocalArtifactStore } from "./artifact-store.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const bytes = Buffer.from("APK-like test artifact");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const descriptor = { path: "dist/app.apk", bytes: bytes.length, sha256, mediaType: "application/octet-stream" };
async function fixture(fn: (root: string, store: LocalArtifactStore) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "locman-artifacts-"));
  try { await fn(path.join(root, "store"), new LocalArtifactStore(path.join(root, "store"))); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("stores and retrieves content by task and digest, without using untrusted artifact paths", async () => fixture(async (_root, store) => {
  await store.put(taskId, descriptor, bytes);
  assert.deepEqual(await store.get(taskId, descriptor), bytes);
  await store.put(taskId, descriptor, bytes); // identical retry is safe
}));

test("rejects byte-count, digest, and storage-key mismatches", async () => fixture(async (_root, store) => {
  await assert.rejects(store.put(taskId, descriptor, Buffer.from("different")));
  await assert.rejects(store.put("../outside", descriptor, bytes), /Invalid artifact storage key/);
  await assert.rejects(store.get(taskId, { ...descriptor, bytes: 1 }), /integrity/);
}));

test("deletes only the requested task namespace", async () => fixture(async (_root, store) => {
  await store.put(taskId, descriptor, bytes);
  await store.deleteTask(taskId);
  await assert.rejects(store.get(taskId, descriptor));
}));

test("refuses a symlink as the configured storage root", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "locman-artifacts-link-"));
  const real = path.join(parent, "real");
  const link = path.join(parent, "link");
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(real);
    await symlink(real, link);
    const store = new LocalArtifactStore(link);
    await assert.rejects(store.put(taskId, descriptor, bytes), /symlink/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
