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
import { z } from 'zod';
import { AgentAdapter, type SessionMeta, type SessionReadRef, type Subagent, type SubagentsRead } from './base.js';
import type { Session, SessionMetadata, Message, ContentBlock, ImageBlock, ThinkingBlock, ToolArguments } from '../ir.js';
import { assertSafeSessionFileId, deriveTargetSessionId } from '../ids.js';
import { imagePlaceholderText } from '../ir.js';
import {
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
  coercedText,
  OptionalString,
} from '../fs.js';
import { JsonValueSchema, type JsonValue, JsonObjectSchema } from '../../types.js';
import { sessionStoreDir } from '../../locate.js';
import {
  cleanTitleText,
  fallbackTitle,
  titleFromCandidates,
} from '../title.js';
import type { JsonlRecord } from '../../utils/jsonl-store.js';
import { parseJson } from '../../utils/json.js';

// ---------------------------------------------------------------------------
// Tool-name normalization map
// ---------------------------------------------------------------------------

const CC_TO_IR_TOOL: ReadonlyMap<string, string> = new Map([
  ['Read', 'read_file'],
  ['Write', 'write_file'],
  ['Edit', 'edit_file'],
  ['MultiEdit', 'multi_edit'],
  ['Bash', 'bash'],
  ['Glob', 'glob'],
  ['Grep', 'grep'],
  ['WebSearch', 'web_search'],
  ['WebFetch', 'web_fetch'],
  ['Task', 'task'],
  ['TodoWrite', 'todo_write'],
  ['NotebookEdit', 'notebook_edit'],
  ['LSP', 'lsp'],
  ['ListMcpResourcesTool', 'list_mcp_resources'],
]);

const IR_TO_CC_TOOL: ReadonlyMap<string, string> = new Map([...CC_TO_IR_TOOL].map(([k, v]) => [v, k]));

function normalizeToolName(ccName: string): string {
  return CC_TO_IR_TOOL.get(ccName) ?? ccName;
}

function denormalizeToolName(irName: string): string {
  return IR_TO_CC_TOOL.get(irName) ?? irName;
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
// Transcript lines as Claude Code writes them
// ---------------------------------------------------------------------------

/** Anthropic image format: {type:'image', source:{type:'base64', media_type, data}} (also {type:'url', url}). */
const CcImageSourceSchema = z.object({
  data: OptionalString,
  url: OptionalString,
  media_type: coercedText('image/png'),
});

/** One content block of a message (or of a tool_result's content); a field of another type reads as absent. */
const CcBlockSchema = z.object({
  type: JsonValueSchema.optional(),
  text: coercedText(),
  thinking: coercedText(),
  signature: JsonValueSchema.optional(),
  name: coercedText(),
  id: coercedText(),
  input: JsonObjectSchema.optional().catch(undefined),
  tool_use_id: coercedText(),
  content: JsonValueSchema.optional(),
  is_error: JsonValueSchema.optional(),
  url: OptionalString,
  source: CcImageSourceSchema.optional().catch(undefined),
});

type CcBlock = z.infer<typeof CcBlockSchema>;

/** A part of a tool_result's content: a block, or a bare string read as a text block. */
const CcResultPartSchema = z.union([z.string().transform((text) => CcBlockSchema.parse({ type: 'text', text })), CcBlockSchema]);

/** A message's content: the text itself, or a list of blocks. */
const CcContentSchema = z.union([z.string(), z.array(JsonValueSchema)]).optional().catch(undefined);

/** One transcript line, the fields TeamAI reads; a field of another type reads as absent. */
const CcRecordSchema = z.object({
  type: OptionalString,
  timestamp: OptionalString,
  summary: JsonValueSchema.optional(),
  cwd: OptionalString,
  uuid: OptionalString,
  parentUuid: z.string().nullish().catch(undefined),
  isSidechain: JsonValueSchema.optional(),
  isMeta: JsonValueSchema.optional(),
  promptId: OptionalString,
  message: z.object({ content: CcContentSchema, model: OptionalString }).optional().catch(undefined),
});

type CcRecord = z.infer<typeof CcRecordSchema>;

/** The lines of a transcript that parse as JSON objects, each read by `CcRecordSchema`. */
function* ccRecords(lines: Iterable<JsonlRecord>): Generator<CcRecord> {
  for (const line of lines) yield CcRecordSchema.parse(line);
}

// ---------------------------------------------------------------------------
// Content-block parsing (CC → IR)
// ---------------------------------------------------------------------------

/**
 * Images returned inside a tool_result (e.g. Read on a screenshot) have no slot in the IR tool_result;
 * they go to `toolResultImages` so the caller can place them after the tool-result message.
 */
function parseCcContentBlocks(content: CcRecordContent, toolResultImages: ImageBlock[] = []): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (content === undefined) return blocks;

  if (!Array.isArray(content)) {
    blocks.push({ type: 'text', text: content });

    return blocks;
  }

  for (const block of content) {
    const parsed = CcBlockSchema.safeParse(block);

    if (!parsed.success) continue;
    const b = parsed.data;
    const btype = b.type;

    if (btype === 'thinking') {
      const thinking: ThinkingBlock = { type: 'thinking', text: b.thinking };

      if (b.signature) thinking.signature = String(b.signature);
      blocks.push(thinking);
    } else if (btype === 'text') {
      blocks.push({ type: 'text', text: b.text });
    } else if (btype === 'tool_use') {
      blocks.push({
        type: 'tool_call',
        toolName: normalizeToolName(b.name),
        callId: b.id,
        arguments: b.input ?? {},
      });
    } else if (btype === 'tool_result') {
      let rawContent: string;

      if (Array.isArray(b.content)) {
        const parts: string[] = [];

        for (const item of b.content) {
          const part = CcResultPartSchema.safeParse(item);

          if (!part.success) continue;

          if (part.data.type === 'text') {
            parts.push(part.data.text);
          } else if (part.data.type === 'image') {
            const image = parseCcImage(part.data);

            if (image) toolResultImages.push(image);
          }
        }

        rawContent = parts.join('\n');
      } else {
        rawContent = String(b.content ?? '');
      }

      blocks.push({
        type: 'tool_result',
        callId: b.tool_use_id,
        content: rawContent,
        isError: Boolean(b.is_error ?? false),
      });
    } else if (btype === 'image') {
      // Screenshot pasted into the input box.
      // If it is not parsed, the image never enters the IR or the target, yet fidelity still reports 100% (silent undercount).
      const image = parseCcImage(b);

      if (image) blocks.push(image);
    }
  }

  return blocks;
}

