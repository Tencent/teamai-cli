/**
 * adapters/opencode.ts — OpenCode platform adapter.
 *
 * OpenCode 2 keeps sessions in a SQLite store whose schema is still moving, so this adapter talks
 * only to its CLI: `opencode session list --format json` (the sessions of the project the command
 * runs in), `opencode session export <id>` (one session by id, from any directory),
 * `opencode session import <file> --directory <dir>` (the export shape) and
 * `opencode session delete <id>`. OpenCode 1 has no `session export`, so it counts as unavailable.
 *
 * Every call passes `--standalone`: without it the CLI talks to OpenCode's background service,
 * and starts one when none runs, which outlives this process.
 *
 * Export shape (OpenCode 2.0.29): `{ info, messages }`. `info` carries `id`, `title`,
 * `time.created/updated` (epoch ms) and `location.directory`. A `user` message has `text` and
 * `files` (inline base64 with `mime` and `name`); an `assistant` message has `content` parts:
 * `text`, `reasoning`, and `tool` (`id` is the call id, `state.input`, `state.content` the
 * result). Other message types (`idle`, `synthetic`, `system`, `shell`, `skill`, `compaction`)
 * are bookkeeping and are not read.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import * as path from 'node:path';
import crossSpawn from 'cross-spawn';
import { homedir, tmpdir } from 'node:os';
import { z } from 'zod';
import { AgentAdapter, ToolUnavailableError, type SessionMeta, type SessionReadRef, type Subagent, type SubagentsRead } from './base.js';
import { imagePlaceholderText, type ContentBlock, type Message, type Session } from '../ir.js';
import { resolveRealCwd } from '../fs.js';
import { deriveOpencodeMessageIds, deriveTargetSessionId } from '../ids.js';
import { execCommand, probeBinary, type ExecResult } from '../../utils/exec.js';

const OPENCODE_TO_IR_TOOL: Record<string, string> = {
  read: 'read_file',
  write: 'write_file',
  edit: 'edit_file',
  shell: 'bash',
  bash: 'bash',
  glob: 'glob',
  grep: 'grep',
  task: 'task',
  todowrite: 'todo_write',
  webfetch: 'web_fetch',
  websearch: 'web_search',
};

const ChildSessions = z.union([
  z.array(z.object({ id: z.string(), parentID: z.string().optional() })),
  z.object({ data: z.array(z.object({ id: z.string(), parentID: z.string().optional() })) }).transform((body) => body.data),
]);

const SERVER_READY_MS = 10_000;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function startChildServer(): Promise<{ children(parent: string): Promise<string[]>; stop(): Promise<void> } | string> {
  const port = await freePort();
  const password = randomBytes(16).toString('hex');
  const child = crossSpawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    stdio: 'ignore',
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  const stop = async (): Promise<void> => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
  };
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
  const get = (query: string): Promise<Response> => fetch(`http://127.0.0.1:${port}/api/session?${query}`, { headers, signal: AbortSignal.timeout(1000) });
  const deadline = Date.now() + SERVER_READY_MS;
  for (;;) {
    const ready = await get('limit=1').then((response) => response.ok, () => false);
    if (ready) break;
    if (child.exitCode !== null || Date.now() > deadline) {
      await stop();
      return `opencode serve did not answer on port ${port} within ${SERVER_READY_MS / 1000} s`;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return {
    async children(parent) {
      const response = await get(`parentID=${encodeURIComponent(parent)}`);
      if (!response.ok) throw new Error(`opencode serve answered ${response.status} to the children of ${parent}`);
      return ChildSessions.parse(await response.json()).filter((info) => info.parentID === parent).map((info) => info.id);
    },
    stop,
  };
}

/** How many sessions one listing returns; the CLI's own default is 100. */
const LIST_MAX = 10_000;

/** `opencode session export` and `delete` print this to stderr for an id it does not have. */
const NOT_FOUND = /Session not found/i;

/** `opencode session import` prints this to stderr, and exits 0, for an id it already has. */
const ALREADY_EXISTS = /Session already exists/i;

const ListedSessions = z.array(
  z.object({ id: z.string(), title: z.string(), created: z.number(), updated: z.number(), directory: z.string() }),
);

const ExportedSession = z.object({
  info: z.object({
    id: z.string(),
    title: z.string(),
    time: z.object({ created: z.number(), updated: z.number() }),
    location: z.object({ directory: z.string() }),
    model: z.object({ id: z.string() }).optional(),
  }),
  messages: z.array(z.object({ type: z.string() }).passthrough()),
});

const MessageTime = z.object({ created: z.number() });

const UserMessage = z.object({
  id: z.string(),
  time: MessageTime,
  text: z.string().default(''),
  files: z
    .array(z.object({ mime: z.string(), data: z.string().optional(), name: z.string().optional(), uri: z.string().optional() }))
    .default([]),
});

