/**
 * adapters/agy.ts — Antigravity CLI (agy) platform adapter, read-only.
 *
 * agy 1.4.8 keeps its conversations in `~/.gemini/antigravity-cli`, and the Antigravity app (2.24) its own in
 * `~/.gemini/antigravity`, each store laid out the same way:
 *   - `brain/<conversationId>/.system_generated/logs/transcript.jsonl`: one step per line, with
 *     `step_index`, `source`, `type`, `status`, `created_at`, `content`, and on a MODEL
 *     PLANNER_RESPONSE `tool_calls` (`{name, args}`, each arg value JSON-encoded) and token counts.
 *     A tool's result is the next MODEL step that is not a PLANNER_RESPONSE.
 *   - `conversation_summaries.db` (SQLite): the title, last change and workspace of each
 *     conversation. The transcript records no workspace, so it is read from here, with the
 *     sqlite3 CLI and read-only.
 *   - `conversations/<id>.db`: the state agy resumes from, which TeamAI cannot write. So TeamAI
 *     never writes or deletes an agy session (`noAdapter` refuses it as a target).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AgentAdapter, ToolUnavailableError, type SessionMeta, type SessionReadRef } from './base.js';
import type { ContentBlock, Message, Session } from '../ir.js';
import { dirExists, readJsonl, readJsonlHead, resolveRealCwd } from '../fs.js';
import { fallbackTitle } from '../title.js';
import { isSafeSessionFileId } from '../ids.js';
import { findSqlite3 } from '../sqlite.js';
import { execCommand, type ExecResult } from '../../utils/exec.js';
import { log } from '../../utils/logger.js';

const SummaryRow = z.object({
  conversation_id: z.string(),
  title: z.string(),
  last_modified_time: z.string(),
  workspace_uris: z.string(),
});
type SummaryRow = z.infer<typeof SummaryRow>;

/** `workspace_uris` as agy stores it: a JSON array of URIs. */
const WorkspaceUris = z.string().transform((text, ctx) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not JSON' });
    return z.NEVER;
  }
}).pipe(z.array(z.string()));

const StepTime = z.object({ created_at: z.string() });

