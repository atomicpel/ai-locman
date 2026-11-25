import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import { z } from "zod";
import { Pool } from "pg";
import { Queue } from "bullmq";
import { createHash, createSign, randomBytes } from "node:crypto";
import { assertDevelopmentOnlyRuntime } from "./runtime-safety.js";
import { ensureExecutionApprovalSchema } from "./approval-schema.js";

assertDevelopmentOnlyRuntime(process.env.NODE_ENV);

const app = Fastify({ logger: true, bodyLimit: 1_000_000 });
await app.register(helmet);
await app.register(cors, { origin: process.env.NODE_ENV === "production" ? false : true });
await app.register(sensible);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await ensureExecutionApprovalSchema(pool);
const DEV_OWNER_ID = "local-dev-user";
const DEFAULT_MODEL = process.env.OPENROUTER_DEFAULT_MODEL ?? "openrouter/auto";
await pool.query(`
  CREATE TABLE IF NOT EXISTS project_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    section TEXT NOT NULL CHECK (section IN ('architecture','decisions','knowledge')),
    content TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, section)
  );
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT 'openrouter/auto';
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_repository TEXT NOT NULL DEFAULT '';
  CREATE TABLE IF NOT EXISTS github_installations (
    owner_id TEXT NOT NULL,
    installation_id BIGINT NOT NULL,
    account_login TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'User',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, installation_id)
  );
  CREATE TABLE IF NOT EXISTS github_install_states (
    state_hash TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await pool.query(`
  ALTER TABLE agent_tasks
    ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS result TEXT,
    ADD COLUMN IF NOT EXISTS error TEXT,
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES agent_tasks(id) ON DELETE SET NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_task_role
    ON messages(task_id, role) WHERE task_id IS NOT NULL;
  ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_status_check;
  ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_status_check CHECK (status IN ('queued','planning','running','reviewing','waiting_approval','testing','completed','failed','cancelled'));
  CREATE TABLE IF NOT EXISTS agent_task_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), task_id UUID NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN ('plan','tool','review','notice')),
    tool_name TEXT NOT NULL DEFAULT '', arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
    result TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_task_events_task_created ON agent_task_events(task_id,created_at);
`);

const redisUrl = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
const redisConnection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  maxRetriesPerRequest: null,
  ...(redisUrl.protocol === "rediss:" ? { tls: {} } : {})
};
let taskQueue: Queue | null = null;
function getTaskQueue() {
  if (!taskQueue) taskQueue = new Queue("ai-locman-tasks", { connection: redisConnection });
  return taskQueue;
}

app.get("/health", async () => ({ status: "ok", service: "ai-locman-api", version: "0.2.0" }));

// Development MVP only. Do not expose this unauthenticated API to the public internet.
app.get("/api/v1/projects", async () => {
  const { rows } = await pool.query(
    "SELECT id, name, description, model, github_repository, created_at FROM projects WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100",
    [DEV_OWNER_ID]
  );
  return { items: rows };
});

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
  model: z.string().trim().min(1).max(200).default(DEFAULT_MODEL)
});

app.post("/api/v1/projects", async (request, reply) => {
  const parsed = createProjectSchema.safeParse(request.body);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { name, description, model } = parsed.data;
  const { rows } = await pool.query(
    `INSERT INTO projects (owner_id, name, description, model)
     VALUES ($1, $2, $3, $4) RETURNING id, name, description, model, created_at`,
    [DEV_OWNER_ID, name, description, model]
  );
  return reply.code(201).send(rows[0]);
});


const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  githubRepository: z.string().max(201).optional(),
  instructions: z.string().max(10000).optional()
}).refine((value) => Object.keys(value).length > 0, "Нечего обновлять");

app.patch("/api/v1/projects/:projectId", async (request, reply) => {
  const parsedParams = projectParam.safeParse(request.params);
  const parsedBody = updateProjectSchema.safeParse(request.body);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const current = await pool.query(
    "SELECT id, name, description, model, instructions, github_repository FROM projects WHERE id=$1 AND owner_id=$2",
    [parsedParams.data.projectId, DEV_OWNER_ID]
  );
  if (!current.rowCount) return reply.notFound("Проект не найден");
  const next = { ...current.rows[0], githubRepository: current.rows[0].github_repository, ...parsedBody.data };
  const { rows } = await pool.query(
    `UPDATE projects SET name=$2, description=$3, model=$4, instructions=$5, github_repository=$6, updated_at=now()
     WHERE id=$1 RETURNING id, name, description, model, instructions, github_repository, created_at, updated_at`,
    [parsedParams.data.projectId, next.name, next.description, next.model ?? DEFAULT_MODEL, next.instructions ?? "", next.githubRepository ?? ""]
  );
  return rows[0];
});

const projectParam = z.object({ projectId: z.string().uuid() });
const conversationParam = z.object({ conversationId: z.string().uuid() });

app.get("/api/v1/projects/:projectId/conversations", async (request, reply) => {
  const parsed = projectParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id = $1 AND owner_id = $2", [parsed.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.created_at,
      (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
     FROM conversations c WHERE c.project_id = $1 ORDER BY c.created_at DESC LIMIT 200`,
    [parsed.data.projectId]
  );
  return { items: rows };
});


const createConversationSchema = z.object({ title: z.string().trim().min(1).max(120).default("Новый чат") });
app.post("/api/v1/projects/:projectId/conversations", async (request, reply) => {
  const parsedParams = projectParam.safeParse(request.params);
  const parsedBody = createConversationSchema.safeParse(request.body ?? {});
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsedParams.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    "INSERT INTO conversations (project_id, title) VALUES ($1, $2) RETURNING id, title, created_at",
    [parsedParams.data.projectId, parsedBody.data.title]
  );
  return reply.code(201).send(rows[0]);
});

const updateConversationSchema = z.object({ title: z.string().trim().min(1).max(120) });
app.patch("/api/v1/conversations/:conversationId", async (request, reply) => {
  const parsedParams = conversationParam.safeParse(request.params);
  const parsedBody = updateConversationSchema.safeParse(request.body);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const { rows } = await pool.query(
    `UPDATE conversations c SET title=$1
     FROM projects p WHERE c.id=$2 AND p.id=c.project_id AND p.owner_id=$3
     RETURNING c.id, c.title, c.created_at`,
    [parsedBody.data.title, parsedParams.data.conversationId, DEV_OWNER_ID]
  );
  if (!rows.length) return reply.notFound("Диалог не найден");
  return rows[0];
});

app.delete("/api/v1/conversations/:conversationId", async (request, reply) => {
  const parsedParams = conversationParam.safeParse(request.params);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  const { rowCount } = await pool.query(
    `DELETE FROM conversations c USING projects p
     WHERE c.id=$1 AND p.id=c.project_id AND p.owner_id=$2`,
    [parsedParams.data.conversationId, DEV_OWNER_ID]
  );
  if (!rowCount) return reply.notFound("Диалог не найден");
  return reply.code(204).send();
});

app.get("/api/v1/conversations/:conversationId/messages", async (request, reply) => {
  const parsed = conversationParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { rows } = await pool.query(
    `SELECT m.id, m.role, m.content, m.model, m.created_at
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     JOIN projects p ON p.id = c.project_id
     WHERE c.id = $1 AND p.owner_id = $2 AND m.role IN ('user','assistant')
     ORDER BY m.created_at ASC LIMIT 1000`,
    [parsed.data.conversationId, DEV_OWNER_ID]
  );
  if (!rows.length) {
    const exists = await pool.query(
      "SELECT c.id FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=$1 AND p.owner_id=$2",
      [parsed.data.conversationId, DEV_OWNER_ID]
    );
    if (!exists.rowCount) return reply.notFound("Диалог не найден");
  }
  return { items: rows };
});

app.get("/api/v1/projects/:projectId/memory", async (request, reply) => {
  const parsed = projectParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsed.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    "SELECT id, section, content, updated_at FROM project_memory WHERE project_id=$1 ORDER BY section",
    [parsed.data.projectId]
  );
  const bySection = new Map(rows.map((row) => [row.section, row]));
  return { items: ["architecture", "decisions", "knowledge"].map((section) => bySection.get(section) ?? ({ section, content: "", updated_at: null })) };
});

const memorySchema = z.object({
  section: z.enum(["architecture", "decisions", "knowledge"]),
  content: z.string().max(50000)
});
app.put("/api/v1/projects/:projectId/memory", async (request, reply) => {
  const parsedParams = projectParam.safeParse(request.params);
  const parsedBody = memorySchema.safeParse(request.body);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsedParams.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    `INSERT INTO project_memory (project_id, section, content)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id, section) DO UPDATE SET content=EXCLUDED.content, updated_at=now()
     RETURNING id, section, content, updated_at`,
    [parsedParams.data.projectId, parsedBody.data.section, parsedBody.data.content]
  );
  return rows[0];
});

app.get("/api/v1/models", async (_request, reply) => {
  const headers: Record<string, string> = {};
  if (process.env.OPENROUTER_API_KEY) headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
  const response = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/models`, { headers });
  if (!response.ok) return reply.code(502).send({ error: "Не удалось получить список моделей OpenRouter" });
  const payload = await response.json() as { data?: Array<{ id: string; name?: string; context_length?: number }> };
  return { items: (payload.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id, contextLength: m.context_length })) };
});

const chatSchema = z.object({
  projectId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  model: z.string().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(20000)
});

app.post("/api/v1/chat", async (request, reply) => {
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { projectId, message } = parsed.data;
  const projectResult = await pool.query(
    "SELECT id, name, instructions, model FROM projects WHERE id = $1 AND owner_id = $2",
    [projectId, DEV_OWNER_ID]
  );
  const project = projectResult.rows[0];
  if (!project) return reply.notFound("Проект не найден");
  const model = parsed.data.model ?? project.model ?? DEFAULT_MODEL;
  const memoryResult = await pool.query(
    "SELECT section, content FROM project_memory WHERE project_id=$1 AND content <> '' ORDER BY section",
    [projectId]
  );
  const memoryText = memoryResult.rows
    .map((item) => `[${item.section}]\n${item.content}`)
    .join("\n\n");

  let conversationId = parsed.data.conversationId;
  if (conversationId) {
    const check = await pool.query(
      "SELECT id FROM conversations WHERE id = $1 AND project_id = $2",
      [conversationId, projectId]
    );
    if (!check.rowCount) return reply.notFound("Диалог не найден в этом проекте");
  } else {
    const created = await pool.query(
      "INSERT INTO conversations (project_id, title) VALUES ($1, $2) RETURNING id",
      [projectId, message.slice(0, 70)]
    );
    conversationId = created.rows[0].id as string;
  }

  await pool.query(
    "INSERT INTO messages (conversation_id, role, content, model) VALUES ($1, 'user', $2, $3)",
    [conversationId, message, model]
  );
  const history = await pool.query(
    `SELECT role, content FROM messages WHERE conversation_id = $1
     AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 30`,
    [conversationId]
  );
  const messages = [
    { role: "system", content: `Ты — AI Locman, русскоязычный помощник по разработке. Проект: ${project.name}. Инструкции проекта: ${project.instructions || "нет"}.\n\nДОЛГОВРЕМЕННАЯ ПАМЯТЬ ЭТОГО ПРОЕКТА (не смешивай с другими проектами):\n${memoryText || "Пока пуста."}\n\nИспользуй память как контекст и сохраняй согласованность с принятыми решениями. Если пользователь сообщает устойчивое архитектурное решение или важный факт, предложи явно сохранить его в память, но не выдумывай, что сохранил автоматически. Отвечай конкретно, не утверждай, что выполнил действия с файлами или GitHub, если инструменты реально не запускались.` },
    ...history.rows.reverse()
  ];

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return reply.code(503).send({ error: "На backend не настроен OPENROUTER_API_KEY. Добавь ключ в .env на сервере.", conversationId });

  const response = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_PUBLIC_URL ?? "http://localhost:8080",
      "X-Title": "AI Locman"
    },
    body: JSON.stringify({ model, messages, stream: false })
  });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 1200);
    request.log.error({ status: response.status, details }, "OpenRouter request failed");
    return reply.code(502).send({ error: `Ошибка OpenRouter (${response.status}). Проверь модель, ключ и баланс.`, conversationId });
  }
  const result = await response.json() as { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>; usage?: unknown };
  const raw = result.choices?.[0]?.message?.content;
  const answer = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part) => part.text ?? "").join("") : "Модель вернула пустой ответ.";
  await pool.query(
    "INSERT INTO messages (conversation_id, role, content, model) VALUES ($1, 'assistant', $2, $3)",
    [conversationId, answer, model]
  );
  return { conversationId, model, answer, usage: result.usage ?? null };
});


const taskSchema = z.object({
  prompt: z.string().trim().min(1).max(20000),
  model: z.string().min(1).max(200).optional(),
  conversationId: z.string().uuid().optional()
});

app.post("/api/v1/projects/:projectId/tasks", async (request, reply) => {
  const parsedProject = projectParam.safeParse(request.params);
  const parsedBody = taskSchema.safeParse(request.body);
  if (!parsedProject.success) return reply.badRequest(parsedProject.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const owned = await pool.query(
    "SELECT id, model FROM projects WHERE id=$1 AND owner_id=$2",
    [parsedProject.data.projectId, DEV_OWNER_ID]
  );
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  if (parsedBody.data.conversationId) {
    const conversation = await pool.query(
      "SELECT id FROM conversations WHERE id=$1 AND project_id=$2",
      [parsedBody.data.conversationId, parsedProject.data.projectId]
    );
    if (!conversation.rowCount) return reply.notFound("Диалог не найден в этом проекте");
  }
  const created = await pool.query(
    `INSERT INTO agent_tasks (project_id, conversation_id, prompt, model, status)
     VALUES ($1, $2, $3, $4, 'queued')
     RETURNING id, project_id, conversation_id, prompt, model, status, created_at`,
    [parsedProject.data.projectId, parsedBody.data.conversationId ?? null, parsedBody.data.prompt, parsedBody.data.model ?? owned.rows[0].model ?? DEFAULT_MODEL]
  );
  const task = created.rows[0];
  try {
    await getTaskQueue().add("execute", { taskId: task.id }, {
      jobId: task.id, attempts: 2, backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 500, removeOnFail: 1000
    });
  } catch (error) {
    await pool.query(
      "UPDATE agent_tasks SET status='failed', error=$2, completed_at=now(), updated_at=now() WHERE id=$1",
      [task.id, error instanceof Error ? error.message.slice(0, 1000) : "Redis queue unavailable"]
    );
    request.log.error({ err: error, taskId: task.id }, "Could not enqueue agent task");
    return reply.code(503).send({ error: "Очередь задач сейчас недоступна. Попробуй позже.", taskId: task.id });
  }
  return reply.code(202).send(task);
});

app.get("/api/v1/projects/:projectId/tasks", async (request, reply) => {
  const parsed = projectParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsed.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    `SELECT id, conversation_id, prompt, model, status, result, error, created_at, updated_at, started_at, completed_at
     FROM agent_tasks WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [parsed.data.projectId]
  );
  return { items: rows };
});

