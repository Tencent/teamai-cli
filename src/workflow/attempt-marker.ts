import { ATTEMPT_ENV, EPHEMERAL_CONFIG_ENV, RUN_DIR_ENV, RUN_MODE_ENV, type RunMode } from '../launch-context.js';
import type { LocalConfig } from '../types.js';
import { AGENT_SESSION_ENV } from '../utils/session-id.js';
import { isRunId, runScratchDir } from './store.js';
import type { WorkflowFailure } from './types.js';
import { git, worktreeCheckout } from './worktree.js';

/**
 * What every process of an attempt of `run` gets: the attempt marker, the run's mode, and the run's directory, and the
 * config a run with no teamai init built, so the process loads it rather than one from its directory.
 */
export function attemptEnv(config: LocalConfig, run: string, attempt: string, mode: RunMode): Partial<Record<typeof EPHEMERAL_CONFIG_ENV, string>> & Record<typeof ATTEMPT_ENV | typeof RUN_MODE_ENV | typeof RUN_DIR_ENV, string> {
  const marked = { [ATTEMPT_ENV]: `${run}/${attempt}`, [RUN_MODE_ENV]: mode, [RUN_DIR_ENV]: runScratchDir(config, run) };

  return config.ephemeralConfig === undefined ? marked : { ...marked, [EPHEMERAL_CONFIG_ENV]: config.ephemeralConfig };
}

/** Whether `env` marks its process as the runner of `attempt` of `run`. */
export function isAttemptRunner(env: NodeJS.ProcessEnv, run: string, attempt: string): boolean {
  return env[ATTEMPT_ENV] === `${run}/${attempt}`;
}

/**
 * Why a process counts as an agent's: it runs inside a workflow attempt, or inside an agent session, or it is a
 * `--driver skill` call, which only a coding agent makes, whatever variables its host sets.
 */
export type AgentEvidence =
  | { kind: 'none' }
  | { kind: 'attempt'; attempt: string }
  | { kind: 'session'; variable: typeof AGENT_SESSION_ENV[number] }
  | { kind: 'skill-driver' };

/** The evidence `env` holds that an agent runs its process: the attempt marker, else the first agent session variable set. */
export function agentEvidence(env: NodeJS.ProcessEnv): AgentEvidence {
  const attempt = env[ATTEMPT_ENV];

  if (attempt) return { kind: 'attempt', attempt };
  const variable = AGENT_SESSION_ENV.find((name) => env[name]);

  return variable ? { kind: 'session', variable } : { kind: 'none' };
}

/**
 * `env` without what `agentEvidence` reads, for a process the CLI starts itself to drive a run of its own: the attempt
 * marker and run directory, and every agent session variable, which a hook inherits from the session it runs in.
 */
export function withoutAgentEvidence(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const removed = new Set<string>([ATTEMPT_ENV, RUN_DIR_ENV, ...AGENT_SESSION_ENV]);

  return Object.fromEntries(Object.entries(env).filter(([name]) => !removed.has(name)));
}

/**
 * Why this process may not start or drive a workflow run: it runs inside a workflow attempt, as the marker says; or, for
 * a start, it works in a workflow's place: a worktree under `.teamai/workflow-worktrees`, or a checkout on a workflow
 * branch, the only trace a place the host made keeps.
 */
export type Nested =
  | { kind: 'marker'; attempt: string }
  | { kind: 'worktree-path'; dir: string; checkout: string }
  | { kind: 'workflow-branch'; dir: string; branch: string };

/**
 * The attempt marker `env` carries, which refuses every run-changing call but the report of the runner of the attempt it
 * names. A call on a run that exists reads no place: a step's child and a `--json` driver report from the step's place.
 */
export function nestedCall(env: NodeJS.ProcessEnv): Extract<Nested, { kind: 'marker' }> | undefined {
  const attempt = env[ATTEMPT_ENV];

  return attempt ? { kind: 'marker', attempt } : undefined;
}

/** What refuses a start in `cwd`: the attempt marker, then a workflow worktree, then HEAD on a workflow branch. */
export async function nestedStart(env: NodeJS.ProcessEnv, cwd: string): Promise<Nested | undefined> {
  const marked = nestedCall(env);

  if (marked) return marked;
  const checkout = worktreeCheckout(cwd);

  if (checkout !== undefined) return { kind: 'worktree-path', dir: cwd, checkout };
  const branch = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  const [owner, run, ...rest] = branch.split('/');

  return owner === 'teamai' && run !== undefined && isRunId(run) && rest.length > 0 ? { kind: 'workflow-branch', dir: cwd, branch } : undefined;
}

export function nestedWorkflowError(nested: Nested): WorkflowFailure {
  switch (nested.kind) {
    case 'marker':
      return { code: 'nested_workflow', message: `This process runs inside workflow attempt ${nested.attempt} (${ATTEMPT_ENV} is set), so it cannot start or drive a workflow run. Do the step's own work here; to run another workflow as part of a run, add it to the definition as a workflow step.` };
    case 'worktree-path':
      return { code: 'nested_workflow', message: `${nested.dir} is inside a workflow worktree of ${nested.checkout}, where a step of a run works, so no workflow run starts from it. Start runs from ${nested.checkout}; to run another workflow as part of a run, add it to the definition as a workflow step.` };
    case 'workflow-branch':
      return { code: 'nested_workflow', message: `HEAD of ${nested.dir} is on workflow branch ${nested.branch}, where a step of a run works, so no workflow run starts from it. Start runs from a checkout on a branch of your own; to run another workflow as part of a run, add it to the definition as a workflow step.` };
    default: {
      const unhandled: never = nested;

      return unhandled;
    }
  }
}
