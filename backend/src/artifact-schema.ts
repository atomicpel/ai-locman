import type { Pool } from "pg";

/** Persist artifact metadata only after bytes have been durably stored and hashed. */
export async function ensureArtifactSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_artifacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL,
      project_id UUID NOT NULL,
      artifact_path TEXT NOT NULL CHECK (length(artifact_path) BETWEEN 1 AND 240),
      byte_size BIGINT NOT NULL CHECK (byte_size >= 0 AND byte_size <= 104857600),
      sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-fA-F0-9]{64}$'),
      media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 127),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT task_artifacts_task_project_fk
        FOREIGN KEY (task_id, project_id) REFERENCES agent_tasks(id, project_id) ON DELETE CASCADE,
      CONSTRAINT task_artifacts_task_path_unique UNIQUE (task_id, artifact_path)
    );
    CREATE INDEX IF NOT EXISTS idx_task_artifacts_project_created
      ON task_artifacts(project_id, created_at DESC);
  `);
}
