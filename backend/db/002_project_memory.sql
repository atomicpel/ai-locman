CREATE TABLE IF NOT EXISTS project_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  section TEXT NOT NULL CHECK (section IN ('architecture','decisions','knowledge')),
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, section)
);

CREATE INDEX IF NOT EXISTS idx_project_memory_project ON project_memory(project_id);
