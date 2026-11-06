import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { toolExtrasFor, type AgentSpec } from '../../../resources/agent-format.js';
import { observeLaunch, type ToolLaunch, type Used } from '../../../agent-observation.js';
import { detectProjectConfig } from '../../../config.js';
import { driverIdentity } from '../../../driver-identity.js';
import { commandSignalPolicy, exitLike, stepEnvironment, terminalReachesCommand, withRunningCli } from '../../../env-exec.js';
import { knownSecrets, resolveWorkflowEnv, type WorkflowEnv } from '../../../env-resolution.js';
import { resolveRunMode, workflowLaunch, type RunMode } from '../../../launch-context.js';
import type { LocalConfig, TeamaiConfig } from '../../../types.js';
import { log, PROGRESS_STREAMS_ENV, streamOfLine, withoutStreamMarks } from '../../../utils/logger.js';
import { redact } from '../../../utils/redact.js';
import { AgentSession } from '../../../session-flow/agent-session.js';
import { openSessionArchive, type SessionArchive } from '../../../session-flow/archive.js';
import { deliveredTeamSkills, usedSkills } from '../../../skill-use.js';
import { attemptEnv } from '../../attempt-marker.js';
import { leaseNext, type PersonHandoff, type ReportInput } from '../../engine.js';
import { offeredToPerson, offerToPerson, reconcileTakenCopies } from '../../handoff.js';
import { LeaseWireSchema, type LeaseWire } from '../../lease-wire.js';
import { setsLimit, type DriverCan, type Missing } from '../../requirements.js';
import { callerProvenance, respondProvenance, respondToHitl, type ResponseInput } from '../../run-controls.js';
import { isRecord } from '../../expression.js';
import { budgeted } from '../../limits.js';
import { resolveCliPath } from '../../../utils/cli-path.js';
import {
  createLocalToolAdapter,
  type LocalToolAdapter,
  type LocalToolResult,
  type LocalToolRun,
} from './local-tool-adapter.js';
import { attemptDir, AttemptIdSchema, attemptResultPath, attemptsDir, readRun, RunIdSchema, updateRun, withRunLock, type RunId, type RunLock } from '../../store.js';
import { abandonPlace, cloneDelivery, cloneHead, placeLeaseOf, placeOf, placeRoot, preparedClone, preparePlace, cloneRoleProblem, refuseDirtyAdoptedCommand, roleNotDeliveredFailure, runPlaceSetup, sweepClones, worktreeRoleProblem, type StepEnd } from '../../place/place.js';
import { commandEnd, managedReport, StartedRunSchema, unreadablePlace, type StartedRun } from '../../protocol.js';
import { memberTools, type MemberTool } from '../../../tool-launch/member-tools.js';
import { startGroupedCommand, stopRecordedGroup, type CommandExit, type GroupedCommand } from '../../../tool-launch/process-stop.js';
import { executableOf, isLaunchTool, LAUNCH_ORDER, LAUNCH_TOOLS, launchAdapterIdOf, type LaunchTool } from '../../../tool-launch/tools.js';
import { confinedOffers, type ConfinedOffer } from '../../../tool-launch/confined.js';
import { AttemptResult } from '../../attempt-result.js';
import { runConfinedStep } from '../../confined-step.js';
import { runAnswerStep } from './answer-step.js';
import { chooseStepModel, loadDeployedAgent, type StepModel } from '../../step-model.js';
import type { DriveOptions, DriverIdentity, RunState, StepHitl, WorkflowEnvelope, WorkflowFailure, WorkflowStep } from '../../types.js';
import { isWorkflowError, stepWorkflow, WORKSPACE_MODES } from '../../types.js';
import { confinedOf, contractClone, type SessionRef } from '../../workspace.js';
import { git, headCommit } from '../../worktree.js';

/** The signals that stop teamai, which the driver passes on to what it runs before it exits. */
export const STOP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGHUP'];

/** How long the driver waits for a command or prompt before asking the run again; half that while a question is open. */
let pollMs = 2000;

/** Shorten the driver's poll (for testing only). */
export function _setDriverPollMs(ms: number): void {
  pollMs = ms;
}

/** What a leased command came to: it ran, staging failed, or it was stopped or its lease ended before it could start. */
type StagedResult = { kind: 'ran'; result: CommandExit } | { kind: 'unstaged'; failure: WorkflowFailure } | { kind: 'stopped' };

interface StagedCommand {
  exit: Promise<StagedResult>;
  /** Aborts staging and setup, or stops the command once it runs. Settles once the attempt is over; a second call changes nothing. */
  stop(): Promise<StagedResult>;
}

/** Whether a staged lease may start its command or tool: nothing stopped it, and its deadline has not passed. */
function startable(lease: Lease, signal: AbortSignal): boolean {
  return !signal.aborted && (lease.expiresAt === undefined || Date.now() < Date.parse(lease.expiresAt));
}

/**
 * Stages a leased command, then starts it, as one attempt, so the driver keeps asking the run what to do while staging
 * and setup run, and a cancel reaches either phase.
 */
function stageThenStart(lease: Lease, stage: (signal: AbortSignal) => Promise<WorkflowFailure | undefined>, start: () => GroupedCommand): StagedCommand {
  const controller = new AbortController();
  let command: GroupedCommand | undefined;

  const exit = (async (): Promise<StagedResult> => {
    const failure = await stage(controller.signal);

    if (!startable(lease, controller.signal)) return { kind: 'stopped' };

    if (failure) return { kind: 'unstaged', failure };
    command = start();

    return { kind: 'ran', result: await command.exit };
  })();

  return { exit, stop: async () => {
    controller.abort();
    await command?.stop();

    return exit;
  } };
}

/** A rendered HITL request and the exact pass and response command presented by the engine. */
export interface LocalHitl extends StepHitl {
  /** The run that owns the question. */
  run: string;
  /** The waiting step's full path. */
  step: string;
  /** The pass the answer will apply to. */
  pass: number;
  /** The engine's literal CLI response template. */
  respond: string;
}

/** A HITL request as the engine's `next` sends it. A `default` that is not text counts as none. */
const HitlRequestSchema = z.object({
  run: z.string(), step: z.string(), pass: z.number(), respond: z.string(), kind: z.enum(['approve', 'choose']), message: z.string(), required: z.boolean(),
  options: z.array(z.string()), default: z.string().optional().catch(undefined),
});

/** What the engine's `next` says the driver waits for. */
/** What a step held for strict isolation misses, as `wait.held` names it. */
const ISOLATION = 'isolation' satisfies Missing;
const HITL = 'hitl' satisfies Missing;

const WaitReplySchema = z.object({
  delivering: z.array(z.unknown()).optional().catch(undefined),
  reason: z.string().optional().catch(undefined),
  held: z.array(z.object({ step: z.string(), reason: z.string(), missing: z.array(z.string()) })).optional().catch(undefined),
}).catch({});

/** What the driver says once it handed run `runId` to a person at `steps`, and the command that person runs. */
function handedToPerson(runId: string, steps: readonly string[]): WorkflowEnvelope {
  const resume = `teamai workflow resume ${runId} --claim`;
  log.info(offeredToPerson(runId, steps, resume));

  return { data: { handoff: { run: runId, steps: [...steps], resume } } };
}

/** Whether every step `next` held from this driver waits for a confined tool here that reaches its level or resolves its model. */
function heldForConfined(held: ReadonlyArray<{ missing: readonly string[] }> | undefined): held is ReadonlyArray<{ reason: string; missing: string[] }> {
  return held !== undefined && held.length > 0 && held.every(({ missing }) => missing.includes('confined') || missing.includes('model'));
}

async function askHitl(hitl: LocalHitl, signal: AbortSignal): Promise<string> {
  process.stderr.write(`Step "${hitl.step}": ${hitl.message}\nOptions: ${hitl.options.join(', ')}\n${hitl.respond}\n`);
  const terminal = createInterface({ input: process.stdin, output: process.stderr });

  try {
    return await terminal.question('Choice, followed by an optional note: ', { signal });
  } finally {
    terminal.close();
  }
}

