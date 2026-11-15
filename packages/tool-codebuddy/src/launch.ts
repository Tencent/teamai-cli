import { readClaudeResult, resultDirRule, type LaunchAdapter, type StepArgsHow, type StepArgsInput } from '@teamai/tool-core/launch';

const UNATTENDED = ['--permission-mode', 'bypassPermissions'] as const;

/** A CodeBuddy step: Claude's flags, with no --effort. */
function stepArgs(input: StepArgsInput, { interactive }: StepArgsHow): string[] {
  const unattended = input.unattended ? UNATTENDED : [];
  const agent = input.agent && !input.agent.inPrompt ? ['--agent', input.agent.name] : [];
  const model = input.model ? ['--model', input.model] : [];
  const resume = input.resume ? ['--resume', input.resume] : [];
  const editRule = resultDirRule(input.resultDir);

  if (interactive) return [...unattended, editRule, ...agent, ...model, ...resume, input.prompt];
  const turns = input.maxTurns !== undefined ? ['--max-turns', String(input.maxTurns)] : [];

  return ['-p', input.prompt, '--output-format', 'stream-json', '--verbose', ...unattended, editRule, ...turns, ...agent, ...model, ...resume];
}

/** How teamai launches the CodeBuddy CLI headless; WorkBuddy has no launch profile. */
export const launch = {
  codebuddy: {
    signIn: { variables: ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN'] },
    call: { evidence: 'docs', prompt: 'stdin', args: () => ['-p', '--output-format', 'json'], read: readClaudeResult },
    // Claude's flags and stream, without --effort. Its unattended mode is codebuddy.ai/docs/cli/permission-modes.
    step: { evidence: 'docs', unattended: { args: UNATTENDED, evidence: 'docs' }, args: stepArgs },
    // CodeBuddy lists about 70 tools whatever `--tools` says.
    confined: { evidence: 'docs', env: ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_CONFIG_DIR'], homeEnv: 'CODEBUDDY_CONFIG_DIR', access: 'full' },
  },
} as const satisfies Record<string, LaunchAdapter>;
