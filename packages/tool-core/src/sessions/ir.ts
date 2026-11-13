/**
 * Canonical IR — cross-platform normalized session representation.
 *
 * Every source-platform session read by an adapter is normalized into the IR
 * defined by this module, and every write is also based on IR, so session
 * migration stays platform-agnostic.
 *
 * Enhancements (vs the Python version):
 * - ThinkingBlock keeps the signature field (usable for same-platform migration)
 * - MessageMetadata adds isMeta/promptId (Claude Code specific)
 * - SessionMetadata adds originator/sourcePlatform
 */

import { z } from 'zod';
import { JsonValueSchema, type JsonValue, JsonObjectSchema, parseJson } from '@teamai/shared/json';
import { coercedText, OptionalString } from './fs.js';

// ---------------------------------------------------------------------------
// Content blocks (ContentBlock)
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  text: string;
  signature?: string; // Keep the original signature (usable for same-platform migration)
}

export interface ToolCallBlock {
  type: 'tool_call';
  toolName: string;
  callId: string;
  arguments: ToolArguments;
}

/** A tool call's input as the source platform recorded it: arbitrary JSON keyed by argument name. */
export const ToolArgumentsSchema = JsonObjectSchema;

export type ToolArguments = z.infer<typeof ToolArgumentsSchema>;

/**
 * Tool-call arguments as a transcript stores them: an object, or that object JSON-encoded. Anything else, or a string
 * that does not decode to an object, is kept as text under `_raw`; absent arguments read as none.
 */
export function toolArgumentsFrom(stored: JsonValue | undefined): ToolArguments {
  const text = z.string().safeParse(stored);
  let decoded: JsonValue = stored ?? {};

  if (text.success) {
    try {
      decoded = parseJson(text.data);
    } catch {
      return { _raw: text.data };
    }
  }

  const args = ToolArgumentsSchema.safeParse(decoded);

  return args.success ? args.data : { _raw: String(stored) };
}

export interface ToolResultBlock {
  type: 'tool_result';
  callId: string;
  content: string;
  isError: boolean;
}

/**
 * Inline image block in a message.
 *
 * - `data`: base64 image content (preferred; platforms that natively support base64 images, such as claude-code, write it back directly)
 * - `filePath`: absolute path of the source file (codebuddy-ide assets; used when writing back to the IDE or to platforms that support file references)
 * - At least one of the two is guaranteed by the read side; if both are missing, the write side degrades to placeholder text
 */
export interface ImageBlock {
  type: 'image';
  mimeType: string; // image/png | image/jpeg | image/gif | image/webp
  data?: string; // base64, without a data: prefix
  filePath?: string; // Absolute path on the source side
  /** Display name (used in placeholders), e.g. image.b9f683a0a9.png */
  label?: string;
}

/** Placeholder text when the target platform does not support images (counted as degraded in fidelity, rather than silently dropped). */
export function imagePlaceholderText(block: ImageBlock): string {
  const sizeKb = block.data ? Math.round((block.data.length * 3) / 4 / 1024) : null;
  const sizePart = sizeKb !== null ? `, ${sizeKb}KB` : '';

  return `[image: ${block.label ?? 'image'}${sizePart}]`;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock | ImageBlock;

export function blockToDict(block: ContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking': {
      const thinking: ThinkingBlock = { type: 'thinking', text: block.text };

      if (block.signature) thinking.signature = block.signature;

      return thinking;
    }

    case 'tool_call':
      return { type: 'tool_call', toolName: block.toolName, callId: block.callId, arguments: block.arguments };
    case 'tool_result':
      return { type: 'tool_result', callId: block.callId, content: block.content, isError: block.isError };
    case 'image': {
      const image: ImageBlock = { type: 'image', mimeType: block.mimeType };

      if (block.data) image.data = block.data;

      if (block.filePath) image.filePath = block.filePath;

      if (block.label) image.label = block.label;

      return image;
    }
  }
}

/** One content block as an archive line stores it; fields of other block types are ignored by the switch below. */
const StoredBlockSchema = z.object({
  type: JsonValueSchema.optional(),
  text: coercedText(),
  signature: JsonValueSchema.optional(),
  toolName: coercedText(),
  callId: coercedText(),
  arguments: ToolArgumentsSchema.optional().catch(undefined),
  content: coercedText(),
  isError: JsonValueSchema.optional(),
  mimeType: coercedText('image/png'),
  data: OptionalString,
  filePath: OptionalString,
  label: OptionalString,
});

