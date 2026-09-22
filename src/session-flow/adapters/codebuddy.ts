/**
 * adapters/codebuddy.ts — CodeBuddy **CLI** 平台适配器。
 *
 * 只覆盖 CLI 存储；CodeBuddy **IDE**（图形化侧边栏「历史对话」）是另一套
 * 独立存储，由 `adapters/codebuddy-ide.ts` 负责。两者会话互不通用，
 * 本适配器不再读写 IDE 侧。
 *
 * 读取/写入 `~/.codebuddy/projects/<encoded-cwd>/<session-uuid>.jsonl` 格式。
 * cwd 编码: `/` → `-`，无前导 `-`。
 * 同目录下有 `<session-uuid>/subagents/` 子目录存子代理会话（首版不迁移）。
 *
 * JSONL 行类型（7 种）：
 *   读取：message/function_call/function_call_result/reasoning → IR；其余跳过
 *   写入：message + function_call + function_call_result + reasoning +
 *         ai-title + file-history-snapshot（辅助行）
 *
 * 增强点（vs Python 版）：
 * - reasoning 块写入为独立 reasoning 行（而非跳过）
 * - 写入时生成 ai-title 行
 * - 写入时生成 file-history-snapshot 行
 * - timestamp 使用 Unix ms 整数
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentAdapter, type SessionMeta } from './base.js';
import type { Session, Message, ContentBlock, TextBlock, ThinkingBlock, ToolCallBlock, ToolResultBlock } from '../ir.js';
import { imagePlaceholderText } from '../ir.js';
import { deriveTargetSessionId } from '../ids.js';
import {
  getCodeBuddyProjectsDir,
  encodeCwdCodeBuddy,
  decodeCwdGeneric,
  readJsonl,
  readJsonlHead,
  writeJsonl,
  fileExists,
  dirExists,
  removeDirRecursive,
} from '../fs.js';
import { isInjectedText, fallbackTitle, titleFromCandidates } from '../title.js';

// ---------------------------------------------------------------------------
// 工具名归一化映射
// ---------------------------------------------------------------------------

const CB_TO_IR_TOOL: Record<string, string> = {
  read_file: 'read_file',
  write_file: 'write_file',
  edit_file: 'edit_file',
  bash: 'bash',
  grep: 'grep',
  glob: 'glob',
  task: 'task',
  todo_write: 'todo_write',
};

/**
 * IR → CodeBuddy 工具名。
 *
 * CodeBuddy / WorkBuddy 客户端按「UI 工具名」查表渲染图标与折叠标题，实测原生行里是
 * `Bash` / `Read` / `Write` / `Edit` / `Grep` / `Glob` / `Task` / `TodoWrite` 这类驼峰名。
 * 直接把 IR 的 `read_file` / `bash` 写进去，客户端查不到 → 工具调用显示为空白。
 * 同时把源平台别名（execute_command / replace_in_file / search_file …）收口到这里，
 * 否则它们会原样落到目标文件里。
 */
const IR_TO_CB_TOOL: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  task: 'Task',
  todo_write: 'TodoWrite',
  delete_file: 'DeleteFile',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  semantic_search: 'SemanticSearch',
  // 源平台别名 → CodeBuddy 语义工具
  execute_command: 'Bash',
  run_command: 'Bash',
  write_to_file: 'Write',
  replace_in_file: 'Edit',
  multi_edit: 'Edit',
  search_file: 'Glob',
  search_content: 'Grep',
  list_dir: 'Glob',
  codebase_search: 'SemanticSearch',
  read_lints: 'LSP',
};

function normalizeToolName(cbName: string): string {
  return CB_TO_IR_TOOL[cbName] ?? cbName;
}

function denormalizeToolName(irName: string): string {
  return IR_TO_CB_TOOL[irName] ?? irName;
}

/** 工具调用在折叠态显示的摘要文本（原生 providerData.argumentsDisplayText）。 */
function argumentsDisplayText(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return name;
  const preferred =
    args.command ?? args.path ?? args.pattern ?? args.glob_pattern ?? args.target_directory ??
    args.target_file ?? args.query ?? args.url ?? args.filePath;
  if (typeof preferred === 'string' && preferred.trim()) {
    return preferred.length > 160 ? `${preferred.slice(0, 160)}…` : preferred;
  }
  try {
    const s = JSON.stringify(args);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return name;
  }
}

