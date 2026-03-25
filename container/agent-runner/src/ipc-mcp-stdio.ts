/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// ── Audio Transcription (OpenAI Whisper via credential proxy) ──

const PROXY_BASE = process.env.ANTHROPIC_BASE_URL || 'http://host.docker.internal:3001';

async function transcribeAudio(filePath: string): Promise<string> {
  const audioBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  // Build multipart/form-data manually (no external deps)
  const boundary = `----nanoclaw-${Date.now()}`;
  const parts: Buffer[] = [];

  // model field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`
  ));

  // file field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  ));
  parts.push(audioBuffer);
  parts.push(Buffer.from('\r\n'));

  // closing boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const res = await fetch(`${PROXY_BASE}/openai/v1/audio/transcriptions`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length.toString(),
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Whisper API failed (${res.status}): ${errText}`);
  }

  const data = await res.json() as { text: string };
  return data.text;
}

// ── Second Brain Tools ──────────────────────────────────────
// These call ChromaDB and LM Studio over the network from inside the container.
// host.docker.internal resolves to the Docker host machine.

const CHROMA_HOST = process.env.CHROMA_URL || 'http://host.docker.internal:8000';
const LMSTUDIO_HOST = process.env.LMSTUDIO_URL || 'http://host.docker.internal:11234';
const SB_EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-ai/nomic-embed-text-v2-moe-GGUF';

async function sbEmbed(text: string): Promise<number[]> {
  const res = await fetch(`${LMSTUDIO_HOST}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: SB_EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`Embed failed: ${res.statusText}`);
  const data = await res.json() as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

async function sbGetActiveJobId(): Promise<number> {
  // Read jobs.json from the mounted second-brain directory or default to 1
  try {
    const jobsPath = '/workspace/second-brain/jobs.json';
    if (fs.existsSync(jobsPath)) {
      const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
      const active = jobs.find((j: { is_active: boolean }) => j.is_active);
      return active?.id || 1;
    }
  } catch {}
  return 1;
}

interface ChromaQueryResult {
  ids: string[][];
  documents: (string | null)[][];
  metadatas: (Record<string, unknown> | null)[][];
  distances: number[][];
}

async function sbSearchChroma(queryEmbedding: number[], jobId: number, limit: number): Promise<string> {
  // Get collections
  const colRes = await fetch(`${CHROMA_HOST}/api/v2/tenants/default_tenant/databases/default_database/collections`);
  const collections = await colRes.json() as Array<{ id: string; name: string }>;

  const results: Array<{ type: string; title: string; content: string; similarity: number }> = [];

  for (const colName of ['obsidian_files', 'captures']) {
    const col = collections.find((c: { name: string }) => c.name === colName);
    if (!col) continue;

    const queryRes = await fetch(
      `${CHROMA_HOST}/api/v2/tenants/default_tenant/databases/default_database/collections/${col.id}/query`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query_embeddings: [queryEmbedding],
          n_results: limit,
          where: { '$or': [{ job_id: { '$eq': jobId } }, { job_id: { '$eq': 0 } }] },
          include: ['documents', 'metadatas', 'distances'],
        }),
      }
    );

    if (!queryRes.ok) continue;
    const data = await queryRes.json() as ChromaQueryResult;

    for (let i = 0; i < (data.ids[0]?.length || 0); i++) {
      const meta = data.metadatas[0][i] as Record<string, unknown> | null;
      results.push({
        type: colName === 'obsidian_files' ? 'obsidian_file' : 'capture',
        title: (meta?.file_name as string) || data.ids[0][i],
        content: data.documents[0][i] || '',
        similarity: 1 - (data.distances[0][i] || 0),
      });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit).map((r, i) =>
    `${i + 1}. [${r.type}] ${r.title} (${(r.similarity * 100).toFixed(1)}%)\n   ${r.content}`
  ).join('\n\n') || 'No results found.';
}

server.tool(
  'semantic_search',
  'Search the user\'s second brain (Obsidian notes and captures) using semantic similarity.',
  {
    query: z.string().describe('Natural language search query'),
    limit: z.number().optional().default(10).describe('Max results'),
  },
  async (args) => {
    try {
      const jobId = await sbGetActiveJobId();
      const embedding = await sbEmbed(args.query);
      const text = await sbSearchChroma(embedding, jobId, args.limit || 10);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Search error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  'add_capture',
  'Capture a quick thought or note into the user\'s second brain.',
  {
    content: z.string().describe('The thought or note to capture'),
    is_personal: z.boolean().optional().default(false).describe('True for personal, false for work'),
  },
  async (args) => {
    try {
      const jobId = args.is_personal ? 0 : await sbGetActiveJobId();
      const embedding = await sbEmbed(args.content);

      // Get captures collection
      const colRes = await fetch(`${CHROMA_HOST}/api/v2/tenants/default_tenant/databases/default_database/collections`);
      const collections = await colRes.json() as Array<{ id: string; name: string }>;
      const capturesCol = collections.find((c: { name: string }) => c.name === 'captures');
      if (!capturesCol) throw new Error('Captures collection not found');

      const id = `capture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await fetch(
        `${CHROMA_HOST}/api/v2/tenants/default_tenant/databases/default_database/collections/${capturesCol.id}/add`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ids: [id],
            documents: [args.content],
            embeddings: [embedding],
            metadatas: [{ job_id: jobId, created_at: new Date().toISOString() }],
          }),
        }
      );

      // Write to Obsidian vault via credential proxy (non-fatal)
      try {
        const proxyBase = process.env.ANTHROPIC_BASE_URL || 'http://host.docker.internal:3001';
        const date = new Date().toISOString().split('T')[0];
        const filename = `Captures/${date}-${id}.md`;
        const obsRes = await fetch(`${proxyBase}/obsidian/vault/${filename}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/markdown' },
          body: args.content,
        });
        if (!obsRes.ok) {
          console.error(`[nanoclaw-mcp] Obsidian write failed: ${obsRes.status} ${obsRes.statusText}`);
        } else {
          console.error(`[nanoclaw-mcp] Obsidian write OK: ${filename}`);
        }
      } catch (obsErr) {
        console.error(`[nanoclaw-mcp] Obsidian write error: ${obsErr instanceof Error ? obsErr.message : String(obsErr)}`);
      }

      return { content: [{ type: 'text' as const, text: `Captured: "${args.content.slice(0, 80)}..."` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Capture error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  'transcribe_audio',
  'Transcribe an audio/voice file to text using OpenAI Whisper.',
  {
    file_path: z.string().describe('Path to the audio file (e.g., /workspace/group/attachments/voice.ogg)'),
  },
  async (args) => {
    try {
      const text = await transcribeAudio(args.file_path);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Transcription error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
