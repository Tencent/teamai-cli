import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { readRegularFileSync } from '@teamai/shared/regular-file';
import { JsonObjectSchema } from '@teamai/shared/json';
import type { ExecResult, Processes } from '@teamai/shared/exec';
import { AgentAdapter, ToolUnavailableError, type SessionMeta, type SessionReadRef } from '@teamai/tool-core/sessions/base';
import { resolveRealCwd } from '@teamai/tool-core/sessions/fs';
import { toolArgumentsFrom, type ContentBlock, type Message, type Session } from '@teamai/tool-core/sessions/ir';
import { findSqlite3, snapshotSqlite } from '@teamai/tool-core/sessions/sqlite';

const SESSION_FILE = /^model-io-sess_([0-9a-f-]{36})\.jsonl$/i;

const StoredImageSource = z.object({
  path: z.string().optional(),
  placeholder: z.string().optional(),
  uri: z.string().optional(),
}).passthrough();

const StoredImageSourceValue = z.union([
  z.string().transform((source) => ({ path: source, placeholder: undefined, uri: undefined })),
  StoredImageSource,
]);

const StoredBlock = z.object({
  type: z.string(),
  text: z.string().optional(),
  dataUrl: z.string().optional(),
  mediaType: z.string().optional(),
  source: StoredImageSourceValue.optional(),
}).passthrough();

const StoredToolCall = z.object({
  id: z.string(), name: z.string(), input: JsonObjectSchema.optional(),
}).passthrough();

const StoredMessage = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(StoredBlock)]),
  toolCalls: z.array(StoredToolCall).optional(),
  toolCallId: z.string().optional(),
  isError: z.boolean().optional(),
  modelId: z.string().optional(),
}).passthrough();

const ModelIo = z.object({
  type: z.literal('model_io'),
  sessionId: z.string().nullable(),
  turnId: z.string(),
  requestId: z.string(),
  attempt: z.number().int().positive(),
  model: z.object({ modelId: z.string().optional(), providerId: z.string().optional() }).passthrough(),
  startedAt: z.string(),
  completedAt: z.string(),
  request: z.object({
    messages: z.array(StoredMessage),
    messagesKind: z.enum(['full', 'delta']),
    messageOffset: z.number().int().nonnegative(),
  }).passthrough(),
  response: z.object({
    text: z.string().optional(), reasoningText: z.string().optional(),
    toolCalls: z.array(StoredToolCall).optional(), modelId: z.string().optional(),
  }).passthrough(),
}).passthrough();

const SessionRow = z.object({
  id: z.string(), directory: z.string(), title: z.string().nullable(),
  time_created: z.number(), time_updated: z.number(), time_archived: z.number().nullable(),
});

type StoredMessage = z.infer<typeof StoredMessage>;

type ModelIo = z.infer<typeof ModelIo>;

type SessionRow = z.infer<typeof SessionRow>;