// ---------------------------------------------------------------------------
// UUID / 时间戳工具
// ---------------------------------------------------------------------------

// 不校验 version 位：源平台的 sessionId 可能是 UUID v7（codex / codex-internal / tcodex）。
// 只认 v4 会让这些会话每次迁移都重新生成一个 v4 ID —— 既不幂等（反复迁移堆积副本），
// 也无法再按源 sessionId 追踪或回滚。放宽到「任意合法 UUID 形状」即可复用源 ID。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
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
// CodeBuddyAdapter
// ---------------------------------------------------------------------------

export class CodeBuddyAdapter extends AgentAdapter {
  readonly platform = 'codebuddy';

  static isAvailable(): boolean {
    return dirExists(getCodeBuddyProjectsDir());
  }

  isReady(): boolean {
    return dirExists(getCodeBuddyProjectsDir());
  }

  static getDefaultStoragePath(): string {
    return getCodeBuddyProjectsDir();
  }

  private resolveProjectDir(projectPath?: string): string {
    const root = getCodeBuddyProjectsDir();
    if (projectPath) {
      return path.join(root, encodeCwdCodeBuddy(projectPath));
    }
    return root;
  }

  private findSessionFile(sessionId: string, projectPath?: string): string | null {
    if (projectPath) {
      const target = path.join(this.resolveProjectDir(projectPath), `${sessionId}.jsonl`);
      return fileExists(target) ? target : null;
    }
    const root = getCodeBuddyProjectsDir();
    if (!dirExists(root)) return null;
    for (const projDir of fs.readdirSync(root)) {
      const candidate = path.join(root, projDir, `${sessionId}.jsonl`);
      if (fileExists(candidate)) return candidate;
    }
    return null;
  }

  /**
   * 找出该 sessionId 的**全部**副本（跨工作区）。
   *
   * findSessionFile 命中首个即返回，用于读取没问题；但删除时只删首个会让其他
   * 工作区里的副本变成孤儿（无 IDE 条目、用户看不见、占空间）。
   */
  private findAllSessionFiles(sessionId: string, projectPath?: string): string[] {
    if (projectPath) {
      const target = path.join(this.resolveProjectDir(projectPath), `${sessionId}.jsonl`);
      return fileExists(target) ? [target] : [];
    }
    const root = getCodeBuddyProjectsDir();
    if (!dirExists(root)) return [];
    const out: string[] = [];
    for (const projDir of fs.readdirSync(root)) {
      const candidate = path.join(root, projDir, `${sessionId}.jsonl`);
      if (fileExists(candidate)) out.push(candidate);
    }
    return out;
  }

