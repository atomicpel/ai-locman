CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_id_project
  ON agent_tasks(id, project_id);

CREATE TABLE IF NOT EXISTS execution_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL,
  project_id UUID NOT NULL,
  repository TEXT NOT NULL CHECK (repository ~ '^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$'),
  revision CHAR(40) NOT NULL CHECK (revision ~ '^[a-fA-F0-9]{40}$'),
  profile TEXT NOT NULL CHECK (profile IN ('node_test','node_typecheck','node_build','android_unit_tests','android_debug_apk','android_lint')),
  executable TEXT NOT NULL CHECK (executable IN ('npm','./gradlew')),
  argv JSONB NOT NULL CHECK (jsonb_typeof(argv) = 'array'),
  diff_sha256 CHAR(64) NOT NULL CHECK (diff_sha256 ~ '^[a-fA-F0-9]{64}$'),
  nonce_sha256 CHAR(64) NOT NULL CHECK (nonce_sha256 ~ '^[a-fA-F0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT execution_approvals_task_project_fk
    FOREIGN KEY (task_id, project_id) REFERENCES agent_tasks(id, project_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_execution_approvals_task_created
  ON execution_approvals(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_approvals_expiry
  ON execution_approvals(expires_at)
  WHERE consumed_at IS NULL;
