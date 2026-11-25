ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_status_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_status_check CHECK (status IN ('queued','planning','running','reviewing','waiting_approval','testing','completed','failed','cancelled'));
CREATE TABLE IF NOT EXISTS agent_task_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 task_id UUID NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
 event_type TEXT NOT NULL CHECK (event_type IN ('plan','tool','review','notice')),
 tool_name TEXT NOT NULL DEFAULT '',
 arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
 result TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_events_task_created ON agent_task_events(task_id,created_at);
