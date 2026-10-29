/**
 * adapters/agy.ts — Antigravity CLI (agy) platform adapter, read-only.
 *
 * agy 1.4.8 keeps its conversations in `~/.gemini/antigravity-cli` (the store root):
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
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AgentAdapter, ToolUnavailableError, type SessionMeta, type SessionReadRef } from './base.js';
import type { ContentBlock, Message, Session } from '../ir.js';
import { dirExists, readJsonl, readJsonlHead, resolveRealCwd } from '../fs.js';
import { fallbackTitle } from '../title.js';
import { isSafeSessionFileId } from '../ids.js';
import { findSqlite3 } from '../sqlite.js';
import { execCommand } from '../../utils/exec.js';

const SummaryRows = z.array(
  z.object({
    conversation_id: z.string(),
    title: z.string(),
    last_modified_time: z.string(),
    workspace_uris: z.string(),
  }),
);
type SummaryRow = z.infer<typeof SummaryRows>[number];

const WorkspaceUris = z.array(z.string());

const StepTime = z.object({ created_at: z.string() });

/** `2026-10-28 23:53:38.208141+00:00`, as agy stores a time, in ISO 8601. */
function isoOf(stored: string): string {
  const at = new Date(stored.replace(' ', 'T'));
  if (Number.isNaN(at.getTime())) throw new Error(`agy recorded a time TeamAI cannot read: ${stored}`);
  return at.toISOString();
}

/** The first workspace a conversation names, as a path, or '' when it names none. */
function workspaceOf(row: SummaryRow): string {
  const [uri] = WorkspaceUris.parse(JSON.parse(row.workspace_uris));
  return uri?.startsWith('file:') ? fileURLToPath(uri) : '';
}

export class AgyAdapter extends AgentAdapter {
  static readonly platform = 'agy';

  /** @param storeRoot agy's data directory (`sessionStoreDir`): `~/.gemini/antigravity-cli`. */
  constructor(private readonly storeRoot: string) {
    super();
  }

  get platform(): string {
    return 'agy';
  }

  isReady(): boolean {
    return dirExists(path.join(this.storeRoot, 'brain'));
  }

  private transcriptOf(sessionId: string): string {
    return path.join(this.storeRoot, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
  }

  /** The summary rows of the conversations `sessionId` names, or of all of them, newest first. */
  private async summaries(sessionId?: string): Promise<SummaryRow[]> {
    const db = path.join(this.storeRoot, 'conversation_summaries.db');
    const sqlite3 = findSqlite3();
    if (!sqlite3) {
      throw new ToolUnavailableError(
        `The sqlite3 CLI was not found, so TeamAI cannot read the workspace and title of agy conversations from ${db}. ` +
          'Install sqlite3 and run the command again.',
      );
    }
    if (!fs.existsSync(db)) return [];
    // The id is a single path segment of letters, digits, `-` and `_`, so it cannot break out of the quotes.
    const where = sessionId === undefined ? '' : ` WHERE conversation_id = '${sessionId}'`;
    const sql = `SELECT conversation_id, title, last_modified_time, workspace_uris FROM conversation_summaries${where} ORDER BY last_modified_time DESC;`;
    const result = await execCommand(sqlite3, ['-readonly', '-json', db, sql], { timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error(`sqlite3 could not read ${db}: ${result.stderr.trim() || `exit ${result.code}`}`);
    return result.stdout.trim() ? SummaryRows.parse(JSON.parse(result.stdout)) : [];
  }

  async listConversations(projectPath?: string): Promise<SessionMeta[]> {
    const workspace = projectPath === undefined ? undefined : resolveRealCwd(projectPath);
    const metas: SessionMeta[] = [];
    for (const row of await this.summaries()) {
      if (!isSafeSessionFileId(row.conversation_id)) continue;
      const cwd = workspaceOf(row);
      if (workspace !== undefined && (!cwd || resolveRealCwd(cwd) !== workspace)) continue;
      const filePath = this.transcriptOf(row.conversation_id);
      let sizeBytes: number;
      try {
        sizeBytes = fs.statSync(filePath).size;
      } catch {
        continue;
      }
      const updatedAt = isoOf(row.last_modified_time);
      const [first] = [...readJsonlHead(filePath, 1)];
      const started = StepTime.safeParse(first);
      metas.push({
        sessionId: row.conversation_id,
        title: row.title || fallbackTitle(row.conversation_id),
        cwd,
        platform: 'agy',
        createdAt: started.success ? isoOf(started.data.created_at) : updatedAt,
        updatedAt,
        filePath,
        sizeBytes,
      });
    }
    return metas;
  }

  /** The summary of `sessionId` when its transcript is here, and in `projectPath` when one is given. */
  private async summaryOf(sessionId: string, projectPath?: string): Promise<SummaryRow | undefined> {
    if (!isSafeSessionFileId(sessionId) || !fs.existsSync(this.transcriptOf(sessionId))) return undefined;
    const [row] = await this.summaries(sessionId);
    if (!row) return undefined;
    if (projectPath === undefined) return row;
    const cwd = workspaceOf(row);
    return cwd && resolveRealCwd(cwd) === resolveRealCwd(projectPath) ? row : undefined;
  }

  async readSession(ref: SessionReadRef): Promise<Session> {
    const row = await this.summaryOf(ref.sessionId, ref.projectPath);
    if (!row) throw new Error(`No agy conversation ${ref.sessionId}${ref.projectPath ? ` in ${ref.projectPath}` : ''}.`);
    const messages = messagesOf(readJsonl(ref.filePath ?? this.transcriptOf(row.conversation_id)));
    const updatedAt = isoOf(row.last_modified_time);
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
    return (await this.summaryOf(sessionId, projectPath))?.conversation_id;
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
