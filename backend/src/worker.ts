import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { Pool } from "pg";

type TaskJob = { taskId: string };
type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }>;
    };
  }>;
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  maxRetriesPerRequest: null,
  ...(redisUrl.protocol === "rediss:" ? { tls: {} } : {})
};

await pool.query(\`
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
\`);

const baseUrl = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

async function executeTask(job: Job<TaskJob>) {
  const { taskId } = job.data;
  const taskResult = await pool.query(
    \`SELECT t.id, t.project_id, t.conversation_id, t.prompt, t.model, t.cancel_requested,
            p.name AS project_name, p.instructions
     FROM agent_tasks t JOIN projects p ON p.id=t.project_id
     WHERE t.id=$1\`,
    [taskId]
  );
  const task = taskResult.rows[0];
  if (!task) throw new Error("Task not found");

  if (task.cancel_requested) {
    await pool.query(
      "UPDATE agent_tasks SET status='cancelled', completed_at=now(), updated_at=now() WHERE id=$1",
      [taskId]
    );
    return { status: "cancelled" };
  }

  await pool.query(
    "UPDATE agent_tasks SET status='planning', started_at=COALESCE(started_at, now()), updated_at=now(), error=NULL WHERE id=$1",
    [taskId]
  );

  let conversationId: string;
  if (task.conversation_id) {
    conversationId = task.conversation_id as string;
  } else {
    const created = await pool.query(
      "INSERT INTO conversations (project_id, title) VALUES ($1, $2) RETURNING id",
      [task.project_id, task.prompt.slice(0, 70)]
    );
    conversationId = created.rows[0].id as string;
    await pool.query("UPDATE agent_tasks SET conversation_id=$2 WHERE id=$1", [taskId, conversationId]);
  }

  await pool.query(
    \`INSERT INTO messages (conversation_id, role, content, model, task_id)
     VALUES ($1, 'user', $2, $3, $4)
     ON CONFLICT (task_id, role) WHERE task_id IS NOT NULL DO NOTHING\`,
    [conversationId, task.prompt, task.model, taskId]
  );

  const cancellation = await pool.query("SELECT cancel_requested FROM agent_tasks WHERE id=$1", [taskId]);
  if (cancellation.rows[0]?.cancel_requested) {
    await pool.query(
      "UPDATE agent_tasks SET status='cancelled', completed_at=now(), updated_at=now() WHERE id=$1",
      [taskId]
    );
    return { status: "cancelled" };
  }

  await pool.query("UPDATE agent_tasks SET status='running', updated_at=now() WHERE id=$1", [taskId]);

  const memory = await pool.query(
    "SELECT section, content FROM project_memory WHERE project_id=$1 AND content <> '' ORDER BY section",
    [task.project_id]
  );
  const memoryText = memory.rows.map((entry) => \`[\${entry.section}]\\n\${entry.content}\`).join("\\n\\n");

  const history = await pool.query(
    \`SELECT role, content FROM messages
     WHERE conversation_id=$1 AND role IN ('user','assistant')
     ORDER BY created_at DESC LIMIT 30\`,
    [conversationId]
  );
  const messages = [
    {
      role: "system",
      content: \`Ты — AI Locman, фоновый исполнитель задач разработки. Проект: \${task.project_name}. Инструкции: \${task.instructions || "нет"}.
Память только этого проекта:
\${memoryText || "Пока пуста."}
Выполняй только те действия, которые реально доступны. Сейчас доступны только ответы модели; не заявляй об изменении файлов, GitHub или сборке, если соответствующий инструмент не вызывался.\`
    },
    ...history.rows.reverse()
  ];

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured on the worker");

  const response = await fetch(\`\${baseUrl}/chat/completions\`, {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${apiKey}\`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_PUBLIC_URL ?? "http://localhost:8080",
      "X-Title": "AI Locman Background Worker"
    },
    body: JSON.stringify({ model: task.model, messages, stream: false })
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 1200);
    throw new Error(\`OpenRouter HTTP \${response.status}: \${details}\`);
  }

  const payload = await response.json() as OpenRouterResponse;
  const raw = payload.choices?.[0]?.message?.content;
  const answer = typeof raw === "string"
    ? raw
    : Array.isArray(raw)
      ? raw.map((part) => part.text ?? "").join("")
      : "";
  if (!answer.trim()) throw new Error("The model returned an empty response");

  const cancelledAfterResponse = await pool.query("SELECT cancel_requested FROM agent_tasks WHERE id=$1", [taskId]);
  if (cancelledAfterResponse.rows[0]?.cancel_requested) {
    await pool.query(
      "UPDATE agent_tasks SET status='cancelled', completed_at=now(), updated_at=now() WHERE id=$1",
      [taskId]
    );
    return { status: "cancelled" };
  }

  await pool.query(
    \`INSERT INTO messages (conversation_id, role, content, model, task_id)
     VALUES ($1, 'assistant', $2, $3, $4)
     ON CONFLICT (task_id, role) WHERE task_id IS NOT NULL DO NOTHING\`,
    [conversationId, answer, task.model, taskId]
  );
  await pool.query(
    \`UPDATE agent_tasks
     SET status='completed', result=$2, error=NULL, completed_at=now(), updated_at=now()
     WHERE id=$1\`,
    [taskId, answer]
  );

  return { status: "completed", conversationId };
}

const worker = new Worker<TaskJob>("ai-locman-tasks", executeTask, {
  connection,
  concurrency: Number(process.env.AGENT_WORKER_CONCURRENCY ?? 2),
  lockDuration: 180_000
});

worker.on("completed", (job, result) => {
  console.info("AI Locman task completed", { taskId: job.id, result });
});

worker.on("failed", (job, error) => {
  if (!job) return;
  const maxAttempts = Number(job.opts.attempts ?? 1);
  if (job.attemptsMade >= maxAttempts) {
    void pool.query(
      \`UPDATE agent_tasks SET status='failed', error=$2, completed_at=now(), updated_at=now()
       WHERE id=$1 AND status NOT IN ('completed','cancelled')\`,
      [job.data.taskId, error.message.slice(0, 2000)]
    ).catch((dbError: unknown) => console.error("Could not persist task failure", dbError));
  }
  console.error("AI Locman task attempt failed", { taskId: job.id, attemptsMade: job.attemptsMade, error });
});

console.info("AI Locman background task worker started");

async function shutdown() {
  await worker.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
