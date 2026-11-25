import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";

type AuthDb = Pick<Pool, "query">;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export async function ensureAuthSessionSchema(db: AuthDb): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id TEXT NOT NULL,
      token_sha256 TEXT NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_owner_expiry
      ON auth_sessions(owner_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
      ON auth_sessions(expires_at) WHERE revoked_at IS NULL;
  `);
}

export function verifyAccessPassword(candidate: string, configured: string): boolean {
  if (!candidate || !configured || candidate.length > 4096 || configured.length > 4096) return false;
  const candidateHash = createHash("sha256").update(candidate, "utf8").digest();
  const configuredHash = createHash("sha256").update(configured, "utf8").digest();
  return timingSafeEqual(candidateHash, configuredHash);
}

export async function createAuthSession(
  db: AuthDb,
  ownerId: string,
  lifetimeDays = 30
): Promise<{ token: string; expiresAt: string }> {
  if (!ownerId.trim() || ownerId.length > 200) throw new Error("Invalid session owner");
  if (!Number.isInteger(lifetimeDays) || lifetimeDays < 1 || lifetimeDays > 90) throw new Error("Invalid session lifetime");
  const token = randomBytes(32).toString("base64url");
  const result = await db.query(
    `INSERT INTO auth_sessions (owner_id, token_sha256, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 day'))
     RETURNING expires_at`,
    [ownerId, digest(token), lifetimeDays]
  );
  const row = result.rows[0] as { expires_at: Date | string } | undefined;
  if (!row) throw new Error("Could not create authentication session");
  return { token, expiresAt: new Date(row.expires_at).toISOString() };
}

export async function resolveAuthSession(
  db: AuthDb,
  token: string
): Promise<{ ownerId: string; expiresAt: string } | null> {
  if (!tokenPattern.test(token)) return null;
  const result = await db.query(
    `SELECT owner_id, expires_at FROM auth_sessions
      WHERE token_sha256 = $1 AND revoked_at IS NULL AND expires_at > now()
      LIMIT 1`,
    [digest(token)]
  );
  const row = result.rows[0] as { owner_id: string; expires_at: Date | string } | undefined;
  return row ? { ownerId: row.owner_id, expiresAt: new Date(row.expires_at).toISOString() } : null;
}

export async function revokeAuthSession(db: AuthDb, token: string): Promise<boolean> {
  if (!tokenPattern.test(token)) return false;
  const result = await db.query(
    `UPDATE auth_sessions SET revoked_at = now()
      WHERE token_sha256 = $1 AND revoked_at IS NULL
      RETURNING id`,
    [digest(token)]
  );
  return result.rowCount === 1;
}

export async function pruneExpiredAuthSessions(db: AuthDb): Promise<number> {
  const result = await db.query(
    "DELETE FROM auth_sessions WHERE expires_at <= now() OR revoked_at < now() - interval '7 days'"
  );
  return result.rowCount ?? 0;
}
