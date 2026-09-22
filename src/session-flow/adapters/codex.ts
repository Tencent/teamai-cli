/**
 * adapters/codex.ts — Codex (OpenAI Codex CLI) 适配器。
 *
 * 读取/写入 `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid-v7>.jsonl` 格式。
 *
 * JSONL 行类型（5 种顶层 type）：
 *   - session_meta: 会话元数据（第一行）
 *   - response_item: 核心消息载体（message / function_call / function_call_output / reasoning）
 *   - event_msg: 事件日志（task_started / task_complete / user_message / agent_message / token_count）
 *   - turn_context: turn 上下文（cwd / sandbox_policy / model）
 *
 * 增强点（vs Python 版）：
 * - 写入时生成 turn_context 行
 * - 写入时生成 event_msg:task_started + task_complete
 * - reasoning 块写入为 response_item:reasoning（而非跳过）
 * - 支持 custom_tool_call / custom_tool_call_output
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
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { AgentAdapter, type SessionMeta } from './base.js';
import type { Session, Message, ContentBlock, TextBlock, ThinkingBlock, ToolCallBlock, ToolResultBlock } from '../ir.js';
import { imagePlaceholderText } from '../ir.js';
import { titleFromUserText, visibleUserText } from '../title.js';
import { deriveTargetSessionId } from '../ids.js';
import { findSqlite3 } from '../sqlite.js';
import { log } from '../../utils/logger.js';
import {
  getCodexSessionsDir,
  resolveRealCwd,
  readJsonl,
  readJsonlHead,
  writeJsonl,
  fileExists,
  dirExists,
  scanFiles,
} from '../fs.js';

// ---------------------------------------------------------------------------
// 工具名归一化映射
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
// UUIDv7 生成
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
// 时间戳工具
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
  // 2026-07-09T00-00-00（: → -）
  return isoStr.replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
}

// ---------------------------------------------------------------------------
// Codex 配置探测 / 元信息清理 / CLI 探测
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
 * "Pure metadata" blocks injected by source platforms. They are not real user
 * input, and Codex builds title/list preview from the first UserMessage item --
 * if that first message is metadata it is dropped wholesale -> no
 * title/preview -> the session never shows up.
 *
 * Notes: 1) only pure-metadata tags are listed here; <user_query>-style
 * wrappers around real questions are handled separately by extractUserText;
 * 2) not line-anchored -- after stripping one block the rest often starts with
 * \n\n<rules>, and line anchors would miss the following blocks; 3)
 * system_reminder covers both the underscore (CodeBuddy) and hyphen (Claude
 * Code) spellings.
 */
const META_BLOCK_RE =
  /<(user_info|rules|environment_context|system-reminder|system_reminder|system_instructions|available_skills|agent_request|local-command-caveat|uploaded_documents|additional_data|timestamp)[^>]*>[\s\S]*?<\/\1>[ \t]*\r?\n?/gi;