const AssistantMessage = z.object({
  id: z.string(),
  time: MessageTime,
  content: z.array(z.object({ type: z.string() }).passthrough()),
});

const ToolPart = z.object({
  id: z.string(),
  name: z.string(),
  state: z.object({
    status: z.string(),
    input: z.record(z.unknown()).default({}),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
    error: z.unknown().optional(),
  }),
});

/** A failed tool's `state.error` with its `message`; an error of any other shape is kept as JSON. */
const ToolError = z.object({ message: z.string() });

const TextPart = z.object({ text: z.string() });

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

function userContent(message: z.infer<typeof UserMessage>): ContentBlock[] {
  const content: ContentBlock[] = message.text ? [{ type: 'text', text: message.text }] : [];
  for (const file of message.files) {
    if (file.mime.startsWith('image/') && file.data) {
      content.push({ type: 'image', mimeType: file.mime, data: file.data, ...(file.name ? { label: file.name } : {}) });
    } else {
      content.push({ type: 'text', text: `[file: ${file.name ?? file.uri ?? file.mime}]` });
    }
  }
  return content;
}

function toolResultText(state: z.infer<typeof ToolPart>['state']): string {
  const text = state.content.map((c) => c.text ?? '').join('');
  if (text || state.error === undefined) return text;
  const error = ToolError.safeParse(state.error);
  return error.success ? error.data.message : JSON.stringify(state.error);
}

/**
 * An assistant message becomes IR turns: its text, reasoning and tool calls, then a user
 * message with the tool results, as Claude Code and Codex store them; text after a tool call
 * opens the next assistant turn.
 */
function assistantTurns(message: z.infer<typeof AssistantMessage>): Message[] {
  const timestamp = iso(message.time.created);
  const turns: Message[] = [];
  let assistant: ContentBlock[] = [];
  let results: ContentBlock[] = [];
  const flush = () => {
    if (assistant.length > 0) turns.push({ role: 'assistant', content: assistant, timestamp, messageId: message.id });
    if (results.length > 0) turns.push({ role: 'user', content: results, timestamp });
    assistant = [];
    results = [];
  };
  for (const part of message.content) {
    if (part.type === 'tool') {
      const tool = ToolPart.parse(part);
      assistant.push({
        type: 'tool_call',
        toolName: OPENCODE_TO_IR_TOOL[tool.name] ?? tool.name,
        callId: tool.id,
        arguments: tool.state.input,
      });
      results.push({
        type: 'tool_result',
        callId: tool.id,
        content: toolResultText(tool.state),
        isError: tool.state.status !== 'completed',
      });
      continue;
    }
    if (part.type !== 'text' && part.type !== 'reasoning') continue;
    if (results.length > 0) flush();
    const { text } = TextPart.parse(part);
    assistant.push(part.type === 'text' ? { type: 'text', text } : { type: 'thinking', text });
  }
  flush();
  return turns;
}

function sessionFromExport(stdout: string): Session {
  const exported = ExportedSession.parse(JSON.parse(stdout));
  const messages: Message[] = [];
  for (const message of exported.messages) {
    if (message.type === 'user') {
      const user = UserMessage.parse(message);
      messages.push({ role: 'user', content: userContent(user), timestamp: iso(user.time.created), messageId: user.id });
    } else if (message.type === 'assistant') {
      messages.push(...assistantTurns(AssistantMessage.parse(message)));
    }
  }
  const { info } = exported;
  return {
    sessionId: info.id,
    title: info.title,
    cwd: info.location.directory,
    platform: 'opencode',
    createdAt: iso(info.time.created),
    updatedAt: iso(info.time.updated),
    messages,
    metadata: info.model ? { model: info.model.id } : {},
  };
}

const IR_TO_OPENCODE_TOOL: Record<string, string> = Object.fromEntries(
  Object.entries(OPENCODE_TO_IR_TOOL)
    .filter(([opencode]) => opencode !== 'bash')
    .map(([opencode, ir]) => [ir, opencode]),
);

type ExportMessage = { type: 'user' | 'assistant'; created: number; fields: Record<string, unknown> };
type ToolPartState = { status: string; input: Record<string, unknown>; content: Array<{ type: 'text'; text: string }> } & Record<
  string,
  unknown
>;

const NO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

/**
 * The `opencode session import` file for `session`, in the shape `session export` prints.
 * Tool results, which arrive as user turns, go back into the tool part of the call they answer.
 * Times never go backwards, and every message gets a new id (`deriveOpencodeMessageIds`).
 * An assistant message needs `time.completed`: OpenCode 2.0.29 imports one without it, then
 * drops it without a word.
 */
