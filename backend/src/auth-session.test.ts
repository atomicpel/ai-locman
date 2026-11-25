import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  clearLoginFailures, createAuthSession, getLoginThrottle, recordLoginFailure,
  resolveAuthSession, revokeAuthSession, verifyAccessPassword, pruneExpiredAuthSessions
} from "./auth-session.js";

function fakeDb() {
  const rows = new Map<string, { owner_id: string; expires_at: Date; revoked: boolean }>();
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    rows, calls,
    db: {
      async query(sql: string, values: unknown[] = []) {
        calls.push({ sql, values });
        if (sql.includes("INSERT INTO auth_sessions")) {
          const expires = new Date(Date.now() + 30 * 86400000);
          rows.set(String(values[1]), { owner_id: String(values[0]), expires_at: expires, revoked: false });
          return { rows: [{ expires_at: expires }], rowCount: 1 };
        }
        if (sql.includes("SELECT owner_id, expires_at")) {
          const row = rows.get(String(values[0]));
          return { rows: row && !row.revoked && row.expires_at > new Date() ? [{ owner_id: row.owner_id, expires_at: row.expires_at }] : [], rowCount: row ? 1 : 0 };
        }
        if (sql.includes("UPDATE auth_sessions")) {
          const row = rows.get(String(values[0]));
          if (!row || row.revoked) return { rows: [], rowCount: 0 };
          row.revoked = true;
          return { rows: [{ id: "session-id" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    }
  };
}

test("password comparison is constant-time over fixed-size digests and rejects empty values", () => {
  assert.equal(verifyAccessPassword("correct horse", "correct horse"), true);
  assert.equal(verifyAccessPassword("wrong", "correct horse"), false);
  assert.equal(verifyAccessPassword("", "correct horse"), false);
});

test("creates opaque bearer sessions and persists only a SHA-256 digest", async () => {
  const fake = fakeDb();
  const session = await createAuthSession(fake.db as never, "local-owner");
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(session.expiresAt);
  assert.equal(fake.rows.has(session.token), false);
  assert.equal(fake.rows.has(createHash("sha256").update(session.token).digest("hex")), true);
  assert.equal(fake.calls[0].values[1], createHash("sha256").update(session.token).digest("hex"));
});

test("resolves an active session to its owner without exposing the token", async () => {
  const fake = fakeDb();
  const created = await createAuthSession(fake.db as never, "owner-a");
  assert.deepEqual(await resolveAuthSession(fake.db as never, created.token), {
    ownerId: "owner-a", expiresAt: created.expiresAt
  });
  assert.equal(await resolveAuthSession(fake.db as never, "not-a-token"), null);
});

test("revokes a session and rejects replay after logout", async () => {
  const fake = fakeDb();
  const created = await createAuthSession(fake.db as never, "owner-a");
  assert.equal(await revokeAuthSession(fake.db as never, created.token), true);
  assert.equal(await resolveAuthSession(fake.db as never, created.token), null);
  assert.equal(await revokeAuthSession(fake.db as never, created.token), false);
});

test("prunes expired and long-revoked sessions", async () => {
  const fake = fakeDb();
  await pruneExpiredAuthSessions(fake.db as never);
  assert.match(fake.calls[0].sql, /expires_at <= now\(\)/);
  assert.match(fake.calls[0].sql, /revoked_at < now\(\) - interval '7 days'/);
});

test("persists per-IP failed-login counters and applies a bounded lockout", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("RETURNING failed_attempts")) {
        return { rows: [{ failed_attempts: 5, locked_until: new Date(Date.now() + 900_000) }], rowCount: 1 };
      }
      if (sql.includes("SELECT locked_until")) {
        return { rows: [{ locked_until: new Date(Date.now() + 900_000) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  const failed = await recordLoginFailure(db as never, "127.0.0.1");
  assert.equal(failed.failedAttempts, 5);
  assert.ok(failed.lockedUntil);
  assert.match(calls[0].sql, /failed_attempts \+ 1/);
  assert.match(calls[0].sql, /interval '15 minutes'/);
  const throttle = await getLoginThrottle(db as never, "127.0.0.1");
  assert.ok(throttle.lockedUntil);
  await clearLoginFailures(db as never, "127.0.0.1");
  assert.match(calls[2].sql, /DELETE FROM auth_login_attempts/);
});
