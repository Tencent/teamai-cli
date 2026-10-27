/**
 * adapters/cursor.ts — Cursor platform adapter.
 *
 * Reads and writes `<data root>/projects/<encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl`.
 * The data root is `CURSOR_DATA_DIR` when the member recorded one (`toolRoots`), `~/.cursor`
 * otherwise. cwd encoding: `/` → `-`, with no leading `-`.
 *
 * JSONL line types (2 kinds):
 *   - Message line (no type field): {role, message:{content:[block...]}}
 *   - turn_ended line: {type:"turn_ended", status:"success"}
 *
 * Notes:
 * - Message lines have no type field; they are recognized by the role + message shape
 * - Content block types: text / tool_use (no tool_result; tool results are not written into the transcript)
 * - On migration, ToolResultBlock is degraded to a TextBlock
 *
 * Enhancements (vs the Python version):
 * - Write a turn_ended line
 * - Create the agent-transcripts/<uuid>/ directory structure correctly
 * - Degrade tool_result
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentAdapter, ToolUnavailableError, type SessionMeta, type SessionReadRef } from './base.js';
import type { Session, Message, ContentBlock } from '../ir.js';
import { imagePlaceholderText } from '../ir.js';
import {
  encodeCwdGeneric,
  decodeCwdGeneric,
  readJsonl,
  readJsonlHead,
  writeJsonl,
  fileExists,
  dirExists,
  removeDirRecursive,
} from '../fs.js';
import { sessionStoreDir } from '../../locate.js';
import { cleanTitleText, fallbackTitle, titleFromCandidates, titleFromUserText, isRenderableText, visibleUserText } from '../title.js';
import { cursorComposerExists, registerCursorComposer, unregisterCursorComposer, type CursorComposerMessage, type CursorComposerTool } from '../cursor-store.js';
import { assertSafeSessionFileId, deriveTargetSessionId } from '../ids.js';
import { log } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Tool-name normalization map
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
 * IR → Cursor tool name.
 *
 * This cannot be produced by reversing CURSOR_TO_IR_TOOL: reversal lets the later value win for a shared key, so short aliases (Read/Write/Edit)
 * would overwrite the full names (ReadFile/WriteFile/EditFile) and the name written into Cursor would be the opposite of what was intended.
 * Source-platform aliases (CodeBuddy / Claude Code) are folded in here too, otherwise they would pass through unchanged as
 * tools Cursor does not recognize, such as execute_command / replace_in_file.
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
  // Source-platform aliases → Cursor semantic tools
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
 * Tool results and thinking do not go into the DB bubble body:
 * - thinking: the engine degrades ThinkingBlock to a `<thinking>…</thinking>` text block (Cursor does not support
 *   thinking). Leaving that wrapper in the body makes Cursor render it as an HTML block, and markdown plus newlines all break.
 * - Tool results: natively they live in the assistant tool bubble's `toolFormerData.result`, not as a standalone message.
 */
const THINKING_WRAP_RE = /<thinking>\s*[\s\S]*?\s*<\/thinking>/gi;

function normalizeToolName(cursorName: string): string {
  return CURSOR_TO_IR_TOOL[cursorName] ?? cursorName;
}

function denormalizeToolName(irName: string): string {
  // Prefer full names such as ReadFile/WriteFile
  return IR_TO_CURSOR_TOOL[irName] ?? irName;
}

// ---------------------------------------------------------------------------
// UUID helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CursorAdapter
// ---------------------------------------------------------------------------

export class CursorAdapter extends AgentAdapter {
  readonly platform: string;
  private readonly storageRoot: string;

  /**
   * @param platform Platform id (default 'cursor')
   * @param storageRoot Transcript store (default ~/.cursor/projects; the adapter registry passes
   *   the member's recorded CURSOR_DATA_DIR root when there is one)
   */
  constructor(platform = 'cursor', storageRoot?: string) {
    super();
    this.platform = platform;
    this.storageRoot = storageRoot ?? sessionStoreDir('cursor', undefined);
  }

