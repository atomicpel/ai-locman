import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import { z } from "zod";
import { Pool } from "pg";

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
  const { rows } = await pool.query(
    "SELECT id, section, content, updated_at FROM project_memory WHERE project_id=$1 ORDER BY section",
    [parsed.data.projectId]
  );
  const owned = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2", [parsed.data.projectId, DEV_OWNER_ID]);
  if (!owned.rowCount) return reply.notFound("Проект не найден");
  return { items: rows };
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
    { role: "system", content: `Ты — AI Locman, русскоязычный помощник по разработке. Проект: ${project.name}. Инструкции проекта: ${project.instructions || "нет"}. Отвечай конкретно, не утверждай, что выполнил действия с файлами или GitHub, если инструменты реально не запускались.` },
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

const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: "0.0.0.0" });
