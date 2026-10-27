/**
 * adapters/codex.ts — Codex (OpenAI Codex CLI) adapter.
 *
 * Reads and writes `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid-v7>.jsonl`.
 *
 * JSONL line types (5 top-level types):
 *   - session_meta: session metadata (first line)
 *   - response_item: core message carrier (message / function_call / function_call_output / reasoning)
 *   - event_msg: event log (task_started / task_complete / user_message / agent_message / token_count)
 *   - turn_context: turn context (cwd / sandbox_policy / model)
 *
 * Enhancements (vs the Python version):
 * - Write a turn_context line
 * - Write event_msg:task_started + task_complete
 * - Write reasoning blocks as response_item:reasoning (instead of skipping them)
 * - Support custom_tool_call / custom_tool_call_output
 *
 * The written rollout must be directly indexable by Codex, or the session never
 * appears in the Codex Desktop history list:
 * - session_meta.payload.model_provider: Codex buckets the list by provider;
 *   only sessions matching ~/.codex/config.toml's model_provider are shown (see
 *   https://github.com/farion1231/cc-switch/issues/4710). Missing/wrong -> silently hidden.
 * - No history_mode: Codex 0.155+ treats it as legacy and `codex
 *   migrate-rollouts --apply` converts it to paginated history plus the items
 *   projection; claiming 'paginated' marks it already-migrated -> no
 *   projection -> no preview, blank body.
 * - A top-level ordinal per line: the pagination cursor depends on it; without
 *   it thread/items/list returns empty.
 * - At least one event_msg:item_completed UserMessage: title and list preview
 *   come from the first user item; injected metadata blocks
 *   (<user_info>/<user_query> timestamp headers etc.) are dropped wholesale,
 *   which would leave no title/preview -> invisible.
 * - After writing, run the codex CLI to build the projection (paginateRollout)
 *   so the session is visible immediately.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { z } from 'zod';
import { AgentAdapter, type SessionMeta, type SessionReadRef, type Subagent, type SubagentsRead } from './base.js';
import type { Session, Message, ContentBlock, ThinkingBlock, ToolCallBlock, ToolResultBlock } from '../ir.js';
import { imagePlaceholderText } from '../ir.js';
import { typedTitle, visibleUserText } from '../title.js';
import { assertSafeSessionFileId, deriveTargetSessionId } from '../ids.js';
import { findSqlite3 } from '../sqlite.js';
import { log } from '../../utils/logger.js';
import { execCommand, probeBinary } from '../../utils/exec.js';
import { isOnPath } from '../../utils/lookpath.js';
import { desktopCodexBinaries } from '../../codex-desktop.js';
import {
  resolveRealCwd,
  readJsonl,
  readJsonlHead,
  writeJsonl,
  fileExists,
  dirExists,
  scanFiles,
} from '../fs.js';
import { sessionStoreDir } from '../../locate.js';

// ---------------------------------------------------------------------------
// Tool-name normalization map
// ---------------------------------------------------------------------------

const CODEX_TO_IR_TOOL: Record<string, string> = {
  exec_command: 'bash',
  apply_patch: 'edit_file',
  read_file: 'read_file',
  write_file: 'write_file',
};

const IR_TO_CODEX_TOOL: Record<string, string> = Object.fromEntries(
  Object.entries(CODEX_TO_IR_TOOL).map(([k, v]) => [v, k]),
);

function normalizeToolName(codexName: string): string {
  return CODEX_TO_IR_TOOL[codexName] ?? codexName;
}

function denormalizeToolName(irName: string): string {
  return IR_TO_CODEX_TOOL[irName] ?? irName;
}

// ---------------------------------------------------------------------------
// UUIDv7 generation
// ---------------------------------------------------------------------------

function generateUuidV7(): string {
  const timestampMs = Date.now();
  // 48-bit timestamp shifted left by 80 bits.
  // Must use BigInt bitwise AND (0xffffffffffffn): Number's `&` is a 32-bit
  // signed op, timestamps above 2^31 go negative, the subsequent BigInt turns
  // negative and toString(16) emits a negative hex -- an invalid UUID that
  // fails Codex's Uuid deserialization and hides the whole session.
  let uuidInt = (BigInt(timestampMs) & 0xffffffffffffn) << 80n;
  // version bits 7 (bits 76-79)
  uuidInt |= 7n << 76n;
  // random bits (low 62)
  const randBytes = crypto.randomBytes(8);
  let rand = 0n;
  for (let i = 0; i < 8; i++) {
    rand = (rand << 8n) | BigInt(randBytes[i]);
  }
  rand &= (1n << 62n) - 1n;
  uuidInt |= rand;
  // variant bits (62-63 = 10)
  uuidInt = (uuidInt & ~(0x3n << 62n)) | (0x2n << 62n);

  // format as a UUID string
  const hex = uuidInt.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function isUuidV7(sid: string): boolean {
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return re.test(sid);
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

function parseCodexTimestamp(ts: unknown): string {
  if (typeof ts === 'number') {
    return new Date(ts).toISOString();
  }
  if (typeof ts === 'string') {
    try {
      return new Date(ts).toISOString();
    } catch {
      return new Date().toISOString();
    }
  }
  return new Date().toISOString();
}

function formatFilenameTimestamp(isoStr: string): string {
  // 2026-07-09T00-00-00 (: → -)
  return isoStr.replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
}

// ---------------------------------------------------------------------------
// Codex config detection / metadata cleanup / CLI detection
// ---------------------------------------------------------------------------

/**
 * Read the effective model_provider (top-level `model_provider = "..."` in config.toml).
 *
 * Codex Desktop buckets the session list by provider: only sessions matching
 * the current config are shown -- that is why sessions "disappear" after
 * switching providers. Migrated rollouts must carry the current value.
 */
