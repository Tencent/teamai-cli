/**
 * adapters/codebuddy-ide.ts — CodeBuddy IDE（图形化）适配器。
 *
 * 与 `codebuddy`（CLI）是**两套独立存储**，会话互不通用：
 *   - CLI: ~/.codebuddy/projects/<encoded-cwd>/<uuid>.jsonl
 *   - IDE: <userData>/CodeBuddyExtension/Data/<ext-id>/CodeBuddyIDE/<inst-id>/history/<md5(cwd)>/
 *
 * 绝大多数用户的日常会话在 IDE 侧（实测：IDE 1650 条 vs CLI 1 条），
 * 只支持 CLI 的话「从 codebuddy 迁出」基本无内容可迁。本适配器补上 IDE 侧的
 * 读 / 写 / 删，使两个平台各自闭环、互不隐式串写。
 *
 * IDE 存储要点：
 * - 工作区目录名 = md5(cwd)，**不可逆**。故 cwd 只能由调用方传入才能还原；
 *   未提供时 SessionMeta.cwd 记为 `md5:<hash>` 供展示与排错。
 * - conversation id = 32 位 hex（无横线）
 * - 消息顺序由 <convDir>/index.json 的 messages 数组决定，与文件名无关
 * - 消息文件 role 有三类：user / assistant / tool（tool-result 是独立消息）
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentAdapter, type SessionMeta } from './base.js';
import type { Session, Message, ContentBlock, ToolResultBlock } from '../ir.js';
import {
  findIdeHistoryDirs,
  findIdeConversationDirs,
  hashWorkspace,
  listIdeConversations,
  listIdeHistoryRoots,
  readIdeConversation,
  readIdeConversations,
  writeIdeSession,
  deleteIdeSession,
  type IdeConversationEntry,
  type IdeMessageParsed,
} from '../ide-history.js';
import { cleanTitleText, isInjectedText } from '../title.js';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * IDE 会话 id 是 32 位 hex（无横线），UUID 形式去掉横线即可等价。
 * 其他形态原样返回，交由目录查找失败后报错。
 */
function toConvId(sessionId: string): string {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(sessionId)) return sessionId.replace(/-/g, '').toLowerCase();
  return sessionId;
}

/** 会话未提供 cwd 时的占位表示，让 UI 与排错时能看出「来源工作区未知」。 */
function unknownWorkspace(hash: string): string {
  return `md5:${hash}`;
}

/** 标题兜底时最多看的消息条数（第一条通常就是用户提问）。 */
const TITLE_LOOKAHEAD = 8;

