/**
 * The skill driver: a coding session drives a run through `workflow start|next|report --driver skill`, running only
 * the literals each reply prints, while detached runners run its command steps. This module is its entry.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { resolveCliEntry } from '../../../builtin-hooks.js';
import type { WorkflowEnv } from '../../../env-resolution.js';
import { resolveRunMode, type RunMode } from '../../../launch-context.js';
import type { GroupedCommandExit } from '../../shell-command.js';
import { isToolId, TOOL_ORDER, toolInstancesFor, toolOf } from '../../../tool-registry.js';
import type { LocalConfig, TeamaiConfig } from '../../../types.js';
import { agentSessionFromEnv } from '../../../utils/session-id.js';
import { WorkflowOffers } from '../../../workflow-offers.js';
import { agentEvidence, isAttemptRunner, type AgentEvidence } from '../../attempt-marker.js';
import { inProcessClient, invokeDeniedMessage, type ResumeClaim, type WorkflowClient } from '../../protocol.js';
import type { SessionApp } from '../../session-apps.js';
import type { WorkflowFailure } from '../../types.js';
import { AttemptIdSchema, RunIdSchema, runnerAlive, runsDir, takeRunLock, type AttemptId, type LockTaken, type RunId, type RunLock } from '../../store.js';
import { canFor, SESSION_HOST_CHOICES, sessionOffers, type SessionHostChoice } from './session-host-profiles.js';
import { journalCall } from './journal.js';
import { describeLiteral, invocationOf, type Invocation } from './literals.js';
import { askFor, attendedReason, ceilingOf, checkStartAnswers, localPromptTool, localReason, neededAnswers, needsTool, type HitlMode } from './preflight.js';
import { needsAiTool } from '../../describe.js';
import { drivesRun, readSkillState, writeSkillState, type AttemptState } from './skill-state.js';
import { detachedRunners, runRunner } from './skill-runner.js';
import { agentReport, foreground, plannedState, poll, WAIT_GRACE_MS } from './tick.js';
import { APP_CHECKED_ROWS, describeRow, judgedBy, startRow, type DescribeInput, type ResumeAnswers, type RowId } from './transitions.js';
import { errorOf, type SkillAnswer, type SkillError } from './turn.js';

// What the runs offered on teamai-reports are judged by outside this driver, as a resume through it judges them.
export { canFor } from './session-host-profiles.js';

export { ceilingOf, isLeft, listOf, localReason, personClauses } from './preflight.js';

/** `tool`: `--tools default=<tool>`, the tool of the calling session, which its session host may not name. */
export type SkillCall =
  | { kind: 'describe'; name: string; tool?: string }
  /**
   * `judge: false`: `--no-judge`, which leaves the scored steps unjudged here. `hitl`: `--hitl`, or `--auto-approve`.
   * `timeoutMs`: `--timeout`, which bounds the run as the workflow's own timeout does.
   */
  | { kind: 'start'; name: string; answers: { parallel?: number; confirmed: boolean; hitl?: HitlMode; judge?: false }; inputs: unknown; tool?: string; timeoutMs?: number }
  /**
   * `resume --driver skill`: this session drives a run another machine published; `claim` which runs it takes from
   * teamai-reports, `any` with `--claim`, `offered` for the run `--next` picked. `confirmed`: `--confirmed`, the agent's
   * word that the person agreed to continue a run of an `invoke: ask` workflow.
   */
  | { kind: 'resume'; run: RunId; claim: ResumeClaim; confirmed: boolean; answers: ResumeAnswers; tool?: string }
  | { kind: 'next'; run: RunId; wait: boolean }
  /** `next --takeover`: this session drives the run from now on, as the person agreed; `confirmed` as a resume's. */
  | { kind: 'takeover'; run: RunId; confirmed: boolean }
  /** `next --choice`: the agent's answer to the session host question. */
  | { kind: 'choose'; run: RunId; choice: SessionHostChoice }
  /** `next --ack dispatch.<a>`: the child of attempt `a` started. */
  | { kind: 'ack'; run: RunId; attempt: AttemptId }
  /** `next --attempt <a> --adopt <dir>`: the session host made `dir`, an absolute path, for the place attempt `a` asked for. */
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
  exit: Promise<GroupedCommandExit>;
  /** Stops the command and every process it started, and settles once they are gone. A second call changes nothing. */
  stop(): Promise<GroupedCommandExit>;
}