function readCodexModelProvider(configPath: string): string {
  try {
    if (!fileExists(configPath)) return 'openai';
    const raw = fs.readFileSync(configPath, 'utf-8');
    const m = raw.match(/^[ \t]*model_provider[ \t]*=[ \t]*["']([^"']+)["']/m);
    return m?.[1]?.trim() || 'openai';
  } catch {
    return 'openai';
  }
}

/**
 * Whether the text is worth emitting as a ThreadItem.
 * Source platforms serialize horizontal rules, fences, and empty list items as standalone text blocks ("-" / "---" / "*" / "```" and similar).
 * Rendered as messages they become empty bullets. Skip these pure markdown-decoration blocks and do not emit an item
 * (the response_item still keeps the original text, so fidelity is unaffected).
 */
function isRenderableText(text: string): boolean {
  return /[^\s\-*•·>#`|~_+=()[\]!.,;:?"'\\/0-9—–‘’“”…]/.test(text);
}

interface ItemCompletedArgs {
  timestamp: string;
  sessionId: string;
  turnId: string;
  itemId: string;
  itemType: 'UserMessage' | 'AgentMessage';
  text: string;
}

/**
 * event_msg:item_completed — the ThreadItem that Codex Desktop actually renders (and uses for the title/preview).
 * UserMessage and AgentMessage disagree on content-type casing (text / Text); copy the native format.
 * Aligned with the 0.155 native format:
 * - payload must include started_at_ms / completed_at_ms (missing them fails deserialization and the item is dropped)
 * - UserMessage items do not write client_id (native has no such field; writing it makes UserMessage fail to parse,
 *   which shows up as an empty thread/items/list projection and a blank session after it opens)
 */
function buildItemCompletedRecord(args: ItemCompletedArgs): Record<string, unknown> {
  const isUser = args.itemType === 'UserMessage';
  const item: Record<string, unknown> = {
    type: args.itemType,
    id: args.itemId,
    content: isUser
      ? [{ type: 'text', text: args.text, text_elements: [] }]
      : [{ type: 'Text', text: args.text }],
  };
  const ms = new Date(args.timestamp).getTime();
  return {
    timestamp: args.timestamp,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: args.sessionId,
      turn_id: args.turnId,
      item,
      started_at_ms: ms,
      completed_at_ms: ms,
    },
  };
}

function pushItemCompleted(records: Record<string, unknown>[], args: ItemCompletedArgs): void {
  records.push(buildItemCompletedRecord(args));
}

/**
 * The codex CLI that runs: `codex` on PATH (npm / brew install), else the one bundled with
 * Codex Desktop. Probed and later started through cross-spawn, which resolves the npm
 * `codex.cmd` shim on Windows that a plain PATH join and `spawn` miss.
 */
async function findCodexCli(): Promise<string | null> {
  for (const candidate of ['codex', ...desktopCodexBinaries()]) {
    if (await probeBinary(candidate)) return candidate;
  }
  return null;
}

const ChildRolloutMetaSchema = z.object({
  type: z.literal('session_meta'),
  payload: z.object({
    id: z.string().min(1),
    timestamp: z.string().optional(),
    cwd: z.string().optional(),
    source: z.object({ subagent: z.object({ thread_spawn: z.object({ parent_thread_id: z.string().min(1) }) }) }),
    subagent_history_start_ordinal: z.number().int().optional(),
  }),
});
type ChildRollout = { file: string; meta: z.infer<typeof ChildRolloutMetaSchema>['payload'] };

// ---------------------------------------------------------------------------
// CodexAdapter
// ---------------------------------------------------------------------------

export class CodexAdapter extends AgentAdapter {
  readonly platform: string;
  private readonly storageRoot: string;

  /**
   * @param platform Platform id (default 'codex'; variants may pass 'codex-internal' / 'tcodex')
   * @param storageRoot Storage root (default ~/.codex/sessions; variants pass ~/.codex-internal/sessions and similar)
   */
  constructor(platform = 'codex', storageRoot?: string) {
    super();
    this.platform = platform;
    this.storageRoot = storageRoot ?? sessionStoreDir('codex', undefined);
  }

  /**
   * Codex creates `sessions/` on its first session, so an installed Codex that
   * has not run one yet only has its root (or just the CLI); writeSession
   * creates the dated directory itself.
   */
  isReady(): boolean {
    return dirExists(path.dirname(this.storageRoot)) || (this.platform === 'codex' && isOnPath('codex'));
  }

  private scanJsonlFiles(): string[] {
    return scanFiles(this.storageRoot, /\.jsonl$/);
  }

  /** Every rollout, active then archived: Codex moves an archived thread's rollout to `archived_sessions/`. */
  private scanAllRollouts(): string[] {
    return [...this.scanJsonlFiles(), ...scanFiles(path.join(path.dirname(this.storageRoot), 'archived_sessions'), /\.jsonl$/)];
  }