export interface ParsedZCode {
  filePath: string;
  sessionId: string;
  model?: string;
  provider?: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

function imageBlock(block: z.infer<typeof StoredBlock>): ContentBlock | undefined {
  if (block.type !== 'image' || !block.dataUrl) return undefined;
  const data = /^data:[^;,]+;base64,(.*)$/s.exec(block.dataUrl)?.[1];
  const labelSource = block.source?.placeholder ?? block.source?.path;

  return { type: 'image', mimeType: block.mediaType ?? 'image/png', data,
    filePath: block.source?.path, label: labelSource?.split(/[\\/]/).at(-1) };
}

function contentBlocks(content: StoredMessage['content']): ContentBlock[] {
  const text = z.string().safeParse(content);

  if (text.success) return text.data ? [{ type: 'text', text: text.data }] : [];
  const blocks = z.array(StoredBlock).parse(content);

  return blocks.flatMap((block): ContentBlock[] => {
    if (block.type === 'text' && block.text !== undefined) return [{ type: 'text', text: block.text }];

    if (block.type === 'reasoning' && block.text !== undefined) return [{ type: 'thinking', text: block.text }];

    const image = imageBlock(block);

    return image ? [image] : [];
  });
}

function messageFrom(stored: StoredMessage): Message | undefined {
  if (stored.role === 'system') return undefined;

  if (stored.role === 'tool') {
    if (!stored.toolCallId) return undefined;
    const text = z.string().safeParse(stored.content);

    return { role: 'user', content: [{ type: 'tool_result', callId: stored.toolCallId,
      content: text.success ? text.data : JSON.stringify(stored.content),
      isError: stored.isError ?? false }] };
  }

  const content = contentBlocks(stored.content);

  for (const call of stored.toolCalls ?? []) {
    content.push({ type: 'tool_call', callId: call.id, toolName: call.name,
      arguments: toolArgumentsFrom(call.input) });
  }

  if (!content.length) return undefined;

  return { role: stored.role, content, metadata: stored.modelId ? { model: stored.modelId } : undefined };
}

function responseMessage(record: ModelIo): Message | undefined {
  const content: ContentBlock[] = [];

  if (record.response.reasoningText) content.push({ type: 'thinking', text: record.response.reasoningText });

  if (record.response.text) content.push({ type: 'text', text: record.response.text });

  for (const call of record.response.toolCalls ?? []) {
    content.push({ type: 'tool_call', callId: call.id, toolName: call.name,
      arguments: toolArgumentsFrom(call.input) });
  }

  if (!content.length) return undefined;

  return { role: 'assistant', content, timestamp: record.completedAt,
    metadata: record.response.modelId ? { model: record.response.modelId } : undefined };
}

function sameMessage(left: Message, right: Message): boolean {
  return left.role === right.role && JSON.stringify(left.content) === JSON.stringify(right.content);
}

/**
 * Add only request-side events that responses do not already supply. ZCode replays an overlapping request window on
 * every turn and may replace it with a shorter compacted window. Assistant messages come from each record's complete
 * response instead; merging the user/tool subsequence keeps early prompts, images and tool results across compaction.
 */
function mergeRequestMessages(messages: Message[], window: Message[]): void {
  const incoming = window.filter(({ role }) => role !== 'assistant');

  if (!incoming.length) return;
  const existing = messages.filter(({ role }) => role !== 'assistant');
  let overlap = 0;
  let overlapEnd = 0;

  for (let start = 0; start < incoming.length; start++) {
    const possible = Math.min(existing.length, incoming.length - start);

    for (let count = possible; count > overlap; count--) {
      const oldStart = existing.length - count;
      let matches = true;

      for (let offset = 0; offset < count; offset++) {
        if (!sameMessage(existing[oldStart + offset]!, incoming[start + offset]!)) {
          matches = false;
          break;
        }
      }

      if (matches) {
        overlap = count;
        overlapEnd = start + count;
        break;
      }
    }
  }

  messages.push(...incoming.slice(overlap ? overlapEnd : 0));
}

/** Parse one ZCode model-I/O rollout. Project discovery waits on the store's cwd source. */
export function parseZCodeFile(filePath: string): ParsedZCode | undefined {
  const match = SESSION_FILE.exec(path.basename(filePath));

  if (!match) return undefined;
  const sessionId = match[1]!;
  const selected = new Map<string, { index: number; record: ModelIo }>();
  let index = 0;

  for (const line of readRegularFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let stored: unknown;

    try { stored = JSON.parse(line); } catch { continue; }

    const parsed = ModelIo.safeParse(stored);

    if (!parsed.success || parsed.data.sessionId !== `sess_${sessionId}`) continue;
    const previous = selected.get(parsed.data.requestId);

    if (!previous || parsed.data.attempt >= previous.record.attempt) selected.set(parsed.data.requestId, { index, record: parsed.data });
    index++;
  }

  const records = [...selected.values()].sort((a, b) => a.index - b.index).map(({ record }) => record);

  if (!records.length) return undefined;
  let storedMessages: StoredMessage[] = [];

  const messages: Message[] = [];

  for (const record of records) {
    if (record.request.messagesKind === 'full') storedMessages = record.request.messages;
    else storedMessages.splice(record.request.messageOffset, storedMessages.length, ...record.request.messages);

    const window = storedMessages.flatMap((stored) => {
      const message = messageFrom(stored);

      return message ? [message] : [];
    });

    mergeRequestMessages(messages, window);
    const response = responseMessage(record);

    if (response) messages.push(response);
  }

  const last = records.at(-1)!;

  return {
    filePath, sessionId, model: last.model.modelId ?? last.response.modelId,
    provider: last.model.providerId, createdAt: records[0]!.startedAt,
    updatedAt: last.completedAt, messages,
  };
}

function isoMillis(value: number): string | undefined {
  const date = new Date(value);

  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function titleOf(messages: Message[], sessionId: string): string {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = message.content.find((block) => block.type === 'text');

    if (text?.type === 'text' && text.text.trim()) return text.text.trim().split(/\r?\n/, 1)[0]!.slice(0, 100);
  }

  return `ZCode session ${sessionId.slice(0, 8)}`;
}

/** Read ZCode's authoritative session metadata and per-session model-I/O transcript without writing either store. */
export class ZCodeAdapter extends AgentAdapter {
  static readonly platform = 'zcode';