const taskParam = z.object({ taskId: z.string().uuid() });

app.get("/api/v1/tasks/:taskId/events", async (request, reply) => {
  const parsed = taskParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT t.id FROM agent_tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND p.owner_id=$2",[parsed.data.taskId,DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Задача не найдена");
  const { rows } = await pool.query("SELECT id,event_type,tool_name,arguments,result,created_at FROM agent_task_events WHERE task_id=$1 ORDER BY created_at ASC LIMIT 200",[parsed.data.taskId]);
  return { items: rows };
});

app.get("/api/v1/tasks/:taskId", async (request, reply) => {
  const parsed = taskParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { rows } = await pool.query(
    `SELECT t.id, t.project_id, t.conversation_id, t.prompt, t.model, t.status, t.result, t.error,
            t.created_at, t.updated_at, t.started_at, t.completed_at
     FROM agent_tasks t JOIN projects p ON p.id=t.project_id
     WHERE t.id=$1 AND p.owner_id=$2`,
    [parsed.data.taskId, DEV_OWNER_ID]
  );
  if (!rows.length) return reply.notFound("Задача не найдена");
  return rows[0];
});

app.post("/api/v1/tasks/:taskId/cancel", async (request, reply) => {
  const parsed = taskParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query(
    "SELECT t.id, t.status FROM agent_tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND p.owner_id=$2",
    [parsed.data.taskId, DEV_OWNER_ID]
  );
  if (!owned.rowCount) return reply.notFound("Задача не найдена");
  if (["completed", "failed", "cancelled"].includes(owned.rows[0].status)) {
    return reply.code(409).send({ error: "Задача уже завершена", status: owned.rows[0].status });
  }
  await pool.query("UPDATE agent_tasks SET cancel_requested=TRUE, updated_at=now() WHERE id=$1", [parsed.data.taskId]);
  const job = await getTaskQueue().getJob(parsed.data.taskId);
  if (job && ["waiting", "delayed", "paused"].includes(await job.getState())) {
    await job.remove();
    await pool.query(
      "UPDATE agent_tasks SET status='cancelled', completed_at=now(), updated_at=now() WHERE id=$1",
      [parsed.data.taskId]
    );
  }
  return { id: parsed.data.taskId, status: "cancellation_requested" };
});


const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";

function githubAppJwt(): string {
  const clientId = process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientId || !privateKey) throw new Error("GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY are required");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({ iat: now - 60, exp: now + 9 * 60, iss: clientId });
  const unsigned = header + "." + payload;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return unsigned + "." + signer.sign(privateKey, "base64url");
}

async function githubAppRequest(path: string, method: "GET" | "POST" = "GET") {
  const response = await fetch(GITHUB_API + path, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + githubAppJwt(),
      "X-GitHub-Api-Version": GITHUB_API_VERSION
    }
  });
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  if (!response.ok) throw new Error("GitHub API " + response.status + ": " + String(payload.message ?? raw).slice(0, 1000));
  return payload;
}

async function githubInstallationToken(installationId: number): Promise<string> {
  const payload = await githubAppRequest("/app/installations/" + installationId + "/access_tokens", "POST");
  const token = payload.token;
  if (typeof token !== "string" || !token) throw new Error("GitHub did not return an installation token");
  return token;
}

async function githubInstallationRows() {
  const { rows } = await pool.query(
    "SELECT installation_id, account_login, account_type FROM github_installations WHERE owner_id=$1 ORDER BY account_login",
    [DEV_OWNER_ID]
  );
  return rows as Array<{ installation_id: string | number; account_login: string; account_type: string }>;
}

async function githubInstallationRequest(token: string, path: string, accept: "application/vnd.github.diff"): Promise<string>;
async function githubInstallationRequest(token: string, path: string, accept?: string): Promise<Record<string, unknown>>;
async function githubInstallationRequest(
  token: string, path: string, accept = "application/vnd.github+json"
): Promise<Record<string, unknown> | string> {
  const response = await fetch(GITHUB_API + path, {
    headers: {
      Accept: accept,
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": GITHUB_API_VERSION
    }
  });
  const raw = await response.text();
  if (!response.ok) {
    let message = raw;
    try { message = String((JSON.parse(raw) as Record<string, unknown>).message ?? raw); } catch { /* keep raw body */ }
    throw new Error("GitHub API " + response.status + ": " + message.slice(0, 1000));
  }
  if (accept === "application/vnd.github.diff") return raw;
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

async function githubRepoToken(owner: string, repo: string): Promise<string> {
  const installations = await githubInstallationRows();
  for (const installation of installations) {
    const token = await githubInstallationToken(Number(installation.installation_id));
    try {
      await githubInstallationRequest(token, "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo));
      return token;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("GitHub API 404")) continue;
      throw error;
    }
  }
  throw new Error("Репозиторий не входит в доступные установки GitHub App");
}

const githubRepoParams = z.object({
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)
});

app.get("/api/v1/github/connect", async (_request, reply) => {
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug || !(process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_APP_ID) || !process.env.GITHUB_APP_PRIVATE_KEY) {
    return reply.code(503).send({ error: "GitHub App не настроен: добавь GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID и GITHUB_APP_PRIVATE_KEY в backend .env" });
  }
  const state = randomBytes(24).toString("base64url");
  await pool.query(
    "INSERT INTO github_install_states (state_hash, owner_id, expires_at) VALUES ($1, $2, now() + interval '30 minutes')",
    [createHash("sha256").update(state).digest("hex"), DEV_OWNER_ID]
  );
  const url = new URL("https://github.com/apps/" + encodeURIComponent(slug) + "/installations/new");
  url.searchParams.set("state", state);
  return reply.redirect(url.toString());
});

app.get("/api/v1/github/callback", async (request, reply) => {
  const query = z.object({
    state: z.string().min(20).max(200),
    installation_id: z.coerce.number().int().positive()
  }).safeParse(request.query);
  if (!query.success) return reply.badRequest("Некорректные параметры GitHub callback");
  const stateHash = createHash("sha256").update(query.data.state).digest("hex");
  // Consume the one-time OAuth state atomically to prevent concurrent callback replay.
  const stateResult = await pool.query(
    "DELETE FROM github_install_states WHERE state_hash=$1 AND expires_at>now() RETURNING owner_id",
    [stateHash]
  );
  if (!stateResult.rowCount) return reply.code(400).send("Ссылка подключения GitHub устарела или уже использована. Вернись в AI Locman и начни подключение заново.");
  try {
    const installation = await githubAppRequest("/app/installations/" + query.data.installation_id);
    const account = installation.account as Record<string, unknown> | undefined;
    const login = typeof account?.login === "string" ? account.login : "GitHub account";
    const type = typeof account?.type === "string" ? account.type : "User";
    await pool.query(
      `INSERT INTO github_installations (owner_id, installation_id, account_login, account_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id, installation_id) DO UPDATE
       SET account_login=EXCLUDED.account_login, account_type=EXCLUDED.account_type, updated_at=now()`,
      [stateResult.rows[0].owner_id, query.data.installation_id, login, type]
    );
    return reply.type("text/html; charset=utf-8").send(
      "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>AI Locman</title></head><body style='font-family:system-ui;background:#0a1020;color:#eaf0fa;padding:32px'><h2>GitHub подключён</h2><p>Установка подтверждена. Можно закрыть эту страницу и вернуться в AI Locman.</p></body></html>"
    );
  } catch (error) {
    request.log.error({ err: error }, "GitHub installation validation failed");
    return reply.code(502).send("Не удалось проверить установку GitHub App. Проверь App ID и private key на backend.");
  }
});

app.get("/api/v1/github/status", async () => {
  const installations = await githubInstallationRows();
  return { connected: installations.length > 0, installations };
});

app.delete("/api/v1/github/connection", async (_request, reply) => {
  await pool.query("DELETE FROM github_installations WHERE owner_id=$1", [DEV_OWNER_ID]);
  return reply.code(204).send();
});

app.get("/api/v1/github/repositories", async (request, reply) => {
  try {
    const installations = await githubInstallationRows();
    const repositories: unknown[] = [];
    for (const installation of installations) {
      const token = await githubInstallationToken(Number(installation.installation_id));
      let page = 1;
      while (page <= 20) {
        const result = await githubInstallationRequest(token, "/installation/repositories?per_page=100&page=" + page);
        const items = Array.isArray(result.repositories) ? result.repositories : [];
        repositories.push(...items);
        if (items.length < 100 || repositories.length >= Number(result.total_count ?? 0)) break;
        page++;
      }
    }
    return { items: repositories };
  } catch (error) {
    request.log.error({ err: error }, "Could not list GitHub repositories");
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo));
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/branches", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/branches?per_page=100");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/contents", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  const query = z.object({
    path: z.string().max(1000).optional(),
    ref: z.string().max(255).optional()
  }).safeParse(request.query);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  if (!query.success) return reply.badRequest(query.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    const path = query.data.path
      ? "/" + query.data.path.split("/").map(encodeURIComponent).join("/")
      : "";
    const params = new URLSearchParams();
    if (query.data.ref) params.set("ref", query.data.ref);
    const queryString = params.toString();
    const suffix = queryString ? "?" + queryString : "";
    return await githubInstallationRequest(
      token,
      "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/contents" + path + suffix
    );
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/commits", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/commits?per_page=50");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/pulls", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/pulls?state=all&per_page=50");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/actions", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/actions/runs?per_page=50");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/compare", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  const query = z.object({ base: z.string().min(1).max(255), head: z.string().min(1).max(255) }).safeParse(request.query);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  if (!query.success) return reply.badRequest(query.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    const response = await githubInstallationRequest(
      token,
      "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) +
        "/compare/" + encodeURIComponent(query.data.base) + "..." + encodeURIComponent(query.data.head),
      "application/vnd.github.diff"
    );
    return reply.type("text/plain; charset=utf-8").send(response);
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});


const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: "0.0.0.0" });
),
    revision CHAR(40) NOT NULL CHECK (revision ~ '^[a-fA-F0-9]{40}


const redisUrl = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
const redisConnection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  maxRetriesPerRequest: null,
  ...(redisUrl.protocol === "rediss:" ? { tls: {} } : {})
};
let taskQueue: Queue | null = null;
function getTaskQueue() {
  if (!taskQueue) taskQueue = new Queue("ai-locman-tasks", { connection: redisConnection });
  return taskQueue;
}

app.get("/health", async () => ({ status: "ok", service: "ai-locman-api", version: "0.2.0" }));

// Development MVP only. Do not expose this unauthenticated API to the public internet.
app.get("/api/v1/projects", async () => {
  const { rows } = await pool.query(
    "SELECT id, name, description, model, github_repository, created_at FROM projects WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100",
    [DEV_OWNER_ID]
  );
  return { items: rows };
});

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
  model: z.string().trim().min(1).max(200).default(DEFAULT_MODEL)
});

app.post("/api/v1/projects", async (request, reply) => {
  const parsed = createProjectSchema.safeParse(request.body);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { name, description, model } = parsed.data;
  const { rows } = await pool.query(
    `INSERT INTO projects (owner_id, name, description, model)
     VALUES ($1, $2, $3, $4) RETURNING id, name, description, model, created_at`,
    [DEV_OWNER_ID, name, description, model]
  );
  return reply.code(201).send(rows[0]);
});


const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  githubRepository: z.string().max(201).optional(),
  instructions: z.string().max(10000).optional()
}).refine((value) => Object.keys(value).length > 0, "Нечего обновлять");

app.patch("/api/v1/projects/:projectId", async (request, reply) => {
  const parsedParams = projectParam.safeParse(request.params);
  const parsedBody = updateProjectSchema.safeParse(request.body);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const current = await pool.query(
    "SELECT id, name, description, model, instructions, github_repository FROM projects WHERE id=$1 AND owner_id=$2",
    [parsedParams.data.projectId, DEV_OWNER_ID]
  );
  if (!current.rowCount) return reply.notFound("Проект не найден");
  const next = { ...current.rows[0], githubRepository: current.rows[0].github_repository, ...parsedBody.data };
  const { rows } = await pool.query(
    `UPDATE projects SET name=$2, description=$3, model=$4, instructions=$5, github_repository=$6, updated_at=now()
     WHERE id=$1 RETURNING id, name, description, model, instructions, github_repository, created_at, updated_at`,
    [parsedParams.data.projectId, next.name, next.description, next.model ?? DEFAULT_MODEL, next.instructions ?? "", next.githubRepository ?? ""]
  );
  return rows[0];
});

const projectParam = z.object({ projectId: z.string().uuid() });
const conversationParam = z.object({ conversationId: z.string().uuid() });

