/**
 * adapters/workbuddy.ts — WorkBuddy 平台适配器。
 *
 * 读取/写入 `~/.workbuddy/projects/<encoded-cwd>/<session-uuid>.jsonl` 格式。
 * cwd 编码: `/` → `-`，无前导 `-`（与 CodeBuddy 一致）。
 *
 * 实测格式（2026-09-10 本机 ~/.workbuddy/projects/... 采样）：
 *   {"id":"65d9...","logicalParentId":"65d9...","timestamp":1773734800538,
 *    "type":"message","role":"user","sessionId":"6d7b...",
 *    "content":[{"type":"input_text","text":"..."}],
 *    "providerData":{"references":[{"type":"memory","enabled":true,"memories":[]}]}}
 *
 * 行类型与 CodeBuddy 完全同构：
 *   message / function_call / function_call_result / reasoning / ai-title
 *
 * 增强点（vs CodeBuddy）：
 * - 同目录存在 `<uuid>.meta.json`，内含**真实 cwd**，优先于目录名反解
 *   （目录名编码不可逆：'-' 可能来自 '/'、空格等，反解有损）
 * - meta.json 还提供 createdAt / updatedAt，优先于从行内时间戳推断
 * - providerData 完整保留到 Message.metadata（含 memory references 等扩展字段）
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentAdapter, type SessionMeta } from './base.js';
import type { Session, Message, ContentBlock, ThinkingBlock, ToolCallBlock, ToolResultBlock } from '../ir.js';
import {
  getWorkBuddyProjectsDir,
  encodeCwdGeneric,
  decodeCwdGeneric,
  readJsonl,
  readJsonlHead,
  writeJsonl,
  fileExists,
  dirExists,
  removeDirRecursive,
} from '../fs.js';

// ---------------------------------------------------------------------------
// 工具名归一化映射
// ---------------------------------------------------------------------------

const WB_TO_IR_TOOL: Record<string, string> = {
  read_file: 'read_file',
  write_file: 'write_file',
  edit_file: 'edit_file',
  bash: 'bash',
  grep: 'grep',
  glob: 'glob',
  task: 'task',
  todo_write: 'todo_write',
};

const IR_TO_WB_TOOL: Record<string, string> = Object.fromEntries(
  Object.entries(WB_TO_IR_TOOL).map(([k, v]) => [v, k]),
);

function normalizeToolName(name: string): string {
  return WB_TO_IR_TOOL[name] ?? name;
}

function denormalizeToolName(irName: string): string {
  return IR_TO_WB_TOOL[irName] ?? irName;
}

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

function toUnixMs(isoStr?: string): number {
  if (!isoStr) return Date.now();
  const d = new Date(isoStr);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

function fromUnixMs(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// meta.json
// ---------------------------------------------------------------------------

interface WorkBuddyMeta {
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  sourceConversationId?: string;
  isPlayground?: boolean;
  migratedFrom?: string;
}

/**
 * 读取与会话 jsonl 同目录的 `<uuid>.meta.json`。
 * 缺失或损坏时返回空对象（调用方回退到目录名反解）。
 */