function exportOf(session: Session, sessionId: string, directory: string): Record<string, unknown> {
  const tools = new Map<string, ToolPartState>();
  const answer = (block: Extract<ContentBlock, { type: 'tool_result' }>): boolean => {
    const state = tools.get(block.callId);
    if (!state) return false;
    const content = [{ type: 'text' as const, text: block.content }];
    if (block.isError) Object.assign(state, { status: 'error', content, error: { type: 'tool', message: block.content } });
    else Object.assign(state, { status: 'completed', content });
    return true;
  };

  let clock = Date.parse(session.createdAt) || 0;
  const start = clock;
  const messages: ExportMessage[] = [];
  for (const message of session.messages) {
    clock = Math.max(clock, Date.parse(message.timestamp ?? '') || 0);
    const created = clock;
    if (message.role === 'user') {
      const text: string[] = [];
      const files: Array<Record<string, unknown>> = [];
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          if (!answer(block)) text.push(`[tool_result] ${block.content}`);
        } else if (block.type === 'image' && block.data) {
          files.push({ mime: block.mimeType, data: block.data, source: { type: 'inline' }, ...(block.label ? { name: block.label } : {}) });
        } else {
          text.push(blockText(block));
        }
      }
      if (text.length === 0 && files.length === 0) continue;
      messages.push({ type: 'user', created, fields: { text: text.join('\n\n'), ...(files.length > 0 ? { files } : {}) } });
      continue;
    }
    const content: Array<Record<string, unknown>> = [];
    for (const block of message.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text });
      else if (block.type === 'thinking') content.push({ type: 'reasoning', text: block.text });
      else if (block.type === 'tool_call') {
        const state: ToolPartState = { status: 'completed', input: block.arguments, content: [] };
        tools.set(block.callId, state);
        content.push({ type: 'tool', id: block.callId, name: IR_TO_OPENCODE_TOOL[block.toolName] ?? block.toolName, state, time: { created } });
      } else if (block.type !== 'tool_result' || !answer(block)) content.push({ type: 'text', text: blockText(block) });
    }
    if (content.length === 0) continue;
    const model = { id: message.metadata?.model ?? session.metadata?.model ?? 'unknown', providerID: session.platform };
    messages.push({ type: 'assistant', created, fields: { agent: 'build', model, content } });
  }

  const ids = deriveOpencodeMessageIds(sessionId, messages.map((m) => m.created));
  return {
    info: {
      id: sessionId,
      title: session.title,
      // OpenCode works the project out from the directory on import.
      projectID: 'global',
      cost: 0,
      tokens: NO_TOKENS,
      time: { created: start, updated: clock },
      location: { directory },
    },
    messages: messages.map((m, i) => ({
      id: ids[i],
      type: m.type,
      time: m.type === 'assistant' ? { created: m.created, completed: m.created } : { created: m.created },
      ...m.fields,
    })),
  };
}

/** A block OpenCode has no part for in that message, as text. */
function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
    case 'thinking':
      return block.text;
    case 'image':
      return imagePlaceholderText(block);
    case 'tool_call':
      return `[tool_call] ${block.toolName} ${JSON.stringify(block.arguments)}`;
    case 'tool_result':
      return `[tool_result] ${block.content}`;
    default: {
      const unhandled: never = block;
      return unhandled;
    }
  }
}

export class OpencodeAdapter extends AgentAdapter {
  static readonly platform = 'opencode';

  get platform(): string {
    return 'opencode';
  }