/** Local tool selection and terminal behavior for one driver invocation. */
export interface LocalDriverOptions {
  /** Overrides auto approval for this run without changing member config; the run remembers it on this install. */
  autoApprove?: boolean;
  /** Declares whether a person can answer HITL requests and work in foreground tools. */
  hitl?: boolean;
  /** Declares this host a sandbox for this run, as `workflows.sandbox` does for every process; the run remembers it on this install. */
  sandbox?: boolean;
  /** The terminal question implementation, injectable for callers without readline. */
  question?: (hitl: LocalHitl, signal: AbortSignal) => Promise<string>;
  tools?: Record<string, string>;
  /** The team's `toolPaths`, as teamai.yaml states them. */
  toolPaths?: TeamaiConfig['toolPaths'];
  adapter?: LocalToolAdapter;
  /** Where the tools a step confined to a directory runs on are looked up: PATH unless given. */
  resolveTool?: (executable: string) => string | null;
  /** Called with the runs each report the engine took answers its settled passes started, which the caller drives. */
  started?: (runs: readonly StartedRun[]) => void;
  /**
   * Shown each line a command step writes to stderr as it writes it, masked, with the stream the command meant it for:
   * what a shortcut of the run shows live.
   */
  progress?: (line: string, stream: 'stdout' | 'stderr') => void;
}

/** A lease as this driver runs it: what the engine sent, and what staging it adds. A step staged after `expiresAt` does not start. */
interface Lease extends LeaseWire {
  /** The lease named a workspace this driver cannot read. The step fails instead of running in the active checkout. */
  unreadableWorkspace?: true;
  /** The environment the step's command or tool runs with, built from `envScope` when the lease is staged. */
  processEnv?: NodeJS.ProcessEnv;
  /** Set once the step has a directory to run in. */
  cwd?: string;
}

/** Masks the result file of every attempt of the run, so one that ended without a report, on a signal too, keeps no secret. */
async function maskAttemptFiles(config: LocalConfig, run: RunId, secrets: Record<string, string>): Promise<void> {
  const listed = await fs.readdir(attemptsDir(config, run)).catch(() => []);

  const attempts = listed.flatMap((name) => {
    const attempt = AttemptIdSchema.safeParse(name);

    return attempt.success ? [attempt.data] : [];
  });

  await Promise.all(attempts.map((attempt) => AttemptResult.mask(attemptResultPath(config, run, attempt), secrets)));
}

function supportedTool(value: string): value is LaunchTool {
  return isLaunchTool(value);
}

/**
 * The tool a prompt step runs on: the step's own `tool`, then `--tools`, then `workflows.tools`, the agent's entry before
 * the default, with the member's own AI tool between them: TEAMAI_AI_TOOL before `workflows.tools.default`, and
 * `ai.tool`, the project's before the machine's, after it. A member's tool that teamai does not launch fails the step;
 * one that runs no workflow step gives way to the next rung, which `warnings` says.
 */
function stepTool({ agent, tool }: Pick<WorkflowStep, 'agent' | 'tool'>, config: LocalConfig, flags: Record<string, string>, members: MemberTool[]): { ok: true; tool: string | undefined; warnings: string[] } | { ok: false; failure: WorkflowFailure } {
  const configured = config.workflows?.tools ?? {};
  const member = ({ setting, tool: named }: MemberTool) => ({ source: setting, named, member: true });

  const rungs = [
    { source: 'tool', named: tool, member: false },
    { source: '--tools', named: agent ? flags[agent] : undefined, member: false },
    { source: `workflows.tools.${agent}`, named: agent ? configured[agent] : undefined, member: false },
    { source: '--tools', named: flags.default, member: false },
    ...members.flatMap((memberTool) => (memberTool.source === 'TEAMAI_AI_TOOL' ? [member(memberTool)] : [])),
    { source: 'workflows.tools.default', named: configured.default, member: false },
    ...members.flatMap((memberTool) => (memberTool.source !== 'TEAMAI_AI_TOOL' ? [member(memberTool)] : [])),
  ];

  const passed: { source: string; named: string }[] = [];

  for (const { source, named, member: isMember } of rungs) {
    if (!named) continue;

    if (isMember && !isLaunchTool(named)) {
      if (!LAUNCH_ORDER.some((launched) => launched === named)) {
        return { ok: false, failure: { code: 'tool_unsupported', message: `${source} is "${named}", which is not a tool teamai launches. Set it to one of: ${LAUNCH_TOOLS.join(', ')}.` } };
      }

      passed.push({ source, named });
      continue;
    }

    return { ok: true, tool: named, warnings: passed.map((skipped) => `${skipped.source} is "${skipped.named}", which cannot run a workflow step. Using ${source} (${named}) instead.`) };
  }

  return { ok: true, tool: undefined, warnings: passed.map((skipped) => `${skipped.source} is "${skipped.named}", which cannot run a workflow step.`) };
}

/** The tool a prompt step launches here, with the warnings its pick logs, or why it launches none. */
type LaunchChoice = { ok: true; tool: LaunchTool; warnings: string[] } | { ok: false; failure: WorkflowFailure; tool?: string; warnings: string[] };

/**
 * The tool teamai launches for prompt step `step` here, as {@link stepTool} picks it with `--tools` `flags`, or why
 * none: no tool is configured, or the one picked is not one teamai launches, which `tool` then names. `warnings` says
 * which of the member's tools gave way, for the step that launches to log.
 */
export function launchToolFor(step: Pick<WorkflowStep, 'agent' | 'tool'>, config: LocalConfig, flags: Record<string, string>, members: MemberTool[]): LaunchChoice {
  const choice = stepTool(step, config, flags, members);

  if (!choice.ok) return { ...choice, warnings: [] };
  const { tool: selected, warnings } = choice;

  if (!selected) return { ok: false, failure: { code: 'tool_unconfigured', message: 'No local workflow tool is configured for this prompt step' }, warnings };

  if (!supportedTool(selected)) return { ok: false, failure: { code: 'tool_unsupported', message: `The local workflow tool "${selected}" is not supported` }, tool: selected, warnings };

  return { ok: true, tool: selected, warnings };
}

function ignoredCodexSettings(agent: AgentSpec): string[] {
  const extras = Object.keys(agent.tool_extras?.codex ?? {});

  return agent.tools?.length ? ['tools', ...extras] : extras;
}

function definitionRun(tool: LaunchTool, name: string, agent: AgentSpec): NonNullable<LocalToolRun['agent']> {
  const settings = launchAdapterIdOf(tool) === 'opencode' ? toolExtrasFor(agent, 'opencode') : undefined;

  const run: NonNullable<LocalToolRun['agent']> = { name, instructions: agent.instructions };

  if (agent.model) run.model = agent.model;

  if (settings) run.settings = settings;

  return run;
}

/** The model a launch passes on argv, and its effort. */
type LaunchModel = { model: string; effort?: string };

/** The fields of a report that say the attempt failed, and why. */
type FailedReport = { outcome: 'failed'; message: string; failure: WorkflowFailure };

function failureReport(failure: WorkflowFailure): FailedReport {
  return { outcome: 'failed', message: failure.message, failure };
}

type ReportBody = ReportInput;

/**
 * A lease as this driver runs it. A lease whose workspace alone it cannot read, which reads as a lease without it, is
 * kept, marked, so its step fails instead of running in the active checkout.
 */
const LocalLeaseSchema = LeaseWireSchema.or(z.preprocess((raw) => (isRecord(raw) ? { ...raw, workspace: undefined } : raw), LeaseWireSchema)
  .transform((lease): Lease => ({ ...lease, unreadableWorkspace: true })));

/**
 * Gets the lease a place to run under `root`, with the team env resolved for it. `signal` stops setup, which
 * then fails, and the workspace it was preparing is removed. A prompt step's place is prepared for `launches`, the tool
 * `promptReport` launches there, when the lease names none.
 */
