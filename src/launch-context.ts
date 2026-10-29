/** Run-mode and launcher attribution shared by AI calls, session capture and human-review guards. */
import { z } from 'zod';
import { envFlag } from './utils/prompt.js';

/**
 * Whether a person is there for a run: `attended` where one launched it, `unattended` in CI or a cloud agent. A run's
 * mode belongs to the run, whatever drives it.
 */
export const RUN_MODES = ['attended', 'unattended'] as const;
export type RunMode = typeof RUN_MODES[number];
export const RunModeSchema = z.enum(RUN_MODES);

/** The variable that names the run mode inherited by child processes. */
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

/** Legacy marker retained only to read session attribution and refuse automated human confirmation. */
export const ATTEMPT_ENV = 'TEAMAI_WORKFLOW_ATTEMPT';

/** The variable that names the internal caller that launched a tool session. */
export const LAUNCHED_BY_ENV = 'TEAMAI_LAUNCHED_BY';

/** Read current or legacy launcher attribution; this never starts or resumes a workflow. */
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

/** Internal AI callers that may launch a new session. */
export type LaunchedBy =
  | 'codebase' | 'deep-enrich' | 'enrich-with-ai' | 'import-local' | 'iwiki-dual' | 'import-mr' | 'recall-promote' | 'quality-update' | 'votes-judge';
