import test from "node:test";
import assert from "node:assert/strict";
import { ensureExecutionApprovalSchema } from "./approval-schema.js";

test("initializes the approval schema idempotently with task/project ownership binding", async () => {
  const calls: string[] = [];
  const pool = {
    async query(sql: string) {
      calls.push(sql);
      return { rows: [], rowCount: 0 };
    }
  };
  await ensureExecutionApprovalSchema(pool as never);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_id_project/);
  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS execution_approvals/);
  assert.match(calls[0], /FOREIGN KEY \(task_id, project_id\) REFERENCES agent_tasks\(id, project_id\)/);
  assert.match(calls[0], /CREATE INDEX IF NOT EXISTS idx_execution_approvals_expiry/);
});
