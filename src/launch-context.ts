/**
 * The environment contract between teamai launching an AI tool for a
 * workflow step and that tool's session-start hook (#1176). The step records
 * the team revision its checkout holds, so the hook must not pull a new one
 * into it while the step runs.
 *
 * Every process the tool starts inherits these variables, so the launch is
 * bound to the checkout it ran in: a nested session elsewhere pulls as before.
 * The hook's background pass reads the launch from its payload, never from its
 * own environment, which a detached child does not inherit on Windows.
 */
import { z } from 'zod';
import type { LocalConfig } from './types.js';
import { envFlag } from './utils/prompt.js';

/**
 * Whether a person is there for a run: `attended` where one launched it, `unattended` in CI or a cloud agent. A run's
 * mode belongs to the run, whatever drives it.
 */
export const RUN_MODES = ['attended', 'unattended'] as const;
export type RunMode = typeof RUN_MODES[number];
export const RunModeSchema = z.enum(RUN_MODES);

/** The variable that names the run mode, and that every process of a workflow attempt inherits it in. */
export const RUN_MODE_ENV = 'TEAMAI_MODE';

let warnedRunMode = false;

/** Where a run mode came from: `TEAMAI_MODE` naming it, `CI` being set, or neither. */
export type RunModeSource = typeof RUN_MODE_ENV | 'CI' | 'default';

/** A run mode with its source, and, when `TEAMAI_MODE` named no mode, the value it ignored. */
export type ExplainedRunMode =
  | { mode: RunMode; source: typeof RUN_MODE_ENV }
  | { mode: RunMode; source: Exclude<RunModeSource, typeof RUN_MODE_ENV>; ignored?: string };

/**
 * The run mode `env` launches, with its source: `TEAMAI_MODE` when it names a mode, else `unattended` when `CI` is set,
 * else `attended`. Any other non-empty `TEAMAI_MODE` is ignored.
 */
export function explainRunMode(env: NodeJS.ProcessEnv): ExplainedRunMode {
  const named = RunModeSchema.safeParse(env[RUN_MODE_ENV]);
  if (named.success) return { mode: named.data, source: RUN_MODE_ENV };
  const ignored = env[RUN_MODE_ENV] || undefined;
  const ci = envFlag('CI', env);
  return { mode: ci ? 'unattended' : 'attended', source: ci ? 'CI' : 'default', ...(ignored !== undefined ? { ignored } : {}) };
}

/** The one run mode all of `modes` are, or undefined when they differ or one is undefined. */
export function agreedRunMode(modes: Iterable<RunMode | undefined>): RunMode | undefined {
  const distinct = new Set(modes);
  const [only] = distinct;
  return distinct.size === 1 ? only : undefined;
}

/** The run mode `env` launches, as {@link explainRunMode} resolves it, with a warning on stderr the first time it ignores `TEAMAI_MODE`. */
export function resolveRunMode(env: NodeJS.ProcessEnv): RunMode {
  const explained = explainRunMode(env);
  if ('ignored' in explained && explained.ignored !== undefined && !warnedRunMode) {
    warnedRunMode = true;
    process.stderr.write(`teamai: TEAMAI_MODE is "${explained.ignored}", which is neither attended nor unattended, so teamai ignores it and reads the mode from CI. Set TEAMAI_MODE to attended or unattended, or unset it.\n`);
  }
  return explained.mode;
}

/**
 * The variable a skill driver's runner is started with, and passes to the command it runs: `<run>/<attempt>`. A
 * `workflow report` call that carries the marker of the attempt it reports is that attempt's runner.
 */
export const ATTEMPT_ENV = 'TEAMAI_WORKFLOW_ATTEMPT';

/** The variable that names who launched a tool's session: `workflow` for a step, `scorer` for a judge, or the {@link LaunchedBy} caller of one of teamai's own AI calls. */
export const LAUNCHED_BY_ENV = 'TEAMAI_LAUNCHED_BY';

/**
 * Who launched the session `vars` (an environment, or a launch a payload forwarded) runs in: `TEAMAI_LAUNCHED_BY`, else
 * `workflow` under a skill driver's attempt marker, which sets no `TEAMAI_LAUNCHED_BY`. Undefined for the member's own
 * session. A child session a host starts for a skill-driven run carries neither, so it counts as the member's.
 */