  /** The rollout to read or delete, archived ones included, so it agrees with `existingSessionId`. */
  private findSessionFile(sessionId: string, projectPath?: string): string | null {
    for (const f of this.scanAllRollouts()) {
      // The filename is rollout-<timestamp>-<sessionId>, matched as an infix; but the prefix is only accepted at 8+ characters,
      // otherwise a 4-character prefix substring would read someone else's session
      const base = path.basename(f, '.jsonl');
      if (!(base === sessionId || (sessionId.length >= 8 && base.endsWith(sessionId)))) continue;
      // rollback --cwd: only the copy that belongs to this project. Without
      // this, deleting one session id would remove every workspace's copy.
      if (projectPath && !this.rolloutMatchesCwd(f, projectPath)) continue;
      return f;
    }
    return null;
  }

  /** The first-line session_meta of a rollout carries the real cwd; use it for --cwd scope filtering. */
  private rolloutMatchesCwd(file: string, projectPath: string): boolean {
    try {
      const rec = this.readFirstLine(file);
      const payload = (rec?.payload ?? {}) as Record<string, unknown>;
      const cwd = String(payload.cwd ?? '');
      // Compare resolved paths: listing resolves the cwd the same way, so a
      // bare string compare made `/tmp/x` and `/private/tmp/x` two different
      // workspaces -- `rollback --cwd /tmp/x` then reported "not found" and
      // deleted nothing.
      return cwd === projectPath || resolveRealCwd(cwd) === resolveRealCwd(projectPath);
    } catch {
      return false;
    }
  }

  private readFirstLine(filePath: string): Record<string, unknown> | null {
    try {
      for (const record of readJsonlHead(filePath, 1)) {
        return record;
      }
    } catch {
      // ignore
    }
    return null;
  }

  private extractTitle(filePath: string): string {
    const name = path.basename(filePath, '.jsonl');
    // rollout-2026-06-09T15-01-17-<uuid>
    const parts = name.split('-', 1);
    if (parts.length === 1 && name.startsWith('rollout-')) {
      const tsUuid = name.slice('rollout-'.length);
      const idx = tsUuid.lastIndexOf('-');
      if (idx > 0) {
        const tsPart = tsUuid.slice(0, idx);
        if (tsPart) return `Session ${tsPart}`;
      }
    }
    return name;
  }

