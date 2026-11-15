import { z } from 'zod';
import { answered, failed, jsonLines, reportedTokens, type CallOutput, type CallReading, type LaunchAdapter } from '@teamai/tool-core/launch';

const PiReply = z.object({
  type: z.literal('message_end'),
  message: z.object({
    role: z.literal('assistant'),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    usage: z.object({ input: z.number(), output: z.number(), cacheRead: z.number() }).partial().optional(),
    stopReason: z.string().optional(),
    errorMessage: z.string().optional(),
  }),
});

/** pi and omp print the turn's events; the assistant's `message_end` carries the reply, its usage and any error. */
function readPiJson({ stdout }: CallOutput): CallReading {
  const reply = jsonLines(stdout).flatMap((line) => {
    const parsed = PiReply.safeParse(line);

    return parsed.success ? [parsed.data.message] : [];
  }).at(-1);

  if (!reply) return { ok: false };

  // pi exits 0 on a provider error; the reply's stop reason says it failed.
  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') return failed(reply.errorMessage || undefined);
  const text = reply.content.flatMap((part) => part.type === 'text' && part.text !== undefined ? [part.text] : []).join('\n').trim();

  if (!text) return { ok: false };
  const { usage } = reply;

  return answered(text, reportedTokens({ input: usage?.input, output: usage?.output, cachedInput: usage?.cacheRead }));
}

/** How teamai launches pi and omp headless: the same call and events, with flags of their own elsewhere. */
export const launch = {
  pi: {
    call: { evidence: 'source', prompt: 'stdin', args: () => ['-p', '--mode', 'json', '--no-session'], read: readPiJson },
    confined: {
      evidence: 'docs',
      env: ['PI_CODING_AGENT_DIR', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY'],
      homeEnv: 'PI_CODING_AGENT_DIR',
      access: 'full',
    },
  },
  // pi's fork: the same call and events, with flags of its own elsewhere.
  omp: {
    call: { evidence: 'docs', prompt: 'stdin', args: () => ['-p', '--mode', 'json', '--no-session'], read: readPiJson },
  },
} as const satisfies Record<string, LaunchAdapter>;
