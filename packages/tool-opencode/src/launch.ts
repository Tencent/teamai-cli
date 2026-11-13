import { z } from 'zod';
import { answered, failed, jsonLines, opencodeModelArgs, type CallOutput, type CallReading, type LaunchAdapter, type StepArgsHow, type StepArgsInput } from '@teamai/tool-core/launch';
import { readToolMetadata } from '@teamai/tool-core/stdout';


const OpenCodeSession = z.object({ sessionID: z.string() });

const OpenCodeEvent = z.union([
  z.object({ type: z.literal('text'), part: z.object({ text: z.string() }) }),
  z.object({ type: z.literal('error'), error: z.object({ message: z.string() }) }),
]);

/** OpenCode prints the answer as `text` parts and an error as an `error` event; `step_finish` carries the tokens. */
function readOpenCodeRun({ stdout }: CallOutput): CallReading {
  const events = jsonLines(stdout).flatMap((line) => {
    const parsed = OpenCodeEvent.safeParse(line);

    return parsed.success ? [parsed.data] : [];
  });

  const error = events.flatMap((event) => event.type === 'error' ? [event.error.message] : []).at(-1);
  const text = events.flatMap((event) => event.type === 'text' ? [event.part.text] : []).join('\n').trim();

  if (error !== undefined || !text) return failed(error);

  const session = jsonLines(stdout).flatMap((line) => {
    const parsed = OpenCodeSession.safeParse(line);

    return parsed.success ? [parsed.data.sessionID] : [];
  }).at(-1);

  return answered(text, readToolMetadata(stdout)?.tokens, session);
}

const UNATTENDED = ['--auto'] as const;

/**
 * OpenCode 2's `run` without `--standalone` talks to its background service, and starts `opencode serve --service`
 * when none runs, which outlives the run with the env it was started in (2.2.5). OpenCode 1 has neither.
 */
const standalone = (opencodeMajor: number): string[] => (opencodeMajor >= 2 ? ['--standalone'] : []);

/** An OpenCode step: `run --format json` headless, the TUI with `--prompt` for a person. */
function stepArgs(input: StepArgsInput, { interactive, opencodeMajor }: StepArgsHow): string[] {
  const unattended = input.unattended ? UNATTENDED : [];
  const agent = input.agent && !input.agent.inPrompt ? ['--agent', input.agent.name] : [];

  if (interactive) return [...unattended, ...agent, ...(input.model ? ['--model', input.model] : []), '--prompt', input.prompt];

  return ['run', ...standalone(opencodeMajor), '--format', 'json', ...unattended, input.prompt, ...agent, ...opencodeModelArgs(input.model === undefined ? undefined : { name: input.model, effort: input.effort }, opencodeMajor)];
}

/** How teamai launches OpenCode headless. */
export const launch = {
  opencode: {
    call: {
      evidence: 'verified',
      prompt: 'stdin',
      args: ({ opencodeMajor }) => ['run', ...standalone(opencodeMajor), '--format', 'json'],
      read: readOpenCodeRun,
      // `opencode run --help` of 2.1.2: `-s, --session` continues a session by its id.
      resume: { evidence: 'docs', args: (session) => ['--session', session] },
      // Prints each event as it comes (the recorded run in ./fixtures).
      streams: { evidence: 'verified' },
    },
    // `opencode run --help` of 2.1.2 and opencode.ai/docs/permissions: approves every request a rule does not deny.
    step: { evidence: 'verified', unattended: { args: UNATTENDED, evidence: 'docs' }, args: stepArgs, agentInPrompt: ({ opencodeMajor, isSubagent }) => opencodeMajor < 2 && isSubagent },
    confined: { evidence: 'verified', env: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'OPENCODE_API_KEY'], verified: /^opencode v2\.1\.2$/, access: 'read' },
  },
} as const satisfies Record<string, LaunchAdapter>;