app.get("/api/v1/projects/:projectId/conversations", async (request, reply) => {
  const parsed = projectParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id = $1 AND owner_id = $2", [parsed.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.created_at,
      (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
     FROM conversations c WHERE c.project_id = $1 ORDER BY c.created_at DESC LIMIT 200`,
    [parsed.data.projectId]
  );
  return { items: rows };
});


const createConversationSchema = z.object({ title: z.string().trim().min(1).max(120).default("Новый чат") });
app.post("/api/v1/projects/:projectId/conversations", async (request, reply) => {
  const parsedParams = projectParam.safeParse(request.params);
  const parsedBody = createConversationSchema.safeParse(request.body ?? {});
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsedParams.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    "INSERT INTO conversations (project_id, title) VALUES ($1, $2) RETURNING id, title, created_at",
    [parsedParams.data.projectId, parsedBody.data.title]
  );
  return reply.code(201).send(rows[0]);
});

const updateConversationSchema = z.object({ title: z.string().trim().min(1).max(120) });
app.patch("/api/v1/conversations/:conversationId", async (request, reply) => {
  const parsedParams = conversationParam.safeParse(request.params);
  const parsedBody = updateConversationSchema.safeParse(request.body);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const { rows } = await pool.query(
    `UPDATE conversations c SET title=$1
     FROM projects p WHERE c.id=$2 AND p.id=c.project_id AND p.owner_id=$3
     RETURNING c.id, c.title, c.created_at`,
    [parsedBody.data.title, parsedParams.data.conversationId, DEV_OWNER_ID]
  );
  if (!rows.length) return reply.notFound("Диалог не найден");
  return rows[0];
});

app.delete("/api/v1/conversations/:conversationId", async (request, reply) => {
  const parsedParams = conversationParam.safeParse(request.params);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  const { rowCount } = await pool.query(
    `DELETE FROM conversations c USING projects p
     WHERE c.id=$1 AND p.id=c.project_id AND p.owner_id=$2`,
    [parsedParams.data.conversationId, DEV_OWNER_ID]
  );
  if (!rowCount) return reply.notFound("Диалог не найден");
  return reply.code(204).send();
});

app.get("/api/v1/conversations/:conversationId/messages", async (request, reply) => {
  const parsed = conversationParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { rows } = await pool.query(
    `SELECT m.id, m.role, m.content, m.model, m.created_at
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     JOIN projects p ON p.id = c.project_id
     WHERE c.id = $1 AND p.owner_id = $2 AND m.role IN ('user','assistant')
     ORDER BY m.created_at ASC LIMIT 1000`,
    [parsed.data.conversationId, DEV_OWNER_ID]
  );
  if (!rows.length) {
    const exists = await pool.query(
      "SELECT c.id FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=$1 AND p.owner_id=$2",
      [parsed.data.conversationId, DEV_OWNER_ID]
    );
    if (!exists.rowCount) return reply.notFound("Диалог не найден");
  }
  return { items: rows };
});

app.get("/api/v1/projects/:projectId/memory", async (request, reply) => {
  const parsed = projectParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsed.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    "SELECT id, section, content, updated_at FROM project_memory WHERE project_id=$1 ORDER BY section",
    [parsed.data.projectId]
  );
  const bySection = new Map(rows.map((row) => [row.section, row]));
  return { items: ["architecture", "decisions", "knowledge"].map((section) => bySection.get(section) ?? ({ section, content: "", updated_at: null })) };
});

const memorySchema = z.object({
  section: z.enum(["architecture", "decisions", "knowledge"]),
  content: z.string().max(50000)
});
app.put("/api/v1/projects/:projectId/memory", async (request, reply) => {
  const parsedParams = projectParam.safeParse(request.params);
  const parsedBody = memorySchema.safeParse(request.body);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsedParams.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    `INSERT INTO project_memory (project_id, section, content)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id, section) DO UPDATE SET content=EXCLUDED.content, updated_at=now()
     RETURNING id, section, content, updated_at`,
    [parsedParams.data.projectId, parsedBody.data.section, parsedBody.data.content]
  );
  return rows[0];
});

app.get("/api/v1/models", async (_request, reply) => {
  const headers: Record<string, string> = {};
  if (process.env.OPENROUTER_API_KEY) headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
  const response = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/models`, { headers });
  if (!response.ok) return reply.code(502).send({ error: "Не удалось получить список моделей OpenRouter" });
  const payload = await response.json() as { data?: Array<{ id: string; name?: string; context_length?: number }> };
  return { items: (payload.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id, contextLength: m.context_length })) };
});

const chatSchema = z.object({
  projectId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  model: z.string().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(20000)
});

app.post("/api/v1/chat", async (request, reply) => {
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { projectId, message } = parsed.data;
  const projectResult = await pool.query(
    "SELECT id, name, instructions, model FROM projects WHERE id = $1 AND owner_id = $2",
    [projectId, DEV_OWNER_ID]
  );
  const project = projectResult.rows[0];
  if (!project) return reply.notFound("Проект не найден");
  const model = parsed.data.model ?? project.model ?? DEFAULT_MODEL;
  const memoryResult = await pool.query(
    "SELECT section, content FROM project_memory WHERE project_id=$1 AND content <> '' ORDER BY section",
    [projectId]
  );
  const memoryText = memoryResult.rows
    .map((item) => `[${item.section}]\n${item.content}`)
    .join("\n\n");

  let conversationId = parsed.data.conversationId;
  if (conversationId) {
    const check = await pool.query(
      "SELECT id FROM conversations WHERE id = $1 AND project_id = $2",
      [conversationId, projectId]
    );
    if (!check.rowCount) return reply.notFound("Диалог не найден в этом проекте");
  } else {
    const created = await pool.query(
      "INSERT INTO conversations (project_id, title) VALUES ($1, $2) RETURNING id",
      [projectId, message.slice(0, 70)]
    );
    conversationId = created.rows[0].id as string;
  }

  await pool.query(
    "INSERT INTO messages (conversation_id, role, content, model) VALUES ($1, 'user', $2, $3)",
    [conversationId, message, model]
  );
  const history = await pool.query(
    `SELECT role, content FROM messages WHERE conversation_id = $1
     AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 30`,
    [conversationId]
  );
  const messages = [
    { role: "system", content: `Ты — AI Locman, русскоязычный помощник по разработке. Проект: ${project.name}. Инструкции проекта: ${project.instructions || "нет"}.\n\nДОЛГОВРЕМЕННАЯ ПАМЯТЬ ЭТОГО ПРОЕКТА (не смешивай с другими проектами):\n${memoryText || "Пока пуста."}\n\nИспользуй память как контекст и сохраняй согласованность с принятыми решениями. Если пользователь сообщает устойчивое архитектурное решение или важный факт, предложи явно сохранить его в память, но не выдумывай, что сохранил автоматически. Отвечай конкретно, не утверждай, что выполнил действия с файлами или GitHub, если инструменты реально не запускались.` },
    ...history.rows.reverse()
  ];

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return reply.code(503).send({ error: "На backend не настроен OPENROUTER_API_KEY. Добавь ключ в .env на сервере.", conversationId });

  const response = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_PUBLIC_URL ?? "http://localhost:8080",
      "X-Title": "AI Locman"
    },
    body: JSON.stringify({ model, messages, stream: false })
  });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 1200);
    request.log.error({ status: response.status, details }, "OpenRouter request failed");
    return reply.code(502).send({ error: `Ошибка OpenRouter (${response.status}). Проверь модель, ключ и баланс.`, conversationId });
  }
  const result = await response.json() as { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>; usage?: unknown };
  const raw = result.choices?.[0]?.message?.content;
  const answer = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part) => part.text ?? "").join("") : "Модель вернула пустой ответ.";
  await pool.query(
    "INSERT INTO messages (conversation_id, role, content, model) VALUES ($1, 'assistant', $2, $3)",
    [conversationId, answer, model]
  );
  return { conversationId, model, answer, usage: result.usage ?? null };
});


const taskSchema = z.object({
  prompt: z.string().trim().min(1).max(20000),
  model: z.string().min(1).max(200).optional(),
  conversationId: z.string().uuid().optional()
});

app.post("/api/v1/projects/:projectId/tasks", async (request, reply) => {
  const parsedProject = projectParam.safeParse(request.params);
  const parsedBody = taskSchema.safeParse(request.body);
  if (!parsedProject.success) return reply.badRequest(parsedProject.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const owned = await pool.query(
    "SELECT id, model FROM projects WHERE id=$1 AND owner_id=$2",
    [parsedProject.data.projectId, DEV_OWNER_ID]
  );
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  if (parsedBody.data.conversationId) {
    const conversation = await pool.query(
      "SELECT id FROM conversations WHERE id=$1 AND project_id=$2",
      [parsedBody.data.conversationId, parsedProject.data.projectId]
    );
    if (!conversation.rowCount) return reply.notFound("Диалог не найден в этом проекте");
  }
  const created = await pool.query(
    `INSERT INTO agent_tasks (project_id, conversation_id, prompt, model, status)
     VALUES ($1, $2, $3, $4, 'queued')
     RETURNING id, project_id, conversation_id, prompt, model, status, created_at`,
    [parsedProject.data.projectId, parsedBody.data.conversationId ?? null, parsedBody.data.prompt, parsedBody.data.model ?? owned.rows[0].model ?? DEFAULT_MODEL]
  );
  const task = created.rows[0];
  try {
    await getTaskQueue().add("execute", { taskId: task.id }, {
      jobId: task.id, attempts: 2, backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 500, removeOnFail: 1000
    });
  } catch (error) {
    await pool.query(
      "UPDATE agent_tasks SET status='failed', error=$2, completed_at=now(), updated_at=now() WHERE id=$1",
      [task.id, error instanceof Error ? error.message.slice(0, 1000) : "Redis queue unavailable"]
    );
    request.log.error({ err: error, taskId: task.id }, "Could not enqueue agent task");
    return reply.code(503).send({ error: "Очередь задач сейчас недоступна. Попробуй позже.", taskId: task.id });
  }
  return reply.code(202).send(task);
});

app.get("/api/v1/projects/:projectId/tasks", async (request, reply) => {
  const parsed = projectParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsed.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    `SELECT id, conversation_id, prompt, model, status, result, error, created_at, updated_at, started_at, completed_at
     FROM agent_tasks WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [parsed.data.projectId]
  );
  return { items: rows };
});

const taskParam = z.object({ taskId: z.string().uuid() });

app.get("/api/v1/tasks/:taskId/events", async (request, reply) => {
  const parsed = taskParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT t.id FROM agent_tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND p.owner_id=$2",[parsed.data.taskId,DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Задача не найдена");
  const { rows } = await pool.query("SELECT id,event_type,tool_name,arguments,result,created_at FROM agent_task_events WHERE task_id=$1 ORDER BY created_at ASC LIMIT 200",[parsed.data.taskId]);
  return { items: rows };
});

app.get("/api/v1/tasks/:taskId", async (request, reply) => {
  const parsed = taskParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { rows } = await pool.query(
    `SELECT t.id, t.project_id, t.conversation_id, t.prompt, t.model, t.status, t.result, t.error,
            t.created_at, t.updated_at, t.started_at, t.completed_at
     FROM agent_tasks t JOIN projects p ON p.id=t.project_id
     WHERE t.id=$1 AND p.owner_id=$2`,
    [parsed.data.taskId, DEV_OWNER_ID]
  );
  if (!rows.length) return reply.notFound("Задача не найдена");
  return rows[0];
});

app.post("/api/v1/tasks/:taskId/cancel", async (request, reply) => {
  const parsed = taskParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query(
    "SELECT t.id, t.status FROM agent_tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND p.owner_id=$2",
    [parsed.data.taskId, DEV_OWNER_ID]
  );
  if (!owned.rowCount) return reply.notFound("Задача не найдена");
  if (["completed", "failed", "cancelled"].includes(owned.rows[0].status)) {
    return reply.code(409).send({ error: "Задача уже завершена", status: owned.rows[0].status });
  }
  await pool.query("UPDATE agent_tasks SET cancel_requested=TRUE, updated_at=now() WHERE id=$1", [parsed.data.taskId]);
  const job = await getTaskQueue().getJob(parsed.data.taskId);
  if (job && ["waiting", "delayed", "paused"].includes(await job.getState())) {
    await job.remove();
    await pool.query(
      "UPDATE agent_tasks SET status='cancelled', completed_at=now(), updated_at=now() WHERE id=$1",
      [parsed.data.taskId]
    );
  }
  return { id: parsed.data.taskId, status: "cancellation_requested" };
});


const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";

function githubAppJwt(): string {
  const clientId = process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientId || !privateKey) throw new Error("GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY are required");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({ iat: now - 60, exp: now + 9 * 60, iss: clientId });
  const unsigned = header + "." + payload;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return unsigned + "." + signer.sign(privateKey, "base64url");
}

async function githubAppRequest(path: string, method: "GET" | "POST" = "GET") {
  const response = await fetch(GITHUB_API + path, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + githubAppJwt(),
      "X-GitHub-Api-Version": GITHUB_API_VERSION
    }
  });
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  if (!response.ok) throw new Error("GitHub API " + response.status + ": " + String(payload.message ?? raw).slice(0, 1000));
  return payload;
}

async function githubInstallationToken(installationId: number): Promise<string> {
  const payload = await githubAppRequest("/app/installations/" + installationId + "/access_tokens", "POST");
  const token = payload.token;
  if (typeof token !== "string" || !token) throw new Error("GitHub did not return an installation token");
  return token;
}

async function githubInstallationRows() {
  const { rows } = await pool.query(
    "SELECT installation_id, account_login, account_type FROM github_installations WHERE owner_id=$1 ORDER BY account_login",
    [DEV_OWNER_ID]
  );
  return rows as Array<{ installation_id: string | number; account_login: string; account_type: string }>;
}

async function githubInstallationRequest(token: string, path: string, accept: "application/vnd.github.diff"): Promise<string>;
async function githubInstallationRequest(token: string, path: string, accept?: string): Promise<Record<string, unknown>>;
async function githubInstallationRequest(
  token: string, path: string, accept = "application/vnd.github+json"
): Promise<Record<string, unknown> | string> {
  const response = await fetch(GITHUB_API + path, {
    headers: {
      Accept: accept,
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": GITHUB_API_VERSION
    }
  });
  const raw = await response.text();
  if (!response.ok) {
    let message = raw;
    try { message = String((JSON.parse(raw) as Record<string, unknown>).message ?? raw); } catch { /* keep raw body */ }
    throw new Error("GitHub API " + response.status + ": " + message.slice(0, 1000));
  }
  if (accept === "application/vnd.github.diff") return raw;
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

async function githubRepoToken(owner: string, repo: string): Promise<string> {
  const installations = await githubInstallationRows();
  for (const installation of installations) {
    const token = await githubInstallationToken(Number(installation.installation_id));
    try {
      await githubInstallationRequest(token, "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo));
      return token;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("GitHub API 404")) continue;
      throw error;
    }
  }
  throw new Error("Репозиторий не входит в доступные установки GitHub App");
}

const githubRepoParams = z.object({
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)
});

app.get("/api/v1/github/connect", async (_request, reply) => {
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug || !(process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_APP_ID) || !process.env.GITHUB_APP_PRIVATE_KEY) {
    return reply.code(503).send({ error: "GitHub App не настроен: добавь GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID и GITHUB_APP_PRIVATE_KEY в backend .env" });
  }
  const state = randomBytes(24).toString("base64url");
  await pool.query(
    "INSERT INTO github_install_states (state_hash, owner_id, expires_at) VALUES ($1, $2, now() + interval '30 minutes')",
    [createHash("sha256").update(state).digest("hex"), DEV_OWNER_ID]
  );
  const url = new URL("https://github.com/apps/" + encodeURIComponent(slug) + "/installations/new");
  url.searchParams.set("state", state);
  return reply.redirect(url.toString());
});

app.get("/api/v1/github/callback", async (request, reply) => {
  const query = z.object({
    state: z.string().min(20).max(200),
    installation_id: z.coerce.number().int().positive()
  }).safeParse(request.query);
  if (!query.success) return reply.badRequest("Некорректные параметры GitHub callback");
  const stateHash = createHash("sha256").update(query.data.state).digest("hex");
  // Consume the one-time OAuth state atomically to prevent concurrent callback replay.
  const stateResult = await pool.query(
    "DELETE FROM github_install_states WHERE state_hash=$1 AND expires_at>now() RETURNING owner_id",
    [stateHash]
  );
  if (!stateResult.rowCount) return reply.code(400).send("Ссылка подключения GitHub устарела или уже использована. Вернись в AI Locman и начни подключение заново.");
  try {
    const installation = await githubAppRequest("/app/installations/" + query.data.installation_id);
    const account = installation.account as Record<string, unknown> | undefined;
    const login = typeof account?.login === "string" ? account.login : "GitHub account";
    const type = typeof account?.type === "string" ? account.type : "User";
    await pool.query(
      `INSERT INTO github_installations (owner_id, installation_id, account_login, account_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id, installation_id) DO UPDATE
       SET account_login=EXCLUDED.account_login, account_type=EXCLUDED.account_type, updated_at=now()`,
      [stateResult.rows[0].owner_id, query.data.installation_id, login, type]
    );
    return reply.type("text/html; charset=utf-8").send(
      "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>AI Locman</title></head><body style='font-family:system-ui;background:#0a1020;color:#eaf0fa;padding:32px'><h2>GitHub подключён</h2><p>Установка подтверждена. Можно закрыть эту страницу и вернуться в AI Locman.</p></body></html>"
    );
  } catch (error) {
    request.log.error({ err: error }, "GitHub installation validation failed");
    return reply.code(502).send("Не удалось проверить установку GitHub App. Проверь App ID и private key на backend.");
  }
});

app.get("/api/v1/github/status", async () => {
  const installations = await githubInstallationRows();
  return { connected: installations.length > 0, installations };
});

app.delete("/api/v1/github/connection", async (_request, reply) => {
  await pool.query("DELETE FROM github_installations WHERE owner_id=$1", [DEV_OWNER_ID]);
  return reply.code(204).send();
});

app.get("/api/v1/github/repositories", async (request, reply) => {
  try {
    const installations = await githubInstallationRows();
    const repositories: unknown[] = [];
    for (const installation of installations) {
      const token = await githubInstallationToken(Number(installation.installation_id));
      let page = 1;
      while (page <= 20) {
        const result = await githubInstallationRequest(token, "/installation/repositories?per_page=100&page=" + page);
        const items = Array.isArray(result.repositories) ? result.repositories : [];
        repositories.push(...items);
        if (items.length < 100 || repositories.length >= Number(result.total_count ?? 0)) break;
        page++;
      }
    }
    return { items: repositories };
  } catch (error) {
    request.log.error({ err: error }, "Could not list GitHub repositories");
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo));
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/branches", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/branches?per_page=100");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/contents", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  const query = z.object({
    path: z.string().max(1000).optional(),
    ref: z.string().max(255).optional()
  }).safeParse(request.query);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  if (!query.success) return reply.badRequest(query.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    const path = query.data.path
      ? "/" + query.data.path.split("/").map(encodeURIComponent).join("/")
      : "";
    const params = new URLSearchParams();
    if (query.data.ref) params.set("ref", query.data.ref);
    const queryString = params.toString();
    const suffix = queryString ? "?" + queryString : "";
    return await githubInstallationRequest(
      token,
      "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/contents" + path + suffix
    );
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/commits", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/commits?per_page=50");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/pulls", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/pulls?state=all&per_page=50");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/actions", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/actions/runs?per_page=50");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/compare", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  const query = z.object({ base: z.string().min(1).max(255), head: z.string().min(1).max(255) }).safeParse(request.query);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  if (!query.success) return reply.badRequest(query.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    const response = await githubInstallationRequest(
      token,
      "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) +
        "/compare/" + encodeURIComponent(query.data.base) + "..." + encodeURIComponent(query.data.head),
      "application/vnd.github.diff"
    );
    return reply.type("text/plain; charset=utf-8").send(response);
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});


const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: "0.0.0.0" });
),
    profile TEXT NOT NULL CHECK (profile IN ('node_test','node_typecheck','node_build','android_unit_tests','android_debug_apk','android_lint')),
    executable TEXT NOT NULL CHECK (executable IN ('npm','./gradlew')),
    argv JSONB NOT NULL CHECK (jsonb_typeof(argv) = 'array'),
    diff_sha256 CHAR(64) NOT NULL CHECK (diff_sha256 ~ '^[a-fA-F0-9]{64}


const redisUrl = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
const redisConnection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  maxRetriesPerRequest: null,
  ...(redisUrl.protocol === "rediss:" ? { tls: {} } : {})
};
let taskQueue: Queue | null = null;
function getTaskQueue() {
  if (!taskQueue) taskQueue = new Queue("ai-locman-tasks", { connection: redisConnection });
  return taskQueue;
}

app.get("/health", async () => ({ status: "ok", service: "ai-locman-api", version: "0.2.0" }));

// Development MVP only. Do not expose this unauthenticated API to the public internet.
app.get("/api/v1/projects", async () => {
  const { rows } = await pool.query(
    "SELECT id, name, description, model, github_repository, created_at FROM projects WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100",
    [DEV_OWNER_ID]
  );
  return { items: rows };
});

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
  model: z.string().trim().min(1).max(200).default(DEFAULT_MODEL)
});

app.post("/api/v1/projects", async (request, reply) => {
  const parsed = createProjectSchema.safeParse(request.body);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { name, description, model } = parsed.data;
  const { rows } = await pool.query(
    `INSERT INTO projects (owner_id, name, description, model)
     VALUES ($1, $2, $3, $4) RETURNING id, name, description, model, created_at`,
    [DEV_OWNER_ID, name, description, model]
  );
  return reply.code(201).send(rows[0]);
});


const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  githubRepository: z.string().max(201).optional(),
  instructions: z.string().max(10000).optional()
}).refine((value) => Object.keys(value).length > 0, "Нечего обновлять");

app.patch("/api/v1/projects/:projectId", async (request, reply) => {
  const parsedParams = projectParam.safeParse(request.params);
  const parsedBody = updateProjectSchema.safeParse(request.body);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const current = await pool.query(
    "SELECT id, name, description, model, instructions, github_repository FROM projects WHERE id=$1 AND owner_id=$2",
    [parsedParams.data.projectId, DEV_OWNER_ID]
  );
  if (!current.rowCount) return reply.notFound("Проект не найден");
  const next = { ...current.rows[0], githubRepository: current.rows[0].github_repository, ...parsedBody.data };
  const { rows } = await pool.query(
    `UPDATE projects SET name=$2, description=$3, model=$4, instructions=$5, github_repository=$6, updated_at=now()
     WHERE id=$1 RETURNING id, name, description, model, instructions, github_repository, created_at, updated_at`,
    [parsedParams.data.projectId, next.name, next.description, next.model ?? DEFAULT_MODEL, next.instructions ?? "", next.githubRepository ?? ""]
  );
  return rows[0];
});

const projectParam = z.object({ projectId: z.string().uuid() });
const conversationParam = z.object({ conversationId: z.string().uuid() });

app.get("/api/v1/projects/:projectId/conversations", async (request, reply) => {
  const parsed = projectParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id = $1 AND owner_id = $2", [parsed.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.created_at,
      (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
     FROM conversations c WHERE c.project_id = $1 ORDER BY c.created_at DESC LIMIT 200`,
    [parsed.data.projectId]
  );
  return { items: rows };
});