async function stageLease(lease: Lease, { config, lock, root, env, mode, signal, launches }: {
  config: LocalConfig;
  lock: RunLock;
  root: string;
  env: WorkflowEnv;
  mode: RunMode;
  signal?: AbortSignal;
  launches?: string;
}): Promise<WorkflowFailure | undefined> {
  if (lease.unreadableWorkspace) return unreadablePlace(lock.run);
  // A lease is handed back to a driver after one of this run was killed: the setup or command that one left running
  // in the attempt's place is stopped before the attempt is staged again.
  await stopRecordedGroup(attemptDir(config, lock.run, lease.attempt));

  if (lease.envScope) {
    const scoped = await stepEnvironment(env, lease.envScope);

    if (!scoped.ok) return scoped.failure;
    lease.processEnv = scoped.env;
  } else {
    lease.processEnv = withRunningCli(process.env);
  }

  const placeLease = placeLeaseOf(lease);

  if (lease.tool === undefined && launches !== undefined) placeLease.tool = launches;
  const prepared = await preparePlace({ config, lock, root, lease: placeLease });

  if (prepared.kind !== 'prepared') return prepared.failure;
  lease.cwd = prepared.dir;

  if (prepared.prompt !== undefined) lease.prompt = prepared.prompt;

  return runPlaceSetup({ config, run: lock.run, attempt: lease.attempt, mode, env, signal });
}

/**
 * The session the step's tool resumes, and the lease session it continues: the lease's session, else each earlier one it
 * continued, newest first. Each is tried on this machine, then as a copy in this tool, then as a copy of the one the team
 * session archive holds. OpenCode has no flag to resume one, so its step starts a new session.
 */
async function resumeSession(archive: SessionArchive, lease: Lease, tool: LaunchTool, cwd: string): Promise<{ id: string; resumed: SessionRef } | undefined> {
  const to = AgentSession.platformForTool(tool);

  if (!lease.session || !to) return undefined;
  const resumes = launchAdapterIdOf(tool) !== 'opencode';
  const misses: string[] = [];

  for (const session of [lease.session, ...(lease.session.earlier ?? [])]) {
    if (!supportedTool(session.tool)) continue;
    const from = AgentSession.platformForTool(session.tool);

    if (!from) continue;
    const resumed = { tool: session.tool, id: session.id };

    if (launchAdapterIdOf(session.tool) === launchAdapterIdOf(tool) && resumes) {
      const found = await AgentSession.find({ platform: from, sessionId: session.id }, { scrub: false });

      if (found.status === 'done') return { id: session.id, resumed };
      misses.push(found.failure.message);
    } else {
      const copied = await AgentSession.copy({ from: { platform: from, sessionId: session.id }, to: { platform: to, cwd } });

      if (copied.status === 'done') return resumes ? { id: copied.sessionId, resumed } : undefined;
      misses.push(copied.failure.message);
    }

    const restored = await archive.restore({ platform: from, sessionId: session.id }, { platform: to, cwd });

    if (restored.status !== 'fresh') return resumes ? { id: restored.sessionId, resumed } : undefined;
    misses.push(restored.reason);
  }

  if (misses.length > 0) log.warn(`Step "${lease.step}" starts a new ${tool} session: ${misses.join(' ')}`);

  return undefined;
}

async function commandReport(config: LocalConfig, lock: RunLock, driver: DriverIdentity, lease: Lease, exited: CommandExit, secrets: Record<string, string>): Promise<ReportBody> {
  const result = { ...exited, stderr: withoutStreamMarks(exited.stderr) };
  const end = commandEnd(result);
  await AttemptResult.write(attemptResultPath(config, lock.run, lease.attempt), end.outputs !== undefined ? { output: end.outputs } : {}, secrets);
  // What a command says as it runs goes to its stderr, so its stdout stays the step's outputs.
  const progress = result.stderr.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => masked(line, secrets));
  const body: ReportBody = { attempt: lease.attempt, revision: lease.revision, driver, ...end };

  if (progress.length > 0) body.progress = progress;

  return body;
}

function masked(line: string, secrets: Record<string, string>): string {
  return redact(line, { envSecrets: secrets, patterns: false });
}

/** Writes that call `show` with each whole line of the chunks given, and with what is left once `end` is called. */
function lineSplitter(show: (line: string) => void) {
  let rest = '';
  const each = (line: string): void => { if (line.trim() !== '') show(line); };

  return {
    write: (chunk: string): void => {
      const lines = `${rest}${chunk}`.split(/\r?\n/);
      rest = lines.pop() ?? '';
      lines.forEach(each);
    },
    end: (): void => { each(rest); rest = ''; },
  };
}

/**
 * The team skills the pass's session and its subagents loaded since `launchedAt`, credited by `teamSkills`, what its
 * checkout held as delivered at launch. A load before it, by a pass whose session this one resumes, is that pass's.
 * Undefined when the session cannot be read.
 */
async function usedInSession(tool: LaunchTool, sessionId: string, cwd: string, teamSkills: Record<string, string[]>, launchedAt: number): Promise<Used | undefined> {
  const platform = AgentSession.platformForTool(tool);

  if (!platform) return undefined;
  const found = await AgentSession.find({ platform, sessionId, cwd }, { subagents: true }).catch(() => undefined);
  const atOrAfterLaunch = (timestamp: string | undefined): boolean => timestamp === undefined || !(Date.parse(timestamp) < launchedAt);

  return found?.status === 'done'
    ? { skills: usedSkills(AgentSession.toolForPlatform(platform), found, (timestamp) => atOrAfterLaunch(timestamp) ? teamSkills : {}) }
    : undefined;
}

