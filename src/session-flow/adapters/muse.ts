/** Read Muse Code's append-only session event log without invoking the CLI. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { AgentAdapter, ToolUnavailableError, type SessionMeta, type SessionReadRef } from './base.js';
import { toolArgumentsFrom, type ContentBlock, type Message, type Session } from '../ir.js';
import { resolveRealCwd } from '../fs.js';
import { JsonValueSchema } from '../../types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A model is a bare id or `{ model_id }`, as the Muse token reader accepts. */
const ModelId = z.union([z.string(), z.object({ model_id: z.string() }).transform((model) => model.model_id)]);

const Envelope = z.object({
  stream: z.object({ id: z.string().optional() }).optional(),
  recorded_at: z.number().optional(),
  payload_type: z.string().nullable().optional(),
  payload: z.object({
    kind: z.string().optional(),
    workspace_root: z.string().optional().catch(undefined),
    record: z.object({ workspace_root: z.string().optional(), model_id: z.string().optional() }).passthrough().optional(),
    event: z.object({
      kind: z.string().optional(), prompt: z.string().optional(), text: z.string().optional(),
      message_id: z.string().optional(), model: ModelId.optional().catch(undefined),
      // `inbox_item_queued`: a steer's text is `payload.prompt`, or `body` when the record carries no payload.
      source: z.object({ source: z.string().optional() }).passthrough().optional().catch(undefined),
      payload: z.object({ prompt: z.string().optional() }).passthrough().nullable().optional().catch(undefined),
      body: z.string().optional().catch(undefined),
      session_metadata: z.object({ workspace_root: z.string().optional() }).passthrough().optional().catch(undefined),
      tool_calls: z.array(z.object({ call_id: z.string(), name: z.string(), args: JsonValueSchema.optional() })).optional(),
      results: z.array(z.object({ tool_call_id: z.string(), text: z.string() })).optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
});

interface ParsedMuse {
  filePath: string;
  sessionId: string;
  cwd: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

function iso(micros: number | undefined): string | undefined {
  if (!micros || !Number.isFinite(micros)) return undefined;
  const date = new Date(Math.floor(micros / 1000));

  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function firstUserTitle(messages: Message[], sessionId: string): string {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = message.content.find((block) => block.type === 'text');

    if (text?.type === 'text' && text.text.trim()) return text.text.trim().split(/\r?\n/, 1)[0]!.slice(0, 100);
  }

  return `Muse session ${sessionId.slice(0, 8)}`;
}

function parseMuseFile(filePath: string): ParsedMuse | undefined {
  if (path.basename(filePath) !== 'session.jsonl') return undefined;
  const sessionId = path.basename(path.dirname(filePath));

  if (!UUID.test(sessionId)) return undefined;
  let cwd = '';
  let model: string | undefined;
  let first: string | undefined;
  let last: string | undefined;
  const messages: Message[] = [];

  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let stored: unknown;

    try { stored = JSON.parse(line); } catch { continue; }

    const parsed = Envelope.safeParse(stored);

    if (!parsed.success) continue;
    const record = parsed.data;

    // Subagents log under subagent/<id>/. Keep only records of this session's own stream.
    if (record.stream?.id && record.stream.id !== sessionId) continue;
    const timestamp = iso(record.recorded_at);

    if (timestamp) {
      first ??= timestamp;
      last = timestamp;
    }

    const payload = record.payload;

    // The workspace is the latest one recorded, as Muse's session-evidence helper reads it:
    // a metadata record's `workspace_root`, else its `record.workspace_root`, or a checkpoint's.
    if (record.payload_type === 'runtime.session.metadata') {
      const workspace = payload?.workspace_root ?? payload?.record?.workspace_root;

      if (workspace) cwd = workspace;

      if (!model && payload?.record?.model_id) model = payload.record.model_id;
      continue;
    }

    if (record.payload_type !== 'runtime.session') continue;
    const event = payload?.event;

    if (event?.kind === 'context_projection_checkpoint') {
      if (event.session_metadata?.workspace_root) cwd = event.session_metadata.workspace_root;
      continue;
    }

    if (payload?.kind !== 'run') continue;

    if (!event) continue;
    const kind = event?.kind;

    if (kind === 'started' && event.prompt !== undefined) {
      messages.push({ role: 'user', content: [{ type: 'text', text: event.prompt }], timestamp });
    } else if (kind === 'reasoning_committed' && event.text) {
      messages.push({ role: 'assistant', content: [{ type: 'thinking', text: event.text }], timestamp,
        messageId: event.message_id });
    } else if (kind === 'assistant_message_committed' && event.text) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: event.text }], timestamp,
        messageId: event.message_id });
    } else if (kind === 'assistant_tool_calls_committed' && event.tool_calls) {
      const content: ContentBlock[] = [];

      for (const call of event.tool_calls) {
        content.push({ type: 'tool_call', callId: call.call_id, toolName: call.name,
          arguments: toolArgumentsFrom(call.args) });
      }

      if (content.length) messages.push({ role: 'assistant', content, timestamp,
        messageId: event.message_id });
    } else if (kind === 'tool_result_batch_committed' && event.results) {
      const content: ContentBlock[] = [];

      for (const result of event.results) {
        content.push({ type: 'tool_result', callId: result.tool_call_id,
          content: result.text, isError: result.text.startsWith('tool failed:') });
      }

      if (content.length) messages.push({ role: 'user', content, timestamp });
    } else if (kind === 'inbox_item_queued' && event.source?.source === 'user_steer') {
      // A prompt typed while a run was active. Background, scheduled and subagent deliveries share this kind.
      const prompt = event.payload?.prompt ?? event.body;

      if (prompt !== undefined) messages.push({ role: 'user', content: [{ type: 'text', text: prompt }], timestamp });
    } else if (kind === 'model_completed' && event.model) {
      model = event.model;
    }
  }

  if (!first) return undefined;

  return { filePath, sessionId, cwd, model, createdAt: first, updatedAt: last ?? first, messages };
}

