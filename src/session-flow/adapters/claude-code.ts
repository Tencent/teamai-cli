/**
 * adapters/claude-code.ts — Claude Code 平台适配器。
 *
 * 读取/写入 `~/.claude/projects/<encoded-cwd>/<session>.jsonl` 格式。
 *
 * JSONL 行类型（13 种）：
 *   读取：user/assistant → IR Message；其余 11 种跳过
 *   写入：user/assistant + mode + permission-mode + file-history-snapshot +
 *         attachment + last-prompt（6 种辅助行确保 CC 能加载）
 *
 * DAG 拍平：按 parentUuid 构建主链，跳过 isSidechain=true 的侧链。
 *
 * 增强点（vs Python 版）：
 * - 写入时生成 last-prompt 行（CC --resume 依赖）
 * - 写入时生成 attachment 行（工具/MCP/Agent 清单占位）
 * - 写入时生成 file-history-snapshot 行（文件历史占位）
 * - 写入时生成 mode + permission-mode 行
 * - thinking 块保留 signature
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentAdapter, type SessionMeta } from './base.js';
import type { Session, Message, ContentBlock, TextBlock, ThinkingBlock, ToolCallBlock, ToolResultBlock } from '../ir.js';
import { deriveTargetSessionId } from '../ids.js';
import { imagePlaceholderText } from '../ir.js';
import {
  getClaudeCodeProjectsDir,
  encodeCwdClaude,
  bestEffortDecodeCwdClaude,
  decodeCwdClaude,
  readJsonl,
  readJsonlHead,
  writeJsonl,
  fileExists,
  dirExists,
  scanFiles,
  removeDirRecursive,
} from '../fs.js';
import {
  cleanTitleText,
  fallbackTitle,
  isInjectedText,
  titleFromCandidates,
  titleFromUserText,
} from '../title.js';

// ---------------------------------------------------------------------------
// 工具名归一化映射
// ---------------------------------------------------------------------------

const CC_TO_IR_TOOL: Record<string, string> = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  MultiEdit: 'multi_edit',
  Bash: 'bash',
  Glob: 'glob',
  Grep: 'grep',
  WebSearch: 'web_search',
  WebFetch: 'web_fetch',
  Task: 'task',
  TodoWrite: 'todo_write',
  NotebookEdit: 'notebook_edit',
  LSP: 'lsp',
  ListMcpResourcesTool: 'list_mcp_resources',
};

const IR_TO_CC_TOOL: Record<string, string> = Object.fromEntries(
  Object.entries(CC_TO_IR_TOOL).map(([k, v]) => [v, k]),
);

function normalizeToolName(ccName: string): string {
  return CC_TO_IR_TOOL[ccName] ?? ccName;
}

function denormalizeToolName(irName: string): string {
  return IR_TO_CC_TOOL[irName] ?? irName;
}

// CC 默认工具清单（用于 attachment 行的 deferred_tools_delta.addedNames）
// CC 加载会话时需要这个清单来重建工具上下文
const CC_DEFAULT_TOOLS = [
  'Bash',
  'Glob',
  'Grep',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebSearch',
  'WebFetch',
  'Task',
  'TodoWrite',
  'LSP',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
];

// ---------------------------------------------------------------------------
// 读取时跳过的行类型
// ---------------------------------------------------------------------------

const SKIP_TYPES = new Set([
  'last-prompt',
  'mode',
  'permission-mode',
  'file-history-snapshot',
  'file-history-delta',
  'attachment',
  'queue-operation',
  'system',
  'atis-latch',
  'cost-state',
]);

// ---------------------------------------------------------------------------
// UUID / 时间戳工具
// ---------------------------------------------------------------------------

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuidV4(s: string): boolean {
  return UUID_V4_RE.test(s);
}

function uuidV4(): string {
  return crypto.randomUUID();
}

/**
 * 解析 CC 的 ISO8601 带 Z 后缀时间戳。
 */
function parseCcTimestamp(tsStr: string | undefined): string | undefined {
  if (!tsStr) return undefined;
  try {
    // 验证可解析
    const d = new Date(tsStr);
    if (isNaN(d.getTime())) return undefined;
    return tsStr;
  } catch {
    return undefined;
  }
}