async function promptReport(
  config: LocalConfig,
  lock: RunLock,
  driver: DriverIdentity,
  lease: Lease,
  adapter: LocalToolAdapter,
  options: LocalDriverOptions,
  archive: SessionArchive,
  signal: AbortSignal,
  mode: RunMode,
  staged: LaunchChoice | undefined,
  secrets: Record<string, string>,
): Promise<ReportBody> {
  const giveUp = async (failure: WorkflowFailure, tool?: string): Promise<ReportBody> => {
    const unrestored = await abandonPlace({ config, lock, attempt: lease.attempt });
    const reported = unrestored ? { ...failure, message: `${failure.message.replace(/\.?$/, '.')} ${unrestored}` } : failure;

    const body: ReportBody = { attempt: lease.attempt, revision: lease.revision, driver, ...failureReport(reported) };

    if (tool) body.tool = tool;

    return body;
  };

  // A role lease's place was staged for its launch tool, which launches it; others pick theirs now.
  const choice = staged ?? launchToolFor({ agent: lease.agent, tool: lease.tool }, config, options.tools ?? {}, await memberTools(config));

  for (const warning of choice.warnings) log.warn(warning);

  if (!choice.ok) return giveUp(choice.failure, choice.tool);
  const selected = choice.tool;
  // A worktree has its own pull record, so the tool launched there is observed and bound as that checkout. A clone has
  // its own install, never the member's config, and none when its place installs no team.
  const contract = lease.workspace;
  const clone = contractClone(contract) ? contract?.branch : undefined;
  const prepared = clone !== undefined ? await preparedClone(config, lock.run, clone) : undefined;

  // The copy was checked as it was prepared; it is checked again right before launch, as something may have pulled since.
  if (lease.role !== undefined) {
    const { role, step } = lease;

    const refused = clone !== undefined
      ? prepared?.install
        ? await cloneRoleProblem({ install: prepared.install, step, role, tools: [selected] })
        : roleNotDeliveredFailure({ role, step, notDelivered: { copy: 'clone', gap: { kind: 'no_install' } } })
      : lease.cwd !== undefined
        ? await worktreeRoleProblem({ dir: lease.cwd, step, role, tools: [selected] })
        : roleNotDeliveredFailure({ role, step, notDelivered: { copy: 'none' } });

    if (refused !== undefined) return giveUp(refused, selected);
  }

  const teamConfig = clone !== undefined
    ? prepared?.install
    : contract && lease.cwd ? await detectProjectConfig(lease.cwd) ?? config : config;

  const stepConfig = teamConfig ?? config;
  const loaded = lease.agent && teamConfig ? await loadDeployedAgent({ tool: selected, name: lease.agent, config: teamConfig, toolPaths: options.toolPaths }) : undefined;
  const agent = loaded?.spec;

  if (lease.agent && !agent) {
    return giveUp({
      code: 'agent_unavailable',
      message: `Agent "${lease.agent}" is not available for ${selected}. Run teamai pull and try again.`,
    }, selected);
  }

  const chosen = await chooseStepModel({
    step: lease.step, tool: selected, model: lease.model, defaultModel: lease.defaultModel, agent: agent ?? undefined, config: stepConfig,
  });

  if (!chosen.ok) return giveUp(chosen.failure, selected);

  if (agent && launchAdapterIdOf(selected) === 'codex') {
    const ignored = ignoredCodexSettings(agent);

    if (ignored.length > 0) {
      log.warn(`Agent "${agent.name}" on ${selected} does not apply ${ignored.join(', ')} from the deployed agent file. codex exec still has a shell. The step is not blocked.`);
    }
  }

  const cwd = lease.cwd ?? driver.workspace;
  const resultFile = attemptResultPath(config, lock.run, lease.attempt);
  const resume = await resumeSession(archive, lease, selected, cwd);

  const launchModel = (model: StepModel): LaunchModel => {
    const named: LaunchModel = { model: model.name };

    if (model.effort) named.effort = model.effort;

    return named;
  };

  const definitionModel = chosen.model && chosen.by === 'definition' ? launchModel(chosen.model) : {};

  const { teamDelivery } = await import('../../../pull.js');

  const delivery = prepared?.install
    ? await cloneDelivery({ install: prepared.install, without: prepared.without }, selected)
    : teamConfig ? await teamDelivery(teamConfig, selected).catch(() => undefined) : undefined;

  const observing: ToolLaunch = { config: stepConfig, tool: selected, cwd, delivery: delivery ?? null };

  // In a clone, git reads its head without the names the place withholds, which setup could have handed a hook.
  if (clone !== undefined) observing.head = await cloneHead(config, lock.run, clone, { withhold: lease.envScope?.withhold ?? [], expiresAt: lease.expiresAt });

  if (lease.agent && loaded) observing.definition = { stem: lease.agent, file: loaded.file, ...definitionModel };

  if (chosen.model && chosen.by !== 'definition') observing.chosen = { ...launchModel(chosen.model), alias: chosen.alias || undefined };

  const [observed, launch, teamSkills] = await Promise.all([
    observeLaunch(observing),
    teamConfig ? workflowLaunch(teamConfig, selected) : undefined,
    delivery?.record?.delivered ? deliveredTeamSkills(stepConfig, cwd, delivery.record.delivered, delivery.record.rev).then((found) => found.teamSkills, () => undefined) : undefined,
  ]);

  // Only headless Claude and CodeBuddy have a turn limit; any other launch reports the cap as not enforced.
  const family = launchAdapterIdOf(selected);
  const capsTurns = lease.maxTurns !== undefined && !lease.interactive && (family === 'claude' || family === 'codebuddy');
  // A turn is ended only at the limits its tool is known to keep and report: Codex states its usage only as it ends, and
  // CodeBuddy's turn cap and per-message usage are untried, so the rest list as unenforced.
  const { limits } = lease;
  const endsAtTurns = limits?.maxTurns !== undefined && !lease.interactive && family === 'claude' ? limits.maxTurns : undefined;
  const budget = limits?.budget !== undefined && (family === 'claude' || family === 'opencode') ? limits.budget.tokens : undefined;
  const launchedAt = Date.now();

  if (lease.interactive) log.info(`Step "${lease.step}" opens ${selected} here for interactive work.`);

  const input: LocalToolRun = {
    prompt: lease.prompt!,
    cwd,
    resultPath: resultFile,
    secrets,
    // The lease `env` is set over the step's environment, as a command's is.
    env: { ...lease.processEnv ?? process.env, ...lease.env, ...attemptEnv(config, lock.run, lease.attempt, mode) },
  };

  if (lease.output) input.output = lease.output;

  if (launch) input.launch = launch;

  if (resume) input.resume = resume.id;

  if (agent) input.agent = definitionRun(selected, lease.agent!, agent);

  if (chosen.model) input.model = chosen.model;

  if (capsTurns) input.maxTurns = lease.maxTurns;
  else if (endsAtTurns !== undefined) input.maxTurns = endsAtTurns;

  if (budget !== undefined) input.budget = budget;

  if (limits?.timeoutMs !== undefined) input.timeoutMs = limits.timeoutMs;

  if (lease.permissions === 'unattended') input.unattended = true;

  const { result, durationMs } = await timedLaunch({
    launch: lease.interactive ? adapter.runInteractive.bind(adapter) : adapter.run.bind(adapter),
    tool: selected,
    input,
    signal,
    unfinished: `${selected} could not complete the workflow step`,
  });

  const end: StepEnd = { outcome: result.exitCode === 0 && !result.failure ? 'success' : 'failed' };

  if (end.outcome === 'failed' && result.failure) {
    end.message = result.failure.message;
    end.failure = result.failure;
  }

  const ran = result.started ? result : undefined;
  const used = ran?.session && teamSkills ? await usedInSession(selected, ran.session, cwd, teamSkills, launchedAt) : undefined;
  // A tool held to no budget that stated it spent more still ended its turn there: the budget names it.
  const passedBudget = limits?.budget !== undefined && budget === undefined && budgeted(ran?.tokens) > limits.budget.tokens;
  const stoppedBy = ran?.stoppedBy ?? (passedBudget ? 'budget' : undefined);
  const limit = limits && stoppedBy && setsLimit(limits, stoppedBy) ? stoppedBy : undefined;

  const unenforced = [
    ...((lease.maxTurns !== undefined && !capsTurns) || (limits?.maxTurns !== undefined && endsAtTurns === undefined) ? ['max_turns' as const] : []),
    ...(limits?.budget !== undefined && budget === undefined ? ['budget' as const] : []),
  ];

  const body: ReportBody = { attempt: lease.attempt, revision: lease.revision, driver, tool: selected, outcome: end.outcome };

  if (ran?.model) body.model = ran.model;

  if (ran?.session) body.session = ran.session;

  if (ran && resume) body.resumed = resume.resumed;

  if (ran) body.durationMs = durationMs;

  if (ran?.tokens) body.tokens = ran.tokens;

  if (ran?.cost) body.cost = ran.cost;

  if (ran?.output !== undefined) body.outputs = ran.output;

  // How the definition was handed over is known only once the launch resolved its tool: OpenCode's depends on its major.
  if (ran) body.agent = ran.applied ? { ...observed, definition: { applied: ran.applied } } : observed;

  if (used) body.used = used;

  if (unenforced.length > 0) body.unenforced = unenforced;
  body.exitCode = result.exitCode;

  if (limit) {
    body.outcome = 'success';
    body.limit = limit;
  } else if (end.failure) {
    Object.assign(body, failureReport(end.failure));
  } else if (end.message) {
    body.message = end.message;
  }

  return body;
}

/**
 * Run leased commands, up to `workflows.max_parallel` at once, or with none set one at a time but for the items of a
 * `for_each` that declares `max_parallel`. Each lease and report goes through the same engine operations an external
 * driver calls.
 */
export async function runLocalDriver(
  config: LocalConfig,
  runId: string,
  cwd: string,
  options: LocalDriverOptions = {},
): Promise<WorkflowEnvelope> {
  return withDriverLock(config, runId, (driveLocked) => driveLocked(cwd, options));
}

/**
 * Runs `body` holding this machine's driver lock of run `runId`, or answers `driver_running` without running it. `body`
 * drives the run through `drive`, so whatever it changes first, such as a claim, no other local driver of the run sees.
 */