/** `2026-10-28 23:53:38.208141+00:00`, as agy stores a time, in ISO 8601, or undefined when it is not a time. */
function isoOf(stored: string): string | undefined {
  const at = new Date(stored.replace(' ', 'T'));
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** The first workspace a conversation names, as a path, or '' when it names none TeamAI can read. */
function workspaceOf(row: SummaryRow): string {
  const uris = WorkspaceUris.safeParse(row.workspace_uris);
  const [uri] = uris.success ? uris.data : [];
  return uri?.startsWith('file:') ? fileURLToPath(uri) : '';
}

/**
 * The stores of `cliStore` (`sessionStoreDir('agy')`, `~/.gemini/antigravity-cli`) and of the Antigravity app beside
 * it. Antigravity IDE keeps no summaries database, so its conversations have no workspace TeamAI can read.
 */
export function agyStoreRoots(cliStore: string): string[] {
  return [cliStore, path.join(path.dirname(cliStore), 'antigravity')];
}

export class AgyAdapter extends AgentAdapter {
  static readonly platform = 'agy';

  /** @param storeRoots the stores to read, as `agyStoreRoots` names them. */
  constructor(private readonly storeRoots: readonly string[]) {
    super();
  }

  get platform(): string {
    return 'agy';
  }

  isReady(): boolean {
    return this.storeRoots.some((root) => dirExists(path.join(root, 'brain')));
  }

  private transcriptOf(root: string, sessionId: string): string {
    return path.join(root, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
  }

  /** The summary rows in `root` of the conversations `sessionId` names, or of all of them, newest first. */
  private async summaries(root: string, sessionId?: string): Promise<SummaryRow[]> {
    const db = path.join(root, 'conversation_summaries.db');
    const sqlite3 = findSqlite3();
    if (!sqlite3) {
      throw new ToolUnavailableError(
        `The sqlite3 CLI was not found, so TeamAI cannot read the workspace and title of agy conversations from ${db}. ` +
          'Install sqlite3 and run the command again.',
      );
    }
    if (!fs.existsSync(db)) return [];
    // A safe id is a single path segment of letters, digits, `-` and `_`, so it cannot break out of the quotes.
    if (sessionId !== undefined && !isSafeSessionFileId(sessionId)) return [];
    const where = sessionId === undefined ? '' : ` WHERE conversation_id = '${sessionId}'`;
    const sql = `SELECT conversation_id, title, last_modified_time, workspace_uris FROM conversation_summaries${where} ORDER BY last_modified_time DESC;`;
    // agy keeps the database in WAL mode, which sqlite3 cannot open read-only once agy has closed it and removed its
    // -shm file. A copy, with the -wal that holds what agy has not checkpointed yet, reads without writing beside agy's.
    const copy = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'teamai-agy-summaries-'));
    let result: ExecResult;
    try {
      const copied = path.join(copy, 'conversation_summaries.db');
      await fs.promises.copyFile(db, copied);
      await fs.promises.copyFile(`${db}-wal`, `${copied}-wal`).catch((error: unknown) => {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      });
      result = await execCommand(sqlite3, ['-json', copied, sql], { timeoutMs: 30_000 });
    } finally {
      await fs.promises.rm(copy, { recursive: true, force: true });
    }
    if (result.code !== 0) throw new Error(`sqlite3 could not read ${db}: ${result.stderr.trim() || `exit ${result.code}`}`);
    if (!result.stdout.trim()) return [];
    // A row of another shape is left out, so the rest still list.
    return z.array(z.unknown()).parse(JSON.parse(result.stdout)).flatMap((raw) => {
      const row = SummaryRow.safeParse(raw);
      return row.success ? [row.data] : [];
    });
  }

  async listConversations(projectPath?: string): Promise<SessionMeta[]> {
    const workspace = projectPath === undefined ? undefined : resolveRealCwd(projectPath);
    const metas: SessionMeta[] = [];
    const stored = await Promise.all(this.storeRoots.map(async (root, index) => {
      // The app's store, unlike the CLI's, is left out when it cannot be read, so the CLI's conversations still list.
      const rows = index === 0 ? await this.summaries(root) : await this.summaries(root).catch((error: unknown) => {
        if (error instanceof ToolUnavailableError) throw error;
        log.debug(`session: could not read the Antigravity conversations in ${root}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      });
      return rows.map((row) => ({ root, row }));
    }));
    for (const { root, row } of stored.flat()) {
      if (!isSafeSessionFileId(row.conversation_id)) continue;
      const cwd = workspaceOf(row);
      if (workspace !== undefined && (!cwd || resolveRealCwd(cwd) !== workspace)) continue;
      const filePath = this.transcriptOf(root, row.conversation_id);
      let sizeBytes: number;
      try {
        sizeBytes = fs.statSync(filePath).size;
      } catch {
        continue;
      }
      const updatedAt = isoOf(row.last_modified_time) ?? fs.statSync(filePath).mtime.toISOString();
      const [first] = [...readJsonlHead(filePath, 1)];
      const started = StepTime.safeParse(first);
      metas.push({
        sessionId: row.conversation_id,
        title: row.title || fallbackTitle(row.conversation_id),
        cwd,
        platform: 'agy',
        createdAt: (started.success ? isoOf(started.data.created_at) : undefined) ?? updatedAt,
        updatedAt,
        filePath,
        sizeBytes,
      });
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** The summary of `sessionId` and its transcript, from the first store that has both, in `projectPath` when one is given. */
  private async summaryOf(sessionId: string, projectPath?: string): Promise<{ row: SummaryRow; transcript: string } | undefined> {
    if (!isSafeSessionFileId(sessionId)) return undefined;
    const root = this.storeRoots.find((store) => fs.existsSync(this.transcriptOf(store, sessionId)));
    if (root === undefined) return undefined;
    const [row] = await this.summaries(root, sessionId);
    if (!row) return undefined;
    const found = { row, transcript: this.transcriptOf(root, sessionId) };
    if (projectPath === undefined) return found;
    const cwd = workspaceOf(row);
    return cwd && resolveRealCwd(cwd) === resolveRealCwd(projectPath) ? found : undefined;
  }

  async readSession(ref: SessionReadRef): Promise<Session> {
    const found = await this.summaryOf(ref.sessionId, ref.projectPath);
    if (!found) throw new Error(`No agy conversation ${ref.sessionId}${ref.projectPath ? ` in ${ref.projectPath}` : ''}.`);
    const { row } = found;
    const transcript = ref.filePath ?? found.transcript;
    const messages = messagesOf(readJsonl(transcript));
    const updatedAt = isoOf(row.last_modified_time) ?? fs.statSync(transcript).mtime.toISOString();
    return {
      sessionId: row.conversation_id,
      title: row.title || fallbackTitle(row.conversation_id),
      cwd: workspaceOf(row),
      platform: 'agy',
      createdAt: messages[0]?.timestamp ?? updatedAt,
      updatedAt,
      messages,
    };
  }

  async existingSessionId(sessionId: string, projectPath?: string): Promise<string | undefined> {
    return (await this.summaryOf(sessionId, projectPath))?.row.conversation_id;
  }

  async writeSession(_session: Session, _projectPath?: string): Promise<string> {
    throw new Error(READ_ONLY);
  }

  /** TeamAI never wrote an agy conversation, so there is none of its own to delete. */
  async deleteSession(_sessionId: string, _projectPath?: string): Promise<boolean> {
    return false;
  }
}

/** `noAdapter` refuses agy as a target first (its facts say `readOnly`); this guards a direct call. */
const READ_ONLY = 'TeamAI cannot write agy sessions: agy resumes a conversation only from its own conversations/<id>.db.';

/** agy's tool names, as the IR names the same tool. */
const IR_TOOL: Readonly<Record<string, string>> = {
  run_command: 'bash',
  view_file: 'read_file',
  read_file: 'read_file',
  write_to_file: 'write_file',
  replace_file_content: 'edit_file',
  multi_replace_file_content: 'edit_file',
  grep_search: 'grep',
  find_by_name: 'glob',
  search_web: 'web_search',
  read_url_content: 'web_fetch',
  invoke_subagent: 'task',
};

const Step = z.object({
  step_index: z.union([z.string(), z.number()]).transform(String),
  source: z.string().optional(),
  type: z.string(),
  status: z.string().optional(),
  created_at: z.string().optional(),
  content: z.string().optional(),
  thinking: z.string().optional(),
  error: z.string().optional(),
  tool_calls: z.array(z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).optional() })).optional(),
});

/** An argument as agy stored it, JSON-encoded, decoded; a value that is not JSON is kept as it is. */
function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** What the member typed: agy wraps it in `<USER_REQUEST>`, followed by metadata of its own. */
function requestOf(content: string): string {
  return /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content)?.[1] ?? content;
}

/**
 * The IR messages of an agy transcript. A model step after a PLANNER_RESPONSE with tool calls is
 * the next call's result, ERROR when the tool failed or a hook denied it.
 */
function messagesOf(lines: Iterable<Record<string, unknown>>): Message[] {
  const messages: Message[] = [];
  const pending: string[] = [];
  for (const line of lines) {
    const parsed = Step.safeParse(line);
    if (!parsed.success) continue;
    const step = parsed.data;
    const timestamp = step.created_at === undefined ? {} : { timestamp: step.created_at };
    if (step.type === 'USER_INPUT') {
      messages.push({ role: 'user', content: [{ type: 'text', text: requestOf(step.content ?? '') }], ...timestamp });
    } else if (step.type === 'SYSTEM_MESSAGE') {
      messages.push({ role: 'user', content: [{ type: 'text', text: step.content ?? '' }], ...timestamp, metadata: { isMeta: true } });
    } else if (step.type === 'PLANNER_RESPONSE') {
      const content: ContentBlock[] = [];
      if (step.thinking) content.push({ type: 'thinking', text: step.thinking });
      if (step.content) content.push({ type: 'text', text: step.content });
      (step.tool_calls ?? []).forEach((call, i) => {
        const callId = `${step.step_index}-${i}`;
        pending.push(callId);
        const args = Object.fromEntries(Object.entries(call.args ?? {}).map(([key, value]) => [key, decoded(value)]));
        content.push({ type: 'tool_call', toolName: IR_TOOL[call.name] ?? call.name, callId, arguments: args });
      });
      if (content.length > 0) messages.push({ role: 'assistant', content, ...timestamp });
    } else if (step.source === 'MODEL' && pending.length > 0) {
      const callId = pending.shift() ?? '';
      const isError = step.status === 'ERROR';
      const text = isError && step.error ? step.error : step.content ?? '';
      messages.push({ role: 'user', content: [{ type: 'tool_result', callId, content: text, isError }], ...timestamp });
    }
  }
  return messages;
}
