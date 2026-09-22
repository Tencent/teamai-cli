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
 * 写入的 rollout 必须能被 Codex 直接索引（否则会话不会出现在 Codex Desktop 历史列表）：
 * - session_meta.payload.model_provider：Codex 按 provider 分桶展示会话，只有与
 *   ~/.codex/config.toml 当前 model_provider 一致的会话才会出现在列表里（见
 *   https://github.com/farion1231/cc-switch/issues/4710）。缺失/写错 → 会话静默消失。
 * - 不声明 history_mode：Codex 0.155+ 把无声明的 rollout 当 legacy，由
 *   `codex migrate-rollouts --apply` 转成分页历史并建立 items 投影；自己声明 'paginated'
 *   会被当成 already-paginated 跳过迁移 → 无投影 → 列表无预览、打开空白。
 * - 每行顶层 ordinal：分页游标依赖它，缺失时 thread/items/list 返回空。
 * - 至少一条 event_msg:item_completed 的 UserMessage：标题与列表预览取自第一条用户
 *   item；元信息块（<user_info>/<user_query>包裹的时间戳头等）会被整条丢弃，
 *   导致没有标题/预览 → 不显示。
 * - 写完后主动调用 codex CLI 建投影（paginateRollout），保证迁移完立刻可见。
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
  // 前 48 位时间戳左移 80 位。
  // 注意：必须用 BigInt 按位与（0xffffffffffffn）。
  // Number 的 `&` 运算符是 32 位有符号按位与，时间戳超过 2^31 会变成负数，
  // 导致后续 BigInt 为负、toString(16) 输出带负号的非法 UUID，
  // 使 Codex 端 Uuid 反序列化失败、整个会话被忽略（迁移后 Codex 里看不到）。
  let uuidInt = (BigInt(timestampMs) & 0xffffffffffffn) << 80n;
  // 版本位 7（位 76-79）
  uuidInt |= 7n << 76n;
  // 随机位（低 62 位）
  const randBytes = crypto.randomBytes(8);
  let rand = 0n;
  for (let i = 0; i < 8; i++) {
    rand = (rand << 8n) | BigInt(randBytes[i]);
  }
  rand &= (1n << 62n) - 1n;
  uuidInt |= rand;
  // 设置变体位（位 62-63 为 10）
  uuidInt = (uuidInt & ~(0x3n << 62n)) | (0x2n << 62n);

  // 转为 UUID 字符串
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
 * 读取 Codex 当前生效的 model_provider（config.toml 顶层 `model_provider = "..."`）。
 *
 * Codex Desktop 的会话列表按 provider 分桶：只有与当前配置一致的会话才会展示，
 * 切换 provider 后旧会话“消失”就是这个机制。迁移写入的 rollout 必须带上当前值。
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
 * 源平台注入的“纯元信息”块。它们不是真实用户输入，而 Codex 用第一条 UserMessage item
 * 生成标题与列表预览，首条消息若是元信息会被整条丢弃 → 会话没有 title/preview →
 * 不出现在历史列表。
 *
 * 注意：1) 只列纯元信息标签，<user_query> 之类包裹真实提问的标签由 extractUserText
 * 单独处理；2) 不锚定行首——前一块剥离后剩余文本常以 \n\n<rules> 开头，行首锚定会导致
 * 后续块匹配失败；3) system_reminder 同时覆盖下划线（CodeBuddy）与连字符（Claude Code）。
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
 * 从一条用户消息里提取真实用户输入。
 * CodeBuddy / Cursor 会把真实提问包在 <user_query>...</user_query> 里（外层还挂着大段
 * <user_info>/<rules> 元信息），直接取包裹内容最干净；没有该包裹的平台走元信息剥离。
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

      // 单次有限扫描：统计消息数 + 提取内容标题。
      // 标题取首条真实用户文本（item_completed 的 UserMessage 或 response_item 的
      // user message，后者覆盖无 item_completed 的老 legacy rollout）——此前只从
      // 文件名生成 `Session <时间戳>`，列表里一整排时间戳没法辨认。
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

    const title = this.extractTitle(f);

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
    // session_id: 已是 UUIDv7 则沿用；否则**确定性派生**而非随机生成——
    // 随机会让同一源会话每次迁移都产出新的目标 id，Codex 里出现内容完全重复的
    // 第二个线程（threads 行数翻倍）。派生后重迁移=覆盖，天然幂等。
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
    // 注意：Codex 端 SessionMeta.payload.timestamp 必须是 RFC3339 字符串（非 epoch 毫秒数字），
    // source 必须是 SessionSource 合法枚举值（'cli'/'vscode'/...）。
    // 非交互来源（自定义字符串）会被 INTERACTIVE_SESSION_SOURCES 过滤，
    // 导致会话不在 Codex 列表中显示。
    // model_provider 必须跟随 ~/.codex/config.toml（按 provider 分桶展示，见文件头注释）。
    // 不声明 history_mode：0.155+ 会把 rollout 当 legacy 并由 `codex migrate-rollouts --apply`
    // 转成分页历史 + 建立 items 投影（标题/预览/内容都来自这次投影）。自己声明 'paginated'
    // 反而会跳过迁移——线程没有投影，列表无预览、打开空白。
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
    // 第一条 UserMessage item 决定会话标题与列表预览。若整个会话里没有一句真实用户输入
    // （全部是源平台注入的元信息），兜底写一条迁移说明，否则会话没有 preview 而不可见。
    const fallbackUserText = session.messages.some(
      (m) =>
        m.role === 'user' &&
        m.content.some((b) => b.type === 'text' && isRenderableText(visibleUserText(b.text))),
    )
      ? null
      : `Migrated session from ${session.platform || 'external agent'}`;
    // 兜底 item 的插入位置（第一个 turn 的 turn_context 之后）
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
          // 源平台注入的元信息（<user_info>/<rules>/<additional_data>/…）与附件路径
          // （@image:/path）都不是真实用户输入，剥掉后剩下的才是标题/预览要用的文本。
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

    // 没有任何真实用户输入时补一条兜底 UserMessage，保证会话有标题/预览。
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

    // 每行补 ordinal：新版 Codex 用它做 rollout 行序号与 items 游标分页，
    // 缺失时 thread/items/list 返回空，会话打开后一片空白。
    // 字段顺序与原生 rollout 保持一致（timestamp, ordinal, type, payload）。
    const ordered = records.map((rec, idx) => ({
      timestamp: rec.timestamp,
      ordinal: idx,
      type: rec.type,
      payload: rec.payload,
    }));

    writeJsonl(filePath, ordered);

    // 3. 让 Codex CLI 把 legacy rollout 转成分页历史并建立 items 投影（标题/预览/内容）。
    await this.paginateRollout(sessionId, path.dirname(this.storageRoot));
    return sessionId;
  }

  /**
   * 触发 `codex migrate-rollouts --apply --thread <id>`，把刚写入的 legacy rollout 转成
   * 分页历史并建立 items 投影。
   *
   * 不跑这一步，会话在 Codex Desktop 里：列表无标题/预览（不可见），打开后内容空白
   * （items 投影只有在 legacy→paginated 迁移时才会建立）。
   *
   * 新写入的 rollout 还没进 state_5.sqlite 时，定向迁移会报 missing_sqlite_metadata；
   * 此时起一个临时 app-server 调一次 thread/list（官方索引入口，会把新 rollout 登记
   * 进 threads 表并算出标题/预览），再重试定向迁移。所有步骤均为 best-effort：找不到
   * codex CLI 或仍失败时保持 legacy 原样，由 Codex 自身启动迁移兜底，不算迁移失败。
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
        // 退出码非 0（如预存损坏 rollout 导致 "one or more rollout migrations failed"）
        // 时 stdout 仍带完整 JSON 报告，取出来判断本线程的结果。
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

    // 未索引（missing_sqlite_metadata 等）→ 让 app-server 的 thread/list 登记新文件，重试
    await this.indexThreadViaAppServer(bin, codexHome);
    await runApply();
  }

  /**
   * 起一个临时 `codex app-server`，initialize + thread/list（官方索引入口：会扫描
   * sessions 目录、把新 rollout upsert 进 state_5.threads 并计算标题/预览），拿到
   * thread/list 响应后立即退出。任何异常都静默结束（best-effort）。
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
            // 当前版本 Codex 的 ResponseItem::Message 要求必填 id（msg_<uuid> 格式），
            // 缺失时整行反序列化失败，resume 重放产出 0 个 item，UI 显示空白
            id: `msg_${generateUuidV7()}`,
            role,
            content: [{ type: contentType, text: block.text }],
          },
        };
      }
      case 'image': {
        // rollout 的消息只支持 text，图片降级为占位文本（保真度计 degraded）
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
    // 先摘索引，再删正文。只删 rollout 会让 Codex 列表里留下一条 title/preview 都在
    // 但点开空白的孤儿会话（threads 行与 items 投影仍在），回滚等于没回滚。
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
   * 删除 Codex 两库里的会话痕迹：state_5.threads（列表项）+ thread_history_1 的
   * items/turns/投影水位。best-effort：CLI 缺失或加锁失败都不影响 rollout 删除。
   */
  private async unregisterThread(sessionId: string): Promise<void> {
    const bin = findSqlite3();
    if (!bin) return;
    const home = path.dirname(this.storageRoot); // ~/.codex
    const stmts: Array<[string, string[]]> = [
      [
        path.join(home, 'state_5.sqlite'),
        [
          `DELETE FROM threads WHERE id='${sessionId}';`,
          `DELETE FROM thread_history_projection_state WHERE thread_id='${sessionId}';`,
        ],
      ],
      [
        path.join(home, 'thread_history_1.sqlite'),
        [
          `DELETE FROM thread_items WHERE thread_id='${sessionId}';`,
          `DELETE FROM thread_turns WHERE thread_id='${sessionId}';`,
        ],
      ],
    ];
    // 逐条执行、不用事务：不同 Codex 版本的表结构不一致（如无 projection_state 表），
    // 放进同一事务会因一条报错整体回滚，连 threads 都删不掉。
    for (const [db, sqls] of stmts) {
      if (!fileExists(db)) continue;
      for (const sql of sqls) {
        try {
          await execFileAsync(bin, [db, `PRAGMA busy_timeout=5000; ${sql}`], {
            timeout: 30_000,
            maxBuffer: 16 * 1024 * 1024,
          });
        } catch {
          // 表不存在 / 加锁失败：跳过，不影响其它清理
        }
      }
    }
  }
}