const createConversationSchema = z.object({ title: z.string().trim().min(1).max(120).default("Новый чат") });
app.post("/api/v1/projects/:projectId/conversations", async (request, reply) => {
  const parsedParams = projectParam.safeParse(request.params);
  const parsedBody = createConversationSchema.safeParse(request.body ?? {});
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsedParams.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    "INSERT INTO conversations (project_id, title) VALUES ($1, $2) RETURNING id, title, created_at",
    [parsedParams.data.projectId, parsedBody.data.title]
  );
  return reply.code(201).send(rows[0]);
});

const updateConversationSchema = z.object({ title: z.string().trim().min(1).max(120) });
app.patch("/api/v1/conversations/:conversationId", async (request, reply) => {
  const parsedParams = conversationParam.safeParse(request.params);
  const parsedBody = updateConversationSchema.safeParse(request.body);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const { rows } = await pool.query(
    `UPDATE conversations c SET title=$1
     FROM projects p WHERE c.id=$2 AND p.id=c.project_id AND p.owner_id=$3
     RETURNING c.id, c.title, c.created_at`,
    [parsedBody.data.title, parsedParams.data.conversationId, DEV_OWNER_ID]
  );
  if (!rows.length) return reply.notFound("Диалог не найден");
  return rows[0];
});

app.delete("/api/v1/conversations/:conversationId", async (request, reply) => {
  const parsedParams = conversationParam.safeParse(request.params);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  const { rowCount } = await pool.query(
    `DELETE FROM conversations c USING projects p
     WHERE c.id=$1 AND p.id=c.project_id AND p.owner_id=$2`,
    [parsedParams.data.conversationId, DEV_OWNER_ID]
  );
  if (!rowCount) return reply.notFound("Диалог не найден");
  return reply.code(204).send();
});

app.get("/api/v1/conversations/:conversationId/messages", async (request, reply) => {
  const parsed = conversationParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { rows } = await pool.query(
    `SELECT m.id, m.role, m.content, m.model, m.created_at
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     JOIN projects p ON p.id = c.project_id
     WHERE c.id = $1 AND p.owner_id = $2 AND m.role IN ('user','assistant')
     ORDER BY m.created_at ASC LIMIT 1000`,
    [parsed.data.conversationId, DEV_OWNER_ID]
  );
  if (!rows.length) {
    const exists = await pool.query(
      "SELECT c.id FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=$1 AND p.owner_id=$2",
      [parsed.data.conversationId, DEV_OWNER_ID]
    );
    if (!exists.rowCount) return reply.notFound("Диалог не найден");
  }
  return { items: rows };
});

app.get("/api/v1/projects/:projectId/memory", async (request, reply) => {
  const parsed = projectParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsed.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    "SELECT id, section, content, updated_at FROM project_memory WHERE project_id=$1 ORDER BY section",
    [parsed.data.projectId]
  );
  const bySection = new Map(rows.map((row) => [row.section, row]));
  return { items: ["architecture", "decisions", "knowledge"].map((section) => bySection.get(section) ?? ({ section, content: "", updated_at: null })) };
});

const memorySchema = z.object({
  section: z.enum(["architecture", "decisions", "knowledge"]),
  content: z.string().max(50000)
});
app.put("/api/v1/projects/:projectId/memory", async (request, reply) => {
  const parsedParams = projectParam.safeParse(request.params);
  const parsedBody = memorySchema.safeParse(request.body);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsedParams.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    `INSERT INTO project_memory (project_id, section, content)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id, section) DO UPDATE SET content=EXCLUDED.content, updated_at=now()
     RETURNING id, section, content, updated_at`,
    [parsedParams.data.projectId, parsedBody.data.section, parsedBody.data.content]
  );
  return rows[0];
});

app.get("/api/v1/models", async (_request, reply) => {
  const headers: Record<string, string> = {};
  if (process.env.OPENROUTER_API_KEY) headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
  const response = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/models`, { headers });
  if (!response.ok) return reply.code(502).send({ error: "Не удалось получить список моделей OpenRouter" });
  const payload = await response.json() as { data?: Array<{ id: string; name?: string; context_length?: number }> };
  return { items: (payload.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id, contextLength: m.context_length })) };
});

const chatSchema = z.object({
  projectId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  model: z.string().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(20000)
});

app.post("/api/v1/chat", async (request, reply) => {
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { projectId, message } = parsed.data;
  const projectResult = await pool.query(
    "SELECT id, name, instructions, model FROM projects WHERE id = $1 AND owner_id = $2",
    [projectId, DEV_OWNER_ID]
  );
  const project = projectResult.rows[0];
  if (!project) return reply.notFound("Проект не найден");
  const model = parsed.data.model ?? project.model ?? DEFAULT_MODEL;
  const memoryResult = await pool.query(
    "SELECT section, content FROM project_memory WHERE project_id=$1 AND content <> '' ORDER BY section",
    [projectId]
  );
  const memoryText = memoryResult.rows
    .map((item) => `[${item.section}]\n${item.content}`)
    .join("\n\n");

  let conversationId = parsed.data.conversationId;
  if (conversationId) {
    const check = await pool.query(
      "SELECT id FROM conversations WHERE id = $1 AND project_id = $2",
      [conversationId, projectId]
    );
    if (!check.rowCount) return reply.notFound("Диалог не найден в этом проекте");
  } else {
    const created = await pool.query(
      "INSERT INTO conversations (project_id, title) VALUES ($1, $2) RETURNING id",
      [projectId, message.slice(0, 70)]
    );
    conversationId = created.rows[0].id as string;
  }

  await pool.query(
    "INSERT INTO messages (conversation_id, role, content, model) VALUES ($1, 'user', $2, $3)",
    [conversationId, message, model]
  );
  const history = await pool.query(
    `SELECT role, content FROM messages WHERE conversation_id = $1
     AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 30`,
    [conversationId]
  );
  const messages = [
    { role: "system", content: `Ты — AI Locman, русскоязычный помощник по разработке. Проект: ${project.name}. Инструкции проекта: ${project.instructions || "нет"}.\n\nДОЛГОВРЕМЕННАЯ ПАМЯТЬ ЭТОГО ПРОЕКТА (не смешивай с другими проектами):\n${memoryText || "Пока пуста."}\n\nИспользуй память как контекст и сохраняй согласованность с принятыми решениями. Если пользователь сообщает устойчивое архитектурное решение или важный факт, предложи явно сохранить его в память, но не выдумывай, что сохранил автоматически. Отвечай конкретно, не утверждай, что выполнил действия с файлами или GitHub, если инструменты реально не запускались.` },
    ...history.rows.reverse()
  ];

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return reply.code(503).send({ error: "На backend не настроен OPENROUTER_API_KEY. Добавь ключ в .env на сервере.", conversationId });

  const response = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_PUBLIC_URL ?? "http://localhost:8080",
      "X-Title": "AI Locman"
    },
    body: JSON.stringify({ model, messages, stream: false })
  });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 1200);
    request.log.error({ status: response.status, details }, "OpenRouter request failed");
    return reply.code(502).send({ error: `Ошибка OpenRouter (${response.status}). Проверь модель, ключ и баланс.`, conversationId });
  }
  const result = await response.json() as { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>; usage?: unknown };
  const raw = result.choices?.[0]?.message?.content;
  const answer = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part) => part.text ?? "").join("") : "Модель вернула пустой ответ.";
  await pool.query(
    "INSERT INTO messages (conversation_id, role, content, model) VALUES ($1, 'assistant', $2, $3)",
    [conversationId, answer, model]
  );
  return { conversationId, model, answer, usage: result.usage ?? null };
});


const taskSchema = z.object({
  prompt: z.string().trim().min(1).max(20000),
  model: z.string().min(1).max(200).optional(),
  conversationId: z.string().uuid().optional()
});

app.post("/api/v1/projects/:projectId/tasks", async (request, reply) => {
  const parsedProject = projectParam.safeParse(request.params);
  const parsedBody = taskSchema.safeParse(request.body);
  if (!parsedProject.success) return reply.badRequest(parsedProject.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const owned = await pool.query(
    "SELECT id, model FROM projects WHERE id=$1 AND owner_id=$2",
    [parsedProject.data.projectId, DEV_OWNER_ID]
  );
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  if (parsedBody.data.conversationId) {
    const conversation = await pool.query(
      "SELECT id FROM conversations WHERE id=$1 AND project_id=$2",
      [parsedBody.data.conversationId, parsedProject.data.projectId]
    );
    if (!conversation.rowCount) return reply.notFound("Диалог не найден в этом проекте");
  }
  const created = await pool.query(
    `INSERT INTO agent_tasks (project_id, conversation_id, prompt, model, status)
     VALUES ($1, $2, $3, $4, 'queued')
     RETURNING id, project_id, conversation_id, prompt, model, status, created_at`,
    [parsedProject.data.projectId, parsedBody.data.conversationId ?? null, parsedBody.data.prompt, parsedBody.data.model ?? owned.rows[0].model ?? DEFAULT_MODEL]
  );
  const task = created.rows[0];
  try {
    await getTaskQueue().add("execute", { taskId: task.id }, {
      jobId: task.id, attempts: 2, backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 500, removeOnFail: 1000
    });
  } catch (error) {
    await pool.query(
      "UPDATE agent_tasks SET status='failed', error=$2, completed_at=now(), updated_at=now() WHERE id=$1",
      [task.id, error instanceof Error ? error.message.slice(0, 1000) : "Redis queue unavailable"]
    );
    request.log.error({ err: error, taskId: task.id }, "Could not enqueue agent task");
    return reply.code(503).send({ error: "Очередь задач сейчас недоступна. Попробуй позже.", taskId: task.id });
  }
  return reply.code(202).send(task);
});

app.get("/api/v1/projects/:projectId/tasks", async (request, reply) => {
  const parsed = projectParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsed.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    `SELECT id, conversation_id, prompt, model, status, result, error, created_at, updated_at, started_at, completed_at
     FROM agent_tasks WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [parsed.data.projectId]
  );
  return { items: rows };
});