  constructor(private readonly cliHome: string, private readonly processes: Processes) { super(); }

  get platform(): string { return 'zcode'; }

  private get db(): string { return path.join(this.cliHome, 'db', 'db.sqlite'); }

  private get rollout(): string { return path.join(this.cliHome, 'rollout'); }

  isReady(): boolean { return fs.existsSync(this.db) && fs.existsSync(this.rollout); }

  private file(sessionId: string): string {
    return path.join(this.rollout, `model-io-sess_${sessionId}.jsonl`);
  }

  private async query(sql: string): Promise<unknown[]> {
    const sqlite3 = findSqlite3();

    if (!sqlite3) {
      throw new ToolUnavailableError(
        `The sqlite3 CLI was not found, so TeamAI cannot read ZCode session metadata from ${this.db}. ` +
        'Install sqlite3 and run the command again.',
      );
    }

    if (!fs.existsSync(this.db)) return [];
    const copy = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'teamai-zcode-state-'));
    let result: ExecResult;

    try {
      const copied = path.join(copy, 'db.sqlite');
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

  private async sessions(sessionId?: string, archived = false): Promise<SessionRow[]> {
    if (sessionId !== undefined && !/^[0-9a-f-]{36}$/i.test(sessionId)) return [];
    const id = sessionId === undefined ? '' : ` AND id = 'sess_${sessionId}'`;
    const archive = archived ? '' : ' AND time_archived IS NULL';

    const raw = await this.query(
      'SELECT id, directory, title, time_created, time_updated, time_archived FROM session ' +
      `WHERE time_deleted IS NULL${archive}${id} ORDER BY time_updated DESC;`,
    );

    return raw.flatMap((value) => {
      const row = SessionRow.safeParse(value);

      return row.success ? [row.data] : [];
    });
  }

  async listConversations(projectPath?: string, options: { archived?: boolean } = {}): Promise<SessionMeta[]> {
    const wanted = projectPath === undefined ? undefined : resolveRealCwd(projectPath);

    return (await this.sessions(undefined, options.archived)).flatMap((row) => {
      const sessionId = row.id.startsWith('sess_') ? row.id.slice(5) : '';
      const filePath = this.file(sessionId);

      if (!sessionId || !fs.existsSync(filePath) || (wanted && resolveRealCwd(row.directory) !== wanted)) return [];
      const parsed = parseZCodeFile(filePath);
      const createdAt = isoMillis(row.time_created);
      const updatedAt = isoMillis(row.time_updated);

      if (!parsed || !createdAt || !updatedAt) return [];

      return [{
        sessionId, title: row.title || titleOf(parsed.messages, sessionId), cwd: row.directory,
        platform: 'zcode', createdAt, updatedAt, messageCount: parsed.messages.length,
        filePath, sizeBytes: fs.statSync(filePath).size,
      }];
    });
  }

  async readSession(ref: SessionReadRef): Promise<Session> {
    const [row] = await this.sessions(ref.sessionId, true);
    const filePath = ref.filePath ?? this.file(ref.sessionId);
    const parsed = parseZCodeFile(filePath);

    if (!row || parsed?.sessionId !== ref.sessionId ||
      (ref.projectPath && resolveRealCwd(row.directory) !== resolveRealCwd(ref.projectPath))) {
      throw new Error(`No ZCode session ${ref.sessionId}${ref.projectPath ? ` in ${ref.projectPath}` : ''}.`);
    }

    const createdAt = isoMillis(row.time_created);
    const updatedAt = isoMillis(row.time_updated);

    if (!createdAt || !updatedAt) throw new Error(`ZCode session ${ref.sessionId} has invalid timestamps.`);

    const session: Session = {
      sessionId: ref.sessionId, title: row.title || titleOf(parsed.messages, ref.sessionId), cwd: row.directory,
      platform: 'zcode', createdAt, updatedAt, messages: parsed.messages,
    };

    if (parsed.model || parsed.provider) session.metadata = { model: parsed.model, provider: parsed.provider };

    return session;
  }

  async existingSessionId(sessionId: string, projectPath?: string): Promise<string | undefined> {
    const [row] = await this.sessions(sessionId, true);

    if (!row || !fs.existsSync(this.file(sessionId))) return undefined;

    return projectPath === undefined || resolveRealCwd(row.directory) === resolveRealCwd(projectPath) ? sessionId : undefined;
  }

  async writeSession(_session: Session): Promise<string> {
    throw new ToolUnavailableError('TeamAI cannot write ZCode sessions: ZCode resumes only from its own session store.');
  }

  async deleteSession(_sessionId: string): Promise<boolean> { return false; }
}