type CcRecordContent = z.infer<typeof CcContentSchema>;

/**
 * Anthropic image format: {type:'image', source:{type:'base64', media_type, data}} (also {type:'url', url}).
 */
function parseCcImage(b: CcBlock): ImageBlock | undefined {
  const src = b.source;
  const data = src?.data;
  const url = b.url ?? src?.url;

  if (!data && !url) return undefined;
  const mimeType = src?.media_type ?? 'image/png';
  const image: ImageBlock = { type: 'image', mimeType };

  // Carry base64 as-is; a URL-only form keeps just the pointer (the write side degrades by target capability)
  if (data) image.data = data;

  if (url) image.filePath = url;
  image.label = guessImageLabel(mimeType);

  return image;
}

/** Inline images have no filename; derive a readable placeholder from the mime type (used when writing back or degrading to a placeholder). */
function guessImageLabel(mimeType: string): string {
  const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';

  return `image.${ext}`;
}

// ---------------------------------------------------------------------------
// Content-block serialization (IR → CC)
// ---------------------------------------------------------------------------

/** A content block as TeamAI writes it to a Claude Code message. */
type CcWrittenBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: ToolArguments }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

function irBlockToCc(block: ContentBlock, session?: Session): CcWrittenBlock | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking': {
      const thinking: CcWrittenBlock = { type: 'thinking', thinking: block.text };

      if (block.signature) thinking.signature = block.signature;

      return thinking;
    }

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
      if (!data && block.filePath && mayReadLocalImageFile(session, block.filePath)) {
        try {
          data = fs.readFileSync(block.filePath).toString('base64');
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

/** The message object of a user or assistant line TeamAI writes. */
interface CcWrittenMessage {
  role: Message['role'];
  content: CcWrittenBlock[];
  model?: string;
}

/** The fields every line on the conversation chain carries. */
interface CcWrittenChainFields {
  parentUuid: string | null;
  isSidechain: false;
  uuid: string;
  timestamp: string;
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch: string;
  userType: 'external';
  entrypoint: 'cli';
}

interface CcWrittenMessageLine extends CcWrittenChainFields {
  type: Message['role'];
  message: CcWrittenMessage;
  isMeta?: true;
  promptId?: string;
}

/** A line TeamAI writes to a Claude Code transcript, so Claude Code can load and resume the session. */
type CcWrittenLine =
  | { type: 'mode'; mode: 'normal'; sessionId: string }
  | { type: 'permission-mode'; permissionMode: 'default'; sessionId: string }
  | (CcWrittenChainFields & { attachment: { type: 'deferred_tools_delta'; addedNames: string[] } })
  | CcWrittenMessageLine
  | {
    type: 'file-history-snapshot';
    messageId: string;
    snapshot: { messageId: string; trackedFileBackups: Record<string, never>; timestamp: string };
    isSnapshotUpdate: false;
  }
  | { type: 'last-prompt'; lastPrompt: string; leafUuid: string | null; sessionId: string }
  | { type: 'summary'; summary: string; leafUuid: string | null; sessionId: string };

const SubagentMetaSchema = z.object({
  toolUseId: z.string().optional(),
  spawnDepth: z.number().int().positive().optional(),
  finished: z.boolean().optional(),
});

function readJsonFile(file: string): JsonValue | undefined {
  try {
    return parseJson(fs.readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

function toolCallIds(session: Session): string[] {
  return session.messages.flatMap((message) => message.content.flatMap((block) => (block.type === 'tool_call' ? [block.callId] : [])));
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
    this.storageRoot = storageRoot ?? sessionStoreDir('claude-code', undefined);
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
      for (const record of ccRecords(readJsonlHead(jsonlPath, 200))) {
        const rtype = record.type;
        const ts = parseCcTimestamp(record.timestamp);

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
          if (recordedCwd === undefined && record.cwd !== undefined && path.isAbsolute(record.cwd)) {
            recordedCwd = record.cwd;
          }

          if (rtype === 'user' && userTextCandidates.length < 5) {
            const content = record.message?.content;

            if (Array.isArray(content)) {
              const parts: string[] = [];

              for (const item of content) {
                const block = CcBlockSchema.safeParse(item);

                if (block.success && block.data.type === 'text') {
                  parts.push(block.data.text);
                }
              }

              if (parts.length) userTextCandidates.push(parts.join(' '));
            } else if (content !== undefined) {
              userTextCandidates.push(content);
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

    return this.readTranscript(jsonlPath, 'main');
  }

  /**
   * The agents a session started: `<session id>/subagents/agent-<id>.jsonl` beside its transcript, each with a
   * `.meta.json` naming the tool call that started it (`toolUseId`). Each agent follows the session or agent whose
   * call started it, in call order; one whose call is not found goes last.
   */
  async readSubagents(session: Session, ref: SessionReadRef): Promise<SubagentsRead> {
    const jsonlPath = ref.filePath ?? this.findSessionFile(session.sessionId, ref.projectPath);

    if (!jsonlPath) return { status: 'unread', reason: `The transcript of session ${session.sessionId} was not found again` };
    const dir = path.join(path.dirname(jsonlPath), path.basename(jsonlPath, '.jsonl'), 'subagents');

    if (!dirExists(dir)) return { status: 'read', agents: [] };

    const read = fs.readdirSync(dir).filter((name) => /^agent-.+\.jsonl$/.test(name)).sort().map((name) => {
      const meta = SubagentMetaSchema.safeParse(readJsonFile(path.join(dir, name.replace(/\.jsonl$/, '.meta.json'))));
      const agent = this.readTranscript(path.join(dir, name), 'subagent');

      return { agent, meta: meta.success ? meta.data : {} };
    });

    const ordered: Subagent[] = [];
    const placed = new Set<number>();

    const visit = (parent: Session, depth: number): void => {
      for (const callId of toolCallIds(parent)) {
        read.forEach((item, index) => {
          if (placed.has(index) || item.meta.toolUseId !== callId) return;
          placed.add(index);
          ordered.push({ session: item.agent, depth: item.meta.spawnDepth ?? depth, finished: item.meta.finished === true });
          visit(item.agent, depth + 1);
        });
      }
    };

    visit(session, 1);
    read.forEach((item, index) => {
      if (!placed.has(index)) ordered.push({ session: item.agent, depth: item.meta.spawnDepth ?? 1, finished: item.meta.finished === true });
    });

    return { status: 'read', agents: ordered };
  }

  private readTranscript(jsonlPath: string, chain: 'main' | 'subagent'): Session {
    // The file name is the id: a listed file decides it, not the request.
    const sessionId = path.basename(jsonlPath, '.jsonl');

    const cwd =
      bestEffortDecodeCwdClaude(path.basename(path.dirname(jsonlPath))) ??
      decodeCwdClaude(path.basename(path.dirname(jsonlPath)));

    // Collect every message record
    const rawRecords: CcRecord[] = [];
    let nativeCwd: string | undefined;
    let summaryTitle: string | undefined;

    for (const record of ccRecords(readJsonl(jsonlPath))) {
      const rtype = record.type;

      if (rtype === 'summary') {
        // Title line written by writeSession (CC /resume uses it too). If the read side ignores it,
        // the title drifts to the first user text after a roundtrip (which may be a leftover fragment after injection cleaning).
        const t = String(record.summary ?? '');

        if (t) summaryTitle = t; // Take the last one (writeSession appends it at the end of the file)
        continue;
      }

      if (rtype === undefined || SKIP_TYPES.has(rtype)) continue;

      if (rtype !== 'user' && rtype !== 'assistant') continue;

      // Every message record carries the real cwd (absolute path). Decoding the directory name is lossy
      // (`-` may come from `/` or a space), so the archive key (repoIdentity) must prefer
      // the native cwd in the record (design doc Key invariant); if recovery fails, fall back to the decoded directory name.
      if (nativeCwd === undefined && record.cwd !== undefined && path.isAbsolute(record.cwd)) {
        nativeCwd = record.cwd;
      }

      rawRecords.push(record);
    }

    // The cwd in the record is sometimes an encoded directory name (`-Users-foo-project`), not a real path:
    // decode it back to the real workspace so migration can "keep the source session's workspace" rather than falling back to the current directory.
    const sessionCwd = nativeCwd ?? bestEffortDecodeCwdClaude(cwd) ?? cwd;

    // Flatten the DAG
    const messages = this.flattenDag(rawRecords, chain);

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
      const ts = parseCcTimestamp(record.timestamp);

      if (ts) {
        if (!createdAt) createdAt = ts;
        updatedAt = ts;
      }
    }

    if (!createdAt) createdAt = new Date().toISOString();

    if (!updatedAt) updatedAt = createdAt;

    const metadata: SessionMetadata = {};

    for (let i = rawRecords.length - 1; i >= 0; i--) {
      if (rawRecords[i].type === 'assistant') {
        const model = rawRecords[i].message?.model;

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
  private flattenDag(rawRecords: CcRecord[], chain: 'main' | 'subagent'): Message[] {
    const mainChain = rawRecords.filter((r) => Boolean(r.isSidechain) === (chain === 'subagent'));

    // uuid → record (main-chain records only)
    const uuidToRecord = new Map<string, CcRecord>();

    for (const record of mainChain) {
      const uid = record.uuid;

      if (uid) uuidToRecord.set(uid, record);
    }

    // parentUuid → children
    const childrenMap = new Map<string | null, CcRecord[]>();
    const roots: CcRecord[] = [];

    for (const record of mainChain) {
      const parent = record.parentUuid ?? null;

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
    const ordered: CcRecord[] = [];
    const visited = new Set<string>();
    const stack: CcRecord[] = roots.toReversed();

    while (stack.length > 0) {
      const record = stack.pop()!;
      const uid = record.uuid;

      if (uid && visited.has(uid)) continue;

      if (uid) visited.add(uid);
      ordered.push(record);

      if (uid) {
        stack.push(...(childrenMap.get(uid) ?? []).toReversed());
      }
    }

    // Convert to IR Message
    const messages: Message[] = [];
    // Images returned by tools go in a user message of their own after the round's tool results
    // (Claude Code writes each parallel tool_result as its own record)
    let toolImages: ImageBlock[] = [];

    const flushToolImages = (timestamp?: string) => {
      if (toolImages.length === 0) return;
      messages.push({ role: 'user', content: toolImages, timestamp });
      toolImages = [];
    };

    for (const record of ordered) {
      const images: ImageBlock[] = [];
      const msg = this.recordToMessage(record, images);

      if (!msg) continue;
      const toolResultsOnly = msg.role === 'user' && msg.content.length > 0 && msg.content.every((b) => b.type === 'tool_result');

      if (!toolResultsOnly) flushToolImages(messages[messages.length - 1]?.timestamp);
      messages.push(msg);
      toolImages.push(...images);
    }

    flushToolImages(messages[messages.length - 1]?.timestamp);

    return messages;
  }

  private recordToMessage(record: CcRecord, toolResultImages?: ImageBlock[]): Message | null {
    const rtype = record.type;

    if (rtype !== 'user' && rtype !== 'assistant') return null;

    const msgObj = record.message;

    if (!msgObj) return null;

    const content = msgObj.content;
    const blocks = parseCcContentBlocks(content, toolResultImages);

    const timestamp = parseCcTimestamp(record.timestamp);
    const messageId = record.uuid;
    const parentId = record.parentUuid ?? undefined;

    const metadata: Message['metadata'] = {};

    if (rtype === 'assistant') {
      const model = msgObj.model;

      if (model) metadata.model = model;
    }

    if (record.isMeta) metadata.isMeta = true;

    if (record.promptId) metadata.promptId = record.promptId;

    return {
      role: rtype,
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
  private sessionToCcRecords(session: Session, sessionId: string, cwd: string): CcWrittenLine[] {
    const records: CcWrittenLine[] = [];
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
      const ccBlocks: CcWrittenBlock[] = [];

      for (const block of msg.content) {
        const ccBlock = irBlockToCc(block, session);

        if (ccBlock) ccBlocks.push(ccBlock);
      }

      // CC message object
      const ccMessage: CcWrittenMessage = { role: msg.role, content: ccBlocks };

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
      const record: CcWrittenMessageLine = {
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