/** How runners start, how a tick tells one is alive, how a runner runs its command, and how a call waits. */
export interface Runners {
  spawn(job: RunnerJob): Promise<void>;
  alive(run: RunId, attempt: AttemptId): Promise<boolean>;
  /** Starts the command of `attempt`, and records what it started where `stopLeft` finds it. */
  command(input: { run: RunId; attempt: AttemptId; command: string; cwd: string; env: NodeJS.ProcessEnv }): CommandRun;
  /**
   * Stops what the last setup, command or judge of `attempt` left running when its runner died with it, then ends the
   * login that judge held.
   */
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
  /** The calling agent session, undefined when its session host names none. */
  session: string | undefined;
  /** What says an agent runs the calling process, which a start of the workflow is checked against: its `invoke`. */
  evidence: AgentEvidence;
  /** The run mode of the calling process, which describe answers for and a start keeps for the run. */
  mode: RunMode;
  /**
   * The app the calling session runs in, undefined outside one, with whether a run could start on its driver now, which
   * describe asks before it offers that start: its runtimes open as for an unattended run, so none asks for a sign-in.
   */
  app: { session: SessionApp; canStart(): Promise<boolean> } | undefined;
  /** The tool of that session, which a child's model is resolved for; undefined when its session host names none. */
  tool: string | undefined;
  /** The tools the member names for `config`'s scope, the most specific first: TEAMAI_AI_TOOL, then `ai.tool`. */
  aiTools: readonly string[];
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
export async function skillContext(input: Pick<SkillContext, 'config' | 'toolPaths' | 'env' | 'cwd' | 'aiTools' | 'trace'> & { app?: SkillContext['app'] }): Promise<SkillContext> {
  const { config, env } = input;
  const session = await agentSessionFromEnv();
  const evidence = agentEvidence(process.env);

  return {
    ...input,
    app: input.app,
    session: session.id,
    // Only a coding agent drives --driver skill, so a session host that sets no session variable is still an agent's.
    evidence: evidence.kind === 'none' ? { kind: 'skill-driver' } : evidence,
    mode: resolveRunMode(process.env),
    tool: session.agent !== undefined && isToolId(session.agent) ? session.agent : undefined,
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

/** Whether the runner of `open` was spawned within `WAIT_GRACE_MS`, so it may not hold its runner.lock yet (C10). */
function isRunnerStarting(open: AttemptState): boolean {
  return (open.phase === 'preparing' || open.phase === 'running') && Date.now() - Date.parse(open.spawnedAt) <= WAIT_GRACE_MS;
}

/**
 * Whether a skill runner holds `attempt` of run `run` on this machine: it runs (its runner.lock), or a start or C10
 * spawned it within `WAIT_GRACE_MS` and it may not have taken that lock yet. Such an attempt is that runner's to stop.
 */
export async function isSkillRunnerHolding(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<boolean> {
  const read = await readSkillState(config, run);
  const open = read.kind === 'found' ? read.state.attempts.find((held) => held.attempt === attempt) : undefined;

  return (open !== undefined && isRunnerStarting(open)) || runnerAlive(config, run, attempt);
}

/**
 * Runs `body` while no driver of run `run` runs a step on this machine, or answers `busy` with `driver_running`: it holds
 * the run's driver.lock, which a local driver holds for its whole drive and every skill driver tick takes, and finds no
 * skill runner of the run alive (its runner.lock) nor spawned within `WAIT_GRACE_MS`, as C10 counts one still starting.
 * Every spawn happens under driver.lock, so no runner starts while `body` runs.
 */
export async function whileNoDriverHere<T>(config: LocalConfig, run: RunId, body: (lock: RunLock) => Promise<T>): Promise<LockTaken<T>> {
  const taken = await takeRunLock(config, run, async (lock): Promise<{ kind: 'ran'; value: T } | { kind: 'runner'; step: string; attempt: AttemptId }> => {
    const read = await readSkillState(config, run);

    for (const open of read.kind === 'found' ? read.state.attempts : []) {
      if (isRunnerStarting(open) || await runnerAlive(config, run, open.attempt)) return { kind: 'runner', step: open.step, attempt: open.attempt };
    }

    return { kind: 'ran', value: await body(lock) };
  }, { waitMs: 0 });

  if (taken.kind === 'busy') return taken;

  if (taken.value.kind === 'ran') return { kind: 'held', value: taken.value.value };
  const { step, attempt } = taken.value;

  return { kind: 'busy', error: { code: 'driver_running', message: `Step "${step}" of run ${run} runs on this machine, in the skill driver's runner of attempt ${attempt}. Wait until the skill driver reports it, then try again; if its coding session has ended, the runner stops an hour after that session last called.` } };
}

/** Whether agent session `session` drives, with the skill driver, a run of `config`'s scope whose skill.json records no end yet. */
export async function drivesUndoneRun(config: LocalConfig, session: string): Promise<boolean> {
  const runs = (await fs.readdir(runsDir(config)).catch(() => [])).flatMap((name) => {
    const run = RunIdSchema.safeParse(name);

    return run.success ? [run.data] : [];
  });

  const states = await Promise.all(runs.map((run) => readSkillState(config, run)));

  return states.some((read) => read.kind === 'found' && read.state.done === undefined && drivesRun(read.state, session));
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `--tools default=<tool>`: the tool this coding session works in, for a session host that sets no session variable teamai reads. */
const SessionToolSchema = z.string().transform((tools, ctx) => {
  const [pair = '', ...more] = tools.split(',');
  const separator = pair.indexOf('=');
  const tool = pair.slice(separator + 1).trim();

  if (more.length > 0 || pair.slice(0, separator).trim() !== 'default' || tool === '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--driver skill takes only --tools default=<tool>, the tool this coding session works in' });

    return z.NEVER;
  }

  // A tool instance is known only once the scope's config is read, so `answerOf` checks the name.
  if (!NAME.test(tool)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: unknownToolMessage(tool) });

    return z.NEVER;
  }

  return tool;
});

/** Why `--tools default=<tool>` is refused: it names neither a tool teamai ships nor an instance this scope defines. */
function unknownToolMessage(tool: string): string {
  return `--tools default=${tool} names no tool teamai knows: ${[...TOOL_ORDER, ...toolInstancesFor('use').flatMap(({ kind, name }) => kind === 'instance' ? [name] : [])].join(', ')}`;
}

/** The options of a run that a skill start and a skill resume share. */
const RunOptionsSchema = z.object({
  parallel: z.string().regex(/^[1-9][0-9]*$/, '--parallel takes a whole number of steps, 1 or more').transform(Number).optional(),
  judge: z.boolean().optional(),
  hitl: z.enum(['person', 'recommend'], { error: '--hitl takes person or recommend, as the describe reply offered' }).optional(),
  autoApprove: z.boolean().optional(),
  tools: SessionToolSchema.optional(),
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

const ResumeOptionsSchema = RunOptionsSchema.extend({ claim: z.boolean().optional(), next: z.boolean().optional(), confirmed: z.boolean().optional() })
  .refine(ONE_HITL.check, { message: ONE_HITL.message });

const OFFER = /^dispatch\.(.+)$/;

const NextOptionsSchema = z.object({
  wait: z.boolean().optional(),
  takeover: z.boolean().optional(),
  confirmed: z.boolean().optional(),
  choice: z.enum(SESSION_HOST_CHOICES, { error: `--choice takes the id of a session host question option: ${SESSION_HOST_CHOICES.join(', ')}` }).optional(),
  ack: z.string().transform((offer, ctx) => {
    const attempt = AttemptIdSchema.safeParse(OFFER.exec(offer)?.[1]);

    if (attempt.success) return attempt.data;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `--ack takes the offer of a dispatch action, such as dispatch.a1b2c3d4e; got ${offer}` });

    return z.NEVER;
  }).optional(),
  attempt: AttemptIdSchema.optional(),
  adopt: z.string().min(1, '--adopt takes the directory the session host made').optional(),
  json: z.undefined({ error: '--driver skill takes no --json: the skill driver composes every request itself' }).optional(),
  prepare: z.undefined({ error: '--prepare is for --json drivers' }).optional(),
}).refine((options) => (options.attempt === undefined) === (options.adopt === undefined), {
  message: '--driver skill takes --attempt and --adopt together, as the adopt of a place action prints them',
}).refine((options) => [options.wait, options.takeover, options.choice, options.ack, options.adopt].filter((given) => given !== undefined && given !== false).length <= 1, {
  message: 'next takes at most one of --wait, --takeover, --choice, --ack and --adopt',
}).refine((options) => !options.confirmed || options.takeover === true, {
  message: 'next takes --confirmed only with --takeover, as a confirm_needed answer prints it',
});

const RespondOptionsSchema = z.object({
  pass: z.string({ error: (issue) => issue.input === undefined ? '--driver skill needs --pass, as the choose action printed it' : undefined }).regex(/^[1-9][0-9]*$/, '--pass takes the pass the choose action printed').transform(Number),
  note: z.undefined({ error: '--driver skill takes no --note' }).optional(),
  json: z.undefined({ error: '--driver skill takes no --json: the skill driver composes every request itself' }).optional(),
});

const ReportOptionsSchema = z.object({
  attempt: AttemptIdSchema,
  modelUnavailable: z.boolean().optional(),
  json: z.undefined({ error: '--driver skill takes no --json: the skill driver composes every report itself' }).optional(),
});

/** The JSON object `workflow start --inputs` carries, with either driver. */
export function parseInputsFlag(raw: string): { inputs: unknown } | { error: WorkflowFailure } {
  try {
    const inputs: unknown = JSON.parse(raw);

    return { inputs };
  } catch {
    return { error: { code: 'invalid_json', message: 'Could not parse --inputs as JSON' } };
  }
}

/** A command line the skill driver refuses before it runs anything. */
type Refused = { error: SkillError };

function invalid(error: z.ZodError): Refused {
  return { error: { code: 'invalid_arguments', message: error.issues[0]?.message ?? 'invalid options', next: null } };
}

/** `--hitl person` in an unattended run: each optional gate would wait for a person nobody is there to be. */
const NOBODY_ANSWERS: SkillError = {
  code: 'invalid_arguments',
  message: '--hitl person leaves the optional gates to a person, and this run is unattended (TEAMAI_MODE or CI says so), so nobody would answer them. Pass --auto-approve or --hitl recommend, or set TEAMAI_MODE=attended where a person attends.',
  next: null,
};

/** The HITL mode `options` answer optional gates with, unless nobody would answer them in an unattended run. */
function hitlOf(options: { hitl?: 'person' | 'recommend'; autoApprove?: boolean }, env: NodeJS.ProcessEnv): { hitl?: HitlMode } | { error: SkillError } {
  const hitl: HitlMode | undefined = options.autoApprove ? 'auto-approve' : options.hitl;

  if (hitl === 'person' && resolveRunMode(env) === 'unattended') return { error: NOBODY_ANSWERS };

  return hitl !== undefined ? { hitl } : {};
}

/** The resume a `--driver skill` command line asks for, apart from its run, which `resume --next` checks before it picks one. */
// oxlint-disable-next-line teamai/no-unknown-parameters -- the parse boundary: the command's options as the CLI parser read them
export function parseSkillResume(options: unknown, env: NodeJS.ProcessEnv): Omit<Extract<SkillCall, { kind: 'resume' }>, 'kind' | 'run'> | { error: SkillError } {
  const parsed = ResumeOptionsSchema.safeParse(options);

  if (!parsed.success) return invalid(parsed.error);
  const { claim, next, confirmed, parallel, judge, tools } = parsed.data;
  const hitl = hitlOf(parsed.data, env);

  if ('error' in hitl) return hitl;

  const answers: ResumeAnswers = {};

  if (parallel !== undefined) answers.parallel = parallel;

  if (hitl.hitl !== undefined) answers.hitl = hitl.hitl;

  if (judge === false) answers.judge = judge;
  const resume: Omit<Extract<SkillCall, { kind: 'resume' }>, 'kind' | 'run'> = { claim: next ? 'offered' : claim ? 'any' : 'lacking', confirmed: confirmed === true, answers };

  if (tools !== undefined) resume.tool = tools;

  return resume;
}

/**
 * Reads a `--driver skill` command line into a call. `env` tells a runner, which carries its attempt's marker, from
 * an agent.
 */
export function parseSkillCall(
  raw:
    | { kind: 'start'; name: string; options: unknown; timeoutMs?: number }
    | { kind: 'next' | 'resume' | 'report'; run: string; options: unknown }
    | { kind: 'respond'; run: string; step: string; choice: string; options: unknown },
  env: NodeJS.ProcessEnv,
): SkillCall | { error: SkillError } {
  if (raw.kind === 'start') {
    if (!NAME.test(raw.name)) return { error: { code: 'invalid_arguments', message: `"${raw.name}" is not a workflow name`, next: null } };
    const options = StartOptionsSchema.safeParse(raw.options);

    if (!options.success) return invalid(options.error);
    const tool = options.data.tools !== undefined ? { tool: options.data.tools } : {};

    if (options.data.describe) return { kind: 'describe', name: raw.name, ...tool };
    const read = options.data.inputs === undefined ? { inputs: undefined } : parseInputsFlag(options.data.inputs);

    if ('error' in read) return { error: { ...read.error, next: null } };
    const { inputs } = read;
    const { parallel, confirmed, judge } = options.data;
    const hitl = hitlOf(options.data, env);

    if ('error' in hitl) return hitl;

    const answers: Extract<SkillCall, { kind: 'start' }>['answers'] = { confirmed: confirmed === true };

    if (parallel !== undefined) answers.parallel = parallel;

    if (hitl.hitl !== undefined) answers.hitl = hitl.hitl;

    if (judge === false) answers.judge = judge;

    const call: Extract<SkillCall, { kind: 'start' }> = { kind: 'start', name: raw.name, inputs, ...tool, answers };

    if (raw.timeoutMs !== undefined) call.timeoutMs = raw.timeoutMs;

    return call;
  }

  const run = RunIdSchema.safeParse(raw.run);

  if (!run.success) return invalid(run.error);

  if (raw.kind === 'resume') {
    const resume = parseSkillResume(raw.options, env);

    return 'error' in resume ? resume : { kind: 'resume', run: run.data, ...resume };
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

async function answerOf(call: SkillCall, caller: SkillContext): Promise<SkillAnswer> {
  // The tool a session declares is the one it works in, whatever its session host names, as a session host may pass its env on to another tool.
  const context = 'tool' in call && call.tool !== undefined ? { ...caller, tool: call.tool } : caller;

  if ('tool' in call && call.tool !== undefined && toolOf(call.tool) === undefined) {
    return { error: { code: 'invalid_arguments', message: unknownToolMessage(call.tool), next: null } };
  }

  switch (call.kind) {
    case 'describe':
    case 'start':
      return start(call, context);
    case 'resume': {
      const ceiling = ceilingOf(context.config);

      if (call.answers.parallel !== undefined && call.answers.parallel > ceiling) {
        return { error: { code: 'invalid_arguments', message: `--parallel ${call.answers.parallel} is above the most this machine runs at once, ${ceiling}.`, next: null } };
      }

      return foreground(context, call.run, { kind: 'resume', claim: call.claim, confirmed: call.confirmed, answers: call.answers, tool: call.tool });
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
  const described = await context.client.describe(call.name, { ceiling, can: { ...canFor(undefined), confined: await sessionOffers(context.tool) }, checkout: context.cwd, tool: context.tool });

  if ('error' in described) return { error: { ...described.error, next: null } };
  const { description, judging, undeliverable } = described;
  const local = localReason(description);
  const why = local !== undefined ? { local } : {};
  const { app } = context;
  const from = app && { place: app.session.terminal, driver: app.session.driver };
  const denied = description.invoke === 'deny' && context.evidence.kind !== 'none' ? { denied: invokeDeniedMessage(description.name, context.evidence, { kind: 'start', ...(from && { from }) }) } : {};

  if (call.kind === 'describe') {
    const attended = attendedReason(description, 'start');

    const input: DescribeInput = {
      needed: neededAnswers(description), ...denied, undeliverable: undeliverable?.message, ...why, judged: judgedBy(judging) !== undefined,
      mode: context.mode, attended, needsTool: needsTool(description, { tool: context.tool, judged: true }), isAiFree: !needsAiTool(description.facts),
      ...(app && { app: { session: app.session, readiness: 'unchecked' } }),
    };

    const unchecked = describeRow(input);
    // Whether a run could start on the app's driver is asked only where the answer would change: never for a run that
    // already goes to the built-in host in the background.
    const isChecked = app !== undefined && context.mode === 'attended' && unchecked.verdict.ask !== 'background' && APP_CHECKED_ROWS.has(unchecked.row);
    const { row, verdict } = isChecked ? describeRow({ ...input, app: { session: app.session, readiness: await app.canStart() ? 'ready' : 'not-ready' } }) : unchecked;

    context.trace?.(row);
    const caller = { session: context.session, tool: call.tool ?? context.tool };
    const proposed = await WorkflowOffers.proposals(context.config, description, { ...caller, cwd: context.cwd });

    return { data: { describe: { workflow: description, judging, ask: askFor(verdict, description, context.invocation, judging, { local: localPromptTool(context), session: call.tool }, proposed) } } };
  }

  const check = checkStartAnswers({ description, answers: call.answers, inputs: call.inputs, ceiling, tool: context.tool });
  const judge = call.answers.judge !== false ? judgedBy(judging) : undefined;
  const attended = context.mode === 'unattended' ? attendedReason(description, 'start') : undefined;
  const taken = startRow({ name: description.name, check, ...denied, ...why, attended, prompts: description.facts.prompts.length > 0, judge });
  context.trace?.(taken.row);

  if ('error' in taken) return { error: { ...taken.error, next: null } };
  const same = describeLiteral(context.invocation, description.name, { tool: call.tool });

  if (taken.row !== 'R10') return { error: errorOf({ kind: 'error', refusal: taken.refusal }, { invocation: context.invocation, same, localTool: localPromptTool(context) }) };
  const planned = taken.start;

  const started = await context.client.start(description.name, {
    inputs: call.inputs, checkout: context.cwd, caller: { evidence: context.evidence, confirmed: call.answers.confirmed, mode: context.mode },
    timeout: call.timeoutMs, startedBy: 'person',
  });

  if ('error' in started) {
    // No literal for a refusal no other answer fixes: a new describe would only lead back to it.
    return { error: { ...started.error, next: ANSWERABLE_START_REFUSALS.has(started.error.code) ? same : null } };
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
