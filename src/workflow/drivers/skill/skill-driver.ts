/**
 * The skill driver: a coding session drives a run through `workflow start|next|report --driver skill`, running only
 * the literals each reply prints, while detached runners run its command steps. This module is its entry.
 */
import { z } from 'zod';
import { resolveCliEntry } from '../../../builtin-hooks.js';
import { driverIdentity } from '../../../driver-identity.js';
import type { WorkflowEnv } from '../../../env-resolution.js';
import type { LocalConfig } from '../../../types.js';
import { agentSessionIdFromEnv } from '../../../utils/session-id.js';
import { isAttemptRunner } from '../../attempt-marker.js';
import { inProcessClient, type WorkflowClient } from '../../protocol.js';
import { AttemptIdSchema, RunIdSchema, withRunLock, type AttemptId, type RunId, type RunLock } from '../../store.js';
import { describeLiteral, invocationOf, type Invocation } from './literals.js';
import { askFor, checkStartAnswers, localOnlySteps, neededAnswers } from './preflight.js';
import { writeSkillState, type SkillState } from './skill-state.js';
import { detachedRunners, runRunner } from './skill-runner.js';
import { ceilingOf, foreground, poll, startRefused, take } from './tick.js';
import type { RowId } from './transitions.js';
import type { SkillAnswer, SkillError } from './turn.js';

export type SkillCall =
  | { kind: 'describe'; name: string }
  | { kind: 'start'; name: string; answers: { parallel?: number; confirmed: boolean }; inputs: unknown }
  | { kind: 'next'; run: RunId; wait: boolean }
  /** `runner` when the call carries the attempt's marker: the runner reports itself. */
  | { kind: 'report'; run: RunId; attempt: AttemptId; role: 'runner' | 'agent' };

/** Where the runner of an attempt starts. */
export interface RunnerJob {
  run: RunId;
  attempt: AttemptId;
  checkout: string;
}

