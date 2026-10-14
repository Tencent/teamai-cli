/**
 * adapters/claude-code.ts — Claude Code platform adapter.
 *
 * Reads and writes `~/.claude/projects/<encoded-cwd>/<session>.jsonl`.
 *
 * JSONL line types (13 kinds):
 *   Read: user/assistant → IR Message; the other 11 kinds are skipped
 *   Write: user/assistant + mode + permission-mode + file-history-snapshot +
 *         attachment + last-prompt (6 auxiliary line kinds so CC can load the session)
 *
 * DAG flatten: build the main chain by parentUuid and skip sidechains where isSidechain=true.
 *
 * Enhancements (vs the Python version):
 * - Write a last-prompt line (CC --resume depends on it)
 * - Write an attachment line (placeholder tool/MCP/Agent inventory)
 * - Write a file-history-snapshot line (file-history placeholder)
 * - Write mode + permission-mode lines
 * - Keep the signature on thinking blocks
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentAdapter, type SessionMeta, type SessionReadRef } from './base.js';
import type { Session, Message, ContentBlock } from '../ir.js';
import { assertSafeSessionFileId, deriveTargetSessionId } from '../ids.js';
import { imagePlaceholderText } from '../ir.js';
import {
  getClaudeCodeProjectsDir,
  encodeCwdClaude,
  bestEffortDecodeCwdClaude,
  decodeCwdClaude,
  readJsonl,
  readJsonlHead,
  fileModifiedAt,
  writeJsonl,
  fileExists,
  dirExists,
  removeDirRecursive,
  mayReadLocalImageFile,
} from '../fs.js';
import {
  cleanTitleText,
  fallbackTitle,
  titleFromCandidates,
} from '../title.js';

// ---------------------------------------------------------------------------
// Tool-name normalization map
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

// Default CC tool inventory (used for deferred_tools_delta.addedNames on the attachment line)
// CC needs this inventory when loading a session so it can rebuild tool context
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
// Line types skipped on read
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
// UUID / timestamp helpers
// ---------------------------------------------------------------------------

function uuidV4(): string {
  return crypto.randomUUID();
}

/**
 * Parse a CC ISO8601 timestamp with a Z suffix.
 */
function parseCcTimestamp(tsStr: string | undefined): string | undefined {
  if (!tsStr) return undefined;
  try {
    // Verify it parses
    const d = new Date(tsStr);
    if (isNaN(d.getTime())) return undefined;
    return tsStr;
  } catch {
    return undefined;
  }
}

/**
 * Format a CC timestamp (millisecond precision, Z suffix).
 */
function toCcTimestamp(isoStr: string | undefined): string {
  const d = isoStr ? new Date(isoStr) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Content-block parsing (CC → IR)
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
      // Screenshot pasted into the input box: Anthropic format is
      // {type:'image', source:{type:'base64', media_type, data}} (also {type:'url', url}).
      // If it is not parsed, the image never enters the IR or the target, yet fidelity still reports 100% (silent undercount).
      const src = b.source as Record<string, unknown> | undefined;
      const data = typeof src?.data === 'string' ? src.data : undefined;
      const url = typeof b.url === 'string' ? b.url : (typeof src?.url === 'string' ? src.url : undefined);
      if (!data && !url) continue;
      blocks.push({
        type: 'image',
        mimeType: String(src?.media_type ?? 'image/png'),
        // Carry base64 as-is; a URL-only form keeps just the pointer (the write side degrades by target capability)
        ...(data ? { data } : {}),
        ...(url ? { filePath: url } : {}),
        label: guessImageLabel(String(src?.media_type ?? 'image/png')),
      });
    }
  }
  return blocks;
}

/** Inline images have no filename; derive a readable placeholder from the mime type (used when writing back or degrading to a placeholder). */
function guessImageLabel(mimeType: string): string {
  const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
  return `image.${ext}`;
}

// ---------------------------------------------------------------------------
// Content-block serialization (IR → CC)
// ---------------------------------------------------------------------------