export async function withDriverLock(
  config: LocalConfig,
  runId: string,
  body: (drive: (cwd: string, options: LocalDriverOptions) => Promise<WorkflowEnvelope>) => Promise<WorkflowEnvelope>,
): Promise<WorkflowEnvelope> {
  const run = RunIdSchema.safeParse(runId);

  if (!run.success) return { error: { code: 'invalid_run', message: 'Run id must look like r followed by 8 or 16 hex digits' } };

  return withRunLock(config, run.data, (lock) => body((cwd, options) => driveRun(config, lock, cwd, options)), { waitMs: 0 });
}

/** Adds to `seen` each value of `secrets` it lacks, under a label of its own when its name already holds another value. */
function rememberSecrets(seen: Record<string, string>, secrets: Record<string, string>) {
  const known = new Set(Object.values(seen));

  for (const [key, value] of Object.entries(secrets)) {
    if (known.has(value)) continue;
    let label = key;

    for (let count = 2; label in seen; count += 1) label = `${key} (value ${count})`;
    seen[label] = value;
    known.add(value);
  }

  return { ...seen };
}

/**
 * What this driver declares on every `next`. Every key is set, so a new capability does not compile until it is decided.
 * It runs setup in each workspace it creates. `tools` are the tools it launches a step that names one on. It ends a
 * prompt's turn at the limits its lease carries. It runs an unattended prompt in its tool's unattended mode, and fails
 * one whose tool has none.
 */
function localCan({ strict, hitl, tools, confined }: { strict: StrictCan; hitl: boolean; tools: string[]; confined: ConfinedOffer[] }): Required<DriverCan> {
  return { hitl, workspace: [...WORKSPACE_MODES], ...strict, tokens: true, max_turns: true, setup: true, tools, end_turn: true, unattended: true, role: true, confined };
}

type StrictCan = Required<Pick<DriverCan, 'network' | 'isolation' | 'env'>>;

/**
 * What this driver gives the strict requirements of a run on this machine, which a local start checks before the run
 * exists. It cannot deny a step the network, keeps it from the member's machine only on a host the member marks
 * `sandbox`, in config or with `--sandbox`, and gives each command and tool only the env keys its lease provides.
 */
export function localStrictCan(config: LocalConfig, options: Pick<LocalDriverOptions, 'sandbox'>): StrictCan {
  return { network: false, isolation: isSandbox(config, options) ? 'sandbox' : 'none', env: true };
}

function onPath(tool: LaunchTool): boolean {
  return resolveCliPath(executableOf(tool)) !== null;
}

/**
 * The tools a step of `run` names, or undefined when a `from` step may bring a workflow that names any. Looking a tool
 * up can start login shells, so the driver looks up only these.
 */
function namedTools(run: Pick<RunState, 'definition' | 'workflows'>): Set<string> | undefined {
  const named = new Set<string>();

  const known = (steps: readonly WorkflowStep[]): boolean => steps.every((step) => {
    if (step.tool !== undefined) named.add(step.tool);
    const child = stepWorkflow(step);

    return child?.kind !== 'from' && (child?.kind !== 'inline' || known(child.workflow.steps));
  });

  return [run.definition, ...Object.values(run.workflows ?? {})].every((definition) => known(definition.steps)) ? named : undefined;
}

/**
 * Whether a step of `run` may be confined to a directory: one is, or a `from` step may bring a workflow with one. Probing
 * the confined tools runs each, so the driver probes them only then.
 */
function mayConfine(run: Pick<RunState, 'definition' | 'workflows'>): boolean {
  const confines = (steps: readonly WorkflowStep[]): boolean => steps.some((step) => {
    const child = stepWorkflow(step);

    return confinedOf(step) !== undefined || child?.kind === 'from' || (child?.kind === 'inline' && confines(child.workflow.steps));
  });

  return [run.definition, ...Object.values(run.workflows ?? {})].some((definition) => confines(definition.steps));
}

/**
 * Whether two items of `run` may run at once with no `workflows.max_parallel`: a `for_each` it has now declares
 * `max_parallel` above 1, or a template of it. A workflow a `from` step admits later is read when the run is driven
 * again, so such a run keeps the terminal, one step at a time, until then.
 */
function mayRunItemsBeside(run: Pick<RunState, 'definition' | 'workflows' | 'admitted'>): boolean {
  const beside = (steps: readonly WorkflowStep[]): boolean => steps.some((step) => {
    const max = step.forEach?.maxParallel;
    const child = stepWorkflow(step);

    return (max !== undefined && (max instanceof Object || max > 1)) || (child?.kind === 'inline' && beside(child.workflow.steps));
  });

  const definitions = [run.definition, ...Object.values(run.workflows ?? {}), ...Object.values(run.admitted ?? {}).map(({ definition }) => definition)];

  return definitions.some((definition) => beside(definition.steps));
}

function isSandbox(config: LocalConfig, options: Pick<LocalDriverOptions, 'sandbox'>): boolean {
  return options.sandbox === true || config.workflows?.sandbox === true;
}

/**
 * Whether a person answers the HITL requests the local driver puts to them in run mode `mode`: an attended run at a
 * terminal. A terminal alone is not a person: an unattended run under a pseudo-terminal asks nobody.
 */
export function personAnswers(mode: RunMode): boolean {
  return mode === 'attended' && Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY);
}

/**
 * Runs a prompt's tool, timed around the tool's run alone. A launch that throws fails `tool_failed` with `unfinished`.
 * The adapter returns once the tool's process group is gone, so when its timeout or budget stopped it, no lock git left
 * in the checkout is held any more, and they are removed.
 */
async function timedLaunch({ launch, tool, input, signal, unfinished }: {
  launch: LocalToolAdapter['run'];
  tool: LaunchTool;
  input: LocalToolRun;
  signal: AbortSignal;
  unfinished: string;
}): Promise<{ result: LocalToolResult; durationMs: number }> {
  const started = performance.now();
  let result: LocalToolResult;

  try {
    result = await launch(tool, input, signal);
  } catch {
    result = { started: false, exitCode: 1, failure: { code: 'tool_failed', message: unfinished } };
  }

  const durationMs = Math.round(performance.now() - started);

  if (result.started && (result.stoppedBy === 'timeout' || result.stoppedBy === 'budget')) await removeGitLocks(path.join(input.cwd, '.git'));

  return { result, durationMs };
}

/**
 * Removes the locks a git process leaves when it is killed mid-write, on which the report's commit of the clone would
 * fail: those directly under `gitDir`, such as `index.lock` and `HEAD.lock`, and those of its refs. None under
 * `objects/` blocks the commit. The agent shaped the clone, so a `gitDir` or `refs` that is not a real directory, such
 * as a link out of the clone, is left alone.
 */
async function removeGitLocks(gitDir: string): Promise<void> {
  const isDirectory = async (at: string): Promise<boolean> => (await fs.lstat(at).catch(() => undefined))?.isDirectory() === true;

  if (!await isDirectory(gitDir)) return;
  const top = await fs.readdir(gitDir).catch((): string[] => []);
  const refs = await isDirectory(path.join(gitDir, 'refs')) ? await fs.readdir(path.join(gitDir, 'refs'), { recursive: true }).catch((): string[] => []) : [];
  const locks = [...top.map((name) => path.join(gitDir, name)), ...refs.map((name) => path.join(gitDir, 'refs', name))].filter((at) => at.endsWith('.lock'));
  await Promise.all(locks.map((lock) => fs.rm(lock, { force: true })));
}

/**
 * The flags a drive runs with: those `given`, over the ones the run `remembered` from this install's last drive, a
 * `--tools` name at a time. A flag left out keeps what the run remembers.
 */
