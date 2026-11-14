import { z } from 'zod';
import { answered, failed, jsonLines, type CallOutput, type CallReading, type LaunchAdapter, type StepArgsHow, type StepArgsInput } from '@teamai/tool-core/launch';
import { readToolMetadata } from '@teamai/tool-core/stdout';
import { desktopCodexBinaries } from './codex-desktop.js';
import { tools } from './definitions.js';

const HOME_VARIABLE = tools.codex.home.rootVariable;

const CodexError = z.union([
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('turn.failed'), error: z.object({ message: z.string() }) }),
]);

/** Codex writes its last message to the `-o` file, and prints its events, the turn's usage included, as JSON lines. */
function readCodexExec({ stdout, lastMessage }: CallOutput): CallReading {
  const text = lastMessage?.trim();

  if (!text) {
    const error = jsonLines(stdout).flatMap((line) => {
      const parsed = CodexError.safeParse(line);

      return parsed.success ? [parsed.data] : [];
    }).at(-1);

    return failed(error?.type === 'error' ? error.message : error?.error.message);
  }

  return answered(text, readToolMetadata(stdout)?.tokens);
}

const UNATTENDED = ['--dangerously-bypass-approvals-and-sandbox'] as const;

/**
 * A Codex step: `exec --json` headless, which also takes the definition's own model; the definition always goes in the
 * prompt. Codex's sandbox lets it write only in the checkout, so `--add-dir` lets it write the result file too; `exec`
 * takes it before `resume` (codex-cli 0.167.0 refused the write without it, and wrote with it, resumed or not).
 */
function stepArgs(input: StepArgsInput, { interactive }: StepArgsHow): string[] {
  const unattended = input.unattended ? UNATTENDED : [];
  const resume = input.resume ? ['resume', input.resume] : [];
  const effort = input.effort ? ['-c', `model_reasoning_effort=${input.effort}`] : [];
  const resultDir = ['--add-dir', input.resultDir];

  if (interactive) return [...resume, ...resultDir, ...unattended, ...(input.model ? ['--model', input.model] : []), ...effort, input.prompt];
  const model = input.model ?? input.agent?.model;

  return ['exec', ...resultDir, ...resume, '--json', ...unattended, ...(model ? ['--model', model] : []), ...effort, input.prompt];
}

/** How teamai launches Codex and its variants headless; each variant starts its own command. */
export const launch = {
  codex: {
    installs: () => desktopCodexBinaries(),
    signIn: { variables: ['OPENAI_API_KEY', 'CODEX_API_KEY'] },
    call: { evidence: 'verified', prompt: 'stdin', args: ({ lastMessageFile }) => ['exec', '--json', '--skip-git-repo-check', '-o', lastMessageFile, '-'], read: readCodexExec, streams: { evidence: 'docs' } },
    // `codex exec --help` of codex-cli 0.165.0: "Intended solely for running in environments that are externally sandboxed".
    step: { evidence: 'verified', unattended: { args: UNATTENDED, evidence: 'docs' }, args: stepArgs, agentInPrompt: () => true },
    // Codex also signs in with CODEX_API_KEY ("run codex login or set CODEX_API_KEY").
    confined: { evidence: 'verified', env: [HOME_VARIABLE, 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY'], homeEnv: HOME_VARIABLE, verified: /^codex-cli 0\.163\.0$/, access: 'read' },
  },
} as const satisfies Record<string, LaunchAdapter>;
