/**
 * adapters/workbuddy.ts — WorkBuddy platform adapter.
 *
 * Reads and writes `~/.workbuddy/projects/<encoded-cwd>/<session-uuid>.jsonl`.
 * cwd encoding: `/` → `-`, with no leading `-` (same as CodeBuddy).
 *
 * Observed format (sampled on this machine at ~/.workbuddy/projects/... on 2026-09-10):
 *   {"id":"65d9...","logicalParentId":"65d9...","timestamp":1773734800538,
 *    "type":"message","role":"user","sessionId":"6d7b...",
 *    "content":[{"type":"input_text","text":"..."}],
 *    "providerData":{"references":[{"type":"memory","enabled":true,"memories":[]}]}}
 *
 * Line types are fully isomorphic with CodeBuddy:
 *   message / function_call / function_call_result / reasoning / ai-title
 *
 * Enhancements (vs CodeBuddy):
 * - The same directory has `<uuid>.meta.json`, which contains the real cwd and is preferred over decoding the directory name
 *   (directory-name encoding is irreversible: '-' may come from '/', a space, and similar, so decoding is lossy)
 * - meta.json also provides createdAt / updatedAt, preferred over inferring them from in-line timestamps
 * - providerData is kept in full on Message.metadata (including extension fields such as memory references)
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentAdapter, type SessionMeta, type SessionReadRef } from '@teamai/tool-core/sessions/base';
import { z } from 'zod';
import type { Session, SessionMetadata, Message, ContentBlock, ThinkingBlock, ToolArguments, ToolCallBlock, ToolResultBlock } from '@teamai/tool-core/sessions/ir';
import { imagePlaceholderText, MessageMetadataSchema, toolArgumentsFrom } from '@teamai/tool-core/sessions/ir';
import { CbContentItemSchema, cbRecords, type CbFunctionCallProviderData, type CbRecord, type CbWrittenLine } from './codebuddy-adapter.js';
import {
  encodeCwdCodeBuddy,
  decodeCwdGeneric,
  readJsonl,
  readJsonlHead,
  writeJsonl,
  fileExists,
  dirExists,
  removeDirRecursive,
  OptionalString,
} from '@teamai/tool-core/sessions/fs';
import { cleanTitleText, cutTitle, fallbackTitle, isInjectedText, titleFromCandidates, titleFromUserText } from '@teamai/tool-core/sessions/title';
import { assertSafeSessionFileId, deriveTargetSessionId } from '@teamai/tool-core/sessions/ids';
import { registerWorkBuddySession, unregisterWorkBuddySession } from './workbuddy-store.js';
import type { Processes } from '@teamai/shared/exec';
import { log } from '@teamai/shared/log';
import { readRegularFileSync, writeRegularFile } from '@teamai/shared/regular-file';

// ---------------------------------------------------------------------------
// Tool-name normalization map
// ---------------------------------------------------------------------------

const WB_TO_IR_TOOL: ReadonlyMap<string, string> = new Map([
  ['read_file', 'read_file'],
  ['write_file', 'write_file'],
  ['edit_file', 'edit_file'],
  ['bash', 'bash'],
  ['grep', 'grep'],
  ['glob', 'glob'],
  ['task', 'task'],
  ['todo_write', 'todo_write'],
]);

/**
 * IR → WorkBuddy tool name.
 *
 * Isomorphic with CodeBuddy: the client looks up icons and collapsed titles by camel-case UI names (Bash / Read / Write / Edit / Grep / Glob /
 * Task / TodoWrite ...). Writing the IR names `read_file`/`bash` directly makes the tool call render blank. Source-platform aliases are folded in here too, so they are not passed through unchanged.
 */
