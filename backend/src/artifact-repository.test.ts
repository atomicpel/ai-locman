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

test("stores manifest metadata transactionally and rechecks owner on download", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "locman-artifact-repo-"));
  const root = path.join(parent, "store");
  const bytes = Buffer.from("persisted artifact bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const descriptor = { path: "dist/app.zip", bytes: bytes.length, sha256, mediaType: "application/zip" };
  const row = { id: "33333333-3333-4333-8333-333333333333", path: descriptor.path, bytes: descriptor.bytes,
    sha256, mediaType: descriptor.mediaType, createdAt: new Date().toISOString() };
  const client = {
    query: async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT t.id FROM agent_tasks")) return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }], rowCount: 1 };
      if (sql.includes("INSERT INTO task_artifacts")) return { rows: [row], rowCount: 1 };
      throw new Error("Unexpected transaction query: " + sql);
    },
    release: () => undefined
  };
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT t.id FROM agent_tasks")) return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }], rowCount: 1 };
      if (sql.includes("SELECT a.id")) return values?.[2] === "owner-1" ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      throw new Error("Unexpected pool query: " + sql);
    },
    connect: async () => client
  } as unknown as Pool;
  const repository = new ArtifactRepository(pool, new LocalArtifactStore(root));
  const common = {
    ownerId: "owner-1", taskId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    executionRequest: {
      taskId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      repository: "owner/repo", revision: "a".repeat(40), profile: "node_build",
      artifactPaths: [descriptor.path]
    }
  };
  try {
    const saved = await repository.saveTaskArtifacts({
      ...common, manifest: [descriptor], files: new Map([[descriptor.path, bytes]])
    });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].sha256, sha256);
    const loaded = await repository.readTaskArtifact({
      ownerId: "owner-1", taskId: common.taskId, artifactId: row.id
    });
    assert.deepEqual(loaded?.data, bytes);
    const denied = await repository.readTaskArtifact({
      ownerId: "someone-else", taskId: common.taskId, artifactId: row.id
    });
    assert.equal(denied, null);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
