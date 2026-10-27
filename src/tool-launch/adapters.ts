import { z } from 'zod';
import type { Evidence } from '../tools.js';
import { readToolMetadata, type TokenUsage } from './stdout.js';

/** What a headless call printed: its answer, or the error the tool reported, when it reported one. */
export type CallReading = { ok: true; text: string; tokens?: TokenUsage } | { ok: false; message?: string };

/** What a finished call left: its stdout, and the last message it wrote to the file `args` named, if it wrote one. */
export interface CallOutput {
  stdout: string;
  lastMessage: string | undefined;
}

/** How an adapter runs a prompt headless and reads the answer back. The prompt goes on stdin. */
export interface CallProfile {
  readonly evidence: Evidence;
  /** `lastMessageFile` is a fresh path in a scratch directory, for a tool that writes its last message to a file. */
  args(lastMessageFile: string): string[];
  read(output: CallOutput): CallReading;
}

export interface LaunchAdapter {
  readonly call: CallProfile;
}

function jsonLines(stdout: string): unknown[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return [];
    try { return [JSON.parse(trimmed) as unknown]; } catch { return []; }
  });
}

const ClaudeResult = z.object({
  type: z.literal('result'),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional(), cache_read_input_tokens: z.number().optional() }).partial().optional(),
});

/** Claude's `--output-format json` result record, which CodeBuddy prints too. */
function readClaudeResult({ stdout }: CallOutput): CallReading {
  const record = jsonLines(stdout).flatMap((line) => { const parsed = ClaudeResult.safeParse(line); return parsed.success ? [parsed.data] : []; }).at(-1);
  if (!record) return { ok: false };
  // An error exits 1 with the reason in `result`; stderr carries only a tag such as `[claude-code:unrecognized_model]`.
  if (record.is_error || record.result === undefined) return { ok: false, ...(record.result ? { message: record.result } : {}) };
  const usage = record.usage;
  const tokens: TokenUsage = {
    ...(usage?.input_tokens !== undefined ? { input: usage.input_tokens } : {}),
    ...(usage?.output_tokens !== undefined ? { output: usage.output_tokens } : {}),
    ...(usage?.cache_read_input_tokens !== undefined ? { cachedInput: usage.cache_read_input_tokens } : {}),
  };
  return { ok: true, text: record.result.trim(), ...(Object.keys(tokens).length > 0 ? { tokens } : {}) };
}

const CodexError = z.union([
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('turn.failed'), error: z.object({ message: z.string() }) }),
]);

/** Codex writes its last message to the `-o` file, and prints its events, the turn's usage included, as JSON lines. */
function readCodexExec({ stdout, lastMessage }: CallOutput): CallReading {
  const text = lastMessage?.trim();
  if (!text) {
    const error = jsonLines(stdout).flatMap((line) => { const parsed = CodexError.safeParse(line); return parsed.success ? [parsed.data] : []; }).at(-1);
    return { ok: false, ...(error ? { message: error.type === 'error' ? error.message : error.error.message } : {}) };
  }
  const tokens = readToolMetadata(stdout)?.tokens;
  return { ok: true, text, ...(tokens ? { tokens } : {}) };
}

const OpenCodeEvent = z.union([
  z.object({ type: z.literal('text'), part: z.object({ text: z.string() }) }),
  z.object({ type: z.literal('error'), error: z.object({ message: z.string() }) }),
]);

/** OpenCode prints the answer as `text` parts and an error as an `error` event; `step_finish` carries the tokens. */
function readOpenCodeRun({ stdout }: CallOutput): CallReading {
  const events = jsonLines(stdout).flatMap((line) => { const parsed = OpenCodeEvent.safeParse(line); return parsed.success ? [parsed.data] : []; });
  const error = events.flatMap((event) => event.type === 'error' ? [event.error.message] : []).at(-1);
  const text = events.flatMap((event) => event.type === 'text' ? [event.part.text] : []).join('\n').trim();
  if (error !== undefined || !text) return { ok: false, ...(error !== undefined ? { message: error } : {}) };
  const tokens = readToolMetadata(stdout)?.tokens;
  return { ok: true, text, ...(tokens ? { tokens } : {}) };
}

const OpenClawEnvelope = z.object({
  ok: z.boolean(),
  final: z.string().optional(),
  usage: z.object({ input: z.number().optional(), output: z.number().optional() }).optional(),
  error: z.object({ message: z.string() }).optional(),
});

/** `openclaw agent exec --json` prints one envelope: `final` is the answer, `usage` the tokens, `error` the failure. */
function readOpenClawExec({ stdout }: CallOutput): CallReading {
  let candidate: unknown;
  try { candidate = JSON.parse(stdout.trim()); } catch { candidate = jsonLines(stdout).at(-1); }
  const parsed = OpenClawEnvelope.safeParse(candidate);
  if (!parsed.success) return { ok: false };
  const { ok, final, usage, error } = parsed.data;
  if (!ok || !final?.trim()) return { ok: false, ...(error ? { message: error.message } : {}) };
  const tokens: TokenUsage = {
    ...(usage?.input !== undefined ? { input: usage.input } : {}),
    ...(usage?.output !== undefined ? { output: usage.output } : {}),
  };
  return { ok: true, text: final.trim(), ...(Object.keys(tokens).length > 0 ? { tokens } : {}) };
}

/** How teamai launches each family of tools headless. A tool picks its adapter with the `launch` facet in `TOOLS`. */
export const LAUNCH_ADAPTERS = {
  claude: {
    call: { evidence: 'verified', args: () => ['-p', '--output-format', 'json'], read: readClaudeResult },
  },
  codex: {
    call: { evidence: 'verified', args: (lastMessageFile) => ['exec', '--json', '-o', lastMessageFile, '-'], read: readCodexExec },
  },
  opencode: {
    call: { evidence: 'verified', args: () => ['run', '--format', 'json'], read: readOpenCodeRun },
  },
  codebuddy: {
    call: { evidence: 'verified', args: () => ['-p', '--output-format', 'json'], read: readClaudeResult },
  },
  // One embedded turn with ephemeral state, so no call leaves a session in the member's conversations (#1308).
  openclaw: {
    call: { evidence: 'docs', args: () => ['agent', 'exec', '--json', '--message-file', '-'], read: readOpenClawExec },
  },
} as const satisfies Record<string, LaunchAdapter>;

export type LaunchAdapterId = keyof typeof LAUNCH_ADAPTERS;
