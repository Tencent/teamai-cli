import { readClaudeResult, resultDirRule, type LaunchAdapter, type StepArgsHow, type StepArgsInput } from '@teamai/tool-core/launch';
import { tools } from './definitions.js';

const HOME_VARIABLE = tools.claude.home.rootVariable;

const UNATTENDED = ['--permission-mode', 'bypassPermissions'] as const;

/** A Claude step: `-p` with stream-json headless, the prompt last for a person. */
function stepArgs(input: StepArgsInput, { interactive }: StepArgsHow): string[] {
  const unattended = input.unattended ? UNATTENDED : [];
  const agent = input.agent && !input.agent.inPrompt ? ['--agent', input.agent.name] : [];
  const model = input.model ? ['--model', input.model] : [];
  const effort = input.effort ? ['--effort', input.effort] : [];
  const resume = input.resume ? ['--resume', input.resume] : [];
  const editRule = resultDirRule(input.resultDir);

  if (interactive) return [...unattended, editRule, ...agent, ...model, ...effort, ...resume, input.prompt];
  const turns = input.maxTurns !== undefined ? ['--max-turns', String(input.maxTurns)] : [];

  // Only partial messages state each message's final usage as it ends, which the budget meter counts.
  return ['-p', input.prompt, '--output-format', 'stream-json', '--verbose', ...(input.streamsUsage ? ['--include-partial-messages'] : []), ...unattended, editRule, ...turns, ...agent, ...model, ...effort, ...resume];
}

/** How teamai launches Claude Code and its variants headless; each variant starts its own command. */
export const launch = {
  claude: {
    signIn: { variables: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], alongside: ['ANTHROPIC_BASE_URL'], gateway: { url: 'ANTHROPIC_BASE_URL', token: 'ANTHROPIC_AUTH_TOKEN' } },
    call: {
      evidence: 'verified',
      prompt: 'stdin',
      args: () => ['-p', '--output-format', 'json'],
      read: readClaudeResult,
      // Claude Code 2.1.319 continued a `claude -p` session this way (2026-11-08).
      resume: { evidence: 'verified', args: (session) => ['--resume', session] },
      // `--output-format json` prints nothing until the call ends; stream-json prints each message, its last the same
      // result record (Claude Code 2.1.319, 2026-11-08).
      streams: { evidence: 'verified', args: () => ['-p', '--output-format', 'stream-json', '--verbose'] },
    },
    // Claude Code 2.1.312 ran a strict-sandbox benchmark trial in this mode (2026-10-30, `teamai benchmark run --sandbox`).
    step: { evidence: 'verified', unattended: { args: UNATTENDED, evidence: 'verified' }, args: stepArgs },
    confined: {
      evidence: 'verified',
      env: [HOME_VARIABLE, 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'],
      homeEnv: HOME_VARIABLE,
      verified: /^2\.1\.308 \(Claude Code\)$/,
      access: 'read',
    },
  },
} as const satisfies Record<string, LaunchAdapter>;
