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
import { imagePlaceholderText } from '../ir.js';
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
import { cleanTitleText, fallbackTitle, isInjectedText, titleFromCandidates, titleFromUserText, extractUserText, isRenderableText, visibleUserText } from '../title.js';
import { registerCursorComposer, unregisterCursorComposer, type CursorComposerMessage, type CursorComposerTool } from '../cursor-store.js';
import { log } from '../../utils/logger.js';

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

/**
 * IR → Cursor 工具名。
 *
 * 不能由 CURSOR_TO_IR_TOOL 反转得到：反转时同键后者覆盖前者，短别名（Read/Write/Edit）
 * 会盖掉完整名（ReadFile/WriteFile/EditFile），写进 Cursor 的名字与预期相反。
 * 另外源平台（CodeBuddy / Claude Code）的别名也要在这里收口，否则会原样透传成
 * execute_command / replace_in_file 之类的「Cursor 认不出的工具」。
 */
const IR_TO_CURSOR_TOOL: Record<string, string> = {
  read_file: 'ReadFile',
  write_file: 'WriteFile',
  edit_file: 'EditFile',
  bash: 'Shell',
  grep: 'Grep',
  glob: 'Glob',
  delete_file: 'DeleteFile',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  semantic_search: 'SemanticSearch',
  // 源平台别名 → Cursor 语义工具
  execute_command: 'Shell',
  run_command: 'Shell',
  write_to_file: 'WriteFile',
  replace_in_file: 'EditFile',
  multi_edit: 'EditFile',
  search_file: 'Glob',
  search_content: 'Grep',
  list_dir: 'Glob',
  codebase_search: 'SemanticSearch',
};

/**
 * 工具结果与 thinking 不进 DB 气泡正文：
 * - thinking：引擎把 ThinkingBlock 降级成 `<thinking>…</thinking>` 文本块（Cursor 不支持
 *   thinking）。这层包裹留在正文里会让 Cursor 按 HTML 块渲染，markdown 与换行全部失效。
 * - 工具结果：原生存在 assistant 的 tool 气泡 `toolFormerData.result` 里，不单独成消息。
 */
const THINKING_WRAP_RE = /<thinking>\s*[\s\S]*?\s*<\/thinking>/gi;

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

// 任意合法 UUID 形状（不校验 version 位）。收紧到 v4 会让 codex v7 等来源的
// sessionId 每次写入都被换成新随机 id：同一会话反复迁移各生成一份副本，
// 既不幂等也无法按源 sessionId 回滚。与 codebuddy.ts 的放宽策略保持一致。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

function uuidV4(): string {
  return crypto.randomUUID();
}

/**
 * 由源会话 id 确定性派生一个 Cursor composerId（UUID v8 形状）。
 *
 * 非 UUID 的源 id（如 codebuddy 的 60062279ff104372bc110594720a8016）若每次随机生成，
 * 同一会话反复迁移会各留一份副本：transcript 与 composerHeaders 都堆积重复条目，
 * 而且无法按源 id 回滚。派生后同一源会话永远命中同一个 composerId（重迁移=覆盖）。
 */
