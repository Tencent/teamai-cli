import { z } from 'zod';
import { JsonValueSchema, type JsonValue } from '@teamai/shared/json';
import { isUsageLimitText } from './usage-limit.js';

export interface TokenUsage {
  input?: number;
  output?: number;
  cachedInput?: number;
}

/** What a tool stated a run cost, in its own unit, as reports and labels store it. */
export const CostSchema = z.object({ amount: z.number().finite().nonnegative(), unit: z.string().min(1) });

/** What a confined run's tool reports it used, as far as it reports it. */
export const ConfinedUsageSchema = z.object({
  inputTokens: z.number().finite().nonnegative().optional(),
  outputTokens: z.number().finite().nonnegative().optional(),
  cost: CostSchema.optional(),
});

export type ConfinedUsage = z.infer<typeof ConfinedUsageSchema>;

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
  /** What the tool said went wrong, when its final result is an error: Claude's `result` text with `is_error`, Codex's and OpenCode's last `error`. */
  error?: string;
  /**
   * The kind of `error`, when the tool names one, which then decides whether it stopped on a usage limit: OpenCode's
   * `provider.rate-limit`, `provider.quota` and `provider.<plan>-limit` are `usage_limit`. Unset, its text decides
   * (`stoppedOnUsageLimit`).
   */
  errorKind?: ErrorKind;
}

export type ErrorKind = 'usage_limit' | 'other';

/** Whether the tool stopped on a usage limit: the kind of its error decides when `report` names one; without one, `text` does. */
export function stoppedOnUsageLimit(report: ToolReport | null | undefined, text: string): boolean {
  const kind = report?.errorKind;

  switch (kind) {
    case 'usage_limit':
      return true;
    case 'other':
      return false;
    case undefined:
      return isUsageLimitText(text);
    default: {
      const unhandled: never = kind;

      return unhandled;
    }
  }
}

/** A count a tool printed, or nothing when the field holds something else. */
const Count = z.number().optional().catch(undefined);

/** A label a tool printed (a model, a session id, an event type), or nothing when the field holds something else. */
const Label = z.string().optional().catch(undefined);

/** Claude's `result` and `system` events: the fields its report reads. */
const ClaudeEvent = z.object({
  type: Label,
  subtype: Label,
  model: Label,
  session_id: Label,
  is_error: z.boolean().optional().catch(undefined),
  result: JsonValueSchema.optional(),
  usage: JsonValueSchema.optional(),
  total_cost_usd: Count,
});

const ClaudeUsage = z.object({ input_tokens: Count, output_tokens: Count, cache_read_input_tokens: Count });

function claudeStdout(stdout: string): ToolReport | null {
  const events = jsonRecords(stdout).flatMap((record) => {
    const event = ClaudeEvent.safeParse(record);

    return event.success ? [event.data] : [];
  });

  // The `init` event names the session's model. `modelUsage` keys every model the session billed, a side call's and a
  // subagent's included, so it cannot tell which one ran the step (#1176).
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  const model = init?.model;
  const record = events.findLast((event) => event.type === 'result');

  if (!record) {
    // A Claude stopped before its final result still named its model and session as it started.
    const session = init?.session_id;

    if (model === undefined && session === undefined) return null;
    const unfinished: ToolReport = { unfinished: true };

    if (model !== undefined) unfinished.model = model;

    if (session !== undefined) unfinished.session = session;

    return unfinished;
  }

  const report: ToolReport = {};
  const result = z.string().safeParse(record.result);

  if (result.success && record.is_error === true) report.error = result.data;

  if (result.success) {
    try {
      const output: unknown = JSON.parse(result.data);

      if (output !== undefined) report.output = output;
    } catch {
      // A result that is not JSON reports no output.
    }
  } else if (record.result !== undefined) {
    report.output = record.result;
  }

  if (model !== undefined) report.model = model;

  if (record.session_id !== undefined) report.session = record.session_id;

  if (record.total_cost_usd !== undefined && record.total_cost_usd >= 0) report.cost = { amount: record.total_cost_usd, unit: 'USD' };

  if (record.subtype === 'error_max_turns') report.reachedMaxTurns = true;

  if (record.usage) {
    const usage = ClaudeUsage.safeParse(record.usage).data;
    const tokens: TokenUsage = {};

    if (usage?.input_tokens !== undefined) tokens.input = usage.input_tokens;

    if (usage?.output_tokens !== undefined) tokens.output = usage.output_tokens;

    if (usage?.cache_read_input_tokens !== undefined) tokens.cachedInput = usage.cache_read_input_tokens;
    report.tokens = tokens;
  }

  return report;
}

