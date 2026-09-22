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
      // 50 lines are often all injected blocks; a too-small budget makes sessions with real questions fall back to "Session <id>"
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
    // Deterministic id: re-migrations of the same source session hit the same composerId (no more per-run copies)
    const sessionId = isUuid(session.sessionId)
      ? session.sessionId
      : deriveCursorId(session.platform || 'unknown', session.sessionId);

    const cwd = projectPath ?? session.cwd;
    const projDir = path.join(getCursorProjectsDir(), encodeCwdGeneric(cwd));
    const transcriptDir = path.join(projDir, 'agent-transcripts', sessionId);
    const jsonlPath = path.join(transcriptDir, `${sessionId}.jsonl`);

    const records: Record<string, unknown>[] = [];
    // Native transcript turn semantics: 1 user + N consecutive assistant + 1 turn_ended.
    // Previously we wrote turn_ended after every assistant, splitting one tool round into dozens of turns.
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
        // The source platform puts tool results in user messages: they belong to the previous assistant's tool calls,
        // so hang it back on the previous assistant record (as a text block) instead of a fake user message.
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

        // Real user prompts: consecutive user messages in one turn merge into one (natives never emit consecutive user messages)
        if (cursorContent.length > 0) {
          if (lastUserRecord && !turnHasAssistant) {
            const prev = lastUserRecord.message as { content: Record<string, unknown>[] };
            prev.content.push(...cursorContent);
          } else {
            endTurn();
            const rec: Record<string, unknown> = {
              role: 'user',
              // write cwd so readSession can recover the real path (archive key depends on it)
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
              // id lets readSession pair tool_use with tool_result (the reader expects it)
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
            // Cursor storage has no images: degrade to a placeholder (counted degraded)
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

    // close the final turn
    endTurn();

    writeJsonl(jsonlPath, records);

    // The transcript is only Cursor's **export**: the Agents Window list comes from state.vscdb's
    // composerHeaders, and the body from composerData/bubbleId in cursorDiskKV. Skipping registration
    // otherwise the session "migrates successfully" yet is invisible in Cursor. Registration is best-effort: failure only affects visibility.
    try {
      const title = this.buildComposerTitle(session, sessionId);
      const reg = registerCursorComposer({
        cwd,
        composerId: sessionId,
        title,
        messages: this.toComposerMessages(session),
      });
      if (!reg.ok) {
        // Never silent: the transcript is on disk but list registration failed -- the user would not see it in Cursor.
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
    // Collect tool results by callId first: natively they hang on the assistant's tool bubble,
    // never a standalone user message (the UI would sprout hundreds of `[tool_result] {json}` bubbles).
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
          // MigrationEngine degrades Cursor-unsupported ThinkingBlocks into `<thinking>...</thinking>`,
          // wrapped text blocks (migrate.ts degradeThinkingBlocks). Left in the body they make Cursor
          // rendered as an HTML block (markdown broken, newlines swallowed) -- strip before the DB bubble; the original stays in the
          // transcript 里。
          const stripped = block.text.replace(THINKING_WRAP_RE, '').trim();
          // user bubbles show the real question only: injected blocks (<user_info>/<rules>/<additional_data>/...) and attachment
          // paths are noise (Cursor renders them as chips natively; we cannot).
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
        // thinking: not written into bubble bodies (native Cursor stores no thinking; once a body starts with <thinking>,
        //   the whole thing renders as an HTML block with broken markdown/newlines). Original kept in the transcript.
        // tool_result: already paired into the tool bubble above; never a standalone message.
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
    // Unregister first (otherwise deleting the transcript leaves an unopenable entry in the Agents list)
    try {
      unregisterCursorComposer(sessionId);
    } catch {
      // best-effort: leftover registration rows only affect the list display, never data safety
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