const taskParam = z.object({ taskId: z.string().uuid() });

app.get("/api/v1/tasks/:taskId/events", async (request, reply) => {
  const parsed = taskParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT t.id FROM agent_tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND p.owner_id=$2",[parsed.data.taskId,DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Задача не найдена");
  const { rows } = await pool.query("SELECT id,event_type,tool_name,arguments,result,created_at FROM agent_task_events WHERE task_id=$1 ORDER BY created_at ASC LIMIT 200",[parsed.data.taskId]);
  return { items: rows };
});

app.get("/api/v1/tasks/:taskId", async (request, reply) => {
  const parsed = taskParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { rows } = await pool.query(
    `SELECT t.id, t.project_id, t.conversation_id, t.prompt, t.model, t.status, t.result, t.error,
            t.created_at, t.updated_at, t.started_at, t.completed_at
     FROM agent_tasks t JOIN projects p ON p.id=t.project_id
     WHERE t.id=$1 AND p.owner_id=$2`,
    [parsed.data.taskId, DEV_OWNER_ID]
  );
  if (!rows.length) return reply.notFound("Задача не найдена");
  return rows[0];
});

app.post("/api/v1/tasks/:taskId/cancel", async (request, reply) => {
  const parsed = taskParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query(
    "SELECT t.id, t.status FROM agent_tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND p.owner_id=$2",
    [parsed.data.taskId, DEV_OWNER_ID]
  );
  if (!owned.rowCount) return reply.notFound("Задача не найдена");
  if (["completed", "failed", "cancelled"].includes(owned.rows[0].status)) {
    return reply.code(409).send({ error: "Задача уже завершена", status: owned.rows[0].status });
  }
  await pool.query("UPDATE agent_tasks SET cancel_requested=TRUE, updated_at=now() WHERE id=$1", [parsed.data.taskId]);
  const job = await getTaskQueue().getJob(parsed.data.taskId);
  if (job && ["waiting", "delayed", "paused"].includes(await job.getState())) {
    await job.remove();
    await pool.query(
      "UPDATE agent_tasks SET status='cancelled', completed_at=now(), updated_at=now() WHERE id=$1",
      [parsed.data.taskId]
    );
  }
  return { id: parsed.data.taskId, status: "cancellation_requested" };
});


const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";

function githubAppJwt(): string {
  const clientId = process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientId || !privateKey) throw new Error("GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY are required");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({ iat: now - 60, exp: now + 9 * 60, iss: clientId });
  const unsigned = header + "." + payload;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return unsigned + "." + signer.sign(privateKey, "base64url");
}

async function githubAppRequest(path: string, method: "GET" | "POST" = "GET") {
  const response = await fetch(GITHUB_API + path, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + githubAppJwt(),
      "X-GitHub-Api-Version": GITHUB_API_VERSION
    }
  });
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  if (!response.ok) throw new Error("GitHub API " + response.status + ": " + String(payload.message ?? raw).slice(0, 1000));
  return payload;
}

async function githubInstallationToken(installationId: number): Promise<string> {
  const payload = await githubAppRequest("/app/installations/" + installationId + "/access_tokens", "POST");
  const token = payload.token;
  if (typeof token !== "string" || !token) throw new Error("GitHub did not return an installation token");
  return token;
}

async function githubInstallationRows() {
  const { rows } = await pool.query(
    "SELECT installation_id, account_login, account_type FROM github_installations WHERE owner_id=$1 ORDER BY account_login",
    [DEV_OWNER_ID]
  );
  return rows as Array<{ installation_id: string | number; account_login: string; account_type: string }>;
}

async function githubInstallationRequest(token: string, path: string, accept: "application/vnd.github.diff"): Promise<string>;
async function githubInstallationRequest(token: string, path: string, accept?: string): Promise<Record<string, unknown>>;
async function githubInstallationRequest(
  token: string, path: string, accept = "application/vnd.github+json"
): Promise<Record<string, unknown> | string> {
  const response = await fetch(GITHUB_API + path, {
    headers: {
      Accept: accept,
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": GITHUB_API_VERSION
    }
  });
  const raw = await response.text();
  if (!response.ok) {
    let message = raw;
    try { message = String((JSON.parse(raw) as Record<string, unknown>).message ?? raw); } catch { /* keep raw body */ }
    throw new Error("GitHub API " + response.status + ": " + message.slice(0, 1000));
  }
  if (accept === "application/vnd.github.diff") return raw;
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

async function githubRepoToken(owner: string, repo: string): Promise<string> {
  const installations = await githubInstallationRows();
  for (const installation of installations) {
    const token = await githubInstallationToken(Number(installation.installation_id));
    try {
      await githubInstallationRequest(token, "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo));
      return token;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("GitHub API 404")) continue;
      throw error;
    }
  }
  throw new Error("Репозиторий не входит в доступные установки GitHub App");
}

const githubRepoParams = z.object({
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)
});

app.get("/api/v1/github/connect", async (_request, reply) => {
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug || !(process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_APP_ID) || !process.env.GITHUB_APP_PRIVATE_KEY) {
    return reply.code(503).send({ error: "GitHub App не настроен: добавь GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID и GITHUB_APP_PRIVATE_KEY в backend .env" });
  }
  const state = randomBytes(24).toString("base64url");
  await pool.query(
    "INSERT INTO github_install_states (state_hash, owner_id, expires_at) VALUES ($1, $2, now() + interval '30 minutes')",
    [createHash("sha256").update(state).digest("hex"), DEV_OWNER_ID]
  );
  const url = new URL("https://github.com/apps/" + encodeURIComponent(slug) + "/installations/new");
  url.searchParams.set("state", state);
  return reply.redirect(url.toString());
});

app.get("/api/v1/github/callback", async (request, reply) => {
  const query = z.object({
    state: z.string().min(20).max(200),
    installation_id: z.coerce.number().int().positive()
  }).safeParse(request.query);
  if (!query.success) return reply.badRequest("Некорректные параметры GitHub callback");
  const stateHash = createHash("sha256").update(query.data.state).digest("hex");
  // Consume the one-time OAuth state atomically to prevent concurrent callback replay.
  const stateResult = await pool.query(
    "DELETE FROM github_install_states WHERE state_hash=$1 AND expires_at>now() RETURNING owner_id",
    [stateHash]
  );
  if (!stateResult.rowCount) return reply.code(400).send("Ссылка подключения GitHub устарела или уже использована. Вернись в AI Locman и начни подключение заново.");
  try {
    const installation = await githubAppRequest("/app/installations/" + query.data.installation_id);
    const account = installation.account as Record<string, unknown> | undefined;
    const login = typeof account?.login === "string" ? account.login : "GitHub account";
    const type = typeof account?.type === "string" ? account.type : "User";
    await pool.query(
      `INSERT INTO github_installations (owner_id, installation_id, account_login, account_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id, installation_id) DO UPDATE
       SET account_login=EXCLUDED.account_login, account_type=EXCLUDED.account_type, updated_at=now()`,
      [stateResult.rows[0].owner_id, query.data.installation_id, login, type]
    );
    return reply.type("text/html; charset=utf-8").send(
      "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>AI Locman</title></head><body style='font-family:system-ui;background:#0a1020;color:#eaf0fa;padding:32px'><h2>GitHub подключён</h2><p>Установка подтверждена. Можно закрыть эту страницу и вернуться в AI Locman.</p></body></html>"
    );
  } catch (error) {
    request.log.error({ err: error }, "GitHub installation validation failed");
    return reply.code(502).send("Не удалось проверить установку GitHub App. Проверь App ID и private key на backend.");
  }
});

app.get("/api/v1/github/status", async () => {
  const installations = await githubInstallationRows();
  return { connected: installations.length > 0, installations };
});

app.delete("/api/v1/github/connection", async (_request, reply) => {
  await pool.query("DELETE FROM github_installations WHERE owner_id=$1", [DEV_OWNER_ID]);
  return reply.code(204).send();
});

app.get("/api/v1/github/repositories", async (request, reply) => {
  try {
    const installations = await githubInstallationRows();
    const repositories: unknown[] = [];
    for (const installation of installations) {
      const token = await githubInstallationToken(Number(installation.installation_id));
      let page = 1;
      while (page <= 20) {
        const result = await githubInstallationRequest(token, "/installation/repositories?per_page=100&page=" + page);
        const items = Array.isArray(result.repositories) ? result.repositories : [];
        repositories.push(...items);
        if (items.length < 100 || repositories.length >= Number(result.total_count ?? 0)) break;
        page++;
      }
    }
    return { items: repositories };
  } catch (error) {
    request.log.error({ err: error }, "Could not list GitHub repositories");
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo));
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/branches", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/branches?per_page=100");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/contents", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  const query = z.object({
    path: z.string().max(1000).optional(),
    ref: z.string().max(255).optional()
  }).safeParse(request.query);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  if (!query.success) return reply.badRequest(query.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    const path = query.data.path
      ? "/" + query.data.path.split("/").map(encodeURIComponent).join("/")
      : "";
    const params = new URLSearchParams();
    if (query.data.ref) params.set("ref", query.data.ref);
    const queryString = params.toString();
    const suffix = queryString ? "?" + queryString : "";
    return await githubInstallationRequest(
      token,
      "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/contents" + path + suffix
    );
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/commits", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/commits?per_page=50");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/pulls", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/pulls?state=all&per_page=50");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/actions", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/actions/runs?per_page=50");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/compare", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  const query = z.object({ base: z.string().min(1).max(255), head: z.string().min(1).max(255) }).safeParse(request.query);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  if (!query.success) return reply.badRequest(query.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    const response = await githubInstallationRequest(
      token,
      "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) +
        "/compare/" + encodeURIComponent(query.data.base) + "..." + encodeURIComponent(query.data.head),
      "application/vnd.github.diff"
    );
    return reply.type("text/plain; charset=utf-8").send(response);
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});


const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: "0.0.0.0" });
),
    nonce_sha256 CHAR(64) NOT NULL CHECK (nonce_sha256 ~ '^[a-fA-F0-9]{64}


const redisUrl = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
const redisConnection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  maxRetriesPerRequest: null,
  ...(redisUrl.protocol === "rediss:" ? { tls: {} } : {})
};
let taskQueue: Queue | null = null;
function getTaskQueue() {
  if (!taskQueue) taskQueue = new Queue("ai-locman-tasks", { connection: redisConnection });
  return taskQueue;
}

app.get("/health", async () => ({ status: "ok", service: "ai-locman-api", version: "0.2.0" }));

// Development MVP only. Do not expose this unauthenticated API to the public internet.
app.get("/api/v1/projects", async () => {
  const { rows } = await pool.query(
    "SELECT id, name, description, model, github_repository, created_at FROM projects WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100",
    [DEV_OWNER_ID]
  );
  return { items: rows };
});

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
  model: z.string().trim().min(1).max(200).default(DEFAULT_MODEL)
});

app.post("/api/v1/projects", async (request, reply) => {
  const parsed = createProjectSchema.safeParse(request.body);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { name, description, model } = parsed.data;
  const { rows } = await pool.query(
    `INSERT INTO projects (owner_id, name, description, model)
     VALUES ($1, $2, $3, $4) RETURNING id, name, description, model, created_at`,
    [DEV_OWNER_ID, name, description, model]
  );
  return reply.code(201).send(rows[0]);
});


const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  githubRepository: z.string().max(201).optional(),
  instructions: z.string().max(10000).optional()
}).refine((value) => Object.keys(value).length > 0, "Нечего обновлять");

app.patch("/api/v1/projects/:projectId", async (request, reply) => {
  const parsedParams = projectParam.safeParse(request.params);
  const parsedBody = updateProjectSchema.safeParse(request.body);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const current = await pool.query(
    "SELECT id, name, description, model, instructions, github_repository FROM projects WHERE id=$1 AND owner_id=$2",
    [parsedParams.data.projectId, DEV_OWNER_ID]
  );
  if (!current.rowCount) return reply.notFound("Проект не найден");
  const next = { ...current.rows[0], githubRepository: current.rows[0].github_repository, ...parsedBody.data };
  const { rows } = await pool.query(
    `UPDATE projects SET name=$2, description=$3, model=$4, instructions=$5, github_repository=$6, updated_at=now()
     WHERE id=$1 RETURNING id, name, description, model, instructions, github_repository, created_at, updated_at`,
    [parsedParams.data.projectId, next.name, next.description, next.model ?? DEFAULT_MODEL, next.instructions ?? "", next.githubRepository ?? ""]
  );
  return rows[0];
});