/** The JSON object on each line of `stdout` that holds one; a tool may print non-JSON lines beside its events. */
function jsonRecords(stdout: string): JsonValue[] {
  const records: JsonValue[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed.startsWith('{')) continue;

    try {
      const value = JsonValueSchema.safeParse(JSON.parse(trimmed));

      if (value.success) records.push(value.data);
    } catch {
      // A tool may print a non-JSON line beside its JSON events.
    }
  }

  return records;
}

const MetadataUsage = z.object({
  input_tokens: Count,
  input: Count,
  output_tokens: Count,
  output: Count,
  cached_input_tokens: Count,
  cache_read_input_tokens: Count,
  cache: z.object({ read: Count }).optional().catch(undefined),
});

const SessionInfo = z.object({ id: Label });

/** The fields of an event that report a run's model, session and tokens; `item`, `part`, `properties` and `info` may nest more. */
const MetadataEvent = z.object({
  type: Label,
  model: Label,
  modelID: Label,
  thread_id: Label,
  session_id: Label,
  sessionID: Label,
  cost: Count,
  usage: MetadataUsage.optional().catch(undefined),
  tokens: MetadataUsage.optional().catch(undefined),
  item: JsonValueSchema.optional(),
  part: JsonValueSchema.optional(),
  properties: JsonValueSchema.optional(),
  info: JsonValueSchema.optional(),
});

type MetadataEvent = z.infer<typeof MetadataEvent>;

