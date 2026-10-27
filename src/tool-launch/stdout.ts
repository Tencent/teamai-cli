import type { LaunchAdapterId } from './adapters.js';

export interface TokenUsage {
  input?: number;
  output?: number;
  cachedInput?: number;
}

/** What a tool's stdout says about its run: the result it printed, the model, the session, and the tokens it billed. */
export interface ToolReport {
  output?: unknown;
  model?: string;
  session?: string;
  tokens?: TokenUsage;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function claudeStdout(stdout: string): ToolReport | null {
  const events = jsonRecords(stdout);
  const record = events.filter((event) => event.type === 'result').at(-1);
  if (!record) return null;
  const usage = record.usage as Record<string, unknown> | undefined;
  // The `init` event names the session's model. `modelUsage` keys every model the session billed, a side call's and a
  // subagent's included, so it cannot tell which one ran the step (#1176).
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  const model = typeof init?.model === 'string' ? init.model : undefined;
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
  return {
    ...(output !== undefined ? { output } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(typeof record.session_id === 'string' ? { session: record.session_id } : {}),
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
  if (!found.model && !found.session && !found.tokens) return null;
  return found;
}

/** What stdout of a tool on this adapter reports. CodeBuddy prints Claude's result record. */
export function toolStdout(adapter: LaunchAdapterId, stdout: string): ToolReport | null {
  if (adapter === 'claude' || adapter === 'codebuddy') return claudeStdout(stdout);
  return readToolMetadata(stdout);
}