  async listConversations(projectPath?: string): Promise<SessionMeta[]> {
    const metas: SessionMeta[] = [];
    const root = getCodeBuddyProjectsDir();
    if (!dirExists(root)) return [];

    const projDirs = projectPath
      ? [this.resolveProjectDir(projectPath)]
      : fs.readdirSync(root).map((d) => path.join(root, d));

    for (const projDir of projDirs) {
      if (!dirExists(projDir)) continue;
      const cwd = decodeCwdGeneric(path.basename(projDir));
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
    let aiTitle = '';

    try {
      for (const record of readJsonlHead(jsonlPath, 80)) {
        const rtype = record.type as string;

        if (rtype === 'ai-title') {
          aiTitle = String(record.aiTitle ?? '');
          continue;
        }

        const tsRaw = record.timestamp;
        if (tsRaw !== undefined) {
          const ts = fromUnixMs(Number(tsRaw));
          if (!createdAt) createdAt = ts;
          updatedAt = ts;
        }

        if (rtype === 'message') {
          messageCount++;
          const role = record.role as string;
          if (role === 'user' && userTextCandidates.length < 5) {
            const content = record.content;
            if (Array.isArray(content)) {
              const parts: string[] = [];
              for (const block of content) {
                if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'input_text') {
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

    // ai-title 是 CodeBuddy 自己起的标题，最可靠；否则退回首条用户文本。
    // 首条「用户消息」常常是 system-reminder 等注入块，不清洗的话
    // 会话列表里显示的就是一整段提示词原文。
    if (aiTitle && !isInjectedText(aiTitle)) {
      title = aiTitle.slice(0, 60);
    } else {
      title = titleFromCandidates(userTextCandidates) || fallbackTitle(sessionId);
    }

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
      throw new Error(`CodeBuddy session file not found: session_id=${sessionId}`);
    }

    const cwd = decodeCwdGeneric(path.basename(path.dirname(jsonlPath)));
    const records = [...readJsonl(jsonlPath)];

    // writeSession 写入的每行都带 cwd（真实绝对路径）。目录名解码是恒等函数
    // （还原不出真实路径），归档键（repoIdentity）必须优先用记录里的原生 cwd
    // （设计文档 Key invariant）；恢复失败退回目录名。
    let nativeCwd: string | undefined;
    for (const rec of records) {
      if (typeof rec.cwd === 'string' && path.isAbsolute(rec.cwd)) {
        nativeCwd = rec.cwd;
        break;
      }
    }
    const sessionCwd = nativeCwd ?? cwd;

    let title = '';
    let createdAt: string | undefined;
    let updatedAt: string | undefined;
    const sessionMetadata: Record<string, unknown> = {};
    const messages: Message[] = [];

    // 第一遍：提取 title/时间戳/元数据
    for (const rec of records) {
      const rtype = rec.type as string;

      if (rtype === 'ai-title') {
        // CodeBuddy 偶尔把注入块原文存成 ai-title，照收会污染整个迁移链路
        // （预览、目标侧标题全是提示词原文）。
        const t = String(rec.aiTitle ?? '');
        if (t && !isInjectedText(t)) title = t.slice(0, 100);
        continue;
      }

      const tsRaw = rec.timestamp;
      if (tsRaw !== undefined) {
        const ts = fromUnixMs(Number(tsRaw));
        if (!createdAt) createdAt = ts;
        updatedAt = ts;
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

        // 提取 model
        const providerData = rec.providerData as Record<string, unknown> | undefined;
        if (providerData?.model) {
          msg.metadata = { model: String(providerData.model) };
          if (!sessionMetadata.model) sessionMetadata.model = String(providerData.model);
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
      // 与 claude-code 同策略：候选文本统一解包（注入头 + 真实提问的混合消息也能救回）
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

    if (!createdAt) createdAt = new Date().toISOString();
    if (!updatedAt) updatedAt = createdAt;

    return {
      sessionId,
      title,
      cwd: sessionCwd,
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
    // 非 UUID 源 id 用确定性派生（同一源会话反复迁移命中同一个 id → 不产生重复会话）
    const sessionId = isUuid(session.sessionId)
      ? session.sessionId
      : deriveTargetSessionId('codebuddy', session.sessionId);

    const cwd = projectPath ?? session.cwd;
    const projDir = path.join(getCodeBuddyProjectsDir(), encodeCwdCodeBuddy(cwd));
    const jsonlPath = path.join(projDir, `${sessionId}.jsonl`);

    const records: Record<string, unknown>[] = [];

    // callId → 工具名：让 function_call_result 行带上真实工具名（而不是一律 'Agent'）
    const toolNamesByCallId = new Map<string, string>();
    for (const m of session.messages) {
      for (const b of m.content) {
        if (b.type === 'tool_call' && b.callId) {
          toolNamesByCallId.set(b.callId, denormalizeToolName(b.toolName));
        }
      }
    }
    const resultToolName = (callId: string): string | undefined => toolNamesByCallId.get(callId);

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

      // 分离 thinking blocks 和其他 blocks
      const thinkingBlocks = msg.content.filter((b) => b.type === 'thinking');
      const otherBlocks = msg.content.filter((b) => b.type !== 'thinking');

      // reasoning 行（thinking blocks → reasoning）
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

      // message 行（text blocks）
      if (otherBlocks.length > 0) {
        const cbContent: Record<string, unknown>[] = [];
        let hasText = false;
        for (const block of otherBlocks) {
          if (block.type === 'text') {
            cbContent.push({
              type: msg.role === 'user' ? 'input_text' : 'output_text',
              text: block.text,
            });
            hasText = true;
          } else if (block.type === 'image') {
            // CLI 存储不含图片，降级为占位文本（保真度计 degraded）
            cbContent.push({
              type: msg.role === 'user' ? 'input_text' : 'output_text',
              text: imagePlaceholderText(block),
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
            content: cbContent,
            providerData: msg.metadata?.model ? { model: msg.metadata.model } : {},
            sessionId,
            cwd,
          });
          parentId = msgId;
        }
      }

      // function_call 行（tool_call blocks）
      // 原生结构要点：顶层 `arguments` 是 JSON 字符串（客户端展开参数面板读它）、
      // providerData.argumentsDisplayText 是折叠态摘要、callId 必须非空（与结果配对）。
      for (const block of otherBlocks) {
        if (block.type === 'tool_call') {
          const fcId = block.callId || uuidV4();
          const callId = block.callId || `call_${uuidV4()}`;
          const name = denormalizeToolName(block.toolName);
          records.push({
            id: fcId,
            parentId,
            timestamp: toUnixMs(msg.timestamp),
            type: 'function_call',
            name,
            callId,
            arguments: JSON.stringify(block.arguments ?? {}),
            providerData: {
              arguments: block.arguments,
              argumentsDisplayText: argumentsDisplayText(name, block.arguments),
              ...(msg.metadata?.model ? { model: msg.metadata.model } : {}),
            },
            sessionId,
            cwd,
          });
          parentId = fcId;
        }
      }

      // function_call_result 行（tool_result blocks）
      // name 用真实工具名：写死 'Agent' 会让所有工具结果都显示成 "Agent"。
      for (const block of otherBlocks) {
        if (block.type === 'tool_result') {
          const fcrId = uuidV4();
          const name = resultToolName(block.callId) ?? 'Agent';
          records.push({
            id: fcrId,
            parentId,
            timestamp: toUnixMs(msg.timestamp),
            type: 'function_call_result',
            name,
            callId: block.callId,
            status: block.isError ? 'failed' : 'completed',
            output: { type: 'text', text: block.content },
            sessionId,
            cwd,
          });
          parentId = fcrId;
        }
      }

      // file-history-snapshot 行（每条消息后）
      records.push({
        id: uuidV4(),
        timestamp: toUnixMs(msg.timestamp),
        type: 'file-history-snapshot',
        isSnapshotUpdate: false,
        snapshot: {
          messageId: msgId,
          trackedFileBackups: {},
        },
        cwd,
      });
    }

    writeJsonl(jsonlPath, records);

    // 这里**不再**顺带写 CodeBuddy IDE 的 history。
    // CLI（~/.codebuddy/projects/...）与 IDE（CodeBuddyExtension/.../history）是两套
    // 独立存储，而本适配器的 list/read/delete 只覆盖 CLI 一侧——写入时偷偷双写会造
    // 成读写不对称：迁进来的会话出现在 IDE 侧边栏，却既列不出来也删不掉。
    // 需要 IDE 侧会话请显式迁移到 `codebuddy-ide` 平台。

    return sessionId;
  }

  async deleteSession(sessionId: string, projectPath?: string): Promise<boolean> {
    const jsonlPaths = this.findAllSessionFiles(sessionId, projectPath);

    let cliDeleted = false;
    for (const jsonlPath of jsonlPaths) {
      try {
        fs.unlinkSync(jsonlPath);
        cliDeleted = true;
      } catch {
        // ignore
      }

      // 删除同名子目录（subagents 等）
      const subdir = jsonlPath.replace(/\.jsonl$/, '');
      if (dirExists(subdir)) {
        removeDirRecursive(subdir);
      }
    }

    // 只清理 CLI 侧。IDE 侧会话由 `codebuddy-ide` 平台负责，
    // 本适配器不再越界删除自己从未写入过的存储。
    return cliDeleted;
  }
}
