import { z } from 'zod';
import type { LaunchAdapterId } from './adapters.js';

export interface TokenUsage {
  input?: number;
  output?: number;
  cachedInput?: number;
}

/** What a tool's stdout says about its run: the result it printed, the model, the session, the tokens it billed and what it said they cost. */
export interface ToolReport {
  output?: unknown;
  model?: string;
  session?: string;
  tokens?: TokenUsage;
  cost?: { amount: number; unit: string };
  /** Whether the run ended at the turn cap it was launched with: Claude's `error_max_turns` result. */
  reachedMaxTurns?: boolean;
  /** Whether stdout ended before the tool's final result, so it holds only what the tool said as it started. */
  unfinished?: boolean;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function claudeStdout(stdout: string): ToolReport | null {
  const events = jsonRecords(stdout);
  // The `init` event names the session's model. `modelUsage` keys every model the session billed, a side call's and a
  // subagent's included, so it cannot tell which one ran the step (#1176).
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  const model = typeof init?.model === 'string' ? init.model : undefined;
  const record = events.findLast((event) => event.type === 'result');
  if (!record) {
    // A Claude stopped before its final result still named its model and session as it started.
    const session = typeof init?.session_id === 'string' ? init.session_id : undefined;
    if (model === undefined && session === undefined) return null;
    return { unfinished: true, ...(model !== undefined ? { model } : {}), ...(session !== undefined ? { session } : {}) };
  }
  const usage = record.usage as Record<string, unknown> | undefined;
  let output: unknown;
  if (typeof record.result === 'string') {
    try {
      output = JSON.parse(record.result) as unknown;
    } catch {
      output = undefined;
    }
  } else if (record.result !== undefined) {
    output = record.result;
  }
  const cost = finiteNumber(record.total_cost_usd);
  return {
    ...(output !== undefined ? { output } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(typeof record.session_id === 'string' ? { session: record.session_id } : {}),
    ...(cost !== undefined && cost >= 0 ? { cost: { amount: cost, unit: 'USD' } } : {}),
    ...(record.subtype === 'error_max_turns' ? { reachedMaxTurns: true } : {}),
    ...(usage ? {
      tokens: {
        ...(finiteNumber(usage.input_tokens) !== undefined ? { input: finiteNumber(usage.input_tokens) } : {}),
        ...(finiteNumber(usage.output_tokens) !== undefined ? { output: finiteNumber(usage.output_tokens) } : {}),
        ...(finiteNumber(usage.cache_read_input_tokens) !== undefined ? { cachedInput: finiteNumber(usage.cache_read_input_tokens) } : {}),
      },
    } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function jsonRecords(stdout: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const value = asRecord(JSON.parse(trimmed) as unknown);
      if (value) records.push(value);
    } catch {
      // A tool may print a non-JSON line beside its JSON events.
    }
  }
  return records;
}

function tokenUsage(record: Record<string, unknown>): TokenUsage | undefined {
  const usage = asRecord(record.usage) ?? asRecord(record.tokens);
  if (!usage) return undefined;
  const cache = asRecord(usage.cache);
  const tokens: TokenUsage = {};
  const input = finiteNumber(usage.input_tokens) ?? finiteNumber(usage.input);
  const output = finiteNumber(usage.output_tokens) ?? finiteNumber(usage.output);
  const cached = finiteNumber(usage.cached_input_tokens)
    ?? finiteNumber(usage.cache_read_input_tokens)
    ?? finiteNumber(cache?.read);
  if (input !== undefined) tokens.input = input;
  if (output !== undefined) tokens.output = output;
  if (cached !== undefined) tokens.cachedInput = cached;
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function addTokens(current: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  const sum = (left?: number, right?: number) => (
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0)
  );
  const tokens: TokenUsage = {};
  const input = sum(current?.input, next.input);
  const output = sum(current?.output, next.output);
  const cached = sum(current?.cachedInput, next.cachedInput);
  if (input !== undefined) tokens.input = input;
  if (output !== undefined) tokens.output = output;
  if (cached !== undefined) tokens.cachedInput = cached;
  return tokens;
}

function absorbMetadata(record: Record<string, unknown>, found: ToolReport, depth: number): void {
  if (typeof record.model === 'string' && record.model !== '') found.model = record.model;
  if (typeof record.modelID === 'string' && record.modelID !== '') found.model = record.modelID;
  for (const key of ['thread_id', 'session_id', 'sessionID'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') found.session = value;
  }
  if (typeof record.type === 'string' && record.type.startsWith('session')) {
    const info = asRecord(asRecord(record.properties)?.info) ?? asRecord(record.info);
    if (typeof info?.id === 'string' && info.id !== '') found.session = info.id;
  }
  if (record.type === 'turn.completed' || record.type === 'step_finish' || record.type === 'step-finish') {
    const tokens = tokenUsage(record);
    if (tokens) found.tokens = addTokens(found.tokens, tokens);
    // OpenCode states each step's cost in USD.
    const cost = finiteNumber(record.cost);
    if (cost !== undefined && cost >= 0) found.cost = { amount: (found.cost?.amount ?? 0) + cost, unit: 'USD' };
  }
  if (depth >= 4) return;
  for (const key of ['item', 'part', 'properties', 'info'] as const) {
    const child = asRecord(record[key]);
    if (child) absorbMetadata(child, found, depth + 1);
  }
}

export function readToolMetadata(stdout: string): ToolReport | null {
  const found: ToolReport = {};
  for (const record of jsonRecords(stdout)) absorbMetadata(record, found, 0);
  if (!found.model && !found.session && !found.tokens && !found.cost) return null;
  return found;
}

const AgyInit = z.object({ event: z.literal('init'), init: z.object({ model: z.string() }) });
const AgyResult = z.object({
  event: z.literal('result'),
  result: z.object({
    conversation_id: z.string().optional(),
    status: z.string(),
    response: z.string().optional(),
    error: z.string().optional(),
    usage: z.object({ input_tokens: z.number(), output_tokens: z.number(), cache_read_tokens: z.number() }).partial().optional(),
  }),
});

/** The run agy's stream-json output reports: the model its `init` event names, and the last `result` event. */
export function agyRun(stdout: string): { model?: string; result?: z.infer<typeof AgyResult>['result']; tokens?: TokenUsage } {
  const events = jsonRecords(stdout);
  const model = events.flatMap((event) => { const init = AgyInit.safeParse(event); return init.success ? [init.data.init.model] : []; }).at(0);
  const result = events.flatMap((event) => { const parsed = AgyResult.safeParse(event); return parsed.success ? [parsed.data.result] : []; }).at(-1);
  const usage = result?.usage;
  const tokens: TokenUsage = {
    ...(usage?.input_tokens !== undefined ? { input: usage.input_tokens } : {}),
    ...(usage?.output_tokens !== undefined ? { output: usage.output_tokens } : {}),
    ...(usage?.cache_read_tokens !== undefined ? { cachedInput: usage.cache_read_tokens } : {}),
  };
  return { ...(model ? { model } : {}), ...(result ? { result } : {}), ...(Object.keys(tokens).length > 0 ? { tokens } : {}) };
}

function agyStdout(stdout: string): ToolReport | null {
  const { model, result, tokens } = agyRun(stdout);
  if (!result) return null;
  let output: unknown;
  try {
    output = result.response === undefined ? undefined : JSON.parse(result.response) as unknown;
  } catch {
    output = undefined;
  }
  return {
    ...(output !== undefined ? { output } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(result.conversation_id ? { session: result.conversation_id } : {}),
    ...(tokens ? { tokens } : {}),
  };
}

/**
 * Counts what a tool billed while its stdout streams, fed one line at a time, and returns the total so far: Claude's
 * messages once each, at the usage the `message_delta` of `--include-partial-messages` states as a message ends, since
 * its assistant events repeat the usage of the message's start and it states a run's total only in its final result;
 * Codex's finished turns and OpenCode's finished steps, as `toolStdout` adds them up.
 */
export function tokenMeter(adapter: LaunchAdapterId): (line: string) => TokenUsage | undefined {
  if (adapter === 'claude') {
    const messages = new Map<string, TokenUsage>();
    // The sum over `messages` of each count, and how many of them state it, kept as each message's usage changes.
    const totals = { input: { sum: 0, stated: 0 }, output: { sum: 0, stated: 0 }, cachedInput: { sum: 0, stated: 0 } };
    const keys = ['input', 'output', 'cachedInput'] as const;
    const count = (usage: TokenUsage | undefined, sign: 1 | -1): void => {
      for (const key of keys) {
        const value = usage?.[key];
        if (value === undefined) continue;
        totals[key].sum += sign * value;
        totals[key].stated += sign;
      }
    };
    let current: string | undefined;
    return (line) => {
      for (const record of jsonRecords(line)) {
        const event = record.type === 'stream_event' ? asRecord(record.event) : undefined;
        const started = event?.type === 'message_start' ? asRecord(event.message) : undefined;
        if (typeof started?.id === 'string') current = started.id;
        const usage = started ? tokenUsage(started) : event?.type === 'message_delta' ? tokenUsage(event) : undefined;
        if (current === undefined || !usage) continue;
        count(messages.get(current), -1);
        count(usage, 1);
        messages.set(current, usage);
      }
      const tokens: TokenUsage = {};
      for (const key of keys) if (totals[key].stated > 0) tokens[key] = totals[key].sum;
      return Object.keys(tokens).length > 0 ? tokens : undefined;
    };
  }
  const found: ToolReport = {};
  return (line) => {
    for (const record of jsonRecords(line)) absorbMetadata(record, found, 0);
    return found.tokens;
  };
}

/** What stdout of a tool on this adapter reports. CodeBuddy prints Claude's result record. */
export function toolStdout(adapter: LaunchAdapterId, stdout: string): ToolReport | null {
  if (adapter === 'claude' || adapter === 'codebuddy') return claudeStdout(stdout);
  if (adapter === 'agy') return agyStdout(stdout);
  return readToolMetadata(stdout);
}
