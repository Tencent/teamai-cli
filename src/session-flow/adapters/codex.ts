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
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentAdapter, type SessionMeta } from './base.js';
import type { Session, Message, ContentBlock, TextBlock, ThinkingBlock, ToolCallBlock, ToolResultBlock } from '../ir.js';
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
  // 前 48 位时间戳左移 80 位
  let uuidInt = BigInt(timestampMs & 0xffffffffffff) << 80n;
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

      // 统计消息数（快速扫描 response_item:message）
      let messageCount = 0;
      try {
        for (const rec of readJsonlHead(f, 200)) {
          if (rec.type === 'response_item') {
            const payload = (rec.payload as Record<string, unknown>) ?? {};
            if (payload.type === 'message') messageCount++;
          }
        }
      } catch {
        // ignore
      }

      metas.push({
        sessionId,
        title,
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
    // session_id: 确保是 UUIDv7
    let sessionId = session.sessionId;
    if (!isUuidV7(sessionId)) {
      sessionId = generateUuidV7();
    }

    // 损坏输入防御：session.createdAt 非法时 new Date(...) 得到 Invalid Date，
    // 直接 toISOString() 会抛 RangeError 让整个写入崩溃。
    const rawCreated = new Date(session.createdAt);
    const createdAt = isNaN(rawCreated.getTime()) ? new Date() : rawCreated;
    const tsIso = createdAt.toISOString();
    const tsMs = createdAt.getTime();
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
    records.push({
      timestamp: tsIso,
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp: tsMs,
        cwd: projectPath ?? session.cwd,
        originator: 'sessionflow',
        cli_version: '0.1.0',
        source: 'migration',
      },
    });

    // 2. 遍历 messages，写 response_item + turn_context + event_msg
    let turnId = generateUuidV7();
    let turnStarted = false;
    // 消息原生时间戳优先——全部用迁移时刻会让时间线塌缩成一点，
    // 经 claude-code 中转后甚至无法恢复先后顺序
    let lastTs = tsIso;

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
              completed_at: Math.floor(new Date(msgTs).getTime() / 1000),
            },
          });
        }
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
          },
        });
        turnStarted = true;
      }

      // 写消息的每个 content block
      for (const block of msg.content) {
        const rec = this.blockToResponseItem(msg.role, block, msgTs);
        if (rec) records.push(rec);
      }
    }

    // 最后一个 turn 的 task_complete
    if (turnStarted) {
      records.push({
        timestamp: lastTs,
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: turnId,
          completed_at: Math.floor(new Date(lastTs).getTime() / 1000),
        },
      });
    }

    writeJsonl(filePath, records);
    return sessionId;
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
            role,
            content: [{ type: contentType, text: block.text }],
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
            content: [],
            rawContent: [{ type: 'reasoning_text', text: block.text }],
          },
        };
      }
    }
  }

  async deleteSession(sessionId: string, projectPath?: string): Promise<void> {
    const f = this.findSessionFile(sessionId);
    if (f && fileExists(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
  }
}