function deriveCursorId(sourcePlatform: string, sourceId: string): string {
  const hex = crypto.createHash('sha256').update(`teamai:cursor:${sourcePlatform}:${sourceId}`).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
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
    const userTextCandidates: string[] = [];

    try {
      const stat = fs.statSync(jsonlPath);
      createdAt = stat.birthtime.toISOString();
      updatedAt = stat.mtime.toISOString();
    } catch {
      createdAt = new Date().toISOString();
      updatedAt = createdAt;
    }

    try {
      // 50 行常全是注入块，预算不够会让有真实提问的会话也 fallback 成 "Session <id>"
      for (const record of readJsonlHead(jsonlPath, 200)) {
        // 消息行没有 type 字段
        if (record.type === 'turn_ended') continue;

        const role = record.role as string | undefined;
        if (role !== 'user' && role !== 'assistant') continue;

        messageCount++;
        if (role === 'user' && userTextCandidates.length < 5) {
          const msg = record.message as Record<string, unknown> | undefined;
          const content = msg?.content;
          if (Array.isArray(content)) {
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
    } catch {
      return null;
    }

    title = titleFromCandidates(userTextCandidates) || fallbackTitle(sessionId);

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
      throw new Error(`Cursor session file not found: session_id=${sessionId}`);
    }

    // 目录层级是 <encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl，
    // 需要往上取 3 层才到项目目录；取 2 层会得到中间层 agent-transcripts，
    // 导致 session.cwd 变成这个占位目录名（migrate 的 Preview 会直接显示它）。
    const cwd = decodeCwdGeneric(
      path.basename(path.dirname(path.dirname(path.dirname(jsonlPath)))),
    );
    const records = [...readJsonl(jsonlPath)];

    // 归档键（repoIdentity）优先用记录里的原生 cwd（真实绝对路径）；
    // 目录名解码有损，恢复失败退回解码目录名（设计文档 Key invariant）。
    let nativeCwd: string | undefined;
    for (const rec of records) {
      if (typeof rec.cwd === 'string' && path.isAbsolute(rec.cwd)) {
        nativeCwd = rec.cwd;
        break;
      }
    }
    const sessionCwd = nativeCwd ?? cwd;

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
    // Same unwrap strategy as the listing path: slash-command messages are
    // "injection head + real question", so dropping the whole block loses the
    // question. titleFromCandidates unwraps <user_query> and strips metadata.
    const candidates: string[] = [];
    for (const msg of messages) {
      if (msg.role === 'user') {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            // 写入端把 tool_result 降级为带该前缀的 text 块——工具输出不是标题
            if (block.text.startsWith('[tool_result')) continue;
            candidates.push(block.text);
          }
        }
        if (title) break;
      }
    }
    if (!title) title = titleFromCandidates(candidates) || fallbackTitle(sessionId);

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
      cwd: sessionCwd,
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
    // 确定性 id：同一源会话反复迁移命中同一个 composerId（不再每次生成副本）
    const sessionId = isUuid(session.sessionId)
      ? session.sessionId
      : deriveCursorId(session.platform || 'unknown', session.sessionId);

    const cwd = projectPath ?? session.cwd;
    const projDir = path.join(getCursorProjectsDir(), encodeCwdGeneric(cwd));
    const transcriptDir = path.join(projDir, 'agent-transcripts', sessionId);
    const jsonlPath = path.join(transcriptDir, `${sessionId}.jsonl`);

    const records: Record<string, unknown>[] = [];
    // 原生 transcript 的 turn 语义：1 条 user + N 条连续 assistant + 1 条 turn_ended。
    // 之前按「每条 assistant 后都写 turn_ended」，把一次工具轮次切成了几十个 turn。
    let lastAssistantRecord: Record<string, unknown> | null = null;
    let lastUserRecord: Record<string, unknown> | null = null;
    let turnHasAssistant = false;

    const endTurn = () => {
      if (turnHasAssistant) {
        records.push({ type: 'turn_ended', status: 'success' });
        turnHasAssistant = false;
        lastAssistantRecord = null;
        lastUserRecord = null;
      }
    };

    for (const msg of session.messages) {
      if (msg.role === 'user') {
        // 源平台把工具结果放在 user 消息里：它属于上一个 assistant 的工具调用，
        // 所以挂回上一条 assistant 记录（作为文本块），而不是变成一条「假 user 消息」。
        const toolResults: string[] = [];
        const cursorContent: Record<string, unknown>[] = [];
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            toolResults.push(`[tool_result${block.isError ? ' (error)' : ''}]\n${block.content}`);
          } else if (block.type === 'text') {
            cursorContent.push({ type: 'text', text: block.text });
          } else if (block.type === 'thinking') {
            cursorContent.push({ type: 'text', text: `<thinking>\n${block.text}\n</thinking>` });
          }
        }
        if (toolResults.length > 0 && lastAssistantRecord) {
          const content = lastAssistantRecord.message as { content: Record<string, unknown>[] };
          for (const t of toolResults) content.content.push({ type: 'text', text: t });
        }

        // 真实用户提问：同一 turn 内连续的用户消息合并进同一条（原生不会出现连续 user）
        if (cursorContent.length > 0) {
          if (lastUserRecord && !turnHasAssistant) {
            const prev = lastUserRecord.message as { content: Record<string, unknown>[] };
            prev.content.push(...cursorContent);
          } else {
            endTurn();
            const rec: Record<string, unknown> = {
              role: 'user',
              // 写入 cwd 使 readSession 能恢复真实路径（归档键派生依赖它）
              cwd,
              message: { content: cursorContent },
            };
            records.push(rec);
            lastUserRecord = rec;
          }
        }
        continue;
      }

      if (msg.role !== 'assistant') continue;

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
              // id 让 readSession 能把 tool_use 与 tool_result 配对（读端就认它）
              id: block.callId || `tool_${cursorContent.length}`,
              name: denormalizeToolName(block.toolName),
              input: block.arguments,
            });
            break;
          case 'tool_result':
            cursorContent.push({
              type: 'text',
              text: `[tool_result${block.isError ? ' (error)' : ''}]\n${block.content}`,
            });
            break;
          case 'image':
            // Cursor 存储不含图片，降级为占位文本（保真度计 degraded）
            cursorContent.push({ type: 'text', text: imagePlaceholderText(block) });
            break;
        }
      }

      if (cursorContent.length > 0) {
        const rec: Record<string, unknown> = {
          role: 'assistant',
          cwd,
          message: { content: cursorContent },
        };
        records.push(rec);
        lastAssistantRecord = rec;
        turnHasAssistant = true;
      }
    }

    // 收尾最后一个 turn
    endTurn();

    writeJsonl(jsonlPath, records);

    // transcript 只是 Cursor 的**导出**产物：Agents Window 的列表来自 state.vscdb 的
    // composerHeaders、正文来自 cursorDiskKV 的 composerData/bubbleId。不注册这一步，
    // 会话在 Cursor 里「迁移成功但完全看不见」。注册是 best-effort：失败只影响可见性。
    try {
      const title = this.buildComposerTitle(session, sessionId);
      const reg = registerCursorComposer({
        cwd,
        composerId: sessionId,
        title,
        messages: this.toComposerMessages(session),
      });
      if (!reg.ok) {
        // 不静默：transcript 已落盘但列表注册失败，用户在 Cursor 里会「看不到」。
        log.debug(`cursor register failed: composer=${sessionId} reason=${reg.reason ?? 'unknown'}`);
        log.warn(
          `Cursor session list registration failed (transcript written, session may be invisible in Cursor): ${reg.reason ?? 'unknown'}`,
        );
      }
    } catch (e) {
      log.warn(`Cursor session list registration error: ${(e as Error).message}`);
    }
    return sessionId;
  }

  /** 会话标题：首条真实用户提问 > 源会话标题清洗 > Session <id>。 */
  private buildComposerTitle(session: Session, sessionId: string): string {
    for (const msg of session.messages) {
      if (msg.role !== 'user') continue;
      for (const block of msg.content) {
        if (block.type !== 'text') continue;
        const t = titleFromUserText(block.text);
        if (t) return t;
      }
    }
    return cleanTitleText(session.title) || fallbackTitle(sessionId);
  }

  /** IR 消息 → Cursor composer 的 bubble 素材（文本 + 工具调用/结果）。 */
  private toComposerMessages(session: Session): CursorComposerMessage[] {
    // 先按 callId 收集工具结果：原生的工具结果挂在 assistant 的 tool 气泡里，
    // 不单独成为用户消息（否则 UI 里会冒出成百上千个 `[tool_result] {json}` 气泡）。
    const toolResults = new Map<string, { content: string; isError: boolean }>();
    for (const msg of session.messages) {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.callId) {
          toolResults.set(block.callId, { content: block.content ?? '', isError: Boolean(block.isError) });
        }
      }
    }

    const out: CursorComposerMessage[] = [];
    const fallbackTs = (() => {
      const d = new Date(session.createdAt);
      return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    })();
    let lastTs = fallbackTs;

    for (const msg of session.messages) {
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;
      const parsed = msg.timestamp ? new Date(msg.timestamp) : null;
      const createdAt =
        parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : lastTs;
      lastTs = createdAt;

      const textParts: string[] = [];
      const tools: CursorComposerTool[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          // MigrationEngine 会把 Cursor 不支持的 ThinkingBlock 降级成 `<thinking>…</thinking>`
          // 包裹的文本块（migrate.ts degradeThinkingBlocks）。这类包裹留在正文里会让 Cursor
          // 按 HTML 块渲染整段（markdown 失效、换行被吞），所以进 DB 气泡前剥掉；原文仍留在
          // transcript 里。
          const stripped = block.text.replace(THINKING_WRAP_RE, '').trim();
          // 用户气泡只显示真实提问：注入块（<user_info>/<rules>/<additional_data>/…）与附件
          // 路径都是噪音（Cursor 原生把它们渲染成 chip，我们渲染不出来）。
          const visible = msg.role === 'user' ? visibleUserText(stripped) : stripped;
          if (visible && isRenderableText(visible)) textParts.push(visible);
        } else if (block.type === 'tool_call') {
          const res = toolResults.get(block.callId);
          tools.push({
            name: denormalizeToolName(block.toolName),
            args: block.arguments ?? {},
            result: res?.content,
            isError: res?.isError,
          });
        }
        // thinking：不写进 bubble 正文（原生 Cursor 不存 thinking；一旦以 `<thinking>` 开头，
        //   整段会被当 HTML 块，markdown 与换行失效）。原文仍保留在 transcript 里。
        // tool_result：已配对进上面的 tool 气泡，不单独成消息。
      }
      const text = textParts.join('\n\n');
      if (!text.trim() && tools.length === 0) continue;
      out.push({
        role: msg.role,
        text,
        tools,
        createdAt,
        modelName: msg.metadata?.model,
      });
    }
    return out;
  }

  async deleteSession(sessionId: string, projectPath?: string): Promise<void> {
    // 先摘掉 DB 注册（否则删了 transcript，Agents 列表里还留着一条点不开的会话）
    try {
      unregisterCursorComposer(sessionId);
    } catch {
      // best-effort：注册残留只影响列表显示，不影响数据安全
    }

    const jsonlPath = this.findSessionFile(sessionId, projectPath);
    if (!jsonlPath) return;

    // 删除整个 session 目录
    const sessionDir = path.dirname(jsonlPath);
    if (dirExists(sessionDir)) {
      removeDirRecursive(sessionDir);
    }
  }
}