/**
 * 格式化为 CC 时间戳（毫秒精度，带 Z 后缀）。
 */
function toCcTimestamp(isoStr: string | undefined): string {
  const d = isoStr ? new Date(isoStr) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// content 块解析（CC → IR）
// ---------------------------------------------------------------------------

function parseCcContentBlocks(content: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (typeof content === 'string') {
    blocks.push({ type: 'text', text: content });
    return blocks;
  }

  if (!Array.isArray(content)) return blocks;

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const btype = b.type as string;

    if (btype === 'thinking') {
      blocks.push({
        type: 'thinking',
        text: String(b.thinking ?? ''),
        ...(b.signature ? { signature: String(b.signature) } : {}),
      });
    } else if (btype === 'text') {
      blocks.push({ type: 'text', text: String(b.text ?? '') });
    } else if (btype === 'tool_use') {
      blocks.push({
        type: 'tool_call',
        toolName: normalizeToolName(String(b.name ?? '')),
        callId: String(b.id ?? ''),
        arguments: (b.input as Record<string, unknown>) ?? {},
      });
    } else if (btype === 'tool_result') {
      let rawContent = b.content;
      if (Array.isArray(rawContent)) {
        const parts: string[] = [];
        for (const part of rawContent) {
          if (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text') {
            parts.push(String((part as Record<string, unknown>).text ?? ''));
          } else if (typeof part === 'string') {
            parts.push(part);
          }
        }
        rawContent = parts.join('\n');
      } else if (typeof rawContent !== 'string') {
        rawContent = rawContent == null ? '' : String(rawContent);
      }
      blocks.push({
        type: 'tool_result',
        callId: String(b.tool_use_id ?? ''),
        content: rawContent as string,
        isError: Boolean(b.is_error ?? false),
      });
    } else if (btype === 'image') {
      // 用户贴进输入框的截图：Anthropic 格式是
      // {type:'image', source:{type:'base64', media_type, data}}（也可能 {type:'url', url}）。
      // 不解析的话图片既不进 IR 也不写进目标，保真度还照样算 100%（静默漏报）。
      const src = b.source as Record<string, unknown> | undefined;
      const data = typeof src?.data === 'string' ? src.data : undefined;
      const url = typeof b.url === 'string' ? b.url : (typeof src?.url === 'string' ? src.url : undefined);
      if (!data && !url) continue;
      blocks.push({
        type: 'image',
        mimeType: String(src?.media_type ?? 'image/png'),
        // base64 直接带；纯 URL 形态只留指针（写入侧按目标能力降级）
        ...(data ? { data } : {}),
        ...(url ? { filePath: url } : {}),
        label: guessImageLabel(String(src?.media_type ?? 'image/png')),
      });
    }
  }
  return blocks;
}

/** 内联图片没有文件名，按 mime 给一个可读的占位名（写回/降级占位符用）。 */
function guessImageLabel(mimeType: string): string {
  const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
  return `image.${ext}`;
}

// ---------------------------------------------------------------------------
// content 块序列化（IR → CC）
// ---------------------------------------------------------------------------

function irBlockToCc(block: ContentBlock): Record<string, unknown> | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.text,
        ...(block.signature ? { signature: block.signature } : {}),
      };
    case 'tool_call':
      return {
        type: 'tool_use',
        id: block.callId,
        name: denormalizeToolName(block.toolName),
        input: block.arguments,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.callId,
        content: block.content,
        is_error: block.isError,
      };
    case 'image': {
      // CC 原生支持用户消息里的 base64 图片块。data 缺失（源文件读不到）时
      // 从 filePath 现读；再不行降级占位文本，绝不静默丢块。
      let data = block.data;
      if (!data && block.filePath) {
        try {
          data = fs.readFileSync(block.filePath).toString('base64');
        } catch {
          data = undefined;
        }
      }
      if (!data) return { type: 'text', text: imagePlaceholderText(block) };
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mimeType, data },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// ClaudeCodeAdapter
// ---------------------------------------------------------------------------

export class ClaudeCodeAdapter extends AgentAdapter {
  readonly platform: string;
  private readonly storageRoot: string;

