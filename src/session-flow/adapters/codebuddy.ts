/**
 * adapters/codebuddy.ts — CodeBuddy **CLI** platform adapter.
 *
 * Covers CLI storage only. CodeBuddy **IDE** (the GUI sidebar "history") is a separate
 * store, handled by `adapters/codebuddy-ide.ts`. Sessions are not interchangeable between the two,
 * and this adapter no longer reads or writes the IDE side.
 *
 * Reads and writes `~/.codebuddy/projects/<encoded-cwd>/<session-uuid>.jsonl`.
 * cwd encoding: `/` → `-`, with no leading `-`.
 * A `<session-uuid>/subagents/` subdirectory in the same directory holds subagent sessions (not migrated in the first version).
 *
 * JSONL line types (7 kinds):
 *   Read: message/function_call/function_call_result/reasoning → IR; the rest are skipped
 *   Write: message + function_call + function_call_result + reasoning +
 *         ai-title + file-history-snapshot (auxiliary lines)
 *
 * Enhancements (vs the Python version):
 * - Write reasoning blocks as their own reasoning lines (instead of skipping them)
 * - Write an ai-title line
 * - Write a file-history-snapshot line
 * - timestamp is a Unix ms integer
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentAdapter, type SessionMeta, type SessionReadRef, type SubagentsRead } from './base.js';
import type { Session, Message, ContentBlock, ThinkingBlock, ToolCallBlock, ToolResultBlock } from '../ir.js';
import { imagePlaceholderText } from '../ir.js';
import { assertSafeSessionFileId, deriveTargetSessionId } from '../ids.js';
import {
  encodeCwdCodeBuddy,
  decodeCwdGeneric,
  readJsonl,
  readJsonlHead,
  fileModifiedAt,
  writeJsonl,
  fileExists,
  dirExists,
  removeDirRecursive,
} from '../fs.js';
import { sessionStoreDir } from '../../locate.js';
import { isInjectedText, fallbackTitle, titleFromCandidates } from '../title.js';

// ---------------------------------------------------------------------------
// Tool-name normalization map
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
 * IR → CodeBuddy tool name.
 *
 * The CodeBuddy / WorkBuddy client looks up icons and collapsed titles by "UI tool name". Native rows use
 * camel-case names such as `Bash` / `Read` / `Write` / `Edit` / `Grep` / `Glob` / `Task` / `TodoWrite`.
 * Writing the IR names `read_file` / `bash` directly means the client finds nothing → the tool call renders blank.
 * Source-platform aliases (execute_command / replace_in_file / search_file ...) are folded in here too,
 * otherwise they would land in the target file unchanged.
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
  // Source-platform aliases → CodeBuddy semantic tools
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

/** Summary text shown for a tool call when collapsed (native providerData.argumentsDisplayText). */
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
// UUID / timestamp helpers
// ---------------------------------------------------------------------------

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
  private readonly storageRoot: string;

  /** @param storageRoot The session store (the registry passes the member's, `sessionStoreDir`). */
  constructor(storageRoot = sessionStoreDir('codebuddy', undefined)) {
    super();
    this.storageRoot = storageRoot;
  }

  isReady(): boolean {
    return dirExists(this.storageRoot);
  }

  private resolveProjectDir(projectPath?: string): string {
    const root = this.storageRoot;
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
    const root = this.storageRoot;
    if (!dirExists(root)) return null;
    for (const projDir of fs.readdirSync(root)) {
      const candidate = path.join(root, projDir, `${sessionId}.jsonl`);
      if (fileExists(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Find every copy of this sessionId (across workspaces).
   *
   * findSessionFile returns on the first hit, which is fine for reads; deleting only the first hit leaves
   * copies in other workspaces as orphans (no IDE entry, invisible to the user, still taking space).
   */
  private findAllSessionFiles(sessionId: string, projectPath?: string): string[] {
    if (projectPath) {
      const target = path.join(this.resolveProjectDir(projectPath), `${sessionId}.jsonl`);
      return fileExists(target) ? [target] : [];
    }
    const root = this.storageRoot;
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
    const root = this.storageRoot;
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
      // Still listed with what was read, so a lookup reports the session unreadable, not missing.
    }

    // No record says when: date it by the file, so a damaged session does not sort as the newest.
    if (!createdAt) createdAt = fileModifiedAt(jsonlPath);
    if (!updatedAt) updatedAt = createdAt;

    // ai-title is the title CodeBuddy itself chose, so it is the most reliable; otherwise fall back to the first user text.
    // The first "user message" is often an injected block such as system-reminder. Without cleaning,
    // the session list shows the entire prompt verbatim.
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

  /**
   * The agents a session started, from `<session id>/subagents/*.jsonl` beside its transcript, read like the session.
   * CodeBuddy records neither which call started an agent nor whether it finished, so they come in file name order.
   */
  async readSubagents(session: Session, ref: SessionReadRef): Promise<SubagentsRead> {
    const jsonlPath = ref.filePath ?? this.findSessionFile(session.sessionId, ref.projectPath);
    if (!jsonlPath) return { status: 'unread', reason: `The transcript of session ${session.sessionId} was not found again` };
    const dir = path.join(path.dirname(jsonlPath), path.basename(jsonlPath, '.jsonl'), 'subagents');
    if (!dirExists(dir)) return { status: 'read', agents: [] };
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
    const agents = await Promise.all(files.map((name) => this.readSession({ sessionId: session.sessionId, filePath: path.join(dir, name) })));
    return { status: 'read', agents: agents.map((agent) => ({ session: agent, depth: 1 })) };
  }

  async readSession(ref: SessionReadRef): Promise<Session> {
    const jsonlPath = ref.filePath ?? this.findSessionFile(ref.sessionId, ref.projectPath);
    if (!jsonlPath) {
      throw new Error(`CodeBuddy session file not found: session_id=${ref.sessionId}`);
    }
    // The file name is the id: a listed file decides it, not the request.
    const sessionId = path.basename(jsonlPath, '.jsonl');

    const cwd = decodeCwdGeneric(path.basename(path.dirname(jsonlPath)));
    const records = [...readJsonl(jsonlPath)];

    // Every line written by writeSession carries cwd (the real absolute path). Decoding the directory name is the identity function
    // (it cannot recover the real path), so the archive key (repoIdentity) must prefer the native cwd in the record
    // (design doc Key invariant); if recovery fails, fall back to the directory name.
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

    // First pass: extract title / timestamps / metadata
    for (const rec of records) {
      const rtype = rec.type as string;

      if (rtype === 'ai-title') {
        // CodeBuddy sometimes stores injected-block text as ai-title. Taking it as-is pollutes the whole migration path
        // (preview and target-side titles are the prompt verbatim).
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

    // Second pass: build messages
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

        // Extract model
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
      // Same strategy as claude-code: unwrap candidate text together (mixed messages with an injection header plus a real question can still be recovered)
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

  async existingSessionId(sessionId: string, projectPath?: string): Promise<string | undefined> {
    return this.findSessionFile(sessionId, projectPath) ? sessionId : undefined;
  }

  async writeSession(session: Session, projectPath?: string): Promise<string> {
    const cwd = projectPath ?? session.cwd;
    const sessionId = deriveTargetSessionId({
      targetPlatform: this.platform,
      targetCwd: cwd,
      sourceSessionId: session.sessionId,
    });
    const projDir = path.join(this.storageRoot, encodeCwdCodeBuddy(cwd));
    const jsonlPath = path.join(projDir, `${sessionId}.jsonl`);

    const records: Record<string, unknown>[] = [];

    // callId → tool name: so function_call_result lines carry the real tool name (instead of always 'Agent')
    const toolNamesByCallId = new Map<string, string>();
    for (const m of session.messages) {
      for (const b of m.content) {
        if (b.type === 'tool_call' && b.callId) {
          toolNamesByCallId.set(b.callId, denormalizeToolName(b.toolName));
        }
      }
    }
    const resultToolName = (callId: string): string | undefined => toolNamesByCallId.get(callId);

    // 1. ai-title line
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

      // Split thinking blocks from the other blocks
      const thinkingBlocks = msg.content.filter((b) => b.type === 'thinking');
      const otherBlocks = msg.content.filter((b) => b.type !== 'thinking');

      // reasoning lines (thinking blocks → reasoning)
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

      // message line (text blocks)
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
            // CLI storage has no images; degrade to placeholder text (counted as degraded fidelity)
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

      // function_call lines (tool_call blocks)
      // Native shape: top-level `arguments` is a JSON string (the client reads it to expand the parameter panel),
      // providerData.argumentsDisplayText is the collapsed summary, and callId must be non-empty (paired with the result).
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

      // function_call_result lines (tool_result blocks)
      // name uses the real tool name: hardcoding 'Agent' would make every tool result display as "Agent".
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

      // file-history-snapshot line (after each message)
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

    // This no longer also writes CodeBuddy IDE history.
    // CLI (~/.codebuddy/projects/...) and IDE (CodeBuddyExtension/.../history) are two
    // independent stores, and this adapter's list/read/delete cover only the CLI side — a silent dual-write would
    // make reads and writes asymmetric: migrated sessions show up in the IDE sidebar, yet cannot be listed or deleted.
    // To get an IDE-side session, migrate explicitly to the `codebuddy-ide` platform.

    return sessionId;
  }

  async deleteSession(sessionId: string, projectPath?: string): Promise<boolean> {
    assertSafeSessionFileId(sessionId);
    const jsonlPaths = this.findAllSessionFiles(sessionId, projectPath);

    let cliDeleted = false;
    for (const jsonlPath of jsonlPaths) {
      try {
        fs.unlinkSync(jsonlPath);
        cliDeleted = true;
      } catch {
        // ignore
      }

      // Delete the same-named subdirectory (subagents and similar)
      const subdir = jsonlPath.replace(/\.jsonl$/, '');
      if (dirExists(subdir)) {
        removeDirRecursive(subdir);
      }
    }

    // Clean up the CLI side only. IDE-side sessions belong to the `codebuddy-ide` platform;
    // this adapter no longer reaches into storage it never wrote.
    return cliDeleted;
  }
}