  /** OpenCode's data directory: `$XDG_DATA_HOME/opencode`, `~/.local/share/opencode` by default. */
  static getDefaultStoragePath(): string {
    return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'opencode');
  }

  isReady(): boolean {
    return fs.existsSync(OpencodeAdapter.getDefaultStoragePath());
  }

  /** Run an `opencode session` command; throws `ToolUnavailableError` when no OpenCode 2 runs here. */
  private async session(args: string[], cwd?: string): Promise<ExecResult> {
    const version = await probeBinary('opencode');
    const major = /(\d+)\.\d+/.exec(version)?.[1];
    if (!major || Number(major) < 2) {
      throw new ToolUnavailableError(
        version
          ? `OpenCode ${version} has no \`opencode session export\`. Upgrade OpenCode to version 2 or later.`
          : 'The opencode CLI was not found on PATH. Install OpenCode 2 or later.',
      );
    }
    return execCommand('opencode', ['session', ...args, '--standalone'], { cwd });
  }

  /**
   * The sessions of the workspace `projectPath`, newest first. The CLI lists one project at a
   * time, so without `projectPath` this throws rather than return one project as if it were all.
   * Inside a git repo that project is the whole repo, so sessions of its other directories are
   * left out.
   */
  async listConversations(projectPath?: string): Promise<SessionMeta[]> {
    if (projectPath === undefined) {
      throw new Error('OpenCode lists one workspace at a time: name the workspace to list its sessions.');
    }
    if (!fs.existsSync(projectPath)) return [];
    const result = await this.session(['list', '--format', 'json', '--max-count', String(LIST_MAX)], projectPath);
    if (result.code !== 0) throw new Error(`opencode session list failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    const workspace = resolveRealCwd(projectPath);
    const inWorkspace = ListedSessions.parse(JSON.parse(result.stdout)).filter(
      (listed) => resolveRealCwd(listed.directory) === workspace,
    );
    return inWorkspace.map((listed) => ({
      sessionId: listed.id,
      title: listed.title,
      cwd: listed.directory,
      platform: 'opencode',
      createdAt: iso(listed.created),
      updatedAt: iso(listed.updated),
      // The listing carries no message count or size, so neither is reported; exporting each
      // session to count is too slow.
    }));
  }

  /** A session id names one OpenCode session in every project, so `projectPath` and `filePath` are not needed. */
  async readSession(ref: SessionReadRef): Promise<Session> {
    const result = await this.session(['export', ref.sessionId]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `opencode session export exited ${result.code}`);
    return sessionFromExport(result.stdout);
  }

  /**
   * The agents a session started. OpenCode 2 lists a session's children only through its server, so this starts one of
   * its own on a free local port with a one-time password, asks it for `GET /api/session?parentID=<id>` down the tree,
   * reads each child with `session export`, and stops it.
   */
  async readSubagents(session: Session, _ref: SessionReadRef): Promise<SubagentsRead> {
    const server = await startChildServer();
    if (typeof server === 'string') return { status: 'unread', reason: server };
    try {
      const agents: Subagent[] = [];
      const visit = async (parent: string, depth: number): Promise<void> => {
        for (const id of await server.children(parent)) {
          if (agents.some((agent) => agent.session.sessionId === id)) continue;
          agents.push({ session: await this.readSession({ sessionId: id }), depth });
          await visit(id, depth + 1);
        }
      };
      await visit(session.sessionId, 1);
      return { status: 'read', agents };
    } finally {
      await server.stop();
    }
  }

  async existingSessionId(sessionId: string, projectPath?: string): Promise<string | undefined> {
    if (!sessionId.startsWith('ses_')) return undefined;
    const result = await this.session(['export', sessionId]);
    if (result.code !== 0) {
      if (NOT_FOUND.test(result.stderr)) return undefined;
      // Neither absent nor present: the caller must not write, and must not report a copy either.
      throw new ToolUnavailableError(
        `opencode session export ${sessionId} failed, so whether that session exists is unknown: ` +
          `${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
    if (!projectPath) return sessionId;
    let directory: string;
    try {
      directory = ExportedSession.parse(JSON.parse(result.stdout)).info.location.directory;
    } catch {
      return sessionId;
    }
    return resolveRealCwd(directory) === resolveRealCwd(projectPath) ? sessionId : undefined;
  }

  /**
   * Import the session into `projectPath` with `opencode session import`, under the id
   * `deriveTargetSessionId` gives it. The caller checks first that no copy exists.
   */
  async writeSession(session: Session, projectPath?: string): Promise<string> {
    const cwd = projectPath ?? session.cwd;
    const sessionId = deriveTargetSessionId({
      targetPlatform: this.platform,
      targetCwd: cwd,
      sourceSessionId: session.sessionId,
      sourceCreatedAt: session.createdAt,
    });
    if (!fs.existsSync(cwd)) {
      throw new Error(`OpenCode imports a session only into a directory that exists, and ${cwd} does not. Create it first.`);
    }
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'teamai-opencode-'));
    try {
      const file = path.join(dir, `${sessionId}.json`);
      // The real path, the one OpenCode records for a session started in that directory.
      fs.writeFileSync(file, JSON.stringify(exportOf(session, sessionId, resolveRealCwd(cwd))));
      const result = await this.session(['import', file, '--directory', resolveRealCwd(cwd)]);
      if (result.code !== 0) throw new Error(`opencode session import failed: ${result.stderr.trim() || `exit ${result.code}`}`);
      if (result.stdout.includes(`Imported session: ${sessionId}`)) return sessionId;
      // OpenCode reports an id it already has on stderr and exits 0. The caller looked a moment
      // ago, so another run just imported this same copy.
      if (ALREADY_EXISTS.test(result.stderr)) return sessionId;
      throw new Error(`opencode session import did not import ${sessionId}: ${result.stderr.trim() || result.stdout.trim()}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async deleteSession(sessionId: string, projectPath?: string): Promise<boolean> {
    if (!(await this.existingSessionId(sessionId, projectPath))) return false;
    const result = await this.session(['delete', sessionId]);
    if (result.code === 0) return true;
    if (NOT_FOUND.test(result.stderr)) return false;
    throw new Error(`opencode session delete ${sessionId} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
}