const IR_TO_WB_TOOL: ReadonlyMap<string, string> = new Map([
  ['read_file', 'Read'],
  ['write_file', 'Write'],
  ['edit_file', 'Edit'],
  ['bash', 'Bash'],
  ['grep', 'Grep'],
  ['glob', 'Glob'],
  ['task', 'Task'],
  ['todo_write', 'TodoWrite'],
  ['delete_file', 'DeleteFile'],
  ['web_fetch', 'WebFetch'],
  ['web_search', 'WebSearch'],
  ['semantic_search', 'SemanticSearch'],
  ['execute_command', 'Bash'],
  ['run_command', 'Bash'],
  ['write_to_file', 'Write'],
  ['replace_in_file', 'Edit'],
  ['multi_edit', 'Edit'],
  ['search_file', 'Glob'],
  ['search_content', 'Grep'],
  ['list_dir', 'Glob'],
  ['codebase_search', 'SemanticSearch'],
  ['read_lints', 'LSP'],
]);

function normalizeToolName(name: string): string {
  return WB_TO_IR_TOOL.get(name) ?? name;
}

function denormalizeToolName(irName: string): string {
  return IR_TO_WB_TOOL.get(irName) ?? irName;
}

/** Session title: first real user question > cleaned source title > Session <id> (same write-side strategy as codebuddy-ide). */
function resolveSessionTitle(session: Session, sessionId: string): string {
  for (const m of session.messages) {
    if (m.role !== 'user') continue;

    for (const b of m.content) {
      if (b.type !== 'text') continue;
      const t = titleFromUserText(b.text);

      if (t) return t;
    }
  }

  return cleanTitleText(session.title) || fallbackTitle(sessionId);
}

