import * as path from 'node:path';
import { z } from 'zod';
import { readRegularFileSync } from '@teamai/shared/regular-file';
import { JsonObjectSchema } from '@teamai/shared/json';
import { toolArgumentsFrom, type ContentBlock, type Message } from '@teamai/tool-core/sessions/ir';

const SESSION_FILE = /^model-io-sess_([0-9a-f-]{36})\.jsonl$/i;

const StoredBlock = z.object({
  type: z.string(),
  text: z.string().optional(),
  dataUrl: z.string().optional(),
  mediaType: z.string().optional(),
  source: z.string().optional(),
}).passthrough();

const StoredToolCall = z.object({
  id: z.string(), name: z.string(), input: JsonObjectSchema.optional(),
}).passthrough();

const StoredMessage = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(StoredBlock)]),
  toolCalls: z.array(StoredToolCall).optional(),
  toolCallId: z.string().optional(),
  isError: z.boolean().optional(),
  modelId: z.string().optional(),
}).passthrough();

const ModelIo = z.object({
  type: z.literal('model_io'),
  sessionId: z.string().nullable(),
  turnId: z.string(),
  requestId: z.string(),
  attempt: z.number().int().positive(),
  model: z.object({ modelId: z.string().optional(), providerId: z.string().optional() }).passthrough(),
  startedAt: z.string(),
  completedAt: z.string(),
  request: z.object({
    messages: z.array(StoredMessage),
    messagesKind: z.enum(['full', 'delta']),
    messageOffset: z.number().int().nonnegative(),
  }).passthrough(),
  response: z.object({
    text: z.string().optional(), reasoningText: z.string().optional(),
    toolCalls: z.array(StoredToolCall).optional(), modelId: z.string().optional(),
  }).passthrough(),
}).passthrough();

type StoredMessage = z.infer<typeof StoredMessage>;

type ModelIo = z.infer<typeof ModelIo>;

export interface ParsedZCode {
  filePath: string;
  sessionId: string;
  model?: string;
  provider?: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

function imageBlock(block: z.infer<typeof StoredBlock>): ContentBlock | undefined {
  if (block.type !== 'image' || !block.dataUrl) return undefined;
  const data = /^data:[^;,]+;base64,(.*)$/s.exec(block.dataUrl)?.[1];

  return { type: 'image', mimeType: block.mediaType ?? 'image/png', data,
    filePath: block.source, label: block.source?.split(/[\\/]/).at(-1) };
}

function contentBlocks(content: StoredMessage['content']): ContentBlock[] {
  const text = z.string().safeParse(content);

  if (text.success) return text.data ? [{ type: 'text', text: text.data }] : [];
  const blocks = z.array(StoredBlock).parse(content);

  return blocks.flatMap((block): ContentBlock[] => {
    if (block.type === 'text' && block.text !== undefined) return [{ type: 'text', text: block.text }];

    if (block.type === 'reasoning' && block.text !== undefined) return [{ type: 'thinking', text: block.text }];

    const image = imageBlock(block);

    return image ? [image] : [];
  });
}

function messageFrom(stored: StoredMessage): Message | undefined {
  if (stored.role === 'system') return undefined;

  if (stored.role === 'tool') {
    if (!stored.toolCallId) return undefined;
    const text = z.string().safeParse(stored.content);

    return { role: 'user', content: [{ type: 'tool_result', callId: stored.toolCallId,
      content: text.success ? text.data : JSON.stringify(stored.content),
      isError: stored.isError ?? false }] };
  }

  const content = contentBlocks(stored.content);

  for (const call of stored.toolCalls ?? []) {
    content.push({ type: 'tool_call', callId: call.id, toolName: call.name,
      arguments: toolArgumentsFrom(call.input) });
  }

  if (!content.length) return undefined;

  return { role: stored.role, content, metadata: stored.modelId ? { model: stored.modelId } : undefined };
}

function responseMessage(record: ModelIo): Message | undefined {
  const content: ContentBlock[] = [];

  if (record.response.reasoningText) content.push({ type: 'thinking', text: record.response.reasoningText });

  if (record.response.text) content.push({ type: 'text', text: record.response.text });

  for (const call of record.response.toolCalls ?? []) {
    content.push({ type: 'tool_call', callId: call.id, toolName: call.name,
      arguments: toolArgumentsFrom(call.input) });
  }

  if (!content.length) return undefined;

  return { role: 'assistant', content, timestamp: record.completedAt,
    metadata: record.response.modelId ? { model: record.response.modelId } : undefined };
}

/** Parse one ZCode model-I/O rollout. Project discovery waits on the store's cwd source. */
export function parseZCodeFile(filePath: string): ParsedZCode | undefined {
  const match = SESSION_FILE.exec(path.basename(filePath));

  if (!match) return undefined;
  const sessionId = match[1]!;
  const selected = new Map<string, { index: number; record: ModelIo }>();
  let index = 0;

  for (const line of readRegularFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let stored: unknown;

    try { stored = JSON.parse(line); } catch { continue; }

    const parsed = ModelIo.safeParse(stored);

    if (!parsed.success || parsed.data.sessionId !== `sess_${sessionId}`) continue;
    const previous = selected.get(parsed.data.turnId);

    if (!previous || parsed.data.attempt >= previous.record.attempt) selected.set(parsed.data.turnId, { index, record: parsed.data });
    index++;
  }

  const records = [...selected.values()].sort((a, b) => a.index - b.index).map(({ record }) => record);

  if (!records.length) return undefined;
  let storedMessages: StoredMessage[] = [];

  for (const record of records) {
    if (record.request.messagesKind === 'full') storedMessages = record.request.messages;
    else storedMessages.splice(record.request.messageOffset, storedMessages.length, ...record.request.messages);
  }

  const messages = storedMessages.flatMap((stored) => {
    const message = messageFrom(stored);

    return message ? [message] : [];
  });

  const last = records.at(-1)!;
  const response = responseMessage(last);

  if (response) messages.push(response);

  return {
    filePath, sessionId, model: last.model.modelId ?? last.response.modelId,
    provider: last.model.providerId, createdAt: records[0]!.startedAt,
    updatedAt: last.completedAt, messages,
  };
}