  async listConversations(projectPath?: string, { archived = false }: { archived?: boolean } = {}): Promise<SessionMeta[]> {
    const metas: SessionMeta[] = [];

    for (const f of archived ? this.scanAllRollouts() : this.scanJsonlFiles()) {
      const first = this.readFirstLine(f);
      if (!first || first.type !== 'session_meta') continue;

      const payload = (first.payload as Record<string, unknown>) ?? {};
      const sessionId = String(payload.id ?? '');
      const cwd = String(payload.cwd ?? '');
      const tsRaw = payload.timestamp;

      if (projectPath) {
        // An exact string compare is not enough: on macOS /tmp and /private/tmp are two spellings of the same directory
        // (a symlink). A spelling mismatch between write and list makes the session "list as empty".
        // Match encodeCwd*/hashWorkspace: realpath first, then compare.
        if (resolveRealCwd(cwd) !== resolveRealCwd(projectPath)) continue;
      }

      const createdAt = parseCodexTimestamp(tsRaw);
      let updatedAt = createdAt;
      try {
        updatedAt = new Date(fs.statSync(f).mtimeMs).toISOString();
      } catch {
        // ignore
      }

      const title = this.extractTitle(f);
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(f).size;
      } catch {
        // ignore
      }

      // One bounded scan: count messages and extract the content title.
      // Title = first real user text (item_completed UserMessage, or response_item
      // user message for legacy rollouts without it). Previously only the
      // filename fallback produces an unreadable wall of "Session <timestamp>".
      let messageCount = 0;
      let contentTitle = '';
      try {
        for (const rec of readJsonlHead(f, 200)) {
          const recPayload = (rec.payload as Record<string, unknown>) ?? {};
          if (rec.type === 'response_item' && recPayload.type === 'message') messageCount++;

          if (contentTitle) continue;
          let text = '';
          if (rec.type === 'event_msg' && recPayload.type === 'item_completed') {
            const item = recPayload.item as Record<string, unknown> | undefined;
            if (item?.type !== 'UserMessage') continue;
            const content = item.content as Array<Record<string, unknown>> | undefined;
            text = (content ?? []).map((c) => String(c.text ?? '')).join(' ');
          } else if (rec.type === 'response_item' && recPayload.type === 'message' && recPayload.role === 'user') {
            const content = recPayload.content as Array<Record<string, unknown>> | undefined;
            text = (content ?? []).map((c) => String(c.text ?? '')).join(' ');
          }
          if (!text) continue;
          const cleaned = typedTitle(text);
          if (cleaned) contentTitle = cleaned;
        }
      } catch {
        // ignore
      }
      const resolvedTitle = contentTitle || title;

      metas.push({
        sessionId,
        title: resolvedTitle,
        cwd,
        platform: this.platform,
        createdAt,
        updatedAt,
        messageCount,
        filePath: f,
        sizeBytes,
      });
    }
    return metas;
  }

  async readSession(ref: SessionReadRef): Promise<Session> {
    const f = ref.filePath ?? this.findSessionFile(ref.sessionId, ref.projectPath);
    if (!f) {
      const where = ref.projectPath ? ` in ${ref.projectPath}` : '';
      throw new Error(`Codex session not found: ${ref.sessionId}${where}`);
    }

    const records = [...readJsonl(f)];

    // A suffix of the id finds the session, so the id comes from the rollout opened.
    let sessionId = path.basename(f, '.jsonl');
    let cwd = '';
    let createdAt = new Date().toISOString();
    const sessionMetadata: Record<string, unknown> = {};

    for (const rec of records) {
      if (rec.type === 'session_meta') {
        const payload = (rec.payload as Record<string, unknown>) ?? {};
        if (typeof payload.id === 'string' && payload.id) sessionId = payload.id;
        cwd = String(payload.cwd ?? '');
        createdAt = parseCodexTimestamp(payload.timestamp);
        for (const key of ['originator', 'cli_version', 'source', 'model_provider'] as const) {
          if (payload[key] !== undefined) sessionMetadata[key] = payload[key];
        }
        break;
      }
    }

    const messages = this.buildMessages(records);

    let updatedAt = createdAt;
    if (messages.length > 0 && messages[messages.length - 1].timestamp) {
      updatedAt = messages[messages.length - 1].timestamp!;
    } else {
      try {
        updatedAt = new Date(fs.statSync(f).mtimeMs).toISOString();
      } catch {
        // ignore
      }
    }

    // Same content-based extraction as listConversations: the filename fallback
    // would leak "Session <timestamp>" into push archives and resume targets.
    let readTitle = '';
    try {
      for (const rec of readJsonlHead(f, 200)) {
        const recPayload = (rec.payload as Record<string, unknown>) ?? {};
        let text = '';
        if (rec.type === 'event_msg' && recPayload.type === 'item_completed') {
          const item = recPayload.item as Record<string, unknown> | undefined;
          if (item?.type !== 'UserMessage') continue;
          const content = item.content as Array<Record<string, unknown>> | undefined;
          text = (content ?? []).map((c) => String(c.text ?? '')).join(' ');
        } else if (rec.type === 'response_item' && recPayload.type === 'message' && recPayload.role === 'user') {
          const content = recPayload.content as Array<Record<string, unknown>> | undefined;
          text = (content ?? []).map((c) => String(c.text ?? '')).join(' ');
        }
        if (!text) continue;
        const cleaned = typedTitle(text);
        if (cleaned) {
          readTitle = cleaned;
          break;
        }
      }
    } catch {
      // ignore
    }
    const title = readTitle || this.extractTitle(f);

    return {
      sessionId,
      title,
      cwd,
      platform: this.platform,
      createdAt,
      updatedAt,
      messages,
      metadata: sessionMetadata,
    };
  }

  /**
   * The agents a session spawned: rollouts written since it started whose first record names it, or an agent it
   * spawned, as the parent thread. Each agent reads from `subagent_history_start_ordinal`, so the parent history the
   * agent was given is not read twice; a rollout without it is read whole, with its start `unknown`. Agents come in
   * spawn order, each followed by the agents it spawned.
   */
  async readSubagents(session: Session, _ref: SessionReadRef): Promise<SubagentsRead> {
    const since = Date.parse(session.createdAt);
    const children = new Map<string, ChildRollout[]>();
    for (const file of this.scanAllRollouts()) {
      try {
        if (fs.statSync(file).mtimeMs < since) continue;
      } catch {
        continue;
      }
      const parsed = ChildRolloutMetaSchema.safeParse(this.readFirstLine(file));
      if (!parsed.success || Date.parse(parsed.data.payload.timestamp ?? '') < since) continue;
      const parent = parsed.data.payload.source.subagent.thread_spawn.parent_thread_id;
      children.set(parent, [...children.get(parent) ?? [], { file, meta: parsed.data.payload }]);
    }
    const agents: Subagent[] = [];
    const visit = (parent: string, depth: number): void => {
      const spawned = [...children.get(parent) ?? []].sort((left, right) => (left.meta.timestamp ?? '').localeCompare(right.meta.timestamp ?? ''));
      for (const child of spawned) {
        if (agents.some((agent) => agent.session.sessionId === child.meta.id)) continue;
        agents.push({ ...this.readChild(child), depth });
        visit(child.meta.id, depth + 1);
      }
    };
    visit(session.sessionId, 1);
    return { status: 'read', agents };
  }

  private readChild({ file, meta }: ChildRollout): Omit<Subagent, 'depth'> {
    const start = meta.subagent_history_start_ordinal;
    const records = [...readJsonl(file)].filter((record) =>
      start === undefined || (typeof record.ordinal === 'number' && record.ordinal >= start));
    const messages = this.buildMessages(records);
    const createdAt = parseCodexTimestamp(meta.timestamp);
    return {
      session: {
        sessionId: meta.id,
        title: '',
        cwd: meta.cwd ?? '',
        platform: this.platform,
        createdAt,
        updatedAt: messages.at(-1)?.timestamp ?? createdAt,
        messages,
        metadata: {},
      },
      finished: records.some((record) => record.type === 'event_msg'
        && typeof record.payload === 'object' && record.payload !== null && 'type' in record.payload && record.payload.type === 'task_complete'),
      start: start === undefined ? 'unknown' : 'recorded',
    };
  }

  private buildMessages(records: Record<string, unknown>[]): Message[] {
    const messages: Message[] = [];
    // Images returned by tools go in a user message of their own after the round's tool results
    let toolImages: ContentBlock[] = [];
    let toolImagesTimestamp: string | undefined;
    const flushToolImages = () => {
      if (toolImages.length === 0) return;
      messages.push({ role: 'user', content: toolImages, timestamp: toolImagesTimestamp });
      toolImages = [];
    };

    for (const rec of records) {
      const rtype = rec.type as string;

      if (rtype === 'turn_context') {
        const payload = (rec.payload as Record<string, unknown>) ?? {};
        const model = payload.model as string | undefined;
        if (model && messages.length > 0) {
          if (!messages[messages.length - 1].metadata) {
            messages[messages.length - 1].metadata = {};
          }
          messages[messages.length - 1].metadata!.model = model;
        }
        continue;
      }

      if (rtype !== 'response_item') continue;

      const payload = (rec.payload as Record<string, unknown>) ?? {};
      const ptype = payload.type as string;
      // Only items that start a new message end the round; ignored ones (web_search_call, developer messages) don't
      const startsMessage = (ptype === 'message' && payload.role !== 'developer') || ptype === 'function_call' || ptype === 'custom_tool_call' || ptype === 'reasoning';
      if (startsMessage) flushToolImages();

      if (ptype === 'message') {
        const role = payload.role as string;
        if (role === 'developer') continue; // skip the system prompt

        const irRole = role === 'user' ? 'user' : 'assistant';
        const content = this.parseMessageContent(payload);
        messages.push({ role: irRole, content, timestamp: parseCodexTimestamp(rec.timestamp) });
      } else if (ptype === 'function_call' || ptype === 'custom_tool_call') {
        const name = String(payload.name ?? '');
        const irName = normalizeToolName(name);
        const callId = String(payload.call_id ?? '');
        const argsRaw = payload.arguments;
        let arguments_: Record<string, unknown>;
        if (ptype === 'custom_tool_call' && typeof payload.input === 'string') {
          // Freeform tools (apply_patch) send plain text in `input`, not JSON `arguments`
          arguments_ = { input: payload.input };
        } else {
          try {
            const decoded: unknown = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw ?? {};
            arguments_ = typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded) ? { ...decoded } : { _raw: String(argsRaw) };
          } catch {
            arguments_ = { _raw: String(argsRaw) };
          }
        }

        const block: ToolCallBlock = { type: 'tool_call', toolName: irName, callId, arguments: arguments_ };

        if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
          messages[messages.length - 1].content.push(block);
        } else {
          messages.push({ role: 'assistant', content: [block], timestamp: parseCodexTimestamp(rec.timestamp) });
        }
      } else if (ptype === 'function_call_output' || ptype === 'custom_tool_call_output') {
        const callId = String(payload.call_id ?? '');
        const rawOutput = payload.output;
        let output: string;
        if (Array.isArray(rawOutput)) {
          // Some tools (images, the JS REPL) return a list of content items instead of a string
          const items = this.parseMessageContent({ content: rawOutput });
          output = items.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
          const images = items.filter((b) => b.type === 'image');
          if (images.length > 0) {
            toolImages.push(...images);
            toolImagesTimestamp = parseCodexTimestamp(rec.timestamp);
          }
        } else {
          output = String(rawOutput ?? '');
        }
        const block: ToolResultBlock = { type: 'tool_result', callId, content: output, isError: false };

        if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
          messages[messages.length - 1].content.push(block);
        } else {
          messages.push({ role: 'user', content: [block], timestamp: parseCodexTimestamp(rec.timestamp) });
        }
      } else if (ptype === 'reasoning') {
        // reasoning → ThinkingBlock. Codex writes the readable part to summary and may add content;
        // rawContent is what writeSession emits.
        const textOf = (parts: unknown, types: string[]): string[] =>
          Array.isArray(parts)
            ? parts
                .filter((p) => p && typeof p === 'object' && types.includes(String((p as Record<string, unknown>).type)))
                .map((p) => String((p as Record<string, unknown>).text ?? ''))
            : [];
        let text = textOf(payload.rawContent, ['reasoning_text']).join('');
        if (!text) text = textOf(payload.content, ['reasoning_text', 'text']).join('');
        if (!text) text = textOf(payload.summary, ['summary_text']).join('\n\n');
        const block: ThinkingBlock = { type: 'thinking', text };

        if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
          messages[messages.length - 1].content.push(block);
        } else {
          messages.push({ role: 'assistant', content: [block], timestamp: parseCodexTimestamp(rec.timestamp) });
        }
      }
    }
    flushToolImages();
    return messages;
  }

  private parseMessageContent(payload: Record<string, unknown>): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    const contentArr = payload.content;

    if (typeof contentArr === 'string') {
      blocks.push({ type: 'text', text: contentArr });
      return blocks;
    }

    if (!Array.isArray(contentArr)) return blocks;

    for (const item of contentArr) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      const itemType = it.type as string;
      const text = String(it.text ?? '');

      if (itemType === 'input_text' || itemType === 'output_text') {
        blocks.push({ type: 'text', text });
      } else if (itemType === 'input_image' && typeof it.image_url === 'string') {
        // A pasted image is stored as a data: URL; anything else keeps just the pointer
        const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(it.image_url);
        const mimeType = dataUrl?.[1] ?? 'image/png';
        blocks.push({
          type: 'image',
          mimeType,
          ...(dataUrl ? { data: dataUrl[2] } : { filePath: it.image_url }),
          label: `image.${mimeType.split('/')[1] ?? 'png'}`,
        });
      }
    }
    return blocks;
  }

  /**
   * Every rollout counts, archived ones included: the file path comes from the session's
   * creation time and the local timezone, so one id can sit in a file other than the one a
   * write would compute. Matches the whole id, never a suffix.
   */
  async existingSessionId(sessionId: string, projectPath?: string): Promise<string | undefined> {
    for (const f of this.scanAllRollouts()) {
      const base = path.basename(f, '.jsonl');
      if (base !== sessionId && !base.endsWith(`-${sessionId}`)) continue;
      if (projectPath && !this.rolloutMatchesCwd(f, projectPath)) continue;
      return sessionId;
    }
    return undefined;
  }

  async writeSession(session: Session, projectPath?: string): Promise<string> {
    const cwd = projectPath ?? session.cwd;
    const sessionId = deriveTargetSessionId({
      targetPlatform: this.platform,
      targetCwd: cwd,
      sourceSessionId: session.sessionId,
    });

    // Guard against corrupt input: an invalid session.createdAt makes new Date(...) an Invalid Date,
    // and calling toISOString() directly throws RangeError and crashes the whole write.
    const rawCreated = new Date(session.createdAt);
    const createdAt = isNaN(rawCreated.getTime()) ? new Date() : rawCreated;
    const tsIso = createdAt.toISOString();
    const fileTs = formatFilenameTimestamp(tsIso);

    // File path
    const dateDir = path.join(
      this.storageRoot,
      `${createdAt.getFullYear()}`,
      String(createdAt.getMonth() + 1).padStart(2, '0'),
      String(createdAt.getDate()).padStart(2, '0'),
    );
    const filename = `rollout-${fileTs}-${sessionId}.jsonl`;
    const filePath = path.join(dateDir, filename);

    // Build JSONL records
    const records: Record<string, unknown>[] = [];

    // 1. session_meta
    // Note: Codex's SessionMeta.payload.timestamp must be an RFC3339 string (not
    // and would be hidden from the Codex list.
    // model_provider must follow ~/.codex/config.toml (the list buckets by provider; see header).
    // No history_mode: 0.155+ treats the rollout as legacy and `codex
    // migrate-rollouts --apply` converts it to paginated history plus the items
    // projection. Claiming 'paginated' ourselves skips that: no projection, no preview, blank body.
    const modelProvider = readCodexModelProvider(
      path.join(path.dirname(this.storageRoot), 'config.toml'),
    );
    records.push({
      timestamp: tsIso,
      type: 'session_meta',
      payload: {
        id: sessionId,
        session_id: sessionId,
        timestamp: tsIso,
        cwd: projectPath ?? session.cwd,
        originator: 'codex_cli_rs',
        cli_version: '0.1.0',
        source: 'cli',
        thread_source: 'user',
        model_provider: modelProvider,
      },
    });

    // 2. Walk messages and write response_item + turn_context + event_msg
    let turnId = generateUuidV7();
    let turnStarted = false;
    // Prefer the message's own timestamp — using the migration time for everything collapses the timeline to a point,
    // and after a claude-code hop the order cannot even be recovered
    let lastTs = tsIso;
    // Codex Desktop's session UI renders the ThreadItem inside event_msg:item_completed
    // (UserMessage / AgentMessage). Writing only response_item lets the session open with a blank body.
    let itemCount = 0;
    let lastAgentMessage: string | undefined;
    let userItemEmitted = false;
    // The first UserMessage item decides title and list preview. If the session has no real
    // (all injected metadata), write a fallback note or the session has no preview and stays invisible.
    const fallbackUserText = session.messages.some(
      (m) =>
        m.role === 'user' &&
        m.content.some((b) => b.type === 'text' && isRenderableText(visibleUserText(b.text))),
    )
      ? null
      : `Migrated session from ${session.platform || 'external agent'}`;
    // Insert position for the fallback item (after the first turn's turn_context)
    let firstTurnInsertAt = -1;
    let firstTurnId = '';

    for (const msg of session.messages) {
      const parsedTs = msg.timestamp ? new Date(msg.timestamp) : null;
      const msgTs =
        parsedTs && !isNaN(parsedTs.getTime()) ? parsedTs.toISOString() : lastTs;
      lastTs = msgTs;

      // Each user message starts a new turn
      if (msg.role === 'user') {
        // If the previous turn already started, finish it first
        if (turnStarted) {
          records.push({
            timestamp: msgTs,
            type: 'event_msg',
            payload: {
              type: 'task_complete',
              turn_id: turnId,
              ...(lastAgentMessage ? { last_agent_message: lastAgentMessage } : {}),
              completed_at: Math.floor(new Date(msgTs).getTime() / 1000),
            },
          });
        }
        lastAgentMessage = undefined;
        // New turn
        turnId = generateUuidV7();
        records.push({
          timestamp: msgTs,
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: turnId,
            started_at: Math.floor(new Date(msgTs).getTime() / 1000),
          },
        });
        records.push({
          timestamp: msgTs,
          type: 'turn_context',
          payload: {
            turn_id: turnId,
            cwd: projectPath ?? session.cwd,
            workspace_roots: [projectPath ?? session.cwd],
            // On the Codex side, TurnContextItem requires approval_policy / sandbox_policy.
            // Missing them makes the whole line fail to deserialize.
            approval_policy: 'on-request',
            sandbox_policy: {
              type: 'workspace-write',
              network_access: false,
              exclude_tmpdir_env_var: false,
              exclude_slash_tmp: false,
            },
          },
        });
        turnStarted = true;
        if (firstTurnInsertAt < 0) {
          firstTurnInsertAt = records.length;
          firstTurnId = turnId;
        }
      }

      // Write each content block of the message
      for (const block of msg.content) {
        const rec = this.blockToResponseItem(msg.role, block, msgTs);
        if (rec) records.push(rec);

        // Also emit the item_completed event used for UI rendering (aligned with the 0.155 native format; see
        // the buildItemCompletedRecord comment).
        if (block.type !== 'text') continue;

        if (msg.role === 'user') {
          // Injected metadata (<user_info>/<rules>/<additional_data>/...) and attachment paths
          // (@image:/path) are not real input; what remains becomes the title/preview text.
          // Skip when the whole block is metadata.
          const userText = visibleUserText(block.text);
          if (!isRenderableText(userText)) continue;
          userItemEmitted = true;
          pushItemCompleted(records, {
            timestamp: msgTs,
            sessionId,
            turnId,
            itemId: `item-${++itemCount}`,
            itemType: 'UserMessage',
            text: userText,
          });
        } else if (isRenderableText(block.text)) {
          lastAgentMessage = block.text;
          pushItemCompleted(records, {
            timestamp: msgTs,
            sessionId,
            turnId,
            itemId: `item-${++itemCount}`,
            itemType: 'AgentMessage',
            text: block.text,
          });
        }
      }
    }

    // With no real user input at all, write a fallback UserMessage so the session has a title/preview.
    if (!userItemEmitted && fallbackUserText && firstTurnInsertAt >= 0) {
      const fallbackRecord = buildItemCompletedRecord({
        timestamp: tsIso,
        sessionId,
        turnId: firstTurnId,
        itemId: 'item-0',
        itemType: 'UserMessage',
        text: fallbackUserText,
      });
      records.splice(firstTurnInsertAt, 0, fallbackRecord);
    }

    // task_complete for the last turn
    if (turnStarted) {
      records.push({
        timestamp: lastTs,
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: turnId,
          ...(lastAgentMessage ? { last_agent_message: lastAgentMessage } : {}),
          completed_at: Math.floor(new Date(lastTs).getTime() / 1000),
        },
      });
    }

    // Per-line ordinal: new Codex uses it for rollout ordering and items pagination;
    // without it thread/items/list returns empty and the session opens blank.
    // Field order matches native rollouts (timestamp, ordinal, type, payload).
    const ordered = records.map((rec, idx) => ({
      timestamp: rec.timestamp,
      ordinal: idx,
      type: rec.type,
      payload: rec.payload,
    }));

    writeJsonl(filePath, ordered);

    // 3. Let the Codex CLI convert the legacy rollout to paginated history + items projection.
    await this.paginateRollout(sessionId, path.dirname(this.storageRoot));
    return sessionId;
  }

  /**
   * Run `codex migrate-rollouts --apply --thread <id>` to convert the freshly written legacy rollout into
   * paginated history and build the items projection.
   *
   * Without this step, a session in Codex Desktop has no title/preview in the list (invisible) and opens with a blank body
   * (the items projection is only built during the legacy->paginated migration).
   *
   * A freshly written rollout is not in state_5.sqlite yet, so the targeted migration
   * reports missing_sqlite_metadata; start a temporary app-server, call thread/list once
   * (the official indexing path: it registers the rollout and computes title/preview),
   * then retry. Everything is best-effort: keep the legacy rollout as-is when the CLI
   */
  private async paginateRollout(sessionId: string, codexHome: string): Promise<void> {
    const bin = await findCodexCli();
    if (!bin) {
      this.noteWrite(
        'Codex CLI was not found. The rollout was written, but Codex will not list it until the CLI indexes it.',
      );
      return;
    }
    const opts = { env: { ...process.env, CODEX_HOME: codexHome }, timeoutMs: 120_000 };

    const runApply = async (): Promise<string | undefined> => {
      let stdout = '';
      try {
        // A non-zero exit (e.g. a corrupted rollout causing "one or more rollout
        // migrations failed") still carries the full JSON report; parse it to
        // judge this thread's outcome.
        ({ stdout } = await execCommand(bin, ['migrate-rollouts', '--apply', '--thread', sessionId, '--json'], opts));
      } catch {
        // Timed out or could not start: no report.
      }
      try {
        const report = JSON.parse(stdout) as {
          outcomes?: { thread_id: string; status: string }[];
        };
        return report.outcomes?.find((o) => o.thread_id === sessionId)?.status;
      } catch {
        return undefined;
      }
    };

    let status = await runApply();
    if (status === 'migrated' || status === 'already_paginated') return;
    // A missing JSON report (timeout, incompatible CLI) must not scan every rollout.
    if (status !== 'missing_sqlite_metadata') {
      const notice =
        `Codex indexing skipped for ${sessionId}: ${status ?? 'no JSON report'}. The rollout was written; the session may stay invisible until Codex reindexes.`;
      log.debug(notice);
      this.noteWrite(notice);
      return;
    }
    await this.indexThreadViaAppServer(bin, codexHome);
    status = await runApply();
    if (status !== 'migrated' && status !== 'already_paginated') {
      const notice =
        `Codex indexing did not finish for ${sessionId}: ${status ?? 'no JSON report'}. The rollout was written; the session may stay invisible until Codex reindexes.`;
      log.debug(notice);
      this.noteWrite(notice);
    }
  }

  /**
   * Start a temporary `codex app-server`, initialize + thread/list (the official
   * indexing path: it scans the sessions dir, upserts the new rollout into
   * state_5.threads and computes title/preview), then exits after the response.
   */
  private indexThreadViaAppServer(bin: string, codexHome: string): Promise<void> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = crossSpawn(bin, ['app-server'], {
          env: { ...process.env, CODEX_HOME: codexHome, RUST_LOG: 'error' },
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        });
      } catch {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child.stdin?.end();
        } catch {
          // ignore
        }
        try {
          child.kill();
        } catch {
          // ignore
        }
        resolve();
      };
      const timer = setTimeout(finish, 30_000);

      const send = (obj: unknown) => {
        try {
          child.stdin?.write(JSON.stringify(obj) + '\n');
        } catch {
          // ignore
        }
      };

      let buffer = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          if (line.includes('"id":1')) {
            send({ jsonrpc: '2.0', method: 'initialized', params: {} });
            send({ jsonrpc: '2.0', id: 2, method: 'thread/list', params: { limit: 50 } });
          } else if (line.includes('"id":2')) {
            finish();
            return;
          }
        }
      });
      child.on('error', finish);
      child.on('exit', finish);

      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'teamai', title: 'teamai', version: '0.0.0' } },
      });
    });
  }

  private blockToResponseItem(role: string, block: ContentBlock, timestamp?: string): Record<string, unknown> | null {
    const ts = timestamp ?? new Date().toISOString();

    switch (block.type) {
      case 'text': {
        const contentType = role === 'user' ? 'input_text' : 'output_text';
        return {
          timestamp: ts,
          type: 'response_item',
          payload: {
            type: 'message',
            // Current Codex ResponseItem::Message requires an id (msg_<uuid> form);
            // missing it fails the line and resume replays 0 items (blank UI).
            id: `msg_${generateUuidV7()}`,
            role,
            content: [{ type: contentType, text: block.text }],
          },
        };
      }
      case 'image': {
        // Codex keeps user images inline as input_image data: URLs; without data, or in an
        // assistant message, degrade to a placeholder (counted degraded)
        const content = role === 'user' && block.data
          ? [{ type: 'input_image', image_url: `data:${block.mimeType};base64,${block.data}` }]
          : [{ type: role === 'user' ? 'input_text' : 'output_text', text: imagePlaceholderText(block) }];
        return {
          timestamp: ts,
          type: 'response_item',
          payload: {
            type: 'message',
            id: `msg_${generateUuidV7()}`,
            role,
            content,
          },
        };
      }
      case 'tool_call': {
        const codexName = denormalizeToolName(block.toolName);
        return {
          timestamp: ts,
          type: 'response_item',
          payload: {
            type: 'function_call',
            id: `fc_${generateUuidV7()}`,
            name: codexName,
            arguments: JSON.stringify(block.arguments),
            call_id: block.callId,
          },
        };
      }
      case 'tool_result': {
        return {
          timestamp: ts,
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            id: `fcoutput_${generateUuidV7()}`,
            call_id: block.callId,
            output: block.content,
          },
        };
      }
      case 'thinking': {
        // Codex supports reasoning; write it as a reasoning response_item
        return {
          timestamp: ts,
          type: 'response_item',
          payload: {
            type: 'reasoning',
            id: `rs_${generateUuidV7()}`,
            content: [],
            rawContent: [{ type: 'reasoning_text', text: block.text }],
          },
        };
      }
    }
  }

  async deleteSession(sessionId: string, projectPath?: string): Promise<boolean> {
    assertSafeSessionFileId(sessionId);
    // Scope first: unregisterThread is global, so running it before the lookup
    // would drop another workspace's copy when `rollback --cwd` matched nothing.
    const f = this.findSessionFile(sessionId, projectPath);
    if (!f || !fileExists(f)) return false;

    // Unregister, then delete the body. Removing only the rollout leaves an
    // orphan listed with title/preview but opening blank -- rollback achieved nothing.
    await this.unregisterThread(sessionId);

    try {
      fs.unlinkSync(f);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove the session's traces from both Codex stores: state_5.threads (list rows) and
   * items/turns/projection watermark. Lock contention or a missing table never blocks the
   * rollout delete. A missing sqlite3 CLI does: the rows would stay listed, so this throws
   * before the rollout is deleted, and a rollback run again once sqlite3 is installed finds it.
   */
  private async unregisterThread(sessionId: string): Promise<void> {
    // Defense in depth against SQL injection: the id comes straight from the CLI
    // argument, so a value like `' OR 1=1; --` would wipe the whole table.
    // Require the Codex id shape (uuid v7) AND escape quotes anyway.
    if (!isUuidV7(sessionId)) {
      log.debug(`codex unregister skipped: not a codex session id: ${sessionId.slice(0, 12)}`);
      return;
    }
    const safeId = sessionId.replace(/'/g, "''");
    const home = path.dirname(this.storageRoot); // ~/.codex
    const stmts: Array<[string, string[]]> = [
      [
        path.join(home, 'state_5.sqlite'),
        [
          `DELETE FROM threads WHERE id='${safeId}';`,
          `DELETE FROM thread_history_projection_state WHERE thread_id='${safeId}';`,
        ],
      ],
      [
        path.join(home, 'thread_history_1.sqlite'),
        [
          `DELETE FROM thread_items WHERE thread_id='${safeId}';`,
          `DELETE FROM thread_turns WHERE thread_id='${safeId}';`,
        ],
      ],
    ];
    const present = stmts.filter(([db]) => fileExists(db));
    if (present.length === 0) return;
    const bin = findSqlite3();
    if (!bin) {
      throw new Error(
        `The sqlite3 CLI was not found, so TeamAI could not unregister Codex thread ${sessionId} ` +
          'and Codex would keep listing it. Nothing was deleted: install sqlite3 and run the rollback again.',
      );
    }
    // Run statement by statement, no transaction: table shapes differ across Codex
    // versions (e.g. no projection_state table) and one error in a transaction
    for (const [db, sqls] of present) {
      for (const sql of sqls) {
        try {
          await execCommand(bin, [db, `PRAGMA busy_timeout=5000; ${sql}`], { timeoutMs: 30_000 });
        } catch {
          // Missing table / lock contention: skip, other cleanup continues
        }
      }
    }
  }
}
