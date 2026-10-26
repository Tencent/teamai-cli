/**
 * The skill driver: a coding session drives a run through `workflow start|next|report --driver skill`, running only
 * the literals each reply prints, while detached runners run its command steps. This module is its entry.
 */
import path from 'node:path';
import { z } from 'zod';
import { resolveCliEntry } from '../../../builtin-hooks.js';
import type { WorkflowEnv } from '../../../env-resolution.js';
import type { ToolName } from '../../../resources/agent-format.js';
import { resolveRunMode, type RunMode } from '../../../launch-context.js';
import type { CommandExit } from '../../../tool-launch/process-stop.js';
import { isAgentToolId } from '../../../tools.js';
import type { LocalConfig, TeamaiConfig } from '../../../types.js';
import { agentSessionFromEnv } from '../../../utils/session-id.js';
import { agentEvidence, isAttemptRunner, type AgentEvidence } from '../../attempt-marker.js';
import { inProcessClient, invokeDeniedMessage, type WorkflowClient } from '../../protocol.js';
import type { WorkflowFailure } from '../../types.js';
import { AttemptIdSchema, RunIdSchema, takeRunLock, type AttemptId, type LockTaken, type RunId, type RunLock } from '../../store.js';
import { canFor, HOST_CHOICES, type HostChoice } from './host-profiles.js';
import { journalCall } from './journal.js';
import { describeLiteral, invocationOf, type Invocation } from './literals.js';
import { askFor, attendedReason, ceilingOf, checkStartAnswers, localPromptTool, localReason, neededAnswers, type HitlMode } from './preflight.js';
import { drivesRun, readSkillState, writeSkillState } from './skill-state.js';
import { detachedRunners, runRunner } from './skill-runner.js';
import { agentReport, foreground, plannedState, poll } from './tick.js';
import { describeRow, startRow, type ResumeAnswers, type RowId } from './transitions.js';
import { errorOf, type SkillAnswer, type SkillError } from './turn.js';

export type SkillCall =
  | { kind: 'describe'; name: string }
  /** `judge: false`: `--no-judge`, which leaves the scored steps unjudged here. `hitl`: `--hitl`, or `--auto-approve`. */
  | { kind: 'start'; name: string; answers: { parallel?: number; confirmed: boolean; hitl?: HitlMode; judge?: false }; inputs: unknown }
  /**
   * `resume --driver skill`: this session drives a run another machine published; `claim` takes it from another install.
   * `confirmed`: `--confirmed`, the agent's word that the person agreed to continue a run of an `invoke: ask` workflow.
   */
  | { kind: 'resume'; run: RunId; claim: boolean; confirmed: boolean; answers: ResumeAnswers }
  | { kind: 'next'; run: RunId; wait: boolean }
  /** `next --takeover`: this session drives the run from now on, as the person agreed; `confirmed` as a resume's. */
  | { kind: 'takeover'; run: RunId; confirmed: boolean }
  /** `next --choice`: the agent's answer to the host question. */
  | { kind: 'choose'; run: RunId; choice: HostChoice }
  /** `next --ack dispatch.<a>`: the child of attempt `a` started. */
  | { kind: 'ack'; run: RunId; attempt: AttemptId }
  /** `next --attempt <a> --adopt <dir>`: the host made `dir`, an absolute path, for the place attempt `a` asked for. */
  | { kind: 'adopt'; run: RunId; attempt: AttemptId; dir: string }
  /** `respond --driver skill`: the agent's answer to an optional gate. */
  | { kind: 'respond'; run: RunId; step: string; pass: number; choice: string }
  /** The runner's call carries the attempt's marker: the runner reports itself. */
  | { kind: 'report'; run: RunId; attempt: AttemptId; role: 'runner' }
  | { kind: 'report'; run: RunId; attempt: AttemptId; role: 'agent'; modelUnavailable: boolean };

/** Where the runner of an attempt starts, and the run mode it runs in. */
export interface RunnerJob {
  run: RunId;
  attempt: AttemptId;
  checkout: string;
  mode: RunMode;
}

