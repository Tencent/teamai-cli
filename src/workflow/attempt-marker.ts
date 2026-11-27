import { RUN_DIR_ENV } from '@teamai/runtime-protocol';
import { z } from 'zod';
import { ATTEMPT_ENV, EPHEMERAL_CONFIG_ENV, RUN_MODE_ENV, STEP_COMMAND_ENV, type RunMode } from '../launch-context.js';
import type { LocalConfig } from '../types.js';
import { AGENT_SESSION_ENV } from '../utils/session-id.js';
import { AttemptIdSchema, isRunId, RunIdSchema, runScratchDir } from './store.js';
import type { WorkflowFailure } from './types.js';
import { git, gitAnswer, worktreeCheckout } from './worktree.js';

/** The attempt marker's value: `<run>/<attempt>`, one run id and one attempt id, and nothing more. */
const MarkedAttemptSchema = z.string().transform((marker) => marker.split('/')).pipe(z.tuple([RunIdSchema, AttemptIdSchema])).transform(([run, attempt]) => ({ run, attempt }));

/** The run and the attempt of it that an attempt marker names. */
export type MarkedAttempt = z.output<typeof MarkedAttemptSchema>;

/**
 * The attempt `env`'s attempt marker names: undefined when the marker is unset, or names anything but exactly one run
 * and one attempt of it. The one parser of the marker; a caller that needs only the run takes `.run`.
 */
export function markedAttempt(env: NodeJS.ProcessEnv): MarkedAttempt | undefined {
  return MarkedAttemptSchema.safeParse(env[ATTEMPT_ENV]).data;
}

/**
 * What every process of an attempt of `run` gets: the attempt marker, the run's mode, and the run's directory, and the
 * config a run with no teamai init built, so the process loads it rather than one from its directory.
 */
export function attemptEnv(config: LocalConfig, run: string, attempt: string, mode: RunMode): Partial<Record<typeof EPHEMERAL_CONFIG_ENV, string>> & Record<typeof ATTEMPT_ENV | typeof RUN_MODE_ENV | typeof RUN_DIR_ENV, string> {
  const marked = { [ATTEMPT_ENV]: `${run}/${attempt}`, [RUN_MODE_ENV]: mode, [RUN_DIR_ENV]: runScratchDir(config, run) };

  return config.ephemeralConfig === undefined ? marked : { ...marked, [EPHEMERAL_CONFIG_ENV]: config.ephemeralConfig };
}

/**
 * What the process of a `command` step gets: `attemptEnv`, and the command-step marker naming the same attempt. The local
 * driver, the skill runner and a fleet member's host command launch a command step with it, and nothing else: a prompt
 * step's tool, setup, a runtime's command, a `--json` driver's lease or a step kind added later gets `attemptEnv` alone,
 * so `isCommandStep` holds for none of them. A driver that itself runs inside another attempt, as
 * the run a step's command started does, gives no marker either: that run is part of the step, one level deep.
 */
export function commandStepEnv(config: LocalConfig, run: string, attempt: string, mode: RunMode): ReturnType<typeof attemptEnv> & Partial<Record<typeof STEP_COMMAND_ENV, string>> {
  const marked = attemptEnv(config, run, attempt, mode);
  const outer = process.env[ATTEMPT_ENV];

  // A skill driver's runner runs inside the attempt it launches, which is no other one.
  return outer !== undefined && outer !== '' && outer !== marked[ATTEMPT_ENV] ? marked : { ...marked, [STEP_COMMAND_ENV]: marked[ATTEMPT_ENV] };
}

/** Whether `env` is the process of a `command` step: its command-step marker names the attempt its attempt marker names. */
export function isCommandStep(env: NodeJS.ProcessEnv): boolean {
  const attempt = env[ATTEMPT_ENV];

  return attempt !== undefined && attempt !== '' && env[STEP_COMMAND_ENV] === attempt;
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
 * What a coding session teamai runs inside sets for its own children, and that changes how a tool teamai launches
 * behaves: Claude Code turns transcript saving off in an interactive session that inherits `CLAUDE_CODE_CHILD_SESSION`,
 * so teamai would find no session of the step to record, score or resume.
 */
const OUTER_SESSION_MARKERS: ReadonlySet<string> = new Set(['CLAUDE_CODE_CHILD_SESSION']);

/** `env` without the markers of a coding session teamai runs inside, for a tool teamai launches (`OUTER_SESSION_MARKERS`). */
export function withoutOuterSessionMarkers(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !OUTER_SESSION_MARKERS.has(name)));
}

/**
 * `env` without what `agentEvidence` reads, for a process the CLI starts itself to drive a run of its own: the attempt
 * and command-step markers and run directory, and every agent session variable, which a hook inherits from the session it runs in.
 */
export function withoutAgentEvidence(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const removed = new Set<string>([ATTEMPT_ENV, STEP_COMMAND_ENV, RUN_DIR_ENV, ...AGENT_SESSION_ENV]);

  return Object.fromEntries(Object.entries(env).filter(([name]) => !removed.has(name)));
}

/**
 * Why this process may not start or drive a workflow run: it runs inside a workflow attempt, as the marker says; or, for
 * a start, it works in a workflow's place: a worktree under `.teamai/workflow-worktrees`, or a checkout on a workflow
 * branch, the only trace a place the session host made keeps.
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
  const head = gitAnswer(await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']));

  // A git that did not answer has no workflow branch to refuse, and a start there fails on git with git's own cause.
  if (head.said !== 'yes') return undefined;
  const branch = head.result.stdout.trim();
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