function irBlockToCc(block: ContentBlock, session?: Session): Record<string, unknown> | null {
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
      // CC natively supports base64 image blocks in user messages. When data is missing (the source file cannot be read),
      // read it from filePath; if that also fails, degrade to placeholder text and never drop the block silently.
      let data = block.data;
      // Untrusted sessions (restored from a team archive) must never read a
      // local path: an archived image block can point at any readable file,
      // and its contents would then be embedded into the restored session.
      if (!data && mayReadLocalImageFile(session, block.filePath)) {
        try {
          data = fs.readFileSync(block.filePath as string).toString('base64');
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
   * @param platform Platform id (default 'claude-code'; variants may pass 'claude-internal' / 'tclaude')
   * @param storageRoot Storage root (default ~/.claude/projects; variants pass ~/.claude-internal/projects and similar)
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
    // Walk every encoded directory
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
    let recordedCwd: string | undefined;
    const userTextCandidates: string[] = [];
    let summaryTitle = '';

    try {
      // 50 lines are often all injected blocks (system-reminder / command records / snapshot); too small a budget makes
      // sessions that do have a real question fall back to "Session <id>" as well. 200 lines matches the codex/workbuddy budget.
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
          // The directory name decodes only when the path has no '-', '_', '.' or space; the record has the real one.
          if (recordedCwd === undefined && typeof record.cwd === 'string' && path.isAbsolute(record.cwd)) {
            recordedCwd = record.cwd;
          }
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
      // Still listed with what was read, so a lookup reports the session unreadable, not missing.
    }

    // No record says when: date it by the file, so a damaged session does not sort as the newest.
    if (!createdAt) createdAt = fileModifiedAt(jsonlPath);
    if (!updatedAt) updatedAt = createdAt;

    // Title: summary line (that is what CC /resume uses) > unwrapped user text > id fallback.
    // Do not skip a whole message just because it is injected — mixed messages with an injection header such as <command-name>
    // followed by a real question would be dropped entirely; titleFromUserText unwraps <user_query> and strips metadata.
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
      cwd: recordedCwd ?? cwd,
      platform: this.platform,
      createdAt,
      updatedAt,
      messageCount,
      filePath: jsonlPath,
      sizeBytes,
    };
  }

  async readSession(ref: SessionReadRef): Promise<Session> {
    const jsonlPath = ref.filePath ?? this.findSessionFile(ref.sessionId, ref.projectPath);
    if (!jsonlPath) {
      throw new Error(
        `Claude Code session file not found: session_id=${ref.sessionId}, project_path=${ref.projectPath ?? 'undefined'}`,
      );
    }
    // The file name is the id: a listed file decides it, not the request.
    const sessionId = path.basename(jsonlPath, '.jsonl');

    const cwd =
      bestEffortDecodeCwdClaude(path.basename(path.dirname(jsonlPath))) ??
      decodeCwdClaude(path.basename(path.dirname(jsonlPath)));

    // Collect every message record
    const rawRecords: Record<string, unknown>[] = [];
    let nativeCwd: string | undefined;
    let summaryTitle: string | undefined;
    for (const record of readJsonl(jsonlPath)) {
      const rtype = record.type as string;
      if (rtype === 'summary') {
        // Title line written by writeSession (CC /resume uses it too). If the read side ignores it,
        // the title drifts to the first user text after a roundtrip (which may be a leftover fragment after injection cleaning).
        const t = String(record.summary ?? '');
        if (t) summaryTitle = t; // Take the last one (writeSession appends it at the end of the file)
        continue;
      }
      if (SKIP_TYPES.has(rtype)) continue;
      if (rtype !== 'user' && rtype !== 'assistant') continue;
      // Every message record carries the real cwd (absolute path). Decoding the directory name is lossy
      // (`-` may come from `/` or a space), so the archive key (repoIdentity) must prefer
      // the native cwd in the record (design doc Key invariant); if recovery fails, fall back to the decoded directory name.
      if (nativeCwd === undefined && typeof record.cwd === 'string' && path.isAbsolute(record.cwd)) {
        nativeCwd = record.cwd;
      }
      rawRecords.push(record);
    }
    // The cwd in the record is sometimes an encoded directory name (`-Users-foo-project`), not a real path:
    // decode it back to the real workspace so migration can "keep the source session's workspace" rather than falling back to the current directory.
    const sessionCwd = nativeCwd ?? bestEffortDecodeCwdClaude(cwd) ?? cwd;

    // Flatten the DAG
    const messages = this.flattenDag(rawRecords);

    // Extract the title: prefer the summary title line (written on disk, and also used by CC /resume),
    // then unwrapped user text (mixed messages with an injection header plus a real question can still be unwrapped), and finally fall back to the id prefix.
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

    // Timestamps
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

    // Metadata
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
   * DAG flatten: build the main chain by parentUuid and skip sidechains where isSidechain=true.
   *
   * Note: the parentUuid chain may pass through skipped line types (attachment/file-history-snapshot and similar),
   * which breaks the chain. Orphan nodes whose parentUuid points at a missing record are treated as roots.
   */
  private flattenDag(rawRecords: Record<string, unknown>[]): Message[] {
    // Filter out sidechains
    const mainChain = rawRecords.filter((r) => !r.isSidechain);

    // uuid → record (main-chain records only)
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
        // parent is on the main chain
        if (!childrenMap.has(parent)) childrenMap.set(parent, []);
        childrenMap.get(parent)!.push(record);
      } else {
        // parent is not on the main chain (skipped line type); treat it as a root
        roots.push(record);
      }
    }

    // Depth-first over the main chain, so each root's chain stays in one piece
    const ordered: Record<string, unknown>[] = [];
    const visited = new Set<string>();
    const stack: Record<string, unknown>[] = [...roots].reverse();

    while (stack.length > 0) {
      const record = stack.pop()!;
      const uid = record.uuid as string | undefined;
      if (uid && visited.has(uid)) continue;
      if (uid) visited.add(uid);
      ordered.push(record);
      if (uid) {
        stack.push(...[...(childrenMap.get(uid) ?? [])].reverse());
      }
    }

    // Convert to IR Message
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
    const projDir = path.join(this.storageRoot, encodeCwdClaude(cwd));
    const jsonlPath = path.join(projDir, `${sessionId}.jsonl`);

    // Build JSONL records (including auxiliary lines)
    const records = this.sessionToCcRecords(session, sessionId, cwd);
    writeJsonl(jsonlPath, records);

    return sessionId;
  }

  /**
   * Convert an IR Session into a list of CC JSONL records (including auxiliary lines).
   *
   * Auxiliary-line order:
   * 1. mode line (first line)
   * 2. permission-mode line
   * 3. Message lines (user/assistant), each followed by a file-history-snapshot
   * 4. Insert an attachment line before the first assistant message (empty tool inventory)
   * 5. last-prompt line (last line)
   */
  private sessionToCcRecords(session: Session, sessionId: string, cwd: string): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = [];
    let parentUuid: string | null = null;
    let firstAssistantUuid: string | null = null;
    let lastUserUuid: string | null = null;
    let lastUserText = '';

    // 1. mode line
    records.push({
      type: 'mode',
      mode: 'normal',
      sessionId,
    });

    // 2. permission-mode line
    records.push({
      type: 'permission-mode',
      permissionMode: 'default',
      sessionId,
    });

    for (const msg of session.messages) {
      const msgUuid = msg.messageId ?? uuidV4();

      // Build content blocks
      const ccBlocks: Record<string, unknown>[] = [];
      for (const block of msg.content) {
        const ccBlock = irBlockToCc(block, session);
        if (ccBlock) ccBlocks.push(ccBlock);
      }

      // CC message object
      const ccMessage: Record<string, unknown> = { role: msg.role, content: ccBlocks };
      if (msg.role === 'assistant') {
        ccMessage.model = msg.metadata?.model ?? 'claude-sonnet-4-20250514';
      }

      // Insert an attachment line before the first assistant message
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

      // Message line
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

      // file-history-snapshot line (after each message)
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

      // Remember the last user message
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

    // 3. last-prompt line (at the end)
    records.push({
      type: 'last-prompt',
      lastPrompt: lastUserText,
      leafUuid: lastUserUuid ?? parentUuid,
      sessionId,
    });

    // 4. summary line (title)
    // Claude Code's /resume list shows the session title from a type:"summary" record.
    // When it is missing, the list falls back to the session id prefix (for example 824ff784), which hits every migrated session.
    // The title read by the source adapter is already cleaned of injections, so persist it as-is.
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

  /**
   * Find every copy of this sessionId (across workspaces).
   *
   * findSessionFile returns on the first hit, which is fine for reads; deleting only the first hit leaves
   * same-named copies in other workspaces as orphans — and rollback without --cwd means "all of them".
   */
  private findAllSessionFiles(sessionId: string, projectPath?: string): string[] {
    if (projectPath) {
      const target = path.join(this.resolveProjectDir(projectPath), `${sessionId}.jsonl`);
      return fileExists(target) ? [target] : [];
    }
    if (!dirExists(this.storageRoot)) return [];
    const out: string[] = [];
    for (const projDir of fs.readdirSync(this.storageRoot)) {
      const candidate = path.join(this.storageRoot, projDir, `${sessionId}.jsonl`);
      if (fileExists(candidate)) out.push(candidate);
    }
    return out;
  }

  async deleteSession(sessionId: string, projectPath?: string): Promise<boolean> {
    assertSafeSessionFileId(sessionId);
    const jsonlPaths = this.findAllSessionFiles(sessionId, projectPath);
    // Nothing to delete under this project: report it instead of printing ✓.
    if (jsonlPaths.length === 0) return false;

    let deleted = false;
    for (const jsonlPath of jsonlPaths) {
      try {
        fs.unlinkSync(jsonlPath);
        deleted = true;
      } catch {
        // ignore
      }

      // Delete the same-named subdirectory
      const subdir = jsonlPath.replace(/\.jsonl$/, '');
      if (dirExists(subdir)) {
        removeDirRecursive(subdir);
      }
    }
    return deleted;
  }
}