/** A step's command as its runner started it. */
export interface CommandRun {
  /** Settles once the command exited and closed its output. `output` is stdout and stderr as they came, unmasked. */
  exit: Promise<CommandExit>;
  /** Stops the command and every process it started, and settles once they are gone. A second call changes nothing. */
  stop(): Promise<CommandExit>;
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
  /** The team's `toolPaths` in `config`'s scope: where `teamai pull` deployed the agents a step names. */
  toolPaths: TeamaiConfig['toolPaths'] | undefined;
  env: WorkflowEnv;
  client: WorkflowClient;
  /** The calling agent session, undefined when its host names none. */
  session: string | undefined;
  /** What says an agent runs the calling process, which a start of the workflow is checked against: its `invoke`. */
  evidence: AgentEvidence;
  /** The run mode of the calling process, which describe answers for and a start keeps for the run. */
  mode: RunMode;
  /** The tool of that session, which a child's model is resolved for; undefined when its host names none. */
  tool: ToolName | undefined;
  invocation: Invocation;
  /** The checkout a start runs from. */
  cwd: string;
  now: () => Date;
  runners: Runners;
  locks: { take<T>(run: RunId, body: (lock: RunLock) => Promise<T>, waitMs: number): Promise<LockTaken<T>> };
  /** Gets the id of every transition row a call takes. */
  trace?: (row: RowId) => void;
}

/**
 * The context of a call from this process: its agent session, how the member ran teamai, the in-process protocol,
 * detached runners, and the real clock.
 */
export async function skillContext(input: Pick<SkillContext, 'config' | 'toolPaths' | 'env' | 'cwd' | 'trace'>): Promise<SkillContext> {
  const { config, env } = input;
  const session = await agentSessionFromEnv();
  const evidence = agentEvidence(process.env);
  return {
    ...input,
    session: session.id,
    // Only a coding agent drives --driver skill, so a host that sets no session variable is still an agent's.
    evidence: evidence.kind === 'none' ? { kind: 'skill-driver' } : evidence,
    mode: resolveRunMode(process.env),
    tool: session.agent !== undefined && isAgentToolId(session.agent) ? session.agent : undefined,
    invocation: invocationOf(resolveCliEntry() ?? undefined),
    client: inProcessClient({ config, env }),
    now: () => new Date(),
    runners: detachedRunners(config),
    locks: { take: (run, body, waitMs) => takeRunLock(config, run, body, { waitMs }) },
  };
}

/**
 * Whether the agent session of this process drives run `run` with the skill driver on this install, as its skill.json
 * records: that session passed the run's `invoke` check when it started or took the run.
 */