function tokenUsage(event: MetadataEvent): TokenUsage | undefined {
  const usage = event.usage ?? event.tokens;

  if (!usage) return undefined;
  const tokens: TokenUsage = {};
  const input = usage.input_tokens ?? usage.input;
  const output = usage.output_tokens ?? usage.output;
  const cached = usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cache?.read;

  if (input !== undefined) tokens.input = input;

  if (output !== undefined) tokens.output = output;

  if (cached !== undefined) tokens.cachedInput = cached;

  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

/** What a budget counts of `tokens`: input plus output. Cached input is shown, never counted. */
export function budgeted(tokens: TokenUsage | undefined): number {
  return (tokens?.input ?? 0) + (tokens?.output ?? 0);
}

/** The tokens of two runs together, by kind. */
export function addTokens(current: TokenUsage | undefined, next: TokenUsage): TokenUsage {
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

function absorbMetadata(record: JsonValue | undefined, found: ToolReport, depth: number): void {
  const parsed = MetadataEvent.safeParse(record);

  if (!parsed.success) return;
  const event = parsed.data;

  if (event.model) found.model = event.model;

  if (event.modelID) found.model = event.modelID;

  for (const key of ['thread_id', 'session_id', 'sessionID'] as const) {
    const value = event[key];

    if (value) found.session = value;
  }

  if (event.type?.startsWith('session')) {
    const nested = SessionInfo.safeParse(z.object({ info: JsonValueSchema.optional() }).safeParse(event.properties).data?.info);
    const info = nested.success ? nested : SessionInfo.safeParse(event.info);

    if (info.success && info.data.id) found.session = info.data.id;
  }

  if (event.type === 'turn.completed' || event.type === 'step_finish' || event.type === 'step-finish') {
    const tokens = tokenUsage(event);

    if (tokens) found.tokens = addTokens(found.tokens, tokens);

    // OpenCode states each step's cost in USD.
    if (event.cost !== undefined && event.cost >= 0) found.cost = { amount: (found.cost?.amount ?? 0) + event.cost, unit: 'USD' };
  }

  if (depth >= 4) return;

  for (const key of ['item', 'part', 'properties', 'info'] as const) absorbMetadata(event[key], found, depth + 1);
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
export interface AgyRun {
  model?: string;
  result?: z.infer<typeof AgyResult>['result'];
  tokens?: TokenUsage;
}

export function agyRun(stdout: string): AgyRun {
  const events = jsonRecords(stdout);

  const model = events.flatMap((event) => {
    const init = AgyInit.safeParse(event);

    return init.success ? [init.data.init.model] : [];
  }).at(0);

  const result = events.flatMap((event) => {
    const parsed = AgyResult.safeParse(event);

    return parsed.success ? [parsed.data.result] : [];
  }).at(-1);

  const usage = result?.usage;
  const tokens: TokenUsage = {};

  if (usage?.input_tokens !== undefined) tokens.input = usage.input_tokens;

  if (usage?.output_tokens !== undefined) tokens.output = usage.output_tokens;

  if (usage?.cache_read_tokens !== undefined) tokens.cachedInput = usage.cache_read_tokens;
  const run: AgyRun = {};

  if (model) run.model = model;

  if (result) run.result = result;

  if (Object.keys(tokens).length > 0) run.tokens = tokens;

  return run;
}

function agyStdout(stdout: string): ToolReport | null {
  const { model, result, tokens } = agyRun(stdout);

  if (!result) return null;
  const report: ToolReport = {};

  try {
    const output: unknown = result.response === undefined ? undefined : JSON.parse(result.response);

    if (output !== undefined) report.output = output;
  } catch {
    // A response that is not JSON reports no output.
  }

  if (model !== undefined) report.model = model;

  if (result.conversation_id) report.session = result.conversation_id;

  if (tokens) report.tokens = tokens;

  return report;
}

/** A `stream_event` line of Claude's `--include-partial-messages`: the event it wraps, a message's start or a delta. */
const ClaudeStreamLine = z.object({
  type: z.literal('stream_event'),
  event: z.looseObject({ type: Label, message: JsonValueSchema.optional() }),
});

/** The message a `message_start` event opens: its id, and the usage it starts with. */
const StartedMessage = MetadataEvent.extend({ id: Label });

/**
 * Counts what a tool billed while its stdout streams, fed one line at a time, and returns the total so far: Claude's
 * messages once each, at the usage the `message_delta` of `--include-partial-messages` states as a message ends, since
 * its assistant events repeat the usage of the message's start and it states a run's total only in its final result;
 * Codex's finished turns and OpenCode's finished steps, as `toolStdout` adds them up.
 */
export function tokenMeter(adapter: string): (line: string) => TokenUsage | undefined {
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
        const event = ClaudeStreamLine.safeParse(record).data?.event;
        const started = event?.type === 'message_start' ? StartedMessage.safeParse(event.message).data : undefined;

        if (started?.id !== undefined) current = started.id;
        const delta = event?.type === 'message_delta' ? MetadataEvent.safeParse(event).data : undefined;
        const usage = started ? tokenUsage(started) : delta ? tokenUsage(delta) : undefined;

        if (current === undefined || !usage) continue;
        // A message_delta may state only the counts that changed, such as output tokens; the others keep their value.
        const previous = messages.get(current);
        const merged = { ...previous, ...usage };
        count(previous, -1);
        count(merged, 1);
        messages.set(current, merged);
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

/** The events `codex exec --json` ends a failed turn with: an `error`, then `turn.failed`. */
const CodexError = z.union([
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('turn.failed'), error: z.object({ message: z.string() }) }),
]);

/** What `codex exec --json` reports: its metadata, and the message of the last error it printed, such as a spent usage limit. */
function codexStdout(stdout: string): ToolReport | null {
  const report = readToolMetadata(stdout);

  const error = jsonRecords(stdout).flatMap((record) => {
    const parsed = CodexError.safeParse(record);

    return parsed.success ? [parsed.data.type === 'error' ? parsed.data.message : parsed.data.error.message] : [];
  }).at(-1);

  return error === undefined ? report : { ...report, error };
}

/**
 * The error event `opencode run --format json` prints, on stdout: `error` is a kind and a message in 2.x
 * (`{"type":"provider.rate-limit","message":…}`), and a name with `data.message` in 1.x.
 */
const OpenCodeError = z.object({
  type: z.literal('error'),
  error: z.union([
    z.string().transform((message) => ({ message, kind: undefined })),
    z.object({ type: z.string(), message: z.string() }).transform(({ type, message }) => ({ message, kind: type })),
    z.object({ data: z.object({ message: z.string() }) }).transform(({ data }) => ({ message: data.message, kind: undefined })),
  ]),
});

/** The kinds of an OpenCode error that say it stopped on a usage limit: the provider's rate limit, a quota, or a plan's limit. */
const OPENCODE_LIMIT = /^provider\.(?:rate-limit|quota|[a-z]+(?:-[a-z]+)*-limit)$/;

/** What `opencode run --format json` reports: its metadata, and the last error it printed, such as a spent usage limit. */
function opencodeStdout(stdout: string): ToolReport | null {
  const report = readToolMetadata(stdout);

  const error = jsonRecords(stdout).flatMap((record) => {
    const parsed = OpenCodeError.safeParse(record);

    return parsed.success ? [parsed.data.error] : [];
  }).at(-1);

  if (error === undefined) return report;

  return { ...report, error: error.message, ...(error.kind !== undefined && { errorKind: OPENCODE_LIMIT.test(error.kind) ? 'usage_limit' : 'other' }) };
}

/** What stdout of a tool on this adapter reports. CodeBuddy prints Claude's result record. */
export function toolStdout(adapter: string, stdout: string): ToolReport | null {
  if (adapter === 'claude' || adapter === 'codebuddy') return claudeStdout(stdout);

  if (adapter === 'codex') return codexStdout(stdout);

  if (adapter === 'agy') return agyStdout(stdout);

  if (adapter === 'opencode') return opencodeStdout(stdout);

  return readToolMetadata(stdout);
}
