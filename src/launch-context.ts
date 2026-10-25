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
import type { LocalConfig } from './types.js';
import { envFlag } from './utils/prompt.js';

/**
 * Whether a person is there for a run: `attended` where one launched it, `unattended` in CI or a cloud agent. A run's
 * mode belongs to the run, whatever drives it.
 */
export const RUN_MODES = ['attended', 'unattended'] as const;
export type RunMode = typeof RUN_MODES[number];

/** The variable that names the run mode, and that every process of a workflow attempt inherits it in. */
export const RUN_MODE_ENV = 'TEAMAI_MODE';

let warnedRunMode = false;

/**
 * The run mode `env` launches: `TEAMAI_MODE` when it names a mode, else `unattended` when `CI` is set, else `attended`.
 * Any other non-empty `TEAMAI_MODE` is ignored, with a warning on stderr the first time.
 */
export function resolveRunMode(env: NodeJS.ProcessEnv): RunMode {
  const named = env[RUN_MODE_ENV];
  const mode = RUN_MODES.find((known) => known === named);
  if (mode) return mode;
  if (named !== undefined && named !== '' && !warnedRunMode) {
    warnedRunMode = true;
    process.stderr.write(`teamai: TEAMAI_MODE is "${named}", which is neither attended nor unattended, so teamai ignores it and reads the mode from CI. Set TEAMAI_MODE to attended or unattended, or unset it.\n`);
  }
  return envFlag('CI', env) ? 'unattended' : 'attended';
}

/** A tool launched by a workflow step, in the checkout whose pull record has key `checkout`. */
export type Launch = { by: 'workflow'; tool: string; checkout: string };

/** The hook payload field the foreground dispatcher forwards the launch in. */
export const LAUNCH_PAYLOAD_KEY = 'teamai_launch';

const BY = 'TEAMAI_LAUNCHED_BY';
const TOOL = 'TEAMAI_LAUNCHED_TOOL';
const CHECKOUT = 'TEAMAI_LAUNCHED_CHECKOUT';

export function launchEnv(launch: Launch): Record<string, string> {
  return { [BY]: launch.by, [TOOL]: launch.tool, [CHECKOUT]: launch.checkout };
}

/** The launch `vars` (an environment or a forwarded payload value) carry, unless one of its variables is missing. */
export function readLaunch(vars: unknown): Launch | undefined {
  if (!vars || typeof vars !== 'object') return undefined;
  const values = vars as Record<string, unknown>;
  const tool = values[TOOL];
  const checkout = values[CHECKOUT];
  if (values[BY] !== 'workflow' || typeof tool !== 'string' || !tool || typeof checkout !== 'string' || !checkout) return undefined;
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