export class MuseAdapter extends AgentAdapter {
  constructor(private readonly storageRoot: string) { super(); }

  get platform(): string { return 'muse'; }

  isReady(): boolean { return fs.existsSync(this.storageRoot); }

  private files(): string[] {
    if (!fs.existsSync(this.storageRoot)) return [];
    const files: string[] = [];

    // Muse shards roots as YYYY/MM/DD/<uuid>/session.jsonl. Do not enter subagent trees.
    for (const year of fs.readdirSync(this.storageRoot, { withFileTypes: true })) {
      if (!year.isDirectory()) continue;
      const yearDir = path.join(this.storageRoot, year.name);

      for (const month of fs.readdirSync(yearDir, { withFileTypes: true })) {
        if (!month.isDirectory()) continue;
        const monthDir = path.join(yearDir, month.name);

        for (const day of fs.readdirSync(monthDir, { withFileTypes: true })) {
          if (!day.isDirectory()) continue;
          const dayDir = path.join(monthDir, day.name);

          for (const session of fs.readdirSync(dayDir, { withFileTypes: true })) {
            if (!session.isDirectory() || !UUID.test(session.name)) continue;
            const file = path.join(dayDir, session.name, 'session.jsonl');

            if (fs.existsSync(file)) files.push(file);
          }
        }
      }
    }

    return files;
  }

  private parsed(sessionId?: string, projectPath?: string): ParsedMuse[] {
    // Muse records the physical workspace path. Match aliases such as macOS
    // `/tmp` -> `/private/tmp` and user-provided symlinked --cwd values.
    const wanted = projectPath ? resolveRealCwd(projectPath) : undefined;

    return this.files().flatMap((file) => {
      const parsed = parseMuseFile(file);

      if (!parsed || (sessionId && parsed.sessionId !== sessionId)) return [];

      if (wanted && (!parsed.cwd || resolveRealCwd(parsed.cwd) !== wanted)) return [];

      return [parsed];
    });
  }

  async listConversations(projectPath?: string): Promise<SessionMeta[]> {
    return this.parsed(undefined, projectPath).map((parsed) => ({
      sessionId: parsed.sessionId, title: firstUserTitle(parsed.messages, parsed.sessionId), cwd: parsed.cwd,
      platform: 'muse', createdAt: parsed.createdAt, updatedAt: parsed.updatedAt,
      messageCount: parsed.messages.length, filePath: parsed.filePath, sizeBytes: fs.statSync(parsed.filePath).size,
    })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async readSession(ref: SessionReadRef): Promise<Session> {
    let parsed: ParsedMuse | undefined;

    if (ref.filePath) {
      const exact = parseMuseFile(ref.filePath);

      if (exact?.sessionId === ref.sessionId) parsed = exact;
    } else if (UUID.test(ref.sessionId)) {
      [parsed] = this.parsed(ref.sessionId, ref.projectPath);
    }

    if (!parsed) throw new Error(`No Muse session ${ref.sessionId}${ref.projectPath ? ` in ${ref.projectPath}` : ''}.`);

    const session: Session = {
      sessionId: parsed.sessionId, title: firstUserTitle(parsed.messages, parsed.sessionId), cwd: parsed.cwd,
      platform: 'muse', createdAt: parsed.createdAt, updatedAt: parsed.updatedAt, messages: parsed.messages,
    };

    if (parsed.model) session.metadata = { model: parsed.model };

    return session;
  }

  async existingSessionId(sessionId: string, projectPath?: string): Promise<string | undefined> {
    if (!UUID.test(sessionId)) return undefined;

    return this.parsed(sessionId, projectPath)[0] ? sessionId : undefined;
  }

  async writeSession(_session: Session): Promise<string> {
    throw new ToolUnavailableError('TeamAI cannot write Muse sessions: Muse resumes only its own append-only event log.');
  }

  async deleteSession(_sessionId: string): Promise<boolean> { return false; }
}