  /**
   * @param platform 平台标识（默认 'claude-code'，变体可传 'claude-internal' / 'tclaude'）
   * @param storageRoot 存储根路径（默认 ~/.claude/projects，变体传 ~/.claude-internal/projects 等）
   */
  constructor(platform = 'claude-code', storageRoot?: string) {
    super();
    this.platform = platform;
    this.storageRoot = storageRoot ?? getClaudeCodeProjectsDir();
  }

  static isAvailable(): boolean {
    return dirExists(getClaudeCodeProjectsDir());
  }

  static getDefaultStoragePath(): string {
    return getClaudeCodeProjectsDir();
  }

  isReady(): boolean {
    return dirExists(this.storageRoot);
  }

  private resolveProjectDir(projectPath?: string): string {
    if (projectPath) {
      return path.join(this.storageRoot, encodeCwdClaude(projectPath));
    }
    return this.storageRoot;
  }

  private findSessionFile(sessionId: string, projectPath?: string): string | null {
    if (projectPath) {
      const target = path.join(this.resolveProjectDir(projectPath), `${sessionId}.jsonl`);
      return fileExists(target) ? target : null;
    }
    // 遍历所有编码目录
    if (!dirExists(this.storageRoot)) return null;
    for (const projDir of fs.readdirSync(this.storageRoot)) {
      const candidate = path.join(this.storageRoot, projDir, `${sessionId}.jsonl`);
      if (fileExists(candidate)) return candidate;
    }
    return null;
  }

  async listConversations(projectPath?: string): Promise<SessionMeta[]> {
    const metas: SessionMeta[] = [];
    const root = this.storageRoot;
    if (!dirExists(root)) return [];

    const projDirs = projectPath
      ? [this.resolveProjectDir(projectPath)]
      : fs.readdirSync(root).map((d) => path.join(root, d));

    for (const projDir of projDirs) {
      if (!dirExists(projDir)) continue;
      const cwd = bestEffortDecodeCwdClaude(path.basename(projDir)) ?? decodeCwdClaude(path.basename(projDir));
      for (const jsonlFile of fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl')).sort()) {
        const fullPath = path.join(projDir, jsonlFile);
        const meta = this.extractMeta(fullPath, cwd);
        if (meta) metas.push(meta);
      }
    }
    return metas;
  }

  private extractMeta(jsonlPath: string, cwd: string): SessionMeta | null {
    const sessionId = path.basename(jsonlPath, '.jsonl');
    let title = '';
    let createdAt: string | undefined;
    let updatedAt: string | undefined;
    let messageCount = 0;
    const userTextCandidates: string[] = [];
    let summaryTitle = '';

    try {
      // 50 行常常全是注入块（system-reminder / 命令记录 / snapshot），预算不够会让
      // 有真实提问的会话也 fallback 成 "Session <id>"；200 行与 codex/workbuddy 对齐。
      for (const record of readJsonlHead(jsonlPath, 200)) {
        const rtype = record.type as string;
        const ts = parseCcTimestamp(record.timestamp as string);

        if (ts) {
          if (!createdAt) createdAt = ts;
          updatedAt = ts;
        }

        if (rtype === 'summary' && !summaryTitle) {
          summaryTitle = String(record.summary ?? '');
        }

        if (rtype === 'user' || rtype === 'assistant') {
          messageCount++;
          if (rtype === 'user' && userTextCandidates.length < 5) {
            const msg = record.message as Record<string, unknown> | undefined;
            const content = msg?.content;
            if (typeof content === 'string') {
              userTextCandidates.push(content);
            } else if (Array.isArray(content)) {
              const parts: string[] = [];
              for (const block of content) {
                if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
                  parts.push(String((block as Record<string, unknown>).text ?? ''));
                }
              }
              if (parts.length) userTextCandidates.push(parts.join(' '));
            }
          }
        }
      }
    } catch {
      return null;
    }

    if (!createdAt) createdAt = new Date().toISOString();
    if (!updatedAt) updatedAt = createdAt;