function stripMetaBlocks(text: string): string {
  let out = text;
  for (let i = 0; i < 10; i++) {
    const next = out.replace(META_BLOCK_RE, '');
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/**
 * Extract the real user input from a user message.
 * CodeBuddy / Cursor wrap the actual question in <user_query>...</user_query>
 * (with large <user_info>/<rules> metadata outside), so unwrapping is the
 * cleanest path; platforms without the wrapper fall back to metadata stripping.
 */
function extractUserText(text: string): string {
  const qm = text.match(/<user_query[^>]*>([\s\S]*?)<\/user_query>/i);
  return stripMetaBlocks(qm ? qm[1] : text);
}

/**
 * 文本是否值得生成 ThreadItem。
 * 源平台会把水平线/围栏/空列表项序列化成独立文本块（"-" / "---" / "*" / "```" 等），
 * 它们作为消息渲染出来就是一颗颗空 bullet。这类纯 markdown 修饰符块跳过不发 item
 * （response_item 仍保留原文，不影响保真度）。
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
 * event_msg:item_completed —— Codex Desktop 真正渲染（并用于生成标题/预览）的 ThreadItem。
 * UserMessage 与 AgentMessage 的 content type 大小写不一致（text / Text），照抄原生格式。
 * 对齐 0.155 原生格式：
 * - payload 必须带 started_at_ms / completed_at_ms（缺失导致反序列化失败、item 被丢弃）
 * - UserMessage item 不写 client_id（原生无此字段，写入会导致 UserMessage 解析失败，
 *   表现为 thread/items/list 投影为空、会话打开后一片空白）
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

const execFileAsync = promisify(execFile);

/** Codex Desktop (ChatGPT.app) 自带的 codex CLI 位置（macOS）。 */
const DESKTOP_CODEX_CANDIDATES = [
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  `${homedir()}/Applications/ChatGPT.app/Contents/Resources/codex`,
  '/Applications/Codex.app/Contents/Resources/codex',
];

function findCodexCli(): string | null {
  // 1) PATH 上的 codex（npm / brew 安装）
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'codex');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // continue
    }
  }
  // 2) Codex Desktop 自带的 CLI
  for (const p of DESKTOP_CODEX_CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // continue
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CodexAdapter
// ---------------------------------------------------------------------------

export class CodexAdapter extends AgentAdapter {
  readonly platform: string;
  private readonly storageRoot: string;

  /**
   * @param platform 平台标识（默认 'codex'，变体可传 'codex-internal' / 'tcodex'）
   * @param storageRoot 存储根路径（默认 ~/.codex/sessions，变体传 ~/.codex-internal/sessions 等）
   */
  constructor(platform = 'codex', storageRoot?: string) {
    super();
    this.platform = platform;
    this.storageRoot = storageRoot ?? getCodexSessionsDir();
  }

  static isAvailable(): boolean {
    return dirExists(getCodexSessionsDir());
  }

  static getDefaultStoragePath(): string {
    return getCodexSessionsDir();
  }

  isReady(): boolean {
    return dirExists(this.storageRoot);
  }

  private scanJsonlFiles(): string[] {
    return scanFiles(this.storageRoot, /\.jsonl$/);
  }

  private findSessionFile(sessionId: string): string | null {
    for (const f of this.scanJsonlFiles()) {
      // 文件名是 rollout-<时间戳>-<sessionId>，中缀匹配；但前缀只认 ≥8 位，
      // 否则 4 位前缀的子串会读到别人的会话
      const base = path.basename(f, '.jsonl');
      if (base === sessionId || (sessionId.length >= 8 && base.endsWith(sessionId))) return f;
    }
    return null;
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

  async listConversations(projectPath?: string): Promise<SessionMeta[]> {
    const metas: SessionMeta[] = [];

    for (const f of this.scanJsonlFiles()) {
      const first = this.readFirstLine(f);
      if (!first || first.type !== 'session_meta') continue;

      const payload = (first.payload as Record<string, unknown>) ?? {};
      const sessionId = String(payload.id ?? '');
      const cwd = String(payload.cwd ?? '');
      const tsRaw = payload.timestamp;

      if (projectPath) {
        // 不能用精确字符串比较：macOS 上 /tmp 与 /private/tmp 是同一目录的两种拼写
        // （symlink），写入时与列出时的拼写不一致会让会话「列出为空」。
        // 与 encodeCwd*/hashWorkspace 一致，先 realpath 再比较。
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
          const cleaned = titleFromUserText(visibleUserText(text));
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

  async readSession(sessionId: string, projectPath?: string): Promise<Session> {
    const f = this.findSessionFile(sessionId);
    if (!f) throw new Error(`Codex session not found: ${sessionId}`);

    const records = [...readJsonl(f)];

    let cwd = '';
    let createdAt = new Date().toISOString();
    const sessionMetadata: Record<string, unknown> = {};

    for (const rec of records) {
      if (rec.type === 'session_meta') {
        const payload = (rec.payload as Record<string, unknown>) ?? {};
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
        const cleaned = titleFromUserText(visibleUserText(text));
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

  private buildMessages(records: Record<string, unknown>[]): Message[] {
    const messages: Message[] = [];

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

      if (ptype === 'message') {
        const role = payload.role as string;
        if (role === 'developer') continue; // 系统提示跳过

        const irRole = role === 'user' ? 'user' : 'assistant';
        const content = this.parseMessageContent(payload);
        messages.push({ role: irRole, content, timestamp: parseCodexTimestamp(rec.timestamp) });
      } else if (ptype === 'function_call' || ptype === 'custom_tool_call') {
        const name = String(payload.name ?? '');
        const irName = normalizeToolName(name);
        const callId = String(payload.call_id ?? '');
        const argsRaw = payload.arguments;
        let arguments_: Record<string, unknown>;
        try {
          arguments_ = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : (argsRaw as Record<string, unknown>) ?? {};
        } catch {
          arguments_ = { _raw: String(argsRaw) };
        }

        const block: ToolCallBlock = { type: 'tool_call', toolName: irName, callId, arguments: arguments_ };

        if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
          messages[messages.length - 1].content.push(block);
        } else {
          messages.push({ role: 'assistant', content: [block], timestamp: parseCodexTimestamp(rec.timestamp) });
        }
      } else if (ptype === 'function_call_output' || ptype === 'custom_tool_call_output') {
        const callId = String(payload.call_id ?? '');
        const output = String(payload.output ?? '');
        const block: ToolResultBlock = { type: 'tool_result', callId, content: output, isError: false };

        if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
          messages[messages.length - 1].content.push(block);
        } else {
          messages.push({ role: 'user', content: [block], timestamp: parseCodexTimestamp(rec.timestamp) });
        }
      } else if (ptype === 'reasoning') {
        // reasoning → ThinkingBlock
        const rawContent = payload.rawContent as Array<Record<string, unknown>> | undefined;
        let text = '';
        if (Array.isArray(rawContent)) {
          for (const part of rawContent) {
            if (part.type === 'reasoning_text') {
              text += String(part.text ?? '');
            }
          }
        }
        const block: ThinkingBlock = { type: 'thinking', text };

        if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
          messages[messages.length - 1].content.push(block);
        } else {
          messages.push({ role: 'assistant', content: [block], timestamp: parseCodexTimestamp(rec.timestamp) });
        }
      }
    }
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
      }
    }
    return blocks;
  }

  async writeSession(session: Session, projectPath?: string): Promise<string> {
    // session_id: reuse if already UUIDv7; otherwise derive deterministically.
    // Random ids would give every re-migration a fresh target id -- a fully
    // duplicated second thread in Codex (threads doubled). Derived ids make a
    // re-migration an overwrite: idempotent by construction.
    const sessionId = isUuidV7(session.sessionId)
      ? session.sessionId
      : deriveTargetSessionId(this.platform, session.sessionId);

    // 损坏输入防御：session.createdAt 非法时 new Date(...) 得到 Invalid Date，
    // 直接 toISOString() 会抛 RangeError 让整个写入崩溃。
    const rawCreated = new Date(session.createdAt);
    const createdAt = isNaN(rawCreated.getTime()) ? new Date() : rawCreated;
    const tsIso = createdAt.toISOString();
    const fileTs = formatFilenameTimestamp(tsIso);

    // 文件路径
    const dateDir = path.join(
      this.storageRoot,
      `${createdAt.getFullYear()}`,
      String(createdAt.getMonth() + 1).padStart(2, '0'),
      String(createdAt.getDate()).padStart(2, '0'),
    );
    const filename = `rollout-${fileTs}-${sessionId}.jsonl`;
    const filePath = path.join(dateDir, filename);

    // 构建 JSONL 记录
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

    // 2. 遍历 messages，写 response_item + turn_context + event_msg
    let turnId = generateUuidV7();
    let turnStarted = false;
    // 消息原生时间戳优先——全部用迁移时刻会让时间线塌缩成一点，
    // 经 claude-code 中转后甚至无法恢复先后顺序
    let lastTs = tsIso;
    // Codex Desktop 的会话界面渲染的是 event_msg:item_completed 里的 ThreadItem
    // （UserMessage / AgentMessage），只写 response_item 会导致会话能打开但内容空白。
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

      // 每个 user 消息开始一个新 turn
      if (msg.role === 'user') {
        // 如果上一个 turn 已开始，先完成它
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
        // 新 turn
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
            // Codex 端 TurnContextItem 的 approval_policy / sandbox_policy 为必填字段，
            // 缺失会导致整行反序列化失败
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

      // 写消息的每个 content block
      for (const block of msg.content) {
        const rec = this.blockToResponseItem(msg.role, block, msgTs);
        if (rec) records.push(rec);

        // 同步生成 UI 渲染用的 item_completed 事件（对齐 0.155 原生格式，见
        // buildItemCompletedRecord 注释）。
        if (block.type !== 'text') continue;

        if (msg.role === 'user') {
          // Injected metadata (<user_info>/<rules>/<additional_data>/...) and attachment paths
          // (@image:/path) are not real input; what remains becomes the title/preview text.
          // 整块都是元信息则跳过。
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

    // 最后一个 turn 的 task_complete
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
   * 触发 `codex migrate-rollouts --apply --thread <id>`，把刚写入的 legacy rollout 转成
   * 分页历史并建立 items 投影。
   *
   * 不跑这一步，会话在 Codex Desktop 里：列表无标题/预览（不可见），打开后内容空白
   * (the items projection is only built during the legacy->paginated migration).
   *
   * A freshly written rollout is not in state_5.sqlite yet, so the targeted migration
   * reports missing_sqlite_metadata; start a temporary app-server, call thread/list once
   * (the official indexing path: it registers the rollout and computes title/preview),
   * then retry. Everything is best-effort: keep the legacy rollout as-is when the CLI
   */
  private async paginateRollout(sessionId: string, codexHome: string): Promise<void> {
    const bin = findCodexCli();
    if (!bin) return;
    const env = { ...process.env, CODEX_HOME: codexHome };
    const opts = { env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 };

    const runApply = async (): Promise<string | undefined> => {
      let stdout = '';
      try {
        const r = await execFileAsync(
          bin,
          ['migrate-rollouts', '--apply', '--thread', sessionId, '--json'],
          opts,
        );
        stdout = r.stdout ?? '';
      } catch (e) {
        // Non-zero exit (e.g. a corrupted rollout causing "one or more rollout
        // migrations failed") still carries the full JSON report; parse it to
        // judge this thread's outcome.
        stdout = (e as { stdout?: string }).stdout ?? '';
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

    // Not indexed (missing_sqlite_metadata etc.) -> register via app-server thread/list, retry
    await this.indexThreadViaAppServer(bin, codexHome);
    await runApply();
  }

  /**
   * Start a temporary `codex app-server`, initialize + thread/list (the official
   * indexing path: it scans the sessions dir, upserts the new rollout into
   * state_5.threads and computes title/preview), then exits after the response.
   */
  private indexThreadViaAppServer(bin: string, codexHome: string): Promise<void> {
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, ['app-server'], {
          env: { ...process.env, CODEX_HOME: codexHome, RUST_LOG: 'error' },
          stdio: ['pipe', 'pipe', 'ignore'],
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
        // rollout messages only support text: degrade the image to a placeholder (counted degraded)
        const contentType = role === 'user' ? 'input_text' : 'output_text';
        return {
          timestamp: ts,
          type: 'response_item',
          payload: {
            type: 'message',
            id: `msg_${generateUuidV7()}`,
            role,
            content: [{ type: contentType, text: imagePlaceholderText(block) }],
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
        // Codex 支持 reasoning，写入为 reasoning response_item
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

  async deleteSession(sessionId: string, projectPath?: string): Promise<void> {
    // Unregister first, then delete the body. Removing only the rollout leaves an
    // orphan listed with title/preview but opening blank -- rollback achieved nothing.
    await this.unregisterThread(sessionId);

    const f = this.findSessionFile(sessionId);
    if (f && fileExists(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Remove the session's traces from both Codex stores: state_5.threads (list rows) and
   * items/turns/projection watermark. Best-effort: a missing CLI or lock contention never blocks the rollout delete.
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
    const bin = findSqlite3();
    if (!bin) return;
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
    // Run statement by statement, no transaction: table shapes differ across Codex
    // versions (e.g. no projection_state table) and one error in a transaction
    for (const [db, sqls] of stmts) {
      if (!fileExists(db)) continue;
      for (const sql of sqls) {
        try {
          await execFileAsync(bin, [db, `PRAGMA busy_timeout=5000; ${sql}`], {
            timeout: 30_000,
            maxBuffer: 16 * 1024 * 1024,
          });
        } catch {
          // Missing table / lock contention: skip, other cleanup continues
        }
      }
    }
  }
}
