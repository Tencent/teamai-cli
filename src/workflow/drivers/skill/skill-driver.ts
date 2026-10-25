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
import { HOST_CHOICES, SKILL_CAN, type HostChoice } from './host-profiles.js';
import { describeLiteral, invocationOf, type Invocation } from './literals.js';
import { askFor, checkStartAnswers, localReason, neededAnswers, type HitlMode } from './preflight.js';
import { writeSkillState, type SkillState } from './skill-state.js';
import { detachedRunners, runRunner } from './skill-runner.js';
import { agentReport, ceilingOf, errorOf, foreground, poll, startRefused, take } from './tick.js';
import type { DescribeVerdict, RowId } from './transitions.js';
import type { SkillAnswer, SkillError } from './turn.js';

export type SkillCall =
  | { kind: 'describe'; name: string }
  /** `judge: false`: `--no-judge`, which leaves the scored steps unjudged here. `hitl`: `--hitl`, or `--auto-approve`. */
  | { kind: 'start'; name: string; answers: { parallel?: number; confirmed: boolean; hitl?: HitlMode; judge?: false }; inputs: unknown }
  | { kind: 'next'; run: RunId; wait: boolean }
  /** `next --takeover`: this session drives the run from now on, as the person agreed. */
  | { kind: 'takeover'; run: RunId }
  /** `next --choice`: the agent's answer to the host question. */
  | { kind: 'choose'; run: RunId; choice: HostChoice }
  /** `next --ack dispatch.<a>`: the child of attempt `a` started. */
  | { kind: 'ack'; run: RunId; attempt: AttemptId }
  /** `respond --driver skill`: the agent's answer to an optional gate. */
  | { kind: 'respond'; run: RunId; step: string; pass: number; choice: string }
  /** The runner's call carries the attempt's marker: the runner reports itself. */
  | { kind: 'report'; run: RunId; attempt: AttemptId; role: 'runner' }
  | { kind: 'report'; run: RunId; attempt: AttemptId; role: 'agent'; modelUnavailable: boolean };

/** Where the runner of an attempt starts. */
export interface RunnerJob {
  run: RunId;
  attempt: AttemptId;
  checkout: string;
}

/** A step's command as its runner started it. */
export interface CommandRun {
  /** Settles once the command exited and closed its output. `output` is stdout and stderr as they came, unmasked. */
  exit: Promise<{ exitCode: number; stdout: string; stderr: string; output: string }>;
  /** Stops the command and every process it started, and settles once they are gone. A second call changes nothing. */
  stop(): Promise<Awaited<CommandRun['exit']>>;
}