const projectParam = z.object({ projectId: z.string().uuid() });
const conversationParam = z.object({ conversationId: z.string().uuid() });

app.get("/api/v1/projects/:projectId/conversations", async (request, reply) => {
  const parsed = projectParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id = $1 AND owner_id = $2", [parsed.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.created_at,
      (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
     FROM conversations c WHERE c.project_id = $1 ORDER BY c.created_at DESC LIMIT 200`,
    [parsed.data.projectId]
  );
  return { items: rows };
});


const createConversationSchema = z.object({ title: z.string().trim().min(1).max(120).default("Новый чат") });
app.post("/api/v1/projects/:projectId/conversations", async (request, reply) => {
  const parsedParams = projectParam.safeParse(request.params);
  const parsedBody = createConversationSchema.safeParse(request.body ?? {});
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsedParams.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    "INSERT INTO conversations (project_id, title) VALUES ($1, $2) RETURNING id, title, created_at",
    [parsedParams.data.projectId, parsedBody.data.title]
  );
  return reply.code(201).send(rows[0]);
});

const updateConversationSchema = z.object({ title: z.string().trim().min(1).max(120) });
app.patch("/api/v1/conversations/:conversationId", async (request, reply) => {
  const parsedParams = conversationParam.safeParse(request.params);
  const parsedBody = updateConversationSchema.safeParse(request.body);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const { rows } = await pool.query(
    `UPDATE conversations c SET title=$1
     FROM projects p WHERE c.id=$2 AND p.id=c.project_id AND p.owner_id=$3
     RETURNING c.id, c.title, c.created_at`,
    [parsedBody.data.title, parsedParams.data.conversationId, DEV_OWNER_ID]
  );
  if (!rows.length) return reply.notFound("Диалог не найден");
  return rows[0];
});

app.delete("/api/v1/conversations/:conversationId", async (request, reply) => {
  const parsedParams = conversationParam.safeParse(request.params);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  const { rowCount } = await pool.query(
    `DELETE FROM conversations c USING projects p
     WHERE c.id=$1 AND p.id=c.project_id AND p.owner_id=$2`,
    [parsedParams.data.conversationId, DEV_OWNER_ID]
  );
  if (!rowCount) return reply.notFound("Диалог не найден");
  return reply.code(204).send();
});

app.get("/api/v1/conversations/:conversationId/messages", async (request, reply) => {
  const parsed = conversationParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { rows } = await pool.query(
    `SELECT m.id, m.role, m.content, m.model, m.created_at
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     JOIN projects p ON p.id = c.project_id
     WHERE c.id = $1 AND p.owner_id = $2 AND m.role IN ('user','assistant')
     ORDER BY m.created_at ASC LIMIT 1000`,
    [parsed.data.conversationId, DEV_OWNER_ID]
  );
  if (!rows.length) {
    const exists = await pool.query(
      "SELECT c.id FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=$1 AND p.owner_id=$2",
      [parsed.data.conversationId, DEV_OWNER_ID]
    );
    if (!exists.rowCount) return reply.notFound("Диалог не найден");
  }
  return { items: rows };
});

app.get("/api/v1/projects/:projectId/memory", async (request, reply) => {
  const parsed = projectParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsed.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    "SELECT id, section, content, updated_at FROM project_memory WHERE project_id=$1 ORDER BY section",
    [parsed.data.projectId]
  );
  const bySection = new Map(rows.map((row) => [row.section, row]));
  return { items: ["architecture", "decisions", "knowledge"].map((section) => bySection.get(section) ?? ({ section, content: "", updated_at: null })) };
});

const memorySchema = z.object({
  section: z.enum(["architecture", "decisions", "knowledge"]),
  content: z.string().max(50000)
});
app.put("/api/v1/projects/:projectId/memory", async (request, reply) => {
  const parsedParams = projectParam.safeParse(request.params);
  const parsedBody = memorySchema.safeParse(request.body);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsedParams.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    `INSERT INTO project_memory (project_id, section, content)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id, section) DO UPDATE SET content=EXCLUDED.content, updated_at=now()
     RETURNING id, section, content, updated_at`,
    [parsedParams.data.projectId, parsedBody.data.section, parsedBody.data.content]
  );
  return rows[0];
});

app.get("/api/v1/models", async (_request, reply) => {
  const headers: Record<string, string> = {};
  if (process.env.OPENROUTER_API_KEY) headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
  const response = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/models`, { headers });
  if (!response.ok) return reply.code(502).send({ error: "Не удалось получить список моделей OpenRouter" });
  const payload = await response.json() as { data?: Array<{ id: string; name?: string; context_length?: number }> };
  return { items: (payload.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id, contextLength: m.context_length })) };
});

const chatSchema = z.object({
  projectId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  model: z.string().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(20000)
});

app.post("/api/v1/chat", async (request, reply) => {
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { projectId, message } = parsed.data;
  const projectResult = await pool.query(
    "SELECT id, name, instructions, model FROM projects WHERE id = $1 AND owner_id = $2",
    [projectId, DEV_OWNER_ID]
  );
  const project = projectResult.rows[0];
  if (!project) return reply.notFound("Проект не найден");
  const model = parsed.data.model ?? project.model ?? DEFAULT_MODEL;
  const memoryResult = await pool.query(
    "SELECT section, content FROM project_memory WHERE project_id=$1 AND content <> '' ORDER BY section",
    [projectId]
  );
  const memoryText = memoryResult.rows
    .map((item) => `[${item.section}]\n${item.content}`)
    .join("\n\n");

  let conversationId = parsed.data.conversationId;
  if (conversationId) {
    const check = await pool.query(
      "SELECT id FROM conversations WHERE id = $1 AND project_id = $2",
      [conversationId, projectId]
    );
    if (!check.rowCount) return reply.notFound("Диалог не найден в этом проекте");
  } else {
    const created = await pool.query(
      "INSERT INTO conversations (project_id, title) VALUES ($1, $2) RETURNING id",
      [projectId, message.slice(0, 70)]
    );
    conversationId = created.rows[0].id as string;
  }

  await pool.query(
    "INSERT INTO messages (conversation_id, role, content, model) VALUES ($1, 'user', $2, $3)",
    [conversationId, message, model]
  );
  const history = await pool.query(
    `SELECT role, content FROM messages WHERE conversation_id = $1
     AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 30`,
    [conversationId]
  );
  const messages = [
    { role: "system", content: `Ты — AI Locman, русскоязычный помощник по разработке. Проект: ${project.name}. Инструкции проекта: ${project.instructions || "нет"}.\n\nДОЛГОВРЕМЕННАЯ ПАМЯТЬ ЭТОГО ПРОЕКТА (не смешивай с другими проектами):\n${memoryText || "Пока пуста."}\n\nИспользуй память как контекст и сохраняй согласованность с принятыми решениями. Если пользователь сообщает устойчивое архитектурное решение или важный факт, предложи явно сохранить его в память, но не выдумывай, что сохранил автоматически. Отвечай конкретно, не утверждай, что выполнил действия с файлами или GitHub, если инструменты реально не запускались.` },
    ...history.rows.reverse()
  ];

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return reply.code(503).send({ error: "На backend не настроен OPENROUTER_API_KEY. Добавь ключ в .env на сервере.", conversationId });

  const response = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_PUBLIC_URL ?? "http://localhost:8080",
      "X-Title": "AI Locman"
    },
    body: JSON.stringify({ model, messages, stream: false })
  });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 1200);
    request.log.error({ status: response.status, details }, "OpenRouter request failed");
    return reply.code(502).send({ error: `Ошибка OpenRouter (${response.status}). Проверь модель, ключ и баланс.`, conversationId });
  }
  const result = await response.json() as { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>; usage?: unknown };
  const raw = result.choices?.[0]?.message?.content;
  const answer = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part) => part.text ?? "").join("") : "Модель вернула пустой ответ.";
  await pool.query(
    "INSERT INTO messages (conversation_id, role, content, model) VALUES ($1, 'assistant', $2, $3)",
    [conversationId, answer, model]
  );
  return { conversationId, model, answer, usage: result.usage ?? null };
});


const taskSchema = z.object({
  prompt: z.string().trim().min(1).max(20000),
  model: z.string().min(1).max(200).optional(),
  conversationId: z.string().uuid().optional()
});

