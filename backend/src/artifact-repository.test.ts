import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { ArtifactRepository } from "./artifact-repository.js";
import { LocalArtifactStore } from "./artifact-store.js";

test("rejects an unowned task before writing artifact bytes", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "locman-artifact-auth-"));
  const root = path.join(parent, "store");
  const bytes = Buffer.from("must not be written");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const pool = {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => { throw new Error("transaction must not start"); }
  } as unknown as Pool;
  const repository = new ArtifactRepository(pool, new LocalArtifactStore(root));
  try {
    await assert.rejects(repository.saveTaskArtifacts({
      ownerId: "not-owner",
      taskId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      executionRequest: {
        taskId: "11111111-1111-4111-8111-111111111111",
        projectId: "22222222-2222-4222-8222-222222222222",
        repository: "owner/repo",
        revision: "a".repeat(40),
        profile: "node_build",
        artifactPaths: ["dist/app.zip"]
      },
      manifest: [{ path: "dist/app.zip", bytes: bytes.length, sha256, mediaType: "application/zip" }],
      files: new Map([["dist/app.zip", bytes]])
    }), /access denied/);
    await assert.rejects(access(root));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
