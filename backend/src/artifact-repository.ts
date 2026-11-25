import type { Pool } from "pg";
import type { ArtifactDescriptor } from "./artifact-policy.js";
import { validateArtifactManifest } from "./artifact-policy.js";
import type { LocalArtifactStore } from "./artifact-store.js";

export type StoredArtifact = ArtifactDescriptor & { id: string; createdAt: string };

/**
 * Coordinates metadata and the content-addressed store.
 * Callers must pass the authenticated owner ID; task/project ownership is rechecked in SQL.
 */
export class ArtifactRepository {
  constructor(private readonly pool: Pool, private readonly store: LocalArtifactStore) {}

  async saveTaskArtifacts(input: {
    ownerId: string;
    taskId: string;
    projectId: string;
    executionRequest: unknown;
    manifest: unknown;
    files: ReadonlyMap<string, Buffer>;
  }): Promise<StoredArtifact[]> {
    const validated = validateArtifactManifest(input.executionRequest, input.manifest);
    if (validated.artifacts.length !== input.files.size) throw new Error("Artifact payload and manifest counts differ");
    const preflight = await this.pool.query(
      `SELECT t.id FROM agent_tasks t
       JOIN projects p ON p.id=t.project_id
       WHERE t.id=$1 AND t.project_id=$2 AND p.owner_id=$3`,
      [input.taskId, input.projectId, input.ownerId]
    );
    if (!preflight.rowCount) throw new Error("Task not found or access denied");
    for (const item of validated.artifacts) {
      const bytes = input.files.get(item.path);
      if (!bytes) throw new Error("Artifact payload is missing: " + item.path);
      await this.store.put(input.taskId, item, bytes);
    }
    for (const path of input.files.keys()) {
      if (!validated.artifacts.some((item) => item.path === path)) throw new Error("Unexpected artifact payload: " + path);
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owned = await client.query(
        `SELECT t.id FROM agent_tasks t
         JOIN projects p ON p.id=t.project_id
         WHERE t.id=$1 AND t.project_id=$2 AND p.owner_id=$3
         FOR UPDATE OF t`,
        [input.taskId, input.projectId, input.ownerId]
      );
      if (!owned.rowCount) throw new Error("Task not found or access denied");
      const saved: StoredArtifact[] = [];
      for (const item of validated.artifacts) {
        const result = await client.query(
          `INSERT INTO task_artifacts (task_id, project_id, artifact_path, byte_size, sha256, media_type)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (task_id, artifact_path) DO UPDATE
           SET byte_size=EXCLUDED.byte_size, sha256=EXCLUDED.sha256, media_type=EXCLUDED.media_type
           RETURNING id, artifact_path AS path, byte_size AS bytes, sha256, media_type AS "mediaType", created_at AS "createdAt"`,
          [input.taskId, input.projectId, item.path, item.bytes, item.sha256, item.mediaType]
        );
        const row = result.rows[0] as StoredArtifact;
        saved.push({ ...row, bytes: Number(row.bytes) });
      }
      await client.query("COMMIT");
      return saved;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listTaskArtifacts(input: { ownerId: string; taskId: string }): Promise<StoredArtifact[] | null> {
    const result = await this.pool.query(
      `SELECT a.id, a.artifact_path AS path, a.byte_size AS bytes, a.sha256,
              a.media_type AS "mediaType", a.created_at AS "createdAt"
       FROM task_artifacts a
       JOIN agent_tasks t ON t.id=a.task_id AND t.project_id=a.project_id
       JOIN projects p ON p.id=t.project_id
       WHERE a.task_id=$1 AND p.owner_id=$2
       ORDER BY a.created_at ASC, a.artifact_path ASC`,
      [input.taskId, input.ownerId]
    );
    const exists = await this.pool.query(
      `SELECT t.id FROM agent_tasks t JOIN projects p ON p.id=t.project_id
       WHERE t.id=$1 AND p.owner_id=$2`,
      [input.taskId, input.ownerId]
    );
    if (!exists.rowCount) return null;
    return result.rows.map((row) => ({ ...row, bytes: Number(row.bytes) }) as StoredArtifact);
  }

  async readTaskArtifact(input: { ownerId: string; taskId: string; artifactId: string }): Promise<{ descriptor: StoredArtifact; data: Buffer } | null> {
    const result = await this.pool.query(
      `SELECT a.id, a.artifact_path AS path, a.byte_size AS bytes, a.sha256,
              a.media_type AS "mediaType", a.created_at AS "createdAt"
       FROM task_artifacts a
       JOIN agent_tasks t ON t.id=a.task_id AND t.project_id=a.project_id
       JOIN projects p ON p.id=t.project_id
       WHERE a.task_id=$1 AND a.id=$2 AND p.owner_id=$3`,
      [input.taskId, input.artifactId, input.ownerId]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0] as StoredArtifact;
    const descriptor = { ...row, bytes: Number(row.bytes) };
    const data = await this.store.get(input.taskId, descriptor);
    return { descriptor, data };
  }
}
