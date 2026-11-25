import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionApproval, consumeExecutionApproval } from "./approval-store.js";

const request = {
  taskId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  repository: "atomicpel/ai-locman",
  revision: "a".repeat(40),
  profile: "node_test",
  artifactPaths: []
};
const diffSha256 = "b".repeat(64);

function fakeDb(rowCount = 1) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls,
    db: {
      async query(sql: string, values: unknown[] = []) {
        calls.push({ sql, values });
        if (sql.includes("INSERT INTO execution_approvals")) {
          return { rows: [{ id: "33333333-3333-4333-8333-333333333333", expires_at: new Date(Date.now() + 60_000) }], rowCount: 1 };
        }
        return { rows: rowCount ? [{ id: "33333333-3333-4333-8333-333333333333" }] : [], rowCount };
      }
    }
  };
}

test("creates a high-entropy challenge and stores only its SHA-256 digest", async () => {
  const fake = fakeDb();
  const approval = await createExecutionApproval(fake.db as never, request, diffSha256);
  assert.equal(approval.challenge.length, 43);
  assert.match(approval.approvalId, /^[0-9a-f-]{36}$/i);
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0].sql, /INSERT INTO execution_approvals/);
  assert.equal(fake.calls[0].values[8] === approval.challenge, false);
  assert.equal(fake.calls[0].values[8], (await import("node:crypto")).createHash("sha256").update(approval.challenge).digest("hex"));
});

test("consumes only a fully bound approval with a single atomic UPDATE", async () => {
  const fake = fakeDb();
  const approval = await createExecutionApproval(fake.db as never, request, diffSha256);
  const consumed = await consumeExecutionApproval(fake.db as never, {
    approvalId: approval.approvalId,
    challenge: approval.challenge,
    request,
    diffSha256
  });
  assert.equal(consumed, true);
  const call = fake.calls[1];
  assert.match(call.sql, /UPDATE execution_approvals/);
  assert.match(call.sql, /consumed_at IS NULL/);
  assert.match(call.sql, /expires_at > now\(\)/);
  assert.match(call.sql, /revision = \$5/);
  assert.match(call.sql, /argv = \$8::jsonb/);
  assert.match(call.sql, /diff_sha256 = \$9/);
});

test("rejects a replay or expired approval when the atomic update returns no row", async () => {
  const fake = fakeDb(0);
  const consumed = await consumeExecutionApproval(fake.db as never, {
    approvalId: "33333333-3333-4333-8333-333333333333",
    challenge: "A".repeat(43),
    request,
    diffSha256
  });
  assert.equal(consumed, false);
});

test("rejects changed diff, malformed challenge, and malformed execution binding", async () => {
  const fake = fakeDb();
  const changedDiff = await consumeExecutionApproval(fake.db as never, {
    approvalId: "33333333-3333-4333-8333-333333333333",
    challenge: "A".repeat(43),
    request,
    diffSha256: "not-a-hash"
  });
  const malformedChallenge = await consumeExecutionApproval(fake.db as never, {
    approvalId: "33333333-3333-4333-8333-333333333333",
    challenge: "short",
    request,
    diffSha256
  });
  const changedRevision = await consumeExecutionApproval(fake.db as never, {
    approvalId: "33333333-3333-4333-8333-333333333333",
    challenge: "A".repeat(43),
    request: { ...request, revision: "c".repeat(40) },
    diffSha256
  });
  assert.equal(changedDiff, false);
  assert.equal(malformedChallenge, false);
  assert.equal(changedRevision, false);
  assert.equal(fake.calls.length, 0);
});
