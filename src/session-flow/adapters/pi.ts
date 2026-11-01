/** Pi and Oh My Pi v3 JSONL session adapter (read-only). */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentAdapter, ToolUnavailableError, type SessionMeta, type SessionReadRef } from './base.js';
import type { ContentBlock, Message, Session } from '../ir.js';
import { fallbackTitle } from '../title.js';
import { isSafeSessionFileId } from '../ids.js';

type Json = Record<string, unknown>;

interface ParsedFile {
  filePath: string;
  header: Json;
  entries: Json[];
  title?: string;
}

function object(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function iso(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** OMP puts a fixed-width `title` record before the ordinary Pi session header. */
function parseFile(filePath: string): ParsedFile | undefined {
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
  } catch {
    return undefined;
  }
  const records: Json[] = [];
  for (const line of lines) {
    try {
      const record = object(JSON.parse(line));
      if (record) records.push(record);
    } catch {
      // A partially-written last line does not hide the readable prefix.
    }
  }
  const titleSlot = records[0]?.type === 'title' ? records.shift() : undefined;
  const headerIndex = records.findIndex((record) => record.type === 'session');
  if (headerIndex < 0) return undefined;
  const [header] = records.splice(headerIndex, 1);
  return { filePath, header, entries: records, title: text(titleSlot?.title) ?? text(header.title) };
}

/** Pi's active branch: follow parentId from the recorded leaf rather than including abandoned branches. */
function activeEntries(entries: Json[]): Json[] {
  if (entries.length === 0) return [];
  const byId = new Map(entries.flatMap((entry) => typeof entry.id === 'string' ? [[entry.id, entry] as const] : []));
  const last = entries.at(-1)!;
  if (last.activeLeafId === null) return [];
  const leaf = typeof last.activeLeafId === 'string' ? last.activeLeafId
    : typeof last.id === 'string' ? last.id : undefined;
  const follow = (start: string | undefined): Json[] => {
    let id = start;
    const branch: Json[] = [];
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const entry = byId.get(id);
      if (!entry) break;
      branch.push(entry);
      id = typeof entry.parentId === 'string' ? entry.parentId : undefined;
    }
    return branch.toReversed();
  };
  const active = follow(leaf);
  return active.length > 0 ? active : follow(typeof last.id === 'string' ? last.id : undefined);
}

function modelOf(entries: Json[]): string | undefined {
  let model: string | undefined;
  for (const entry of entries) {
    if (entry.type === 'model_change') {
      const changed = text(entry.model) ?? [text(entry.provider), text(entry.modelId)].filter(Boolean).join('/');
      if (changed) model = changed;
    } else if (entry.type === 'message') {
      const stored = object(entry.message);
      if (stored?.role === 'assistant' && typeof stored.model === 'string') model = stored.model;
    }
  }
  return model;
}

function image(block: Json): ContentBlock | undefined {
  const data = text(block.data);
  if (!data) return undefined;
  return { type: 'image', data, mimeType: text(block.mimeType) ?? 'image/png', label: 'image' };
}

function contentBlocks(content: unknown, assistant: boolean): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const value of content) {
    const block = object(value);
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') blocks.push({ type: 'text', text: block.text });
    else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      blocks.push({ type: 'thinking', text: block.thinking, ...(typeof block.thinkingSignature === 'string' ? { signature: block.thinkingSignature } : {}) });
    } else if (assistant && block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
      blocks.push({ type: 'tool_call', callId: block.id, toolName: block.name, arguments: object(block.arguments) ?? {} });
    } else if (block.type === 'image') {
      const parsed = image(block);
      if (parsed) blocks.push(parsed);
    }
  }
  return blocks;
}

function toolResult(message: Json): ContentBlock[] {
  const parts = contentBlocks(message.content, false);
  const plain = parts.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map((block) => block.text).join('\n');
  const result: ContentBlock[] = [{
    type: 'tool_result',
    callId: text(message.toolCallId) ?? '',
    content: plain,
    isError: message.isError === true,
  }];
  result.push(...parts.filter((block) => block.type === 'image'));
  return result;
}

