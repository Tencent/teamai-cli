/** Read coding sessions from Hermes Agent's SQLite state store without invoking Hermes. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { AgentAdapter, ToolUnavailableError, type SessionMeta, type SessionReadRef } from '@teamai/tool-core/sessions/base';
import { resolveRealCwd } from '@teamai/tool-core/sessions/fs';
import { toolArgumentsFrom, type ContentBlock, type Message, type Session } from '@teamai/tool-core/sessions/ir';
import { fallbackTitle } from '@teamai/tool-core/sessions/title';
import { isSafeSessionFileId } from '@teamai/tool-core/sessions/ids';
import { findSqlite3, snapshotSqlite } from '@teamai/tool-core/sessions/sqlite';
import type { ExecResult, Processes } from '@teamai/shared/exec';
import { JsonValueSchema } from '@teamai/shared/json';

const CODING_SOURCES = ['acp', 'cli', 'desktop', 'gui', 'oneshot', 'tui'] as const;
const LOCAL_CODING_SOURCES = ['acp', 'cli', 'gui', 'oneshot', 'tui'] as const;
const SOURCE_SQL = CODING_SOURCES.map((source) => `'${source}'`).join(', ');
const LOCAL_SOURCE_SQL = LOCAL_CODING_SOURCES.map((source) => `'${source}'`).join(', ');

const SessionRow = z.object({
  id: z.string(), source: z.string(), model: z.string().nullable(), cwd: z.string().nullable(),
  title: z.string().nullable(), started_at: z.number(), ended_at: z.number().nullable(),
  last_activity_at: z.number().nullable(), message_count: z.number().nullable(),
});

const MessageRow = z.object({
  id: z.number(), role: z.string(), content: z.string().nullable(), tool_call_id: z.string().nullable(),
  tool_calls: z.string().nullable(), tool_name: z.string().nullable(), timestamp: z.number(),
  finish_reason: z.string().nullable(), reasoning: z.string().nullable(), reasoning_content: z.string().nullable(),
});

const StoredToolCall = z.object({
  id: z.string().optional(), call_id: z.string().optional(), name: z.string().optional(),
  arguments: JsonValueSchema.optional(), args: JsonValueSchema.optional(),
  function: z.object({ name: z.string(), arguments: JsonValueSchema.optional() }).optional(),
});

const StoredContentParts = z.array(z.union([
  z.string(),
  z.object({ text: z.string() }).passthrough().transform((part) => part.text),
]));

type SessionRow = z.infer<typeof SessionRow>;

type MessageRow = z.infer<typeof MessageRow>;

function iso(seconds: number | null): string | undefined {
  if (seconds === null || !Number.isFinite(seconds)) return undefined;
  const date = new Date(seconds * 1000);

  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function textOf(content: string | null): string {
  if (!content) return '';

  try {
    const decoded: unknown = JSON.parse(content);
    const text = z.string().safeParse(decoded);

    if (text.success) return text.data;
    const parts = StoredContentParts.safeParse(decoded);

    if (parts.success) return parts.data.join('\n');
  } catch {
    // Ordinary message content is a string, not JSON.
  }

  return content;
}

function toolCallsOf(stored: string | null): ContentBlock[] {
  if (!stored) return [];
  let parsed: unknown;

  try { parsed = JSON.parse(stored); } catch { return []; }

  const calls = z.array(StoredToolCall).safeParse(parsed);

  if (!calls.success) return [];

  return calls.data.flatMap((call) => {
    const name = call.function?.name ?? call.name;
    const callId = call.id ?? call.call_id;

    if (!name || !callId) return [];
    const args = call.function?.arguments ?? call.arguments ?? call.args;

    return [{ type: 'tool_call' as const, callId, toolName: name, arguments: toolArgumentsFrom(args) }];
  });
}

function messagesOf(rows: MessageRow[]): Message[] {
  const messages: Message[] = [];

  for (const row of rows) {
    const timestamp = iso(row.timestamp);

    if (row.role === 'user') {
      const text = textOf(row.content);

      if (text) messages.push({ role: 'user', content: [{ type: 'text', text }], timestamp, messageId: String(row.id) });
    } else if (row.role === 'assistant') {
      const content: ContentBlock[] = [];

      const reasoning = row.reasoning ?? row.reasoning_content;

      if (reasoning) content.push({ type: 'thinking', text: reasoning });
      const text = textOf(row.content);

      if (text) content.push({ type: 'text', text });
      content.push(...toolCallsOf(row.tool_calls));

      if (content.length) messages.push({ role: 'assistant', content, timestamp, messageId: String(row.id) });
    } else if (row.role === 'tool' && row.tool_call_id) {
      messages.push({
        role: 'user', timestamp, messageId: String(row.id),
        content: [{
          type: 'tool_result', callId: row.tool_call_id, content: textOf(row.content),
          isError: row.finish_reason === 'error',
        }],
      });
    }
  }

  return messages;
}

export class HermesAdapter extends AgentAdapter {
  static readonly platform = 'hermes';

  constructor(private readonly home: string, private readonly processes: Processes) { super(); }

  get platform(): string { return 'hermes'; }

  isReady(): boolean { return fs.existsSync(this.db); }

  private get db(): string { return path.join(this.home, 'state.db'); }

  private async query(sql: string): Promise<unknown[]> {
    const sqlite3 = findSqlite3();

    if (!sqlite3) {
      throw new ToolUnavailableError(
        `The sqlite3 CLI was not found, so TeamAI cannot read Hermes sessions from ${this.db}. ` +
          'Install sqlite3 and run the command again.',
      );
    }

    if (!fs.existsSync(this.db)) return [];
    const copy = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'teamai-hermes-state-'));
    let result: ExecResult;

    try {
      const copied = path.join(copy, 'state.db');
      await snapshotSqlite(sqlite3, this.db, copied, this.processes.exec);
      result = await this.processes.exec(sqlite3, ['-json', copied, sql], { timeoutMs: 30_000 });
    } finally {
      await fs.promises.rm(copy, { recursive: true, force: true });
    }

    if (result.code !== 0) {
      throw new Error(`sqlite3 could not read ${this.db}: ${result.stderr.trim() || `exit ${result.code}`}`);
    }

    if (!result.stdout.trim()) return [];
    const rows = z.array(z.unknown()).safeParse(JSON.parse(result.stdout));

    return rows.success ? rows.data : [];
  }

  private async sessions(sessionId?: string): Promise<SessionRow[]> {
    if (sessionId !== undefined && !isSafeSessionFileId(sessionId)) return [];
    const id = sessionId === undefined ? '' : ` AND id = '${sessionId}'`;

    const raw = await this.query(
      'SELECT id, source, model, cwd, title, started_at, ended_at, last_activity_at, message_count ' +
      `FROM sessions WHERE (LOWER(source) IN (${SOURCE_SQL}) OR ` +
      `(LOWER(source) = 'local' AND LOWER(created_source) IN (${LOCAL_SOURCE_SQL})))${id} ` +
      'ORDER BY COALESCE(last_activity_at, ended_at, started_at) DESC;',
    );

    return raw.flatMap((value) => {
      const row = SessionRow.safeParse(value);

      return row.success ? [row.data] : [];
    });
  }

  private async messages(sessionId: string): Promise<MessageRow[]> {
    const raw = await this.query(
      'SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp, finish_reason, reasoning, reasoning_content ' +
      `FROM messages WHERE session_id = '${sessionId}' AND (active = 1 OR compacted = 1) ORDER BY id;`,
    );

    return raw.flatMap((value) => {
      const row = MessageRow.safeParse(value);

      return row.success ? [row.data] : [];
    });
  }

  async listConversations(projectPath?: string): Promise<SessionMeta[]> {
    const wanted = projectPath === undefined ? undefined : resolveRealCwd(projectPath);
    const sizeBytes = fs.existsSync(this.db) ? fs.statSync(this.db).size : 0;

    return (await this.sessions()).flatMap((row) => {
      if (!row.cwd || (wanted !== undefined && resolveRealCwd(row.cwd) !== wanted)) return [];
      const createdAt = iso(row.started_at);
      const updatedAt = iso(row.last_activity_at ?? row.ended_at ?? row.started_at);

      if (!createdAt || !updatedAt) return [];

      return [{
        sessionId: row.id, title: row.title || fallbackTitle(row.id), cwd: row.cwd, platform: 'hermes',
        createdAt, updatedAt, messageCount: row.message_count ?? undefined, filePath: this.db, sizeBytes,
      }];
    });
  }

  async readSession(ref: SessionReadRef): Promise<Session> {
    const [row] = await this.sessions(ref.sessionId);

    if (!row || !row.cwd || (ref.projectPath && resolveRealCwd(row.cwd) !== resolveRealCwd(ref.projectPath))) {
      throw new Error(`No Hermes coding session ${ref.sessionId}${ref.projectPath ? ` in ${ref.projectPath}` : ''}.`);
    }

    const messages = messagesOf(await this.messages(row.id));
    const createdAt = iso(row.started_at);
    const updatedAt = iso(row.last_activity_at ?? row.ended_at ?? row.started_at);

    if (!createdAt || !updatedAt) throw new Error(`Hermes session ${row.id} has invalid timestamps.`);

    const session: Session = {
      sessionId: row.id, title: row.title || fallbackTitle(row.id), cwd: row.cwd, platform: 'hermes',
      createdAt, updatedAt, messages,
    };

    if (row.model) session.metadata = { model: row.model };

    return session;
  }

  async existingSessionId(sessionId: string, projectPath?: string): Promise<string | undefined> {
    const [row] = await this.sessions(sessionId);

    if (!row?.cwd) return undefined;

    return projectPath === undefined || resolveRealCwd(row.cwd) === resolveRealCwd(projectPath) ? row.id : undefined;
  }

  async writeSession(_session: Session): Promise<string> {
    throw new ToolUnavailableError('TeamAI cannot write Hermes sessions: Hermes resumes only from its own state.db.');
  }

  async deleteSession(_sessionId: string): Promise<boolean> { return false; }
}
