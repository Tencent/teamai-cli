import { answered, failed, type CallOutput, type CallReading, type LaunchAdapter, type StepArgsHow, type StepArgsInput } from '@teamai/tool-core/launch';
import { agyRun } from '@teamai/tool-core/stdout';


/** agy's stream-json output ends with a `result` event: the response on SUCCESS, else the error, and the turn's usage. */
function readAgyStream({ stdout }: CallOutput): CallReading {
  const { result, tokens } = agyRun(stdout);

  if (!result) return { ok: false };
  const text = result.response?.trim();

  if (result.status !== 'SUCCESS' || !text) return failed(result.error || undefined);

  return answered(text, tokens);
}

const UNATTENDED = ['--dangerously-skip-permissions'] as const;

/** An agy step: stream-json with the prompt attached to `--print=` headless, `--prompt-interactive` for a person. */
function stepArgs(input: StepArgsInput, { interactive }: StepArgsHow): string[] {
  const unattended = input.unattended ? UNATTENDED : [];
  const agent = input.agent && !input.agent.inPrompt ? ['--agent', input.agent.name] : [];
  const model = input.model ? ['--model', input.model] : [];
  const effort = input.effort ? ['--effort', input.effort] : [];
  const conversation = input.resume ? ['--conversation', input.resume] : [];

  if (interactive) return [...unattended, ...agent, ...model, ...effort, ...conversation, '--prompt-interactive', input.prompt];

  // `--print=` keeps the prompt attached: a bare `-p` takes its next argument as the prompt, even a flag.
  return ['--output-format=stream-json', ...unattended, ...agent, ...model, ...effort, ...conversation, `--print=${input.prompt}`];
}

/** How teamai launches agy headless. */
export const launch = {
  // agy reads stdin only as stream-json user events. `--print=` is print mode with the prompt left to them; a bare
  // `-p` would take the next flag as its prompt.
  agy: {
    // `agy --help` of 1.4.10.
    step: { evidence: 'verified', unattended: { args: UNATTENDED, evidence: 'docs' }, args: stepArgs },
    // Plan mode with the sandbox reads files but runs no shell and writes nothing in the workspace (agy 1.4.10).
    confined: { evidence: 'verified', env: ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL'], access: 'read' },
    call: {
      evidence: 'verified',
      prompt: 'stdin',
      stdinOf: (prompt) => `${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } })}\n`,
      args: () => ['--input-format=stream-json', '--output-format=stream-json', '--print='],
      read: readAgyStream,
    },
  },
} as const satisfies Record<string, LaunchAdapter>;
