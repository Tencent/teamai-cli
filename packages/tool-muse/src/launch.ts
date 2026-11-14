import { z } from 'zod';
import { answered, failed, jsonLines, reportedTokens, type CallOutput, type CallReading, type LaunchAdapter } from '@teamai/tool-core/launch';

const MuseRecord = z.object({ payload_type: z.string(), payload: z.record(z.string(), z.unknown()) });
const MuseTerminal = z.object({ terminal: z.string(), text: z.string().nullable().optional(), reason: z.string().nullable().optional() });
const MuseUsage = z.object({ models: z.array(z.object({ input_tokens: z.number(), cached_tokens: z.number(), output_tokens: z.number() }).partial()) });

/** `muse exec --json` prints one record per event: the run's terminal record carries the answer, `run.usage` the tokens. */
function readMuseExec({ stdout }: CallOutput): CallReading {
  const records = jsonLines(stdout).flatMap((line) => {
    const parsed = MuseRecord.safeParse(line);

    return parsed.success ? [parsed.data] : [];
  });

  const terminal = records.flatMap((record) => {
    const parsed = record.payload_type.startsWith('run.terminal.') ? MuseTerminal.safeParse(record.payload) : undefined;

    return parsed?.success ? [parsed.data] : [];
  }).at(-1);

  if (!terminal) return { ok: false };
  const text = terminal.text?.trim();

  if (terminal.terminal !== 'completed' || !text) return failed(terminal.reason || undefined);

  const models = records.flatMap((record) => {
    const parsed = record.payload_type === 'run.usage' ? MuseUsage.safeParse(record.payload) : undefined;

    return parsed?.success ? parsed.data.models : [];
  });

  const sum = (key: 'input_tokens' | 'cached_tokens' | 'output_tokens') => models.some((model) => model[key] !== undefined) ? models.reduce((total, model) => total + (model[key] ?? 0), 0) : undefined;

  return answered(text, reportedTokens({ input: sum('input_tokens'), output: sum('output_tokens'), cachedInput: sum('cached_tokens') }));
}

/** How teamai launches Muse Code headless. */
export const launch = {
  // muse reads no prompt from stdin: `--prompt-file` takes a regular file only.
  muse: {
    call: { evidence: 'verified', prompt: 'file', args: ({ promptFile }) => ['exec', '--json', '--no-session-log', '--prompt-file', promptFile], read: readMuseExec },
  },
} as const satisfies Record<string, LaunchAdapter>;
