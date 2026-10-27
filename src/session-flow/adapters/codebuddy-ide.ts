/**
 * adapters/codebuddy-ide.ts — CodeBuddy IDE (GUI) adapter.
 *
 * This and `codebuddy` (CLI) are two independent stores; sessions are not interchangeable:
 *   - CLI: ~/.codebuddy/projects/<encoded-cwd>/<uuid>.jsonl
 *   - IDE: <userData>/CodeBuddyExtension/Data/<ext-id>/CodeBuddyIDE/<inst-id>/history/<md5(cwd)>/
 *
 * Most users' day-to-day sessions live on the IDE side (measured: 1650 IDE vs 1 CLI).
 * Supporting only the CLI means "migrate out of codebuddy" has almost nothing to migrate. This adapter adds IDE-side
 * read / write / delete so each platform is a closed loop and neither writes into the other implicitly.
 *
 * IDE storage notes:
 * - The workspace directory name is md5(cwd) and is irreversible. cwd can be recovered only when the caller passes it;
 *   when it is missing, SessionMeta.cwd is recorded as `md5:<hash>` for display and debugging.
 * - conversation id = 32 hex digits (no hyphens)
 * - Message order comes from the messages array in <convDir>/index.json, independent of filenames
 * - Message-file roles are three kinds: user / assistant / tool (tool-result is its own message)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentAdapter, type SessionMeta, type SessionReadRef } from './base.js';
import type { Session, Message, ContentBlock, ImageBlock, ToolResultBlock } from '../ir.js';
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
import { isInjectedText, titleFromCandidates } from '../title.js';
import { deriveTargetSessionId } from '../ids.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * An IDE session id is 32 hex digits (no hyphens). A UUID form is equivalent once hyphens are stripped.
 * Other shapes are returned unchanged and fail later when the directory lookup misses.
 */
function toConvId(sessionId: string): string {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(sessionId)) return sessionId.replace(/-/g, '').toLowerCase();
  return sessionId;
}

/** Placeholder when a session has no cwd, so the UI and debugging can see that the source workspace is unknown. */
function unknownWorkspace(hash: string): string {
  return `md5:${hash}`;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};

/**
 * Parse an IDE image block into an IR ImageBlock.
 *
 * All three IDE reference shapes are handled:
 *   - `codebuddy-asset://assets/xxx.png` (relative to convDir; the common shape)
 *   - an absolute path (some versions write an absolute path directly)
 *   - `data:image/...;base64,....` (inline; no file read)
 *
 * When the file is readable, include base64 (for native platforms such as claude-code) and always include filePath
 * (writing back to the IDE copies the file, avoiding a base64 roundtrip). Return an ImageBlock even if the file cannot be read:
 * fidelity can count the block honestly, and the write side degrades to placeholder text on its own.
 */
function parseImageBlock(block: Record<string, unknown>, convDir: string): ImageBlock | null {
  const ref = String(block.image ?? block.url ?? block.path ?? '').trim();
  if (!ref) return null;

  // data URI: decode base64 directly
  const dataUri = ref.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (dataUri) {
    return {
      type: 'image',
      mimeType: dataUri[1].toLowerCase(),
      data: dataUri[2],
      label: 'inline-image',
    };
  }

  // Resolve the file path
  let filePath = '';
  if (ref.startsWith('codebuddy-asset://')) {
    const rel = ref.slice('codebuddy-asset://'.length).replace(/^\/+/, '');
    filePath = path.join(convDir, rel);
  } else if (path.isAbsolute(ref)) {
    filePath = ref;
  } else {
    filePath = path.join(convDir, ref);
  }

  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  const mimeType = MIME_BY_EXT[ext] ?? 'image/png';
  const label = path.basename(filePath);

  let data: string | undefined;
  try {
    data = fs.readFileSync(filePath).toString('base64');
  } catch {
    data = undefined; // File missing (cleaned up / another machine): keep the pointer; the write side degrades
  }

  return { type: 'image', mimeType, data, filePath, label };
}

/**
 * How many messages to scan at most when falling back to a title.
 *
 * 8 messages are often all injections or command records (slash-command sessions, compaction-summary sessions), so the title falls back
 * to "Session <id>". Widening to 30 matches the scan budget used by claude-code/codex.
 */
const TITLE_LOOKAHEAD = 30;

function firstUserText(messages: IdeMessageParsed[]): string {
  // Collect candidates, then unwrap them together: skipping a whole injected message is not the same as discarding it; real questions inside slash-command mixed messages still need to be recovered
  const candidates: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const block of m.content) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      candidates.push(block.text);
    }
    if (candidates.length >= 5) break;
  }
  return titleFromCandidates(candidates);
}

/**
 * The IDE persists conversation.name from index.json as-is, and sometimes mixes in
 * injected-block text such as <system-reminder>. Leaving it uncleaned pollutes the whole migration path
 * (list titles, readSession.title, and target-side titles are all the prompt verbatim).
 */
function safeConversationName(name: string): string {
  return name && !isInjectedText(name) ? name.slice(0, 100) : '';
}

// ---------------------------------------------------------------------------
// CodeBuddyIdeAdapter
// ---------------------------------------------------------------------------

export class CodeBuddyIdeAdapter extends AgentAdapter {
  readonly platform = 'codebuddy-ide';