/** How runners start, how a tick tells one is alive, how a runner runs its command, and how a call waits. */
export interface Runners {
  spawn(job: RunnerJob): Promise<void>;
  alive(run: RunId, attempt: AttemptId): Promise<boolean>;
  /** Starts the command of `attempt`, and records what it started where `stopLeft` finds it. */
  command(input: { run: RunId; attempt: AttemptId; command: string; cwd: string; env: NodeJS.ProcessEnv }): CommandRun;
  /** Stops what the last setup or command of `attempt` left running when its runner died with it. */
  stopLeft(run: RunId, attempt: AttemptId): Promise<void>;
  /** Waits `ms`, or until `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
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
  judge: z.boolean().optional(),
  inputs: z.string().optional(),
  hitl: z.enum(['person', 'recommend'], { errorMap: () => ({ message: '--hitl takes person or recommend, as the describe reply offered' }) }).optional(),
  autoApprove: z.boolean().optional(),
  tools: z.undefined({ invalid_type_error: '--tools is for --driver local' }),
}).refine((options) => !(options.hitl !== undefined && options.autoApprove), {
  message: '--hitl and --auto-approve answer the same question: pass one of them, as the describe reply offered',
});
const OFFER = /^dispatch\.(.+)$/;
const NextOptionsSchema = z.object({
  wait: z.boolean().optional(),
  takeover: z.boolean().optional(),
  choice: z.enum(HOST_CHOICES, { errorMap: () => ({ message: `--choice takes the id of a host question option: ${HOST_CHOICES.join(', ')}` }) }).optional(),
  ack: z.string().transform((offer, ctx) => {
    const attempt = AttemptIdSchema.safeParse(OFFER.exec(offer)?.[1]);
    if (attempt.success) return attempt.data;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `--ack takes the offer of a dispatch action, such as dispatch.a1b2c3d4e; got ${offer}` });
    return z.NEVER;
  }).optional(),
  json: z.undefined({ invalid_type_error: '--driver skill takes no --json: the skill driver composes every request itself' }),
  prepare: z.undefined({ invalid_type_error: '--prepare is for --json drivers' }),
  attempt: z.undefined({ invalid_type_error: '--attempt is for --json drivers, with --prepare' }),
  adopt: z.undefined({ invalid_type_error: '--adopt is for --json drivers, with --prepare --attempt' }),
}).refine((options) => [options.wait, options.takeover, options.choice, options.ack].filter((given) => given !== undefined && given !== false).length <= 1, {
  message: 'next takes at most one of --wait, --takeover, --choice and --ack',
});
const RespondOptionsSchema = z.object({
  pass: z.string({ required_error: '--driver skill needs --pass, as the choose action printed it' }).regex(/^[1-9][0-9]*$/, '--pass takes the pass the choose action printed').transform(Number),
  note: z.undefined({ invalid_type_error: '--driver skill takes no --note' }),
  json: z.undefined({ invalid_type_error: '--driver skill takes no --json: the skill driver composes every request itself' }),
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
  raw:
    | { kind: 'start'; name: string; options: unknown }
    | { kind: 'next' | 'report'; run: string; options: unknown }
    | { kind: 'respond'; run: string; step: string; choice: string; options: unknown },
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
    const { parallel, confirmed, judge, autoApprove } = options.data;
    const hitl: HitlMode | undefined = autoApprove ? 'auto-approve' : options.data.hitl;
    return {
      kind: 'start', name: raw.name, inputs,
      answers: { ...(parallel !== undefined ? { parallel } : {}), confirmed: confirmed === true, ...(hitl !== undefined ? { hitl } : {}), ...(judge === false ? { judge } : {}) },
    };
  }
  const run = RunIdSchema.safeParse(raw.run);
  if (!run.success) return invalid(run.error);
  if (raw.kind === 'next') {
    const options = NextOptionsSchema.safeParse(raw.options);
    if (!options.success) return invalid(options.error);
    const { choice, ack, wait, takeover } = options.data;
    if (takeover) return { kind: 'takeover', run: run.data };
    if (choice !== undefined) return { kind: 'choose', run: run.data, choice };
    if (ack !== undefined) return { kind: 'ack', run: run.data, attempt: ack };
    return { kind: 'next', run: run.data, wait: wait === true };
  }
  if (raw.kind === 'respond') {
    const options = RespondOptionsSchema.safeParse(raw.options);
    if (!options.success) return invalid(options.error);
    return { kind: 'respond', run: run.data, step: raw.step, pass: options.data.pass, choice: raw.choice };
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
    case 'takeover':
      return foreground(context, call.run, { kind: 'takeover' });
    case 'choose':
      return foreground(context, call.run, { kind: 'choose', choice: call.choice });
    case 'ack':
      return foreground(context, call.run, { kind: 'ack', attempt: call.attempt });
    case 'respond':
      return foreground(context, call.run, { kind: 'respond', step: call.step, pass: call.pass, choice: call.choice });
    case 'report':
      if (call.role === 'runner') return runRunner(context, call.run, call.attempt);
      return agentReport(context, call.run, call);
    default: {
      const unhandled: never = call;
      return unhandled;
    }
  }
}

async function start(call: Extract<SkillCall, { kind: 'describe' | 'start' }>, context: SkillContext): Promise<SkillAnswer> {
  const ceiling = ceilingOf(context.config);
  const described = await context.client.describe(call.name, { ceiling, can: SKILL_CAN, ...(context.tool !== undefined ? { tool: context.tool } : {}) });
  if ('error' in described) return { error: { ...described.error, next: null } };
  const { description, judging } = described;
  const local = localReason(description);
  const why = local !== undefined ? { local } : {};
  if (call.kind === 'describe') {
    const taken = take(context, undefined, { kind: 'describe', needed: neededAnswers(description), ...why, judgingHere: judging.kind === 'here' });
    const verdict: DescribeVerdict = taken?.answer?.kind === 'describe' ? taken.answer : { kind: 'describe', ask: 'start' };
    return { data: { describe: { workflow: description, judging, ask: askFor(verdict, description, context.invocation, judging) } } };
  }
  const check = checkStartAnswers({ description, answers: call.answers, inputs: call.inputs, ceiling });
  const judge = judging.kind === 'here' && call.answers.judge !== false ? judging.tool : undefined;
  const taken = take(context, undefined, { kind: 'start', name: description.name, check, ...why, prompts: description.facts.prompts.length > 0, ...(judge !== undefined ? { judge } : {}) });
  const effect = taken?.effects.find((planned) => planned.kind === 'start');
  if (taken?.answer?.kind === 'error') return { error: errorOf(taken.answer, { invocation: context.invocation, same: describeLiteral(context.invocation, description.name) }) };
  if (!effect || effect.kind !== 'start') return { error: { code: 'run_unreadable', message: `The skill driver took no start row for ${description.name}.`, next: null } };
  const started = await context.client.start(description.name, { ...(call.inputs !== undefined ? { inputs: call.inputs } : {}), checkout: context.cwd });
  if ('error' in started) return startRefused(context, description.name, started.error);
  const run = RunIdSchema.safeParse(started.data.run);
  if (!run.success) return { error: { code: 'run_unreadable', message: 'The new run id was missing', next: null } };
  const state: SkillState = {
    version: 1, run: run.data, driver: driverIdentity('skill', context.cwd), invocation: context.invocation, options: { parallel: effect.parallel, hitl: effect.hitl }, host: { kind: effect.host },
    orchestrator: { ...(context.session !== undefined ? { session: context.session } : {}), lastCallAt: context.now().toISOString() },
    attempts: [], ...(effect.judge !== undefined ? { judging: { tool: effect.judge } } : {}), seq: 0, events: [], seen: {}, settled: [],
  };
  const saved = await context.locks.take(run.data, (lock) => writeSkillState(context.config, lock, state, context.env.secrets), 0);
  if (saved !== undefined) return { error: { ...saved.error, next: null } };
  return foreground(context, run.data, { kind: 'next' });
}