    // 标题：summary 行（CC /resume 用的就是它）> 用户文本解包 > id 兜底。
    // 不再按「整条是否注入」跳过——<command-name> 等注入头后跟真实提问的混合消息
    // 会被整条丢掉；titleFromUserText 能解 <user_query> 包裹并剥元信息。
    title = summaryTitle ? cleanTitleText(summaryTitle) : '';
    if (!title) title = titleFromCandidates(userTextCandidates);
    if (!title) title = fallbackTitle(sessionId);

    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(jsonlPath).size;
    } catch {
      // ignore
    }

    return {
      sessionId,
      title,
      cwd,
      platform: this.platform,
      createdAt,
      updatedAt,
      messageCount,
      filePath: jsonlPath,
      sizeBytes,
    };
  }

  async readSession(sessionId: string, projectPath?: string): Promise<Session> {
    const jsonlPath = this.findSessionFile(sessionId, projectPath);
    if (!jsonlPath) {
      throw new Error(`Claude Code session file not found: session_id=${sessionId}, project_path=${projectPath ?? 'undefined'}`);
    }

    const cwd =
      bestEffortDecodeCwdClaude(path.basename(path.dirname(jsonlPath))) ??
      decodeCwdClaude(path.basename(path.dirname(jsonlPath)));

    // 收集所有消息记录
    const rawRecords: Record<string, unknown>[] = [];
    let nativeCwd: string | undefined;
    let summaryTitle: string | undefined;
    for (const record of readJsonl(jsonlPath)) {
      const rtype = record.type as string;
      if (rtype === 'summary') {
        // writeSession 落盘的标题行（CC /resume 也以它为准）。读取侧不认的话，
        // roundtrip 后标题会漂移成首条用户文本（可能是注入清洗后的残句）。
        const t = String(record.summary ?? '');
        if (t) summaryTitle = t; // 取最后一条（writeSession 追加在文件末尾）
        continue;
      }
      if (SKIP_TYPES.has(rtype)) continue;
      if (rtype !== 'user' && rtype !== 'assistant') continue;
      // 每条消息记录都带真实 cwd（绝对路径）。目录名解码是有损的
      // （`-` 可能来自 `/` 或空格），归档键（repoIdentity）必须优先用
      // 记录里的原生 cwd（设计文档 Key invariant）；恢复失败退回解码目录名。
      if (nativeCwd === undefined && typeof record.cwd === 'string' && path.isAbsolute(record.cwd)) {
        nativeCwd = record.cwd;
      }
      rawRecords.push(record);
    }
    // 记录里的 cwd 有时是编码目录名（`-Users-foo-project`），不是真实路径：
    // 反解成真实工作区，迁移才能「保持源会话的工作区」而不是回退到当前目录。
    const sessionCwd = nativeCwd ?? bestEffortDecodeCwdClaude(cwd) ?? cwd;

    // DAG 拍平
    const messages = this.flattenDag(rawRecords);

    // 提取标题：优先 summary 标题行（写入侧落盘、CC /resume 亦采用），
    // 其次用户文本解包（注入头 + 真实提问的混合消息也能解），最后退回 id 前缀。
    let title = summaryTitle ? cleanTitleText(summaryTitle) : '';
    if (!title) {
      const candidates: string[] = [];
      for (const msg of messages) {
        if (msg.role !== 'user') continue;
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) candidates.push(block.text);
        }
        if (candidates.length >= 5) break;
      }
      title = titleFromCandidates(candidates);
    }
    if (!title) title = fallbackTitle(sessionId);

    // 时间戳
    let createdAt: string | undefined;
    let updatedAt: string | undefined;
    for (const record of rawRecords) {
      const ts = parseCcTimestamp(record.timestamp as string);
      if (ts) {
        if (!createdAt) createdAt = ts;
        updatedAt = ts;
      }
    }
    if (!createdAt) createdAt = new Date().toISOString();
    if (!updatedAt) updatedAt = createdAt;

    // 元数据
    const metadata: Record<string, unknown> = {};
    for (let i = rawRecords.length - 1; i >= 0; i--) {
      if (rawRecords[i].type === 'assistant') {
        const msg = rawRecords[i].message as Record<string, unknown> | undefined;
        const model = msg?.model as string | undefined;
        if (model) {
          metadata.model = model;
          break;
        }
      }
    }

    return {
      sessionId,
      title,
      cwd: sessionCwd,
      platform: this.platform,
      createdAt,
      updatedAt,
      messages,
      metadata,
    };
  }

  /**
   * DAG 拍平：按 parentUuid 构建主链，跳过 isSidechain=true 的侧链。
   *
   * 注意：parentUuid 链可能经过被跳过的行类型（attachment/file-history-snapshot 等），
   * 导致链断裂。对于 parentUuid 指向不存在记录的 orphan 节点，将它们作为根节点处理。
   */
  private flattenDag(rawRecords: Record<string, unknown>[]): Message[] {
    // 过滤侧链
    const mainChain = rawRecords.filter((r) => !r.isSidechain);

    // uuid → record（仅主链记录）
    const uuidToRecord = new Map<string, Record<string, unknown>>();
    for (const record of mainChain) {
      const uid = record.uuid as string | undefined;
      if (uid) uuidToRecord.set(uid, record);
    }

    // parentUuid → children
    const childrenMap = new Map<string | null, Record<string, unknown>[]>();
    const roots: Record<string, unknown>[] = [];
    for (const record of mainChain) {
      const parent = (record.parentUuid as string | null | undefined) ?? null;
      if (parent === null) {
        roots.push(record);
      } else if (uuidToRecord.has(parent)) {
        // parent 在主链中
        if (!childrenMap.has(parent)) childrenMap.set(parent, []);
        childrenMap.get(parent)!.push(record);
      } else {
        // parent 不在主链中（被跳过的行类型），作为根节点处理
        roots.push(record);
      }
    }

    // BFS 遍历主链
    const ordered: Record<string, unknown>[] = [];
    const visited = new Set<string>();
    const queue: Record<string, unknown>[] = [...roots];

    while (queue.length > 0) {
      const record = queue.shift()!;
      const uid = record.uuid as string | undefined;
      if (uid && visited.has(uid)) continue;
      if (uid) visited.add(uid);
      ordered.push(record);
      if (uid) {
        queue.push(...(childrenMap.get(uid) ?? []));
      }
    }

    // 转换为 IR Message
    const messages: Message[] = [];
    for (const record of ordered) {
      const msg = this.recordToMessage(record);
      if (msg) messages.push(msg);
    }
    return messages;
  }

  private recordToMessage(record: Record<string, unknown>): Message | null {
    const rtype = record.type as string;
    if (rtype !== 'user' && rtype !== 'assistant') return null;

    const msgObj = record.message as Record<string, unknown> | undefined;
    if (!msgObj || typeof msgObj !== 'object') return null;

    const content = msgObj.content;
    const blocks = parseCcContentBlocks(content);

    const timestamp = parseCcTimestamp(record.timestamp as string);
    const messageId = record.uuid as string | undefined;
    const parentId = record.parentUuid as string | undefined;

    const metadata: Message['metadata'] = {};
    if (rtype === 'assistant') {
      const model = msgObj.model as string | undefined;
      if (model) metadata.model = model;
    }
    if (record.isMeta) metadata.isMeta = true;
    if (record.promptId) metadata.promptId = record.promptId as string;

    return {
      role: rtype as 'user' | 'assistant',
      content: blocks,
      timestamp,
      messageId,
      parentId,
      metadata,
    };
  }

  async writeSession(session: Session, projectPath?: string): Promise<string> {
    // 确定 session_id（必须是 UUIDv4）：已是 v4 则沿用，否则确定性派生——
    // 随机生成会让重复迁移产生 id 不同、内容相同的重复会话。
    const sessionId = isUuidV4(session.sessionId)
      ? session.sessionId
      : deriveTargetSessionId(this.platform, session.sessionId);

    // 确定目标目录
    const cwd = projectPath ?? session.cwd;
    const projDir = path.join(this.storageRoot, encodeCwdClaude(cwd));
    const jsonlPath = path.join(projDir, `${sessionId}.jsonl`);

    // 生成 JSONL 记录（含辅助行）
    const records = this.sessionToCcRecords(session, sessionId, cwd);
    writeJsonl(jsonlPath, records);

    return sessionId;
  }

  /**
   * 将 IR Session 转换为 CC JSONL 记录列表（含辅助行）。
   *
   * 辅助行生成顺序：
   * 1. mode 行（首行）
   * 2. permission-mode 行
   * 3. 消息行（user/assistant），每条消息后跟 file-history-snapshot
   * 4. 首条 assistant 消息前插入 attachment 行（空工具清单）
   * 5. last-prompt 行（末行）
   */
  private sessionToCcRecords(session: Session, sessionId: string, cwd: string): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = [];
    let parentUuid: string | null = null;
    let firstAssistantUuid: string | null = null;
    let lastUserUuid: string | null = null;
    let lastUserText = '';

    // 1. mode 行
    records.push({
      type: 'mode',
      mode: 'normal',
      sessionId,
    });

    // 2. permission-mode 行
    records.push({
      type: 'permission-mode',
      permissionMode: 'default',
      sessionId,
    });

    for (const msg of session.messages) {
      const msgUuid = msg.messageId ?? uuidV4();

      // 构建 content 块
      const ccBlocks: Record<string, unknown>[] = [];
      for (const block of msg.content) {
        const ccBlock = irBlockToCc(block);
        if (ccBlock) ccBlocks.push(ccBlock);
      }

      // CC 消息对象
      const ccMessage: Record<string, unknown> = { role: msg.role, content: ccBlocks };
      if (msg.role === 'assistant') {
        ccMessage.model = msg.metadata?.model ?? 'claude-sonnet-4-20250514';
      }

      // 首条 assistant 消息前插入 attachment 行
      if (msg.role === 'assistant' && firstAssistantUuid === null) {
        firstAssistantUuid = msgUuid;
        const attachmentUuid = uuidV4();
        records.push({
          parentUuid,
          isSidechain: false,
          attachment: {
            type: 'deferred_tools_delta',
            addedNames: CC_DEFAULT_TOOLS,
          },
          uuid: attachmentUuid,
          timestamp: toCcTimestamp(msg.timestamp),
          cwd,
          sessionId,
          version: '2.1.221',
          gitBranch: session.metadata?.gitBranch ?? '',
          userType: 'external',
          entrypoint: 'cli',
        });
        parentUuid = attachmentUuid;
      }

      // 消息行
      const record: Record<string, unknown> = {
        parentUuid,
        isSidechain: false,
        type: msg.role,
        message: ccMessage,
        uuid: msgUuid,
        timestamp: toCcTimestamp(msg.timestamp),
        cwd,
        sessionId,
        version: '2.1.221',
        gitBranch: session.metadata?.gitBranch ?? '',
        userType: 'external',
        entrypoint: 'cli',
      };
      if (msg.metadata?.isMeta) record.isMeta = true;
      if (msg.metadata?.promptId) record.promptId = msg.metadata.promptId;

      records.push(record);
      parentUuid = msgUuid;

      // file-history-snapshot 行（每条消息后）
      records.push({
        type: 'file-history-snapshot',
        messageId: msgUuid,
        snapshot: {
          messageId: msgUuid,
          trackedFileBackups: {},
          timestamp: toCcTimestamp(msg.timestamp),
        },
        isSnapshotUpdate: false,
      });

      // 记录最后一条 user 消息
      if (msg.role === 'user') {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            lastUserText = block.text;
            lastUserUuid = msgUuid;
            break;
          }
        }
      }
    }

    // 3. last-prompt 行（末尾）
    records.push({
      type: 'last-prompt',
      lastPrompt: lastUserText,
      leafUuid: lastUserUuid ?? parentUuid,
      sessionId,
    });

    // 4. summary 行（标题）
    // Claude Code 的 /resume 列表靠 type:"summary" 记录显示会话标题，
    // 缺失时退回显示 session id 前缀（如 824ff784），迁移来的会话全中招。
    // 源适配器读出的 title 已经过注入清洗，这里直接落盘。
    const summary = cleanTitleText(session.title ?? '') || fallbackTitle(sessionId);
    if (summary) {
      records.push({
        type: 'summary',
        summary,
        leafUuid: parentUuid,
        sessionId,
      });
    }

    return records;
  }

  async deleteSession(sessionId: string, projectPath?: string): Promise<void> {
    const jsonlPath = this.findSessionFile(sessionId, projectPath);
    if (!jsonlPath) return;

    try {
      fs.unlinkSync(jsonlPath);
    } catch {
      // ignore
    }

    // 删除同名子目录
    const subdir = jsonlPath.replace(/\.jsonl$/, '');
    if (dirExists(subdir)) {
      removeDirRecursive(subdir);
    }
  }
}