/** Summary text shown for a tool call when collapsed (native providerData.argumentsDisplayText). */
function argumentsDisplayText(name: string, args: ToolArguments | undefined): string {
  if (!args) return name;

  const preferred = z.string().safeParse(
    args.command ?? args.path ?? args.pattern ?? args.glob_pattern ?? args.target_directory ??
    args.target_file ?? args.query ?? args.url ?? args.filePath,
  );

  if (preferred.success && preferred.data.trim()) {
    return preferred.data.length > 160 ? `${preferred.data.slice(0, 160)}…` : preferred.data;
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
// meta.json
// ---------------------------------------------------------------------------

/** `<uuid>.meta.json`; a field of another type reads as absent. */
const WorkBuddyMetaSchema = z.object({
  cwd: OptionalString,
  createdAt: z.number().optional().catch(undefined),
  updatedAt: z.number().optional().catch(undefined),
  sourceConversationId: OptionalString,
  isPlayground: z.boolean().optional().catch(undefined),
  migratedFrom: OptionalString,
});

type WorkBuddyMeta = z.infer<typeof WorkBuddyMetaSchema>;

/**
 * Read `<uuid>.meta.json` from the same directory as the session jsonl.
 * Return an empty object when it is missing or corrupt (the caller falls back to decoding the directory name).
 */
function readMeta(jsonlPath: string): WorkBuddyMeta {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');

  try {
    if (!fileExists(metaPath)) return {};

    return WorkBuddyMetaSchema.parse(JSON.parse(readRegularFileSync(metaPath, 'utf-8')));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// WorkBuddyAdapter
// ---------------------------------------------------------------------------

export class WorkBuddyAdapter extends AgentAdapter {
  readonly platform = 'workbuddy';
  private readonly storageRoot: string;

  /** @param storageRoot The session store (the registry passes the member's, `sessionStoreDir`). */
  constructor(storageRoot: string, private readonly processes: Processes) {
    super();
    this.storageRoot = storageRoot;
  }

  isReady(): boolean {
    return dirExists(this.storageRoot);
  }

  private resolveProjectDir(projectPath?: string): string {
    const root = this.storageRoot;

    if (projectPath) {
      // Must use the same encoding as writeSession (encodeCwdCodeBuddy, which keeps spaces):
      // native workspace directory names keep spaces. encodeCwdGeneric (space → '-') points at an empty directory,
      // which shows up as "list by cwd = 0" — the full set can be read, but workspace filtering drops everything.
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

  async listConversations(projectPath?: string): Promise<SessionMeta[]> {
    const metas: SessionMeta[] = [];
    const root = this.storageRoot;

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
    const userTextCandidates: string[] = [];
    let aiTitle = '';

    try {
      for (const record of cbRecords(readJsonlHead(jsonlPath, 80))) {
        const rtype = record.type;

        if (rtype === 'ai-title') {
          aiTitle = String(record.aiTitle ?? '');
          continue;
        }

        // Infer from in-line timestamps only when meta.json did not cover them
        const tsRaw = record.timestamp;

        if (tsRaw !== undefined) {
          const ts = fromUnixMs(Number(tsRaw));

          if (!createdAt) createdAt = ts;

          if (!metaInfo.updatedAt) updatedAt = ts;
        }

        if (rtype === 'message') {
          messageCount++;
          const role = record.role;

          if (role === 'user' && userTextCandidates.length < 5) {
            const content = record.content;

            if (Array.isArray(content)) {
              const parts: string[] = [];

              for (const item of content) {
                const block = CbContentItemSchema.safeParse(item);

                if (block.success && block.data.type === 'input_text') {
                  parts.push(block.data.text);
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

    if (!createdAt) createdAt = new Date().toISOString();

    if (!updatedAt) updatedAt = createdAt;

    // aiTitle is the title WorkBuddy itself chose, so it is the most reliable; injected-text cleaning matches the codebuddy adapter
    title =
      (aiTitle && !isInjectedText(aiTitle) && cutTitle(aiTitle)) ||
      titleFromCandidates(userTextCandidates) ||
      fallbackTitle(sessionId);

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

  async readSession(ref: SessionReadRef): Promise<Session> {
    // The listed file, else the id in the workspace, else the id anywhere.
    const jsonlPath =
      ref.filePath ??
      this.findSessionFile(ref.sessionId, ref.projectPath) ??
      (ref.projectPath ? this.findSessionFile(ref.sessionId) : null);

    if (!jsonlPath) {
      throw new Error(`WorkBuddy session file not found: session_id=${ref.sessionId}`);
    }

    // The file name is the id: a listed file decides it, not the request.
    const sessionId = path.basename(jsonlPath, '.jsonl');

    const metaInfo = readMeta(jsonlPath);
    const cwd = metaInfo.cwd ?? decodeCwdGeneric(path.basename(path.dirname(jsonlPath)));
    const records = [...cbRecords(readJsonl(jsonlPath))];

    let title = '';
    let createdAt = metaInfo.createdAt !== undefined ? fromUnixMs(metaInfo.createdAt) : undefined;
    let updatedAt = metaInfo.updatedAt !== undefined ? fromUnixMs(metaInfo.updatedAt) : undefined;
    const sessionMetadata: SessionMetadata = {};
    const messages: Message[] = [];

    if (metaInfo.sourceConversationId) sessionMetadata.sourceConversationId = metaInfo.sourceConversationId;

    if (metaInfo.isPlayground !== undefined) sessionMetadata.isPlayground = metaInfo.isPlayground;

    if (metaInfo.migratedFrom) sessionMetadata.originator = metaInfo.migratedFrom;

    // First pass: extract title / timestamps
    for (const rec of records) {
      const rtype = rec.type;

      if (rtype === 'ai-title') {
        // Same as the codebuddy adapter: injected-block text is occasionally stored as ai-title, and taking it as-is pollutes the migration path
        const t = String(rec.aiTitle ?? '');

        if (t && !isInjectedText(t)) title = cutTitle(t, 100);
        continue;
      }

      const tsRaw = rec.timestamp;

      if (tsRaw !== undefined) {
        const ts = fromUnixMs(Number(tsRaw));

        if (!createdAt) createdAt = ts;

        if (!metaInfo.updatedAt) updatedAt = ts;
      }
    }

    // Second pass: build messages
    for (const rec of records) {
      const rtype = rec.type;

      if (rtype === 'message') {
        const role = rec.role;

        if (role !== 'user' && role !== 'assistant') continue;

        const content = this.parseMessageContent(rec);

        const msg: Message = {
          role,
          content,
          messageId: OptionalString.parse(rec.id),
          parentId: OptionalString.parse(rec.parentId),
          timestamp: rec.timestamp !== undefined ? fromUnixMs(Number(rec.timestamp)) : undefined,
        };

        // Keep providerData in full (including WorkBuddy extension fields such as memory references)
        const providerData = rec.providerData;

        if (providerData) {
          const md = MessageMetadataSchema.parse(providerData);

          if (md.model !== undefined) {
            if (!sessionMetadata.model) sessionMetadata.model = md.model;
          }

          msg.metadata = md;
        }

        messages.push(msg);
      } else if (rtype === 'function_call') {
        const name = String(rec.name ?? '');
        const irName = normalizeToolName(name);
        const callId = String(rec.callId ?? rec.id ?? '');
        const arguments_ = toolArgumentsFrom(rec.providerData?.arguments ?? rec.arguments);
        const block: ToolCallBlock = { type: 'tool_call', toolName: irName, callId, arguments: arguments_ };

        if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
          messages[messages.length - 1].content.push(block);
        } else {
          messages.push({ role: 'assistant', content: [block] });
        }
      } else if (rtype === 'function_call_result') {
        const callId = String(rec.callId ?? '');
        const contentStr = rec.output?.text ?? '';

        const status = String(rec.status ?? 'completed');
        const isError = status === 'failed' || status === 'error';
        const block: ToolResultBlock = { type: 'tool_result', callId, content: contentStr, isError };

        if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
          messages[messages.length - 1].content.push(block);
        } else {
          messages.push({ role: 'user', content: [block] });
        }
      } else if (rtype === 'reasoning') {
        let text = '';

        for (const item of rec.rawContent ?? []) {
          const part = CbContentItemSchema.safeParse(item);

          if (part.success && part.data.type === 'reasoning_text') {
            text += part.data.text;
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
              if (isInjectedText(block.text)) continue; // injected blocks are not titles
              title = cleanTitleText(block.text);

              if (title) break;
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

  private parseMessageContent(rec: CbRecord): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    const contentArr = rec.content;

    if (contentArr === undefined) return blocks;

    if (!Array.isArray(contentArr)) {
      blocks.push({ type: 'text', text: contentArr });

      return blocks;
    }

    for (const item of contentArr) {
      const it = CbContentItemSchema.safeParse(item);

      if (!it.success) continue;
      const itemType = it.data.type;
      const text = it.data.text;

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
      idFormat: 'uuid',
      targetCwd: cwd,
      sourceSessionId: session.sessionId,
    });

    // WorkBuddy is isomorphic with CodeBuddy: project directory names keep spaces (observed CodeBuddy on disk as
    // `Users-caiwenzhe-Desktop-Code-teamai cli`). encodeCwdGeneric would also turn spaces into
    // `-`, so the directory name would not match what the client computes from the current cwd → the session would not appear in that project's list.
    const projDir = path.join(this.storageRoot, encodeCwdCodeBuddy(cwd));
    const jsonlPath = path.join(projDir, `${sessionId}.jsonl`);

    const records: CbWrittenLine[] = [];

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

      const thinkingBlocks = msg.content.filter((b) => b.type === 'thinking');
      const otherBlocks = msg.content.filter((b) => b.type !== 'thinking');

      // reasoning line
      for (const tb of thinkingBlocks) {
        const reasoningId = uuidV4();
        records.push({
          id: reasoningId,
          parentId,
          timestamp: toUnixMs(msg.timestamp),
          type: 'reasoning',
          providerData: msg.metadata?.model ? { model: msg.metadata.model } : {},
          content: [],
          rawContent: [{ type: 'reasoning_text', text: tb.text }],
          sessionId,
          cwd,
        });
        parentId = reasoningId;
      }

      // message line
      if (otherBlocks.length > 0) {
        const wbContent: Array<{ type: 'input_text' | 'output_text'; text: string }> = [];
        let hasText = false;

        for (const block of otherBlocks) {
          if (block.type === 'text') {
            wbContent.push({
              type: msg.role === 'user' ? 'input_text' : 'output_text',
              text: block.text,
            });
            hasText = true;
          } else if (block.type === 'image') {
            // WorkBuddy message bodies do not store images; degrade to placeholder text (counted as degraded fidelity)
            wbContent.push({
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
            content: wbContent,
            providerData: msg.metadata?.model ? { model: msg.metadata.model } : {},
            sessionId,
            cwd,
          });
          parentId = msgId;
        }
      }

      // function_call line
      // Same as CodeBuddy/native: top-level arguments is a JSON string, the collapsed summary goes in
      // argumentsDisplayText, and callId must be non-empty (otherwise it cannot be paired with the result).
      for (const block of otherBlocks) {
        if (block.type === 'tool_call') {
          const fcId = block.callId || uuidV4();
          const callId = block.callId || `call_${uuidV4()}`;
          const name = denormalizeToolName(block.toolName);

          const providerData: CbFunctionCallProviderData = {
            arguments: block.arguments,
            argumentsDisplayText: argumentsDisplayText(name, block.arguments),
          };

          if (msg.metadata?.model) providerData.model = msg.metadata.model;
          records.push({
            id: fcId,
            parentId,
            timestamp: toUnixMs(msg.timestamp),
            type: 'function_call',
            name,
            callId,
            arguments: JSON.stringify(block.arguments ?? {}),
            providerData,
            sessionId,
            cwd,
          });
          parentId = fcId;
        }
      }

      // function_call_result line
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
    }

    writeJsonl(jsonlPath, records);

    // Write meta.json — keep the real cwd so later reads do not depend on lossy directory-name decoding
    try {
      const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
      await writeRegularFile(
        metaPath,
        JSON.stringify(
          {
            createdAt: toUnixMs(session.createdAt),
            updatedAt: toUnixMs(session.updatedAt),
            cwd,
            sourceConversationId: sessionId,
            // Stay consistent with the DB is_playground flag: 0 / false → listed under "spaces"
            isPlayground: false,
          },
          null,
          2,
        ),
      );
    } catch {
      // A failed meta.json write does not affect the main flow
    }

    // Register into workbuddy.db — WorkBuddy's list queries the sessions table, and without registration the session is completely invisible
    // (jsonl is only the session body; list entries and space membership live in the DB). Best-effort.
    try {
      const reg = registerWorkBuddySession({
        store: this.storageRoot,
        cwd,
        sessionId,
        title: resolveSessionTitle(session, sessionId),
        createdAtMs: toUnixMs(session.createdAt),
        // Latest activity = migration time: the list sorts by updated_at, and keeping the source time would bury the session in an old date group
        updatedAtMs: Date.now(),
        model: session.metadata?.model,
      }, this.processes);

      if (!reg.ok) {
        const notice =
          `WorkBuddy session list registration failed (transcript written, session may be invisible in WorkBuddy): ${reg.reason ?? 'unknown'}`;

        log.debug(`workbuddy register failed: session=${sessionId} reason=${reg.reason ?? 'unknown'}`);
        this.noteWrite(notice);
      }
    } catch (e) {
      const notice = `WorkBuddy session list registration error: ${e instanceof Error ? e.message : String(e)}`;
      log.debug(notice);
      this.noteWrite(notice);
    }

    return sessionId;
  }

  async deleteSession(sessionId: string, projectPath?: string): Promise<boolean> {
    assertSafeSessionFileId(sessionId);
    // Resolve the scoped transcript first: unregistering is global, so doing
    // it before the lookup would drop another workspace's copy of the same
    // session id when `rollback --cwd` matched nothing here.
    const jsonlPath = this.findSessionFile(sessionId, projectPath);

    if (!jsonlPath) return false;

    // Drop the DB registration (otherwise deleting the jsonl leaves an unopenable session in the WorkBuddy list)
    try {
      unregisterWorkBuddySession(this.storageRoot, sessionId, this.processes);
    } catch {
      // best-effort
    }

    let deleted = false;

    try {
      fs.unlinkSync(jsonlPath);
      deleted = true;
    } catch {
      deleted = false;
    }

    const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');

    if (fileExists(metaPath)) {
      try {
        fs.unlinkSync(metaPath);
      } catch {
        // ignore
      }
    }

    // Delete the same-named subdirectory (subagents and similar)
    const subdir = jsonlPath.replace(/\.jsonl$/, '');

    if (dirExists(subdir)) {
      removeDirRecursive(subdir);
    }

    return deleted;
  }
}
