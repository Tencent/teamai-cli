/**
 * adapters/cursor.ts — Cursor 平台适配器。
 *
 * 读取/写入 `~/.cursor/projects/<encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl` 格式。
 * cwd 编码: `/` → `-`，无前导 `-`。
 *
 * JSONL 行类型（2 种）：
 *   - 消息行（无 type 字段）：{role, message:{content:[block...]}}
 *   - turn_ended 行：{type:"turn_ended", status:"success"}
 *
 * 特点：
 * - 消息行没有 type 字段，靠 role + message 结构识别
 * - content block 类型：text / tool_use（无 tool_result，工具结果不写入 transcript）
 * - 迁移时 ToolResultBlock 降级为 TextBlock
 *
 * 增强点（vs Python 版）：
 * - 写入时生成 turn_ended 行
 * - 目录结构正确创建 agent-transcripts/<uuid>/
 * - tool_result 降级处理
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentAdapter, type SessionMeta } from './base.js';
import type { Session, Message, ContentBlock, TextBlock, ToolCallBlock, ToolResultBlock, ThinkingBlock } from '../ir.js';
import {
  getCursorProjectsDir,
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

const CURSOR_TO_IR_TOOL: Record<string, string> = {
  ReadFile: 'read_file',
  Read: 'read_file',
  WriteFile: 'write_file',
  Write: 'write_file',
  EditFile: 'edit_file',
  Edit: 'edit_file',
  Shell: 'bash',
  Grep: 'grep',
  Glob: 'glob',
  DeleteFile: 'delete_file',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
  SemanticSearch: 'semantic_search',
};

const IR_TO_CURSOR_TOOL: Record<string, string> = Object.fromEntries(
  Object.entries(CURSOR_TO_IR_TOOL).map(([k, v]) => [v, k]),
);

function normalizeToolName(cursorName: string): string {
  return CURSOR_TO_IR_TOOL[cursorName] ?? cursorName;
}

function denormalizeToolName(irName: string): string {
  // 优先用 ReadFile/WriteFile 等完整名
  return IR_TO_CURSOR_TOOL[irName] ?? irName;
}

// ---------------------------------------------------------------------------
// UUID 工具
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

function uuidV4(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// CursorAdapter
// ---------------------------------------------------------------------------

export class CursorAdapter extends AgentAdapter {
  readonly platform = 'cursor';

  static isAvailable(): boolean {
    return dirExists(getCursorProjectsDir());
  }

  isReady(): boolean {
    return dirExists(getCursorProjectsDir());
  }

  static getDefaultStoragePath(): string {
    return getCursorProjectsDir();
  }

  private resolveProjectDir(projectPath?: string): string {
    const root = getCursorProjectsDir();
    if (projectPath) {
      return path.join(root, encodeCwdGeneric(projectPath));
    }
    return root;
  }

  private findSessionFile(sessionId: string, projectPath?: string): string | null {
    if (projectPath) {
      const target = path.join(
        this.resolveProjectDir(projectPath),
        'agent-transcripts',
        sessionId,
        `${sessionId}.jsonl`,
      );
      return fileExists(target) ? target : null;
    }
    // 遍历所有项目目录
    const root = getCursorProjectsDir();
    if (!dirExists(root)) return null;
    for (const projDir of fs.readdirSync(root)) {
      const transcriptsDir = path.join(root, projDir, 'agent-transcripts');
      if (!dirExists(transcriptsDir)) continue;
      for (const sid of fs.readdirSync(transcriptsDir)) {
        const candidate = path.join(transcriptsDir, sid, `${sid}.jsonl`);
        if (fileExists(candidate) && sid === sessionId) return candidate;
      }
    }
    return null;
  }

  async listConversations(projectPath?: string): Promise<SessionMeta[]> {
    const metas: SessionMeta[] = [];
    const root = getCursorProjectsDir();
    if (!dirExists(root)) return [];

    const projDirs = projectPath
      ? [this.resolveProjectDir(projectPath)]
      : fs.readdirSync(root).map((d) => path.join(root, d));

    for (const projDir of projDirs) {
      if (!dirExists(projDir)) continue;
      const cwd = decodeCwdGeneric(path.basename(projDir));
      const transcriptsDir = path.join(projDir, 'agent-transcripts');
      if (!dirExists(transcriptsDir)) continue;

      for (const sid of fs.readdirSync(transcriptsDir)) {
        const fullPath = path.join(transcriptsDir, sid, `${sid}.jsonl`);
        if (!fileExists(fullPath)) continue;
        const meta = this.extractMeta(fullPath, cwd, sid);
        if (meta) metas.push(meta);
      }
    }
    return metas;
  }

  private extractMeta(jsonlPath: string, cwd: string, sessionId: string): SessionMeta | null {
    let title = '';
    let createdAt: string | undefined;
    let updatedAt: string | undefined;
    let messageCount = 0;
    let firstUserText = '';

    try {
      const stat = fs.statSync(jsonlPath);
      createdAt = stat.birthtime.toISOString();
      updatedAt = stat.mtime.toISOString();
    } catch {
      createdAt = new Date().toISOString();
      updatedAt = createdAt;
    }

    try {
      for (const record of readJsonlHead(jsonlPath, 50)) {
        // 消息行没有 type 字段
        if (record.type === 'turn_ended') continue;

        const role = record.role as string | undefined;
        if (role !== 'user' && role !== 'assistant') continue;

        messageCount++;
        if (role === 'user' && !firstUserText) {
          const msg = record.message as Record<string, unknown> | undefined;
          const content = msg?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
                firstUserText = String((block as Record<string, unknown>).text ?? '');
                break;
              }
            }
          }
        }
      }
    } catch {
      return null;
    }

    title = firstUserText ? firstUserText.slice(0, 50) : `Session ${sessionId.slice(0, 8)}`;

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
      throw new Error(`Cursor 会话文件未找到: session_id=${sessionId}`);
    }

    // 目录层级是 <encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl，
    // 需要往上取 3 层才到项目目录；取 2 层会得到中间层 agent-transcripts，
    // 导致 session.cwd 变成这个占位目录名（migrate 的 Preview 会直接显示它）。
    const cwd = decodeCwdGeneric(
      path.basename(path.dirname(path.dirname(path.dirname(jsonlPath)))),
    );
    const records = [...readJsonl(jsonlPath)];

    const messages: Message[] = [];

    for (const rec of records) {
      // turn_ended 行跳过
      if (rec.type === 'turn_ended') continue;

      // 消息行（无 type 字段）
      const role = rec.role as string | undefined;
      if (role !== 'user' && role !== 'assistant') continue;

      const msg = rec.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      const blocks = this.parseContentBlocks(content);

      messages.push({
        role: role as 'user' | 'assistant',
        content: blocks,
      });
    }

    // 提取标题
    let title = '';
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
    if (!title) title = `Session ${sessionId.slice(0, 8)}`;

    let createdAt: string;
    let updatedAt: string;
    try {
      const stat = fs.statSync(jsonlPath);
      createdAt = stat.birthtime.toISOString();
      updatedAt = stat.mtime.toISOString();
    } catch {
      createdAt = new Date().toISOString();
      updatedAt = createdAt;
    }

    return {
      sessionId,
      title,
      cwd,
      platform: this.platform,
      createdAt,
      updatedAt,
      messages,
      metadata: {},
    };
  }

  private parseContentBlocks(content: unknown): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    if (typeof content === 'string') {
      blocks.push({ type: 'text', text: content });
      return blocks;
    }

    if (!Array.isArray(content)) return blocks;

    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      const btype = it.type as string;

      if (btype === 'text') {
        blocks.push({ type: 'text', text: String(it.text ?? '') });
      } else if (btype === 'tool_use') {
        blocks.push({
          type: 'tool_call',
          toolName: normalizeToolName(String(it.name ?? '')),
          callId: String(it.id ?? ''),
          arguments: (it.input as Record<string, unknown>) ?? {},
        });
      }
      // Cursor 没有 tool_result / thinking
    }
    return blocks;
  }

  async writeSession(session: Session, projectPath?: string): Promise<string> {
    let sessionId = session.sessionId;
    if (!isUuid(sessionId)) {
      sessionId = uuidV4();
    }

    const cwd = projectPath ?? session.cwd;
    const projDir = path.join(getCursorProjectsDir(), encodeCwdGeneric(cwd));
    const transcriptDir = path.join(projDir, 'agent-transcripts', sessionId);
    const jsonlPath = path.join(transcriptDir, `${sessionId}.jsonl`);

    const records: Record<string, unknown>[] = [];

    for (const msg of session.messages) {
      const cursorContent: Record<string, unknown>[] = [];

      for (const block of msg.content) {
        switch (block.type) {
          case 'text':
            cursorContent.push({ type: 'text', text: block.text });
            break;
          case 'thinking':
            // Cursor 无 thinking，降级为 text
            cursorContent.push({ type: 'text', text: `<thinking>\n${block.text}\n</thinking>` });
            break;
          case 'tool_call':
            cursorContent.push({
              type: 'tool_use',
              name: denormalizeToolName(block.toolName),
              input: block.arguments,
            });
            break;
          case 'tool_result':
            // Cursor transcript 不存储 tool_result，降级为 text
            cursorContent.push({
              type: 'text',
              text: `[tool_result${block.isError ? ' (error)' : ''}]\n${block.content}`,
            });
            break;
        }
      }

      if (cursorContent.length > 0) {
        records.push({
          role: msg.role,
          message: { content: cursorContent },
        });
      }

      // 每个 assistant turn 后加 turn_ended
      if (msg.role === 'assistant') {
        records.push({ type: 'turn_ended', status: 'success' });
      }
    }

    writeJsonl(jsonlPath, records);
    return sessionId;
  }

  async deleteSession(sessionId: string, projectPath?: string): Promise<void> {
    const jsonlPath = this.findSessionFile(sessionId, projectPath);
    if (!jsonlPath) return;

    // 删除整个 session 目录
    const sessionDir = path.dirname(jsonlPath);
    if (dirExists(sessionDir)) {
      removeDirRecursive(sessionDir);
    }
  }
}