function drivenWith(given: Pick<LocalDriverOptions, keyof DriveOptions>, remembered: DriveOptions | undefined): DriveOptions {
  const driven: DriveOptions = {};
  const tools = { ...remembered?.tools, ...given.tools };

  if (Object.keys(tools).length > 0) driven.tools = tools;
  // Kept off as well as on: an off overrides the member's workflows.auto_approve, as the flag does.
  const autoApprove = given.autoApprove ?? remembered?.autoApprove;

  if (autoApprove !== undefined) driven.autoApprove = autoApprove;

  if (given.sandbox ?? remembered?.sandbox) driven.sandbox = true;

  return driven;
}

/**
 * `given` over what run `run` remembers, which the run then remembers for the next drive, so a resume without flags
 * drives the run as this one does. Answers the error when the run file could not be written.
 */
async function rememberDrive(config: LocalConfig, run: RunState, given: LocalDriverOptions): Promise<LocalDriverOptions | { error: WorkflowFailure }> {
  const driven = drivenWith(given, run.driveOptions);
  // Neither given nor remembered, auto-approve stays unset, so the member's workflows.auto_approve decides.
  const options = { ...given, tools: driven.tools ?? {}, autoApprove: driven.autoApprove, sandbox: driven.sandbox === true };

  if (JSON.stringify(driven) === JSON.stringify(run.driveOptions ?? {})) return options;

  const written = await updateRun(config, run.id, await knownSecrets(config), async (stored) => ({
    value: undefined,
    write: stored === 'missing' ? undefined : { ...stored, driveOptions: driven },
  }));

  if (written.status === 'busy') return { error: { code: 'busy', message: `Run ${run.id} is locked by another process, so it was not driven. Resume it again: teamai workflow resume ${run.id}` } };

  if (written.status === 'corrupt') return { error: { code: 'run_unreadable', message: `Run ${run.id} could not be read` } };

  return options;
}