app.post("/api/v1/projects/:projectId/tasks", async (request, reply) => {
  const parsedProject = projectParam.safeParse(request.params);
  const parsedBody = taskSchema.safeParse(request.body);
  if (!parsedProject.success) return reply.badRequest(parsedProject.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const owned = await pool.query(
    "SELECT id, model FROM projects WHERE id=$1 AND owner_id=$2",
    [parsedProject.data.projectId, DEV_OWNER_ID]
  );
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  if (parsedBody.data.conversationId) {
    const conversation = await pool.query(
      "SELECT id FROM conversations WHERE id=$1 AND project_id=$2",
      [parsedBody.data.conversationId, parsedProject.data.projectId]
    );
    if (!conversation.rowCount) return reply.notFound("Диалог не найден в этом проекте");
  }
  const created = await pool.query(
    `INSERT INTO agent_tasks (project_id, conversation_id, prompt, model, status)
     VALUES ($1, $2, $3, $4, 'queued')
     RETURNING id, project_id, conversation_id, prompt, model, status, created_at`,
    [parsedProject.data.projectId, parsedBody.data.conversationId ?? null, parsedBody.data.prompt, parsedBody.data.model ?? owned.rows[0].model ?? DEFAULT_MODEL]
  );
  const task = created.rows[0];
  try {
    await getTaskQueue().add("execute", { taskId: task.id }, {
      jobId: task.id, attempts: 2, backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 500, removeOnFail: 1000
    });
  } catch (error) {
    await pool.query(
      "UPDATE agent_tasks SET status='failed', error=$2, completed_at=now(), updated_at=now() WHERE id=$1",
      [task.id, error instanceof Error ? error.message.slice(0, 1000) : "Redis queue unavailable"]
    );
    request.log.error({ err: error, taskId: task.id }, "Could not enqueue agent task");
    return reply.code(503).send({ error: "Очередь задач сейчас недоступна. Попробуй позже.", taskId: task.id });
  }
  return reply.code(202).send(task);
});

app.get("/api/v1/projects/:projectId/tasks", async (request, reply) => {
  const parsed = projectParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsed.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    `SELECT id, conversation_id, prompt, model, status, result, error, created_at, updated_at, started_at, completed_at
     FROM agent_tasks WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [parsed.data.projectId]
  );
  return { items: rows };
});

const taskParam = z.object({ taskId: z.string().uuid() });

app.get("/api/v1/tasks/:taskId/events", async (request, reply) => {
  const parsed = taskParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT t.id FROM agent_tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND p.owner_id=$2",[parsed.data.taskId,DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Задача не найдена");
  const { rows } = await pool.query("SELECT id,event_type,tool_name,arguments,result,created_at FROM agent_task_events WHERE task_id=$1 ORDER BY created_at ASC LIMIT 200",[parsed.data.taskId]);
  return { items: rows };
});

app.get("/api/v1/tasks/:taskId", async (request, reply) => {
  const parsed = taskParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { rows } = await pool.query(
    `SELECT t.id, t.project_id, t.conversation_id, t.prompt, t.model, t.status, t.result, t.error,
            t.created_at, t.updated_at, t.started_at, t.completed_at
     FROM agent_tasks t JOIN projects p ON p.id=t.project_id
     WHERE t.id=$1 AND p.owner_id=$2`,
    [parsed.data.taskId, DEV_OWNER_ID]
  );
  if (!rows.length) return reply.notFound("Задача не найдена");
  return rows[0];
});

app.post("/api/v1/tasks/:taskId/cancel", async (request, reply) => {
  const parsed = taskParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query(
    "SELECT t.id, t.status FROM agent_tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND p.owner_id=$2",
    [parsed.data.taskId, DEV_OWNER_ID]
  );
  if (!owned.rowCount) return reply.notFound("Задача не найдена");
  if (["completed", "failed", "cancelled"].includes(owned.rows[0].status)) {
    return reply.code(409).send({ error: "Задача уже завершена", status: owned.rows[0].status });
  }
  await pool.query("UPDATE agent_tasks SET cancel_requested=TRUE, updated_at=now() WHERE id=$1", [parsed.data.taskId]);
  const job = await getTaskQueue().getJob(parsed.data.taskId);
  if (job && ["waiting", "delayed", "paused"].includes(await job.getState())) {
    await job.remove();
    await pool.query(
      "UPDATE agent_tasks SET status='cancelled', completed_at=now(), updated_at=now() WHERE id=$1",
      [parsed.data.taskId]
    );
  }
  return { id: parsed.data.taskId, status: "cancellation_requested" };
});


const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";

function githubAppJwt(): string {
  const clientId = process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientId || !privateKey) throw new Error("GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY are required");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({ iat: now - 60, exp: now + 9 * 60, iss: clientId });
  const unsigned = header + "." + payload;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return unsigned + "." + signer.sign(privateKey, "base64url");
}

async function githubAppRequest(path: string, method: "GET" | "POST" = "GET") {
  const response = await fetch(GITHUB_API + path, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + githubAppJwt(),
      "X-GitHub-Api-Version": GITHUB_API_VERSION
    }
  });
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  if (!response.ok) throw new Error("GitHub API " + response.status + ": " + String(payload.message ?? raw).slice(0, 1000));
  return payload;
}

async function githubInstallationToken(installationId: number): Promise<string> {
  const payload = await githubAppRequest("/app/installations/" + installationId + "/access_tokens", "POST");
  const token = payload.token;
  if (typeof token !== "string" || !token) throw new Error("GitHub did not return an installation token");
  return token;
}

async function githubInstallationRows() {
  const { rows } = await pool.query(
    "SELECT installation_id, account_login, account_type FROM github_installations WHERE owner_id=$1 ORDER BY account_login",
    [DEV_OWNER_ID]
  );
  return rows as Array<{ installation_id: string | number; account_login: string; account_type: string }>;
}

async function githubInstallationRequest(token: string, path: string, accept: "application/vnd.github.diff"): Promise<string>;
async function githubInstallationRequest(token: string, path: string, accept?: string): Promise<Record<string, unknown>>;
async function githubInstallationRequest(
  token: string, path: string, accept = "application/vnd.github+json"
): Promise<Record<string, unknown> | string> {
  const response = await fetch(GITHUB_API + path, {
    headers: {
      Accept: accept,
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": GITHUB_API_VERSION
    }
  });
  const raw = await response.text();
  if (!response.ok) {
    let message = raw;
    try { message = String((JSON.parse(raw) as Record<string, unknown>).message ?? raw); } catch { /* keep raw body */ }
    throw new Error("GitHub API " + response.status + ": " + message.slice(0, 1000));
  }
  if (accept === "application/vnd.github.diff") return raw;
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

async function githubRepoToken(owner: string, repo: string): Promise<string> {
  const installations = await githubInstallationRows();
  for (const installation of installations) {
    const token = await githubInstallationToken(Number(installation.installation_id));
    try {
      await githubInstallationRequest(token, "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo));
      return token;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("GitHub API 404")) continue;
      throw error;
    }
  }
  throw new Error("Репозиторий не входит в доступные установки GitHub App");
}

const githubRepoParams = z.object({
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)
});

app.get("/api/v1/github/connect", async (_request, reply) => {
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug || !(process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_APP_ID) || !process.env.GITHUB_APP_PRIVATE_KEY) {
    return reply.code(503).send({ error: "GitHub App не настроен: добавь GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID и GITHUB_APP_PRIVATE_KEY в backend .env" });
  }
  const state = randomBytes(24).toString("base64url");
  await pool.query(
    "INSERT INTO github_install_states (state_hash, owner_id, expires_at) VALUES ($1, $2, now() + interval '30 minutes')",
    [createHash("sha256").update(state).digest("hex"), DEV_OWNER_ID]
  );
  const url = new URL("https://github.com/apps/" + encodeURIComponent(slug) + "/installations/new");
  url.searchParams.set("state", state);
  return reply.redirect(url.toString());
});

app.get("/api/v1/github/callback", async (request, reply) => {
  const query = z.object({
    state: z.string().min(20).max(200),
    installation_id: z.coerce.number().int().positive()
  }).safeParse(request.query);
  if (!query.success) return reply.badRequest("Некорректные параметры GitHub callback");
  const stateHash = createHash("sha256").update(query.data.state).digest("hex");
  // Consume the one-time OAuth state atomically to prevent concurrent callback replay.
  const stateResult = await pool.query(
    "DELETE FROM github_install_states WHERE state_hash=$1 AND expires_at>now() RETURNING owner_id",
    [stateHash]
  );
  if (!stateResult.rowCount) return reply.code(400).send("Ссылка подключения GitHub устарела или уже использована. Вернись в AI Locman и начни подключение заново.");
  try {
    const installation = await githubAppRequest("/app/installations/" + query.data.installation_id);
    const account = installation.account as Record<string, unknown> | undefined;
    const login = typeof account?.login === "string" ? account.login : "GitHub account";
    const type = typeof account?.type === "string" ? account.type : "User";
    await pool.query(
      `INSERT INTO github_installations (owner_id, installation_id, account_login, account_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id, installation_id) DO UPDATE
       SET account_login=EXCLUDED.account_login, account_type=EXCLUDED.account_type, updated_at=now()`,
      [stateResult.rows[0].owner_id, query.data.installation_id, login, type]
    );
    return reply.type("text/html; charset=utf-8").send(
      "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>AI Locman</title></head><body style='font-family:system-ui;background:#0a1020;color:#eaf0fa;padding:32px'><h2>GitHub подключён</h2><p>Установка подтверждена. Можно закрыть эту страницу и вернуться в AI Locman.</p></body></html>"
    );
  } catch (error) {
    request.log.error({ err: error }, "GitHub installation validation failed");
    return reply.code(502).send("Не удалось проверить установку GitHub App. Проверь App ID и private key на backend.");
  }
});

app.get("/api/v1/github/status", async () => {
  const installations = await githubInstallationRows();
  return { connected: installations.length > 0, installations };
});

app.delete("/api/v1/github/connection", async (_request, reply) => {
  await pool.query("DELETE FROM github_installations WHERE owner_id=$1", [DEV_OWNER_ID]);
  return reply.code(204).send();
});

app.get("/api/v1/github/repositories", async (request, reply) => {
  try {
    const installations = await githubInstallationRows();
    const repositories: unknown[] = [];
    for (const installation of installations) {
      const token = await githubInstallationToken(Number(installation.installation_id));
      let page = 1;
      while (page <= 20) {
        const result = await githubInstallationRequest(token, "/installation/repositories?per_page=100&page=" + page);
        const items = Array.isArray(result.repositories) ? result.repositories : [];
        repositories.push(...items);
        if (items.length < 100 || repositories.length >= Number(result.total_count ?? 0)) break;
        page++;
      }
    }
    return { items: repositories };
  } catch (error) {
    request.log.error({ err: error }, "Could not list GitHub repositories");
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo));
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/branches", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/branches?per_page=100");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/contents", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  const query = z.object({
    path: z.string().max(1000).optional(),
    ref: z.string().max(255).optional()
  }).safeParse(request.query);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  if (!query.success) return reply.badRequest(query.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    const path = query.data.path
      ? "/" + query.data.path.split("/").map(encodeURIComponent).join("/")
      : "";
    const params = new URLSearchParams();
    if (query.data.ref) params.set("ref", query.data.ref);
    const queryString = params.toString();
    const suffix = queryString ? "?" + queryString : "";
    return await githubInstallationRequest(
      token,
      "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/contents" + path + suffix
    );
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/commits", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/commits?per_page=50");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/pulls", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/pulls?state=all&per_page=50");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/actions", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/actions/runs?per_page=50");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/compare", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  const query = z.object({ base: z.string().min(1).max(255), head: z.string().min(1).max(255) }).safeParse(request.query);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  if (!query.success) return reply.badRequest(query.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    const response = await githubInstallationRequest(
      token,
      "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) +
        "/compare/" + encodeURIComponent(query.data.base) + "..." + encodeURIComponent(query.data.head),
      "application/vnd.github.diff"
    );
    return reply.type("text/plain; charset=utf-8").send(response);
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});


const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: "0.0.0.0" });
),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT execution_approvals_task_project_fk FOREIGN KEY (task_id, project_id) REFERENCES agent_tasks(id, project_id) ON DELETE CASCADE,
    CHECK (expires_at > created_at)
  );
  CREATE INDEX IF NOT EXISTS idx_execution_approvals_task_created ON execution_approvals(task_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_execution_approvals_expiry ON execution_approvals(expires_at) WHERE consumed_at IS NULL;
`);



const redisUrl = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
const redisConnection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  maxRetriesPerRequest: null,
  ...(redisUrl.protocol === "rediss:" ? { tls: {} } : {})
};
let taskQueue: Queue | null = null;
function getTaskQueue() {
  if (!taskQueue) taskQueue = new Queue("ai-locman-tasks", { connection: redisConnection });
  return taskQueue;
}

app.get("/health", async () => ({ status: "ok", service: "ai-locman-api", version: "0.2.0" }));

// Development MVP only. Do not expose this unauthenticated API to the public internet.
app.get("/api/v1/projects", async () => {
  const { rows } = await pool.query(
    "SELECT id, name, description, model, github_repository, created_at FROM projects WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100",
    [DEV_OWNER_ID]
  );
  return { items: rows };
});

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
  model: z.string().trim().min(1).max(200).default(DEFAULT_MODEL)
});

app.post("/api/v1/projects", async (request, reply) => {
  const parsed = createProjectSchema.safeParse(request.body);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { name, description, model } = parsed.data;
  const { rows } = await pool.query(
    `INSERT INTO projects (owner_id, name, description, model)
     VALUES ($1, $2, $3, $4) RETURNING id, name, description, model, created_at`,
    [DEV_OWNER_ID, name, description, model]
  );
  return reply.code(201).send(rows[0]);
});


const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  githubRepository: z.string().max(201).optional(),
  instructions: z.string().max(10000).optional()
}).refine((value) => Object.keys(value).length > 0, "Нечего обновлять");

app.patch("/api/v1/projects/:projectId", async (request, reply) => {
  const parsedParams = projectParam.safeParse(request.params);
  const parsedBody = updateProjectSchema.safeParse(request.body);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const current = await pool.query(
    "SELECT id, name, description, model, instructions, github_repository FROM projects WHERE id=$1 AND owner_id=$2",
    [parsedParams.data.projectId, DEV_OWNER_ID]
  );
  if (!current.rowCount) return reply.notFound("Проект не найден");
  const next = { ...current.rows[0], githubRepository: current.rows[0].github_repository, ...parsedBody.data };
  const { rows } = await pool.query(
    `UPDATE projects SET name=$2, description=$3, model=$4, instructions=$5, github_repository=$6, updated_at=now()
     WHERE id=$1 RETURNING id, name, description, model, instructions, github_repository, created_at, updated_at`,
    [parsedParams.data.projectId, next.name, next.description, next.model ?? DEFAULT_MODEL, next.instructions ?? "", next.githubRepository ?? ""]
  );
  return rows[0];
});

const projectParam = z.object({ projectId: z.string().uuid() });
const conversationParam = z.object({ conversationId: z.string().uuid() });

app.get("/api/v1/projects/:projectId/conversations", async (request, reply) => {
  const parsed = projectParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id = $1 AND owner_id = $2", [parsed.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.created_at,
      (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
     FROM conversations c WHERE c.project_id = $1 ORDER BY c.created_at DESC LIMIT 200`,
    [parsed.data.projectId]
  );
  return { items: rows };
});


const createConversationSchema = z.object({ title: z.string().trim().min(1).max(120).default("Новый чат") });
app.post("/api/v1/projects/:projectId/conversations", async (request, reply) => {
  const parsedParams = projectParam.safeParse(request.params);
  const parsedBody = createConversationSchema.safeParse(request.body ?? {});
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsedParams.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    "INSERT INTO conversations (project_id, title) VALUES ($1, $2) RETURNING id, title, created_at",
    [parsedParams.data.projectId, parsedBody.data.title]
  );
  return reply.code(201).send(rows[0]);
});

const updateConversationSchema = z.object({ title: z.string().trim().min(1).max(120) });
app.patch("/api/v1/conversations/:conversationId", async (request, reply) => {
  const parsedParams = conversationParam.safeParse(request.params);
  const parsedBody = updateConversationSchema.safeParse(request.body);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const { rows } = await pool.query(
    `UPDATE conversations c SET title=$1
     FROM projects p WHERE c.id=$2 AND p.id=c.project_id AND p.owner_id=$3
     RETURNING c.id, c.title, c.created_at`,
    [parsedBody.data.title, parsedParams.data.conversationId, DEV_OWNER_ID]
  );
  if (!rows.length) return reply.notFound("Диалог не найден");
  return rows[0];
});

app.delete("/api/v1/conversations/:conversationId", async (request, reply) => {
  const parsedParams = conversationParam.safeParse(request.params);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  const { rowCount } = await pool.query(
    `DELETE FROM conversations c USING projects p
     WHERE c.id=$1 AND p.id=c.project_id AND p.owner_id=$2`,
    [parsedParams.data.conversationId, DEV_OWNER_ID]
  );
  if (!rowCount) return reply.notFound("Диалог не найден");
  return reply.code(204).send();
});

app.get("/api/v1/conversations/:conversationId/messages", async (request, reply) => {
  const parsed = conversationParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { rows } = await pool.query(
    `SELECT m.id, m.role, m.content, m.model, m.created_at
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     JOIN projects p ON p.id = c.project_id
     WHERE c.id = $1 AND p.owner_id = $2 AND m.role IN ('user','assistant')
     ORDER BY m.created_at ASC LIMIT 1000`,
    [parsed.data.conversationId, DEV_OWNER_ID]
  );
  if (!rows.length) {
    const exists = await pool.query(
      "SELECT c.id FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=$1 AND p.owner_id=$2",
      [parsed.data.conversationId, DEV_OWNER_ID]
    );
    if (!exists.rowCount) return reply.notFound("Диалог не найден");
  }
  return { items: rows };
});

app.get("/api/v1/projects/:projectId/memory", async (request, reply) => {
  const parsed = projectParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsed.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    "SELECT id, section, content, updated_at FROM project_memory WHERE project_id=$1 ORDER BY section",
    [parsed.data.projectId]
  );
  const bySection = new Map(rows.map((row) => [row.section, row]));
  return { items: ["architecture", "decisions", "knowledge"].map((section) => bySection.get(section) ?? ({ section, content: "", updated_at: null })) };
});

const memorySchema = z.object({
  section: z.enum(["architecture", "decisions", "knowledge"]),
  content: z.string().max(50000)
});
app.put("/api/v1/projects/:projectId/memory", async (request, reply) => {
  const parsedParams = projectParam.safeParse(request.params);
  const parsedBody = memorySchema.safeParse(request.body);
  if (!parsedParams.success) return reply.badRequest(parsedParams.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsedParams.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    `INSERT INTO project_memory (project_id, section, content)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id, section) DO UPDATE SET content=EXCLUDED.content, updated_at=now()
     RETURNING id, section, content, updated_at`,
    [parsedParams.data.projectId, parsedBody.data.section, parsedBody.data.content]
  );
  return rows[0];
});

app.get("/api/v1/models", async (_request, reply) => {
  const headers: Record<string, string> = {};
  if (process.env.OPENROUTER_API_KEY) headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
  const response = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/models`, { headers });
  if (!response.ok) return reply.code(502).send({ error: "Не удалось получить список моделей OpenRouter" });
  const payload = await response.json() as { data?: Array<{ id: string; name?: string; context_length?: number }> };
  return { items: (payload.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id, contextLength: m.context_length })) };
});

const chatSchema = z.object({
  projectId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  model: z.string().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(20000)
});