function readMeta(jsonlPath: string): WorkBuddyMeta {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
  try {
    if (!fileExists(metaPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    return {
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : undefined,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : undefined,
      sourceConversationId:
        typeof parsed.sourceConversationId === 'string' ? parsed.sourceConversationId : undefined,
      isPlayground: typeof parsed.isPlayground === 'boolean' ? parsed.isPlayground : undefined,
      migratedFrom: typeof parsed.migratedFrom === 'string' ? parsed.migratedFrom : undefined,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// WorkBuddyAdapter
// ---------------------------------------------------------------------------

export class WorkBuddyAdapter extends AgentAdapter {
  readonly platform = 'workbuddy';

  static isAvailable(): boolean {
    return dirExists(getWorkBuddyProjectsDir());
  }

  isReady(): boolean {
    return dirExists(getWorkBuddyProjectsDir());
  }

  static getDefaultStoragePath(): string {
    return getWorkBuddyProjectsDir();
  }

  private resolveProjectDir(projectPath?: string): string {
    const root = getWorkBuddyProjectsDir();
    if (projectPath) {
      return path.join(root, encodeCwdGeneric(projectPath));
    }
    return root;
  }

  private findSessionFile(sessionId: string, projectPath?: string): string | null {
    if (projectPath) {
      const target = path.join(this.resolveProjectDir(projectPath), `${sessionId}.jsonl`);
      return fileExists(target) ? target : null;
    }
    const root = getWorkBuddyProjectsDir();
    if (!dirExists(root)) return null;
    for (const projDir of fs.readdirSync(root)) {
      const candidate = path.join(root, projDir, `${sessionId}.jsonl`);
      if (fileExists(candidate)) return candidate;
    }
    return null;
  }

  async listConversations(projectPath?: string): Promise<SessionMeta[]> {
    const metas: SessionMeta[] = [];
    const root = getWorkBuddyProjectsDir();
    if (!dirExists(root)) return [];

    const projDirs = projectPath
      ? [this.resolveProjectDir(projectPath)]
      : fs.readdirSync(root).map((d) => path.join(root, d));

    for (const projDir of projDirs) {
      if (!dirExists(projDir)) continue;
      const fallbackCwd = decodeCwdGeneric(path.basename(projDir));
      for (const jsonlFile of fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl')).sort()) {
        const fullPath = path.join(projDir, jsonlFile);
        const meta = this.extractMeta(fullPath, fallbackCwd);
        if (meta) metas.push(meta);
      }
    }
    return metas;
  }

  private extractMeta(jsonlPath: string, fallbackCwd: string): SessionMeta | null {
    const sessionId = path.basename(jsonlPath, '.jsonl');
    const metaInfo = readMeta(jsonlPath);
    let title = '';
    let createdAt = metaInfo.createdAt !== undefined ? fromUnixMs(metaInfo.createdAt) : undefined;
    let updatedAt = metaInfo.updatedAt !== undefined ? fromUnixMs(metaInfo.updatedAt) : undefined;
    let messageCount = 0;
    let firstUserText = '';
    let aiTitle = '';

    try {
      for (const record of readJsonlHead(jsonlPath, 80)) {
        const rtype = record.type as string;

        if (rtype === 'ai-title') {
          aiTitle = String(record.aiTitle ?? '');
          continue;
        }

        // meta.json 未覆盖时才从行内推断
        const tsRaw = record.timestamp;
        if (tsRaw !== undefined) {
          const ts = fromUnixMs(Number(tsRaw));
          if (!createdAt) createdAt = ts;
          if (!metaInfo.updatedAt) updatedAt = ts;
        }

        if (rtype === 'message') {
          messageCount++;
          const role = record.role as string;
          if (role === 'user' && !firstUserText) {
            const content = record.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'input_text') {
                  firstUserText = String((block as Record<string, unknown>).text ?? '');
                  break;
                }
              }
            }
          }
        }
      }
    } catch {
      return null;
    }

    if (!createdAt) createdAt = new Date().toISOString();
    if (!updatedAt) updatedAt = createdAt;

    title = aiTitle || (firstUserText ? firstUserText.slice(0, 50) : `Session ${sessionId.slice(0, 8)}`);

    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(jsonlPath).size;
    } catch {
      // ignore
    }

    return {
      sessionId,
      title,
      cwd: metaInfo.cwd ?? fallbackCwd,
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
      throw new Error(`WorkBuddy 会话文件未找到: session_id=${sessionId}`);
    }

    const metaInfo = readMeta(jsonlPath);
    const cwd = metaInfo.cwd ?? decodeCwdGeneric(path.basename(path.dirname(jsonlPath)));
    const records = [...readJsonl(jsonlPath)];

    let title = '';
    let createdAt = metaInfo.createdAt !== undefined ? fromUnixMs(metaInfo.createdAt) : undefined;
    let updatedAt = metaInfo.updatedAt !== undefined ? fromUnixMs(metaInfo.updatedAt) : undefined;
    const sessionMetadata: Record<string, unknown> = {};
    const messages: Message[] = [];

    if (metaInfo.sourceConversationId) sessionMetadata.sourceConversationId = metaInfo.sourceConversationId;
    if (metaInfo.isPlayground !== undefined) sessionMetadata.isPlayground = metaInfo.isPlayground;
    if (metaInfo.migratedFrom) sessionMetadata.originator = metaInfo.migratedFrom;

    // 第一遍：提取 title/时间戳
    for (const rec of records) {
      const rtype = rec.type as string;

      if (rtype === 'ai-title') {
        title = String(rec.aiTitle ?? '');
        continue;
      }

      const tsRaw = rec.timestamp;
      if (tsRaw !== undefined) {
        const ts = fromUnixMs(Number(tsRaw));
        if (!createdAt) createdAt = ts;
        if (!metaInfo.updatedAt) updatedAt = ts;
      }
    }

    // 第二遍：构建消息
    for (const rec of records) {
      const rtype = rec.type as string;

      if (rtype === 'message') {
        const role = rec.role as string;
        if (role !== 'user' && role !== 'assistant') continue;

        const content = this.parseMessageContent(rec);
        const msg: Message = {
          role: role as 'user' | 'assistant',
          content,
          messageId: rec.id as string | undefined,
          parentId: rec.parentId as string | undefined,
          timestamp: rec.timestamp !== undefined ? fromUnixMs(Number(rec.timestamp)) : undefined,
        };

        // providerData 完整保留（含 memory references 等 WorkBuddy 扩展字段）
        const providerData = rec.providerData as Record<string, unknown> | undefined;
        if (providerData) {
          const md: Record<string, unknown> = { ...providerData };
          if (typeof providerData.model === 'string') {
            if (!sessionMetadata.model) sessionMetadata.model = providerData.model;
          }
          msg.metadata = md;
        }

        messages.push(msg);
      } else if (rtype === 'function_call') {
        const name = String(rec.name ?? '');
        const irName = normalizeToolName(name);
        const callId = String(rec.callId ?? rec.id ?? '');
        const providerData = rec.providerData as Record<string, unknown> | undefined;
        let argsRaw = providerData?.arguments ?? rec.arguments;
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
          messages.push({ role: 'assistant', content: [block] });
        }
      } else if (rtype === 'function_call_result') {
        const callId = String(rec.callId ?? '');
        const output = rec.output as Record<string, unknown> | undefined;
        let contentStr = '';
        if (output) {
          contentStr = String(output.text ?? '');
        }
        const status = String(rec.status ?? 'completed');
        const isError = status === 'failed' || status === 'error';
        const block: ToolResultBlock = { type: 'tool_result', callId, content: contentStr, isError };

        if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
          messages[messages.length - 1].content.push(block);
        } else {
          messages.push({ role: 'user', content: [block] });
        }
      } else if (rtype === 'reasoning') {
        const rawContent = rec.rawContent as Array<Record<string, unknown>> | undefined;
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
          messages.push({ role: 'assistant', content: [block] });
        }
      }
    }

    if (!title) {
      for (const msg of messages) {
        if (msg.role === 'user') {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              title = block.text.slice(0, 50);
              break;
            }
          }
          if (title) break;
        }
      }
    }
    if (!title) title = `Session ${sessionId.slice(0, 8)}`;

    if (!createdAt) createdAt = new Date().toISOString();
    if (!updatedAt) updatedAt = createdAt;

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

  private parseMessageContent(rec: Record<string, unknown>): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    const contentArr = rec.content;

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
    let sessionId = session.sessionId;
    if (!isUuidV4(sessionId)) {
      sessionId = uuidV4();
    }

    const cwd = projectPath ?? session.cwd;
    const projDir = path.join(getWorkBuddyProjectsDir(), encodeCwdGeneric(cwd));
    const jsonlPath = path.join(projDir, `${sessionId}.jsonl`);

    const records: Record<string, unknown>[] = [];

    // 1. ai-title 行
    records.push({
      timestamp: toUnixMs(session.createdAt),
      type: 'ai-title',
      aiTitle: session.title,
      sessionId,
      cwd,
    });

    let parentId: string | null = null;

    for (const msg of session.messages) {
      const msgId = msg.messageId ?? uuidV4();

      const thinkingBlocks = msg.content.filter((b) => b.type === 'thinking');
      const otherBlocks = msg.content.filter((b) => b.type !== 'thinking');

      // reasoning 行
      for (const tb of thinkingBlocks) {
        const reasoningId = uuidV4();
        records.push({
          id: reasoningId,
          parentId,
          timestamp: toUnixMs(msg.timestamp),
          type: 'reasoning',
          providerData: msg.metadata?.model ? { model: msg.metadata.model } : {},
          content: [],
          rawContent: [{ type: 'reasoning_text', text: (tb as ThinkingBlock).text }],
          sessionId,
          cwd,
        });
        parentId = reasoningId;
      }

      // message 行
      if (otherBlocks.length > 0) {
        const wbContent: Record<string, unknown>[] = [];
        let hasText = false;
        for (const block of otherBlocks) {
          if (block.type === 'text') {
            wbContent.push({
              type: msg.role === 'user' ? 'input_text' : 'output_text',
              text: block.text,
            });
            hasText = true;
          }
        }

        if (hasText) {
          records.push({
            id: msgId,
            parentId,
            timestamp: toUnixMs(msg.timestamp),
            type: 'message',
            role: msg.role,
            status: 'completed',
            content: wbContent,
            providerData: msg.metadata?.model ? { model: msg.metadata.model } : {},
            sessionId,
            cwd,
          });
          parentId = msgId;
        }
      }

      // function_call 行
      for (const block of otherBlocks) {
        if (block.type === 'tool_call') {
          const fcId = block.callId || uuidV4();
          records.push({
            id: fcId,
            parentId,
            timestamp: toUnixMs(msg.timestamp),
            type: 'function_call',
            name: denormalizeToolName(block.toolName),
            callId: block.callId,
            providerData: {
              arguments: block.arguments,
              ...(msg.metadata?.model ? { model: msg.metadata.model } : {}),
            },
            sessionId,
            cwd,
          });
          parentId = fcId;
        }
      }

      // function_call_result 行
      for (const block of otherBlocks) {
        if (block.type === 'tool_result') {
          const fcrId = uuidV4();
          records.push({
            id: fcrId,
            parentId,
            timestamp: toUnixMs(msg.timestamp),
            type: 'function_call_result',
            name: 'Agent',
            callId: block.callId,
            status: block.isError ? 'failed' : 'completed',
            output: { type: 'text', text: block.content },
            sessionId,
            cwd,
          });
          parentId = fcrId;
        }
      }
    }

    writeJsonl(jsonlPath, records);

    // 写入 meta.json —— 保留真实 cwd，使后续读取无需依赖有损的目录名反解
    try {
      const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
      fs.writeFileSync(
        metaPath,
        JSON.stringify(
          {
            createdAt: toUnixMs(session.createdAt),
            updatedAt: toUnixMs(session.updatedAt),
            cwd,
            sourceConversationId: sessionId,
          },
          null,
          2,
        ),
        'utf-8',
      );
    } catch {
      // meta.json 写入失败不影响主流程
    }

    return sessionId;
  }

  async deleteSession(sessionId: string, projectPath?: string): Promise<void> {
    const jsonlPath = this.findSessionFile(sessionId, projectPath);
    if (!jsonlPath) return;

    try {
      fs.unlinkSync(jsonlPath);
    } catch {
      // ignore
    }

    const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
    if (fileExists(metaPath)) {
      try {
        fs.unlinkSync(metaPath);
      } catch {
        // ignore
      }
    }

    // 删除同名子目录（subagents 等）
    const subdir = jsonlPath.replace(/\.jsonl$/, '');
    if (dirExists(subdir)) {
      removeDirRecursive(subdir);
    }
  }
}