function messageOf(entry: Json): Message | undefined {
  if (entry.type !== 'message') return undefined;
  const stored = object(entry.message);
  if (!stored) return undefined;
  const role = text(stored.role);
  const timestamp = iso(stored.timestamp) ?? iso(entry.timestamp);
  const common = {
    timestamp,
    ...(typeof entry.id === 'string' ? { messageId: entry.id } : {}),
    ...(typeof entry.parentId === 'string' ? { parentId: entry.parentId } : {}),
  };
  if (role === 'user') return { role: 'user', content: contentBlocks(stored.content, false), ...common };
  if (role === 'assistant') return {
    role: 'assistant',
    content: contentBlocks(stored.content, true),
    ...common,
    metadata: typeof stored.model === 'string' ? { model: stored.model } : {},
  };
  if (role === 'toolResult') return { role: 'user', content: toolResult(stored), ...common };
  if (role === 'bashExecution') {
    const command = text(stored.command) ?? '';
    const output = text(stored.output) ?? '';
    return { role: 'user', content: [{ type: 'text', text: `$ ${command}\n${output}`.trim() }], ...common };
  }
  if (role === 'custom') return { role: 'user', content: contentBlocks(stored.content, false), ...common };
  return undefined;
}

function titleOf(parsed: ParsedFile, entries: Json[], messages: Message[]): string {
  let title = parsed.title;
  for (const entry of entries) {
    if ((entry.type === 'title_change' && typeof entry.title === 'string') || (entry.type === 'session_info' && typeof entry.name === 'string')) {
      title = (entry.title ?? entry.name) as string;
    }
  }
  if (title) return title;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const first = message.content.find((block) => block.type === 'text');
    if (first?.type === 'text' && first.text.trim()) return first.text.trim().split(/\r?\n/, 1)[0]!.slice(0, 100);
  }
  return fallbackTitle(text(parsed.header.id) ?? path.basename(parsed.filePath, '.jsonl'));
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

  isReady(): boolean { return fs.existsSync(this.storageRoot); }

  private projectStorageRoot(projectPath?: string): string {
    if (this.id !== 'pi' || !this.projectSettings || !projectPath) return this.storageRoot;
    try {
      const settings = object(JSON.parse(fs.readFileSync(path.join(projectPath, '.pi', 'settings.json'), 'utf8')));
      const configured = text(settings?.sessionDir)?.trim();
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
    const wanted = projectPath ? path.resolve(projectPath) : undefined;
    return this.files(this.projectStorageRoot(projectPath)).flatMap((file) => {
      const parsed = parseFile(file);
      if (!parsed) return [];
      const id = text(parsed.header.id);
      const cwd = text(parsed.header.cwd);
      if (!id || (sessionId !== undefined && id !== sessionId)) return [];
      if (wanted !== undefined && (!cwd || path.resolve(cwd) !== wanted)) return [];
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
      const createdAt = iso(parsed.header.timestamp) ?? messages[0]?.timestamp ?? stat.birthtime.toISOString();
      const updatedAt = branch.toReversed().map((entry) => iso(entry.timestamp)).find(Boolean) ?? stat.mtime.toISOString();
      return {
        sessionId: text(parsed.header.id)!, title: titleOf(parsed, branch, messages), cwd: text(parsed.header.cwd) ?? '',
        platform: this.id, createdAt, updatedAt, messageCount: messages.length,
        filePath: parsed.filePath, sizeBytes: stat.size,
      };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async readSession(ref: SessionReadRef): Promise<Session> {
    let parsed: ParsedFile | undefined;
    if (ref.filePath) {
      const exact = parseFile(ref.filePath);
      if (exact && text(exact.header.id) === ref.sessionId) parsed = exact;
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
    const createdAt = iso(parsed.header.timestamp) ?? messages[0]?.timestamp ?? stat.birthtime.toISOString();
    const updatedAt = branch.toReversed().map((entry) => iso(entry.timestamp)).find(Boolean) ?? stat.mtime.toISOString();
    const model = modelOf(branch);
    return {
      sessionId: text(parsed.header.id)!, title: titleOf(parsed, branch, messages), cwd: text(parsed.header.cwd) ?? '',
      platform: this.id, createdAt, updatedAt, messages, ...(model ? { metadata: { model } } : {}),
    };
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
