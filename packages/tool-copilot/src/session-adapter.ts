/** Read GitHub Copilot CLI's append-only session event log without invoking the CLI. */
import * as fs from 'node:fs';
import { readRegularFileSync } from '@teamai/shared/regular-file';
import * as path from 'node:path';
import { z } from 'zod';
import { AgentAdapter, ToolUnavailableError, type SessionMeta, type SessionReadRef } from '@teamai/tool-core/sessions/base';
import { toolArgumentsFrom, type ContentBlock, type Message, type Session } from '@teamai/tool-core/sessions/ir';
import { readJsonl, resolveRealCwd } from '@teamai/tool-core/sessions/fs';
import { JsonValueSchema } from '@teamai/shared/json';
import { parseYaml } from '@teamai/shared/yaml';
import { log } from '@teamai/shared/log';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ToolRequest = z.object({
  toolCallId: z.string(), name: z.string(), arguments: JsonValueSchema.optional(),
}).passthrough();

const ResultText = z.union([z.string(), JsonValueSchema.transform((value) => JSON.stringify(value))]);

const Event = z.object({
  type: z.string(),
  timestamp: z.string().optional(),
  data: z.object({
    sessionId: z.string().optional(),
    copilotVersion: z.string().optional(),
    startTime: z.string().optional(),
    context: z.object({ cwd: z.string().optional() }).passthrough().optional(),
    content: z.string().optional(),
    messageId: z.string().optional(),
    model: z.string().optional(),
    newModel: z.string().optional(),
    chosenModel: z.string().optional(),
    toolRequests: z.array(ToolRequest).optional(),
    toolCallId: z.string().optional(),
    success: z.boolean().optional(),
    result: z.object({ content: ResultText.optional(), detailedContent: ResultText.optional() }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

interface ParsedCopilot {
  filePath: string;
  sessionId: string;
  cwd: string;
  model?: string;
  version?: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

function workspaceCwd(filePath: string): string {
  try {
    const stored = parseYaml(readRegularFileSync(path.join(path.dirname(filePath), 'workspace.yaml'), 'utf8'));
    const parsed = z.object({ cwd: z.string() }).safeParse(stored);

    return parsed.success ? parsed.data.cwd : '';
  } catch {
    return '';
  }
}

function firstUserTitle(messages: Message[], sessionId: string): string {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = message.content.find((block) => block.type === 'text');

    if (text?.type === 'text' && text.text.trim()) return text.text.trim().split(/\r?\n/, 1)[0]!.slice(0, 100);
  }

  return `Copilot session ${sessionId.slice(0, 8)}`;
}

function parseCopilotFile(filePath: string): ParsedCopilot | undefined {
  if (path.basename(filePath) !== 'events.jsonl') return undefined;
  const sessionId = path.basename(path.dirname(filePath));

  if (!UUID.test(sessionId)) return undefined;
  let cwd = '';
  let model: string | undefined;
  let version: string | undefined;
  let first: string | undefined;
  let last: string | undefined;
  const messages: Message[] = [];

  for (const stored of readJsonl(filePath)) {
    const parsed = Event.safeParse(stored);

    if (!parsed.success) continue;
    const event = parsed.data;
    const timestamp = event.timestamp;

    if (timestamp && !Number.isNaN(Date.parse(timestamp))) {
      first ??= timestamp;
      last = timestamp;
    }

    const data = event.data;

    if (!data) continue;

    if (event.type === 'session.start') {
      cwd = data.context?.cwd ?? cwd;
      version = data.copilotVersion ?? version;
      first = data.startTime ?? first;
    } else if (event.type === 'session.model_change') {
      model = data.newModel ?? model;
    } else if (event.type === 'session.auto_mode_resolved') {
      model = data.chosenModel ?? model;
    } else if (event.type === 'user.message' && data.content !== undefined) {
      messages.push({ role: 'user', content: [{ type: 'text', text: data.content }], timestamp,
        messageId: data.messageId });
    } else if (event.type === 'assistant.message') {
      const content: ContentBlock[] = [];

      if (data.content) content.push({ type: 'text', text: data.content });

      for (const request of data.toolRequests ?? []) {
        content.push({ type: 'tool_call', callId: request.toolCallId, toolName: request.name,
          arguments: toolArgumentsFrom(request.arguments) });
      }

      if (content.length) messages.push({ role: 'assistant', content, timestamp,
        messageId: data.messageId, metadata: data.model ? { model: data.model } : undefined });

      if (data.model) model = data.model;
    } else if (event.type === 'tool.execution_complete' && data.toolCallId) {
      messages.push({ role: 'user', content: [{ type: 'tool_result', callId: data.toolCallId,
        content: data.result?.content ?? data.result?.detailedContent ?? '', isError: data.success === false }], timestamp });
    }
  }

  cwd ||= workspaceCwd(filePath);

  if (!first) return undefined;

  return { filePath, sessionId, cwd, model, version, createdAt: first, updatedAt: last ?? first, messages };
}

/** A log that fails to read is skipped with a debug line, so one damaged session does not hide the others. */
function readCopilotFile(filePath: string): ParsedCopilot | undefined {
  try {
    return parseCopilotFile(filePath);
  } catch (cause) {
    log.debug(`copilot: skipped ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`);

    return undefined;
  }
}

export class CopilotAdapter extends AgentAdapter {
  constructor(private readonly storageRoot: string) { super(); }

  get platform(): string { return 'copilot'; }

  isReady(): boolean { return fs.existsSync(this.storageRoot); }

  private files(): string[] {
    if (!fs.existsSync(this.storageRoot)) return [];

    return fs.readdirSync(this.storageRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && UUID.test(entry.name))
      .map((entry) => path.join(this.storageRoot, entry.name, 'events.jsonl'))
      .filter((file) => fs.existsSync(file));
  }

  private parsed(sessionId?: string, projectPath?: string): ParsedCopilot[] {
    const wanted = projectPath ? resolveRealCwd(projectPath) : undefined;

    return this.files().flatMap((file) => {
      const parsed = readCopilotFile(file);

      if (!parsed || (sessionId && parsed.sessionId !== sessionId)) return [];

      if (wanted && (!parsed.cwd || resolveRealCwd(parsed.cwd) !== wanted)) return [];

      return [parsed];
    });
  }

  async listConversations(projectPath?: string): Promise<SessionMeta[]> {
    return this.parsed(undefined, projectPath).map((parsed) => ({
      sessionId: parsed.sessionId, title: firstUserTitle(parsed.messages, parsed.sessionId), cwd: parsed.cwd,
      platform: 'copilot', createdAt: parsed.createdAt, updatedAt: parsed.updatedAt,
      messageCount: parsed.messages.length, filePath: parsed.filePath, sizeBytes: fs.statSync(parsed.filePath).size,
    })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async readSession(ref: SessionReadRef): Promise<Session> {
    let parsed: ParsedCopilot | undefined;

    if (ref.filePath) {
      const exact = parseCopilotFile(ref.filePath);

      if (exact?.sessionId === ref.sessionId) parsed = exact;
    } else if (UUID.test(ref.sessionId)) {
      [parsed] = this.parsed(ref.sessionId, ref.projectPath);
    }

    if (!parsed) throw new Error(`No Copilot session ${ref.sessionId}${ref.projectPath ? ` in ${ref.projectPath}` : ''}.`);

    const session: Session = {
      sessionId: parsed.sessionId, title: firstUserTitle(parsed.messages, parsed.sessionId), cwd: parsed.cwd,
      platform: 'copilot', createdAt: parsed.createdAt, updatedAt: parsed.updatedAt, messages: parsed.messages,
    };

    if (parsed.model || parsed.version) session.metadata = { model: parsed.model, version: parsed.version };

    return session;
  }

  async existingSessionId(sessionId: string, projectPath?: string): Promise<string | undefined> {
    if (!UUID.test(sessionId)) return undefined;

    return this.parsed(sessionId, projectPath)[0] ? sessionId : undefined;
  }

  async writeSession(_session: Session): Promise<string> {
    throw new ToolUnavailableError('TeamAI cannot write Copilot sessions: Copilot resumes only its own event log.');
  }

  async deleteSession(_sessionId: string): Promise<boolean> { return false; }
}
