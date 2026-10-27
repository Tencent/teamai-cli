import { z } from 'zod';
import type { Evidence } from '../tools.js';
import type { TokenUsage } from './stdout.js';

/** What a headless call printed: its answer, or the error the tool reported, when it reported one. */
export type CallReading = { ok: true; text: string; tokens?: TokenUsage } | { ok: false; message?: string };

/** How an adapter runs a prompt headless and reads the answer back. The prompt goes on stdin. */
export interface CallProfile {
  readonly evidence: Evidence;
  readonly args: readonly string[];
  read(stdout: string): CallReading;
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
function readClaudeResult(stdout: string): CallReading {
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

/** How teamai launches each family of tools headless. A tool picks its adapter with the `launch` facet in `TOOLS`. */
export const LAUNCH_ADAPTERS = {
  claude: {
    call: { evidence: 'verified', args: ['-p', '--output-format', 'json'], read: readClaudeResult },
  },
} as const satisfies Record<string, LaunchAdapter>;

export type LaunchAdapterId = keyof typeof LAUNCH_ADAPTERS;
