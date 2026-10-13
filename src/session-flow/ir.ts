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
  arguments: Record<string, unknown>;
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

export function blockToDict(block: ContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return { type: 'thinking', text: block.text, ...(block.signature ? { signature: block.signature } : {}) };
    case 'tool_call':
      return { type: 'tool_call', toolName: block.toolName, callId: block.callId, arguments: block.arguments };
    case 'tool_result':
      return { type: 'tool_result', callId: block.callId, content: block.content, isError: block.isError };
    case 'image':
      return {
        type: 'image',
        mimeType: block.mimeType,
        ...(block.data ? { data: block.data } : {}),
        ...(block.filePath ? { filePath: block.filePath } : {}),
        ...(block.label ? { label: block.label } : {}),
      };
  }
}

export function blockFromDict(data: Record<string, unknown>): ContentBlock {
  const t = data.type as string;
  switch (t) {
    case 'text':
      return { type: 'text', text: String(data.text ?? '') };
    case 'thinking':
      return { type: 'thinking', text: String(data.text ?? ''), ...(data.signature ? { signature: String(data.signature) } : {}) };
    case 'tool_call':
      return {
        type: 'tool_call',
        toolName: String(data.toolName ?? ''),
        callId: String(data.callId ?? ''),
        arguments: (data.arguments as Record<string, unknown>) ?? {},
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        callId: String(data.callId ?? ''),
        content: String(data.content ?? ''),
        isError: Boolean(data.isError ?? false),
      };
    case 'image':
      return {
        type: 'image',
        mimeType: String(data.mimeType ?? 'image/png'),
        ...(typeof data.data === 'string' ? { data: data.data } : {}),
        ...(typeof data.filePath === 'string' ? { filePath: data.filePath } : {}),
        ...(typeof data.label === 'string' ? { label: data.label } : {}),
      };
    default:
      throw new Error(`Unknown content block type: ${t}`);
  }
}

// ---------------------------------------------------------------------------
// Messages (Message)
// ---------------------------------------------------------------------------

export interface MessageMetadata {
  model?: string;
  isMeta?: boolean;
  promptId?: string;
  [key: string]: unknown;
}

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  timestamp?: string; // ISO8601
  messageId?: string;
  parentId?: string;
  metadata?: MessageMetadata;
}

export function messageToDict(msg: Message): Record<string, unknown> {
  return {
    role: msg.role,
    content: msg.content.map(blockToDict),
    timestamp: msg.timestamp ?? null,
    messageId: msg.messageId ?? null,
    parentId: msg.parentId ?? null,
    metadata: msg.metadata ?? {},
  };
}

export function messageFromDict(data: Record<string, unknown>): Message {
  const rawContent = (data.content as Array<Record<string, unknown>>) ?? [];
  return {
    role: data.role as 'user' | 'assistant',
    content: rawContent.map(blockFromDict),
    timestamp: (data.timestamp as string) ?? undefined,
    messageId: (data.messageId as string) ?? undefined,
    parentId: (data.parentId as string) ?? undefined,
    metadata: (data.metadata as MessageMetadata) ?? {},
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
  [key: string]: unknown;
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

export function sessionToDict(session: Session): Record<string, unknown> {
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

export function sessionFromDict(data: Record<string, unknown>): Session {
  const rawMessages = (data.messages as Array<Record<string, unknown>>) ?? [];
  return {
    sessionId: String(data.sessionId ?? ''),
    title: String(data.title ?? ''),
    cwd: String(data.cwd ?? ''),
    platform: String(data.platform ?? ''),
    createdAt: String(data.createdAt ?? new Date().toISOString()),
    updatedAt: String(data.updatedAt ?? new Date().toISOString()),
    messages: rawMessages.map(messageFromDict),
    metadata: (data.metadata as SessionMetadata) ?? {},
  };
}