/** How runners start, how a tick tells one is alive, and how a call waits. */
export interface Runners {
  spawn(job: RunnerJob): Promise<void>;
  alive(run: RunId, attempt: AttemptId): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface SkillContext {
  config: LocalConfig;
  env: WorkflowEnv;
  client: WorkflowClient;
  /** The calling agent session, undefined when its host names none. */
  session: string | undefined;
  invocation: Invocation;
  /** The checkout a start runs from. */
  cwd: string;
  now: () => Date;
  runners: Runners;
  locks: { take<T>(run: RunId, body: (lock: RunLock) => Promise<T>, waitMs: number): Promise<T | { error: { code: 'driver_running'; message: string } }> };
  /** Gets the id of every transition row a call takes. */
  trace?: (row: RowId) => void;
}

/**
 * The context of a call from this process: its agent session, how the member ran teamai, the in-process protocol,
 * detached runners, and the real clock.
 */
export async function skillContext(input: Pick<SkillContext, 'config' | 'env' | 'cwd' | 'trace'>): Promise<SkillContext> {
  const { config, env } = input;
  return {
    ...input,
    session: await agentSessionIdFromEnv(),
    invocation: invocationOf(resolveCliEntry() ?? undefined),
    client: inProcessClient({ config, env }),
    now: () => new Date(),
    runners: detachedRunners(config),
    locks: { take: (run, body, waitMs) => withRunLock(config, run, body, { waitMs }) },
  };
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const StartOptionsSchema = z.object({
  describe: z.boolean().optional(),
  parallel: z.string().regex(/^[1-9][0-9]*$/, '--parallel takes a whole number of steps, 1 or more').transform(Number).optional(),
  confirmed: z.boolean().optional(),
  inputs: z.string().optional(),
  tools: z.undefined({ invalid_type_error: '--tools is for --driver local' }),
  autoApprove: z.undefined({ invalid_type_error: '--auto-approve is for --driver local' }),
});
const NextOptionsSchema = z.object({
  wait: z.boolean().optional(),
  json: z.undefined({ invalid_type_error: '--driver skill takes no --json: the skill driver composes every request itself' }),
  prepare: z.undefined({ invalid_type_error: '--prepare is for --json drivers' }),
});
const ReportOptionsSchema = z.object({
  attempt: AttemptIdSchema,
  json: z.undefined({ invalid_type_error: '--driver skill takes no --json: the skill driver composes every report itself' }),
});

function invalid(error: z.ZodError): { error: SkillError } {
  return { error: { code: 'invalid_arguments', message: error.issues[0]?.message ?? 'invalid options', next: null } };
}

/**
 * Reads a `--driver skill` command line into a call. `env` tells a runner, which carries its attempt's marker, from
 * an agent.
 */
export function parseSkillCall(
  raw: { kind: 'start'; name: string; options: unknown } | { kind: 'next' | 'report'; run: string; options: unknown },
  env: NodeJS.ProcessEnv,
): SkillCall | { error: SkillError } {
  if (raw.kind === 'start') {
    if (!NAME.test(raw.name)) return { error: { code: 'invalid_arguments', message: `"${raw.name}" is not a workflow name`, next: null } };
    const options = StartOptionsSchema.safeParse(raw.options);
    if (!options.success) return invalid(options.error);
    if (options.data.describe) return { kind: 'describe', name: raw.name };
    let inputs: unknown;
    if (options.data.inputs !== undefined) {
      try {
        inputs = JSON.parse(options.data.inputs) as unknown;
      } catch {
        return { error: { code: 'invalid_json', message: 'Could not parse --inputs as JSON', next: null } };
      }
    }
    const { parallel, confirmed } = options.data;
    return { kind: 'start', name: raw.name, answers: { ...(parallel !== undefined ? { parallel } : {}), confirmed: confirmed === true }, inputs };
  }
  const run = RunIdSchema.safeParse(raw.run);
  if (!run.success) return invalid(run.error);
  if (raw.kind === 'next') {
    const options = NextOptionsSchema.safeParse(raw.options);
    return options.success ? { kind: 'next', run: run.data, wait: options.data.wait === true } : invalid(options.error);
  }
  const options = ReportOptionsSchema.safeParse(raw.options);
  if (!options.success) return invalid(options.error);
  return { kind: 'report', run: run.data, attempt: options.data.attempt, role: isAttemptRunner(env, run.data, options.data.attempt) ? 'runner' : 'agent' };
}

export async function runSkillCall(call: SkillCall, context: SkillContext): Promise<SkillAnswer> {
  switch (call.kind) {
    case 'describe':
    case 'start':
      return start(call, context);
    case 'next':
      return call.wait ? poll(context, call.run) : foreground(context, call.run, { kind: 'next' });
    case 'report':
      return call.role === 'runner' ? runRunner(context, call.run, call.attempt) : foreground(context, call.run, { kind: 'report', attempt: call.attempt });
    default: {
      const unhandled: never = call;
      return unhandled;
    }
  }
}

async function start(call: Extract<SkillCall, { kind: 'describe' | 'start' }>, context: SkillContext): Promise<SkillAnswer> {
  const ceiling = ceilingOf(context.config);
  const described = await context.client.describe(call.name, { ceiling });
  if ('error' in described) return { error: { ...described.error, next: null } };
  const { description } = described;
  const localOnly = localOnlySteps(description);
  if (call.kind === 'describe') {
    const taken = take(context, undefined, { kind: 'describe', needed: neededAnswers(description), localOnly });
    const kind = taken?.answer?.kind === 'describe' ? taken.answer.ask : 'start';
    return { data: { describe: { workflow: description, ask: askFor(kind, description, context.invocation) } } };
  }
  const check = checkStartAnswers({ description, answers: call.answers, inputs: call.inputs, ceiling });
  const taken = take(context, undefined, { kind: 'start', check, localOnly });
  const effect = taken?.effects.find((planned) => planned.kind === 'start');
  if (taken?.row === 'R9' && check.kind === 'confirm-needed') {
    const lacks = check.missing.map((answer) => ({ confirmed: '--confirmed, the person\'s yes', inputs: '--inputs', parallel: '--parallel' })[answer]);
    const said = [
      ...(lacks.length > 0 ? [`it needs ${lacks.join(', ')}`] : []),
      ...(check.outOfRange ? [`--parallel ${check.outOfRange.parallel} is above the most this machine runs at once, ${check.outOfRange.ceiling}`] : []),
    ];
    return { error: { code: 'confirm_needed', message: `Start ${description.name} from its describe reply: ${said.join('; ')}. Run the describe literal and ask the person.`, next: describeLiteral(context.invocation, description.name) } };
  }
  if (!effect || effect.kind !== 'start') {
    return { error: { code: 'needs_local_driver', message: `${description.name} has steps the skill driver does not run in a coding session yet: ${localOnly.join(', ')}. Prompt steps and steps outside the checkout need the local driver for now. The person can run it in a terminal with ${context.invocation} workflow start ${description.name} --driver local.`, next: null } };
  }
  const started = await context.client.start(description.name, { ...(call.inputs !== undefined ? { inputs: call.inputs } : {}), checkout: context.cwd });
  if ('error' in started) return startRefused(context, description.name, started.error);
  const run = RunIdSchema.safeParse(started.data.run);
  if (!run.success) return { error: { code: 'run_unreadable', message: 'The new run id was missing', next: null } };
  const state: SkillState = {
    version: 1, run: run.data, driver: driverIdentity('skill', context.cwd), invocation: context.invocation, options: { parallel: effect.parallel },
    orchestrator: { ...(context.session !== undefined ? { session: context.session } : {}), lastCallAt: context.now().toISOString() },
    attempts: [], seq: 0, events: [], seen: {}, settled: [],
  };
  const saved = await context.locks.take(run.data, (lock) => writeSkillState(context.config, lock, state, context.env.secrets), 0);
  if (saved !== undefined) return { error: { ...saved.error, next: null } };
  return foreground(context, run.data, { kind: 'next' });
}