export function blockFromDict(record: JsonValue): ContentBlock {
  const data = StoredBlockSchema.parse(record);
  const t = data.type;

  switch (t) {
    case 'text':
      return { type: 'text', text: data.text };
    case 'thinking': {
      const thinking: ThinkingBlock = { type: 'thinking', text: data.text };

      if (data.signature) thinking.signature = String(data.signature);

      return thinking;
    }

    case 'tool_call':
      return {
        type: 'tool_call',
        toolName: data.toolName,
        callId: data.callId,
        arguments: data.arguments ?? {},
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        callId: data.callId,
        content: data.content,
        isError: Boolean(data.isError ?? false),
      };
    case 'image': {
      const image: ImageBlock = { type: 'image', mimeType: data.mimeType };

      if (data.data !== undefined) image.data = data.data;

      if (data.filePath !== undefined) image.filePath = data.filePath;

      if (data.label !== undefined) image.label = data.label;

      return image;
    }

    default:
      throw new Error(`Unknown content block type: ${String(t)}`);
  }
}

// ---------------------------------------------------------------------------
// Messages (Message)
// ---------------------------------------------------------------------------

export interface MessageMetadata {
  model?: string;
  isMeta?: boolean;
  promptId?: string;
  [key: string]: JsonValue | undefined;
}

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  timestamp?: string; // ISO8601
  messageId?: string;
  parentId?: string;
  metadata?: MessageMetadata;
}

/** A message as an archive line stores it: absent optional fields are written as null. */
export interface MessageRecord {
  role: Message['role'];
  content: ContentBlock[];
  timestamp: string | null;
  messageId: string | null;
  parentId: string | null;
  metadata: MessageMetadata;
}

export function messageToDict(msg: Message): MessageRecord {
  return {
    role: msg.role,
    content: msg.content.map(blockToDict),
    timestamp: msg.timestamp ?? null,
    messageId: msg.messageId ?? null,
    parentId: msg.parentId ?? null,
    metadata: msg.metadata ?? {},
  };
}

/** Message metadata read from JSON: the typed keys are dropped when they hold another type, every other key passes through. */
export const MessageMetadataSchema = z
  .object({
    model: OptionalString,
    isMeta: z.boolean().optional().catch(undefined),
    promptId: OptionalString,
  })
  .catchall(JsonValueSchema);

const StoredMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.array(JsonValueSchema).nullish(),
  timestamp: z.string().nullish(),
  messageId: z.string().nullish(),
  parentId: z.string().nullish(),
  metadata: MessageMetadataSchema.nullish(),
});

export function messageFromDict(record: JsonValue): Message {
  const data = StoredMessageSchema.parse(record);

  return {
    role: data.role,
    content: (data.content ?? []).map(blockFromDict),
    timestamp: data.timestamp ?? undefined,
    messageId: data.messageId ?? undefined,
    parentId: data.parentId ?? undefined,
    metadata: data.metadata ?? {},
  };
}

// ---------------------------------------------------------------------------
// Sessions (Session)
// ---------------------------------------------------------------------------

export interface SessionMetadata {
  model?: string;
  gitBranch?: string;
  version?: string;
  originator?: string;
  sourcePlatform?: string;
  [key: string]: JsonValue | undefined;
}

export interface Session {
  sessionId: string;
  title: string;
  cwd: string;
  platform: string;
  createdAt: string; // ISO8601
  updatedAt: string; // ISO8601
  messages: Message[];
  metadata?: SessionMetadata;
}

/** A session as a single JSON document stores it. */
export interface SessionRecord {
  sessionId: string;
  title: string;
  cwd: string;
  platform: string;
  createdAt: string;
  updatedAt: string;
  messages: MessageRecord[];
  metadata: SessionMetadata;
}

export function sessionToDict(session: Session): SessionRecord {
  return {
    sessionId: session.sessionId,
    title: session.title,
    cwd: session.cwd,
    platform: session.platform,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages.map(messageToDict),
    metadata: session.metadata ?? {},
  };
}

const StoredSessionMetadataSchema = z
  .object({
    model: OptionalString,
    gitBranch: OptionalString,
    version: OptionalString,
    originator: OptionalString,
    sourcePlatform: OptionalString,
  })
  .catchall(JsonValueSchema);

const StoredSessionSchema = z.object({
  sessionId: coercedText(),
  title: coercedText(),
  cwd: coercedText(),
  platform: coercedText(),
  createdAt: JsonValueSchema.optional(),
  updatedAt: JsonValueSchema.optional(),
  messages: z.array(JsonValueSchema).nullish(),
  metadata: StoredSessionMetadataSchema.nullish(),
});

export function sessionFromDict(record: JsonValue): Session {
  const data = StoredSessionSchema.parse(record);

  return {
    sessionId: data.sessionId,
    title: data.title,
    cwd: data.cwd,
    platform: data.platform,
    createdAt: String(data.createdAt ?? new Date().toISOString()),
    updatedAt: String(data.updatedAt ?? new Date().toISOString()),
    messages: (data.messages ?? []).map(messageFromDict),
    metadata: data.metadata ?? {},
  };
}