export async function sessionDrivesRun(config: LocalConfig, run: RunId): Promise<boolean> {
  const read = await readSkillState(config, run);
  return drivesRun(read.kind === 'found' ? read.state : undefined, (await agentSessionFromEnv()).id);
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The options of a run that a skill start and a skill resume share. */
const RunOptionsSchema = z.object({
  parallel: z.string().regex(/^[1-9][0-9]*$/, '--parallel takes a whole number of steps, 1 or more').transform(Number).optional(),
  judge: z.boolean().optional(),
  hitl: z.enum(['person', 'recommend'], { errorMap: () => ({ message: '--hitl takes person or recommend, as the describe reply offered' }) }).optional(),
  autoApprove: z.boolean().optional(),
  tools: z.undefined({ invalid_type_error: '--tools is for --driver local' }),
});
const ONE_HITL = {
  check: (options: z.infer<typeof RunOptionsSchema>) => !(options.hitl !== undefined && options.autoApprove),
  message: '--hitl and --auto-approve answer the same question: pass one of them, as the describe reply offered',
};
const StartOptionsSchema = RunOptionsSchema.extend({
  describe: z.boolean().optional(),
  confirmed: z.boolean().optional(),
  inputs: z.string().optional(),
}).refine(ONE_HITL.check, { message: ONE_HITL.message });
const ResumeOptionsSchema = RunOptionsSchema.extend({ claim: z.boolean().optional(), confirmed: z.boolean().optional() }).refine(ONE_HITL.check, { message: ONE_HITL.message });
const OFFER = /^dispatch\.(.+)$/;
const NextOptionsSchema = z.object({
  wait: z.boolean().optional(),
  takeover: z.boolean().optional(),
  confirmed: z.boolean().optional(),
  choice: z.enum(HOST_CHOICES, { errorMap: () => ({ message: `--choice takes the id of a host question option: ${HOST_CHOICES.join(', ')}` }) }).optional(),
  ack: z.string().transform((offer, ctx) => {
    const attempt = AttemptIdSchema.safeParse(OFFER.exec(offer)?.[1]);
    if (attempt.success) return attempt.data;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `--ack takes the offer of a dispatch action, such as dispatch.a1b2c3d4e; got ${offer}` });
    return z.NEVER;
  }).optional(),
  attempt: AttemptIdSchema.optional(),
  adopt: z.string().min(1, '--adopt takes the directory the host made').optional(),
  json: z.undefined({ invalid_type_error: '--driver skill takes no --json: the skill driver composes every request itself' }),
  prepare: z.undefined({ invalid_type_error: '--prepare is for --json drivers' }),
}).refine((options) => (options.attempt === undefined) === (options.adopt === undefined), {
  message: '--driver skill takes --attempt and --adopt together, as the adopt of a place action prints them',
}).refine((options) => [options.wait, options.takeover, options.choice, options.ack, options.adopt].filter((given) => given !== undefined && given !== false).length <= 1, {
  message: 'next takes at most one of --wait, --takeover, --choice, --ack and --adopt',
}).refine((options) => !options.confirmed || options.takeover === true, {
  message: 'next takes --confirmed only with --takeover, as a confirm_needed answer prints it',
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

/** The JSON object `workflow start --inputs` carries, with either driver. */
export function parseInputsFlag(raw: string): { inputs: unknown } | { error: WorkflowFailure } {
  try {
    return { inputs: JSON.parse(raw) as unknown };
  } catch {
    return { error: { code: 'invalid_json', message: 'Could not parse --inputs as JSON' } };
  }
}

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
    | { kind: 'next' | 'resume' | 'report'; run: string; options: unknown }
    | { kind: 'respond'; run: string; step: string; choice: string; options: unknown },
  env: NodeJS.ProcessEnv,
): SkillCall | { error: SkillError } {
  if (raw.kind === 'start') {
    if (!NAME.test(raw.name)) return { error: { code: 'invalid_arguments', message: `"${raw.name}" is not a workflow name`, next: null } };
    const options = StartOptionsSchema.safeParse(raw.options);
    if (!options.success) return invalid(options.error);
    if (options.data.describe) return { kind: 'describe', name: raw.name };
    const read = options.data.inputs === undefined ? { inputs: undefined } : parseInputsFlag(options.data.inputs);
    if ('error' in read) return { error: { ...read.error, next: null } };
    const { inputs } = read;
    const { parallel, confirmed, judge, autoApprove } = options.data;
    const hitl: HitlMode | undefined = autoApprove ? 'auto-approve' : options.data.hitl;
    return {
      kind: 'start', name: raw.name, inputs,
      answers: { ...(parallel !== undefined ? { parallel } : {}), confirmed: confirmed === true, ...(hitl !== undefined ? { hitl } : {}), ...(judge === false ? { judge } : {}) },
    };
  }
  const run = RunIdSchema.safeParse(raw.run);
  if (!run.success) return invalid(run.error);
  if (raw.kind === 'resume') {
    const options = ResumeOptionsSchema.safeParse(raw.options);
    if (!options.success) return invalid(options.error);
    const { claim, confirmed, parallel, judge, autoApprove } = options.data;
    const hitl: HitlMode | undefined = autoApprove ? 'auto-approve' : options.data.hitl;
    return {
      kind: 'resume', run: run.data, claim: claim === true, confirmed: confirmed === true,
      answers: { ...(parallel !== undefined ? { parallel } : {}), ...(hitl !== undefined ? { hitl } : {}), ...(judge === false ? { judge } : {}) },
    };
  }
  if (raw.kind === 'next') {
    const options = NextOptionsSchema.safeParse(raw.options);
    if (!options.success) return invalid(options.error);
    const { choice, ack, wait, takeover, confirmed, attempt, adopt } = options.data;
    if (takeover) return { kind: 'takeover', run: run.data, confirmed: confirmed === true };
    if (choice !== undefined) return { kind: 'choose', run: run.data, choice };
    if (ack !== undefined) return { kind: 'ack', run: run.data, attempt: ack };
    if (attempt !== undefined && adopt !== undefined) return { kind: 'adopt', run: run.data, attempt, dir: path.resolve(adopt) };
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

/**
 * Answers `call` with one envelope, and journals it. An error thrown inside an agent's call answers `skill_call_failed`
 * with its message, as the agent reads only the envelope. A runner's own call answers nobody, so its error goes on up: the
 * runner is gone, which the next tick finds.
 */
export async function runSkillCall(call: SkillCall, context: SkillContext): Promise<SkillAnswer> {
  let answer: SkillAnswer;
  try {
    answer = await answerOf(call, context);
  } catch (error) {
    if (call.kind === 'report' && call.role === 'runner') throw error;
    answer = { error: { code: 'skill_call_failed', message: error instanceof Error ? error.message : String(error), next: null } };
  }
  await journalCall(context, call, answer);
  return answer;
}

async function answerOf(call: SkillCall, context: SkillContext): Promise<SkillAnswer> {
  switch (call.kind) {
    case 'describe':
    case 'start':
      return start(call, context);
    case 'resume': {
      const ceiling = ceilingOf(context.config);
      if (call.answers.parallel !== undefined && call.answers.parallel > ceiling) {
        return { error: { code: 'invalid_arguments', message: `--parallel ${call.answers.parallel} is above the most this machine runs at once, ${ceiling}.`, next: null } };
      }
      return foreground(context, call.run, { kind: 'resume', claim: call.claim, confirmed: call.confirmed, answers: call.answers });
    }
    case 'next':
      return call.wait ? poll(context, call.run) : foreground(context, call.run, { kind: 'next' });
    case 'takeover':
      return foreground(context, call.run, { kind: 'takeover', confirmed: call.confirmed });
    case 'choose':
      return foreground(context, call.run, { kind: 'choose', choice: call.choice });
    case 'ack':
      return foreground(context, call.run, { kind: 'ack', attempt: call.attempt });
    case 'adopt':
      return foreground(context, call.run, { kind: 'adopt', attempt: call.attempt, dir: call.dir });
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

/** The refusals of a protocol start that another answer to describe fixes: other inputs, or the person's yes. */
const ANSWERABLE_START_REFUSALS: ReadonlySet<string> = new Set(['invalid_inputs', 'confirm_needed']);

async function start(call: Extract<SkillCall, { kind: 'describe' | 'start' }>, context: SkillContext): Promise<SkillAnswer> {
  const ceiling = ceilingOf(context.config);
  const described = await context.client.describe(call.name, { ceiling, can: canFor(undefined), checkout: context.cwd, ...(context.tool !== undefined ? { tool: context.tool } : {}) });
  if ('error' in described) return { error: { ...described.error, next: null } };
  const { description, judging, undeliverable } = described;
  const local = localReason(description);
  const why = local !== undefined ? { local } : {};
  if (call.kind === 'describe') {
    const denied = description.invoke === 'deny' && context.evidence.kind !== 'none' ? { denied: invokeDeniedMessage(description.name, context.evidence, { kind: 'start' }) } : {};
    const attended = attendedReason(description, 'start');
    const { row, verdict } = describeRow({
      needed: neededAnswers(description), ...denied, ...(undeliverable ? { undeliverable: undeliverable.message } : {}), ...why, judgingHere: judging.kind === 'here',
      mode: context.mode, ...(attended !== undefined ? { attended } : {}),
    });
    context.trace?.(row);
    return { data: { describe: { workflow: description, judging, ask: askFor(verdict, description, context.invocation, judging, { tool: localPromptTool(context.config, context.tool) }) } } };
  }
  const check = checkStartAnswers({ description, answers: call.answers, inputs: call.inputs, ceiling });
  const judge = judging.kind === 'here' && call.answers.judge !== false ? judging.tool : undefined;
  const attended = context.mode === 'unattended' ? attendedReason(description, 'start') : undefined;
  const taken = startRow({ name: description.name, check, ...why, ...(attended !== undefined ? { attended } : {}), prompts: description.facts.prompts.length > 0, ...(judge !== undefined ? { judge } : {}) });
  context.trace?.(taken.row);
  if (taken.row === 'R25') return { error: { ...taken.error, next: null } };
  if (taken.row !== 'R10') {
    const same = describeLiteral(context.invocation, description.name);
    return { error: errorOf({ kind: 'error', refusal: taken.refusal }, { invocation: context.invocation, same, localTool: localPromptTool(context.config, context.tool) }) };
  }
  const planned = taken.start;
  const started = await context.client.start(description.name, {
    ...(call.inputs !== undefined ? { inputs: call.inputs } : {}), checkout: context.cwd, caller: { evidence: context.evidence, confirmed: call.answers.confirmed, mode: context.mode },
  });
  if ('error' in started) {
    // No literal for a refusal no other answer fixes: a new describe would only lead back to it.
    return { error: { ...started.error, next: ANSWERABLE_START_REFUSALS.has(started.error.code) ? describeLiteral(context.invocation, description.name) : null } };
  }
  const run = RunIdSchema.safeParse(started.data.run);
  if (!run.success) return { error: { code: 'run_unreadable', message: 'The new run id was missing', next: null } };
  const state = plannedState(context, run.data, planned);
  const saved = await context.locks.take(run.data, (lock) => writeSkillState(context.config, lock, state, context.env.secrets), 0);
  switch (saved.kind) {
    case 'held':
      return foreground(context, run.data, { kind: 'next' });
    case 'busy':
      return { error: { ...saved.error, next: null } };
    default: {
      const unhandled: never = saved;
      return unhandled;
    }
  }
}
