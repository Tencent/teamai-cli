/**
 * The skill driver: a coding session drives a run through `workflow start|next|report --driver skill`, running only
 * the literals each reply prints, while detached runners run its command steps. This module is its entry.
 */
import { z } from 'zod';
import { resolveCliEntry } from '../../../builtin-hooks.js';
import { driverIdentity } from '../../../driver-identity.js';
import type { WorkflowEnv } from '../../../env-resolution.js';
import type { ToolName } from '../../../resources/agent-format.js';
import { isAgentToolId } from '../../../tools.js';
import type { LocalConfig } from '../../../types.js';
import { agentSessionFromEnv } from '../../../utils/session-id.js';
import { isAttemptRunner } from '../../attempt-marker.js';
import { inProcessClient, type WorkflowClient } from '../../protocol.js';
import { AttemptIdSchema, RunIdSchema, withRunLock, type AttemptId, type RunId, type RunLock } from '../../store.js';
import { HOST_CHOICES, type HostChoice } from './host-profiles.js';
import { describeLiteral, invocationOf, type Invocation } from './literals.js';
import { askFor, checkStartAnswers, localOnlySteps, neededAnswers } from './preflight.js';
import { writeSkillState, type SkillState } from './skill-state.js';
import { detachedRunners, runRunner } from './skill-runner.js';
import { ceilingOf, errorOf, foreground, poll, startRefused, take } from './tick.js';
import type { RowId } from './transitions.js';
import type { SkillAnswer, SkillError } from './turn.js';

export type SkillCall =
  | { kind: 'describe'; name: string }
  | { kind: 'start'; name: string; answers: { parallel?: number; confirmed: boolean }; inputs: unknown }
  | { kind: 'next'; run: RunId; wait: boolean }
  /** `next --choice`: the agent's answer to the host question. */
  | { kind: 'choose'; run: RunId; choice: HostChoice }
  /** `next --ack dispatch.<a>`: the child of attempt `a` started. */
  | { kind: 'ack'; run: RunId; attempt: AttemptId }
  /** The runner's call carries the attempt's marker: the runner reports itself. */
  | { kind: 'report'; run: RunId; attempt: AttemptId; role: 'runner' }
  | { kind: 'report'; run: RunId; attempt: AttemptId; role: 'agent'; modelUnavailable: boolean };

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
  /** The tool of that session, which a child's model is resolved for; undefined when its host names none. */
  tool: ToolName | undefined;
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
  const session = await agentSessionFromEnv();
  return {
    ...input,
    session: session.id,
    tool: session.agent !== undefined && isAgentToolId(session.agent) ? session.agent : undefined,
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
const OFFER = /^dispatch\.(.+)$/;
const NextOptionsSchema = z.object({
  wait: z.boolean().optional(),
  choice: z.enum(HOST_CHOICES, { errorMap: () => ({ message: `--choice takes the id of a host question option: ${HOST_CHOICES.join(', ')}` }) }).optional(),
  ack: z.string().transform((offer, ctx) => {
    const attempt = AttemptIdSchema.safeParse(OFFER.exec(offer)?.[1]);
    if (attempt.success) return attempt.data;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `--ack takes the offer of a dispatch action, such as dispatch.a1b2c3d4e; got ${offer}` });
    return z.NEVER;
  }).optional(),
  json: z.undefined({ invalid_type_error: '--driver skill takes no --json: the skill driver composes every request itself' }),
  prepare: z.undefined({ invalid_type_error: '--prepare is for --json drivers' }),
}).refine((options) => [options.wait, options.choice, options.ack].filter((given) => given !== undefined && given !== false).length <= 1, {
  message: 'next takes at most one of --wait, --choice and --ack',
});
const ReportOptionsSchema = z.object({
  attempt: AttemptIdSchema,
  modelUnavailable: z.boolean().optional(),
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
    if (!options.success) return invalid(options.error);
    const { choice, ack, wait } = options.data;
    if (choice !== undefined) return { kind: 'choose', run: run.data, choice };
    if (ack !== undefined) return { kind: 'ack', run: run.data, attempt: ack };
    return { kind: 'next', run: run.data, wait: wait === true };
  }
  const options = ReportOptionsSchema.safeParse(raw.options);
  if (!options.success) return invalid(options.error);
  const { attempt, modelUnavailable } = options.data;
  if (isAttemptRunner(env, run.data, attempt)) return { kind: 'report', run: run.data, attempt, role: 'runner' };
  return { kind: 'report', run: run.data, attempt, role: 'agent', modelUnavailable: modelUnavailable === true };
}

export async function runSkillCall(call: SkillCall, context: SkillContext): Promise<SkillAnswer> {
  switch (call.kind) {
    case 'describe':
    case 'start':
      return start(call, context);
    case 'next':
      return call.wait ? poll(context, call.run) : foreground(context, call.run, { kind: 'next' });
    case 'choose':
      return foreground(context, call.run, { kind: 'choose', choice: call.choice });
    case 'ack':
      return foreground(context, call.run, { kind: 'ack', attempt: call.attempt });
    case 'report':
      if (call.role === 'runner') return runRunner(context, call.run, call.attempt);
      return foreground(context, call.run, { kind: 'report', attempt: call.attempt, modelUnavailable: call.modelUnavailable });
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
  const taken = take(context, undefined, { kind: 'start', name: description.name, check, localOnly, prompts: description.facts.prompts.length > 0 });
  const effect = taken?.effects.find((planned) => planned.kind === 'start');
  if (taken?.answer?.kind === 'error') return { error: errorOf(taken.answer, { invocation: context.invocation, same: describeLiteral(context.invocation, description.name) }) };
  if (!effect || effect.kind !== 'start') return { error: { code: 'run_unreadable', message: `The skill driver took no start row for ${description.name}.`, next: null } };
  const started = await context.client.start(description.name, { ...(call.inputs !== undefined ? { inputs: call.inputs } : {}), checkout: context.cwd });
  if ('error' in started) return startRefused(context, description.name, started.error);
  const run = RunIdSchema.safeParse(started.data.run);
  if (!run.success) return { error: { code: 'run_unreadable', message: 'The new run id was missing', next: null } };
  const state: SkillState = {
    version: 1, run: run.data, driver: driverIdentity('skill', context.cwd), invocation: context.invocation, options: { parallel: effect.parallel }, host: { kind: effect.host },
    orchestrator: { ...(context.session !== undefined ? { session: context.session } : {}), lastCallAt: context.now().toISOString() },
    attempts: [], seq: 0, events: [], seen: {}, settled: [],
  };
  const saved = await context.locks.take(run.data, (lock) => writeSkillState(context.config, lock, state, context.env.secrets), 0);
  if (saved !== undefined) return { error: { ...saved.error, next: null } };
  return foreground(context, run.data, { kind: 'next' });
}
