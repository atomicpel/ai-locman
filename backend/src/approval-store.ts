import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { validateExecutionRequest } from "./execution-policy.js";

type ApprovalDb = Pick<Pool, "query">;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[a-f0-9]{64}$/i;

/** A challenge is short-lived and bound to one immutable execution request and diff. */
export async function createExecutionApproval(
  db: ApprovalDb,
  input: unknown,
  diffSha256: string
): Promise<{ approvalId: string; challenge: string; expiresAt: string }> {
  const validated = validateExecutionRequest(input);
  if (!sha256Pattern.test(diffSha256)) throw new Error("Invalid diff SHA-256");

  const challenge = randomBytes(32).toString("base64url");
  const nonceSha256 = sha256(challenge);

  // The task must belong to this project, and the project must still point at this repository.
  // Expiry is calculated by PostgreSQL to avoid application/database clock skew.
  const inserted = await db.query(
    `INSERT INTO execution_approvals
      (task_id, project_id, repository, revision, profile, executable, argv,
       diff_sha256, nonce_sha256, expires_at)
     SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,now() + interval '5 minutes'
      WHERE EXISTS (
        SELECT 1 FROM agent_tasks t
        JOIN projects p ON p.id = t.project_id
        WHERE t.id = $1 AND t.project_id = $2 AND p.github_repository = $3
      )
     RETURNING id, expires_at`,
    [
      validated.request.taskId,
      validated.request.projectId,
      validated.request.repository,
      validated.request.revision,
      validated.request.profile,
      validated.executable,
      JSON.stringify(validated.argv),
      diffSha256.toLowerCase(),
      nonceSha256
    ]
  );
  const row = inserted.rows[0] as { id: string; expires_at: Date | string } | undefined;
  if (!row) throw new Error("Approval challenge could not be persisted for this task and repository");
  return {
    approvalId: row.id,
    challenge,
    expiresAt: new Date(row.expires_at).toISOString()
  };
}

/**
 * Atomically consumes an approval only when every execution and diff binding matches.
 * A zero-row result means expired, replayed, unknown, or mismatched; callers must fail closed.
 */
export async function consumeExecutionApproval(
  db: ApprovalDb,
  input: {
    approvalId: string;
    challenge: string;
    request: unknown;
    diffSha256: string;
  }
): Promise<boolean> {
  if (!uuidPattern.test(input.approvalId)) return false;
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.challenge)) return false;
  if (!sha256Pattern.test(input.diffSha256)) return false;

  let validated: ReturnType<typeof validateExecutionRequest>;
  try {
    validated = validateExecutionRequest(input.request);
  } catch {
    return false;
  }

  const consumed = await db.query(
    `UPDATE execution_approvals
        SET consumed_at = now()
      WHERE id = $1
        AND task_id = $2
        AND project_id = $3
        AND repository = $4
        AND revision = $5
        AND profile = $6
        AND executable = $7
        AND argv = $8::jsonb
        AND diff_sha256 = $9
        AND nonce_sha256 = $10
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id`,
    [
      input.approvalId,
      validated.request.taskId,
      validated.request.projectId,
      validated.request.repository,
      validated.request.revision,
      validated.request.profile,
      validated.executable,
      JSON.stringify(validated.argv),
      input.diffSha256.toLowerCase(),
      sha256(input.challenge)
    ]
  );
  return consumed.rowCount === 1;
}
