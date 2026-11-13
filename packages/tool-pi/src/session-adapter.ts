/** Pi and Oh My Pi v3 JSONL session adapter (read-only). */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentAdapter, ToolUnavailableError, type SessionMeta, type SessionReadRef } from '@teamai/tool-core/sessions/base';
import { z } from 'zod';
import { ToolArgumentsSchema, type ContentBlock, type Message, type Session, type ThinkingBlock } from '@teamai/tool-core/sessions/ir';
import { fallbackTitle } from '@teamai/tool-core/sessions/title';
import { isSafeSessionFileId } from '@teamai/tool-core/sessions/ids';
import { OptionalString, resolveRealCwd, TextOrBlocksSchema } from '@teamai/tool-core/sessions/fs';
import { JsonValueSchema } from '@teamai/shared/json';
import { readRegularFileSync } from '@teamai/shared/regular-file';

/** A time as ISO 8601, from epoch milliseconds or a date string; anything that is not a time reads as absent. */
function isoOf(value: number | string): string | undefined {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

const PiTime = z.union([z.number(), z.string()]).transform(isoOf).optional().catch(undefined);

/** One content block of a message; a field of another type reads as absent. */
const PiBlockSchema = z.object({
  type: JsonValueSchema.optional(),
  text: OptionalString,
  thinking: OptionalString,
  thinkingSignature: OptionalString,
  id: OptionalString,
  name: OptionalString,
  arguments: ToolArgumentsSchema.optional().catch(undefined),
  data: OptionalString,
  mimeType: OptionalString,
});

type PiBlock = z.infer<typeof PiBlockSchema>;

/** The `message` of a message entry. */
const PiMessageSchema = z.object({
  role: OptionalString,
  timestamp: PiTime,
  model: OptionalString,
  content: TextOrBlocksSchema,
  toolCallId: OptionalString,
  isError: JsonValueSchema.optional(),
  command: OptionalString,
  output: OptionalString,
});

type PiMessage = z.infer<typeof PiMessageSchema>;

/** One session file record (the title slot, the header, or an entry), the fields TeamAI reads. */
const PiRecordSchema = z.object({
  type: OptionalString,
  id: OptionalString,
  parentId: OptionalString,
  activeLeafId: z.string().nullable().optional().catch(undefined),
  title: OptionalString,
  name: OptionalString,
  cwd: OptionalString,
  timestamp: PiTime,
  model: OptionalString,
  provider: OptionalString,
  modelId: OptionalString,
  message: PiMessageSchema.optional().catch(undefined),
});

type PiRecord = z.infer<typeof PiRecordSchema>;

/** `.pi/settings.json` in a project. */
const PiSettingsSchema = z.object({ sessionDir: OptionalString });

interface ParsedFile {
  filePath: string;
  header: PiRecord;
  entries: PiRecord[];
  title?: string;
}

/** OMP puts a fixed-width `title` record before the ordinary Pi session header. */
function parseFile(filePath: string): ParsedFile | undefined {
  let lines: string[];

  try {
    lines = readRegularFileSync(filePath, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
  } catch {
    return undefined;
  }

  const records: PiRecord[] = [];

  for (const line of lines) {
    try {
      const record = PiRecordSchema.safeParse(JSON.parse(line));

      if (record.success) records.push(record.data);
    } catch {
      // A partially-written last line does not hide the readable prefix.
    }
  }

  const titleSlot = records[0]?.type === 'title' ? records.shift() : undefined;
  const headerIndex = records.findIndex((record) => record.type === 'session');

  if (headerIndex < 0) return undefined;
  const [header] = records.splice(headerIndex, 1);

  return { filePath, header, entries: records, title: titleSlot?.title ?? header.title };
}

/** Pi's active branch: follow parentId from the recorded leaf rather than including abandoned branches. */
function activeEntries(entries: PiRecord[]): PiRecord[] {
  if (entries.length === 0) return [];
  const byId = new Map(entries.flatMap((entry) => entry.id !== undefined ? [[entry.id, entry] as const] : []));
  const last = entries.at(-1)!;

  if (last.activeLeafId === null) return [];

  const leaf = last.activeLeafId ?? last.id;

  const follow = (start: string | undefined): PiRecord[] => {
    let id = start;
    const branch: PiRecord[] = [];
    const seen = new Set<string>();

    while (id && !seen.has(id)) {
      seen.add(id);
      const entry = byId.get(id);

      if (!entry) break;
      branch.push(entry);
      id = entry.parentId;
    }

    return branch.toReversed();
  };

  const active = follow(leaf);

  return active.length > 0 ? active : follow(last.id);
}

function modelOf(entries: PiRecord[]): string | undefined {
  let model: string | undefined;

  for (const entry of entries) {
    if (entry.type === 'model_change') {
      const changed = entry.model ?? [entry.provider, entry.modelId].filter(Boolean).join('/');

      if (changed) model = changed;
    } else if (entry.type === 'message') {
      const stored = entry.message;

      if (stored?.role === 'assistant' && stored.model !== undefined) model = stored.model;
    }
  }

  return model;
}

function image(block: PiBlock): ContentBlock | undefined {
  const data = block.data;

  if (!data) return undefined;

  return { type: 'image', data, mimeType: block.mimeType ?? 'image/png', label: 'image' };
}

function contentBlocks(content: PiMessage['content'], assistant: boolean): ContentBlock[] {
  if (content === undefined) return [];

  if (!Array.isArray(content)) return [{ type: 'text', text: content }];
  const blocks: ContentBlock[] = [];

  for (const value of content) {
    const stored = PiBlockSchema.safeParse(value);

    if (!stored.success) continue;
    const block = stored.data;

    if (block.type === 'text' && block.text !== undefined) blocks.push({ type: 'text', text: block.text });
    else if (block.type === 'thinking' && block.thinking !== undefined) {
      const thinking: ThinkingBlock = { type: 'thinking', text: block.thinking };

      if (block.thinkingSignature !== undefined) thinking.signature = block.thinkingSignature;
      blocks.push(thinking);
    } else if (assistant && block.type === 'toolCall' && block.id !== undefined && block.name !== undefined) {
      blocks.push({ type: 'tool_call', callId: block.id, toolName: block.name, arguments: block.arguments ?? {} });
    } else if (block.type === 'image') {
      const parsed = image(block);

      if (parsed) blocks.push(parsed);
    }
  }

  return blocks;
}

function toolResult(message: PiMessage): ContentBlock[] {
  const parts = contentBlocks(message.content, false);
  const plain = parts.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');

  const result: ContentBlock[] = [{
    type: 'tool_result',
    callId: message.toolCallId ?? '',
    content: plain,
    isError: message.isError === true,
  }];

  result.push(...parts.filter((block) => block.type === 'image'));

  return result;
}

function messageOf(entry: PiRecord): Message | undefined {
  if (entry.type !== 'message') return undefined;
  const stored = entry.message;

  if (!stored) return undefined;
  const role = stored.role;
  const timestamp = stored.timestamp ?? entry.timestamp;
  const common: Pick<Message, 'timestamp' | 'messageId' | 'parentId'> = { timestamp };

  if (entry.id !== undefined) common.messageId = entry.id;

  if (entry.parentId !== undefined) common.parentId = entry.parentId;

  if (role === 'user') return { role: 'user', content: contentBlocks(stored.content, false), ...common };

  if (role === 'assistant') return {
    role: 'assistant',
    content: contentBlocks(stored.content, true),
    ...common,
    metadata: stored.model !== undefined ? { model: stored.model } : {},
  };

  if (role === 'toolResult') return { role: 'user', content: toolResult(stored), ...common };

  if (role === 'bashExecution') {
    const command = stored.command ?? '';
    const output = stored.output ?? '';

    return { role: 'user', content: [{ type: 'text', text: `$ ${command}\n${output}`.trim() }], ...common };
  }

  if (role === 'custom') return { role: 'user', content: contentBlocks(stored.content, false), ...common };

  return undefined;
}

function titleOf(parsed: ParsedFile, entries: PiRecord[], messages: Message[]): string {
  let title = parsed.title;

  for (const entry of entries) {
    if (entry.type === 'title_change' && entry.title !== undefined) title = entry.title;
    else if (entry.type === 'session_info' && entry.name !== undefined) title = entry.title ?? entry.name;
  }

  if (title) return title;

  for (const message of messages) {
    if (message.role !== 'user') continue;
    const first = message.content.find((block) => block.type === 'text');

    if (first?.type === 'text' && first.text.trim()) return first.text.trim().split(/\r?\n/, 1)[0]!.slice(0, 100);
  }

  return fallbackTitle(parsed.header.id ?? path.basename(parsed.filePath, '.jsonl'));
}

export class PiAdapter extends AgentAdapter {
  constructor(
    private readonly id: 'pi' | 'omp',
    private readonly storageRoot: string,
    private readonly projectSettings = true,
  ) {
    super();
  }

  get platform(): string { return this.id; }

  isReady(projectPath = process.cwd()): boolean {
    return fs.existsSync(this.storageRoot) || fs.existsSync(this.projectStorageRoot(projectPath));
  }

  private projectStorageRoot(projectPath?: string): string {
    if (this.id !== 'pi' || !this.projectSettings || !projectPath) return this.storageRoot;

    try {
      const settings = PiSettingsSchema.safeParse(JSON.parse(readRegularFileSync(path.join(projectPath, '.pi', 'settings.json'), 'utf8')));
      const configured = settings.data?.sessionDir?.trim();

      if (!configured) return this.storageRoot;

      const expanded = configured === '~' || configured.startsWith('~/') || (process.platform === 'win32' && configured.startsWith('~\\'))
        ? path.join(os.homedir(), configured.slice(1)) : configured;

      return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(projectPath, expanded);
    } catch {
      return this.storageRoot;
    }
  }

  private files(storageRoot: string): string[] {
    if (!fs.existsSync(storageRoot)) return [];
    const files: string[] = [];

    const visit = (dir: string, depth: number): void => {
      if (depth > 4) return;

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) visit(full, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
      }
    };

    visit(storageRoot, 0);

    return files;
  }

  private parsed(sessionId?: string, projectPath?: string): ParsedFile[] {
    const wanted = projectPath ? resolveRealCwd(projectPath) : undefined;

    return this.files(this.projectStorageRoot(projectPath)).flatMap((file) => {
      const parsed = parseFile(file);

      if (!parsed) return [];
      const id = parsed.header.id;
      const cwd = parsed.header.cwd;

      if (!id || (sessionId !== undefined && id !== sessionId)) return [];

      if (wanted !== undefined && (!cwd || resolveRealCwd(cwd) !== wanted)) return [];

      return [parsed];
    });
  }

  async listConversations(projectPath?: string): Promise<SessionMeta[]> {
    return this.parsed(undefined, projectPath).map((parsed) => {
      const branch = activeEntries(parsed.entries);

      const messages = branch.flatMap((entry) => {
        const message = messageOf(entry);

        return message ? [message] : [];
      });

      const stat = fs.statSync(parsed.filePath);
      const createdAt = parsed.header.timestamp ?? messages[0]?.timestamp ?? stat.birthtime.toISOString();
      const updatedAt = branch.toReversed().map((entry) => entry.timestamp).find(Boolean) ?? stat.mtime.toISOString();

      return {
        sessionId: parsed.header.id!, title: titleOf(parsed, branch, messages), cwd: parsed.header.cwd ?? '',
        platform: this.id, createdAt, updatedAt, messageCount: messages.length,
        filePath: parsed.filePath, sizeBytes: stat.size,
      };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async readSession(ref: SessionReadRef): Promise<Session> {
    let parsed: ParsedFile | undefined;

    if (ref.filePath) {
      const exact = parseFile(ref.filePath);

      if (exact && exact.header.id === ref.sessionId) parsed = exact;
    } else if (isSafeSessionFileId(ref.sessionId)) {
      [parsed] = this.parsed(ref.sessionId, ref.projectPath);
    }

    if (!parsed) throw new Error(`No ${this.id} session ${ref.sessionId}${ref.projectPath ? ` in ${ref.projectPath}` : ''}.`);
    const branch = activeEntries(parsed.entries);

    const messages = branch.flatMap((entry) => {
      const message = messageOf(entry);

      return message ? [message] : [];
    });

    const stat = fs.statSync(parsed.filePath);
    const createdAt = parsed.header.timestamp ?? messages[0]?.timestamp ?? stat.birthtime.toISOString();
    const updatedAt = branch.toReversed().map((entry) => entry.timestamp).find(Boolean) ?? stat.mtime.toISOString();
    const model = modelOf(branch);

    const session: Session = {
      sessionId: parsed.header.id!, title: titleOf(parsed, branch, messages), cwd: parsed.header.cwd ?? '',
      platform: this.id, createdAt, updatedAt, messages,
    };

    if (model) session.metadata = { model };

    return session;
  }

  async existingSessionId(sessionId: string, projectPath?: string): Promise<string | undefined> {
    if (!isSafeSessionFileId(sessionId)) return undefined;

    return this.parsed(sessionId, projectPath)[0] ? sessionId : undefined;
  }

  async writeSession(_session: Session, _projectPath?: string): Promise<string> {
    throw new ToolUnavailableError(`TeamAI cannot write ${this.id} sessions: ${this.id} resumes only its own JSONL session graph.`);
  }

  async deleteSession(_sessionId: string, _projectPath?: string): Promise<boolean> { return false; }
}