export function launchedBy(vars: Readonly<Record<string, unknown>>): string | undefined {
  const by = vars[LAUNCHED_BY_ENV];
  if (typeof by === 'string' && by) return by;
  const attempt = vars[ATTEMPT_ENV];
  return typeof attempt === 'string' && attempt ? 'workflow' : undefined;
}

/** The mode a session runs in, and who launched it when teamai did. Records written before this carry neither. */
export const SessionRunSchema = z.object({ runMode: RunModeSchema, launchedBy: z.string().min(1).optional() });
export type SessionRun = z.infer<typeof SessionRunSchema>;

/** The hook payload field the foreground dispatcher forwards the session's {@link SessionRun} in. */
export const SESSION_RUN_PAYLOAD_KEY = 'teamai_run';

/** The {@link SessionRun} of a session whose hook runs with `env`. */
export function sessionRun(env: NodeJS.ProcessEnv): SessionRun {
  const by = launchedBy(env);
  return { runMode: resolveRunMode(env), ...(by ? { launchedBy: by } : {}) };
}

/** The {@link SessionRun} the foreground dispatcher forwarded in `payload`, or undefined when it forwarded none. */
export function readSessionRun(payload: Readonly<Record<string, unknown>>): SessionRun | undefined {
  const parsed = SessionRunSchema.safeParse(payload[SESSION_RUN_PAYLOAD_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Who in teamai launched a tool's session, as `TEAMAI_LAUNCHED_BY` carries it: a workflow step, a scorer judge, or the
 * module whose AI call started it.
 */
export type LaunchedBy =
  | 'workflow' | 'scorer'
  | 'codebase' | 'deep-enrich' | 'enrich-with-ai' | 'import-local' | 'iwiki-dual' | 'import-mr' | 'recall-promote' | 'quality-update' | 'votes-judge';

/** A tool launched by a workflow step, in the checkout whose pull record has key `checkout`. */
export type Launch = { by: 'workflow'; tool: string; checkout: string };

/** The hook payload field the foreground dispatcher forwards the launch in. */
export const LAUNCH_PAYLOAD_KEY = 'teamai_launch';

const TOOL = 'TEAMAI_LAUNCHED_TOOL';
const CHECKOUT = 'TEAMAI_LAUNCHED_CHECKOUT';

export function launchEnv(launch: Launch): Record<string, string> {
  return { [LAUNCHED_BY_ENV]: launch.by, [TOOL]: launch.tool, [CHECKOUT]: launch.checkout };
}

/** The launch `vars` (an environment or a forwarded payload value) carry, unless one of its variables is missing. */
export function readLaunch(vars: unknown): Launch | undefined {
  if (!vars || typeof vars !== 'object') return undefined;
  const values = vars as Record<string, unknown>;
  const tool = values[TOOL];
  const checkout = values[CHECKOUT];
  if (launchedBy(values) !== 'workflow' || typeof tool !== 'string' || !tool || typeof checkout !== 'string' || !checkout) return undefined;
  return { by: 'workflow', tool, checkout };
}

/** The launch of `tool` for a step in the checkout `config`'s pulls deliver into; undefined when the scope has none. */
export async function workflowLaunch(config: LocalConfig, tool: string): Promise<Launch | undefined> {
  const { checkoutRecordKey } = await import('./pull.js');
  const checkout = await checkoutRecordKey(config);
  return checkout ? { by: 'workflow', tool, checkout } : undefined;
}

/**
 * Whether a session `launch` started may leave the checkout as delivered: `config`'s checkout is the one the tool was
 * launched in, and its record holds one complete team delivery for that tool. That holds for any tool the launched one
 * starts there, so its pull cannot move the step's files; one the checkout was not delivered to gets its first delivery
 * at its next session outside the step. Anything else pulls, root seeding included, so a new worktree or a newly
 * enabled tool still gets the team's assets.
 */
export async function launchHoldsCheckout(config: LocalConfig, launch: Launch): Promise<boolean> {
  const { teamDelivery } = await import('./pull.js');
  const delivery = await teamDelivery(config, launch.tool);
  return delivery.complete && delivery.key === launch.checkout;
}