  isReady(): boolean {
    return listIdeHistoryRoots().length > 0;
  }

  async listConversations(projectPath?: string): Promise<SessionMeta[]> {
    // Filter at workspace level by md5(cwd), instead of passing the workspace directory down as the history root
    // — the latter's children are session directories, and the index.json read from them has no conversations field,
    // so the result is always an empty list (and it pointlessly reads every session-level index.json: slow and wrong).
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
          // A single file stat failure does not stop the tally
        }
      }
    } catch {
      // Missing directory (session just created, not yet on disk): treat as an empty session
    }

    // Title fallback reads only the first few messages: IDE sessions often have thousands of messages, and reading the whole session just for a title
    // makes one list take tens of seconds.
    const title =
      safeConversationName(entry.name) ||
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

  async readSession(ref: SessionReadRef): Promise<Session> {
    const projectPath = ref.projectPath;
    // A listed conversation directory decides the id, not the request.
    const convId = ref.filePath ? path.basename(ref.filePath) : toConvId(ref.sessionId);

    // The listed conversation directory, else the given workspace, else search globally.
    // Session ids are globally unique, so the user does not have to cd into the original workspace to migrate out —
    // and IDE workspace directory names are md5(cwd), so without projectPath there is no way to scope the search.
    let convDir: string | undefined;
    let historyDir: string | undefined;
    let workspaceHash = '';
    // A global fallback hit does not belong to projectPath — the real workspace is an irreversible md5,
    // so cwd can only be marked with an md5 placeholder and must not impersonate the passed-in path (otherwise the archive key would be wrong too).
    let matchedGivenPath = false;

    if (ref.filePath) {
      convDir = ref.filePath;
      historyDir = path.dirname(ref.filePath);
      workspaceHash = path.basename(historyDir);
      matchedGivenPath = projectPath !== undefined && hashWorkspace(projectPath) === workspaceHash;
    } else if (projectPath) {
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
      throw new Error(`CodeBuddy IDE session not found: session_id=${ref.sessionId}`);
    }

    const entry = readIdeConversations(historyDir).find((e) => e.id === convId);
    const rawMessages = readIdeConversation(convDir);

    const messages: Message[] = [];
    const sessionMetadata: Record<string, unknown> = {};

    for (const raw of rawMessages) {
      if (raw.model && !sessionMetadata.model) sessionMetadata.model = raw.model;

      // An IDE tool-result is its own role:"tool" message, and the IR has no such role:
      // match the CLI adapter and fold it into the previous user message (or start a new user message if there is none).
      if (raw.role === 'tool') {
        for (const block of raw.content) {
          if (block.type !== 'tool-result') continue;
          const irBlock = this.parseToolResult(block);
          if (!irBlock) continue;
          const last = messages[messages.length - 1];
          if (last && last.role === 'user') {
            last.content.push(irBlock);
          } else {
            // Keep the original timestamp: if it is missing, a downstream writeSession (such as claude-code) fills in
            // the migration time and produces an inversion where a later message is earlier than the previous one.
            messages.push({ role: 'user', content: [irBlock], timestamp: raw.createdAt });
          }
        }
        continue;
      }

      const content = this.parseContent(raw, convDir);
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
      safeConversationName(entry?.name ?? '') ||
      firstUserText(rawMessages) ||
      `Session ${convId.slice(0, 8)}`;
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

  private parseContent(raw: IdeMessageParsed, convDir: string): ContentBlock[] {
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
        case 'image': {
          // Image dragged into the input box: content is a relative `codebuddy-asset://assets/xxx.png`
          // reference, and the file itself lives under <convDir>/assets/. These used to be skipped outright — the image never entered
          // the IR, fidelity still reported 100%, and the user only noticed the pictures were gone after opening the migration result.
          const img = parseImageBlock(block, convDir);
          if (img) blocks.push(img);
          break;
        }
        default:
          // Other IDE-specific blocks (file references and similar): the IR has no matching type, so skip them
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

  /** Returns the 32-hex conversation id, the form `writeSession` returns. */
  async existingSessionId(sessionId: string, projectPath?: string): Promise<string | undefined> {
    const convId = toConvId(sessionId);
    const found = projectPath
      ? findIdeHistoryDirs(projectPath, false).some((historyDir) => fs.existsSync(path.join(historyDir, convId)))
      : findIdeConversationDirs(convId).length > 0;
    return found ? convId : undefined;
  }

  async writeSession(session: Session, projectPath?: string): Promise<string> {
    const cwd = projectPath ?? session.cwd;

    // writeIdeSession locates the workspace by md5(cwd). When cwd is a placeholder such as `md5:<hash>`,
    // the hash cannot be computed and the write is skipped silently. A silent success is more dangerous than a failure — the user thinks the migration finished, but the sidebar is empty.
    // Windows drive paths (C:\...) are valid absolute paths too, so allow them as well.
    const absoluteLike = cwd.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(cwd);
    if (!cwd || !absoluteLike) {
      throw new Error(
        `Writing to CodeBuddy IDE requires an absolute working directory, got "${cwd}". Pass --cwd/--target-cwd.`,
      );
    }

    const writeId = deriveTargetSessionId({
      targetPlatform: this.platform,
      targetCwd: cwd,
      sourceSessionId: session.sessionId,
    });
    const result = writeIdeSession({ ...session, sessionId: writeId }, cwd);
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