  isReady(): boolean {
    return dirExists(this.storageRoot);
  }

  private resolveProjectDir(projectPath?: string): string {
    const root = this.storageRoot;
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
    // Walk every project directory
    const root = this.storageRoot;
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
    const root = this.storageRoot;
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
        // Message lines have no type field
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
      // Still listed with what was read, so a lookup reports the session unreadable, not missing.
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

  async readSession(ref: SessionReadRef): Promise<Session> {
    // The listed file, else the id in the workspace, else the id anywhere.
    const jsonlPath =
      ref.filePath ??
      this.findSessionFile(ref.sessionId, ref.projectPath) ??
      (ref.projectPath ? this.findSessionFile(ref.sessionId) : null);
    if (!jsonlPath) {
      throw new Error(`Cursor session file not found: session_id=${ref.sessionId}`);
    }
    // The file name is the id: a listed file decides it, not the request.
    const sessionId = path.basename(jsonlPath, '.jsonl');

    // The directory layout is <encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl.
    // Go up 3 levels to reach the project directory; 2 levels lands on the intermediate agent-transcripts layer,
    // so session.cwd becomes that placeholder directory name (migrate Preview would show it directly).
    const cwd = decodeCwdGeneric(
      path.basename(path.dirname(path.dirname(path.dirname(jsonlPath)))),
    );
    const records = [...readJsonl(jsonlPath)];

    // The archive key (repoIdentity) prefers the native cwd in the record (a real absolute path);
    // decoding the directory name is lossy, so if recovery fails fall back to the decoded directory name (design doc Key invariant).
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
      // Skip turn_ended lines
      if (rec.type === 'turn_ended') continue;

      // Message line (no type field)
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

    // Extract the title
    let title = '';
    // Same unwrap strategy as the listing path: slash-command messages are
    // "injection head + real question", so dropping the whole block loses the
    // question. titleFromCandidates unwraps <user_query> and strips metadata.
    const candidates: string[] = [];
    for (const msg of messages) {
      if (msg.role === 'user') {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            // The write side degrades tool_result to a text block with this prefix — tool output is not a title
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
        // Some Cursor versions export tool_use without an id (observed 173/173
        // on one transcript). An empty callId then short-circuits the result
        // pairing downstream and every call lands as "cancelled" in targets
        // like CodeBuddy IDE. Synthesize a stable per-parse id instead --
        // same approach as the writeSession fallback below.
        const rawId = String(it.id ?? '').trim();
        blocks.push({
          type: 'tool_call',
          toolName: normalizeToolName(String(it.name ?? '')),
          callId: rawId || `tool_${blocks.length}`,
          arguments: (it.input as Record<string, unknown>) ?? {},
        });
      }
      // Cursor transcripts carry no tool results and no thinking (the export
      // stops at tool_use). Every tool_call therefore ends up without a paired
      // result, and targets that render unpaired calls as "cancelled" (e.g.
      // CodeBuddy IDE) show the whole session as cancelled. Synthesize an
      // honest placeholder result so the pairing is complete and the target
      // UI renders a normal state instead of a wall of cancellations.
    }

    // Pair each tool_call that has no tool_result with a placeholder result.
    const hasResult = new Set(
      blocks
        .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
        .map((b) => b.callId),
    );
    const withResults: ContentBlock[] = [];
    for (const block of blocks) {
      withResults.push(block);
      if (block.type === 'tool_call' && block.callId && !hasResult.has(block.callId)) {
        withResults.push({
          type: 'tool_result',
          callId: block.callId,
          content:
            '[tool output not captured: Cursor transcripts do not record tool results]',
          isError: false,
        });
      }
    }
    return withResults;
  }

  async existingSessionId(sessionId: string, projectPath?: string): Promise<string | undefined> {
    if (this.findSessionFile(sessionId, projectPath)) return sessionId;
    // Cursor shows the conversation from its store, which a write would replace, transcript or not.
    const inStore = cursorComposerExists(sessionId, projectPath);
    if (!inStore.ok) {
      throw new ToolUnavailableError(
        `Cursor's session store could not be read, so whether session ${sessionId} exists is unknown: ${inStore.reason}`,
      );
    }
    return inStore.exists ? sessionId : undefined;
  }

  async writeSession(session: Session, projectPath?: string): Promise<string> {
    const cwd = projectPath ?? session.cwd;
    const sessionId = deriveTargetSessionId({
      targetPlatform: this.platform,
      targetCwd: cwd,
      sourceSessionId: session.sessionId,
    });
    const projDir = path.join(this.storageRoot, encodeCwdGeneric(cwd));
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
          } else if (block.type === 'image') {
            // Cursor storage has no images: degrade to a placeholder (counted degraded)
            cursorContent.push({ type: 'text', text: imagePlaceholderText(block) });
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
            // Cursor has no thinking; degrade to text
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
        const notice =
          `Cursor session list registration failed (transcript written, session may be invisible in Cursor): ${reg.reason ?? 'unknown'}`;
        log.debug(`cursor register failed: composer=${sessionId} reason=${reg.reason ?? 'unknown'}`);
        this.noteWrite(notice);
      }
    } catch (e) {
      const notice = `Cursor session list registration error: ${(e as Error).message}`;
      log.debug(notice);
      this.noteWrite(notice);
    }
    return sessionId;
  }

  /** Session title: first real user question > cleaned source-session title > Session <id>. */
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

  /** IR message → bubble material for a Cursor composer (text + tool calls/results). */
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
          // AgentSession.copy hands thinking over as `<thinking>...</thinking>` text; writeSession degrades a
          // raw ThinkingBlock to that text in the transcript itself. In a bubble body Cursor renders it as an
          // HTML block (markdown broken, newlines swallowed), so strip it; the transcript keeps it.
          const stripped = block.text.replace(THINKING_WRAP_RE, '').trim();
          // user bubbles show the real question only: injected blocks (<user_info>/<rules>/<additional_data>/...) and attachment
          // paths are noise (Cursor renders them as chips natively; we cannot).
          const visible = msg.role === 'user' ? visibleUserText(stripped) : stripped;
          if (visible && isRenderableText(visible)) textParts.push(visible);
        } else if (block.type === 'image') {
          textParts.push(imagePlaceholderText(block));
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

  async deleteSession(sessionId: string, projectPath?: string): Promise<boolean> {
    assertSafeSessionFileId(sessionId);
    // Resolve the scoped transcript before touching the global registration:
    // unregistering first would drop another workspace's copy of the same
    // session id when `rollback --cwd` matched nothing here.
    const jsonlPath = this.findSessionFile(sessionId, projectPath);
    if (!jsonlPath) {
      // No transcript, but the composer can still be in the store; with `projectPath`, only one in that workspace.
      const inStore = cursorComposerExists(sessionId, projectPath);
      if (!inStore.ok) throw new Error(`Cursor's session store could not be read: ${inStore.reason}`);
      if (!inStore.exists) return false;
      const removed = unregisterCursorComposer(sessionId);
      if (!removed.ok) throw new Error(`Removing session ${sessionId} from Cursor's store failed: ${removed.reason}`);
      return true;
    }

    // Unregister (otherwise deleting the transcript leaves an unopenable entry in the Agents list)
    try {
      unregisterCursorComposer(sessionId);
    } catch {
      // best-effort: leftover registration rows only affect the list display, never data safety
    }

    // Delete the whole session directory
    const sessionDir = path.dirname(jsonlPath);
    if (dirExists(sessionDir)) {
      removeDirRecursive(sessionDir);
      return !dirExists(sessionDir);
    }
    return false;
  }
}
