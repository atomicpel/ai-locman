import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import { z } from "zod";
import { Pool } from "pg";
import { Queue } from "bullmq";

const app = Fastify({ logger: true, bodyLimit: 1_000_000 });
await app.register(helmet);
await app.register(cors, { origin: process.env.NODE_ENV === "production" ? false : true });
await app.register(sensible);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
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
    "SELECT id, name, description, created_at FROM projects WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100",
    [DEV_OWNER_ID]
  );
  return { items: rows };
});

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default("")
});

app.post("/api/v1/projects", async (request, reply) => {
  const parsed = createProjectSchema.safeParse(request.body);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { name, description } = parsed.data;
  const { rows } = await pool.query(
    `INSERT INTO projects (owner_id, name, description)
     VALUES ($1, $2, $3) RETURNING id, name, description, created_at`,
    [DEV_OWNER_ID, name, description]
  );
  return reply.code(201).send(rows[0]);
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
  model: z.string().min(1).max(200).default(DEFAULT_MODEL),
  message: z.string().trim().min(1).max(20000)
});

app.post("/api/v1/chat", async (request, reply) => {
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) return reply.badRequest(parsed.error.message);
  const { projectId, model, message } = parsed.data;
  const projectResult = await pool.query(
    "SELECT id, name, instructions FROM projects WHERE id = $1 AND owner_id = $2",
    [projectId, DEV_OWNER_ID]
  );
  const project = projectResult.rows[0];
  if (!project) return reply.notFound("Проект не найден");
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
  model: z.string().min(1).max(200).default(DEFAULT_MODEL),
  conversationId: z.string().uuid().optional()
});

app.post("/api/v1/projects/:projectId/tasks", async (request, reply) => {
  const parsedProject = projectParam.safeParse(request.params);
  const parsedBody = taskSchema.safeParse(request.body);
  if (!parsedProject.success) return reply.badRequest(parsedProject.error.message);
  if (!parsedBody.success) return reply.badRequest(parsedBody.error.message);
  const owned = await pool.query(
    "SELECT id FROM projects WHERE id=$1 AND owner_id=$2",
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
    [parsedProject.data.projectId, parsedBody.data.conversationId ?? null, parsedBody.data.prompt, parsedBody.data.model]
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

const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: "0.0.0.0" });