function firstUserText(messages: IdeMessageParsed[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const block of m.content) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      if (isInjectedText(block.text)) continue; // 整条是注入，看下一条
      const cleaned = cleanTitleText(block.text);
      if (cleaned) return cleaned;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// CodeBuddyIdeAdapter
// ---------------------------------------------------------------------------

export class CodeBuddyIdeAdapter extends AgentAdapter {
  readonly platform = 'codebuddy-ide';

  static isAvailable(): boolean {
    return listIdeHistoryRoots().length > 0;
  }

  isReady(): boolean {
    return listIdeHistoryRoots().length > 0;
  }

  static getDefaultStoragePath(): string {
    return listIdeHistoryRoots()[0] ?? '';
  }

  async listConversations(projectPath?: string): Promise<SessionMeta[]> {
    // 按 md5(cwd) 在工作区级过滤，而不是把 workspace 目录当成 history 根传下去
    // ——后者的子目录是会话目录，读出来的 index.json 没有 conversations 字段，
    // 结果永远是空列表（且要白读一遍全部会话级 index.json，慢且错）。
    const entries = listIdeConversations();
    const hash = projectPath ? hashWorkspace(projectPath) : null;
    const filtered = hash ? entries.filter((e) => e.workspaceHash === hash) : entries;

    return filtered.map((e) => this.toMeta(e, projectPath ?? ''));
  }

  private toMeta(entry: IdeConversationEntry, knownCwd: string): SessionMeta {
    let messageCount = 0;
    let sizeBytes = 0;
    const msgDir = path.join(entry.convDir, 'messages');
    try {
      for (const f of fs.readdirSync(msgDir)) {
        if (!f.endsWith('.json')) continue;
        messageCount++;
        try {
          sizeBytes += fs.statSync(path.join(msgDir, f)).size;
        } catch {
          // 单个文件 stat 失败不阻断统计
        }
      }
    } catch {
      // 目录不存在（会话刚建、未落盘）时按空会话处理
    }

    // 标题兜底只读开头几条：IDE 会话动辄几千条消息，为拿个标题把整会话读一遍
    // 会让列一次表耗时十几秒。
    const title =
      entry.name ||
      firstUserText(readIdeConversation(entry.convDir, TITLE_LOOKAHEAD)) ||
      `Session ${entry.id.slice(0, 8)}`;

    return {
      sessionId: entry.id,
      title,
      cwd: knownCwd || unknownWorkspace(entry.workspaceHash),
      platform: this.platform,
      createdAt: entry.createdAt || new Date().toISOString(),
      updatedAt: entry.lastMessageAt || entry.createdAt || new Date().toISOString(),
      messageCount,
      filePath: entry.convDir,
      sizeBytes,
    };
  }

  async readSession(sessionId: string, projectPath?: string): Promise<Session> {
    const convId = toConvId(sessionId);

    // 先按给定工作区定位，找不到再全局搜。
    // 会话 id 全局唯一，用户不必 cd 到当初的工作区才能迁出——
    // 而 IDE 的工作区目录名是 md5(cwd)，没有 projectPath 时根本无从限定。
    let convDir: string | undefined;
    let historyDir: string | undefined;
    let workspaceHash = '';
    // 全局兜底命中的会话不属于 projectPath——真实工作区是 md5 不可逆的，
    // cwd 只能标 md5 占位，绝不能冒充传入路径（否则归档键会跟着错）。
    let matchedGivenPath = false;

    if (projectPath) {
      for (const dir of findIdeHistoryDirs(projectPath)) {
        const candidate = path.join(dir, convId);
        if (fs.existsSync(candidate)) {
          convDir = candidate;
          historyDir = dir;
          workspaceHash = path.basename(dir);
          matchedGivenPath = true;
          break;
        }
      }
    }
    if (!convDir) {
      const found = findIdeConversationDirs(convId)[0];
      if (found) {
        convDir = found.convDir;
        historyDir = found.historyDir;
        workspaceHash = path.basename(found.historyDir);
      }
    }
    if (!convDir || !historyDir) {
      throw new Error(`CodeBuddy IDE session not found: session_id=${sessionId}`);
    }

    const entry = readIdeConversations(historyDir).find((e) => e.id === convId);
    const rawMessages = readIdeConversation(convDir);

    const messages: Message[] = [];
    const sessionMetadata: Record<string, unknown> = {};

    for (const raw of rawMessages) {
      if (raw.model && !sessionMetadata.model) sessionMetadata.model = raw.model;

      // IDE 的 tool-result 是独立 role:"tool" 消息，IR 没有该角色：
      // 与 CLI 适配器保持一致，归入上一条 user 消息（不存在则新建一条 user）。
      if (raw.role === 'tool') {
        for (const block of raw.content) {
          if (block.type !== 'tool-result') continue;
          const irBlock = this.parseToolResult(block);
          if (!irBlock) continue;
          const last = messages[messages.length - 1];
          if (last && last.role === 'user') {
            last.content.push(irBlock);
          } else {
            messages.push({ role: 'user', content: [irBlock] });
          }
        }
        continue;
      }

      const content = this.parseContent(raw);
      if (content.length === 0) continue;

      const msg: Message = {
        role: raw.role === 'assistant' ? 'assistant' : 'user',
        content,
        messageId: raw.id,
        timestamp: raw.createdAt,
      };
      if (raw.model) msg.metadata = { model: raw.model };
      messages.push(msg);
    }

    const title =
      entry?.name || firstUserText(rawMessages) || `Session ${convId.slice(0, 8)}`;
    const createdAt = entry?.createdAt || rawMessages[0]?.createdAt || new Date().toISOString();
    const updatedAt =
      entry?.lastMessageAt || rawMessages[rawMessages.length - 1]?.createdAt || createdAt;

    return {
      sessionId: convId,
      title,
      cwd: projectPath && matchedGivenPath ? projectPath : unknownWorkspace(workspaceHash),
      platform: this.platform,
      createdAt,
      updatedAt,
      messages,
      metadata: sessionMetadata,
    };
  }

  private parseContent(raw: IdeMessageParsed): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    for (const block of raw.content) {
      switch (block.type) {
        case 'text': {
          const text = String(block.text ?? '');
          if (text) blocks.push({ type: 'text', text });
          break;
        }
        case 'reasoning': {
          const text = String(block.text ?? block.reasoning ?? '');
          if (text) blocks.push({ type: 'thinking', text });
          break;
        }
        case 'tool-call': {
          const callId = String(block.toolCallId ?? block.id ?? '');
          const args = (block.args ?? block.arguments ?? {}) as Record<string, unknown>;
          blocks.push({
            type: 'tool_call',
            toolName: String(block.toolName ?? ''),
            callId,
            arguments: args,
          });
          break;
        }
        case 'tool-result': {
          const irBlock = this.parseToolResult(block);
          if (irBlock) blocks.push(irBlock);
          break;
        }
        default:
          // image / 文件引用等 IDE 特有块：IR 无对应类型，跳过（保真度统计会体现）
          break;
      }
    }

    return blocks;
  }

  private parseToolResult(block: Record<string, unknown>): ToolResultBlock | null {
    const callId = String(block.toolCallId ?? block.id ?? '');
    const result = block.result as Record<string, unknown> | undefined;
    const inner = result?.result as Record<string, unknown> | undefined;

    let content = '';
    if (typeof inner?.content === 'string') {
      content = inner.content;
    } else if (inner && typeof inner.content !== 'undefined') {
      content = JSON.stringify(inner.content);
    } else if (result) {
      content = JSON.stringify(result);
    }

    const isError =
      Boolean(block.isError) ||
      result?.status === 'failed' ||
      result?.success === false;

    return { type: 'tool_result', callId, content, isError };
  }

  async writeSession(session: Session, projectPath?: string): Promise<string> {
    const cwd = projectPath ?? session.cwd;

    // writeIdeSession 依赖 md5(cwd) 定位工作区；cwd 是 `md5:<hash>` 这类占位值时
    // 算不出 hash 会静默跳过。静默成功比失败更危险——用户以为迁完了，侧边栏却是空的。
    if (!cwd || !cwd.startsWith('/')) {
      throw new Error(
        `Writing to CodeBuddy IDE requires an absolute working directory, got "${cwd}". Pass --cwd/--target-cwd.`,
      );
    }

    const result = writeIdeSession(session, cwd);
    if (result.synced === 0 || !result.convId) {
      throw new Error(`CodeBuddy IDE write failed: ${result.skipped ?? 'no IDE history directory found'}`);
    }

    return result.convId;
  }

  async deleteSession(sessionId: string, projectPath?: string): Promise<boolean> {
    const cleaned = deleteIdeSession(sessionId, projectPath);
    return cleaned > 0;
  }
}