async function driveRun(config: LocalConfig, lock: RunLock, cwd: string, given: LocalDriverOptions): Promise<WorkflowEnvelope> {
  const runId = lock.run;
  const started = await readRun(config, runId);
  // Places go under the checkout the run started from, wherever in it the driver runs.
  const isStarted = started !== 'missing' && started !== 'corrupt';
  const drive = isStarted ? await rememberDrive(config, started, given) : given;

  if ('error' in drive) return drive;
  const options = drive;
  const root = await placeRoot({ cwd, checkout: isStarted ? started.checkout : undefined });
  const unreconciled = await reconcileTakenCopies(config, runId, root);

  if (unreconciled) return { error: unreconciled };
  // Resolved once per drive, so a resume where a person attends runs attended whatever mode the run started in.
  const mode = resolveRunMode(process.env);
  const canHitl = options.hitl ?? personAnswers(mode);
  // It launches a step that names its tool on the tools this machine has: those the run's steps name, or every one when a
  // step's output may bring a workflow later. It is the run's only driver, so a step whose tool it cannot launch fails
  // rather than waits.
  const named = isStarted ? namedTools(started) : undefined;
  const tools = LAUNCH_TOOLS.filter((tool) => (named === undefined || named.has(tool)) && onPath(tool));
  const lookup = options.resolveTool ? { resolveTool: options.resolveTool } : {};
  const confined = isStarted && mayConfine(started) ? await confinedOffers(lookup) : [];
  const can = localCan({ strict: localStrictCan(config, options), hitl: canHitl, tools, confined });
  const driver = driverIdentity('local', cwd);
  // A driver killed before cleanup, of this run or any other, left clones behind.
  await sweepClones(config);
  const adapter = options.adapter ?? createLocalToolAdapter();
  const archive = openSessionArchive(config);
  // With no workflows.max_parallel the driver runs one step at a time, except the items of a for_each that declares
  // max_parallel, which `next` leases beside each other (`isOneAtATime`); a run that may have them runs in parallel.
  const isOneAtATime = config.workflows?.max_parallel === undefined;
  const maxParallel = config.workflows?.max_parallel ?? (isStarted && mayRunItemsBeside(started) ? Number.POSITIVE_INFINITY : 1);
  const isParallel = maxParallel > 1;
  // One command at a time keeps the terminal: Ctrl-C reaches it, and it can prompt on /dev/tty. Parallel commands get
  // process groups of their own, which `stop` and the signal handlers below can end as a whole.
  const detached = isParallel && process.platform !== 'win32';
  const reported = new Set<string>();
  const inFlight = new Map<string, { lease: Lease; command: StagedCommand }>();
  // Leases not started yet, in lease order. Steps that share a checkout run one at a time. Distinct worktrees overlap.
  const held: Lease[] = [];
  // Cancelled commands whose process group is not gone yet. They are not sent as running, so `next` does not cancel
  // them again. They still take a slot, and a new attempt of their step waits until they are gone, so a retried step
  // never runs beside its cancelled attempt.
  const dying = new Map<string, { step: string; lease: Lease; command: StagedCommand }>();
  const base = await headCommit(root);
  // Outside a git work tree no snapshot can check an answer, so an answer there holds no place and waits for nothing.
  const checked = (await git(root, ['rev-parse', '--is-inside-work-tree'])).code === 0;
  const placeOfLease = (lease: Lease): string => (lease.answer && !checked ? lease.attempt : placeOf(lease, root));
  // The prompts that run, by attempt. A prompt that was stopped before its tool started has nothing to report.
  const prompts = new Map<string, { lease: Lease; controller: AbortController; exit: Promise<ReportBody | undefined> }>();
  let question: { hitl: LocalHitl; controller: AbortController; exit: Promise<{ kind: 'question'; line?: string }> } | undefined;
  // A headless prompt takes a slot as a command does, so a step in another checkout starts beside it. An interactive one has the terminal.
  const busy = (): number => inFlight.size + dying.size + prompts.size;
  const interactiveRuns = (): boolean => [...prompts.values()].some(({ lease }) => lease.interactive);
  const room = (): boolean => !interactiveRuns() && busy() + held.length < maxParallel && !held.some((lease) => lease.prompt !== undefined);

  const cancel = (attempt: string): void => {
    prompts.get(attempt)?.controller.abort();
    const index = held.findIndex((lease) => lease.attempt === attempt);

    if (index !== -1) held.splice(index, 1);
    const running = inFlight.get(attempt);

    if (!running) return;
    inFlight.delete(attempt);
    dying.set(attempt, { step: running.lease.step, lease: running.lease, command: running.command });
    void running.command.stop();
  };

  let interactiveIgnores: readonly NodeJS.Signals[] = [];
  let signalled: NodeJS.Signals | undefined;
  let wake = (): void => {};
  let handled: readonly NodeJS.Signals[] = [];

  const handle = (signals: readonly NodeJS.Signals[]): void => {
    for (const name of handled) process.off(name, onSignal);
    handled = signals;

    for (const name of handled) process.on(name, onSignal);
  };

  const exitOn = (signal: NodeJS.Signals): void => {
    handle([]);
    exitLike({ kind: 'signaled', signal });
  };

  // Parallel commands and detached prompt tools do not get the terminal's Ctrl-C, and no command gets a signal sent to
  // teamai alone, so the driver stops them before it exits the way the signal would. An interactive tool that the
  // terminal's signals reach handles them itself. With nothing running, the signal ends teamai at once, as it would
  // without a handler.
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interactiveRuns() && interactiveIgnores.includes(signal)) return;

    if (busy() === 0) return exitOn(signal);
    signalled ??= signal;

    for (const { controller } of prompts.values()) controller.abort(signal);
    wake();
  };

  if (isParallel) handle(STOP_SIGNALS);
  // The team env, resolved once per turn of the loop: the leases it hands out, their env, and what it masks agree. It
  // masks every value the drive has seen, so a value that changed while an attempt ran stays masked in what it reports.
  let env: WorkflowEnv | undefined;
  const seen: Record<string, string> = {};
  // Nobody answers here, so the driver offers the run to a person; once it could not, the steps only a person can take fail.
  let handoff: PersonHandoff | undefined = canHitl ? undefined : { kind: 'offers' };

  const report = async (body: ReportBody, lease: Lease, changed?: readonly string[]): Promise<WorkflowEnvelope | undefined> => {
    const secrets = env?.secrets ?? await knownSecrets(config);
    await AttemptResult.mask(attemptResultPath(config, runId, lease.attempt), secrets);

    // The leases still waiting to start keep their whole timeout through this report too.
    const sent: ReportBody = { ...body, queued: held.map((waiting) => waiting.attempt) };

    const answer = changed === undefined
      ? await managedReport({ config, runId, report: sent, secrets, lock })
      : await managedReport({ config, runId, report: sent, secrets, lock, changed });

    // Cancelled while it ran: the next `next` lists it in `cancelled`, and the run goes on without it.
    if (isWorkflowError(answer)) return answer.error.code === 'lease_cancelled' ? undefined : answer;
    reported.add(body.attempt);
    options.started?.(StartedRunSchema.array().catch([]).parse(answer.data.started));

    return undefined;
  };

  const unstaged = (lease: Lease, failure: WorkflowFailure): ReportBody => ({ attempt: lease.attempt, revision: lease.revision, driver, ...failureReport(failure) });
  // Why a confined step this driver was leased has no tool here that resolves its model. It hands that lease back and
  // takes no other, so it does not lease the step again in this process.
  let handedBack: string | undefined;

  try {
    for (;;) {
      if (signalled) return { error: { code: 'interrupted', message: `Stopped by ${signalled} after every command it started exited` } };
      const running = [...inFlight.keys(), ...held.map((lease) => lease.attempt), ...prompts.keys()];
      const canTakeLease = room() && handedBack === undefined;
      const resolved = await resolveWorkflowEnv(config);
      const turn = { ...resolved, secrets: rememberSecrets(seen, resolved.secrets) };
      env = turn;
      const next = await leaseNext(config, runId, driver, { running, queued: held.map((lease) => lease.attempt), canTakeLease, can, autoApprove: options.autoApprove, runMode: mode, handoff, base, env: turn, alone: true, prepare: true, isOneAtATime });

      if (signalled) continue;
      // A clone whose steps all settled is not needed any more.
      await sweepClones(config, runId);

      if (isWorkflowError(next)) return next;

      const cancelled = z.array(z.string()).safeParse(next.data.cancelled);
      const deadlines = z.record(z.string(), z.string()).safeParse(next.data.deadlines);

      // A lease waiting to start keeps the deadline its restarted clock gives it.
      for (const [index, lease] of held.entries()) {
        const deadline = deadlines.success ? deadlines.data[lease.attempt] : undefined;

        if (deadline !== undefined) held[index] = { ...lease, expiresAt: deadline };
      }

      for (const attempt of cancelled.success ? cancelled.data : []) cancel(attempt);

      if ('done' in next.data) {
        question?.controller.abort();

        for (const { controller } of prompts.values()) controller.abort();

        for (const [attempt, { lease, exit }] of prompts) {
          const body = await exit;
          const failed = body && await report(body, lease);
          prompts.delete(attempt);

          if (failed) return failed;
        }

        return next;
      }

      const hitlRequest = HitlRequestSchema.safeParse(next.data.hitl);
      const hitl: LocalHitl | undefined = hitlRequest.success ? hitlRequest.data : undefined;
      const leased = LocalLeaseSchema.safeParse(next.data.lease);
      const nextLease = 'lease' in next.data && leased.success ? leased.data : undefined;

      if (question && (nextLease?.step === question.hitl.step
        || (!nextLease && (hitl?.step !== question.hitl.step || hitl?.pass !== question.hitl.pass)))) {
        question.controller.abort();
        await question.exit;
        question = undefined;
      }

      if ('lease' in next.data) {
        if (!nextLease) return { error: { code: 'run_unreadable', message: `Run ${runId} returned a lease the local driver cannot run` } };

        if (reported.has(nextLease.attempt)) {
          return { error: { code: 'driver_stuck', message: `Attempt ${nextLease.attempt} was leased again before it could be reported` } };
        }

        // A confined step runs in its directory, never in a checkout another attempt holds.
        held.push(nextLease.confined ? { ...nextLease, cwd: nextLease.confined.dir } : nextLease);
      }

      const placesBusy = (): Set<string> => new Set([
        ...[...inFlight.values()].map(({ lease }) => placeOfLease(lease)),
        ...[...dying.values()].map(({ lease }) => placeOfLease(lease)),
        ...[...prompts.values()].map(({ lease }) => placeOfLease(lease)),
      ]);

      for (let index = 0; !interactiveRuns() && busy() < maxParallel;) {
        const lease = held[index];
        const command = lease?.command;

        if (lease === undefined || command === undefined) break;

        if ([...dying.values()].some((stopping) => stopping.step === lease.step)
          || placesBusy().has(placeOfLease(lease))
          || held.slice(0, index).some((earlier) => earlier.prompt !== undefined && placeOfLease(earlier) === placeOfLease(lease))) {
          index += 1;
          continue;
        }

        held.splice(index, 1);
        // Setup runs in its own process group, out of the terminal's reach, so the driver handles every stop signal until
        // the command starts. An attached command already has the signals its terminal sends to the whole group; a second
        // would force-quit some tools.
        const forwarded = !isParallel ? commandSignalPolicy(await terminalReachesCommand()).forwarded : undefined;

        if (forwarded) handle(STOP_SIGNALS);
        inFlight.set(lease.attempt, { lease, command: stageThenStart(
          lease,
          async (signal) => {
            const staged = await stageLease(lease, { config, lock, root, env: turn, mode, signal });

            return staged ?? refuseDirtyAdoptedCommand({ config, run: lock.run, attempt: lease.attempt });
          },
          () => {
            if (forwarded) handle(forwarded);

            // The lease `env` is set over the step's environment, so its values reach the shell only as variables.
            const input: Parameters<typeof startGroupedCommand>[0] = {
              command, cwd: lease.cwd ?? root, env: { ...lease.processEnv ?? process.env, ...lease.env, ...attemptEnv(config, runId, lease.attempt, mode), [PROGRESS_STREAMS_ENV]: '1' }, detached, group: attemptDir(config, runId, lease.attempt),
            };

            const { progress } = options;

            if (!progress) return startGroupedCommand(input);

            const shown = lineSplitter((line) => {
              const { stream, text } = streamOfLine(line);
              progress(masked(text, turn.secrets), stream);
            });

            const grouped = startGroupedCommand({ ...input, onStderr: shown.write });

            return { ...grouped, exit: grouped.exit.finally(shown.end) };
          },
        ) });
      }

      // Prompts in places no other attempt holds start beside each other, in lease order, while a slot is free. An
      // interactive one starts only once nothing else runs.
      while (!interactiveRuns() && busy() < maxParallel) {
        const promptAt = held.findIndex((lease) => lease.prompt !== undefined
          && !placesBusy().has(placeOfLease(lease))
          && ![...dying.values()].some((stopping) => stopping.step === lease.step)
          && (!lease.interactive || busy() === 0));

        const [lease] = promptAt === -1 ? [] : held.splice(promptAt, 1);

        if (lease === undefined) break;

        if (lease.interactive && question) {
          question.controller.abort();
          await question.exit;
          question = undefined;
        }

        // Setup runs out of the terminal's reach, so the tool's signals are left to it only once it starts.
        interactiveIgnores = [];
        const ignored = lease.interactive ? commandSignalPolicy(await terminalReachesCommand()).ignored : [];
        const controller = new AbortController();

        if (!isParallel) handle(STOP_SIGNALS);
        prompts.set(lease.attempt, { lease, controller, exit: (async () => {
          const { confined: place, prompt } = lease;

          if (lease.answer && prompt !== undefined) {
            const failure = await stageLease(lease, { config, lock, root, env: turn, mode, signal: controller.signal });

            if (!startable(lease, controller.signal)) {
              await abandonPlace({ config, lock, attempt: lease.attempt });

              return undefined;
            }

            if (failure) return unstaged(lease, failure);

            const answered = await runAnswerStep({ config, prompt, output: lease.output, cwd: lease.cwd ?? root, expiresAt: lease.expiresAt, signal: controller.signal, ...lookup });

            // Cancelled while it answered: the engine settles the step, and the reply is not wanted.
            return controller.signal.aborted ? undefined : { attempt: lease.attempt, revision: lease.revision, driver, ...answered };
          }

          if (place) {
            await stopRecordedGroup(attemptDir(config, runId, lease.attempt));

            if (!startable(lease, controller.signal)) return undefined;
            const secrets = env?.secrets ?? await knownSecrets(config);
            const ended = await runConfinedStep({ config, run: runId, lease: { ...lease, confined: place }, signal: controller.signal, secrets, ...lookup });
            const id = { attempt: lease.attempt, revision: lease.revision, driver };

            if (ended.kind === 'ran') return { ...id, ...ended.report };
            handedBack = ended.reason;

            return { ...id, outcome: 'released' };
          }

          // A role copy is checked and delivered for the tool the step launches, so another tool the member enables does not refuse it.
          const launch = lease.role !== undefined ? launchToolFor({ agent: lease.agent, tool: lease.tool }, config, options.tools ?? {}, await memberTools(config)) : undefined;
          const failure = await stageLease(lease, { config, lock, root, env: turn, mode, signal: controller.signal, launches: launch?.ok ? launch.tool : undefined });

          if (!startable(lease, controller.signal)) {
            await abandonPlace({ config, lock, attempt: lease.attempt });

            return undefined;
          }

          if (failure) return unstaged(lease, failure);
          interactiveIgnores = ignored;

          return promptReport(config, lock, driver, lease, adapter, options, archive, controller.signal, mode, launch, turn.secrets);
        })() });
      }

      if (canHitl && hitl && !question && !interactiveRuns()) {
        const controller = new AbortController();
        question = { hitl, controller, exit: (options.question ?? askHitl)(hitl, controller.signal)
          .then((line) => ({ kind: 'question' as const, line }), () => ({ kind: 'question' as const })) };
      }

      if ('lease' in next.data && room()) continue;

      if (busy() === 0 && !question) {
        const wait = WaitReplySchema.parse(next.data.wait);

        // Another process of this machine delivers a step this run waits for; it settles without this driver.
        if (Array.isArray(wait.delivering) && wait.delivering.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          continue;
        }

        // A wait for a call that could not take a lease says nothing about what is left; ask again with room. A driver
        // that handed back a confined lease never has room again, so it stops on that.
        if (!canTakeLease && handedBack === undefined) continue;

        const confinedWait = handedBack ?? (heldForConfined(wait.held) ? wait.held.map((item) => item.reason.replace(/\.$/u, '')).join('; ') : undefined);

        if (confinedWait !== undefined) {
          return { error: { code: 'confined_pending', message: `Run ${runId} waits for a confined tool: ${confinedWait.replace(/\.$/u, '')}. Make one available here, then run teamai workflow resume ${runId}, or drive the run with a driver that offers one.` } };
        }

        // Nobody answers here, so the run goes to a person: offered on teamai-reports, its local state kept.
        const people = handoff?.kind === 'offers' ? (wait.held ?? []).filter(({ missing }) => missing.includes(HITL)).map(({ step }) => step) : [];

        if (people.length > 0) {
          const unoffered = await offerToPerson(config, runId, cwd);

          if (unoffered === undefined) return handedToPerson(runId, people);
          handoff = { kind: 'unoffered', reason: unoffered };
          continue;
        }

        const reason = wait.reason ?? 'the next step is not available';
        // A run claimed from another machine does not bring its --sandbox along: say which flag declares it here.
        const needsSandbox = !isSandbox(config, options) && wait.held?.some(({ missing }) => missing.includes(ISOLATION)) === true;

        return { error: { code: 'busy', message: needsSandbox
          ? `${reason}. If this machine is a disposable host, such as a CI runner or a container, declare it a sandbox: teamai workflow resume ${runId} --sandbox, or workflows.sandbox: true in config`
          : reason } };
      }

      let timer: NodeJS.Timeout | undefined;

      const exited = await Promise.race([
        ...[...inFlight.values()].map(({ lease, command }) => command.exit.then((result) => ({ kind: 'command' as const, attempt: lease.attempt, lease, result }))),
        ...[...dying].map(([attempt, { command }]) => command.stop().then(() => ({ kind: 'stopped' as const, attempt }))),
        ...[...prompts].map(([attempt, { exit }]) => exit.then((body) => ({ kind: 'prompt' as const, attempt, body }))),
        ...(question ? [question.exit] : []),
        new Promise<undefined>((resolve) => {
          wake = () => resolve(undefined);
          timer = setTimeout(wake, question ? pollMs / 2 : pollMs);
        }),
      ]);

      clearTimeout(timer);

      if (!exited) continue;

      if (exited.kind === 'question') {
        const questionHitl = question!.hitl;
        question = undefined;

        if (exited.line === undefined) return { error: { code: 'interrupted', message: 'The HITL question closed without an answer. Continue with teamai workflow resume.' } };
        const [choice = '', ...words] = exited.line.trim().split(/\s+/);
        const provenance = respondProvenance({ kind: 'terminal', caller: callerProvenance(process.env, { isTTY: true }) });
        const response: ResponseInput = { step: questionHitl.step, pass: questionHitl.pass, choice, provenance, queued: { driver, attempts: held.map((lease) => lease.attempt) } };

        if (words.length > 0) response.note = words.join(' ');
        const answer = await respondToHitl(config, runId, turn.secrets, response);

        if (isWorkflowError(answer)) {
          // agent_in_path: the driver runs inside an agent session; it keeps waiting for the person's answer from elsewhere.
          if (!['repeated_response', 'stale_response', 'invalid_choice', 'not_waiting', 'run_settled', 'agent_in_path'].includes(answer.error.code)) return answer;
          log.warn(answer.error.message);
        }

        continue;
      }

      if (exited.kind === 'prompt') {
        const ended = prompts.get(exited.attempt);
        prompts.delete(exited.attempt);

        if (!isParallel) handle([]);
        const failed = exited.body && ended && await report(exited.body, ended.lease);

        if (failed) return failed;
        continue;
      }

      if (exited.kind === 'stopped') {
        const stopping = dying.get(exited.attempt);
        dying.delete(exited.attempt);

        if (!isParallel) handle([]);

        if (stopping) await abandonPlace({ config, lock, attempt: stopping.lease.attempt });
        continue;
      }

      inFlight.delete(exited.attempt);

      if (!isParallel) handle([]);
      const staged = exited.result;

      if (staged.kind === 'stopped') {
        // Its lease ended while it was staged: the engine stops it, and the driver leaves the copy as it found it.
        await abandonPlace({ config, lock, attempt: exited.lease.attempt });
        continue;
      }

      const body = staged.kind === 'unstaged'
        ? unstaged(exited.lease, staged.failure)
        : await commandReport(config, lock, driver, exited.lease, staged.result, turn.secrets);

      // The command did not start. An empty list keeps a host file written after adopt out of the commit.
      const failed = await report(body, exited.lease, staged.kind === 'unstaged' ? [] : undefined);

      if (failed) return failed;
    }
  } finally {
    // The sweep runs even when stopping what still runs throws, so no attempt's result file keeps a secret.
    try {
      question?.controller.abort();

      for (const { controller } of prompts.values()) controller.abort(signalled);
      await Promise.all([...prompts.values()].map(({ exit }) => exit));

      for (const attempt of inFlight.keys()) cancel(attempt);
      await Promise.all([...dying.values()].map(async ({ lease, command }) => {
        await command.stop();
        await abandonPlace({ config, lock, attempt: lease.attempt });
      }));
    } finally {
      await maskAttemptFiles(config, runId, env?.secrets ?? await knownSecrets(config));
    }

    await archive.close();

    if (signalled) exitOn(signalled);
    handle([]);
  }
}