app.post("/api/v1/chat", async (request, reply) => {
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { projectId, message } = parsed.data;
  const projectResult = await pool.query(
    "SELECT id, name, instructions, model FROM projects WHERE id = $1 AND owner_id = $2",
    [projectId, DEV_OWNER_ID]
  );
  const project = projectResult.rows[0];
  if (!project) return reply.notFound("Проект не найден");
  const model = parsed.data.model ?? project.model ?? DEFAULT_MODEL;
  const memoryResult = await pool.query(
    "SELECT section, content FROM project_memory WHERE project_id=$1 AND content <> '' ORDER BY section",
    [projectId]
  );
  const memoryText = memoryResult.rows
    .map((item) => `[${item.section}]\n${item.content}`)
    .join("\n\n");

  let conversationId = parsed.data.conversationId;
  if (conversationId) {
    const check = await pool.query(
      "SELECT id FROM conversations WHERE id = $1 AND project_id = $2",
      [conversationId, projectId]
    );
    if (!check.rowCount) return reply.notFound("Диалог не найден в этом проекте");
  } else {
    const created = await pool.query(
      "INSERT INTO conversations (project_id, title) VALUES ($1, $2) RETURNING id",
      [projectId, message.slice(0, 70)]
    );
    conversationId = created.rows[0].id as string;
  }

  await pool.query(
    "INSERT INTO messages (conversation_id, role, content, model) VALUES ($1, 'user', $2, $3)",
    [conversationId, message, model]
  );
  const history = await pool.query(
    `SELECT role, content FROM messages WHERE conversation_id = $1
     AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 30`,
    [conversationId]
  );
  const messages = [
    { role: "system", content: `Ты — AI Locman, русскоязычный помощник по разработке. Проект: ${project.name}. Инструкции проекта: ${project.instructions || "нет"}.\n\nДОЛГОВРЕМЕННАЯ ПАМЯТЬ ЭТОГО ПРОЕКТА (не смешивай с другими проектами):\n${memoryText || "Пока пуста."}\n\nИспользуй память как контекст и сохраняй согласованность с принятыми решениями. Если пользователь сообщает устойчивое архитектурное решение или важный факт, предложи явно сохранить его в память, но не выдумывай, что сохранил автоматически. Отвечай конкретно, не утверждай, что выполнил действия с файлами или GitHub, если инструменты реально не запускались.` },
    ...history.rows.reverse()
  ];

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return reply.code(503).send({ error: "На backend не настроен OPENROUTER_API_KEY. Добавь ключ в .env на сервере.", conversationId });

  const response = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_PUBLIC_URL ?? "http://localhost:8080",
      "X-Title": "AI Locman"
    },
    body: JSON.stringify({ model, messages, stream: false })
  });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 1200);
    request.log.error({ status: response.status, details }, "OpenRouter request failed");
    return reply.code(502).send({ error: `Ошибка OpenRouter (${response.status}). Проверь модель, ключ и баланс.`, conversationId });
  }
  const result = await response.json() as { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>; usage?: unknown };
  const raw = result.choices?.[0]?.message?.content;
  const answer = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part) => part.text ?? "").join("") : "Модель вернула пустой ответ.";
  await pool.query(
    "INSERT INTO messages (conversation_id, role, content, model) VALUES ($1, 'assistant', $2, $3)",
    [conversationId, answer, model]
  );
  return { conversationId, model, answer, usage: result.usage ?? null };
});


const taskSchema = z.object({
  prompt: z.string().trim().min(1).max(20000),
  model: z.string().min(1).max(200).optional(),
  conversationId: z.string().uuid().optional()
});

app.post("/api/v1/projects/:projectId/tasks", async (request, reply) => {
  const parsedProject = projectParam.safeParse(request.params);
  const parsedBody = taskSchema.safeParse(request.body);
  if (!parsedProject.success) return reply.badRequest(parsedProject.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const owned = await pool.query(
    "SELECT id, model FROM projects WHERE id=$1 AND owner_id=$2",
    [parsedProject.data.projectId, DEV_OWNER_ID]
  );
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  if (parsedBody.data.conversationId) {
    const conversation = await pool.query(
      "SELECT id FROM conversations WHERE id=$1 AND project_id=$2",
      [parsedBody.data.conversationId, parsedProject.data.projectId]
    );
    if (!conversation.rowCount) return reply.notFound("Диалог не найден в этом проекте");
  }
  const created = await pool.query(
    `INSERT INTO agent_tasks (project_id, conversation_id, prompt, model, status)
     VALUES ($1, $2, $3, $4, 'queued')
     RETURNING id, project_id, conversation_id, prompt, model, status, created_at`,
    [parsedProject.data.projectId, parsedBody.data.conversationId ?? null, parsedBody.data.prompt, parsedBody.data.model ?? owned.rows[0].model ?? DEFAULT_MODEL]
  );
  const task = created.rows[0];
  try {
    await getTaskQueue().add("execute", { taskId: task.id }, {
      jobId: task.id, attempts: 2, backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 500, removeOnFail: 1000
    });
  } catch (error) {
    await pool.query(
      "UPDATE agent_tasks SET status='failed', error=$2, completed_at=now(), updated_at=now() WHERE id=$1",
      [task.id, error instanceof Error ? error.message.slice(0, 1000) : "Redis queue unavailable"]
    );
    request.log.error({ err: error, taskId: task.id }, "Could not enqueue agent task");
    return reply.code(503).send({ error: "Очередь задач сейчас недоступна. Попробуй позже.", taskId: task.id });
  }
  return reply.code(202).send(task);
});

app.get("/api/v1/projects/:projectId/tasks", async (request, reply) => {
  const parsed = projectParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsed.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  const { rows } = await pool.query(
    `SELECT id, conversation_id, prompt, model, status, result, error, created_at, updated_at, started_at, completed_at
     FROM agent_tasks WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [parsed.data.projectId]
  );
  return { items: rows };
});

const taskParam = z.object({ taskId: z.string().uuid() });

app.get("/api/v1/tasks/:taskId/events", async (request, reply) => {
  const parsed = taskParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query("SELECT t.id FROM agent_tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND p.owner_id=$2",[parsed.data.taskId,DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Задача не найдена");
  const { rows } = await pool.query("SELECT id,event_type,tool_name,arguments,result,created_at FROM agent_task_events WHERE task_id=$1 ORDER BY created_at ASC LIMIT 200",[parsed.data.taskId]);
  return { items: rows };
});

app.get("/api/v1/tasks/:taskId", async (request, reply) => {
  const parsed = taskParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { rows } = await pool.query(
    `SELECT t.id, t.project_id, t.conversation_id, t.prompt, t.model, t.status, t.result, t.error,
            t.created_at, t.updated_at, t.started_at, t.completed_at
     FROM agent_tasks t JOIN projects p ON p.id=t.project_id
     WHERE t.id=$1 AND p.owner_id=$2`,
    [parsed.data.taskId, DEV_OWNER_ID]
  );
  if (!rows.length) return reply.notFound("Задача не найдена");
  return rows[0];
});

app.post("/api/v1/tasks/:taskId/cancel", async (request, reply) => {
  const parsed = taskParam.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const owned = await pool.query(
    "SELECT t.id, t.status FROM agent_tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND p.owner_id=$2",
    [parsed.data.taskId, DEV_OWNER_ID]
  );
  if (!owned.rowCount) return reply.notFound("Задача не найдена");
  if (["completed", "failed", "cancelled"].includes(owned.rows[0].status)) {
    return reply.code(409).send({ error: "Задача уже завершена", status: owned.rows[0].status });
  }
  await pool.query("UPDATE agent_tasks SET cancel_requested=TRUE, updated_at=now() WHERE id=$1", [parsed.data.taskId]);
  const job = await getTaskQueue().getJob(parsed.data.taskId);
  if (job && ["waiting", "delayed", "paused"].includes(await job.getState())) {
    await job.remove();
    await pool.query(
      "UPDATE agent_tasks SET status='cancelled', completed_at=now(), updated_at=now() WHERE id=$1",
      [parsed.data.taskId]
    );
  }
  return { id: parsed.data.taskId, status: "cancellation_requested" };
});


const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";

function githubAppJwt(): string {
  const clientId = process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientId || !privateKey) throw new Error("GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY are required");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({ iat: now - 60, exp: now + 9 * 60, iss: clientId });
  const unsigned = header + "." + payload;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return unsigned + "." + signer.sign(privateKey, "base64url");
}

async function githubAppRequest(path: string, method: "GET" | "POST" = "GET") {
  const response = await fetch(GITHUB_API + path, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + githubAppJwt(),
      "X-GitHub-Api-Version": GITHUB_API_VERSION
    }
  });
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  if (!response.ok) throw new Error("GitHub API " + response.status + ": " + String(payload.message ?? raw).slice(0, 1000));
  return payload;
}

async function githubInstallationToken(installationId: number): Promise<string> {
  const payload = await githubAppRequest("/app/installations/" + installationId + "/access_tokens", "POST");
  const token = payload.token;
  if (typeof token !== "string" || !token) throw new Error("GitHub did not return an installation token");
  return token;
}

async function githubInstallationRows() {
  const { rows } = await pool.query(
    "SELECT installation_id, account_login, account_type FROM github_installations WHERE owner_id=$1 ORDER BY account_login",
    [DEV_OWNER_ID]
  );
  return rows as Array<{ installation_id: string | number; account_login: string; account_type: string }>;
}

async function githubInstallationRequest(token: string, path: string, accept: "application/vnd.github.diff"): Promise<string>;
async function githubInstallationRequest(token: string, path: string, accept?: string): Promise<Record<string, unknown>>;
async function githubInstallationRequest(
  token: string, path: string, accept = "application/vnd.github+json"
): Promise<Record<string, unknown> | string> {
  const response = await fetch(GITHUB_API + path, {
    headers: {
      Accept: accept,
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": GITHUB_API_VERSION
    }
  });
  const raw = await response.text();
  if (!response.ok) {
    let message = raw;
    try { message = String((JSON.parse(raw) as Record<string, unknown>).message ?? raw); } catch { /* keep raw body */ }
    throw new Error("GitHub API " + response.status + ": " + message.slice(0, 1000));
  }
  if (accept === "application/vnd.github.diff") return raw;
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

async function githubRepoToken(owner: string, repo: string): Promise<string> {
  const installations = await githubInstallationRows();
  for (const installation of installations) {
    const token = await githubInstallationToken(Number(installation.installation_id));
    try {
      await githubInstallationRequest(token, "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo));
      return token;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("GitHub API 404")) continue;
      throw error;
    }
  }
  throw new Error("Репозиторий не входит в доступные установки GitHub App");
}

const githubRepoParams = z.object({
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)
});

app.get("/api/v1/github/connect", async (_request, reply) => {
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug || !(process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_APP_ID) || !process.env.GITHUB_APP_PRIVATE_KEY) {
    return reply.code(503).send({ error: "GitHub App не настроен: добавь GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID и GITHUB_APP_PRIVATE_KEY в backend .env" });
  }
  const state = randomBytes(24).toString("base64url");
  await pool.query(
    "INSERT INTO github_install_states (state_hash, owner_id, expires_at) VALUES ($1, $2, now() + interval '30 minutes')",
    [createHash("sha256").update(state).digest("hex"), DEV_OWNER_ID]
  );
  const url = new URL("https://github.com/apps/" + encodeURIComponent(slug) + "/installations/new");
  url.searchParams.set("state", state);
  return reply.redirect(url.toString());
});

app.get("/api/v1/github/callback", async (request, reply) => {
  const query = z.object({
    state: z.string().min(20).max(200),
    installation_id: z.coerce.number().int().positive()
  }).safeParse(request.query);
  if (!query.success) return reply.badRequest("Некорректные параметры GitHub callback");
  const stateHash = createHash("sha256").update(query.data.state).digest("hex");
  // Consume the one-time OAuth state atomically to prevent concurrent callback replay.
  const stateResult = await pool.query(
    "DELETE FROM github_install_states WHERE state_hash=$1 AND expires_at>now() RETURNING owner_id",
    [stateHash]
  );
  if (!stateResult.rowCount) return reply.code(400).send("Ссылка подключения GitHub устарела или уже использована. Вернись в AI Locman и начни подключение заново.");
  try {
    const installation = await githubAppRequest("/app/installations/" + query.data.installation_id);
    const account = installation.account as Record<string, unknown> | undefined;
    const login = typeof account?.login === "string" ? account.login : "GitHub account";
    const type = typeof account?.type === "string" ? account.type : "User";
    await pool.query(
      `INSERT INTO github_installations (owner_id, installation_id, account_login, account_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id, installation_id) DO UPDATE
       SET account_login=EXCLUDED.account_login, account_type=EXCLUDED.account_type, updated_at=now()`,
      [stateResult.rows[0].owner_id, query.data.installation_id, login, type]
    );
    return reply.type("text/html; charset=utf-8").send(
      "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>AI Locman</title></head><body style='font-family:system-ui;background:#0a1020;color:#eaf0fa;padding:32px'><h2>GitHub подключён</h2><p>Установка подтверждена. Можно закрыть эту страницу и вернуться в AI Locman.</p></body></html>"
    );
  } catch (error) {
    request.log.error({ err: error }, "GitHub installation validation failed");
    return reply.code(502).send("Не удалось проверить установку GitHub App. Проверь App ID и private key на backend.");
  }
});

app.get("/api/v1/github/status", async () => {
  const installations = await githubInstallationRows();
  return { connected: installations.length > 0, installations };
});

app.delete("/api/v1/github/connection", async (_request, reply) => {
  await pool.query("DELETE FROM github_installations WHERE owner_id=$1", [DEV_OWNER_ID]);
  return reply.code(204).send();
});

app.get("/api/v1/github/repositories", async (request, reply) => {
  try {
    const installations = await githubInstallationRows();
    const repositories: unknown[] = [];
    for (const installation of installations) {
      const token = await githubInstallationToken(Number(installation.installation_id));
      let page = 1;
      while (page <= 20) {
        const result = await githubInstallationRequest(token, "/installation/repositories?per_page=100&page=" + page);
        const items = Array.isArray(result.repositories) ? result.repositories : [];
        repositories.push(...items);
        if (items.length < 100 || repositories.length >= Number(result.total_count ?? 0)) break;
        page++;
      }
    }
    return { items: repositories };
  } catch (error) {
    request.log.error({ err: error }, "Could not list GitHub repositories");
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo));
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/branches", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/branches?per_page=100");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/contents", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  const query = z.object({
    path: z.string().max(1000).optional(),
    ref: z.string().max(255).optional()
  }).safeParse(request.query);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  if (!query.success) return reply.badRequest(query.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    const path = query.data.path
      ? "/" + query.data.path.split("/").map(encodeURIComponent).join("/")
      : "";
    const params = new URLSearchParams();
    if (query.data.ref) params.set("ref", query.data.ref);
    const queryString = params.toString();
    const suffix = queryString ? "?" + queryString : "";
    return await githubInstallationRequest(
      token,
      "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/contents" + path + suffix
    );
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/commits", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/commits?per_page=50");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/pulls", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/pulls?state=all&per_page=50");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/actions", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    return await githubInstallationRequest(token, "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) + "/actions/runs?per_page=50");
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});

app.get("/api/v1/github/repositories/:owner/:repo/compare", async (request, reply) => {
  const parsed = githubRepoParams.safeParse(request.params);
  const query = z.object({ base: z.string().min(1).max(255), head: z.string().min(1).max(255) }).safeParse(request.query);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  if (!query.success) return reply.badRequest(query.error.message);
  try {
    const token = await githubRepoToken(parsed.data.owner, parsed.data.repo);
    const response = await githubInstallationRequest(
      token,
      "/repos/" + encodeURIComponent(parsed.data.owner) + "/" + encodeURIComponent(parsed.data.repo) +
        "/compare/" + encodeURIComponent(query.data.base) + "..." + encodeURIComponent(query.data.head),
      "application/vnd.github.diff"
    );
    return reply.type("text/plain; charset=utf-8").send(response);
  } catch (error) {
    return reply.code(502).send({ error: error instanceof Error ? error.message : "GitHub API error" });
  }
});


const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: "0.0.0.0" });
