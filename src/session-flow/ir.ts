/**
 * Canonical IR — 跨平台归一化的会话表示。
 *
 * 所有适配器读取的源平台会话都会被归一化为本模块定义的 IR 结构，
 * 所有写入操作也基于 IR 进行，从而实现平台无关的会话迁移。
 *
 * 增强点（vs Python 版）：
 * - ThinkingBlock 保留 signature 字段（同平台迁移可用）
 * - MessageMetadata 增加 isMeta/promptId（CC 特有）
 * - SessionMetadata 增加 originator/sourcePlatform
 */

// ---------------------------------------------------------------------------
// 内容块（ContentBlock）
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  text: string;
  signature?: string; // 保留原始签名（同平台迁移时可用）
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
 * 消息内嵌图片块。
 *
 * - `data`：图片内容的 base64（优先使用；claude-code 等原生支持 base64 图片的平台直接写回）
 * - `filePath`：源端文件绝对路径（codebuddy-ide 的 assets；写回 IDE / 落地到支持文件引用的平台用）
 * - 两者至少有一个，读取侧保证；都没有时写入侧降级为占位文本
 */
export interface ImageBlock {
  type: 'image';
  mimeType: string; // image/png | image/jpeg | image/gif | image/webp
  data?: string; // base64，不带 data: 前缀
  filePath?: string; // 源端绝对路径
  /** 展示名（占位符用），如 image.b9f683a0a9.png */
  label?: string;
}

/** 目标平台不支持图片时的占位文本（保真度计 degraded，而非静默丢弃）。 */
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
// 消息（Message）
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
// 会话（Session）
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
